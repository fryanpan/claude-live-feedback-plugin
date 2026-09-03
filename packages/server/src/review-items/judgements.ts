/**
 * The quality gate's verdicts — what the judge writes back onto an ask it was
 * shown, for both shapes an ask can take.
 *
 * A verdict is about ONE version of the words. Both verbs here refuse a
 * verdict that outlived the words it read (`forVersion`) and one overtaken by
 * a newer verdict (`forPendingAt`), which is what stops a judge returning
 * late from re-holding an item a reader has just released.
 */
import { type ReviewItemJudgement, readTaskReviewItem } from '@feedback/core';
import { classifyActor } from '../actor-identity.ts';
import { wordsRevisionOf } from '../task-fields.ts';
import { LEGACY_REVIEW_ITEM_ID, legacyDecisionItem, reviewItemVersion } from './derive.ts';
import type { ReviewItemPersistence } from './persistence.ts';
import type { RecordDecisionJudgementResult, RecordReviewJudgementResult } from './types.ts';

export class ReviewJudgementStore {
  constructor(private readonly p: ReviewItemPersistence) {}

  /**
   * Record the quality gate's verdict on an item's CURRENT words, and who
   * filed them.
   *
   * Writes only the two store-side fields — `judge` (projected, so the card
   * can say "Held: …") and `filedBy` (store-only, so the wake can be
   * addressed). The words themselves are untouched: a hold is a verdict ON the
   * item, never an edit OF it, and the filer's own `revise` is what changes
   * the text. Overwrites the previous verdict in place because a verdict is
   * about the current words, and those have a history of their own
   * (`revisions`) that a superseded verdict adds nothing to.
   *
   * Refuses the derived legacy row and an answered item for the same reasons
   * `reviseReviewItem` does: neither has words a verdict could hold.
   */
  recordReviewJudgement(
    taskId: string,
    reviewItemId: string,
    judgement: ReviewItemJudgement,
    opts: {
      actor: { id: string; name: string; kind?: string };
      /**
       * The words the verdict is ABOUT, as `reviewItemVersion` read them
       * before the judge was asked. A revision that landed while the judge
       * was out makes this verdict stale — it is refused, and the revision's
       * own judgement is the one that stands. Omitted: the caller accepts
       * whatever words are there now.
       */
      forVersion?: number;
      /**
       * The `at` of the `pending` stamp this caller placed before it asked
       * the judge. The verdict is refused unless that exact stamp is still
       * on the row — somebody else has written a verdict since, and theirs
       * is the newer fact.
       *
       * `forVersion` alone does not cover this: a reader overruling the gate
       * releases the item WITHOUT changing its words, so a judge that came
       * back afterwards still matched the version and could re-hold an item
       * the reader had just been told was released (codex review).
       */
      forPendingAt?: number;
    },
  ): RecordReviewJudgementResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (reviewItemId === LEGACY_REVIEW_ITEM_ID) return { ok: false, error: 'unknown-review-item' };
    const item = task.reviews?.find((r) => r.id === reviewItemId);
    if (!item) return { ok: false, error: 'unknown-review-item' };
    if (item.answer) return { ok: false, error: 'answered' };
    if (opts.forVersion !== undefined && reviewItemVersion(item) !== opts.forVersion) {
      return { ok: false, error: 'stale' };
    }
    if (
      opts.forPendingAt !== undefined &&
      (item.judge?.verdict !== 'pending' || item.judge.at !== opts.forPendingAt)
    ) {
      return { ok: false, error: 'stale' };
    }
    item.judge = { at: judgement.at, verdict: judgement.verdict, reason: judgement.reason };
    item.filedBy = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    task.updatedAt = Math.max(task.updatedAt, judgement.at);
    this.p.save(task.workspaceId);
    const read = readTaskReviewItem(item);
    // Unreachable: the row was found by id and its review was readable a
    // moment ago. Kept so a corrupt row is a refusal rather than an undefined.
    if (!read) return { ok: false, error: 'unknown-review-item' };
    return { ok: true, task, item: read };
  }

  /**
   * The same verdict write, for the ticket's OWN decision — the derived
   * `r-legacy` row that `recordReviewJudgement` refuses by id.
   *
   * A separate method rather than a branch inside that one, because the two
   * write to different places and guard on different versions: a ticket item
   * stamps its own wrapper and counts `revisions`; the decision stamps the
   * TASK and counts `wordsRevisionOf`, since its words are the row's words
   * and every writer of those already moves that counter. Folding them
   * together would mean one function whose every line asks which shape it is
   * holding.
   *
   * The refusals are the same three facts, read off this shape: the ticket
   * must still be a decision, an ANSWERED decision is closed (a verdict
   * about words a person has already acted on changes nothing), and a
   * verdict that outlived the words it read is dropped.
   */
  recordDecisionJudgement(
    taskId: string,
    judgement: ReviewItemJudgement,
    opts: {
      actor: { id: string; name: string; kind?: string };
      /** `wordsRevisionOf` as this run read it before asking the judge. */
      forVersion?: number;
      /** The `pending` stamp this caller placed — see `recordReviewJudgement`. */
      forPendingAt?: number;
    },
  ): RecordDecisionJudgementResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (task.needs !== 'decision') return { ok: false, error: 'not-a-decision' };
    if (task.answer) return { ok: false, error: 'answered' };
    if (opts.forVersion !== undefined && wordsRevisionOf(task) !== opts.forVersion) {
      return { ok: false, error: 'stale' };
    }
    if (
      opts.forPendingAt !== undefined &&
      (task.decisionJudge?.verdict !== 'pending' || task.decisionJudge.at !== opts.forPendingAt)
    ) {
      return { ok: false, error: 'stale' };
    }
    task.decisionJudge = {
      at: judgement.at,
      verdict: judgement.verdict,
      reason: judgement.reason,
    };
    task.decisionFiledBy = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    task.updatedAt = Math.max(task.updatedAt, judgement.at);
    this.p.save(task.workspaceId);
    const item = legacyDecisionItem(task);
    // Unreachable: `needs === 'decision'` was checked above and is the whole
    // condition `legacyReviewItem` derives on.
    if (!item) return { ok: false, error: 'not-a-decision' };
    return { ok: true, task, item };
  }
}
