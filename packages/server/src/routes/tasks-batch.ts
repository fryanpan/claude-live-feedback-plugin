import { type TaskReviewItem, type User } from '@feedback/core';
/**
 * Batch capture: a burst of rows in one call, each landing owned and placed.
 *
 * Lifted verbatim out of `createServer`'s request closure; the handlers
 * read their collaborators off `TaskRoutesContext` instead of the scope.
 */
import { indexBatchKeys, resolveRowRefs } from '../task-batch-refs.ts';
import { createdVisibility, parseTaskCreate } from '../task-create.ts';
import { placeableGoals } from '../task-queue.ts';
import { LEGACY_REVIEW_ITEM_ID, type Task, isRetired, retiredRefusal } from '../tasks.ts';
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

/** Rows one `POST /tasks/batch` will take. A burst out of a conversation is
 *  single digits; a hundred is a tracker, and that has its own import path. */
const MAX_BATCH_TASKS = 100;

/** How many review items one batch puts in front of the judge at a time.
 *  The judge is a network call with an 8s timeout, so awaiting a hundred of
 *  them one after the next is a request that can run for thirteen minutes
 *  (codex review). Eight at a time keeps a dead judge's worst case near a
 *  hundred seconds without opening a hundred sockets at a live one. */
const JUDGE_BATCH_CONCURRENCY = 8;

/**
 * Run `fn` over `rows` at most `limit` at a time, answering in ROW ORDER.
 * Order is the point: a batch reports its holds per row, and a caller
 * matching them back to what it sent should not have to sort.
 */
