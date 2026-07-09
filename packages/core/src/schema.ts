import * as Y from 'yjs';
import type { Anchor, Comment, DocMeta, Thread, ThreadStatus, User } from './types.ts';

/**
 * Yjs doc shape:
 *   meta       Y.Map<string, DocMeta fields>         — docId, type, sourceUrl, title, createdAt
 *   content    Y.Text                                 — markdown content (surface 1)
 *   threads    Y.Map<threadId, Y.Map {
 *                anchor: frozen JSON Anchor (static — threads never move)
 *                status: 'open' | 'resolved'
 *                createdBy: User
 *                createdAt: number
 *                comments: Y.Array<Y.Map { id, author, text, ts }>
 *              }>
 */

export const YKey = {
  meta: 'meta',
  content: 'content',
  threads: 'threads',
} as const;

export function getMeta(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(YKey.meta);
}

export function getContent(doc: Y.Doc): Y.Text {
  return doc.getText(YKey.content);
}

export function getThreads(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(YKey.threads) as Y.Map<Y.Map<unknown>>;
}

export function readDocMeta(doc: Y.Doc): DocMeta {
  const m = getMeta(doc);
  const docId = (m.get('docId') as string) ?? '';
  const type = (m.get('type') as DocMeta['type']) ?? 'markdown';
  const createdAt = (m.get('createdAt') as number) ?? Date.now();
  const sourceUrl = m.get('sourceUrl') as string | undefined;
  const title = m.get('title') as string | undefined;
  const setId = m.get('setId') as string | undefined;
  const owner = m.get('owner') as string | undefined;
  const workspaceId = m.get('workspaceId') as string | undefined;
  const relPath = m.get('relPath') as string | undefined;
  const workspaceRoot = m.get('workspaceRoot') as string | undefined;
  const producedBy = m.get('producedBy') as DocMeta['producedBy'] | undefined;
  const diffBase = m.get('diffBase') as string | undefined;
  const diffTarget = m.get('diffTarget') as string | undefined;
  const diffStatus = m.get('diffStatus') as DocMeta['diffStatus'] | undefined;
  const diffOldPath = m.get('diffOldPath') as string | undefined;
  const diffAdditions = m.get('diffAdditions') as number | undefined;
  const diffDeletions = m.get('diffDeletions') as number | undefined;
  return {
    docId,
    type,
    createdAt,
    sourceUrl,
    title,
    setId,
    owner,
    workspaceId,
    relPath,
    workspaceRoot,
    producedBy,
    diffBase,
    diffTarget,
    diffStatus,
    diffOldPath,
    diffAdditions,
    diffDeletions,
  };
}

export function initDocMeta(doc: Y.Doc, meta: DocMeta): void {
  const m = getMeta(doc);
  doc.transact(() => {
    if (!m.has('docId')) m.set('docId', meta.docId);
    if (!m.has('type')) m.set('type', meta.type);
    if (!m.has('createdAt')) m.set('createdAt', meta.createdAt);
    if (meta.sourceUrl !== undefined) m.set('sourceUrl', meta.sourceUrl);
    if (meta.title !== undefined) m.set('title', meta.title);
    if (meta.setId !== undefined) m.set('setId', meta.setId);
    if (meta.owner !== undefined && !m.has('owner')) m.set('owner', meta.owner);
    if (meta.workspaceId !== undefined && !m.has('workspaceId'))
      m.set('workspaceId', meta.workspaceId);
    if (meta.relPath !== undefined && !m.has('relPath')) m.set('relPath', meta.relPath);
    if (meta.workspaceRoot !== undefined && !m.has('workspaceRoot'))
      m.set('workspaceRoot', meta.workspaceRoot);
    if (meta.producedBy !== undefined && !m.has('producedBy')) m.set('producedBy', meta.producedBy);
    if (meta.diffBase !== undefined && !m.has('diffBase')) m.set('diffBase', meta.diffBase);
    if (meta.diffTarget !== undefined && !m.has('diffTarget')) m.set('diffTarget', meta.diffTarget);
    if (meta.diffStatus !== undefined && !m.has('diffStatus')) m.set('diffStatus', meta.diffStatus);
    if (meta.diffOldPath !== undefined && !m.has('diffOldPath'))
      m.set('diffOldPath', meta.diffOldPath);
    if (meta.diffAdditions !== undefined && !m.has('diffAdditions'))
      m.set('diffAdditions', meta.diffAdditions);
    if (meta.diffDeletions !== undefined && !m.has('diffDeletions'))
      m.set('diffDeletions', meta.diffDeletions);
  });
}

