/**
 * The 0..n review items filed ON a ticket — asking, answering, asking for
 * more, rewriting the ask, and taking it back.
 *
 * Lifted out of `TaskStore` whole. These verbs used to sit in the middle of
 * an 8,000-line class, sharing a `this` with goals, attachments, voice queues
 * and the sidecar writer — so nothing stopped one reaching for any of them,
 * and nothing said which of them it actually needed. Now that answer is the
 * nine-member `ReviewItemPersistence` this module declares itself, and a test
 * can hand it a plain object.
 *
 * The `r-legacy` row is not one of these: it is DERIVED from a legacy
 * decision's own fields, so the two verbs that accept it hand it straight to
 * `TaskDecisionStore` rather than growing a second implementation of
 * "record a decision's answer" free to drift from the first.
 */
import {
  type ReviewItemRange,
  type TaskReviewItem,
  applyReviewRevision,
  checkReviewPayload,
  latestThreadedQuestion,
  readReviewPayload,
  reinstateReview,
  reviewGapAdvice,
  reviewPayloadMessage,
  withdrawReview,
} from '@feedback/core';
import type { TaskActor } from '@feedback/core/task-wire';
import { classifyActor } from '../actor-identity.ts';
import { cryptoId } from '../task-fields.ts';
import { TaskDecisionStore } from './decisions.ts';
import { LEGACY_REVIEW_ITEM_ID } from './derive.ts';
import type { ReviewItemPersistence } from './persistence.ts';
import type {
  AddReviewItemResult,
  AnswerTaskReviewResult,
  RequestInfoOnReviewResult,
  ReviseReviewItemResult,
  WithdrawReviewItemResult,
} from './types.ts';

export class ReviewItemStore {
  private readonly decisions: TaskDecisionStore;

  constructor(private readonly p: ReviewItemPersistence) {
    this.decisions = new TaskDecisionStore(p);
  }