async function mapBounded<T, R>(
  rows: readonly T[],
  limit: number,
  fn: (row: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(rows.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, rows.length) }, async () => {
    for (let i = next++; i < rows.length; i = next++) {
      out[i] = await fn(rows[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleTaskBatch(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const {
    taskStore,
    taskProjection,
    docStore,
    j,
    safeJson,
    ANONYMOUS_ACTOR,
    announceTaskReview,
    judgeReviewItem,
    judgeTaskDecision,
  } = ctx;
  const { req, pathname, authorFor } = rq;
  /**
   * Batch capture: a burst of ideas in ONE call, each landing owned and
   * placed, and the whole thing coming back in board order so the caller
   * can see the ranking it just produced without a second read.
   *
   * PER-ITEM failure, deliberately. An all-or-nothing batch turns one
   * typo into "which of these eight already landed?", and the answer to
   * that question is a read the caller shouldn't have to do — so a bad
   * row is reported by index and its neighbours still land. The two
   * whole-call refusals left are the ones where nothing could have
   * landed anyway: an unknown workspace, and a body with no rows in it.
   */
  const wsTasksBatchMatch = pathname.match(/^\/workspaces\/([^/]+)\/tasks\/batch$/);
  if (wsTasksBatchMatch && req.method === 'POST') {
    const workspaceId = decodeURIComponent(wsTasksBatchMatch[1] ?? '');
    const body = await safeJson(req);
    const batchBoard = taskStore.getWorkspace(workspaceId);
    if (!batchBoard) {
      return j(404, { error: 'workspace-not-found' });
    }
    // Whole-batch, before any row is read: on a retired board every row
    // fails for the same reason, and a hundred copies of one sentence
    // is not a better answer than the sentence.
    if (isRetired(batchBoard)) {
      return j(409, { error: 'workspace-retired', message: retiredRefusal(batchBoard) });
    }
    const rows = body?.tasks;
    if (!Array.isArray(rows) || rows.length === 0) {
      return j(400, { error: 'tasks must be a non-empty array of task bodies' });
    }
    // Refused, never truncated. A capture tool that silently keeps the
    // first N reports success for rows that don't exist, and the caller
    // has no way to know which — the failure this whole route is shaped
    // to avoid. The number is a burst-sized ceiling, not a capacity
    // limit: a batch this large is a tracker, and import_tasks_markdown
    // is the surface for one.
    if (rows.length > MAX_BATCH_TASKS) {
      return j(400, {
        error: 'too-many-tasks',
        message: `a batch takes at most ${MAX_BATCH_TASKS} rows; this one had ${rows.length}. Nothing was created — split it, or use import_tasks_markdown for a whole tracker.`,
      });
    }
    // The batch's provenance, declared ONCE for every row: tasks
    // derived from a doc carry a structured origin ref without the
    // caller repeating it per row (or remembering a second link call),
    // and a PLAN doc's rows are filed as drafts — held in triage until
    // the plan is approved. `mode` defaults from what the doc says it
    // is: a huddle is a conversation whose tasks may start at once, an
    // ordinary doc being turned into tasks is a plan.
    const sourceDocRaw = body?.sourceDoc as { docId?: unknown; mode?: unknown } | null | undefined;
    let sourceDoc: { docId: string; mode: 'plan' | 'discussion'; hold: boolean } | undefined;
    if (sourceDocRaw !== undefined && sourceDocRaw !== null) {
      const sdId = sourceDocRaw.docId;
      const sdMode = sourceDocRaw.mode;
      if (typeof sdId !== 'string' || sdId.length === 0) {
        return j(400, { error: 'bad-source-doc', message: 'sourceDoc.docId is required' });
      }
      if (sdMode !== undefined && sdMode !== 'plan' && sdMode !== 'discussion') {
        return j(400, {
          error: 'bad-source-doc',
          message: "sourceDoc.mode must be 'plan' or 'discussion'",
        });
      }
      // Unlike a bare `links` ref, the source doc must EXIST: its plan
      // state decides whether these rows are drafts, and a gate read
      // off a doc that isn't there would answer with a shrug.
      const sourceLiveDoc = docStore.get(sdId);
      if (!sourceLiveDoc) {
        return j(404, { error: 'source-doc-not-found', docId: sdId });
      }
      const mode = sdMode ?? (sourceLiveDoc.meta.huddle === true ? 'discussion' : 'plan');
      const hold = mode === 'plan' && sourceLiveDoc.meta.planState !== 'approved';
      // Filing plan drafts is what DECLARES the doc a pending plan —
      // one call, no separate "mark this a plan" step. An approved
      // plan stays approved: later rows ride in ungated.
      if (hold && sourceLiveDoc.meta.planState === undefined) {
        docStore.setPlanState(sourceLiveDoc.docId, 'pending');
      }
      sourceDoc = { docId: sourceLiveDoc.docId, mode, hold };
    }
    const createdBy = authorFor(body?.author);
    const createdIds = new Set<string>();
    const failures: Array<{
      index: number;
      title?: string;
      error: string;
      message?: string;
    }> = [];
    const ignoredLinks: Array<{ taskId: string; ignored: unknown[] }> = [];
    const shapeGaps: Array<{ taskId: string; gaps: unknown[] }> = [];
    /** Per row, because a burst files many tickets and "which one came
     *  out thin" is the only useful form of the answer. */
    const reviewAdvice: Array<{ taskId: string; advice: string }> = [];
    /** Rows whose filed review the gate held — the filer reads this
     *  the way it reads `reviewAdvice`: per row, by task id. */
    const heldReviews: Array<{
      taskId: string;
      reviewItemId: string;
      heldReason: string;
      message: string;
    }> = [];
    /** The review items this batch filed, waiting on the quality gate.
     *  They are judged together after the creation loop rather than one
     *  per row inside it: the judge is a network call, and in series a
     *  hundred rows against a degraded judge held the request for
     *  thirteen minutes (codex review). Nothing is lost by waiting —
     *  each item is stamped `pending`, and so off the reader's queue,
     *  the moment its call goes out. */
    const toJudge: Array<{
      task: Task;
      item: TaskReviewItem;
      actor: User;
    }> = [];
    /** The rows that ARE decisions — judged in the same bounded pass,
     *  because a decision ticket reaches the reader's queue through its
     *  derived `r-legacy` row and so must clear the same gate as a
     *  question filed on a ticket. */
    const decisionsToJudge: Array<{ task: Task; actor: User }> = [];
    /** Each row's actual visibility, stated plainly — a triage row is
     *  returned by no dispatch read, and a filed review item is on the
     *  addressee's Home queue regardless. See `createdVisibility`. */
    const visibility: Array<{ taskId: string; note: string }> = [];
    /** Did any row attach a review item? The projection refresh those
     *  need happens once after the loop; see below. */
    let attachedReview = false;
    // Placement, collected per row and reported ONCE. Per-row it would
    // repeat the same band list a hundred times in a hundred-row burst;
    // the rows that need naming are the unplaced ones, so those are what
    // it names.
    const unplaced: string[] = [];
    // Batch-local dependency references. Keys are read once, up front,
    // so an ambiguous one is refused where it is DECLARED rather than
    // at every site that reads it; `idByIndex` fills in as rows land,
    // which is what lets a row that depends on a FAILED row fail too
    // instead of being created with the edge silently dropped.
    const { keyToIndex, keyErrors } = indexBatchKeys(rows);
    const idByIndex = new Map<number, string>();
    const refCtx = { keyToIndex, idByIndex, rowCount: rows.length };
    for (const [index, row] of rows.entries()) {
      // One caller, one identity: every row is attributed to whoever
      // sent the batch. A row naming its own author would be a second
      // way to spell attribution with no caller asking for it — and
      // `assignee` already answers the question people actually have,
      // which is who OWNS the row rather than who typed it.
      const title = (row as { title?: unknown } | null)?.title;
      const named = typeof title === 'string' ? { title } : {};
      const keyError = keyErrors.get(index);
      if (keyError) {
        failures.push({ index, ...named, ...keyError });
        continue;
      }
      const refs = resolveRowRefs(row, index, refCtx);
      if (!refs.ok) {
        failures.push({ index, ...named, error: refs.error, message: refs.message });
        continue;
      }
      // Hand the parser a row whose references are already real ids —
      // so the store's `unknown-after` gate and every rule downstream
      // of it are unchanged by this feature.
      const resolvedRow =
        refs.after === undefined && refs.afterEnforce === undefined
          ? row
          : {
              ...(row as Record<string, unknown>),
              ...(refs.after !== undefined ? { after: refs.after } : {}),
              ...(refs.afterEnforce !== undefined ? { afterEnforce: refs.afterEnforce } : {}),
            };
      const parsed = parseTaskCreate(resolvedRow, createdBy, batchBoard);
      if (!parsed.ok) {
        failures.push({
          index,
          ...named,
          error: parsed.error,
          ...(parsed.message !== undefined ? { message: parsed.message } : {}),
        });
        continue;
      }
      if (sourceDoc !== undefined) {
        // The batch-level declaration fans onto every row: a doc origin
        // where the row named none (a row's own origin — a promoted
        // thread's, say — outranks the batch default), and the draft
        // hold when the plan gate is pending.
        if (parsed.opts.origin === undefined) {
          parsed.opts.origin = { kind: 'doc', docId: sourceDoc.docId };
        }
        if (sourceDoc.hold) parsed.opts.planHold = { docId: sourceDoc.docId };
      }
      const res = taskStore.createTask(workspaceId, parsed.opts);
      if (!res.ok) {
        failures.push({
          index,
          ...named,
          error: res.error,
          ...(res.message !== undefined ? { message: res.message } : {}),
        });
        continue;
      }
      // Same as the single-create door, and NOT optional: both routes
      // read one body through `parseTaskCreate`, so a `review` honoured
      // by one and dropped by the other is the "accepted it, returned
      // 200, discarded it" bug this file's header is about.
      if (parsed.review !== undefined) {
        const actor = createdBy ?? ANONYMOUS_ACTOR;
        const added = taskStore.addReviewItem(res.task.id, parsed.review, { actor });
        // Filed now, judged after the loop — see `toJudge`. The item is
        // in the store from this line, and off the reader's queue from
        // it too: `judgeReviewItem` stamps `pending` before it asks, so
        // nothing here depends on the verdict landing before the next
        // row is created.
        if (added.ok) toJudge.push({ task: added.task, item: added.item, actor });
        attachedReview = true;
      }
      if (res.task.needs === 'decision') {
        decisionsToJudge.push({ task: res.task, actor: createdBy ?? ANONYMOUS_ACTOR });
      }
      if (parsed.reviewAdvice !== undefined) {
        reviewAdvice.push({ taskId: res.task.id, advice: parsed.reviewAdvice });
      }
      {
        const note = createdVisibility(
          res.task.status,
          parsed.review !== undefined,
          res.task.planHold !== undefined,
        );
        if (note !== undefined) visibility.push({ taskId: res.task.id, note });
      }
      createdIds.add(res.task.id);
      idByIndex.set(index, res.task.id);
      if (!res.placement.placed) unplaced.push(res.task.id);
      if (parsed.ignoredLinks.length > 0) {
        ignoredLinks.push({ taskId: res.task.id, ignored: parsed.ignoredLinks });
      }
      if (res.shapeGaps !== undefined) {
        shapeGaps.push({ taskId: res.task.id, gaps: res.shapeGaps });
      }
    }
    // The gate, for every review this batch filed — side by side, a
    // bounded few at a time, and answered in row order so the holds
    // this route reports still line up with the rows that sent them.
    if (toJudge.length > 0) {
      const gates = await mapBounded(toJudge, JUDGE_BATCH_CONCURRENCY, (row) =>
        judgeReviewItem(row.task, row.item, row.actor),
      );
      for (let i = 0; i < toJudge.length; i++) {
        const row = toJudge[i];
        const gate = gates[i];
        if (!row || !gate) continue;
        if (gate.held) {
          heldReviews.push({
            taskId: row.task.id,
            reviewItemId: row.item.id,
            heldReason: gate.reason,
            message: gate.message,
          });
        } else announceTaskReview(row.task, row.item, row.actor);
      }
    }
    // The decision rows, the same way. Reported under the derived id,
    // which is what tells the caller to address the fix at the TICKET
    // — `revise_review_item(taskId=…)` — rather than at an item id no
    // ticket carries. Nothing is announced for a decision: a decision
    // ticket announces itself through `task.created`.
    if (decisionsToJudge.length > 0) {
      const gates = await mapBounded(decisionsToJudge, JUDGE_BATCH_CONCURRENCY, (row) =>
        judgeTaskDecision(row.task, row.actor),
      );
      for (let i = 0; i < decisionsToJudge.length; i++) {
        const row = decisionsToJudge[i];
        const gate = gates[i];
        if (!row || !gate?.held) continue;
        heldReviews.push({
          taskId: row.task.id,
          reviewItemId: LEGACY_REVIEW_ITEM_ID,
          heldReason: gate.reason,
          message: gate.message,
        });
      }
      taskProjection.ensureWorkspace(workspaceId);
    }
    // Once, after the loop rather than inside it — see the single-create
    // door for why any of it is needed. The row that actually needs it
    // is the LAST one carrying a review: every earlier one was projected
    // incidentally by the NEXT row's `task.created`, which is why a
    // one-row batch and the tail of an n-row batch were the only shapes
    // that showed the miss.
    if (attachedReview) taskProjection.ensureWorkspace(workspaceId);
    // Board order comes from the board, not from a second sort of our
    // own that happens to agree with it today.
    const tasks = taskStore.listTasks(workspaceId).filter((t) => createdIds.has(t.id));
    return j(200, {
      workspaceId,
      tasks,
      failures,
      // Absent when every row was placed — there is nothing to act on,
      // and a block that is always there is a block nobody reads.
      ...(unplaced.length > 0
        ? {
            placement: {
              unplaced,
              goals: placeableGoals(taskStore.getWorkspace(workspaceId)?.goals ?? []),
            },
          }
        : {}),
      ...(ignoredLinks.length > 0 ? { ignoredLinks } : {}),
      ...(shapeGaps.length > 0 ? { shapeGaps } : {}),
      ...(reviewAdvice.length > 0 ? { reviewAdvice } : {}),
      ...(heldReviews.length > 0 ? { held: heldReviews } : {}),
      // Absent when every row is ordinarily visible — a note that is
      // always there is a note nobody reads.
      ...(visibility.length > 0 ? { visibility } : {}),
      // What the batch's provenance came out as: the canonical docId
      // the rows now cite, the mode after defaulting, and whether the
      // plan gate held the rows as drafts.
      ...(sourceDoc !== undefined
        ? {
            sourceDoc: { docId: sourceDoc.docId, mode: sourceDoc.mode, held: sourceDoc.hold },
          }
        : {}),
    });
  }
  return undefined;
}