export function readThread(threadMap: Y.Map<unknown>, threadId: string): Thread | null {
  const anchor = threadMap.get('anchor') as Anchor | undefined;
  const status = threadMap.get('status') as ThreadStatus | undefined;
  const createdBy = threadMap.get('createdBy') as User | undefined;
  const createdAt = threadMap.get('createdAt') as number | undefined;
  const commentsArr = threadMap.get('comments') as Y.Array<Y.Map<unknown>> | undefined;
  if (!anchor || !status || !createdBy || createdAt === undefined) return null;

  const comments: Comment[] = [];
  if (commentsArr) {
    for (const c of commentsArr) {
      const id = c.get('id') as string | undefined;
      const author = c.get('author') as User | undefined;
      const text = c.get('text') as string | undefined;
      const ts = c.get('ts') as number | undefined;
      if (id && author && text !== undefined && ts !== undefined) {
        comments.push({ id, author, text, ts });
      }
    }
  }

  const lastActivity =
    comments.length > 0 ? (comments[comments.length - 1]?.ts ?? createdAt) : createdAt;

  return {
    id: threadId,
    status,
    anchor,
    createdBy,
    commentCount: comments.length,
    lastActivity,
    comments,
  };
}

export function listThreads(doc: Y.Doc): Thread[] {
  const out: Thread[] = [];
  const threads = getThreads(doc);
  threads.forEach((threadMap, id) => {
    const t = readThread(threadMap, id);
    if (t) out.push(t);
  });
  return out;
}

export interface CreateThreadArgs {
  threadId: string;
  anchor: Anchor;
  createdBy: User;
  firstComment: { id: string; text: string };
}

export function createThread(doc: Y.Doc, args: CreateThreadArgs): Thread {
  const threads = getThreads(doc);
  const now = Date.now();
  const threadMap = new Y.Map<unknown>();
  const comments = new Y.Array<Y.Map<unknown>>();
  const firstCommentMap = new Y.Map<unknown>();

  doc.transact(() => {
    firstCommentMap.set('id', args.firstComment.id);
    firstCommentMap.set('author', args.createdBy);
    firstCommentMap.set('text', args.firstComment.text);
    firstCommentMap.set('ts', now);
    comments.push([firstCommentMap]);

    threadMap.set('anchor', args.anchor);
    threadMap.set('status', 'open');
    threadMap.set('createdBy', args.createdBy);
    threadMap.set('createdAt', now);
    threadMap.set('comments', comments);

    threads.set(args.threadId, threadMap);
  });

  const t = readThread(threadMap, args.threadId);
  if (!t) throw new Error('thread creation failed');
  return t;
}

export function postReply(
  doc: Y.Doc,
  threadId: string,
  reply: { id: string; author: User; text: string },
): Comment | null {
  const threads = getThreads(doc);
  const threadMap = threads.get(threadId);
  if (!threadMap) return null;
  const comments = threadMap.get('comments') as Y.Array<Y.Map<unknown>> | undefined;
  if (!comments) return null;
  const now = Date.now();
  const cm = new Y.Map<unknown>();
  doc.transact(() => {
    cm.set('id', reply.id);
    cm.set('author', reply.author);
    cm.set('text', reply.text);
    cm.set('ts', now);
    comments.push([cm]);
  });
  return { id: reply.id, author: reply.author, text: reply.text, ts: now };
}

export function setStatus(doc: Y.Doc, threadId: string, status: ThreadStatus): Thread | null {
  const threads = getThreads(doc);
  const threadMap = threads.get(threadId);
  if (!threadMap) return null;
  doc.transact(() => threadMap.set('status', status));
  return readThread(threadMap, threadId);
}

/** Replace anchor (used when re-anchoring an orphaned thread). */
export function replaceAnchor(doc: Y.Doc, threadId: string, anchor: Anchor): Thread | null {
  const threads = getThreads(doc);
  const threadMap = threads.get(threadId);
  if (!threadMap) return null;
  doc.transact(() => threadMap.set('anchor', anchor));
  return readThread(threadMap, threadId);
}

/** Used by anchor resolution to mark a thread orphaned without losing its anchor context. */
export function markOrphan(doc: Y.Doc, threadId: string): Thread | null {
  const threads = getThreads(doc);
  const threadMap = threads.get(threadId);
  if (!threadMap) return null;
  const current = threadMap.get('anchor') as Anchor | undefined;
  if (!current || current.kind === 'orphan') return readThread(threadMap, threadId);
  const orphan: Anchor = { kind: 'orphan', original: current, lastSeenAt: Date.now() };
  doc.transact(() => threadMap.set('anchor', orphan));
  return readThread(threadMap, threadId);
}
