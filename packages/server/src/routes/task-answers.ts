import { answerAsksBack } from '@feedback/core';
/**
 * The ticket's own decision: recording an answer, undoing one, asking back.
 *
 * Lifted verbatim out of `createServer`'s request closure; the handlers
 * read their collaborators off `TaskRoutesContext` instead of the scope.
 */
import { classifyActor } from '../actor-identity.ts';
import { matchRest } from '../middleware/workspace-scope.ts';
import { legacyDecisionItem } from '../tasks.ts';
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleTaskAnswers(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const { taskStore, j, safeJson, askBackOnItem } = ctx;
  const { req, scope, visitor, authorFor } = rq;
  // answer_decision (§3.10): record the VERBATIM answer. Does not
  // transition the task — status changes stay with the single gate.
  const taskAnswerMatch = matchRest(scope, /^tasks\/([^/]+)\/answer$/);
  if (taskAnswerMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskAnswerMatch[1] ?? '');
    const body = await safeJson(req);
    const text = body?.text;
    if (typeof text !== 'string' || text.length === 0) {
      return j(400, { error: 'text required' });
    }
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    // `optionId` says which candidate the words came from. The words are
    // still the answer — an option is a shortcut to typing them, so this
    // route deliberately does NOT look the label up and substitute it.
    const optionId = body?.optionId;
    if (optionId !== undefined && typeof optionId !== 'string') {
      return j(400, { error: 'optionId must be a string' });
    }
    // A person's question typed where the answer goes converts to the
    // "Tell me more" this task already carries — the decision stays open
    // instead of closing under a question it cannot answer. Same rule as
    // the review-item answer route below; a tapped option still answers,
    // and an agent's words never convert. Old payloads are accepted
    // unchanged — nothing new is refused, one reading is rerouted.
    if (optionId === undefined && classifyActor(author) === 'person' && answerAsksBack(text)) {
      // A stale form racing a recorded answer: the derived item is
      // already 'answered', which outranks the request this would
      // record — the question would be invisible. Refuse it, same as
      // the review-item route below.
      const task = taskStore.getTask(taskId);
      if (task?.answer !== undefined) {
        return j(409, {
          error: 'answered',
          message:
            'this decision is already answered — a question cannot displace the recorded answer; undo the answer first, or ask on the task',
        });
      }
      // The SAME ask a question on a review item makes: a thread on the
      // task doc anchored to the derived `r-legacy` row, recorded with
      // its thread — so the decision leaves the reader's queue and comes
      // back Revised, whichever box the question was typed into. Until
      // 2026-08-31 this recorded a threadless "tell me more" and the
      // card stayed put under the question, while the same words typed
      // on a stored item's card sent it away: two identical cards, two
      // behaviours. A non-decision task (nothing derived) keeps the old
      // record, which `requestMoreInfo` refuses as `not-a-decision`.
      const decision = task ? legacyDecisionItem(task) : undefined;
      if (task && decision) {
        return askBackOnItem(task, decision, text, author, Boolean(visitor));
      }
      const asked = taskStore.requestMoreInfo(taskId, text, { actor: author });
      if (!asked.ok) return j(asked.error === 'not-found' ? 404 : 400, asked);
      return j(200, { asked: true, task: asked.task });
    }
    const res = taskStore.answerDecision(taskId, text, {
      actor: author,
      ...(optionId !== undefined ? { optionId } : {}),
    });
    if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
    return j(200, res);
  }
  // Undo. Answering is a single click with no confirmation, so there has
  // to be a way back — and the way back is a SOFT delete: the store moves
  // the answer to `answerHistory` rather than dropping it, and the
  // decision goes back to open. Matched BEFORE `/answer` would be a
  // mistake either way (that pattern is anchored), but it is written
  // first so the pair reads together.
  const taskAnswerUndoMatch = matchRest(scope, /^tasks\/([^/]+)\/answer\/undo$/);
  if (taskAnswerUndoMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskAnswerUndoMatch[1] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const res = taskStore.withdrawAnswer(taskId, { actor: author });
    if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
    return j(200, res);
  }
  // "Tell me more" — a question asked back at a decision INSTEAD of
  // answering it. Keeps the options from being a closed set: the row
  // stays open, stays counted, and the attached agent owes context.
  const taskMoreInfoMatch = matchRest(scope, /^tasks\/([^/]+)\/more-info$/);
  if (taskMoreInfoMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskMoreInfoMatch[1] ?? '');
    const body = await safeJson(req);
    const question = typeof body?.question === 'string' ? body.question.trim() : '';
    if (question.length === 0) return j(400, { error: 'question required' });
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const res = taskStore.requestMoreInfo(taskId, question, { actor: author });
    if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
    return j(200, res);
  }
  return undefined;
}
