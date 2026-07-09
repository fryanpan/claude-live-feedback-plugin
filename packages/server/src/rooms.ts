import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type Anchor,
  type DocMeta,
  type DocType,
  type Thread,
  type User,
  contentKind,
  createThread,
  initDocMeta,
  listThreads,
  prose,
  readDocMeta,
  postReply as schemaPostReply,
  replaceAnchor as schemaReplaceAnchor,
  setStatus as schemaSetStatus,
} from '@feedback/core';
import type { ServerWebSocket } from 'bun';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
  type ActivityType,
  type Event,
  appendActivity,
  buildEventDoc,
  clampReadPayload,
  classifyActor,
  eventId,
  isOwnerActor,
  payloadDigest,
  toUtcIso,
  wordCount,
} from './activity.ts';
import {
  type BindDiffOpts,
  type BindDiffResult,
  type BindFolderOpts,
  type BindFolderResult,
  bindDiff as bindDiffImpl,
  bindFolder as bindFolderImpl,
} from './binds.ts';
import { showFile } from './git-diff.ts';
import type { SseHub } from './sse.ts';
import type { WebhookDispatcher } from './webhooks.ts';

export type WsCtx = {
  docId: string;
  isAwarenessOrigin: symbol;
};

export type FeedbackWs = ServerWebSocket<WsCtx>;

export interface DocRoom {
  docId: string;
  ydoc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Set<FeedbackWs>;
  meta: DocMeta;
  webhookUrl?: string;
  /** incremented per webhook event. */
  seq: number;
}

/** A file leaf in the workspace tree (a single bound review doc). */
export interface WorkspaceFileNode {
  type: 'file';
  docId: string;
  /** Basename of relPath. */
  name: string;
  relPath: string;
  fileType: DocType;
  /** Open (unresolved) thread count on this file. */
  openCount: number;
  /** Total thread count (open + resolved). */
  threadCount: number;
  reviewUrl?: string;
  lastActivityAt?: number;
  /** Diff-review extras (present only on `type:'diff'` members). */
  diffStatus?: DocMeta['diffStatus'];
  diffAdditions?: number;
  diffDeletions?: number;
}

/** A directory node in the workspace tree; `openCount` is rolled up from
 *  all descendant files. */
export interface WorkspaceDirNode {
  type: 'dir';
  /** Path segment name; empty string for the tree root. */
  name: string;
  openCount: number;
  children: Array<WorkspaceDirNode | WorkspaceFileNode>;
}

/** Result of `buildWorkspaceTree` — a nested directory tree plus totals. */
export interface WorkspaceTree {
  workspaceId: string;
  /** Absolute workspace root, when known (from member docs' workspaceRoot). */
  root?: string;
  totalOpen: number;
  tree: WorkspaceDirNode;
}

export interface RoomsConfig {
  dataDir: string;
  /** Called on new thread / reply / status change to dispatch webhooks + SSE. */
  sse: SseHub;
  webhooks: WebhookDispatcher;
  /** Decorate doc metadata on the way out (e.g. with a reachable reviewUrl). */
  decorateDocMeta?: (meta: DocMeta) => DocMeta & { reviewUrl?: string };
}

/**
 * Per-room binding to a markdown file on disk. Maintained by
 * `attachFile` — every prose change debounces a write of the
 * serialized fragment back to the file. First attach seeds from disk
 * if the fragment is empty.
 */
interface FileBinding {
  path: string;
  writeTimer?: ReturnType<typeof setTimeout> | null;
  readTimer?: ReturnType<typeof setTimeout> | null;
  /** Interval handle for the stat-mtime poll (see armFileWatcher). */
  pollTimer?: ReturnType<typeof setInterval> | null;
  /** Last file mtime (ms) we observed, so the poll reacts only to changes. */
  lastMtimeMs?: number;
  /** The serialized markdown we last wrote or last read from disk.
   *  Both directions guard against this to break echo loops. */
  lastWritten?: string;
  /** Set when the most recent disk→doc reconcile failed (parse threw or
   *  produced zero blocks). Cleared on the next successful reconcile.
   *  Surfaced via getDoc so a wedged doc reports WHY it's stale instead
   *  of silently serving pre-edit content. */
  lastSyncError?: { message: string; at: number };
}

/**
 * Decide what a disk→doc reconcile should do, given the file's current
 * content (`disk`), the markdown we last wrote/read (`lastWritten`), and the
 * live doc's current serialization (`currentSerialized`).
 *
 *   - `in-sync`   disk is byte-identical to our last write → nothing to do.
 *   - `catch-up`  disk differs from lastWritten but already equals the live
 *                 doc → just advance bookkeeping, don't touch the fragment.
 *   - `apply`     disk changed externally and the live doc is clean (still
 *                 equals lastWritten) → safe to pull disk into the doc.
 *   - `conflict`  disk changed externally AND the live doc has its own
 *                 un-flushed edits (diverged from lastWritten) → a blind
 *                 replace would clobber the human's in-progress work. The
 *                 caller keeps the live edits (the editor is the runtime
 *                 source of truth) and reasserts them to disk.
 *
 * Pure + exported so the policy is unit-tested without timing races.
 */
export function decideReconcile(args: {
  disk: string;
  lastWritten: string | undefined;
  currentSerialized: string;
}): 'in-sync' | 'catch-up' | 'apply' | 'conflict' {
  const { disk, lastWritten, currentSerialized } = args;
  if (disk === lastWritten) return 'in-sync';
  if (disk === currentSerialized) return 'catch-up';
  // disk diverges from BOTH our last write and the live doc.
  if (currentSerialized !== lastWritten) return 'conflict';
  return 'apply';
}

export class Rooms {
  private rooms = new Map<string, DocRoom>();
  private fileBindings = new Map<string, FileBinding>();

  constructor(private cfg: RoomsConfig) {
    if (!existsSync(cfg.dataDir)) mkdirSync(cfg.dataDir, { recursive: true });
    this.hydrateFromDisk();
  }

  list(): DocMeta[] {
    return Array.from(this.rooms.values()).map((r) => this.withActivity(r.meta));
  }

  /**
   * Stamp a doc's meta with `lastActivityAt`, derived from the persisted
   * `.ydoc` mtime. saveToDisk rewrites that file on every prose/thread
   * change (200ms debounced), so its mtime tracks real activity without a
   * CRDT field that would churn the doc history on every keystroke. Falls
   * back to `createdAt` when the file isn't on disk yet.
   */
  private withActivity(meta: DocMeta): DocMeta {
    let lastActivityAt = meta.createdAt;
    try {
      const p = this.pathFor(meta.docId);
      if (existsSync(p)) lastActivityAt = Math.round(statSync(p).mtimeMs);
    } catch {}
    return { ...meta, lastActivityAt };
  }

