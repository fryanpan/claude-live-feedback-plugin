/**
 * The board's task list and the single-row create.
 *
 * Lifted verbatim out of `createServer`'s request closure; the handlers
 * read their collaborators off `TaskRoutesContext` instead of the scope.
 */
import { createdVisibility, parseTaskCreate } from '../task-create.ts';
import { placeableGoals } from '../task-queue.ts';
import { type TaskStatus, isRetired, retiredRefusal } from '../tasks.ts';
import type { ReviewGate, TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleTaskListCreate(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const {
    taskStore,
    taskProjection,
    readyNudger,
    j,
    safeJson,
    ANONYMOUS_ACTOR,
    announceTaskReview,
    heldFields,
    judgeReviewItem,
    judgeTaskDecision,
    mergedHold,
  } = ctx;
  const { req, pathname, url, authorFor } = rq;
  const wsTasksMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/tasks$/);
  if (wsTasksMatch && req.method === 'GET') {
    const workspaceId = decodeURIComponent(wsTasksMatch[1] ?? '');
    if (!taskStore.getWorkspace(workspaceId)) {
      return j(404, { error: 'workspace not found' });
    }
    const status = url.searchParams.get('status') as TaskStatus | null;
    const tasks = taskStore.listTasks(workspaceId, {
      ...(status ? { status } : {}),
      ...(url.searchParams.get('goal') ? { goal: url.searchParams.get('goal') ?? '' } : {}),
      ...(url.searchParams.get('assignee')
        ? { assignee: url.searchParams.get('assignee') ?? '' }
        : {}),
      ...(url.searchParams.get('needs')
        ? { needs: url.searchParams.get('needs') as 'action' | 'decision' }
        : {}),
      // ADDITIVE, and the default is the narrowing: a caller built
      // before archiving existed keeps getting the rows it always got,
      // minus the ones somebody has since removed. That is the safe
      // direction — the failure it cannot produce is an old bundle
      // resurrecting a task its user archived.
      includeArchived: url.searchParams.get('includeArchived') === 'true',
    });
    // The kind the BOARD resolves, not just the one somebody declared.
    // An agent has no other way to ask "which of my rows read as an
    // unrecorded owner" — the resolved value lives in a ydoc it cannot
    // read, and the two answers differ exactly where it matters (an
    // undeclared row whose owner is an attached agent reads `agent`).
    const ownerKindOf = taskProjection.ownerKindReader(workspaceId);
    // And WHICH session that owner is, when one can be named. The kind
    // above says a row belongs to an agent; this says whether that
    // agent is still there, which is the difference between "somebody
    // owns this" and "somebody is on this". Absent when no attachment
    // vouches for the owner — a person, or an owner too generic to
    // resolve to one session.
    const ownerSessionOf = taskProjection.ownerSessionReader(workspaceId);
    return j(200, {
      workspaceId,
      tasks: tasks.map((t) => {
        const session = ownerSessionOf(t);
        return {
          ...t,
          ownerKind: ownerKindOf(t),
          ...(session !== undefined ? { ownerSession: session } : {}),
        };
      }),
    });
  }
  if (wsTasksMatch && req.method === 'POST') {
    const workspaceId = decodeURIComponent(wsTasksMatch[1] ?? '');
    const body = await safeJson(req);
    // An unknown workspace is a 404 before anything about the task is
    // judged — otherwise a typo'd id comes back as a complaint about
    // the body, and the caller fixes the wrong thing.
    const targetBoard = taskStore.getWorkspace(workspaceId);
    if (!targetBoard) {
      return j(404, { error: 'workspace-not-found' });
    }
    // A retired board takes no new work, and it says so about the BOARD
    // rather than about the body — a caller told its title is fine and
    // its goal is unknown fixes the wrong thing. `createTask` refuses
    // this too (it is the choke point every filing path runs through);
    // answering here is what turns N identical row failures into one
    // sentence a caller can act on.
    if (isRetired(targetBoard)) {
      return j(409, { error: 'workspace-retired', message: retiredRefusal(targetBoard) });
    }
    // A row SPUN OFF A DOC — the pointer pill's Create Task — asks to
    // be placed: the board's top active goal, the lead as owner, and
    // `todo` after the create, so the lead's dispatch sees it. See
    // `TaskStore.placeSpinoff` for the rule and the report behind it.
    // An explicit goal or assignee in the same body still wins. The
    // origin doc is what lets the rule find the task the doc belongs
    // to — a row spun off a huddle started FOR a task joins that task's
    // band.
    const originRef = body?.origin as { kind?: unknown; docId?: unknown } | undefined;
    const spinoffDocId =
      originRef?.kind === 'doc' && typeof originRef.docId === 'string'
        ? originRef.docId
        : undefined;
    const spinoff =
      body?.spinoff === true
        ? taskStore.placeSpinoff(workspaceId, { docId: spinoffDocId })
        : undefined;
    const createBody =
      spinoff === undefined
        ? body
        : {
            ...body,
            goal: typeof body?.goal === 'string' ? body.goal : spinoff.goal,
            ...(spinoff.leadAgentId !== undefined && body?.assignee === undefined
              ? { assignToLead: true }
              : {}),
          };
    // One reading of a create body, shared with the batch route below.
    const parsed = parseTaskCreate(createBody, authorFor(body?.author), targetBoard);
    if (!parsed.ok) {
      return j(400, {
        error: parsed.error,
        ...(parsed.message !== undefined ? { message: parsed.message } : {}),
      });
    }
    const res = taskStore.createTask(workspaceId, parsed.opts);
    if (!res.ok) return j(res.error === 'workspace-not-found' ? 404 : 400, res);
    if (spinoff !== undefined && !parsed.opts.fileToTriage && res.task.status !== 'todo') {
      const moved = taskStore.transition(res.task.id, 'todo', {
        actor: authorFor(body?.author) ?? ANONYMOUS_ACTOR,
        note: 'Spun off a doc line; placed on the board and queued for dispatch.',
      });
      if (moved.ok) res.task = moved.task as typeof res.task;
    }
    if (spinoff !== undefined && res.task.status === 'todo' && spinoff.leadAgentId) {
      // The same immediate addressed wake an actionable spoken request
      // gets — the row is the lead's now, and the lead should hear so.
      readyNudger.taskReady({ workspaceId, taskId: res.task.id, taskTitle: res.task.title });
    }
    // The review item the body filed WITH the ticket, now that the
    // ticket has an id. `parseTaskCreate` already put the payload
    // through the same `checkReviewPayload` the store runs, so a
    // refusal here is unreachable and the ticket cannot land holding a
    // question the caller was told was rejected.
    let gate: ReviewGate | undefined;
    // The ticket that IS the decision. Judged here, before the response
    // is written, for the same reason a `review` payload is: this row
    // reaches the reader's queue as the derived `r-legacy` item, so a
    // 200 that says nothing about a hold reads as "it is in front of
    // them" for a row the queue omits.
    let decisionGate: ReviewGate | undefined;
    if (res.task.needs === 'decision') {
      decisionGate = await judgeTaskDecision(res.task, authorFor(body?.author) ?? ANONYMOUS_ACTOR);
      if (decisionGate?.held) taskProjection.ensureWorkspace(workspaceId);
    }
    if (parsed.review !== undefined) {
      const actor = authorFor(body?.author) ?? ANONYMOUS_ACTOR;
      const added = taskStore.addReviewItem(res.task.id, parsed.review, { actor });
      if (added.ok) {
        gate = await judgeReviewItem(added.task, added.item, actor);
        if (!gate.held) announceTaskReview(added.task, added.item, actor);
      }
      // `createTask` already emitted `task.created` — and therefore
      // already projected this ticket, a moment before it had any
      // review items. `addReviewItem` emits nothing, so without this the
      // board room carries the ticket with no `reviews` until some
      // unrelated store event happens to touch the workspace, which on a
      // quiet board is never. Same call the dedicated review-item route
      // makes for the same reason.
      taskProjection.ensureWorkspace(workspaceId);
    }
    // Dropped refs are reported, never swallowed: the caller finds out
    // what didn't survive without having to diff what it sent. Same
    // reasoning for `shapeGaps` — the decision WAS created and the
    // caller still learns which parts of the shape are missing.
    return j(200, {
      task: res.task,
      // What happened to the placement, and — only when nobody judged
      // it — the bands it could have been ranked into. The caller that
      // just generated this work is the one party that still knows why
      // it exists; handing it `goal: "chores"` and nothing else is what
      // let agent-generated work drift out of the goal structure.
      placement: {
        ...res.placement,
        ...(res.placement.placed
          ? {}
          : { goals: placeableGoals(taskStore.getWorkspace(workspaceId)?.goals ?? []) }),
        // Which spin-off rule chose the band, for the caller's toast
        // and the PR reader alike: `top-active-goal` or `chores`.
        ...(spinoff !== undefined ? { spinoff: spinoff.rule } : {}),
        ...(spinoff?.taskId !== undefined ? { spinoffTask: spinoff.taskId } : {}),
      },
      ...(parsed.ignoredLinks.length > 0 ? { ignoredLinks: parsed.ignoredLinks } : {}),
      ...(res.shapeGaps !== undefined ? { shapeGaps: res.shapeGaps } : {}),
      ...(parsed.reviewAdvice !== undefined ? { reviewAdvice: parsed.reviewAdvice } : {}),
      ...heldFields(mergedHold(gate, decisionGate)),
      // The row's ACTUAL visibility, stated plainly — `placed` above
      // answers goal placement, not whether any dispatch read returns
      // the row or where a filed ask went. See `createdVisibility`.
      ...(() => {
        const note = createdVisibility(res.task.status, parsed.review !== undefined);
        return note !== undefined ? { visibility: note } : {};
      })(),
    });
  }
  return undefined;
}
