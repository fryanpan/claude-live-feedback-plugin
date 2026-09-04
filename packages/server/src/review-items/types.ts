/**
 * What the review-item verbs answer with. Their own module so the store, the
 * routes and `TaskStore`'s delegating methods all name one shape.
 */
import type { TaskReviewItem } from '@feedback/core';
import type { Task } from '@feedback/core/task-wire';
import type { HubWorkspace } from '../tasks.ts';

export type AnswerDecisionResult =
  | { ok: true; task: Task }
  | { ok: false; error: 'not-found' | 'not-a-decision' | 'unknown-option' };

export type WithdrawAnswerResult =
  | { ok: true; task: Task }
  | { ok: false; error: 'not-found' | 'not-a-decision' | 'no-answer' };

export type RequestMoreInfoResult =
  | { ok: true; task: Task }
  | { ok: false; error: 'not-found' | 'not-a-decision' };

/**
 * One HELD review item as the stall monitor reads it off the board: enough to
 * name the item and the ticket in a wake, and to address the filer.
 */
export interface HeldReviewItem {
  taskId: string;
  title: string;
  reviewItemId: string;
  headline: string;
  /** The judge's reason — the gap the filer was asked to close. */
  reason: string;
  /** When the hold was placed; what the 5-minute clock runs from. */
  heldAt: number;
  /** Display name of the filer, for the line. */
  filedBy: string;
  /** The filer's agent id, for the addressed wake. Absent on an item whose
   *  filer the store did not record (pre-gate rows cannot be held anyway). */
  filerAgentId?: string;
}

export type AddReviewItemResult =
  | {
      ok: true;
      task: Task;
      item: TaskReviewItem;
      /** The shared checker's GAPS, phrased as what to write. Advice on a
       *  successful create, never a refusal — see `reviewGapAdvice`. */
      advice?: string;
    }
  | {
      ok: false;
      error: 'not-found' | 'bad-review';
      /** The gate's verbatim refusal, written to land in a retrying model's
       *  context. Present exactly when `error` is 'bad-review'. */
      message?: string;
    };

export type AnswerTaskReviewResult =
  | { ok: true; task: Task; item: TaskReviewItem }
  | {
      ok: false;
      error: 'not-found' | 'unknown-review-item' | 'unknown-option' | 'not-a-decision';
    };

export type RequestInfoOnReviewResult =
  | { ok: true; task: Task; item: TaskReviewItem }
  | { ok: false; error: 'not-found' | 'unknown-review-item' | 'not-a-decision' };

export type ReviseReviewItemResult =
  | {
      ok: true;
      task: Task;
      item: TaskReviewItem;
      /** The anchored thread the revision answers, when a question was asked
       *  doc-style — where a reply belongs. */
      threadId?: string;
      advice?: string;
    }
  | {
      ok: false;
      error:
        | 'not-found'
        | 'unknown-review-item'
        | 'not-revisable'
        | 'answered'
        | 'withdrawn'
        | 'empty-patch'
        | 'no-change'
        | 'bad-review'
        | 'bad-range';
      /** The verbatim refusal, present for 'bad-review', 'answered', 'withdrawn',
       *  'no-change' and 'bad-range'. */
      message?: string;
    };

export type WithdrawReviewItemResult =
  | { ok: true; task: Task; item: TaskReviewItem }
  | {
      ok: false;
      error:
        | 'not-found'
        | 'unknown-review-item'
        | 'not-withdrawable'
        | 'answered'
        | 'already-withdrawn'
        | 'not-withdrawn';
      /** The verbatim refusal, for the errors core phrases
       *  ('answered', 'already-withdrawn', 'not-withdrawn'). */
      message?: string;
    };

/** `recordReviewJudgement`'s answer. */
export type RecordReviewJudgementResult =
  | { ok: true; task: Task; item: TaskReviewItem }
  | { ok: false; error: 'not-found' | 'unknown-review-item' | 'answered' | 'stale' };

/** `recordDecisionJudgement`'s answer. */
export type RecordDecisionJudgementResult =
  | { ok: true; task: Task; item: TaskReviewItem }
  | { ok: false; error: 'not-found' | 'not-a-decision' | 'answered' | 'stale' };

/** `reviseTaskDecision`'s answer. */
export type ReviseTaskDecisionResult =
  | { ok: true; task: Task; item: TaskReviewItem }
  | {
      ok: false;
      error:
        | 'not-found'
        | 'not-a-decision'
        | 'answered'
        | 'empty-patch'
        | 'no-change'
        | 'bad-review';
      message?: string;
    };

/** `reviewState`'s answer — `undefined` for a ticket that does not exist. */
export type ReviewStateCounts = { open: number; unreadable: number; held: number };

/** `reviewItemCriteria`'s answer. */
export type ReviewItemCriteriaRead = { value: string; isDefault: boolean };

/** `setReviewItemCriteria`'s answer. */
export type SetReviewItemCriteriaResult =
  | { ok: true; workspace: HubWorkspace; criteria: ReviewItemCriteriaRead }
  | { ok: false; error: 'workspace-not-found' };