  /**
   * Permanently remove a review doc: drop the in-memory room, cancel its
   * timers, and delete the persisted `.ydoc` so it doesn't reload on the
   * next restart. The bound SOURCE file (sourceUrl) is the user's own file
   * and is left untouched.
   *
   * Guardrail: refuses if the doc still has OPEN comment threads (returns
   * `has-open-threads` + the count) unless `force` is set — open threads
   * mean someone is still waiting on that feedback. This is the primary
   * cleanup path for the "doc used for 30 min then obsolete" lifecycle.
   */
  deleteDoc(
    docId: string,
    opts?: { force?: boolean },
  ): { ok: boolean; error?: 'not-found' | 'has-open-threads'; openThreads?: number } {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'not-found' };
    const openThreads = listThreads(room.ydoc).filter((t) => t.status === 'open').length;
    if (openThreads > 0 && !opts?.force) {
      return { ok: false, error: 'has-open-threads', openThreads };
    }
    // Cancel pending persistence first so it can't recreate the .ydoc after
    // we remove it.
    const saveTimer = this.saveTimers.get(docId);
    if (saveTimer) clearTimeout(saveTimer);
    this.saveTimers.delete(docId);
    // Tear down the file binding + its poll/write/read timers.
    const binding = this.fileBindings.get(docId);
    if (binding) {
      if (binding.writeTimer) clearTimeout(binding.writeTimer);
      if (binding.readTimer) clearTimeout(binding.readTimer);
      if (binding.pollTimer) clearInterval(binding.pollTimer);
      this.fileBindings.delete(docId);
    }
    // Close any live viewers so they don't hold a dead room reference.
    for (const ws of room.conns) {
      try {
        ws.close(1000, 'doc deleted');
      } catch {}
    }
    this.rooms.delete(docId);
    try {
      const p = this.pathFor(docId);
      if (existsSync(p)) rmSync(p);
    } catch (err) {
      console.error(`[rooms] failed to remove persisted ${docId}:`, err);
    }
    try {
      room.awareness.destroy();
      room.ydoc.destroy();
    } catch {}
    return { ok: true };
  }

  // The persisted Yjs files are the source of truth for doc existence —
  // the in-memory `rooms` map is just a hot cache. Without this hydration
  // step, `list()` only returns rooms that have been touched since the
  // last supervisor restart, which is misleading (every `bun --watch`
  // reload silently shrinks the result). Load every persisted doc into
  // memory at startup so discovery via list_docs is always accurate.
  // File-bound markdown rooms re-attach automatically when their sourceUrl
  // points at an existing file. Without this, every supervisor restart
  // silently leaves bound docs with their Yjs state intact in memory but
  // no observeDeep listener wired to write-back — reads work, writes never
  // fire, disk drifts behind the live editor. Bug surfaced 2026-05-09:
  // ~16 hours of edits sat unflushed before disk was inspected.
  // Files that have moved (sourceUrl present, file missing) are left
  // unbound; callers can rebind via create_review_doc with the new path.
  private hydrateFromDisk(): void {
    let count = 0;
    let rebound = 0;
    try {
      for (const file of readdirSync(this.cfg.dataDir)) {
        if (!file.endsWith('.ydoc')) continue;
        const docId = file.slice(0, -'.ydoc'.length);
        if (!docId) continue;
        const room = this.getOrCreate(docId);
        count++;
        const src = room.meta.sourceUrl;
        if (src && existsSync(src)) {
          if (contentKind(room.meta.type) === 'prose') {
            if (this.attachFile(docId, src).ok) rebound++;
          } else if (contentKind(room.meta.type) === 'flat') {
            // Working-tree diff docs have a sourceUrl and re-arm their live
            // poll like code docs. Pinned diff docs have no sourceUrl and
            // need no binding — content is already in the .ydoc.
            if (this.attachReadonlyFile(docId, src).ok) rebound++;
          }
        }
      }
    } catch (err) {
      console.error('[rooms] hydrateFromDisk failed:', err);
    }
    if (count > 0) {
      console.error(
        `[rooms] hydrated ${count} doc(s) from ${this.cfg.dataDir}` +
          (rebound > 0 ? ` (${rebound} markdown docs auto-rebound)` : ''),
      );
    }
  }

  getOrCreate(
    docId: string,
    init?: {
      type?: DocType;
      sourceUrl?: string;
      title?: string;
      setId?: string;
      webhookUrl?: string;
      owner?: string;
      workspaceId?: string;
      relPath?: string;
      workspaceRoot?: string;
      producedBy?: { agentId?: string; sessionId?: string };
      diffBase?: string;
      diffTarget?: string;
      diffStatus?: DocMeta['diffStatus'];
      diffOldPath?: string;
      diffAdditions?: number;
      diffDeletions?: number;
    },
  ): DocRoom {
    const existing = this.rooms.get(docId);
    if (existing) {
      if (init?.webhookUrl !== undefined) existing.webhookUrl = init.webhookUrl;
      // Allow re-tagging an existing doc into a different set without a
      // server restart — agents may rebatch their review queue.
      if (init?.setId !== undefined && init.setId !== existing.meta.setId) {
        const m = existing.ydoc.getMap('meta');
        existing.ydoc.transact(() => m.set('setId', init.setId));
        existing.meta.setId = init.setId;
      }
      return existing;
    }
    const ydoc = new Y.Doc();
    this.loadFromDisk(docId, ydoc);
    const restored = readDocMeta(ydoc);
    const isNew = !restored.docId;
    const meta: DocMeta = (() => {
      if (!isNew) {
        // Restored doc; allow init to override setId (set membership
        // is editorial, not part of the persisted CRDT contract).
        if (init?.setId !== undefined && init.setId !== restored.setId) {
          const m = ydoc.getMap('meta');
          ydoc.transact(() => m.set('setId', init.setId));
          restored.setId = init.setId;
        }
        return restored;
      }
      const now: DocMeta = {
        docId,
        type: init?.type ?? 'markdown',
        sourceUrl: init?.sourceUrl,
        title: init?.title,
        setId: init?.setId,
        owner: init?.owner,
        workspaceId: init?.workspaceId,
        relPath: init?.relPath,
        workspaceRoot: init?.workspaceRoot,
        producedBy: init?.producedBy,
        diffBase: init?.diffBase,
        diffTarget: init?.diffTarget,
        diffStatus: init?.diffStatus,
        diffOldPath: init?.diffOldPath,
        diffAdditions: init?.diffAdditions,
        diffDeletions: init?.diffDeletions,
        createdAt: Date.now(),
      };
      initDocMeta(ydoc, now);
      return now;
    })();
    const room: DocRoom = {
      docId,
      ydoc,
      awareness: new awarenessProtocol.Awareness(ydoc),
      conns: new Set(),
      meta,
      webhookUrl: init?.webhookUrl,
      seq: 0,
    };
    this.rooms.set(docId, room);
    this.wireEvents(room);
    // For freshly-created rooms (no on-disk state), the initDocMeta call
    // above fired its update event before wireEvents listened, so nothing
    // would ever flush this room to disk if the user hasn't done another
    // mutation by the next supervisor restart. Force a snapshot now so a
    // create_review_doc immediately followed by a `bun --watch` reload
    // doesn't lose the doc.
    if (isNew) this.saveToDisk(room);
    return room;
  }

  get(docId: string): DocRoom | undefined {
    return this.rooms.get(docId);
  }

  async postComment(
    docId: string,
    threadId: string | null,
    author: User,
    text: string,
    anchor?: Anchor,
  ): Promise<Thread | null> {
    const room = this.rooms.get(docId);
    if (!room) return null;
    if (threadId == null) {
      if (!anchor) return null;
      const id = randomId();
      const t = createThread(room.ydoc, {
        threadId: id,
        anchor,
        createdBy: author,
        firstComment: { id: randomId(), text },
      });
      this.fireEvent(room, 'thread.created', t);
      // Hash the activity event with the comment's PERSISTED ts (not a fresh
      // Date.now()), so a later backfill — which reconstructs this event from
      // the same stored ts — produces an IDENTICAL eventId and dedupes
      // instead of double-counting.
      this.recordActivity(room, 'comment', author, t.id, {
        text,
        tsMs: t.comments[0]?.ts ?? Date.now(),
      });
      return t;
    }
    const comment = schemaPostReply(room.ydoc, threadId, {
      id: randomId(),
      author,
      text,
    });
    if (!comment) return null;
    const thread = this.getThread(docId, threadId);
    if (thread) this.fireEvent(room, 'thread.replied', thread, comment);
    this.recordActivity(room, 'reply', author, threadId, { text, tsMs: comment.ts });
    return thread;
  }

  /**
   * Agent-side thread creation. Mirrors the user-side editor flow
   * (editor → POST /api/docs/<id>/threads with a pre-built Anchor) but
   * accepts `find`+context the same way `find_and_replace` does — the
   * agent doesn't have a cursor to anchor against, so it specifies the
   * text range by its visible content. Once the anchor is built, the
   * write path is identical: `postComment(docId, null, ...)` fires
   * `thread.created` on the same channel the editor uses, so widgets
   * see the new thread instantly.
   */
  async createThreadByFind(
    docId: string,
    opts: {
      find: string;
      contextBefore?: string;
      contextAfter?: string;
      occurrence?: number;
    },
    author: User,
    text: string,
  ): Promise<
    | { ok: true; thread: Thread }
    | {
        ok: false;
        error: 'no-match' | 'cross-node' | 'ambiguous' | 'no-doc';
        candidates?: Array<{ docOffset: number; preview: string }>;
      }
  > {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'no-doc' };
    // Code/diff docs are flat text in the `content` Y.Text — the prose
    // resolver below would walk an empty fragment and always miss. Find the
    // text directly and snap the anchor to whole lines, matching the code
    // surface's own selection convention.
    if (contentKind(room.meta.type) === 'flat') {
      const content = room.ydoc.getText('content');
      const hay = content.toString();
      const before = opts.contextBefore ?? '';
      const after = opts.contextAfter ?? '';
      const needle = before + opts.find + after;
      const hits: number[] = [];
      for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) hits.push(i);
      if (hits.length === 0) return { ok: false, error: 'no-match' };
      let hit: number | undefined;
      if (opts.occurrence != null) {
        hit = hits[opts.occurrence - 1];
        if (hit === undefined) return { ok: false, error: 'no-match' };
      } else if (hits.length > 1) {
        return {
          ok: false,
          error: 'ambiguous',
          candidates: hits.slice(0, 5).map((docOffset) => ({
            docOffset,
            preview: hay.slice(Math.max(0, docOffset - 30), docOffset + needle.length + 30),
          })),
        };
      } else {
        hit = hits[0] as number;
      }
      const from = hit + before.length;
      const to = from + opts.find.length;
      const lineStart = hay.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
      const nl = hay.indexOf('\n', Math.max(to - 1, lineStart));
      const lineEnd = nl === -1 ? hay.length : nl + 1;
      const enc = (offset: number) =>
        Array.from(
          Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(content, offset)),
        ) as unknown as Uint8Array;
      const anchor: Anchor = {
        kind: 'text-range',
        startRel: enc(lineStart),
        endRel: enc(lineEnd),
        snippet: { text: hay.slice(lineStart, lineEnd).slice(0, 120) },
      };
      const thread = await this.postComment(docId, null, author, text, anchor);
      if (!thread) return { ok: false, error: 'no-doc' };
      return { ok: true, thread };
    }
    const resolved = prose.resolveTextRangeFromFind(room.ydoc, opts);
    if (!resolved.ok) {
      if (resolved.error === 'ambiguous') {
        return { ok: false, error: 'ambiguous', candidates: resolved.candidates };
      }
      return { ok: false, error: resolved.error };
    }
    // Yjs's encodeAny silently JSON-stringifies a Uint8Array inside a plain
    // object — it becomes { "0": ..., "1": ... } on the way out, with no
    // .length and no iteration, so `new Uint8Array(anchor.startRel)` on the
    // client produces an empty array. Anchor resolution then returns null,
    // the editor renders no decoration, and clicks miss entirely. The editor
    // serializes the same way it sends over JSON: as a number[]. Match it.
    // See packages/markdown-app/src/app.ts:976 (`Array.from(selection.start)`).
    // `Anchor.startRel`/`endRel` is typed as Uint8Array, but the editor's
    // own thread-create path (`packages/markdown-app/src/app.ts:976`)
    // sends a number[] — and that's what survives Yjs's encoder cleanly
    // inside a plain object. A Uint8Array nested in a plain object gets
    // JSON-stringified to `{"0":2,"1":251,...}` on the way out, with no
    // .length and no iteration, so `new Uint8Array(anchor.startRel)` on
    // the client produces an empty array and decorations stop rendering.
    // Match the editor's wire shape. The `unknown` double-cast is the
    // accepted way to thread a number[] through a Uint8Array-typed slot
    // without `as any`.
    const startRelArr = Array.from(resolved.startRel) as unknown as Uint8Array;
    const endRelArr = Array.from(resolved.endRel) as unknown as Uint8Array;
    const anchor: Anchor = {
      kind: 'text-range',
      startRel: startRelArr,
      endRel: endRelArr,
      snippet: { text: resolved.snippetText },
    };
    const thread = await this.postComment(docId, null, author, text, anchor);
    if (!thread) return { ok: false, error: 'no-doc' };
    return { ok: true, thread };
  }

  resolve(docId: string, threadId: string, author?: User): Thread | null {
    const room = this.rooms.get(docId);
    if (!room) return null;
    const t = schemaSetStatus(room.ydoc, threadId, 'resolved');
    if (t) {
      this.fireEvent(room, 'thread.resolved', t);
      this.recordActivity(room, 'resolve', author ?? DEFAULT_REVIEWER, threadId, {
        tsMs: Date.now(),
      });
    }
    return t;
  }

  reopen(docId: string, threadId: string, author?: User): Thread | null {
    const room = this.rooms.get(docId);
    if (!room) return null;
    const t = schemaSetStatus(room.ydoc, threadId, 'open');
    if (t) {
      this.fireEvent(room, 'thread.reopened', t);
      this.recordActivity(room, 'reopen', author ?? DEFAULT_REVIEWER, threadId, {
        tsMs: Date.now(),
      });
    }
    return t;
  }

  reanchor(docId: string, threadId: string, anchor: Anchor): Thread | null {
    const room = this.rooms.get(docId);
    if (!room) return null;
    return schemaReplaceAnchor(room.ydoc, threadId, anchor);
  }

  /**
   * Return the current doc as a flat plain-text string plus a thread
   * summary. Used by the MCP `get_doc` tool. The plain text is what
   * `find_and_replace` matches against — markdown structure lives in
   * the Y.XmlFragment tree and is visible via block hints but isn't
   * the editable surface.
   */
  getDoc(docId: string): {
    plainText: string;
    blocks: Array<{
      type: string | null;
      headingLevel?: number;
      text: string;
      startOffset: number;
      endOffset: number;
    }>;
    threads: Thread[];
    syncError?: { message: string; at: number };
  } | null {
    const room = this.rooms.get(docId);
    if (!room) return null;
    // Code and diff docs are flat read-only text in the `content` Y.Text,
    // not a prose fragment — surface the whole source as one block. (For a
    // diff doc that text is the file at the target commit.)
    if (contentKind(room.meta.type) === 'flat') {
      const text = room.ydoc.getText('content').toString();
      const syncError = this.fileBindings.get(docId)?.lastSyncError;
      return {
        plainText: text,
        blocks: [{ type: 'code', text, startOffset: 0, endOffset: text.length }],
        threads: listThreads(room.ydoc),
        ...(syncError ? { syncError } : {}),
      };
    }
    const fragment = prose.getProseFragment(room.ydoc);
    const walk = prose.walkProse(fragment);

    // Group segments by their TOP-LEVEL block — so a table's many cells
    // surface as one `type: "table"` block, not N `type: "paragraph"`
    // cells. Same applies to lists (`bulletList` / `orderedList`) — the
    // agent sees the list as one block.
    const grouped: Array<{
      top: Y.XmlElement | null;
      type: string | null;
      text: string;
      startOffset: number;
      endOffset: number;
      headingLevel?: number;
    }> = [];
    const rawText = (node: Y.XmlText): string => {
      let out = '';
      for (const op of node.toDelta() as Array<{ insert?: string }>) {
        if (typeof op.insert === 'string') out += op.insert;
      }
      return out;
    };
    for (const s of walk.segments) {
      const last = grouped[grouped.length - 1];
      if (last && last.top === s.topBlock && s.topBlock != null) {
        last.text += rawText(s.node);
        last.endOffset = s.docOffset + s.length;
      } else {
        grouped.push({
          top: s.topBlock,
          type: s.topBlockType,
          text: rawText(s.node),
          startOffset: s.docOffset,
          endOffset: s.docOffset + s.length,
          ...(s.headingLevel != null ? { headingLevel: s.headingLevel } : {}),
        });
      }
    }
    // Second pass: re-render every block from its Y.XmlElement so
    // block.text is proper markdown — preserving heading levels,
    // code-block fences with language, list bullets/numbering, table
    // pipes, AND inline marks (**bold**, *italic*, `code`, links).
    // Without this, agents reading get_doc lose all formatting cues
    // because the raw-toDelta concat we use for offset-aligned
    // plainText strips marks deliberately.
    for (const g of grouped) {
      if (g.top) {
        const md = prose.serializeBlockToMarkdown(g.top);
        if (md) g.text = md;
      }
    }
    const blocks = grouped.map(({ top, ...rest }) => {
      void top;
      return rest;
    });

    const syncError = this.fileBindings.get(docId)?.lastSyncError;
    return {
      plainText: walk.plainText,
      blocks,
      threads: listThreads(room.ydoc),
      ...(syncError ? { syncError } : {}),
    };
  }

  /**
   * Build the file-tree view for a workspace: every doc tagged with
   * `workspaceId`, arranged into a nested directory tree by its `relPath`,
   * with per-file unresolved-comment counts and folder roll-ups.
   *
   * Each FILE node carries `{docId, name, relPath, fileType, openCount,
   * threadCount, reviewUrl?, lastActivityAt}`. Each DIR node carries a
   * rolled-up `openCount` = sum of every descendant file's openCount.
   *
   * Sort within each level: directories first, then open-count desc, then
   * name asc — so the folders/files that need attention float up, matching
   * the landing page's "what needs my review?" ordering.
   *
   * `reviewUrl` is filled in by the caller via the rooms decorator
   * (`decorateDocMeta`) so the URL machinery stays in the server layer.
   */
  buildWorkspaceTree(workspaceId: string): WorkspaceTree {
    const decorate = this.cfg.decorateDocMeta;
    const root: WorkspaceDirNode = { type: 'dir', name: '', openCount: 0, children: [] };
    let totalOpen = 0;
    let workspaceRoot: string | undefined;

    for (const meta of this.list()) {
      if (meta.workspaceId !== workspaceId) continue;
      if (!workspaceRoot && meta.workspaceRoot) workspaceRoot = meta.workspaceRoot;
      const relPath = meta.relPath ?? meta.docId;
      const openCount = this.listThreads(meta.docId, { status: 'open' }).length;
      const threadCount = this.listThreads(meta.docId).length;
      totalOpen += openCount;
      const decorated = decorate ? decorate(meta) : meta;
      const fileNode: WorkspaceFileNode = {
        type: 'file',
        docId: meta.docId,
        name: relPath.split('/').pop() ?? relPath,
        relPath,
        fileType: meta.type,
        openCount,
        threadCount,
        reviewUrl: (decorated as { reviewUrl?: string }).reviewUrl,
        lastActivityAt: meta.lastActivityAt,
        ...(meta.diffStatus !== undefined ? { diffStatus: meta.diffStatus } : {}),
        ...(meta.diffAdditions !== undefined ? { diffAdditions: meta.diffAdditions } : {}),
        ...(meta.diffDeletions !== undefined ? { diffDeletions: meta.diffDeletions } : {}),
      };
      // Walk/create the directory chain, accumulating openCount as we go.
      const parts = relPath.split('/');
      const dirs = parts.slice(0, -1);
      let cursor = root;
      cursor.openCount += openCount;
      for (const part of dirs) {
        let next = cursor.children.find(
          (c): c is WorkspaceDirNode => c.type === 'dir' && c.name === part,
        );
        if (!next) {
          next = { type: 'dir', name: part, openCount: 0, children: [] };
          cursor.children.push(next);
        }
        next.openCount += openCount;
        cursor = next;
      }
      cursor.children.push(fileNode);
    }

    sortTreeChildren(root);
    return { workspaceId, root: workspaceRoot, totalOpen, tree: root };
  }

  /**
   * Bind a whole folder/worktree for review. Scans the folder for
   * supported files, creates one review doc per file grouped under a
   * single `workspaceId`, and returns the resulting file list plus a
   * record of anything skipped.
   *
   * Scan strategy: prefer `git ls-files` (respects .gitignore for free —
   * skips node_modules/dist/etc); fall back to a recursive readdir with a
   * hardcoded skip set when the folder isn't a git repo.
   *
   * Allowlist by extension: .md → markdown (WYSIWYG, editable, write-back);
   * code extensions → read-only syntax-highlighted source. Files that are
   * too big (>512 KB) or look binary (NUL byte in the first 8 KB) are
   * recorded in `skipped[]` and never bound.
   *
   * Guardrail: if the surviving file count exceeds `maxFiles` (default
   * 300), nothing is created — returns `{ ok:false, error:'too-many-files',
   * fileCount }` so a stray bind on a giant tree can't melt the server with
   * thousands of mtime polls.
   *
   * Deterministic docIds (`${workspaceId}:${relPath}`) make re-binding
   * idempotent: the same file maps to the same docId, so threads survive.
   */
  /** Bind a whole folder/worktree for review — see binds.ts. */
  bindFolder(opts: BindFolderOpts): BindFolderResult {
    return bindFolderImpl(this, opts);
  }

  /** Bind a git diff (working-tree or pinned) for review — see binds.ts. */
  bindDiff(opts: BindDiffOpts): BindDiffResult {
    return bindDiffImpl(this, opts);
  }

  /**
   * List the bound workspaces with rolled-up triage signals — so the daily
   * cleanup can treat a folder bind as ONE unit instead of nagging per file.
   * Each entry aggregates its member docs (`meta.workspaceId === id`):
   *   - `fileCount`     number of member docs
   *   - `openThreads`   sum of every member's open-thread count
   *   - `allIdle`       true iff EVERY member is idle (lastActivityAt older
   *                     than 24h) — a workspace is only idle when nothing in
   *                     it has moved recently
   *   - `owner`         the creating agent's cwd (first member that has one)
   *   - `lastActivityAt` max member lastActivityAt (most recent touch)
   */
  listWorkspaces(now: number = Date.now()): Array<{
    workspaceId: string;
    root?: string;
    title?: string;
    owner?: string;
    fileCount: number;
    openThreads: number;
    allIdle: boolean;
    lastActivityAt?: number;
  }> {
    const IDLE_MS = 24 * 60 * 60 * 1000;
    const byId = new Map<
      string,
      {
        workspaceId: string;
        root?: string;
        title?: string;
        owner?: string;
        fileCount: number;
        openThreads: number;
        allIdle: boolean;
        lastActivityAt?: number;
      }
    >();
    for (const meta of this.list()) {
      const id = meta.workspaceId;
      if (!id) continue;
      let entry = byId.get(id);
      if (!entry) {
        entry = {
          workspaceId: id,
          root: meta.workspaceRoot,
          title: meta.title,
          owner: meta.owner,
          fileCount: 0,
          openThreads: 0,
          allIdle: true,
          lastActivityAt: undefined,
        };
        byId.set(id, entry);
      }
      if (!entry.root && meta.workspaceRoot) entry.root = meta.workspaceRoot;
      if (!entry.owner && meta.owner) entry.owner = meta.owner;
      entry.fileCount += 1;
      entry.openThreads += this.listThreads(meta.docId, { status: 'open' }).length;
      const last = meta.lastActivityAt ?? meta.createdAt;
      if (entry.lastActivityAt === undefined || last > entry.lastActivityAt) {
        entry.lastActivityAt = last;
      }
      // A member is idle if its last activity is older than 24h. The
      // workspace is idle only when every member is — so a single recently
      // touched file keeps the whole workspace out of the cleanup queue.
      if (now - last < IDLE_MS) entry.allIdle = false;
    }
    return Array.from(byId.values()).sort((a, b) => {
      if (a.openThreads !== b.openThreads) return b.openThreads - a.openThreads;
      return a.workspaceId.localeCompare(b.workspaceId);
    });
  }

  /**
   * Delete a whole workspace (a bound folder) as one unit: loop its member
   * docs and `deleteDoc` each, applying the per-file open-thread guardrail.
   *
   * Semantics are ALL-OR-NOTHING:
   *   - WITHOUT `force`: if ANY member still has open threads, abort the
   *     entire delete (nothing is removed) and return the offending files.
   *   - WITH `force`: delete every member regardless of open threads.
   *
   * The bound SOURCE files on disk are left untouched (same as deleteDoc).
   */
  deleteWorkspace(
    workspaceId: string,
    opts?: { force?: boolean },
  ):
    | { ok: true; deleted: number }
    | { ok: false; error: 'not-found' }
    | {
        ok: false;
        error: 'has-open-threads';
        files: Array<{ docId: string; openThreads: number }>;
      } {
    const members = this.list().filter((m) => m.workspaceId === workspaceId);
    if (members.length === 0) return { ok: false, error: 'not-found' };
    if (!opts?.force) {
      // Pre-flight the guardrail across ALL members before deleting any, so a
      // workspace with even one open thread is left fully intact.
      const blocked: Array<{ docId: string; openThreads: number }> = [];
      for (const m of members) {
        const openThreads = this.listThreads(m.docId, { status: 'open' }).length;
        if (openThreads > 0) blocked.push({ docId: m.docId, openThreads });
      }
      if (blocked.length > 0) return { ok: false, error: 'has-open-threads', files: blocked };
    }
    let deleted = 0;
    for (const m of members) {
      const res = this.deleteDoc(m.docId, { force: true });
      if (res.ok) deleted += 1;
    }
    return { ok: true, deleted };
  }

  /**
   * Bind a doc to a file path on disk. After attach:
   *   - if the doc's prose fragment is empty AND the file exists with
   *     content, the file is parsed and seeded into the fragment
   *   - every subsequent prose change debounces a write of the
   *     serialized markdown back to the file (default 800ms)
   *
   * File path is resolved relative to the server's process cwd if
   * relative. An absolute path is strongly recommended.
   *
   * Bidirectional sync:
   *   doc → disk — every prose change debounces an 800ms serialize+write
   *   disk → doc — fs.watch fires on external edits, debounced 300ms,
   *     reads the file, diffs against current serialized output, and if
   *     different applies the new markdown in one 'file-watch' transact.
   *   Echo loop is broken by `binding.lastWritten` on both sides — a
   *   write we initiated won't be re-applied, and a read that matches
   *   our cached content is silently ignored.
   */
  attachFile(
    docId: string,
    filePath: string,
  ): {
    ok: boolean;
    error?: 'not-found' | 'path-empty' | 'read-failed';
    seeded?: boolean;
    resolvedPath?: string;
  } {
    if (!filePath || filePath.trim() === '') return { ok: false, error: 'path-empty' };
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'not-found' };
    const abs = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath);
    const fragment = prose.getProseFragment(room.ydoc);
    let seeded = false;
    if (fragment.length === 0 && existsSync(abs)) {
      try {
        const md = readFileSync(abs, 'utf8');
        const blocks = prose.parseMarkdownBlocks(md);
        if (blocks.length > 0) {
          room.ydoc.transact(() => fragment.push(blocks), 'file-seed');
          seeded = true;
        }
      } catch (err) {
        console.error(`[rooms] read failed for ${abs}:`, err);
        return { ok: false, error: 'read-failed' };
      }
    }
    const existing = this.fileBindings.get(docId);
    if (existing?.writeTimer) clearTimeout(existing.writeTimer);
    if (existing?.readTimer) clearTimeout(existing.readTimer);
    if (existing?.pollTimer) clearInterval(existing.pollTimer);
    const binding: FileBinding = { path: abs };
    this.fileBindings.set(docId, binding);
    // sourceUrl mirrors the path so UI headers can show "Editing: <path>"
    if (!room.meta.sourceUrl) {
      const m = room.ydoc.getMap('meta');
      room.ydoc.transact(() => m.set('sourceUrl', abs));
      room.meta.sourceUrl = abs;
    }
    // doc → disk: every change schedules a debounced write.
    fragment.observeDeep((_events, tr) => {
      // Don't echo our own seed-from-disk or file-watch apply back to disk.
      if (tr.origin === 'file-seed' || tr.origin === 'file-watch') return;
      this.scheduleFileWrite(room, binding);
    });
    if (seeded) binding.lastWritten = prose.serializeFragmentToMarkdown(fragment);

    // disk → doc: poll for external edits (see armFileWatcher).
    this.armFileWatcher(room, binding);

    return { ok: true, seeded, resolvedPath: abs };
  }

  /**
   * Bind a READ-ONLY source file (type='code') for review. The file's raw
   * text is seeded into the flat `content` Y.Text (no markdown parse), the
   * mtime poll is armed for disk→doc refresh, and — crucially — there is NO
   * doc→disk write-back: the browser never edits a code file (it only
   * comments), so the file is never rewritten by live-feedback. The agent
   * edits the source via its normal tools; the poll re-renders the view.
   */
  attachReadonlyFile(
    docId: string,
    filePath: string,
  ): { ok: boolean; error?: 'not-found' | 'path-empty' | 'read-failed'; resolvedPath?: string } {
    if (!filePath || filePath.trim() === '') return { ok: false, error: 'path-empty' };
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'not-found' };
    const abs = filePath.startsWith('/') ? filePath : join(process.cwd(), filePath);
    const content = room.ydoc.getText('content');
    let text = '';
    if (existsSync(abs)) {
      try {
        text = readFileSync(abs, 'utf8');
      } catch (err) {
        console.error(`[rooms] read failed for ${abs}:`, err);
        return { ok: false, error: 'read-failed' };
      }
    }
    // Sync content to the file's CURRENT bytes. The surface is read-only —
    // the live doc never holds browser edits — so disk is authoritative at
    // attach time. This covers both the first seed and content that drifted
    // while the server was down: the poll's mtime baseline resets on attach,
    // so a change missed during downtime would otherwise stay stale until
    // the NEXT disk write. The 'file-watch' origin routes the replace
    // through the same reanchor sweep as a live edit.
    if (existsSync(abs) && text !== content.toString()) {
      const origin = content.length === 0 ? 'file-seed' : 'file-watch';
      room.ydoc.transact(() => {
        if (content.length > 0) content.delete(0, content.length);
        if (text.length > 0) content.insert(0, text);
      }, origin);
    }
    const existing = this.fileBindings.get(docId);
    if (existing?.writeTimer) clearTimeout(existing.writeTimer);
    if (existing?.readTimer) clearTimeout(existing.readTimer);
    if (existing?.pollTimer) clearInterval(existing.pollTimer);
    const binding: FileBinding = { path: abs, lastWritten: content.toString() };
    this.fileBindings.set(docId, binding);
    if (!room.meta.sourceUrl) {
      const m = room.ydoc.getMap('meta');
      room.ydoc.transact(() => m.set('sourceUrl', abs));
      room.meta.sourceUrl = abs;
    }
    // NO write-back observer for code docs (read-only). Only disk → doc.
    this.armFileWatcher(room, binding);
    return { ok: true, resolvedPath: abs };
  }

  /**
   * Watch the bound file for external edits via an mtime poll.
   *
   * We deliberately do NOT use fs.watch. A file-level fs.watch is bound to
   * the inode present at watch-creation time (kqueue on macOS, inotify on
   * Linux). Editors — and Claude Code's own Edit tool — save via
   * write-temp-then-rename, which atomically replaces the file's inode, so
   * the watch goes stale and only the FIRST external edit ever reaches the
   * live doc (deterministic repro on Bun + Node). Watching the parent
   * directory dodges the inode problem on macOS but proved unreliable under
   * Bun-on-Linux. A stat-mtime poll is immune to all of it — inode
   * replacement, platform, and runtime — and ~1s latency matches the doc's
   * existing sync contract.
   */
  private armFileWatcher(room: DocRoom, binding: FileBinding): void {
    if (binding.pollTimer) clearInterval(binding.pollTimer);
    binding.pollTimer = null;
    if (!existsSync(binding.path)) return;
    try {
      binding.lastMtimeMs = statSync(binding.path).mtimeMs;
    } catch {}
    const timer = setInterval(() => {
      let mtimeMs: number;
      try {
        if (!existsSync(binding.path)) return;
        mtimeMs = statSync(binding.path).mtimeMs;
      } catch (err) {
        console.error(`[rooms] stat failed for ${binding.path}:`, err);
        return;
      }
      if (mtimeMs === binding.lastMtimeMs) return;
      binding.lastMtimeMs = mtimeMs;
      // Debounce so we don't read a half-written file mid-save.
      if (binding.readTimer) clearTimeout(binding.readTimer);
      binding.readTimer = setTimeout(() => this.reconcileFromDisk(room, binding), 150);
    }, 500);
    // Don't let the poll keep the process (or a test runner) alive.
    timer.unref?.();
    binding.pollTimer = timer;
  }

  /**
   * Force a re-parse of the bound file into the live doc, ignoring
   * the currentSerialized match and lastWritten guards. Useful when
   * the parser itself changed (e.g. after a fix) and the on-disk
   * content would parse differently now even though its bytes are
   * unchanged.
   */
  reparseFromDisk(docId: string): { ok: boolean; error?: 'not-found' | 'no-binding' | 'missing' } {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'not-found' };
    // PINNED diff docs have no file binding — their content is pinned to a
    // commit. Recover by re-reading the file at the target hash from the
    // repo. (Working-tree diff docs have a live binding and fall through to
    // the normal flat-text path below.)
    if (room.meta.type === 'diff' && room.meta.diffTarget) {
      const { workspaceRoot, diffTarget, relPath, diffStatus } = room.meta;
      if (!workspaceRoot || !diffTarget || !relPath) return { ok: false, error: 'no-binding' };
      if (diffStatus === 'deleted') return { ok: true };
      const text = showFile(workspaceRoot, diffTarget, relPath);
      if (text === null) return { ok: false, error: 'missing' };
      const content = room.ydoc.getText('content');
      room.ydoc.transact(() => {
        content.delete(0, content.length);
        content.insert(0, text);
      }, 'file-watch');
      return { ok: true };
    }
    const binding = this.fileBindings.get(docId);
    if (!binding) return { ok: false, error: 'no-binding' };
    if (!existsSync(binding.path)) return { ok: false, error: 'missing' };
    let md: string;
    try {
      md = readFileSync(binding.path, 'utf8');
    } catch {
      return { ok: false, error: 'missing' };
    }
    if (contentKind(room.meta.type) === 'flat') {
      const content = room.ydoc.getText('content');
      room.ydoc.transact(() => {
        content.delete(0, content.length);
        content.insert(0, md);
      }, 'file-watch');
      binding.lastWritten = md;
      binding.lastSyncError = undefined;
      return { ok: true };
    }
    const blocks = prose.parseMarkdownBlocks(md);
    if (blocks.length === 0) return { ok: false, error: 'missing' };
    const fragment = prose.getProseFragment(room.ydoc);
    room.ydoc.transact(() => {
      fragment.delete(0, fragment.length);
      fragment.push(blocks);
    }, 'file-watch');
    binding.lastWritten = md;
    binding.lastSyncError = undefined;
    return { ok: true };
  }

  /**
   * External file changed — read it, compare to what we think is
   * canonical, and apply the delta to the live doc if different.
   * Applies in one transact origin='file-watch' so the doc→disk
   * observer knows not to re-flush (which would bounce back here).
   */
  private reconcileFromDisk(room: DocRoom, binding: FileBinding): void {
    if (!existsSync(binding.path)) return;
    let md: string;
    try {
      md = readFileSync(binding.path, 'utf8');
    } catch (err) {
      console.error(`[rooms] read failed for ${binding.path}:`, err);
      return;
    }
    // Code and working-tree diff docs are flat text — replace the whole
    // `content` Y.Text on change. No write-back means no live edits, so
    // there's never a conflict; the pure decideReconcile is reused only to
    // skip no-op reads.
    if (contentKind(room.meta.type) === 'flat') {
      const content = room.ydoc.getText('content');
      const current = content.toString();
      const decision = decideReconcile({
        disk: md,
        lastWritten: binding.lastWritten,
        currentSerialized: current,
      });
      if (decision === 'in-sync') return;
      if (decision === 'catch-up') {
        binding.lastWritten = md;
        return;
      }
      room.ydoc.transact(() => {
        content.delete(0, content.length);
        content.insert(0, md);
      }, 'file-watch');
      binding.lastWritten = md;
      binding.lastSyncError = undefined;
      return;
    }
    const fragment = prose.getProseFragment(room.ydoc);
    const currentSerialized = prose.serializeFragmentToMarkdown(fragment);
    const decision = decideReconcile({
      disk: md,
      lastWritten: binding.lastWritten,
      currentSerialized,
    });
    // Same content as last round-trip → nothing to do.
    if (decision === 'in-sync') return;
    // The live doc already serializes to disk (up to serializer whitespace) —
    // just catch up bookkeeping, don't touch the fragment.
    if (decision === 'catch-up') {
      binding.lastWritten = md;
      return;
    }
    if (decision === 'conflict') {
      // An external write collided with un-flushed live edits. A blind
      // delete+push here would clobber the human's in-progress work (the bug
      // a peer reported). The editor is the runtime source of truth, so keep
      // the live edits and reassert them to disk via the debounced writer.
      // The dropped external change is recoverable with reparse_from_disk.
      binding.lastSyncError = {
        message:
          'external file change collided with un-flushed live edits; kept live edits (use reparse_from_disk to force disk)',
        at: Date.now(),
      };
      console.warn(
        `[rooms] ${room.docId}: disk↔doc conflict for ${binding.path}; kept live edits, reasserting to disk`,
      );
      this.scheduleFileWrite(room, binding);
      return;
    }
    // decision === 'apply' — disk changed externally and the live doc is clean.
    let blocks: Y.XmlElement[];
    try {
      blocks = prose.parseMarkdownBlocks(md);
    } catch (err) {
      // A parse throw used to vanish into the setTimeout callback, leaving
      // the doc silently serving pre-edit content. Record + log instead so
      // getDoc can report WHY it's stale. The fragment is left untouched
      // (we never started the transact), so the next edit retries cleanly.
      const message = err instanceof Error ? err.message : String(err);
      binding.lastSyncError = { message: `parse failed: ${message}`, at: Date.now() };
      console.error(`[rooms] ${room.docId}: disk→doc parse failed for ${binding.path}:`, err);
      return;
    }
    if (blocks.length === 0) {
      // Don't wipe to empty on a parse that produced nothing — but DON'T
      // do it silently either (the old behavior). Surface it.
      binding.lastSyncError = {
        message: 'disk content parsed to zero blocks; live doc left unchanged',
        at: Date.now(),
      };
      console.warn(
        `[rooms] ${room.docId}: disk→doc reconcile yielded 0 blocks from ${binding.path}; keeping prior state`,
      );
      return;
    }
    // Apply destructively: parse fresh, replace all blocks. Y.XmlText
    // identities change so thread anchors in the replaced region may
    // orphan — auto-reanchor's snippet-match sweep catches the common
    // case on the next tick.
    room.ydoc.transact(() => {
      fragment.delete(0, fragment.length);
      fragment.push(blocks);
    }, 'file-watch');
    binding.lastWritten = md;
    binding.lastSyncError = undefined;
    console.log(
      `[rooms] ${room.docId}: applied external edit from ${binding.path} (${blocks.length} blocks)`,
    );
  }

  private scheduleFileWrite(room: DocRoom, binding: FileBinding): void {
    if (binding.writeTimer) clearTimeout(binding.writeTimer);
    binding.writeTimer = setTimeout(() => {
      try {
        const md = prose.serializeFragmentToMarkdown(prose.getProseFragment(room.ydoc));
        if (md === binding.lastWritten) return;
        writeFileSync(binding.path, md);
        binding.lastWritten = md;
        // Record our own write's mtime so the poll doesn't treat the
        // write-back as an external edit and schedule a redundant reconcile.
        try {
          binding.lastMtimeMs = statSync(binding.path).mtimeMs;
        } catch {}
      } catch (err) {
        console.error(`[rooms] file write failed for ${binding.path}:`, err);
      }
    }, 800);
  }

  /**
   * Replace `find` with `replace` inside the doc. Optional context
   * string around the match disambiguates repeated phrases; pass
   * `occurrence` to pick by index when you know the match count.
   */
  findAndReplace(
    docId: string,
    opts: {
      find: string;
      replace: string;
      contextBefore?: string;
      contextAfter?: string;
      occurrence?: number;
      parseInlineMarks?: boolean;
    },
  ): prose.ReplaceResult {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'no-match' };
    return prose.findAndReplace(room.ydoc, opts);
  }

  /**
   * Rewrite the range a text-range thread is anchored to. The thread
   * anchor is authoritative — we never recompute offsets on the
   * client. When the anchor is orphaned (user deleted the text) the
   * caller gets `anchor-orphaned` back and should either re-anchor or
   * fall back to `findAndReplace`.
   */
  rewriteThreadRegion(
    docId: string,
    threadId: string,
    replacement: string,
    opts?: { parseInlineMarks?: boolean },
  ): prose.AnchoredEditResult {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'anchor-not-found' };
    const thread = this.getThread(docId, threadId);
    if (!thread) return { ok: false, error: 'anchor-not-found' };
    if (thread.anchor.kind !== 'text-range') return { ok: false, error: 'anchor-orphaned' };
    return prose.rewriteRange(room.ydoc, {
      startRel: thread.anchor.startRel,
      endRel: thread.anchor.endRel,
      replacement,
      parseInlineMarks: opts?.parseInlineMarks === true,
    });
  }

  /**
   * Agent anchors — the agent can mint its own named pointers into the
   * doc for batch edits. Stored separately from comment threads.
   */
  createAgentAnchor(
    docId: string,
    opts: {
      find: string;
      contextBefore?: string;
      contextAfter?: string;
      occurrence?: number;
      label?: string;
    },
  ): prose.CreateAnchorResult {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'no-match' };
    return prose.createAgentAnchor(room.ydoc, opts);
  }

  editAtAgentAnchor(
    docId: string,
    anchorId: string,
    op: { kind: 'replace'; text: string } | { kind: 'insert_after'; text: string },
  ): prose.AnchoredEditResult {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'anchor-not-found' };
    const anchor = prose.readAgentAnchor(room.ydoc, anchorId);
    if (!anchor) return { ok: false, error: 'anchor-not-found' };
    if (op.kind === 'replace') {
      return prose.rewriteRange(room.ydoc, {
        startRel: anchor.startRel,
        endRel: anchor.endRel,
        replacement: op.text,
      });
    }
    return prose.insertAfterRange(room.ydoc, { endRel: anchor.endRel, text: op.text });
  }

  deleteAgentAnchor(docId: string, anchorId: string): boolean {
    const room = this.rooms.get(docId);
    if (!room) return false;
    return prose.deleteAgentAnchor(room.ydoc, anchorId);
  }

  /**
   * Parse markdown into block elements and insert them as siblings
   * immediately after the block that contains the agent anchor.
   * Use this for adding new headings / paragraphs / lists / tables —
   * `edit_at_anchor` with `insert_after` does a character-stream
   * insert which keeps the new text inside the anchor's block,
   * producing literal `## Heading` text instead of a heading element.
   */
  insertBlocksAtAnchor(
    docId: string,
    anchorId: string,
    markdown: string,
  ): prose.AnchoredEditResult {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'anchor-not-found' };
    const anchor = prose.readAgentAnchor(room.ydoc, anchorId);
    if (!anchor) return { ok: false, error: 'anchor-not-found' };
    return prose.insertBlocksAfterAnchor(room.ydoc, {
      anchorRel: anchor.endRel,
      markdown,
    });
  }

  /** Append text at the END position of a thread's anchored range. */
  insertAfterThread(docId: string, threadId: string, text: string): prose.AnchoredEditResult {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'anchor-not-found' };
    const thread = this.getThread(docId, threadId);
    if (!thread) return { ok: false, error: 'anchor-not-found' };
    if (thread.anchor.kind !== 'text-range') return { ok: false, error: 'anchor-orphaned' };
    return prose.insertAfterRange(room.ydoc, { endRel: thread.anchor.endRel, text });
  }

  /**
   * Parse markdown into block elements and insert them immediately
   * after the block that contains the thread's anchor. Use this for
   * "add a section below this comment" — the anchor picks the
   * location, the markdown describes the new blocks.
   */
  insertBlocksAfterThread(
    docId: string,
    threadId: string,
    markdown: string,
  ): prose.AnchoredEditResult {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'anchor-not-found' };
    const thread = this.getThread(docId, threadId);
    if (!thread) return { ok: false, error: 'anchor-not-found' };
    if (thread.anchor.kind !== 'text-range') return { ok: false, error: 'anchor-orphaned' };
    return prose.insertBlocksAfterAnchor(room.ydoc, {
      anchorRel: thread.anchor.endRel,
      markdown,
    });
  }

  /**
   * Delete the single block containing a thread's anchored range. Use
   * for "remove the paragraph this comment points at." Empty-string
   * find_and_replace cannot do this — it removes text but leaves the
   * empty block element behind.
   */
  deleteBlockAtThread(docId: string, threadId: string): prose.DeleteBlockResult {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'anchor-orphaned' };
    const thread = this.getThread(docId, threadId);
    if (!thread) return { ok: false, error: 'anchor-orphaned' };
    if (thread.anchor.kind !== 'text-range') return { ok: false, error: 'anchor-orphaned' };
    return prose.deleteBlockAtAnchor(room.ydoc, { anchorRel: thread.anchor.startRel });
  }

  /** Same, keyed on an agent anchor. */
  deleteBlockAtAgentAnchor(docId: string, anchorId: string): prose.DeleteBlockResult {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'anchor-orphaned' };
    const anchor = prose.readAgentAnchor(room.ydoc, anchorId);
    if (!anchor) return { ok: false, error: 'anchor-orphaned' };
    return prose.deleteBlockAtAnchor(room.ydoc, { anchorRel: anchor.startRel });
  }

  /** Delete every top-level block from start match through end match.
   *  Block-inclusive — partial match still deletes the whole block. */
  deleteBlocksInRange(
    docId: string,
    opts: {
      startFind: string;
      endFind: string;
      contextBefore?: string;
      contextAfter?: string;
      startOccurrence?: number;
      endOccurrence?: number;
    },
  ): prose.DeleteBlocksInRangeResult {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'no-match' };
    return prose.deleteBlocksInRange(room.ydoc, opts);
  }

  /** Delete a heading block + everything until the next heading at ≤ level. */
  deleteSection(
    docId: string,
    opts: { heading: string; level?: number; occurrence?: number },
  ): prose.DeleteSectionResult {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'no-match' };
    return prose.deleteSection(room.ydoc, opts);
  }

  /**
   * Sweep every text-range thread in a doc and best-effort re-anchor
   * the ones whose Y.RelativePosition no longer resolves. Idempotent —
   * safe to call on every significant doc change.
   */
  autoReanchor(docId: string): { checked: number; reanchored: number; stillOrphan: number } | null {
    const room = this.rooms.get(docId);
    if (!room) return null;
    return prose.autoReanchorDoc(room.ydoc);
  }

  listThreads(docId: string, filter?: { status?: 'open' | 'resolved' }): Thread[] {
    const room = this.rooms.get(docId);
    if (!room) return [];
    const all = listThreads(room.ydoc);
    return filter?.status ? all.filter((t) => t.status === filter.status) : all;
  }

  getThread(docId: string, threadId: string): Thread | null {
    const room = this.rooms.get(docId);
    if (!room) return null;
    return listThreads(room.ydoc).find((t) => t.id === threadId) ?? null;
  }

  /**
   * Append a comment-family activity event (comment / reply / resolve /
   * reopen) for a successful thread action. Both person and agent actions are
   * recorded — agent events carry actor:'agent' so the Weekly Review agent can
   * filter them, but person events are never dropped. Best-effort: any failure
   * is swallowed so activity capture can't break the action it observes.
   */
  private recordActivity(
    room: DocRoom,
    type: ActivityType,
    author: User,
    threadId: string,
    opts: { text?: string; tsMs: number },
  ): void {
    try {
      const actor = classifyActor(author);
      const ts = toUtcIso(opts.tsMs);
      const payload: Event['payload'] =
        opts.text !== undefined ? { text: opts.text, wordCount: wordCount(opts.text) } : {};
      const id = eventId({
        ts,
        actor,
        docId: room.docId,
        type,
        threadId,
        payloadDigest: payloadDigest(opts.text),
      });
      const event: Event = {
        eventId: id,
        ts,
        type,
        actor,
        actorId: author.id,
        actorName: author.name,
        isOwner: isOwnerActor(author),
        threadId,
        doc: buildEventDoc(room.meta),
        payload,
      };
      appendActivity(this.cfg.dataDir, event);
    } catch (err) {
      console.error('[rooms] recordActivity failed:', err);
    }
  }

  /**
   * Append a browser-originated reading event (read_session / doc_open). The
   * client posts the interaction-bounded payload; the server resolves the doc
   * / repo / producedBy and stamps actor=person, ts=now. Unknown `type`s are
   * rejected so a malformed POST can't poison the stream.
   */
  recordReadEvent(
    docId: string,
    type: 'read_session' | 'doc_open',
    payload: Event['payload'],
    author: User,
  ): { ok: boolean; error?: 'no-doc' | 'bad-type' | 'append-failed' } {
    if (type !== 'read_session' && type !== 'doc_open') {
      return { ok: false, error: 'bad-type' };
    }
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'no-doc' };
    try {
      // Re-clamp the browser-supplied duration/scroll fields server-side so a
      // spoofed or buggy POST can't write an inflated read time.
      clampReadPayload(payload);
      const ts = toUtcIso(Date.now());
      const sessionId = payload.sessionId;
      const id = eventId({
        ts,
        actor: 'person',
        docId,
        type,
        threadId: null,
        payloadDigest: payloadDigest(sessionId),
      });
      const event: Event = {
        eventId: id,
        ts,
        type,
        actor: 'person',
        actorId: author.id,
        actorName: author.name,
        isOwner: isOwnerActor(author),
        doc: buildEventDoc(room.meta),
        payload,
      };
      appendActivity(this.cfg.dataDir, event);
      return { ok: true };
    } catch (err) {
      console.error('[rooms] recordReadEvent failed:', err);
      return { ok: false, error: 'append-failed' };
    }
  }

  private fireEvent(
    room: DocRoom,
    event: 'thread.created' | 'thread.replied' | 'thread.resolved' | 'thread.reopened',
    thread: Thread,
    comment?: { id: string; author: User; text: string; ts: number },
  ): void {
    room.seq++;
    const decorate = this.cfg.decorateDocMeta ?? ((m) => m);
    const payload = {
      event,
      docId: room.docId,
      threadId: thread.id,
      thread,
      doc: decorate(room.meta),
      comment,
      seq: room.seq,
    };
    this.cfg.sse.broadcast(room.docId, payload);
    if (room.webhookUrl) {
      void this.cfg.webhooks.send(room.webhookUrl, payload);
    }
  }

  private wireEvents(room: DocRoom): void {
    room.ydoc.on('update', () => {
      this.saveToDisk(room);
    });
    // Code and diff docs have no prose fragment — the prose-fragment
    // auto-reanchor sweep below would find nothing and orphan every thread.
    // Run the flat-text twin instead: observe the raw `content` Y.Text and
    // re-anchor threads by snippet match. (Diff content is pinned to a
    // commit and normally never changes, but a reparse after data loss
    // re-seeds it, and the sweep re-anchors threads then.)
    if (contentKind(room.meta.type) === 'flat') {
      const content = room.ydoc.getText('content');
      let codeReanchorTimer: ReturnType<typeof setTimeout> | null = null;
      content.observe((_event, tr) => {
        if (tr.origin === 'agent-reanchor') return;
        if (codeReanchorTimer) clearTimeout(codeReanchorTimer);
        codeReanchorTimer = setTimeout(() => {
          const res = prose.autoReanchorCodeDoc(room.ydoc);
          if (res.reanchored > 0 || res.stillOrphan > 0) {
            console.log(
              `[rooms] ${room.docId}: code re-anchor — ${res.reanchored} fixed, ${res.stillOrphan} orphaned`,
            );
          }
        }, 250);
      });
      const initialCode = prose.autoReanchorCodeDoc(room.ydoc);
      if (initialCode.reanchored > 0) {
        console.log(
          `[rooms] ${room.docId}: on-load code re-anchored ${initialCode.reanchored} thread(s)`,
        );
      }
      return;
    }
    // Every prose change triggers a best-effort sweep that rebuilds
    // Y.RelativePositions for threads whose anchors no longer resolve
    // (e.g. the user split a block or re-typed the anchored text —
    // prosemirror can destroy the original Y.XmlText during those).
    // Debounced so a burst of keystrokes only does one sweep.
    const fragment = prose.getProseFragment(room.ydoc);
    let reanchorTimer: ReturnType<typeof setTimeout> | null = null;
    fragment.observeDeep((_events, tr) => {
      // Don't re-enter on our own re-anchor writes.
      if (tr.origin === 'agent-reanchor') return;
      if (reanchorTimer) clearTimeout(reanchorTimer);
      reanchorTimer = setTimeout(() => {
        const res = prose.autoReanchorDoc(room.ydoc);
        if (res.reanchored > 0) {
          console.log(`[rooms] ${room.docId}: auto-reanchored ${res.reanchored} thread(s)`);
        }
      }, 250);
    });
    // Also sweep once on room load so threads recover after server
    // restart even if no new edits happen.
    const initial = prose.autoReanchorDoc(room.ydoc);
    if (initial.reanchored > 0) {
      console.log(`[rooms] ${room.docId}: on-load auto-reanchored ${initial.reanchored} thread(s)`);
    }
  }

  private pathFor(docId: string): string {
    // keep docId simple; validate in API layer
    return join(this.cfg.dataDir, `${docId}.ydoc`);
  }

  private loadFromDisk(docId: string, ydoc: Y.Doc): void {
    const path = this.pathFor(docId);
    if (!existsSync(path)) return;
    try {
      const buf = readFileSync(path);
      Y.applyUpdate(ydoc, new Uint8Array(buf));
    } catch (err) {
      console.error(`[rooms] failed to load ${docId}:`, err);
    }
  }

  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private saveToDisk(room: DocRoom): void {
    const prev = this.saveTimers.get(room.docId);
    if (prev) clearTimeout(prev);
    this.saveTimers.set(
      room.docId,
      setTimeout(() => {
        try {
          const update = Y.encodeStateAsUpdate(room.ydoc);
          writeFileSync(this.pathFor(room.docId), update);
        } catch (err) {
          console.error(`[rooms] failed to persist ${room.docId}:`, err);
        }
      }, 200),
    );
  }
}

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** Resolve / reopen actions come from the reviewer surface, which doesn't
 *  send an author in the body. Default to the known reviewer (Bryan, the
 *  doc owner) so the activity stream attributes them to a person. The route
 *  may override by passing an explicit author. */
const DEFAULT_REVIEWER: User = {
  id: 'known-bryan',
  name: 'Bryan',
  kind: 'known',
  color: '#2e7dd7',
};

/**
 * Sort a workspace dir node's children in place, recursively: directories
 * first, then by open-count descending (attention floats up), then by name
 * ascending. Mirrors the landing page's "what needs my review?" ordering.
 */
function sortTreeChildren(node: WorkspaceDirNode): void {
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    if (a.openCount !== b.openCount) return b.openCount - a.openCount;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) {
    if (child.type === 'dir') sortTreeChildren(child);
  }
}
