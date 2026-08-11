import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
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
  type WebhookPayload,
  contentKind,
  createThread,
  initDocMeta,
  listThreads,
  prose,
  readDocMeta,
  postReply as schemaPostReply,
  replaceAnchor as schemaReplaceAnchor,
  setStatus as schemaSetStatus,
  setThreadSummary,
  suggestOps,
} from '@feedback/core';
import type { ServerWebSocket } from 'bun';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';

import { type StoredSummary, needsCall } from '@feedback/core/summary-prompt';
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
  type RefreshWorkspaceResult,
  type SetWorkspaceGroupsResult,
  bindDiff as bindDiffImpl,
  bindFolder as bindFolderImpl,
  memberDocId,
  refreshWorkspace as refreshWorkspaceImpl,
  setWorkspaceGroups as setWorkspaceGroupsImpl,
} from './binds.ts';
import { scanFolderPaths } from './fs-scan.ts';
import { showFile } from './git-diff.ts';
import {
  deletePrivateMeta,
  liftPrivateMetaFromYdoc,
  readPrivateMeta,
  writePrivateMeta,
} from './private-meta.ts';
import { isWithinRoot } from './safe-path.ts';
import type { SseHub } from './sse.ts';
import type { ScheduleArgs, ThreadSummarizer } from './summarize.ts';
import type { WebhookDispatcher } from './webhooks.ts';

