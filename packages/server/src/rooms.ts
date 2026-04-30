import { type FSWatcher, existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Anchor,
  type DocMeta,
  type DocType,
  type Thread,
  type User,
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
  watcher?: FSWatcher | null;
  /** The serialized markdown we last wrote or last read from disk.
   *  Both directions guard against this to break echo loops. */
  lastWritten?: string;
}

export class Rooms {
  private rooms = new Map<string, DocRoom>();
  private fileBindings = new Map<string, FileBinding>();

  constructor(private cfg: RoomsConfig) {
    if (!existsSync(cfg.dataDir)) mkdirSync(cfg.dataDir, { recursive: true });
  }

  list(): DocMeta[] {
    return Array.from(this.rooms.values()).map((r) => r.meta);
  }

  getOrCreate(
    docId: string,
    init?: {
      type?: DocType;
      sourceUrl?: string;
      title?: string;
      setId?: string;
      webhookUrl?: string;
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
    const meta: DocMeta = (() => {
      const current = readDocMeta(ydoc);
      if (current.docId) {
        // Restored doc; allow init to override setId (set membership
        // is editorial, not part of the persisted CRDT contract).
        if (init?.setId !== undefined && init.setId !== current.setId) {
          const m = ydoc.getMap('meta');
          ydoc.transact(() => m.set('setId', init.setId));
          current.setId = init.setId;
        }
        return current;
      }
      const now: DocMeta = {
        docId,
        type: init?.type ?? 'markdown',
        sourceUrl: init?.sourceUrl,
        title: init?.title,
        setId: init?.setId,
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
    return thread;
  }

  resolve(docId: string, threadId: string): Thread | null {
    const room = this.rooms.get(docId);
    if (!room) return null;
    const t = schemaSetStatus(room.ydoc, threadId, 'resolved');
    if (t) this.fireEvent(room, 'thread.resolved', t);
    return t;
  }

  reopen(docId: string, threadId: string): Thread | null {
    const room = this.rooms.get(docId);
    if (!room) return null;
    const t = schemaSetStatus(room.ydoc, threadId, 'open');
    if (t) this.fireEvent(room, 'thread.reopened', t);
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
  } | null {
    const room = this.rooms.get(docId);
    if (!room) return null;
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

    return { plainText: walk.plainText, blocks, threads: listThreads(room.ydoc) };
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
    try {
      existing?.watcher?.close();
    } catch {}
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

    // disk → doc: watch the file for external edits.
    if (existsSync(abs)) {
      try {
        binding.watcher = watch(abs, { persistent: false }, () => {
          // fs.watch can fire several times per write (rename + change
          // on macOS); debounce through binding.readTimer.
          if (binding.readTimer) clearTimeout(binding.readTimer);
          binding.readTimer = setTimeout(() => this.reconcileFromDisk(room, binding), 300);
        });
      } catch (err) {
        console.error(`[rooms] fs.watch failed for ${abs}:`, err);
      }
    }

    return { ok: true, seeded, resolvedPath: abs };
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
    const binding = this.fileBindings.get(docId);
    if (!binding) return { ok: false, error: 'no-binding' };
    if (!existsSync(binding.path)) return { ok: false, error: 'missing' };
    let md: string;
    try {
      md = readFileSync(binding.path, 'utf8');
    } catch {
      return { ok: false, error: 'missing' };
    }
    const blocks = prose.parseMarkdownBlocks(md);
    if (blocks.length === 0) return { ok: false, error: 'missing' };
    const fragment = prose.getProseFragment(room.ydoc);
    room.ydoc.transact(() => {
      fragment.delete(0, fragment.length);
      fragment.push(blocks);
    }, 'file-watch');
    binding.lastWritten = md;
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
    // Same content as last round-trip → nothing to do.
    if (md === binding.lastWritten) return;
    // If the current fragment would serialize to the same file content
    // (up to serializer whitespace), we're already in sync — just catch
    // up bookkeeping.
    const fragment = prose.getProseFragment(room.ydoc);
    const currentSerialized = prose.serializeFragmentToMarkdown(fragment);
    if (currentSerialized === md) {
      binding.lastWritten = md;
      return;
    }
    const blocks = prose.parseMarkdownBlocks(md);
    if (blocks.length === 0) return; // don't wipe to empty on a parse failure
    // Apply destructively: parse fresh, replace all blocks. Y.XmlText
    // identities change so thread anchors in the replaced region may
    // orphan — auto-reanchor's snippet-match sweep catches the common
    // case on the next tick.
    room.ydoc.transact(() => {
      fragment.delete(0, fragment.length);
      fragment.push(blocks);
    }, 'file-watch');
    binding.lastWritten = md;
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
