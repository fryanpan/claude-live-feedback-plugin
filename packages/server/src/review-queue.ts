/**
 * What is waiting on a PERSON, across every surface a workspace has.
 *
 * The board's decisions strip answers a narrower question — open decision
 * tasks — and everything else that genuinely needs Bryan has been invisible
 * from the board: an agent's question on a task discussion, a doc comment
 * nobody answered. Those are one act ("someone needs you") wearing three
 * surfaces, and splitting them across three places to look is what makes
 * coming back to the board mean scrolling a chat history instead.
 *
 * This module computes the two thread-shaped kinds. Decisions stay where they
 * are — the client already holds every task — and the ORDERING of the merged
 * queue is the client's (`reviewQueue` in hub-model), which is what keeps the
 * priority rule in one pure, testable place instead of split across the wire.
 *
 * The server owns this half for one reason: "is this comment an agent's" is
 * `classifyActor`'s judgement, and it must not be re-decided here. A second
 * notion of who counts as an agent is exactly the drift this codebase has
 * already been bitten by.
 */
import type { Comment, Thread } from '@feedback/core';
import { classifyActor } from './activity.ts';

/** How much of the question rides along to the strip. Enough to recognise the
 *  ask; the thread itself is one tap away. */
const ASK_MAX = 200;

export interface ReviewThreadItem {
  kind: 'task-thread' | 'doc-thread';
  docId: string;
  threadId: string;
  /** Present on a task discussion — the board opens the task, not the doc. */
  taskId?: string;
  /** What the reader is being asked ABOUT: the task title, or the doc's label. */
  title: string;
  /** The question itself — the newest unanswered comment, clipped. */
  ask: string;
  askedBy: string;
  /** When that comment landed. How long it has been waiting is the whole
   *  priority signal within a band. */
  since: number;
}

export interface ReviewTaskRef {
  id: string;
  title: string;
  bodyDocId: string;
  /** A finished task's discussion is not a queue item — answering it changes
   *  nothing, and the board's problem is too much competing for attention. */
  done?: boolean;
}

export interface ReviewDocRef {
  docId: string;
  title: string;
}

export interface ThreadSource {
  /** A doc's threads, or `[]` when its room isn't loaded. A room that has
   *  never been opened has no threads either way, so absence and emptiness
   *  are the same answer here. */
  threadsOf(docId: string): Thread[];
}

/**
 * The comment that is waiting for a person, or null if none is.
 *
 * "The newest word is an agent's" is the signal, and a person speaking is the
 * ONLY thing that clears it — there is no dismissed flag, because a second
 * piece of state saying "handled" would immediately disagree with the first.
 *
 * It over-includes by design: an agent's closing note with nothing to answer
 * still reads as waiting. That is the safe direction — a queue showing one
 * item too many costs a glance, one hiding a question costs the question.
 */
export function awaitingPerson(thread: Thread): Comment | null {
  if (thread.status !== 'open') return null;
  const comments = thread.comments ?? [];
  if (comments.length === 0) return null;
  // By time, not by array position. Comment order in the Yjs array is
  // insertion order, and a CRDT merges concurrent inserts by position rather
  // than by clock — so "the last element" answers a question about array
  // layout, not about who spoke last. Ties keep the later element.
  let newest = comments[0];
  for (const c of comments) if (c.ts >= newest.ts) newest = c;
  return classifyActor(newest.author) === 'agent' ? newest : null;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > ASK_MAX ? `${flat.slice(0, ASK_MAX - 1)}…` : flat;
}

/**
 * Every open thread across a workspace's tasks and docs whose newest comment
 * is an agent's, oldest first — the thing that has been waiting longest is the
 * one most at risk of never being answered at all.
 */
export function reviewThreadItems(args: {
  tasks: ReviewTaskRef[];
  docs: ReviewDocRef[];
  source: ThreadSource;
}): ReviewThreadItem[] {
  const items: ReviewThreadItem[] = [];
  const collect = (
    kind: ReviewThreadItem['kind'],
    docId: string,
    title: string,
    taskId?: string,
  ) => {
    for (const thread of args.source.threadsOf(docId)) {
      const ask = awaitingPerson(thread);
      if (!ask) continue;
      items.push({
        kind,
        docId,
        threadId: thread.id,
        ...(taskId ? { taskId } : {}),
        title,
        ask: clip(ask.text),
        askedBy: ask.author.name,
        since: ask.ts,
      });
    }
  };

  for (const task of args.tasks) {
    if (task.done) continue;
    collect('task-thread', task.bodyDocId, task.title, task.id);
  }
  for (const doc of args.docs) collect('doc-thread', doc.docId, doc.title);

  return items.sort((a, b) => a.since - b.since || a.threadId.localeCompare(b.threadId));
}