export type WsCtx = {
  docId: string;
  isAwarenessOrigin: symbol;
  /**
   * The share that authorized this socket, when it came from a share
   * visitor. Authorization is checked at the HTTP upgrade and then never
   * again for the life of the connection — so without this, revoking a
   * share left every socket it had opened still connected and still
   * writable. Absent for a socket opened over the tailnet.
   */
  shareId?: string;
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
  /** No longer part of the review (file deleted, or its change reverted) as
   *  of the last `refresh_workspace`. Still listed — it holds comments —
   *  but rendered dimmed so nobody reviews a ghost. */
  stale?: boolean;
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
  /**
   * Generates thread summary lines. Optional on purpose: without it every
   * card falls back to its deterministic lines and nothing else changes.
   */
  summarizer?: ThreadSummarizer;
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
   *  produced zero blocks) or hit a conflict. Cleared on the next successful
   *  reconcile. Surfaced via getDoc AND on edit-tool responses so a wedged
   *  doc reports WHY it's stale instead of silently serving pre-edit
   *  content. */
  lastSyncError?: { message: string; at: number };
  /** The observeDeep callback wired by attachFile. Kept so a re-attach can
   *  unobserve it — without this, every re-attach (hydrate, re-run
   *  create_review_doc) stacked another write-back scheduler holding stale
   *  binding state. */
  observer?: Parameters<Y.XmlFragment['observeDeep']>[0];
  /** True when this flat binding writes doc edits back to the file (the
   *  editable File view). Absent/false = classic read-only code binding. */
  writeBack?: boolean;
  /** The content-Y.Text observer wired by attachFlatFile({writeBack:true}).
   *  Kept so a re-attach can unobserve it (same stacking hazard as
   *  `observer` above). */
  contentObserver?: (event: Y.YTextEvent, tr: Y.Transaction) => void;
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
      deletePrivateMeta(this.cfg.dataDir, docId);
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
            // need no binding — content is already in the .ydoc. Editable
            // (write-back) members must come back editable: binding
            // hydration ≠ state hydration, and a read-only re-attach here
            // silently ate every post-restart File-view edit.
            const writeBack =
              room.meta.type === 'diff' &&
              !room.meta.diffTarget &&
              !(room.meta.relPath ?? '').toLowerCase().endsWith('.md');
            if (this.attachFlatFile(docId, src, { writeBack }).ok) rebound++;
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
      diffWhitespaceOnly?: boolean;
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
    // Private fields live in a sidecar, not the CRDT (see private-meta.ts).
    // A `.ydoc` written before that change still carries them: lift them out
    // — which also DELETES them from the doc, so the next share visitor to
    // sync this room doesn't receive them — and let the sidecar win where
    // both exist, since the sidecar is the one being maintained.
    const legacyPrivate = liftPrivateMetaFromYdoc(ydoc);
    const storedPrivate = { ...legacyPrivate, ...readPrivateMeta(this.cfg.dataDir, docId) };
    const restored = { ...readDocMeta(ydoc), ...storedPrivate };
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
    // Advertise generation to clients. A browser cannot see the server's
    // summarizer, so this synced flag is what makes a card's "Generating
    // summary…" state truthful — without it a client on a key-less server
    // would promise summaries that never come. Written after wireEvents so
    // the transaction schedules a disk flush; conditional so an unchanged
    // value costs no update event. Covers restored docs too (this method is
    // the single room-creation path, hydration included).
    const summariesOn = this.cfg.summarizer?.enabled === true;
    const metaMap = ydoc.getMap('meta');
    if ((metaMap.get('summariesEnabled') === true) !== summariesOn) {
      ydoc.transact(() => metaMap.set('summariesEnabled', summariesOn));
    }
    // For freshly-created rooms (no on-disk state), the initDocMeta call
    // above fired its update event before wireEvents listened, so nothing
    // would ever flush this room to disk if the user hasn't done another
    // mutation by the next supervisor restart. Force a snapshot now so a
    // create_review_doc immediately followed by a `bun --watch` reload
    // doesn't lose the doc.
    //
    // A migrated legacy doc needs the same forced snapshot for the same
    // reason — the lift's transaction also ran before wireEvents listened, so
    // without this the private keys would still be in the `.ydoc` on disk and
    // would come straight back on the next restart.
    if (isNew || Object.keys(legacyPrivate).length > 0) this.saveToDisk(room);
    return room;
  }

  get(docId: string): DocRoom | undefined {
    return this.rooms.get(docId);
  }

  /** Schedule a persistence pass for a doc whose in-memory meta changed with
   *  no accompanying CRDT update (the private sidecar keys). */
  persistMeta(docId: string): void {
    const room = this.rooms.get(docId);
    if (room) this.saveToDisk(room);
  }

  async postComment(
    docId: string,
    threadId: string | null,
    author: User,
    text: string,
    anchor?: Anchor,
    /**
     * May this write spend the summary API key? Routes pass `false` for share
     * visitors: a public tunnel URL must not be able to run up a bill, and a
     * summary is not worth granting an outsider an outbound call. Defaults to
     * true so local editors and agents keep working unchanged.
     */
    opts?: { generate?: boolean },
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
      this.fireEvent(room, 'thread.created', t, undefined, opts);
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
    if (thread) this.fireEvent(room, 'thread.replied', thread, comment, opts);
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
    /**
     * Forwarded verbatim to both `postComment` calls below. Share visitors
     * can reach this route, and the text they post becomes the WHOLE prompt
     * — the worst of the gate's holes, because it needs no pre-existing
     * thread. Defaults to generating, like every other local caller.
     */
    writeOpts?: { generate?: boolean },
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
      const thread = await this.postComment(docId, null, author, text, anchor, writeOpts);
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
    const thread = await this.postComment(docId, null, author, text, anchor, writeOpts);
    if (!thread) return { ok: false, error: 'no-doc' };
    return { ok: true, thread };
  }

  /**
   * `opts.generate` is the same visitor gate `postComment` carries, and it is
   * here for the same reason: a resolve is a thread CHANGE, so it schedules a
   * summary, so a share visitor clicking Resolve would otherwise spend the
   * host's API key on a prompt containing their own comment text. Gating only
   * the comment routes gated nothing — every visitor comment moves
   * `summaryHash`, and the next Resolve click cashes it in.
   */
  resolve(
    docId: string,
    threadId: string,
    author?: User,
    opts?: { generate?: boolean },
  ): Thread | null {
    const room = this.rooms.get(docId);
    if (!room) return null;
    const t = schemaSetStatus(room.ydoc, threadId, 'resolved');
    if (t) {
      this.fireEvent(room, 'thread.resolved', t, undefined, opts);
      this.recordActivity(room, 'resolve', author ?? DEFAULT_REVIEWER, threadId, {
        tsMs: Date.now(),
      });
    }
    return t;
  }

  /** See `resolve` — `opts.generate` is the same visitor gate. */
  reopen(
    docId: string,
    threadId: string,
    author?: User,
    opts?: { generate?: boolean },
  ): Thread | null {
    const room = this.rooms.get(docId);
    if (!room) return null;
    const t = schemaSetStatus(room.ydoc, threadId, 'open');
    if (t) {
      this.fireEvent(room, 'thread.reopened', t, undefined, opts);
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
  /**
   * All threads across a workspace's member docs in one call — so an agent
   * watching a folder or diff review can poll ONE endpoint instead of one
   * per file (a 64-file diff review would otherwise mean 64 polls). Each
   * thread is tagged with its docId + relPath so replies/resolves know
   * where to go. Sorted most-recent-activity first.
   */
  listWorkspaceThreads(
    workspaceId: string,
    opts?: { status?: 'open' | 'resolved' },
  ): Array<Thread & { docId: string; relPath?: string }> {
    const out: Array<Thread & { docId: string; relPath?: string }> = [];
    for (const meta of this.list()) {
      if (meta.workspaceId !== workspaceId) continue;
      for (const t of this.listThreads(meta.docId, opts)) {
        out.push({ ...t, docId: meta.docId, relPath: meta.relPath });
      }
    }
    out.sort((a, b) => b.lastActivity - a.lastActivity);
    return out;
  }

  /**
   * The grouped-diff sidebar model: a diff review's CHANGED files organized
   * into their logical groups (agent-supplied at bind time or heuristic),
   * ordered by group rank then churn. Context files opened from the
   * all-files view (type 'code') are deliberately excluded — this view is
   * "what changed", not "what's open".
   */
  listGroupedDiff(workspaceId: string): {
    workspaceId: string;
    totalOpen: number;
    groups: Array<{
      title: string;
      openCount: number;
      details?: string;
      files: WorkspaceFileNode[];
    }>;
  } {
    const decorate = this.cfg.decorateDocMeta;
    const byGroup = new Map<
      string,
      { rank: number; details?: string; files: WorkspaceFileNode[] }
    >();
    // Companion editor docs (openEditableFile) are type 'markdown' but hold
    // threads left in the .md File view — those must count toward the diff
    // member's badge even though only diff members get rows here. Context
    // files never share a relPath with a member (openContextFile
    // short-circuits when one exists), so summing by relPath is safe.
    const companionThreads = new Map<string, { open: number; total: number }>();
    for (const meta of this.list()) {
      if (meta.workspaceId !== workspaceId || meta.type === 'diff' || !meta.relPath) continue;
      const open = this.listThreads(meta.docId, { status: 'open' }).length;
      const total = this.listThreads(meta.docId).length;
      if (open === 0 && total === 0) continue;
      const prev = companionThreads.get(meta.relPath) ?? { open: 0, total: 0 };
      companionThreads.set(meta.relPath, { open: prev.open + open, total: prev.total + total });
    }
    let totalOpen = 0;
    for (const meta of this.list()) {
      if (meta.workspaceId !== workspaceId || meta.type !== 'diff') continue;
      const relPath = meta.relPath ?? meta.docId;
      const extra = companionThreads.get(relPath) ?? { open: 0, total: 0 };
      const openCount = this.listThreads(meta.docId, { status: 'open' }).length + extra.open;
      const threadCount = this.listThreads(meta.docId).length + extra.total;
      totalOpen += openCount;
      const decorated = decorate ? decorate(meta) : meta;
      const node: WorkspaceFileNode = {
        type: 'file',
        docId: meta.docId,
        name: relPath.split('/').pop() ?? relPath,
        relPath,
        fileType: meta.type,
        openCount,
        threadCount,
        reviewUrl: (decorated as { reviewUrl?: string }).reviewUrl,
        lastActivityAt: meta.lastActivityAt,
        ...(meta.stale ? { stale: true } : {}),
        ...(meta.diffStatus !== undefined ? { diffStatus: meta.diffStatus } : {}),
        ...(meta.diffAdditions !== undefined ? { diffAdditions: meta.diffAdditions } : {}),
        ...(meta.diffDeletions !== undefined ? { diffDeletions: meta.diffDeletions } : {}),
      };
      const title = meta.diffGroup ?? 'Files';
      let g = byGroup.get(title);
      if (!g) {
        g = { rank: meta.diffGroupRank ?? Number.MAX_SAFE_INTEGER, files: [] };
        byGroup.set(title, g);
      }
      g.rank = Math.min(g.rank, meta.diffGroupRank ?? Number.MAX_SAFE_INTEGER);
      // Every member of a group shares the same details; take the first
      // non-empty one so a member bound before the details were set can't
      // blank it out.
      if (g.details === undefined && meta.diffGroupDetails) g.details = meta.diffGroupDetails;
      g.files.push(node);
    }
    const groups = Array.from(byGroup.entries())
      .sort((a, b) => a[1].rank - b[1].rank || a[0].localeCompare(b[0]))
      .map(([title, g]) => {
        g.files.sort((a, b) => a.name.localeCompare(b.name) || a.relPath.localeCompare(b.relPath));
        return {
          title,
          openCount: g.files.reduce((s, f) => s + f.openCount, 0),
          ...(g.details !== undefined ? { details: g.details } : {}),
          files: g.files,
        };
      });
    return { workspaceId, totalOpen, groups };
  }

  /**
   * Every reviewable file in the workspace's repo folder (gitignore-aware
   * scan), with changed files marked — powers the "Show All Files" context
   * view. Files that are already docs carry their reviewUrl; anything else
   * can be opened on demand via `openContextFile`.
   */
  listRepoFiles(workspaceId: string): {
    ok: boolean;
    root?: string;
    truncated?: boolean;
    files?: Array<{
      relPath: string;
      changed: boolean;
      docId?: string;
      reviewUrl?: string;
      stale?: boolean;
      status?: DocMeta['diffStatus'];
    }>;
    error?: 'not-found';
  } {
    const members = this.list().filter((m) => m.workspaceId === workspaceId);
    const root = members.find((m) => m.workspaceRoot)?.workspaceRoot;
    if (!root || !existsSync(root)) return { ok: false, error: 'not-found' };
    const decorate = this.cfg.decorateDocMeta;
    // A changed file can carry BOTH its diff member and its companion
    // editable markdown doc on the same relPath — the diff member is the
    // reviewable surface this list must point at.
    const byRel = new Map<string, DocMeta>();
    for (const m of members) {
      const key = m.relPath ?? '';
      const prev = byRel.get(key);
      if (!prev || (prev.type !== 'diff' && m.type === 'diff')) byRel.set(key, m);
    }
    const MAX_FILES = 10_000;
    const excluded = workspaceExcludes(members);
    const scanned = scanFolderPaths(root).filter((rel) => !isExcludedPath(rel, excluded));
    const truncated = scanned.length > MAX_FILES;
    const files = scanned.slice(0, MAX_FILES).map((relPath) => {
      const member = byRel.get(relPath);
      if (!member) return { relPath, changed: false };
      const decorated = decorate ? decorate(member) : member;
      return {
        relPath,
        // A STALE diff member is no longer changed — its change was reverted
        // or the file left the review. Still reporting it as changed here
        // would contradict the grouped view, which already dims it.
        changed: member.type === 'diff' && !member.stale,
        docId: member.docId,
        reviewUrl: (decorated as { reviewUrl?: string }).reviewUrl,
        ...(member.stale ? { stale: true } : {}),
        ...(member.diffStatus !== undefined ? { status: member.diffStatus } : {}),
      };
    });
    return { ok: true, root, truncated, files };
  }

  /**
   * Open an UNCHANGED repo file for context from the all-files view: bind it
   * lazily as a read-only code doc in the same workspace (deterministic
   * docId, so repeat opens reuse the doc and any comments on it survive).
   * relPath is validated against the workspace root — no traversal.
   */
  openContextFile(
    workspaceId: string,
    relPath: string,
  ):
    | { ok: true; docId: string; meta: DocMeta }
    | { ok: false; error: 'not-found' | 'bad-path' | 'attach-failed' } {
    const members = this.list().filter((m) => m.workspaceId === workspaceId);
    const root = members.find((m) => m.workspaceRoot)?.workspaceRoot;
    if (!root) return { ok: false, error: 'not-found' };
    const clean = relPath.replace(/^\/+/, '');
    const abs = join(root, clean);
    // Traversal guard: the resolved path must stay under the root.
    if (clean.split('/').includes('..') || !`${abs}/`.startsWith(`${root}/`)) {
      return { ok: false, error: 'bad-path' };
    }
    // The workspace's exclude is a scope, not a display filter: a path the
    // caller kept out must not be bindable on demand either, or "excluded"
    // would only mean "not listed by default".
    if (isExcludedPath(clean, workspaceExcludes(members))) {
      return { ok: false, error: 'bad-path' };
    }
    if (!existsSync(abs)) return { ok: false, error: 'not-found' };
    // The guard above is lexical, so a symlink INSIDE the root that points
    // outside it passes: `join` never touches the filesystem. Resolve what
    // the path really points at before reading it — this endpoint is
    // reachable by a share visitor, and a diff review's root is a whole repo.
    // Ordered after existsSync so a missing file still reads 'not-found'.
    if (!isWithinRoot(root, abs)) return { ok: false, error: 'bad-path' };
    const existing = members.find((m) => m.relPath === clean);
    if (existing) return { ok: true, docId: existing.docId, meta: existing };
    const owner = members.find((m) => m.owner)?.owner;
    const docId = memberDocId(workspaceId, clean);
    // Markdown opens as the full WYSIWYG editable doc (same as bind_folder
    // always did); everything else is read-only highlighted source.
    const isMd = clean.toLowerCase().endsWith('.md');
    const room = this.getOrCreate(docId, {
      type: isMd ? 'markdown' : 'code',
      sourceUrl: abs,
      setId: workspaceId,
      owner,
      workspaceId,
      workspaceRoot: root,
      relPath: clean,
      title: clean,
    });
    const attached = isMd ? this.attachFile(docId, abs) : this.attachReadonlyFile(docId, abs);
    if (!attached.ok) return { ok: false, error: 'attach-failed' };
    return { ok: true, docId: room.docId, meta: room.meta };
  }

  /**
   * Open (or reuse) the companion EDITABLE markdown doc for a `.md` member
   * of a LIVE working-tree diff review. The member stays the flat
   * diff/redline surface; the companion is a full prose doc bound to the
   * same working-tree file via attachFile, so File-view edits flow
   * prose → disk (debounced write-back) → the member's mtime poll →
   * redline/diff re-render. Unchanged `.md` files delegate to
   * openContextFile (already a full markdown doc); pinned reviews refuse —
   * their content is a commit, not a file.
   */
  openEditableFile(
    workspaceId: string,
    relPath: string,
  ):
    | { ok: true; docId: string; meta: DocMeta }
    | {
        ok: false;
        error: 'not-found' | 'bad-path' | 'pinned' | 'not-markdown' | 'attach-failed';
      } {
    const members = this.list().filter((m) => m.workspaceId === workspaceId);
    const root = members.find((m) => m.workspaceRoot)?.workspaceRoot;
    if (!root) return { ok: false, error: 'not-found' };
    const clean = relPath.replace(/^\/+/, '');
    const abs = join(root, clean);
    if (clean.split('/').includes('..') || !`${abs}/`.startsWith(`${root}/`)) {
      return { ok: false, error: 'bad-path' };
    }
    if (isExcludedPath(clean, workspaceExcludes(members))) {
      return { ok: false, error: 'bad-path' };
    }
    if (!clean.toLowerCase().endsWith('.md')) return { ok: false, error: 'not-markdown' };
    const member = members.find((m) => m.relPath === clean);
    if (!member) return this.openContextFile(workspaceId, clean);
    if (member.type !== 'diff') return { ok: true, docId: member.docId, meta: member };
    if (member.diffTarget) return { ok: false, error: 'pinned' };
    if (!existsSync(abs)) return { ok: false, error: 'not-found' };
    // Same symlink escape as openContextFile — see the note there. A member's
    // relPath is git-derived rather than caller-supplied, but git tracks
    // symlinks, so the member path is not self-evidently safe either.
    if (!isWithinRoot(root, abs)) return { ok: false, error: 'bad-path' };
    const owner = members.find((m) => m.owner)?.owner;
    const companionId = memberDocId(`${workspaceId}:edit`, clean);
    const room = this.getOrCreate(companionId, {
      type: 'markdown',
      sourceUrl: abs,
      setId: workspaceId,
      owner,
      workspaceId,
      workspaceRoot: root,
      relPath: clean,
      title: clean,
    });
    const attached = this.attachFile(companionId, abs);
    if (!attached.ok) return { ok: false, error: 'attach-failed' };
    return { ok: true, docId: room.docId, meta: room.meta };
  }

  buildWorkspaceTree(workspaceId: string): WorkspaceTree {
    const decorate = this.cfg.decorateDocMeta;
    const root: WorkspaceDirNode = { type: 'dir', name: '', openCount: 0, children: [] };
    let totalOpen = 0;
    let workspaceRoot: string | undefined;

    // One node per relPath: an editable .md gives the workspace TWO docs for
    // the same file (the diff member + its companion editor doc, see
    // openEditableFile). The diff member stays the face of the file — its
    // docId is what the diff-nav and reviewUrl point at — but threads land on
    // whichever doc the reviewer commented in, so badges merge across both.
    const byRel = new Map<string, { meta: DocMeta; openCount: number; threadCount: number }>();
    for (const meta of this.list()) {
      if (meta.workspaceId !== workspaceId) continue;
      if (!workspaceRoot && meta.workspaceRoot) workspaceRoot = meta.workspaceRoot;
      const key = meta.relPath ?? meta.docId;
      const open = this.listThreads(meta.docId, { status: 'open' }).length;
      const total = this.listThreads(meta.docId).length;
      const prev = byRel.get(key);
      if (!prev) {
        byRel.set(key, { meta, openCount: open, threadCount: total });
      } else {
        prev.openCount += open;
        prev.threadCount += total;
        if (prev.meta.type !== 'diff' && meta.type === 'diff') prev.meta = meta;
      }
    }

    for (const { meta, openCount, threadCount } of byRel.values()) {
      const relPath = meta.relPath ?? meta.docId;
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
        ...(meta.stale ? { stale: true } : {}),
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
   * Close every websocket a given share opened. Revocation and expiry are
   * enforced per HTTP request, but a websocket is authorized ONCE at its
   * upgrade — so an already-connected visitor kept reading and writing the
   * doc after the share was revoked. Verified: the socket stayed open and
   * writable while HTTP returned 401.
   *
   * 1008 is the "policy violation" close code, which is what this is.
   */
  closeSocketsForShare(shareId: string): number {
    let closed = 0;
    for (const meta of this.list()) {
      const room = this.get(meta.docId);
      if (!room) continue;
      for (const ws of room.conns) {
        if (ws.data?.shareId !== shareId) continue;
        try {
          ws.close(1008, 'share revoked');
        } catch {
          // Already gone — the close handler does the bookkeeping.
        }
        closed += 1;
      }
    }
    return closed;
  }

  /** Close sockets whose authorizing share is no longer live (revoked or
   *  expired). Returns the shareIds that were swept. */
  closeSocketsForDeadShares(isLive: (shareId: string) => boolean): string[] {
    const dead = new Set<string>();
    for (const meta of this.list()) {
      const room = this.get(meta.docId);
      if (!room) continue;
      for (const ws of room.conns) {
        const id = ws.data?.shareId;
        if (!id || isLive(id)) continue;
        dead.add(id);
      }
    }
    for (const id of dead) this.closeSocketsForShare(id);
    return Array.from(dead);
  }

  /** Re-reconcile a workspace against disk, keeping docIds (and therefore
   *  threads) stable — see binds.ts. */
  refreshWorkspace(workspaceId: string): RefreshWorkspaceResult {
    return refreshWorkspaceImpl(this, workspaceId);
  }

  /** Re-group a diff review's sidebar in place — see binds.ts. */
  setWorkspaceGroups(
    workspaceId: string,
    groups: Array<{ title: string; paths: string[]; details?: string }>,
  ): SetWorkspaceGroupsResult {
    return setWorkspaceGroupsImpl(this, workspaceId, groups);
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
    // A re-attach must replace the write-back observer, not stack another —
    // each leaked observer is a duplicate scheduler holding a stale binding.
    if (existing?.observer) fragment.unobserveDeep(existing.observer);
    const binding: FileBinding = { path: abs, lastMtimeMs: existing?.lastMtimeMs };
    this.fileBindings.set(docId, binding);
    // sourceUrl records the bound path. It stays OUT of the CRDT (an absolute
    // host path is exactly what a share visitor must not sync) — the sidecar
    // is its home, and saveToDisk is what persists it.
    if (!room.meta.sourceUrl) {
      room.meta.sourceUrl = abs;
      this.saveToDisk(room);
    }

    // Attaching a NON-empty fragment (hydrate after a restart, or a re-run
    // create_review_doc): honor the sync contract's "the file is the source
    // of truth at rest". Without this, an edit made while the server was down
    // was never picked up — and the next flush overwrote it on disk.
    if (!seeded && existsSync(abs)) {
      try {
        const md = readFileSync(abs, 'utf8');
        const currentSerialized = prose.serializeFragmentToMarkdown(fragment);
        const prior = existing?.lastWritten;
        if (md !== currentSerialized) {
          // NB: this byte-equality guard rarely spares the parse below —
          // most real files differ from the serializer's normal form, so
          // hydrate pays one parse+serialize per bound doc (~1ms for a
          // typical doc). Accepted: the alternative was rewriting ~every
          // never-edited bound file on each restart.
          const diskNormalized = prose.normalizeMarkdown(md);
          if (diskNormalized === currentSerialized) {
            // Pure normalization drift: disk parses to exactly the live
            // doc's content, the bytes just differ in formatting the
            // round-trip doesn't preserve. This is the steady state for
            // every bound-but-never-edited doc (binding stamps the .ydoc
            // after the .md, so mtime arbitration below would call the
            // live side newer and rewrite the file). Semantically equal
            // means in-sync — leave the file untouched.
            binding.lastWritten = currentSerialized;
          } else if (prior !== undefined && currentSerialized !== prior) {
            // The live doc has un-flushed edits relative to our last write —
            // we are NOT at rest, so don't pick a winner here. Keep the old
            // bookkeeping; if disk also moved, the poll's reconcile will
            // treat it as a conflict (backup + reassert). If disk did not
            // move, re-arm the flush this re-attach just cancelled. (The
            // conflict case reconciles NOW — armFileWatcher re-baselines the
            // mtime below, so the poll would never see the change.)
            binding.lastWritten = prior;
            // A disk that IS (or normalizes to) our last write hasn't
            // really changed — re-arm the flush this re-attach cancelled.
            // Without the normalized check, a doc whose drift was
            // suppressed at hydrate hit reconcile here and reported a
            // false conflict (backup + syncError) though disk never moved.
            if (md === prior || diskNormalized === prior) this.scheduleFileWrite(room, binding);
            else this.reconcileFromDisk(room, binding);
          } else if (prior === undefined && !this.diskNewerThanState(docId, abs)) {
            // Fresh attach with NO bookkeeping (post-restart hydrate) and the
            // .md is OLDER than the persisted .ydoc: the crash happened inside
            // the 800ms write-back window, so the hydrated doc is the newer
            // side. Applying disk here would revert the just-made edit on
            // startup (codex P1). Reassert the live doc to disk instead —
            // snapshotting the disk version first, symmetric with the apply
            // branch below (this is the one writer that replaces content the
            // server never wrote).
            this.backupExternalVersion(docId, md);
            binding.lastWritten = md;
            this.scheduleFileWrite(room, binding);
          } else if (prose.parseMarkdownBlocks(md).length > 0) {
            // At rest: pull disk in as a block diff so anchors on untouched
            // blocks keep resolving. On the no-bookkeeping path we can't
            // PROVE the fragment's extra state was ever flushed, so snapshot
            // it first — restarts are rare enough that a stray backup beats
            // an unrecoverable revert.
            if (prior === undefined) {
              this.backupExternalVersion(docId, currentSerialized, 'live');
            }
            room.ydoc.transact(() => {
              prose.applyMarkdownToFragment(fragment, md);
            }, 'file-watch');
            prose.normalizeHeadingLevels(room.ydoc);
          }
        }
      } catch (err) {
        console.error(`[rooms] attach-time reconcile failed for ${abs}:`, err);
      }
    }

    // doc → disk: every change schedules a debounced write.
    const observer: Parameters<Y.XmlFragment['observeDeep']>[0] = (_events, tr) => {
      // Don't echo our own seed-from-disk or file-watch apply back to disk.
      if (tr.origin === 'file-seed' || tr.origin === 'file-watch') return;
      this.scheduleFileWrite(room, binding);
    };
    binding.observer = observer;
    fragment.observeDeep(observer);
    // Bookkeeping lives in serializer-space: comparing raw disk bytes against
    // normalized serializer output made every applied external edit look like
    // permanent divergence, so the NEXT external edit was misjudged a
    // conflict and clobbered (2026-08-03 incident, RC1).
    if (binding.lastWritten === undefined) {
      binding.lastWritten = prose.serializeFragmentToMarkdown(fragment);
    }

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
    return this.attachFlatFile(docId, filePath);
  }

  /**
   * Bind a flat (code / working-tree diff) doc to a file. Disk→doc always
   * flows via the mtime poll; pass `writeBack: true` to also flow doc→disk
   * through the same debounced atomic writer prose docs use — that is what
   * makes the File view a live editor. Pinned diff docs must never pass
   * writeBack (their content is a commit, not a file).
   */
  attachFlatFile(
    docId: string,
    filePath: string,
    opts: { writeBack?: boolean } = {},
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
    // Sync content to the file's CURRENT bytes when disk is the newer side.
    // For read-only docs disk is always authoritative (the live doc never
    // holds browser edits). For write-back docs the two can genuinely
    // diverge across a restart, in BOTH directions: a File-view edit whose
    // ~800ms flush the crash beat (doc newer — blindly seeding here silently
    // destroyed it), or an agent editing the working tree while the server
    // was down (disk newer — "doc always wins" would reassert pre-deploy
    // bytes over their work). Arbitrate by mtime via diskNewerThanState;
    // when the doc wins, back up the losing disk version and reassert below.
    // The 'file-watch' origin routes a disk apply through the same reanchor
    // sweep as a live edit.
    let reassertDoc = false;
    if (existsSync(abs) && text !== content.toString()) {
      if (opts.writeBack && content.length > 0 && !this.diskNewerThanState(docId, abs)) {
        this.backupExternalVersion(docId, text);
        reassertDoc = true;
      } else {
        const origin = content.length === 0 ? 'file-seed' : 'file-watch';
        room.ydoc.transact(() => {
          if (content.length > 0) content.delete(0, content.length);
          if (text.length > 0) content.insert(0, text);
        }, origin);
      }
    }
    const existing = this.fileBindings.get(docId);
    if (existing?.writeTimer) clearTimeout(existing.writeTimer);
    if (existing?.readTimer) clearTimeout(existing.readTimer);
    if (existing?.pollTimer) clearInterval(existing.pollTimer);
    if (existing?.contentObserver) content.unobserve(existing.contentObserver);
    // lastWritten is "what the FILE holds" — when the doc won the arbitration
    // the file still holds the stale disk text, and recording the doc text
    // instead would make the writer's no-op check skip the reassert.
    const binding: FileBinding = {
      path: abs,
      lastWritten: reassertDoc ? text : content.toString(),
    };
    this.fileBindings.set(docId, binding);
    if (!room.meta.sourceUrl) {
      // Sidecar, not CRDT — see attachFile above.
      room.meta.sourceUrl = abs;
      this.saveToDisk(room);
    }
    if (opts.writeBack) {
      // doc → disk: same origin-guarded debounced writer as prose docs —
      // our own seed/poll applies must not echo back out to the file.
      binding.writeBack = true;
      const observer = (_event: Y.YTextEvent, tr: Y.Transaction) => {
        if (tr.origin === 'file-seed' || tr.origin === 'file-watch') return;
        this.scheduleFileWrite(room, binding);
      };
      binding.contentObserver = observer;
      content.observe(observer);
    }
    this.armFileWatcher(room, binding);
    // Doc won the attach-time arbitration above: push its state back out
    // through the normal debounced writer (which also stamps the poll
    // baseline so the reassert isn't misread as an external edit).
    if (reassertDoc) this.scheduleFileWrite(room, binding);
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
    // The caller is declaring disk the winner. A pending write-back holds a
    // PRE-reparse serialization — letting it fire would rewrite the file the
    // caller just forced ("its stale in-memory copy flushed to disk and the
    // reparse pulled that back", 2026-08-03 incident).
    if (binding.writeTimer) {
      clearTimeout(binding.writeTimer);
      binding.writeTimer = null;
    }
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
    if (prose.parseMarkdownBlocks(md).length === 0) return { ok: false, error: 'missing' };
    const fragment = prose.getProseFragment(room.ydoc);
    room.ydoc.transact(() => {
      // Block-level diff, not delete-all + push: blocks the rewrite didn't
      // touch keep their Y.XmlText identity, so their thread anchors keep
      // resolving instead of every thread in the doc orphaning.
      prose.applyMarkdownToFragment(fragment, md);
    }, 'file-watch');
    // The diff above keys blocks by their serialized markdown, so a block
    // whose only defect is an ATTRIBUTE (a legacy string heading level, which
    // serializes to the same `## …`) is correctly seen as unchanged and kept.
    // reparse is the documented recovery tool, so repair those here — without
    // it, force-pulling a legacy doc still left its headings rendering as h1.
    prose.normalizeHeadingLevels(room.ydoc);
    // Serializer-space, not raw disk bytes — see attachFile (RC1).
    binding.lastWritten = prose.serializeFragmentToMarkdown(fragment);
    binding.lastSyncError = undefined;
    return { ok: true };
  }

  /**
   * External file changed — read it, compare to what we think is
   * canonical, and apply the delta to the live doc if different.
   * Applies in one transact origin='file-watch' so the doc→disk
   * observer knows not to re-flush (which would bounce back here).
   */
  private reconcileFromDisk(
    room: DocRoom,
    binding: FileBinding,
  ): 'in-sync' | 'catch-up' | 'apply' | 'conflict' | 'missing' {
    if (!existsSync(binding.path)) return 'missing';
    let md: string;
    try {
      md = readFileSync(binding.path, 'utf8');
    } catch (err) {
      console.error(`[rooms] read failed for ${binding.path}:`, err);
      return 'missing';
    }
    // Code and working-tree diff docs are flat text — replace the whole
    // `content` Y.Text on change. Read-only bindings can't hold live edits,
    // so 'conflict' is impossible for them; editable (writeBack) bindings
    // get the same keep-live/backup/reassert arm the prose path has — a
    // blind replace here would eat the reviewer's in-flight keystrokes.
    if (contentKind(room.meta.type) === 'flat') {
      const content = room.ydoc.getText('content');
      const current = content.toString();
      const decision = decideReconcile({
        disk: md,
        lastWritten: binding.lastWritten,
        currentSerialized: current,
      });
      if (decision === 'in-sync') return decision;
      if (decision === 'catch-up') {
        binding.lastWritten = md;
        return decision;
      }
      if (decision === 'conflict' && binding.writeBack) {
        const backupPath = this.backupExternalVersion(room.docId, md);
        binding.lastSyncError = {
          message:
            'external file change collided with un-flushed live edits; kept live edits and reasserted them to disk. ' +
            (backupPath
              ? `The external version was saved to ${backupPath} — restore it and reparse_from_disk to make it win.`
              : 'Backup of the external version FAILED — it survives only in your editor/git history.'),
          at: Date.now(),
        };
        console.warn(
          `[rooms] ${room.docId}: disk↔doc conflict for ${binding.path}; kept live edits, reasserting to disk` +
            (backupPath ? ` (external version backed up to ${backupPath})` : ''),
        );
        this.scheduleFileWrite(room, binding);
        return decision;
      }
      room.ydoc.transact(() => {
        content.delete(0, content.length);
        content.insert(0, md);
      }, 'file-watch');
      binding.lastWritten = md;
      binding.lastSyncError = undefined;
      return decision;
    }
    const fragment = prose.getProseFragment(room.ydoc);
    const currentSerialized = prose.serializeFragmentToMarkdown(fragment);
    const decision = decideReconcile({
      disk: md,
      lastWritten: binding.lastWritten,
      currentSerialized,
    });
    // Same content as last round-trip → nothing to do.
    if (decision === 'in-sync') return decision;
    // The live doc already serializes to disk (up to serializer whitespace) —
    // just catch up bookkeeping, don't touch the fragment.
    if (decision === 'catch-up') {
      binding.lastWritten = md;
      return decision;
    }
    // decideReconcile compares BYTES. A formatting-only external save
    // (format-on-save, trailing-newline fixers) changes bytes but not
    // content — without these checks it classified as 'apply' (block
    // rewrite, broken anchors) or, with un-flushed live edits, 'conflict'
    // (backup + syncError + reassert over the human's formatting). Parse
    // cost is fine here: we only get this far on a detected mtime change.
    const diskNormalized = prose.normalizeMarkdown(md);
    if (diskNormalized === currentSerialized) {
      // Formatting-variant of the live content — semantically in-sync.
      // Leave the file as the external tool wrote it.
      binding.lastWritten = currentSerialized;
      return 'in-sync';
    }
    if (decision === 'conflict') {
      if (diskNormalized === binding.lastWritten) {
        // Disk holds a formatting-variant of our LAST write — no semantic
        // external change, so the un-flushed live edits are not in
        // conflict. Re-arm the flush; the pending write carries them out.
        this.scheduleFileWrite(room, binding);
        return 'catch-up';
      }
      // An external write collided with un-flushed live edits. A blind
      // delete+push here would clobber the human's in-progress work (the bug
      // a peer reported). The editor is the runtime source of truth, so keep
      // the live edits and reassert them to disk via the debounced writer.
      // BUT the reassert overwrites the external version on disk — so back it
      // up first, or "recoverable with reparse_from_disk" is a lie (disk
      // would already hold our reassert by the time anyone reparses).
      const backupPath = this.backupExternalVersion(room.docId, md);
      binding.lastSyncError = {
        message:
          'external file change collided with un-flushed live edits; kept live edits and reasserted them to disk. ' +
          (backupPath
            ? `The external version was saved to ${backupPath} — restore it and reparse_from_disk to make it win.`
            : 'Backup of the external version FAILED — it survives only in your editor/git history.'),
        at: Date.now(),
      };
      console.warn(
        `[rooms] ${room.docId}: disk↔doc conflict for ${binding.path}; kept live edits, reasserting to disk` +
          (backupPath ? ` (external version backed up to ${backupPath})` : ''),
      );
      this.scheduleFileWrite(room, binding);
      return decision;
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
      return decision;
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
      return decision;
    }
    // Apply as a block-level diff: only blocks whose markdown actually
    // changed are replaced, so anchors on untouched blocks keep resolving.
    // Anchors inside a rewritten block still break — auto-reanchor's
    // snippet-match sweep catches that case on the next tick.
    //
    // Suggestions ride the same block-granularity rule: marks in untouched
    // blocks survive (identity preserved), but an external rewrite of a
    // block CARRYING suggestions replaces the block and its proposals are
    // dropped — accepted-and-surfaced, not silently swallowed. Snapshot the
    // pending sids so the drop can be recorded below (syncError pattern; a
    // snippet-match re-anchor sweep for suggestions is out of scope for v1).
    const sidsBefore = new Set(suggestOps.scanSuggestions(fragment).keys());
    room.ydoc.transact(() => {
      prose.applyMarkdownToFragment(fragment, md);
    }, 'file-watch');
    const sidsAfter = new Set(suggestOps.scanSuggestions(fragment).keys());
    const droppedSids = [...sidsBefore].filter((sid) => !sidsAfter.has(sid));
    // Same as reparseFromDisk: a block whose only defect is a legacy string
    // heading level serializes identically, so the diff keeps it and the
    // attribute has to be repaired separately. Idempotent and cheap.
    prose.normalizeHeadingLevels(room.ydoc);
    // Serializer-space, NOT the raw disk bytes (RC1): parse→serialize is not
    // byte-identity, so storing `md` here left `currentSerialized ≠
    // lastWritten` forever after — and the NEXT external edit was misjudged
    // a conflict and clobbered by the reassert.
    binding.lastWritten = prose.serializeFragmentToMarkdown(fragment);
    if (droppedSids.length > 0) {
      // Same recoverability philosophy as the conflict backups: the reconcile
      // SUCCEEDED, but pending proposals living in a rewritten block were
      // dropped — record which, so agents/UI can report the loss instead of
      // the suggestions just vanishing. Cleared by the next clean reconcile.
      binding.lastSyncError = {
        message: `external edit dropped pending suggestion(s): ${droppedSids.join(', ')}`,
        at: Date.now(),
      };
      console.warn(
        `[rooms] ${room.docId}: external edit to ${binding.path} dropped suggestion(s) ${droppedSids.join(', ')}`,
      );
    } else {
      binding.lastSyncError = undefined;
    }
    console.log(
      `[rooms] ${room.docId}: applied external edit from ${binding.path} (${blocks.length} blocks)`,
    );
    return decision;
  }

  private scheduleFileWrite(room: DocRoom, binding: FileBinding): void {
    if (binding.writeTimer) clearTimeout(binding.writeTimer);
    binding.writeTimer = setTimeout(() => {
      binding.writeTimer = null;
      try {
        // Guard (RC2): if disk moved since we last read or wrote it, we'd be
        // overwriting bytes we have never seen — the poll just hasn't caught
        // up yet. Reconcile first; apply/conflict decides, and the conflict
        // path both backs up the external version and re-schedules our flush.
        if (binding.lastMtimeMs !== undefined && existsSync(binding.path)) {
          try {
            const mtimeMs = statSync(binding.path).mtimeMs;
            if (mtimeMs !== binding.lastMtimeMs) {
              binding.lastMtimeMs = mtimeMs;
              this.reconcileFromDisk(room, binding);
              return;
            }
          } catch {}
        }
        const md =
          contentKind(room.meta.type) === 'flat'
            ? room.ydoc.getText('content').toString()
            : prose.serializeFragmentToMarkdown(prose.getProseFragment(room.ydoc));
        if (md === binding.lastWritten) return;
        // Atomic: write-temp-then-rename, so a crash mid-write can't leave
        // the user's file truncated and a concurrent reader never sees half
        // a document. (Same save pattern editors use.) Rename onto the
        // REALPATH — renaming onto a symlink would replace the link with a
        // regular file instead of writing through it (codex P2).
        let target = binding.path;
        try {
          target = realpathSync(binding.path);
        } catch {}
        const tmp = `${target}.lf-write~`;
        writeFileSync(tmp, md);
        renameSync(tmp, target);
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
   * Snapshot an external file version we are about to overwrite into
   * `<dataDir>/clobber-backups/`, so a conflict reassert is recoverable
   * instead of destructive. Returns the backup path, or null on failure —
   * never throws (the reconcile must proceed either way).
   */
  private backupExternalVersion(docId: string, content: string, label = 'external'): string | null {
    try {
      const dir = join(this.cfg.dataDir, 'clobber-backups');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const safeId = docId.replace(/[^A-Za-z0-9._-]/g, '_');
      const file = join(dir, `${safeId}-${label}-${Date.now()}.md`);
      writeFileSync(file, content);
      return file;
    } catch (err) {
      console.error(`[rooms] clobber backup failed for ${docId}:`, err);
      return null;
    }
  }

  /**
   * Is the bound .md at least as new as the persisted .ydoc? Decides who wins
   * a no-bookkeeping attach (post-restart): the .ydoc's mtime marks the live
   * doc's last change, so an older .md means the crash beat the write-back
   * debounce and disk is the STALE side. Errs toward disk (the documented
   * source of truth at rest) when either stat fails.
   */
  private diskNewerThanState(docId: string, filePath: string): boolean {
    try {
      const ydocPath = this.pathFor(docId);
      if (!existsSync(ydocPath)) return true;
      return statSync(filePath).mtimeMs >= statSync(ydocPath).mtimeMs;
    } catch {
      return true;
    }
  }

  /**
   * Run a disk→doc reconcile for a bound doc right now (instead of waiting
   * for the mtime poll) and report the decision. Used by tests to pin the
   * reconcile policy without timing races, and available to routes for an
   * explicit "sync now".
   */
  reconcileNow(
    docId: string,
  ): 'in-sync' | 'catch-up' | 'apply' | 'conflict' | 'no-binding' | 'missing' {
    const room = this.rooms.get(docId);
    const binding = this.fileBindings.get(docId);
    if (!room || !binding) return 'no-binding';
    if (!existsSync(binding.path)) return 'missing';
    // Advance the poll baseline the same way the poll itself would, so this
    // manual reconcile doesn't get replayed on the next tick.
    try {
      binding.lastMtimeMs = statSync(binding.path).mtimeMs;
    } catch {}
    if (binding.readTimer) {
      clearTimeout(binding.readTimer);
      binding.readTimer = null;
    }
    return this.reconcileFromDisk(room, binding);
  }

  /** The doc's pending sync trouble, if any — conflicts, parse failures. */
  getSyncError(docId: string): { message: string; at: number } | undefined {
    return this.fileBindings.get(docId)?.lastSyncError;
  }

  /**
   * Replace the WHOLE document from a markdown payload — the legitimate
   * "comprehensive rewrite" path. Applies as a block-level diff on the live
   * doc (anchors on untouched blocks keep resolving, connected editors
   * update live) and flushes to disk via the normal debounced writer.
   *
   * This is what agents used `Write` + `reparse_from_disk` — or the
   * delete_doc → Write → create_review_doc dance — to approximate, both of
   * which raced the write-back and clobbered (2026-07-15, 2026-08-03).
   */
  setDocContent(
    docId: string,
    markdown: string,
  ): { ok: true } | { ok: false; error: 'not-found' | 'unsupported' | 'empty' | 'parse-failed' } {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'not-found' };
    // Flat docs (code / diff) are read-only review surfaces; their content
    // comes from disk or a pinned commit, never from an agent payload.
    if (contentKind(room.meta.type) !== 'prose') return { ok: false, error: 'unsupported' };
    if (!markdown.trim()) return { ok: false, error: 'empty' };
    let blocks: Y.XmlElement[];
    try {
      blocks = prose.parseMarkdownBlocks(markdown);
    } catch {
      return { ok: false, error: 'parse-failed' };
    }
    if (blocks.length === 0) return { ok: false, error: 'empty' };
    const fragment = prose.getProseFragment(room.ydoc);
    // A doc-side edit origin (NOT 'file-watch'): the write-back observer must
    // see this and flush it to disk like any other agent edit.
    room.ydoc.transact(() => {
      prose.applyMarkdownToFragment(fragment, markdown);
    }, 'agent-set-content');
    prose.normalizeHeadingLevels(room.ydoc);
    return { ok: true };
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

  // =========================================================================
  // Suggested edits (redline-suggestions phase 2). Thin wrappers over the
  // core suggest-ops: suggestions ARE marks in the prose fragment, so every
  // operation rescans at execution time — no registry to keep in sync, and a
  // sid that raced away (double-accept, external rewrite) reports not-found.
  // All mutations run under the same 'agent' transaction origin the other
  // agent edit tools use: the write-back observer flushes results to disk;
  // a browser UndoManager never tracks them.
  // =========================================================================

  /** All pending proposals on the doc, in doc order. Empty for unknown docs
   *  and for flat (code/diff) docs, whose prose fragment has no content. */
  listSuggestions(docId: string): suggestOps.SuggestionSummary[] {
    const room = this.rooms.get(docId);
    if (!room) return [];
    return suggestOps.listSuggestions(room.ydoc);
  }

  /**
   * The suggestion-creation primitive: same find/context/occurrence matching
   * as findAndReplace, but the replacement is written AS A PROPOSAL — the
   * matched text marked suggestDelete, the new text inserted with
   * suggestInsert, one shared sid, author from the caller. The doc's
   * accepted state (and therefore disk) is unchanged until accepted.
   */
  createSuggestion(
    docId: string,
    opts: {
      find: string;
      replace: string;
      contextBefore?: string;
      contextAfter?: string;
      occurrence?: number;
      parseInlineMarks?: boolean;
      author: suggestOps.SuggestionAuthor;
    },
  ):
    | { ok: true; suggestionId: string }
    | {
        ok: false;
        // `match-in-pending-suggestion`: the find only matched text that is
        // itself an unaccepted proposal — anchoring here would make this
        // proposal vanish when the other one is rejected.
        error: 'not-found' | 'no-match' | 'ambiguous' | 'match-in-pending-suggestion';
        candidates?: Array<{ docOffset: number; preview: string }>;
      } {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'not-found' };
    const res = suggestOps.suggestReplace(room.ydoc, opts);
    if (!res.ok) return res;
    this.fireSuggestionEvent(
      room,
      'suggestion.created',
      res.sid,
      suggestOps.listSuggestions(room.ydoc).find((s) => s.sid === res.sid),
    );
    return { ok: true, suggestionId: res.sid };
  }

  /**
   * The `rewrite_thread_region` twin of `createSuggestion`: propose the
   * rewrite of a thread's anchored range instead of applying it directly.
   * Same anchor resolution as `rewriteThreadRegion` — `anchor-orphaned` if
   * the user deleted the anchored text, `cross-block` if the range somehow
   * spans two blocks (shouldn't happen for a single-thread anchor, but
   * mirrors `rewriteRange`'s own restriction).
   */
  createSuggestionForThread(
    docId: string,
    threadId: string,
    opts: {
      replacement: string;
      parseInlineMarks?: boolean;
      author: suggestOps.SuggestionAuthor;
      ts?: number;
    },
  ):
    | { ok: true; suggestionId: string }
    | { ok: false; error: 'anchor-not-found' | 'anchor-orphaned' | 'cross-block' } {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'anchor-not-found' };
    const thread = this.getThread(docId, threadId);
    if (!thread) return { ok: false, error: 'anchor-not-found' };
    if (thread.anchor.kind !== 'text-range') return { ok: false, error: 'anchor-orphaned' };
    const res = suggestOps.suggestRewriteRange(room.ydoc, {
      startRel: thread.anchor.startRel,
      endRel: thread.anchor.endRel,
      replacement: opts.replacement,
      parseInlineMarks: opts.parseInlineMarks === true,
      author: opts.author,
      ts: opts.ts,
    });
    if (!res.ok) return res;
    this.fireSuggestionEvent(
      room,
      'suggestion.created',
      res.sid,
      suggestOps.listSuggestions(room.ydoc).find((s) => s.sid === res.sid),
    );
    return { ok: true, suggestionId: res.sid };
  }

  /** Accept a proposal: it becomes real content and flows to disk via the
   *  normal debounced write-back. Missing sid (or doc) → not-found — also
   *  the correct answer to the double-accept race. */
  acceptSuggestion(docId: string, sid: string): suggestOps.SuggestionOpResult {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'not-found' };
    const before = suggestOps.listSuggestions(room.ydoc).find((s) => s.sid === sid);
    const res = suggestOps.acceptSuggestion(room.ydoc, sid);
    if (res.ok) this.fireSuggestionEvent(room, 'suggestion.accepted', sid, before);
    return res;
  }

  /** Reject a proposal: restores exactly the pre-suggestion text. */
  rejectSuggestion(docId: string, sid: string): suggestOps.SuggestionOpResult {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'not-found' };
    const before = suggestOps.listSuggestions(room.ydoc).find((s) => s.sid === sid);
    const res = suggestOps.rejectSuggestion(room.ydoc, sid);
    if (res.ok) this.fireSuggestionEvent(room, 'suggestion.rejected', sid, before);
    return res;
  }

  /** Accept or reject every pending proposal (optionally one author's). */
  resolveAllSuggestions(
    docId: string,
    opts: { action: 'accept' | 'reject'; authorId?: string },
  ): { ok: true; resolved: number; sids: string[] } | { ok: false; error: 'not-found' } {
    const room = this.rooms.get(docId);
    if (!room) return { ok: false, error: 'not-found' };
    const before = new Map(suggestOps.listSuggestions(room.ydoc).map((s) => [s.sid, s]));
    const res = suggestOps.resolveAllSuggestions(room.ydoc, opts);
    const event = opts.action === 'accept' ? 'suggestion.accepted' : 'suggestion.rejected';
    for (const sid of res.sids) {
      this.fireSuggestionEvent(room, event, sid, before.get(sid));
    }
    return res;
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
    opts?: { generate?: boolean },
  ): void {
    room.seq++;
    // Every thread change funnels through here, which is exactly why the
    // summary trigger lives here and not at the four call sites: a fifth
    // event added later gets summarization for free rather than silently
    // going without it.
    if (opts?.generate !== false) this.scheduleSummary(room, thread.id);
    const decorate = this.cfg.decorateDocMeta ?? ((m) => m);
    this.broadcastToRoom(room, {
      event,
      docId: room.docId,
      threadId: thread.id,
      thread,
      doc: decorate(room.meta),
      comment,
      seq: room.seq,
    });
  }

  /**
   * Suggestion verdict events (redline-suggestions phase 2, commit 3):
   * `suggestion.created` / `suggestion.accepted` / `suggestion.rejected` on
   * the same doc/workspace channel thread events use, so a suggesting agent
   * hears the outcome via `watch_doc` without polling `list_suggestions`.
   * `summary` is the SuggestionSummary captured BEFORE the mutation for
   * accept/reject (the marks are gone afterward, so there's nothing left to
   * scan) — undefined only if the sid vanished between scan and fire, which
   * shouldn't happen since callers scan and mutate in the same call.
   */
  private fireSuggestionEvent(
    room: DocRoom,
    event: 'suggestion.created' | 'suggestion.accepted' | 'suggestion.rejected',
    sid: string,
    summary: suggestOps.SuggestionSummary | undefined,
  ): void {
    room.seq++;
    const decorate = this.cfg.decorateDocMeta ?? ((m) => m);
    this.broadcastToRoom(room, {
      event,
      docId: room.docId,
      sid,
      suggestion: summary,
      doc: decorate(room.meta),
      seq: room.seq,
    });
  }

  /**
   * Summarize every already-existing thread that has no current summary.
   *
   * Generation is triggered by thread CHANGES, so nothing that was written
   * before this feature shipped would ever get a summary — the docs with the
   * worst deterministic topic lines are exactly the old ones. This walks the
   * hydrated rooms once and hands the backlog to the summarizer, which paces
   * it over `windowMs`.
   *
   * Resolved threads are included: their cards still render both lines in the
   * all-threads panel and the outdated-comments flow, and a summary is the
   * whole point there too. They are counted separately so the operator sees
   * what they are agreeing to pay for rather than one opaque total.
   *
   * Returns immediately with the count queued; the drain runs in the
   * background. Never automatic — the caller (bin.ts) decides, because a
   * backfill spends real money and must not fire in a test or a short-lived
   * process.
   */
  backfillSummaries(opts: { windowMs?: number } = {}): {
    queued: number;
    open: number;
    resolved: number;
  } {
    const summarizer = this.cfg.summarizer;
    if (!summarizer?.enabled) return { queued: 0, open: 0, resolved: 0 };
    const tasks: ScheduleArgs[] = [];
    let open = 0;
    let resolved = 0;
    for (const [docId, room] of this.rooms) {
      for (const t of listThreads(room.ydoc)) {
        // Ask the same question the live path asks, so a thread summarized a
        // second ago is not paid for twice.
        if (!needsCall(t, t.summary)) continue;
        if (t.status === 'open') open++;
        else resolved++;
        tasks.push({
          docId,
          threadId: t.id,
          getThread: () => this.getThread(docId, t.id),
          apply: (summary) => {
            setThreadSummary(room.ydoc, t.id, summary);
            this.saveToDisk(room);
          },
        });
      }
    }
    if (tasks.length > 0) {
      void summarizer
        .backfill(tasks, {
          ...(opts.windowMs !== undefined ? { windowMs: opts.windowMs } : {}),
        })
        .then(({ attempted, stored }) => {
          console.log(`[summarize] backfill done: ${stored} stored of ${attempted} attempted`);
        })
        // Nothing observes this promise. Every throw inside `backfill` is
        // caught today, so this cannot fire — but it is one refactor away
        // from being an unhandled rejection on a fire-and-forget path.
        .catch((err) => {
          console.error('[summarize] backfill failed:', err instanceof Error ? err.message : err);
        });
    }
    return { queued: tasks.length, open, resolved };
  }

  /**
   * Store a summary that was generated on demand (REST route / MCP tool).
   * Same write and same persistence as the scheduled path — one way in, so
   * an on-demand summary cannot end up in the doc but not on disk.
   */
  applyThreadSummary(docId: string, threadId: string, summary: StoredSummary): Thread | null {
    const room = this.rooms.get(docId);
    if (!room) return null;
    const t = setThreadSummary(room.ydoc, threadId, summary);
    if (t) this.saveToDisk(room);
    return t;
  }

  /**
   * Ask for a generated summary for one thread, if generation is configured.
   *
   * Reads the thread fresh at call time rather than capturing it: three
   * seconds of debounce is long enough for two more replies to land, and the
   * summary must describe the thread as it will be, not as it was.
   */
  private scheduleSummary(room: DocRoom, threadId: string): void {
    const summarizer = this.cfg.summarizer;
    if (!summarizer) return;
    summarizer.schedule({
      docId: room.docId,
      threadId,
      getThread: () => this.getThread(room.docId, threadId),
      apply: (summary) => {
        // Writes into the SAME ydoc the browsers are synced to, so the new
        // lines appear on every open card without a reload.
        setThreadSummary(room.ydoc, threadId, summary);
        this.saveToDisk(room);
      },
    });
  }

  /** Shared SSE + workspace + webhook fan-out behind fireEvent /
   *  fireSuggestionEvent. Caller stamps `event`/`seq`/`doc` into payload. */
  private broadcastToRoom(room: DocRoom, payload: WebhookPayload): void {
    this.cfg.sse.broadcast(room.docId, payload);
    // Workspace members double-broadcast on a per-workspace channel so an
    // agent can watch ONE stream per review/folder instead of one per file.
    if (room.meta.workspaceId) {
      this.cfg.sse.broadcast(`ws~${room.meta.workspaceId}`, payload);
    }
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
      // Don't re-enter on our own re-anchor writes. NOTE: 'file-watch' must
      // NOT be skipped here — a disk reparse is exactly when anchors inside a
      // rewritten block break, and this sweep is what recovers them. Adding
      // 'file-watch' to this guard (to match the write-back observer's) would
      // silently break reparse recovery.
      if (tr.origin === 'agent-reanchor') return;
      if (reanchorTimer) clearTimeout(reanchorTimer);
      reanchorTimer = setTimeout(() => {
        const res = prose.autoReanchorDoc(room.ydoc);
        if (res.reanchored > 0) {
          console.log(`[rooms] ${room.docId}: auto-reanchored ${res.reanchored} thread(s)`);
        }
      }, 250);
    });
    // Docs seeded from disk before the heading-level fix persisted `level` as
    // a string, which makes Tiptap render every heading as <h1>. Repair them
    // on load so an existing doc doesn't need a reparse to render correctly.
    const fixed = prose.normalizeHeadingLevels(room.ydoc);
    if (fixed > 0) {
      console.log(`[rooms] ${room.docId}: normalized ${fixed} legacy string heading level(s)`);
    }
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
          // The sidecar rides the SAME debounced write as the `.ydoc`. Two
          // persistence paths would eventually disagree, and a doc whose
          // sourceUrl went missing stops writing back to disk silently —
          // the failure mode this whole change must not introduce.
          writePrivateMeta(this.cfg.dataDir, room.docId, room.meta);
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
/** The workspace's stored exclude prefixes, normalized. Replicated on every
 *  member (there is no workspace registry), so any member answers. */
function workspaceExcludes(members: DocMeta[]): string[] {
  const raw = members.find((m) => m.workspaceExclude)?.workspaceExclude ?? [];
  return raw.map((p) => p.replace(/^\/+/, '').replace(/\/+$/, '')).filter(Boolean);
}

function isExcludedPath(relPath: string, excludes: string[]): boolean {
  return excludes.some((p) => relPath === p || relPath.startsWith(`${p}/`));
}

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
