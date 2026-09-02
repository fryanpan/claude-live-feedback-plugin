/**
 * Deriving a review item from a ticket's LEGACY decision fields — pure, and
 * shared by the review-item store, the board projection and the REST queue
 * so no two of them can disagree about whether a decision is still waiting.
 */
import { type ReviewPayload, type TaskReviewItem, reviewFromDecisionTask } from '@feedback/core';
import type { Task } from '@feedback/core/task-wire';
import { taskAskedBy } from '../task-fields.ts';

/**
 * The id of the review item DERIVED from a task's legacy decision fields.
 *
 * Fixed rather than minted, and that is what makes the derivation safe to run
 * on every read: the same task always derives the same id, so an answer
 * addressed at it lands on the same row no matter how many times anything
 * re-derived it. A minted id would make a read a write.
 *
 * It cannot collide with a real one: `cryptoId('r')` emits `r-` plus twelve
 * base64url characters, and this is six.
 */
export const LEGACY_REVIEW_ITEM_ID = 'r-legacy';

/**
 * The one legacy decision a task carries, as a review item — or undefined
 * when the task is not a decision.
 *
 * The body of `TaskStore.legacyReviewItem`, lifted to a PURE module function
 * so the board projection can derive the same row (and read its state) from
 * a task alone: `projectTask` holds no store, and the browser draws the
 * Home decision card off the projection rather than off `GET /review-items`.
 * One derivation, so the queue route and the projection cannot disagree
 * about whether a decision is waiting on its owner.
 *
 * `needs === 'decision'` is the WHOLE condition. It used to also require
 * that no stored row existed, which made an unanswered decision disappear
 * from every reader as soon as somebody filed a second question on the same
 * ticket — see `listReviewItems` for why that is the wrong key.
 *
 * What is carried across, beyond `reviewFromDecisionTask`'s payload: the
 * task's own clock and filer, the legacy `answer` (an answered decision read
 * as open is a queue that never empties), the info requests WITH their
 * threads (a threaded one is what reads as `waiting`), and the decision's
 * revisions (what reads as `revised`).
 */
export function legacyDecisionItem(task: Task): TaskReviewItem | undefined {
  if (task.needs !== 'decision') return undefined;
  const review: ReviewPayload = reviewFromDecisionTask(task);
  const item: TaskReviewItem = {
    id: LEGACY_REVIEW_ITEM_ID,
    review,
    createdAt: task.createdAt,
    createdBy: taskAskedBy(task),
    // The gate's verdict on these words, so a held decision is skipped by
    // `isReviewItemGated` exactly as a held ticket item is. Derived here
    // rather than stored on the row, for the reason `decisionJudge`
    // carries: this item is rebuilt on every read.
    ...(task.decisionJudge !== undefined ? { judge: task.decisionJudge } : {}),
  };
  if (task.answer) {
    item.answer = {
      text: task.answer.text,
      by: task.answer.by,
      ts: task.answer.ts,
      ...(task.answer.optionId !== undefined ? { answeredWith: task.answer.optionId } : {}),
    };
  }
  if (task.infoRequests && task.infoRequests.length > 0) {
    item.infoRequests = task.infoRequests.map((r) => ({
      text: r.text,
      by: r.by,
      ts: r.ts,
      ...(r.threadId !== undefined ? { threadId: r.threadId } : {}),
      ...(r.range !== undefined ? { range: r.range } : {}),
    }));
  }
  if (task.decisionRevisions && task.decisionRevisions.length > 0) {
    item.revisions = task.decisionRevisions;
  }
  return item;
}

/**
 * Which WORDS a review item currently has: its revision count. A judge's
 * verdict is about one version; `recordReviewJudgement` compares this so a
 * verdict that outlived the words it judged is dropped rather than applied
 * to the revision that replaced them.
 */
export function reviewItemVersion(item: Pick<TaskReviewItem, 'revisions'>): number {
  return item.revisions?.length ?? 0;
}
