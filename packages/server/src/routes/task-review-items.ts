import {
  type Thread,
  answerAsksBack,
  isReviewItemGated,
  isReviewItemHeld,
  latestThreadedQuestion,
} from '@feedback/core';
/**
 * A ticket's review items — 0..n, several possibly open at once.
 *
 * Lifted verbatim out of `createServer`'s request closure; the handlers
 * read their collaborators off `TaskRoutesContext` instead of the scope.
 */
import { classifyActor } from '../activity.ts';
import { isCategoryAuthor } from '../task-owner.ts';
import { LEGACY_REVIEW_ITEM_ID } from '../tasks.ts';
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleTaskReviewItems(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const {
    taskStore,
    taskProjection,
    rooms,
    j,
    safeJson,
    parseRevisedRange,
    announceTaskReview,
    askBackOnItem,
    heldFields,
    judgeReviewItem,
    judgeTaskDecision,
  } = ctx;
  const { req, pathname, visitor, authorFor, refuseCategoryAuthor } = rq;
  // ── A ticket's review items: 0..n, several possibly open at once ────
  //
  // The two routes ABOVE are untouched and stay that way. They are the
  // old doors, and a session running an old plugin bundle keeps calling
  // them from a process we cannot restart — `answerTaskReview` on the
  // derived `r-legacy` row delegates straight back into
  // `answerDecision`, so there is exactly one implementation of
  // "record a decision's answer" underneath both.
  //
  // What these add is the cardinality. A decision task used to BE a
  // decision — one `needs` flag and one embedded `options` array — so
  // the ticket title had to double as the question and a second open
  // question had nowhere to go. Now the question is a row with its own
  // headline and why, and `:reviewItemId` says which one an answer
  // lands on.
  const taskReviewAddMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/review-items$/);
  if (taskReviewAddMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskReviewAddMatch[1] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    // Unvalidated on purpose: `addReviewItem` runs `checkReviewPayload`,
    // and that IS the gate. A pre-check here would be a second copy of
    // the limits, free to drift from the one the card renders against.
    const res = taskStore.addReviewItem(taskId, body?.review, { actor: author });
    if (!res.ok) {
      return j(res.error === 'not-found' ? 404 : 400, {
        error: res.error,
        ...(res.message !== undefined ? { message: res.message } : {}),
      });
    }
    taskProjection.ensureWorkspace(res.task.workspaceId);
    // The gate, BEFORE the announcement: a held item is not on anybody's
    // queue, so nothing may say it is.
    const gate = await judgeReviewItem(res.task, res.item, author);
    if (!gate.held) announceTaskReview(res.task, res.item, author);
    // `reviewAdvice`, the same key a comment-borne declaration answers
    // with. The divergent `shapeGaps` vocabulary stays exactly where it
    // is for the callers that already read it — this is a new door, and
    // a new door has no old callers to keep.
    return j(200, {
      task: res.task,
      item: gate.item,
      ...(res.advice !== undefined ? { reviewAdvice: res.advice } : {}),
      ...heldFields(gate),
    });
  }
  const taskReviewAnswerMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)\/review-items\/([^/]+)\/answer$/,
  );
  if (taskReviewAnswerMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskReviewAnswerMatch[1] ?? '');
    const reviewItemId = decodeURIComponent(taskReviewAnswerMatch[2] ?? '');
    const body = await safeJson(req);
    const text = body?.text;
    if (typeof text !== 'string' || text.length === 0) {
      return j(400, { error: 'text required' });
    }
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    // `answeredWith` is this entity's spelling of the legacy `optionId`:
    // provenance for a tapped answer, never a substitute for the words.
    const answeredWith = body?.answeredWith;
    if (answeredWith !== undefined && typeof answeredWith !== 'string') {
      return j(400, { error: 'answeredWith must be a string' });
    }
    // A question typed where the answer goes is an ASK BACK, not a
    // decision. Recording it as the answer closed the item and left
    // `revise` refusing it ("the answer is to the words it has"), so the
    // only way to keep asking was a duplicate row (Bryan, 2026-08-30:
    // "Why is this important?" stamped as a decision's answer). A
    // person's un-tapped answer that ends asking is routed through the
    // EXISTING more-info shape instead: the question lands as a thread
    // on the item, the item waits on its owner, and the owner's revision
    // re-presents it with the question quoted. A tapped option is an
    // answer whatever its label ends in, and an agent's words never
    // convert — agents answer, people ask.
    if (answeredWith === undefined && classifyActor(author) === 'person' && answerAsksBack(text)) {
      const task = taskStore.getTask(taskId);
      if (!task) return j(404, { error: 'not-found' });
      // The ticket's OWN decision (`r-legacy`) takes this path too —
      // `listReviewItems` derives its row. It used to be recorded
      // through the task-level "tell me more" with no thread, which
      // left the decision on the queue under a question the reader
      // had just asked; now it gets the same thread and the same
      // waiting state as a stored item.
      const item = taskStore.listReviewItems(taskId).find((r) => r.id === reviewItemId);
      // An unknown item falls through to the ordinary answer path below,
      // which owns that refusal. An ANSWERED one is refused here: the
      // fall-through would let `answerTaskReview`'s legal repeat-answer
      // displace the standing answer with a question — a stale form
      // racing another reader's answer would overwrite it with the exact
      // words this conversion exists to keep out of that field (codex
      // review). A question recorded on a closed item would also reach
      // nobody: `reviewItemState` reads `answer` first.
      if (item?.answer !== undefined) {
        return j(409, {
          error: 'answered',
          message:
            'this item is already answered — a question cannot displace the recorded answer; undo the answer first, or ask on the item’s thread',
        });
      }
      if (item) return askBackOnItem(task, item, text, author, Boolean(visitor));
    }
    const res = taskStore.answerTaskReview(taskId, reviewItemId, text, {
      actor: author,
      ...(answeredWith !== undefined ? { answeredWith } : {}),
    });
    if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
    taskProjection.ensureWorkspace(res.task.workspaceId);
    return j(200, res);
  }
  // "Tell me more" on ONE review item — the `request_more_info` tool's
  // door, and deliberately NOT the reader's "I have a question". It
  // records the question with no thread, so `reviewItemState` never
  // reads the item as `waiting` and it stays on the queue: this is the
  // agent-side ask for context, and an agent asking must not take an
  // item off the person's queue. A person's question goes through the
  // threads route (a `review-item` anchor on the task doc), which is
  // what makes the item wait on its owner.
  const taskReviewInfoMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)\/review-items\/([^/]+)\/more-info$/,
  );
  if (taskReviewInfoMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskReviewInfoMatch[1] ?? '');
    const reviewItemId = decodeURIComponent(taskReviewInfoMatch[2] ?? '');
    const body = await safeJson(req);
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    if (question.length === 0) return j(400, { error: 'question required' });
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const res = taskStore.requestMoreInfoOnReview(taskId, reviewItemId, question, {
      actor: author,
    });
    if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
    taskProjection.ensureWorkspace(res.task.workspaceId);
    return j(200, res);
  }
  /**
   * RELEASE a held review item — the reader overruling the gate.
   *
   * The gate is a judge, and a judge can be wrong about one item. Until
   * this route existed the only way off a hold was the filer revising,
   * so a reader looking at a question they could answer in ten seconds
   * had to wait for an agent to reword it (UX review, 2026-08-29).
   *
   * It records an `ok` verdict naming the person, which is the truth of
   * what happened: the item passed, on their authority rather than the
   * judge's. That puts it on the queue by the same rule every passed
   * item reaches it, and it is announced exactly as a filing is —
   * nothing downstream needs to know a person did this.
   *
   * Releasing an item nothing is holding is a no-op success: two taps
   * on a slow connection must not turn into an error the reader has to
   * think about.
   */
  const taskReviewReleaseMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)\/review-items\/([^/]+)\/release$/,
  );
  if (taskReviewReleaseMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskReviewReleaseMatch[1] ?? '');
    const reviewItemId = decodeURIComponent(taskReviewReleaseMatch[2] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const task = taskStore.getTask(taskId);
    if (!task) return j(404, { error: 'not-found' });
    const before = taskStore.listReviewItems(taskId).find((r) => r.id === reviewItemId);
    if (!before) return j(404, { error: 'not-found' });
    if (!isReviewItemGated(before)) {
      return j(200, { taskId, item: before, released: false });
    }
    const overruled = {
      at: Date.now(),
      verdict: 'ok' as const,
      reason: `Released by ${author.name} — the gate was overruled.`,
    };
    // The ticket's OWN decision is releasable too, and unlike a held
    // comment it has a surface to press the button from: the row is on
    // the board, and the held note renders on it. The verdict lands on
    // the task rather than on an item, which is the only difference.
    const res =
      reviewItemId === LEGACY_REVIEW_ITEM_ID
        ? taskStore.recordDecisionJudgement(taskId, overruled, { actor: author })
        : taskStore.recordReviewJudgement(taskId, reviewItemId, overruled, {
            actor: author,
          });
    if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
    taskProjection.ensureWorkspace(res.task.workspaceId);
    announceTaskReview(res.task, res.item, author);
    return j(200, { taskId, item: res.item, released: true });
  }
  // revise_review_item: the owner's answer to a question asked ON the
  // item — the words made clearer in place, the old words kept, and an
  // optional reply on the thread that asked. Refusals happen before
  // any write: a reply with no thread to land on is refused here rather
  // than dropped after the revision applied, because "revised, and the
  // reply went nowhere" is the accepted-and-discarded shape this repo
  // keeps re-shipping.
  const taskReviewReviseMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)\/review-items\/([^/]+)\/revise$/,
  );
  if (taskReviewReviseMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskReviewReviseMatch[1] ?? '');
    const reviewItemId = decodeURIComponent(taskReviewReviseMatch[2] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const task = taskStore.getTask(taskId);
    if (!task) return j(404, { error: 'not-found' });
    const reply = body?.reply;
    if (reply !== undefined && (typeof reply !== 'string' || reply.trim() === '')) {
      return j(400, { error: 'reply must be a non-empty string' });
    }
    const parsedRange = parseRevisedRange(body?.revisedRange);
    if (!parsedRange.ok) return j(400, { error: parsedRange.error });
    const revisedRange = parsedRange.range;
    // The TICKET'S OWN decision. `reviseReviewItem` refuses the derived
    // id — rightly: its words are the task's title, body and options,
    // and there is no stored row to patch. So this door delegates into
    // the store method that rewrites THOSE words through the ordinary
    // title/body doors, exactly as `answerTaskReview` delegates the
    // same id into `answerDecision`. Without it a held decision is a
    // dead end: off the reader's queue, complained about at five
    // minutes, and with no verb its filer can call.
    if (reviewItemId === LEGACY_REVIEW_ITEM_ID) {
      // Refused, never dropped. The ticket's own decision has no item
      // thread of its own to answer on, and forwarding a `reply` this
      // branch does not act on would answer 200 while discarding the
      // one sentence the caller wrote for a person to read — the
      // accepted-and-discarded shape this file refuses everywhere else
      // (codex review).
      if (reply !== undefined) {
        return j(400, {
          error: 'no-thread',
          message:
            "a ticket's own decision has no item thread to reply on — revise it without `reply`, and point at what changed with post_reply on the task",
        });
      }
      const wasHeldDecision = taskStore
        .listReviewItems(taskId)
        .some((r) => r.id === LEGACY_REVIEW_ITEM_ID && isReviewItemHeld(r));
      const revised = taskStore.reviseTaskDecision(
        taskId,
        { headline: body?.headline, detail: body?.detail, options: body?.options },
        {
          actor: author,
          ...(typeof body?.reason === 'string' ? { reason: body.reason } : {}),
        },
      );
      if (!revised.ok) {
        return j(revised.error === 'not-found' ? 404 : 400, revised);
      }
      taskProjection.ensureWorkspace(revised.task.workspaceId);
      // Judged again, on the new words — the promise the hold's message
      // makes. A revision that still misses comes back held.
      const gate = await judgeTaskDecision(revised.task, author);
      if (wasHeldDecision && gate && !gate.held) {
        announceTaskReview(revised.task, gate.item, author);
      }
      return j(200, {
        task: revised.task,
        item: gate?.item ?? revised.item,
        ...heldFields(gate),
      });
    }
    if (reply !== undefined) {
      const item = taskStore.listReviewItems(taskId).find((r) => r.id === reviewItemId);
      if (item && !latestThreadedQuestion(item)?.threadId) {
        return j(400, {
          error: 'no-thread',
          message:
            'nobody has asked on this item, so there is no thread for the reply — revise without `reply`, or post_reply on the thread you mean',
        });
      }
    }
    // Whether the gate was holding it BEFORE this revision — a hold
    // that clears is the moment the item first reaches the queue, and
    // that is announced exactly as a fresh filing would be.
    const before = taskStore.listReviewItems(taskId).find((r) => r.id === reviewItemId);
    const wasHeld = before !== undefined && isReviewItemHeld(before);
    const res = taskStore.reviseReviewItem(
      taskId,
      reviewItemId,
      { headline: body?.headline, detail: body?.detail, options: body?.options },
      { actor: author, ...(revisedRange ? { revisedRange } : {}) },
    );
    if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
    taskProjection.ensureWorkspace(res.task.workspaceId);
    // Re-judged on every revision: the verdict was about the old words.
    const gate = await judgeReviewItem(res.task, res.item, author);
    if (wasHeld && !gate.held) announceTaskReview(res.task, gate.item, author);
    let thread: Thread | null = null;
    if (reply !== undefined && res.threadId) {
      const docId = taskProjection.ensureBodyRoom(res.task);
      thread = await rooms.postComment(docId, res.threadId, author, reply, undefined, {
        generate: !visitor,
      });
    }
    return j(200, {
      task: res.task,
      item: gate.item,
      ...(res.threadId !== undefined ? { threadId: res.threadId } : {}),
      ...(thread ? { thread } : {}),
      ...(res.advice !== undefined ? { reviewAdvice: res.advice } : {}),
      ...heldFields(gate),
    });
  }
  // Taking a TICKET-borne ask back — the same exit the doc-thread
  // withdraw route has had, for the surface that lacked it: an item
  // filed with add_review_item had no way off the reader's queue short
  // of revising it into something else, which is a lie about what was
  // asked. Same contract as the doc route: the words stay on the ticket
  // verbatim, marked withdrawn with the reason beside them; refused on
  // an answered item (409 — the state, not the request, is what's
  // wrong); `/undo` puts the ask back in front of the reader.
  const taskReviewWithdrawMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)\/review-items\/([^/]+)\/withdraw(\/undo)?$/,
  );
  if (taskReviewWithdrawMatch && req.method === 'POST') {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    const taskId = decodeURIComponent(taskReviewWithdrawMatch[1] ?? '');
    const reviewItemId = decodeURIComponent(taskReviewWithdrawMatch[2] ?? '');
    const undo = taskReviewWithdrawMatch[3] !== undefined;
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    if (isCategoryAuthor(author)) return refuseCategoryAuthor();
    const reason = body?.reason;
    if (reason !== undefined && typeof reason !== 'string') {
      return j(400, { error: 'reason must be a string' });
    }
    const res = taskStore.withdrawReviewItem(taskId, reviewItemId, {
      actor: author,
      ...(reason !== undefined ? { reason } : {}),
      ...(undo ? { undo: true } : {}),
    });
    if (!res.ok) {
      const status =
        res.error === 'not-found' || res.error === 'unknown-review-item'
          ? 404
          : res.error === 'answered'
            ? 409
            : 400;
      return j(status, {
        error: res.error,
        ...(res.message !== undefined ? { message: res.message } : {}),
      });
    }
    taskProjection.ensureWorkspace(res.task.workspaceId);
    // Announced on the way BACK only, exactly as the doc route reasons:
    // a withdrawal must not buzz the reader with the ask just taken off
    // their queue, and a reinstated item still held by the gate is on
    // nobody's queue yet.
    if (undo && !isReviewItemHeld(res.item)) {
      announceTaskReview(res.task, res.item, author);
    }
    return j(200, { taskId, reviewItemId, item: res.item, withdrawn: !undo });
  }
  return undefined;
}
