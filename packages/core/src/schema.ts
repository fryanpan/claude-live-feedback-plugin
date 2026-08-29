import * as Y from 'yjs';
import { type ReviewPayload, readReviewPayload } from './review-item.ts';
import { readStoredSummary } from './thread-summary.ts';
import type {
  Anchor,
  Comment,
  DocMeta,
  StoredSummary,
  Thread,
  ThreadStatus,
  User,
} from './types.ts';

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
  const alias = m.get('alias') as string | undefined;
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
  const diffWhitespaceOnly = m.get('diffWhitespaceOnly') as boolean | undefined;
  const diffGroup = m.get('diffGroup') as string | undefined;
  const diffGroupRank = m.get('diffGroupRank') as number | undefined;
  const diffGroupDetails = m.get('diffGroupDetails') as string | undefined;
  const huddle = m.get('huddle') as boolean | undefined;
  return {
    docId,
    type,
    createdAt,
    alias,
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
    diffWhitespaceOnly,
    diffGroup,
    diffGroupRank,
    diffGroupDetails,
    huddle,
  };
}

export function initDocMeta(doc: Y.Doc, meta: DocMeta): void {
  const m = getMeta(doc);
  doc.transact(() => {
    if (!m.has('docId')) m.set('docId', meta.docId);
    if (!m.has('type')) m.set('type', meta.type);
    if (!m.has('createdAt')) m.set('createdAt', meta.createdAt);
    // sourceUrl / owner / workspaceRoot / producedBy are deliberately NOT
    // written here. They describe the host machine rather than the document,
    // nothing on the client reads their values, and the Yjs doc is handed
    // whole to every connected client — share visitors included — so a key in
    // this map is a key the person holding a share link can read. The server
    // keeps them in a sidecar instead (server/src/private-meta.ts).
    if (meta.title !== undefined) m.set('title', meta.title);
    // `!m.has` rather than an unconditional set, matching the other
    // create-time keys — and load-bearing here rather than stylistic, because
    // it is what makes the alias unwritable a second time even from inside
    // the server.
    if (meta.alias !== undefined && !m.has('alias')) m.set('alias', meta.alias);
    if (meta.setId !== undefined) m.set('setId', meta.setId);
    if (meta.workspaceId !== undefined && !m.has('workspaceId'))
      m.set('workspaceId', meta.workspaceId);
    if (meta.relPath !== undefined && !m.has('relPath')) m.set('relPath', meta.relPath);
    if (meta.diffBase !== undefined && !m.has('diffBase')) m.set('diffBase', meta.diffBase);
    if (meta.diffTarget !== undefined && !m.has('diffTarget')) m.set('diffTarget', meta.diffTarget);
    if (meta.diffStatus !== undefined && !m.has('diffStatus')) m.set('diffStatus', meta.diffStatus);
    if (meta.diffOldPath !== undefined && !m.has('diffOldPath'))
      m.set('diffOldPath', meta.diffOldPath);
    if (meta.diffAdditions !== undefined && !m.has('diffAdditions'))
      m.set('diffAdditions', meta.diffAdditions);
    if (meta.diffDeletions !== undefined && !m.has('diffDeletions'))
      m.set('diffDeletions', meta.diffDeletions);
    if (meta.diffWhitespaceOnly !== undefined && !m.has('diffWhitespaceOnly'))
      m.set('diffWhitespaceOnly', meta.diffWhitespaceOnly);
    if (meta.huddle !== undefined && !m.has('huddle')) m.set('huddle', meta.huddle);
    if (meta.diffGroup !== undefined && !m.has('diffGroup')) m.set('diffGroup', meta.diffGroup);
    if (meta.diffGroupRank !== undefined && !m.has('diffGroupRank'))
      m.set('diffGroupRank', meta.diffGroupRank);
    if (meta.diffGroupDetails !== undefined && !m.has('diffGroupDetails'))
      m.set('diffGroupDetails', meta.diffGroupDetails);
  });
}

export function readThread(threadMap: Y.Map<unknown>, threadId: string): Thread | null {
  const anchor = threadMap.get('anchor') as Anchor | undefined;
  const status = threadMap.get('status') as ThreadStatus | undefined;
  const createdBy = threadMap.get('createdBy') as User | undefined;
  const createdAt = threadMap.get('createdAt') as number | undefined;
  const summary = readStoredSummary(threadMap.get('summary'));
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
        // Read defensively, exactly as `summary` is: this map is written by
        // whatever peer posted the comment and no peer's write is
        // authoritative, so a malformed payload must degrade to "an ordinary
        // comment" rather than reach a renderer.
        const review = readReviewPayload(c.get('review'));
        comments.push({ id, author, text, ts, ...(review ? { review } : {}) });
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
    // Only a well-formed summary is surfaced — `readStoredSummary` checks
    // every field, including `discussion`. This value is synced to every peer
    // and no peer's write is authoritative, so a partial or mistyped object
    // must not be able to reach `threadLines`.
    ...(summary ? { summary } : {}),
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
  firstComment: { id: string; text: string; review?: ReviewPayload };
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
    if (args.firstComment.review) firstCommentMap.set('review', args.firstComment.review);
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
  reply: { id: string; author: User; text: string; review?: ReviewPayload },
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
    if (reply.review) cm.set('review', reply.review);
    comments.push([cm]);
  });
  return {
    id: reply.id,
    author: reply.author,
    text: reply.text,
    ts: now,
    ...(reply.review ? { review: reply.review } : {}),
  };
}

/**
 * Replace the review payload on an existing comment.
 *
 * The one mutation a review item takes after it is written: stamping the
 * answer — `answeredAt` on every answer, plus `answeredWith` when the words
 * came from tapping an option. Written as a whole-value `set` on the same
 * ydoc the browsers hold, so the card the person just answered updates from
 * the sync rather than from a refetch.
 *
 * Returns false when the comment has gone, which is a normal race rather
 * than an error.
 */
export function setCommentReview(
  doc: Y.Doc,
  threadId: string,
  commentId: string,
  review: ReviewPayload,
): boolean {
  const threadMap = getThreads(doc).get(threadId);
  const comments = threadMap?.get('comments') as Y.Array<Y.Map<unknown>> | undefined;
  if (!comments) return false;
  for (const c of comments) {
    if (c.get('id') !== commentId) continue;
    doc.transact(() => c.set('review', review));
    return true;
  }
  return false;
}

/**
 * Store a generated summary on a thread.
 *
 * Written as ONE transaction on the same ydoc the browsers are synced to, so
 * the new lines reach every open card the moment they land — no reload, no
 * refetch. Returns null when the thread has gone (deleted mid-flight), which
 * is a normal race, not an error.
 */
export function setThreadSummary(
  doc: Y.Doc,
  threadId: string,
  summary: StoredSummary,
): Thread | null {
  const threads = getThreads(doc);
  const threadMap = threads.get(threadId);
  if (!threadMap) return null;
  doc.transact(() => {
    threadMap.set('summary', summary);
  });
  return readThread(threadMap, threadId);
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
  // A subject anchor points at the thing the thread is ON, which cannot stop
  // existing while the thread does — so there is nothing to lose and nothing
  // to recover. Orphaning one would only hide it from the surfaces that show
  // anchored comments.
  if (!current || current.kind === 'orphan' || current.kind === 'subject') {
    return readThread(threadMap, threadId);
  }
  const orphan: Anchor = { kind: 'orphan', original: current, lastSeenAt: Date.now() };
  doc.transact(() => threadMap.set('anchor', orphan));
  return readThread(threadMap, threadId);
}