  /**
   * Attach a review item to a ticket.
   *
   * `review` arrives as `unknown` because every door into this is a route
   * carrying parsed JSON, and it is gated by `checkReviewPayload` — THE
   * checker, the same one comment-borne declarations pass through. Writing a
   * second gate here is precisely the "two spellings of one concept" this
   * whole change deletes: a second copy of a limit is how a card ends up
   * rendering something the API swore it had refused.
   *
   * The stored payload is the one `readReviewPayload` normalizes out of the
   * input, so caller-supplied junk keys never reach the sidecar. Option ids
   * are the CALLER'S — `checkReviewPayload` already demands they exist and be
   * unique within the item, and re-minting them would break an `answeredWith`
   * a client had already put on screen. Only the item id is minted here,
   * `r-<crypto>`, the way options mint `o-<crypto>`.
   *
   * `gaps` come back as `advice` on SUCCESS. They were computed and read by
   * nobody in the first cut of this feature: the call returned 200, the card
   * came out thinner than the author meant, and nothing connected the two.
   */
  addReviewItem(
    taskId: string,
    review: unknown,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): AddReviewItemResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };

    const check = checkReviewPayload(review);
    if (!check.ok) {
      return { ok: false, error: 'bad-review', message: reviewPayloadMessage(check) };
    }
    const payload = readReviewPayload(review);
    // Unreachable for anything the gate passed — kept because "the checker said
    // yes and the reader said no" must not become an undefined write.
    if (!payload) {
      return { ok: false, error: 'bad-review', message: reviewPayloadMessage(check) };
    }

    const ts = this.p.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    const item: TaskReviewItem = {
      id: cryptoId('r'),
      review: payload,
      createdAt: ts,
      // Display name, like every other projected `by` (§3.3 visitor contract).
      createdBy: actor.name,
    };
    task.reviews = [...(task.reviews ?? []), item];
    task.updatedAt = ts;
    this.p.save(task.workspaceId);
    this.p.emit({
      type: 'review_item.added',
      workspaceId: task.workspaceId,
      taskId: task.id,
      reviewItemId: item.id,
      shape: payload.shape,
      headline: payload.headline,
      actor,
      links: task.links,
      ts,
    });

    const advice = reviewGapAdvice(check.gaps);
    return { ok: true, task, item, ...(advice !== undefined ? { advice } : {}) };
  }

  /**
   * Answer ONE review item on a ticket, leaving its siblings open.
   *
   * `r-legacy` DELEGATES to `answerDecision`, untouched. That is the whole
   * back-compat story in one line: `task.answer`, the `optionId` validation
   * and the `decision.answered` payload stay byte-identical for every caller
   * that never heard of review items, and there is no second implementation of
   * "record a decision's answer" free to drift from the first.
   */
  answerTaskReview(
    taskId: string,
    reviewItemId: string,
    text: string,
    opts: { actor: { id: string; name: string; kind?: string }; answeredWith?: string },
  ): AnswerTaskReviewResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };

    if (reviewItemId === LEGACY_REVIEW_ITEM_ID && this.decisions.legacyReviewItem(task)) {
      const res = this.decisions.answerDecision(taskId, text, {
        actor: opts.actor,
        ...(opts.answeredWith !== undefined ? { optionId: opts.answeredWith } : {}),
      });
      if (!res.ok) return res;
      const item = this.decisions.legacyReviewItem(res.task);
      // The row exists — it resolved a line above — so this only guards the
      // type. An answer recorded is never reported as a failure.
      if (!item) return { ok: false, error: 'unknown-review-item' };
      return { ok: true, task: res.task, item };
    }

    const item = task.reviews?.find((r) => r.id === reviewItemId);
    if (!item) return { ok: false, error: 'unknown-review-item' };
    // An `answeredWith` that resolves to no option ON THIS ROW would record an
    // answer whose provenance is a lie — and with several rows on one ticket,
    // a neighbour's option id is the easy way to write that lie by accident.
    if (
      opts.answeredWith !== undefined &&
      !item.review.options?.some((o) => o.id === opts.answeredWith)
    ) {
      return { ok: false, error: 'unknown-option' };
    }

    const ts = this.p.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    // Answering twice is legal — somebody changes their mind, a retry lands,
    // two people reach for the same row — but the words already recorded are
    // USER CONTENT and this project does not hard-delete user content. The
    // superseded answer moves aside instead of being written over; nothing
    // else anywhere would have reported that it was gone.
    if (item.answer) item.priorAnswers = [...(item.priorAnswers ?? []), item.answer];
    item.answer = {
      text,
      by: actor.name,
      ts,
      ...(opts.answeredWith !== undefined ? { answeredWith: opts.answeredWith } : {}),
    };
    task.updatedAt = ts;
    this.p.save(task.workspaceId);
    this.p.emit({
      type: 'decision.answered',
      workspaceId: task.workspaceId,
      taskId: task.id,
      answer: text,
      ...(opts.answeredWith !== undefined ? { optionId: opts.answeredWith } : {}),
      reviewItemId,
      actor,
      links: task.links,
      ts,
    });
    return { ok: true, task, item };
  }

  /**
   * Ask ONE review item for more context instead of answering it.
   *
   * Carried over deliberately. "Tell me more" is a shipped first-class
   * response with no counterpart in `ReviewPayload`, so unifying the two
   * spellings without it would have quietly deleted a capability people use.
   * The item stays open and stays counted — that is the point of it being its
   * own thing rather than an answer carrying a flag.
   *
   * `r-legacy` delegates to the untouched `requestMoreInfo`, same as above.
   */
  requestMoreInfoOnReview(
    taskId: string,
    reviewItemId: string,
    question: string,
    opts: {
      actor: { id: string; name: string; kind?: string };
      /**
       * The thread the question was asked on, with the phrase it is about,
       * when it was asked doc-style — by selecting words of the item and
       * commenting. Same storage as the typed question, one field richer:
       * that is what makes the item's state derivable from one list rather
       * than reconciled across two.
       */
      threadId?: string;
      range?: ReviewItemRange;
    },
  ): RequestInfoOnReviewResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };

    if (reviewItemId === LEGACY_REVIEW_ITEM_ID && this.decisions.legacyReviewItem(task)) {
      // The thread and the phrase ride along: a threaded question is what
      // takes the ticket's own decision off the reader's queue, exactly as
      // it takes a stored item off it — same derivation, `reviewItemState`
      // on the row `legacyReviewItem` builds from these.
      const res = this.decisions.requestMoreInfo(taskId, question, {
        actor: opts.actor,
        ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
        ...(opts.range !== undefined ? { range: opts.range } : {}),
      });
      if (!res.ok) return res;
      const item = this.decisions.legacyReviewItem(res.task);
      if (!item) return { ok: false, error: 'unknown-review-item' };
      return { ok: true, task: res.task, item };
    }

    const item = task.reviews?.find((r) => r.id === reviewItemId);
    if (!item) return { ok: false, error: 'unknown-review-item' };

    const ts = this.p.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    item.infoRequests = [
      ...(item.infoRequests ?? []),
      {
        text: question,
        by: actor.name,
        ts,
        ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
        ...(opts.range !== undefined ? { range: opts.range } : {}),
      },
    ];
    task.updatedAt = ts;
    this.p.save(task.workspaceId);
    this.p.emit({
      type: 'decision.info_requested',
      workspaceId: task.workspaceId,
      taskId: task.id,
      question,
      reviewItemId,
      actor,
      links: task.links,
      ts,
    });
    return { ok: true, task, item };
  }

  /**
   * Rewrite ONE review item's words in place, keeping what they were.
   *
   * The owner's answer to a question asked on the item: not a reply that
   * leaves the ask as confusing as it was, but the ask itself made clearer.
   * `patch` names only the fields that change; the merged payload passes the
   * SAME gate a new item does (`checkReviewPayload`), so a revision cannot
   * smuggle in what a filing would have been refused.
   *
   * The previous text goes onto `revisions` — user content is never
   * overwritten in place — stamped with the anchored thread it answers (the
   * newest doc-style question) and with where the change landed in the new
   * text: the caller's `revisedRange` if given, else the prefix/suffix diff
   * of the detail. `reviewItemState` reads the item as `revised` from here,
   * which is what puts it back on the queue.
   *
   * The derived legacy row (`r-legacy`) is refused: its words are the task's
   * title and body, and rewriting those is `rewrite_task`'s job. So is an
   * ANSWERED item: the answer was given to the words on it, and rewriting
   * them under it would leave a decision on record about text nobody can see
   * — and `reviewItemState` reads `answer` first, so the mismatch would never
   * surface as a re-queue either. File a fresh item instead.
   */
  reviseReviewItem(
    taskId: string,
    reviewItemId: string,
    patch: { headline?: unknown; detail?: unknown; options?: unknown },
    opts: {
      actor: { id: string; name: string; kind?: string };
      revisedRange?: { start: number; end: number };
    },
  ): ReviseReviewItemResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (reviewItemId === LEGACY_REVIEW_ITEM_ID) return { ok: false, error: 'not-revisable' };
    const item = task.reviews?.find((r) => r.id === reviewItemId);
    if (!item) return { ok: false, error: 'unknown-review-item' };
    if (item.answer) {
      return {
        ok: false,
        error: 'answered',
        message: `review item ${reviewItemId} is already answered — the answer is to the words it has; add a new item instead of rewriting these`,
      };
    }

    const ts = this.p.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    const question = latestThreadedQuestion(item);
    // What a revision IS — which patches are legal, where the changed span
    // fell, what the superseded reading was — is decided once, in core, and
    // shared with the doc-thread route. Only WHERE the history is filed
    // differs: a ticket item keeps it on the wrapper (below), a doc-thread
    // item on the payload (`withRevision`). The `item.answer` refusal above
    // STAYS: a ticket item records its answer on the wrapper, which the
    // payload-level check inside cannot see.
    const applied = applyReviewRevision(item.review, patch, {
      by: actor.name,
      at: ts,
      ...(opts.revisedRange ? { revisedRange: opts.revisedRange } : {}),
      ...(question?.threadId !== undefined ? { threadId: question.threadId } : {}),
    });
    if (!applied.ok) {
      return applied.error === 'answered'
        ? { ok: false, error: 'answered', message: applied.message ?? '' }
        : applied.error === 'empty-patch'
          ? { ok: false, error: 'empty-patch' }
          : { ok: false, error: applied.error, message: applied.message ?? '' };
    }
    item.revisions = [...(item.revisions ?? []), applied.previous];
    item.review = applied.next;
    task.updatedAt = ts;
    this.p.save(task.workspaceId);
    this.p.emit({
      type: 'review_item.revised',
      workspaceId: task.workspaceId,
      taskId: task.id,
      reviewItemId,
      ...(question?.threadId !== undefined ? { threadId: question.threadId } : {}),
      actor,
      links: task.links,
      ts,
    });
    const advice = reviewGapAdvice(applied.gaps);
    return {
      ok: true,
      task,
      item,
      ...(question?.threadId !== undefined ? { threadId: question.threadId } : {}),
      ...(advice !== undefined ? { advice } : {}),
    };
  }

  /**
   * Take back one review item on a ticket, or put it back (`undo`) — the
   * asker's own exit from its own ask, which the doc-thread surface has had
   * since 2026-08-29 and the ticket surface lacked. The measured cost of the
   * gap: a duplicate ticket-form decision could only leave the reader's queue
   * by being revised into something else, which is a lie about what was asked.
   *
   * What "withdrawn" MEANS — the stamps, the refusals, the words never being
   * touched — is core's (`withdrawReview` / `reinstateReview`), shared with
   * the doc route so the two surfaces cannot drift. This method only decides
   * where the payload lives (the item wrapper) and what else must be true of
   * the WRAPPER: an answer recorded there closes the item just as payload
   * stamps do, and core cannot see it.
   *
   * The derived legacy row is refused: the ticket's own decision has no
   * stored item to stamp — its words ARE the title, body and options — and
   * its exits are answering it or archiving the ticket.
   */
  withdrawReviewItem(
    taskId: string,
    reviewItemId: string,
    opts: {
      actor: { id: string; name: string; kind?: string };
      reason?: string;
      undo?: boolean;
    },
  ): WithdrawReviewItemResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (reviewItemId === LEGACY_REVIEW_ITEM_ID) {
      return {
        ok: false,
        error: 'not-withdrawable',
        message:
          "the ticket's own decision has no item to withdraw — its words are the ticket; answer it, rewrite the ticket, or archive it",
      };
    }
    const item = task.reviews?.find((r) => r.id === reviewItemId);
    if (!item) return { ok: false, error: 'unknown-review-item' };
    if (item.answer && opts.undo !== true) {
      return {
        ok: false,
        error: 'answered',
        message: `review item ${reviewItemId} is already answered — withdrawing it would retract an answer somebody gave; undo the answer first if it was a mistake`,
      };
    }

    const ts = this.p.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    const applied =
      opts.undo === true
        ? reinstateReview(item.review, { by: actor.name, at: ts })
        : withdrawReview(item.review, {
            by: actor.name,
            at: ts,
            ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
          });
    if (!applied.ok) return { ok: false, error: applied.error, message: applied.message };
    item.review = applied.next;
    task.updatedAt = ts;
    this.p.save(task.workspaceId);
    const reason = opts.reason?.trim();
    this.p.emit({
      type: 'review_item.withdrawn',
      workspaceId: task.workspaceId,
      taskId: task.id,
      reviewItemId,
      ...(opts.undo === true ? { reinstated: true } : {}),
      ...(reason !== undefined && reason !== '' && opts.undo !== true ? { reason } : {}),
      actor,
      links: task.links,
      ts,
    });
    return { ok: true, task, item };
  }
}
