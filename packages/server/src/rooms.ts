import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
}

export class Rooms {
  private rooms = new Map<string, DocRoom>();

  constructor(private cfg: RoomsConfig) {
    if (!existsSync(cfg.dataDir)) mkdirSync(cfg.dataDir, { recursive: true });
  }

  list(): DocMeta[] {
    return Array.from(this.rooms.values()).map((r) => r.meta);
  }

  getOrCreate(
    docId: string,
    init?: { type?: DocType; sourceUrl?: string; title?: string; webhookUrl?: string },
  ): DocRoom {
    const existing = this.rooms.get(docId);
    if (existing) {
      if (init?.webhookUrl !== undefined) existing.webhookUrl = init.webhookUrl;
      return existing;
    }
    const ydoc = new Y.Doc();
    this.loadFromDisk(docId, ydoc);
    const meta: DocMeta = (() => {
      const current = readDocMeta(ydoc);
      if (current.docId) return current;
      const now: DocMeta = {
        docId,
        type: init?.type ?? 'markdown',
        sourceUrl: init?.sourceUrl,
        title: init?.title,
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

    // Group segments into blocks for readable structure hints.
    const blocks: Array<{
      type: string | null;
      headingLevel?: number;
      text: string;
      startOffset: number;
      endOffset: number;
    }> = [];
    for (const s of walk.segments) {
      const last = blocks[blocks.length - 1];
      if (last && last.type === s.blockType && last.endOffset === s.docOffset) {
        last.text += s.node.toString();
        last.endOffset = s.docOffset + s.length;
      } else {
        const b = {
          type: s.blockType,
          text: s.node.toString(),
          startOffset: s.docOffset,
          endOffset: s.docOffset + s.length,
          ...(s.headingLevel != null ? { headingLevel: s.headingLevel } : {}),
        };
        blocks.push(b);
      }
    }

    return { plainText: walk.plainText, blocks, threads: listThreads(room.ydoc) };
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
    const payload = {
      event,
      docId: room.docId,
      threadId: thread.id,
      thread,
      doc: room.meta,
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
