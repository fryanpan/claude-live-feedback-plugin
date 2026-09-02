/**
 * The fields of a row that are edited one at a time, plus its soft delete.
 *
 * Lifted verbatim out of `createServer`'s request closure; the handlers
 * read their collaborators off `TaskRoutesContext` instead of the scope.
 */
import { parkNoteText } from '../park-note.ts';
import {
  ASSIGNEE_REQUIRED_ERROR,
  ASSIGNEE_REQUIRED_HANDOVER_MESSAGE,
  BAD_ASSIGNEE_KIND_ERROR,
  BAD_ASSIGNEE_KIND_MESSAGE,
  parseAssigneeKind,
  resolveAssignee,
} from '../task-owner.ts';
import { taskBodyDocId } from '../task-projection.ts';
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleTaskFields(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const { taskStore, taskProjection, rooms, j, safeJson, regateDecisionWords, rewriteTaskBody } =
    ctx;
  const { req, pathname, authorFor } = rq;
  // set_task_dependencies: edit `after` / `afterEnforce` on a task that
  // already exists. Until this route, `after` could only be set at
  // creation — so a decision filed after the work it gates could never
  // be wired to it, every decision on a real board had an empty `after`,
  // and "is this blocking anything" was underivable. Replaces the whole
  // edge set (an edge has to be removable), and emits no store event, so
  // the projection is refreshed by hand — the renameTask contract.
  const taskAfterMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/after$/);
  if (taskAfterMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskAfterMatch[1] ?? '');
    const body = await safeJson(req);
    if (!Array.isArray(body?.after)) return j(400, { error: 'after must be an array' });
    if (body?.afterEnforce !== undefined && !Array.isArray(body.afterEnforce)) {
      return j(400, { error: 'afterEnforce must be an array' });
    }
    for (const id of [...body.after, ...((body.afterEnforce as unknown[]) ?? [])]) {
      if (typeof id !== 'string') return j(400, { error: 'task ids must be strings' });
    }
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const res = taskStore.setDependencies(
      taskId,
      {
        after: body.after as string[],
        ...(body.afterEnforce !== undefined ? { afterEnforce: body.afterEnforce as string[] } : {}),
      },
      { actor: author },
    );
    if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
    taskProjection.ensureWorkspace(res.task.workspaceId);
    return j(200, res);
  }
  // In-place task title edit (§3.9: tap the title, Enter commits) —
  // and rewrite_task's title-only path. Emits an attributed
  // task.retitled when the title actually moves; the hand refresh
  // below stays because a no-op rename ("changed: false") emits
  // nothing. `reason` is optional and rides the audit row verbatim.
  const taskTitleMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/title$/);
  if (taskTitleMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskTitleMatch[1] ?? '');
    const body = await safeJson(req);
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (title.length === 0) return j(400, { error: 'title required' });
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    const res = taskStore.renameTask(taskId, title, {
      actor: author,
      ...(reason ? { reason } : {}),
    });
    if (!res.ok) return j(404, res);
    taskProjection.ensureWorkspace(res.task.workspaceId);
    // A decision ticket's headline just moved — see `regateDecisionWords`.
    if (res.changed) await regateDecisionWords(taskId, author);
    return j(200, res);
  }
  // update_task_body: replace a task's description after creation.
  // The body is a live `task:<id>` doc room, so this goes THROUGH that
  // room rather than at the store's snapshot field — a block-level
  // diff, so comment threads on paragraphs the rewrite didn't touch
  // keep their anchors, and anyone reading the task on the board sees
  // it change under them. Three things the doc route alone can't do,
  // and each of them looks like "the rewrite failed" from outside:
  // create the room on a workspace this process hasn't served yet,
  // flush the snapshot the board and next_tasks read, and put an
  // attributed row in the audit log.
  const taskBodyMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/body$/);
  if (taskBodyMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskBodyMatch[1] ?? '');
    const body = await safeJson(req);
    const markdown = typeof body?.markdown === 'string' ? body.markdown : '';
    // Optional: shaping retitles and rewrites in ONE act, so a clipped
    // capture title is not left behind by the pass that fixed its body.
    // A blank string is "no new title", never a request to blank one.
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const task = taskStore.getTask(taskId);
    if (!task) return j(404, { ok: false, error: 'not-found' });
    if (!markdown.trim()) return j(400, { ok: false, error: 'empty' });
    const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
    const res = rewriteTaskBody(task, markdown, {
      actor: author,
      ...(title ? { title } : {}),
      ...(reason ? { reason } : {}),
    });
    if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
    // No hand-refresh of the projection: unlike `/title` (which emits
    // nothing by design), this act DOES emit, and the projection's own
    // subscriber re-runs ensureWorkspace off the event.
    // Same, for the words the body carries — this is the door
    // `rewrite_task` uses to fix a held decision.
    await regateDecisionWords(taskId, author);
    const rewritten = taskStore.getTask(taskId);
    return j(200, {
      ok: true,
      task: rewritten,
    });
  }
  // assign_task (§3.6 task.assigned): hand a task between the human and
  // the agent (or a named identity). Status is untouched — a hand-off
  // is not progress, and routing it through the transition gate would
  // make "you take this" require evidence.
  const taskAssigneeMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/assignee$/);
  if (taskAssigneeMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskAssigneeMatch[1] ?? '');
    const body = await safeJson(req);
    const assignee = resolveAssignee(body?.assignee, undefined);
    // The create routes gate this; without the same gate here a board
    // could be walked back to the generic owner one hand-over at a time.
    // No author fallback: "hand it to whoever" is not a hand-over, and
    // silently assigning to the caller would do something else than what
    // they asked.
    if (!assignee) {
      return j(400, {
        error: ASSIGNEE_REQUIRED_ERROR,
        message: ASSIGNEE_REQUIRED_HANDOVER_MESSAGE,
      });
    }
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    // `assigneeKind` is forwarded here explicitly. The route layer is
    // the one nothing type-checks, and a param accepted by the tool and
    // dropped by the route answers 200 while doing nothing — this
    // codebase has shipped that exact bug. Refused rather than dropped
    // for the same reason: the plausible typo here is 'human', which is
    // a valid ASSIGNEE, and swallowing it would answer 200 while the
    // row lands undeclared.
    const handoverKind = parseAssigneeKind(body?.assigneeKind);
    if (!handoverKind.ok) {
      return j(400, {
        error: BAD_ASSIGNEE_KIND_ERROR,
        message: BAD_ASSIGNEE_KIND_MESSAGE,
      });
    }
    const res = taskStore.setAssignee(taskId, assignee, {
      actor: author,
      assigneeKind: handoverKind.assigneeKind,
    });
    if (!res.ok) return j(404, res);
    // A no-op emits nothing, so nothing would refresh the board room —
    // harmless here (nothing changed) but the changed path is covered
    // by the task.assigned event's own projection hook.
    if (!res.changed) taskProjection.ensureWorkspace(res.task.workspaceId);
    // Echo what the board now says this owner IS. Without it the caller
    // learns only that the call didn't error — which is exactly what a
    // declaration that silently failed to land also reports.
    const ownerKind = taskProjection.ownerKindReader(res.task.workspaceId)(res.task);
    return j(200, { ...res, ownerKind });
  }
  // Set / move / clear a due date (§3.6 task.due_set). `dueAt` was
  // writable only at creation, so the detail panel rendered a date
  // nobody could correct. Bryan, 2026-08-18: "All fields must be human
  // editable."
  const taskDueMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/due$/);
  if (taskDueMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskDueMatch[1] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    // `null` clears and a number sets. Anything else is REFUSED rather
    // than coerced: an unparseable date silently read as "clear" would
    // answer 200 while deleting the fact the caller meant to change.
    const raw = body?.dueAt;
    const dueAt =
      raw === null || raw === undefined
        ? null
        : typeof raw === 'number' && Number.isFinite(raw)
          ? raw
          : undefined;
    if (dueAt === undefined) {
      return j(400, { error: 'dueAt must be an epoch-ms number, or null to clear' });
    }
    const res = taskStore.setDueAt(taskId, dueAt, { actor: author });
    if (!res.ok) return j(404, res);
    if (!res.changed) taskProjection.ensureWorkspace(res.task.workspaceId);
    return j(200, res);
  }
  // Park a row: move it to `triage` and leave a comment saying why and
  // when to come back to it.
  //
  // The verb is older than its meaning. Parking used to be a state of
  // its own (`parkedUntil` on the row) until the owner's 2026-08-27
  // call that it duplicated triage — both say nobody is working this and
  // nobody has agreed it is work. The state went; the route stayed,
  // still on its old payload, because the shared server's REST callers
  // cannot be restarted (CLAUDE.md: narrowing a verb keeps accepting the
  // old shape).
  //
  // Which makes `parkedUntil: null` the delicate arm. It used to mean
  // "un-park now", and an old bundle still sends it that way — so it
  // must not be read as "park with no date", which would shove a live
  // row an old caller was trying to WAKE back into triage. It answers
  // 200 and does nothing, and says so. Parking with no date is spelled
  // by omitting the field, which no old caller does: the old MCP schema
  // required it.
  const taskParkMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/park$/);
  if (taskParkMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskParkMatch[1] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const task = taskStore.getTask(taskId);
    if (!task) return j(404, { ok: false, error: 'not-found' });
    const present = body !== null && typeof body === 'object' && 'parkedUntil' in body;
    const raw = body?.parkedUntil;
    // Same strictness the /due route keeps, and for a sharper reason
    // now: an unparseable date read as anything at all would move the
    // row on a request the caller got wrong.
    if (present && raw !== null && !(typeof raw === 'number' && Number.isFinite(raw))) {
      return j(400, {
        error: 'parkedUntil must be an epoch-ms number, or null (the retired un-park)',
      });
    }
    if (present && raw === null) {
      return j(200, {
        ok: true,
        task,
        changed: false,
        commented: false,
        message:
          'Un-parking is retired — parking is now a move to triage plus a comment, so there is no deferral to lift. Move the row on with a status change when it is ready.',
      });
    }
    const until = present ? (raw as number) : undefined;
    const reason = typeof body?.reason === 'string' ? body.reason : undefined;
    // Read BEFORE the move: `task` is the live row, so its status is
    // already `triage` on the other side of the call.
    const wasStatus = task.status;
    const moved = taskStore.transition(taskId, 'triage', { actor: author });
    // `same-status` is the ordinary case — a second park on a row
    // already in triage — and it still earns its comment below. Anything
    // else is refused rather than half-done: a note claiming a deferral
    // on a row that did not move is worse than no note. (A goal row
    // cannot reach here at all: `getTask` above resolves tasks only, so
    // a goal id 404s, which is what this verb has always answered.)
    if (!moved.ok && moved.error !== 'same-status') return j(400, moved);
    const changed = moved.ok;
    // The comment lands either way. It is the whole of what the verb
    // records now, and a row already in triage is exactly the row a
    // second park has something new to say about.
    taskProjection.ensureTaskBody(task);
    const note = await rooms.postComment(
      taskBodyDocId(taskId),
      null,
      author,
      parkNoteText({
        ...(until !== undefined ? { until } : {}),
        ...(reason !== undefined ? { reason } : {}),
        ...(changed ? { from: wasStatus } : {}),
      }),
      { kind: 'subject' },
      // Machine-written and one line long: not worth an outbound call.
      { generate: false },
    );
    if (!changed) taskProjection.ensureWorkspace(task.workspaceId);
    return j(200, {
      ok: true,
      task: taskStore.getTask(taskId) ?? task,
      changed,
      commented: note !== null,
    });
  }
  // Soft-delete a row, and put it back (§3.6 task.archived /
  // task.restored). The board's ONLY removal: three fields on the task,
  // nothing moved on disk, the id and every thread hanging off it still
  // resolving. See `archivedAt` on the Task type.
  //
  // `reason` is optional here where a park's is merely encouraged — an
  // archive is often a one-tap "not this" from a keyboard, and refusing
  // it for want of a sentence would push people back to leaving dead
  // rows on the board, which is the thing being fixed.
  const taskArchiveMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/archive$/);
  if (taskArchiveMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskArchiveMatch[1] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const res = taskStore.archiveTask(taskId, {
      actor: author,
      ...(typeof body?.reason === 'string' ? { reason: body.reason } : {}),
    });
    if (!res.ok) return j(404, res);
    if (!res.changed) taskProjection.ensureWorkspace(res.task.workspaceId);
    return j(200, res);
  }
  const taskRestoreMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/restore$/);
  if (taskRestoreMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskRestoreMatch[1] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const res = taskStore.unarchiveTask(taskId, { actor: author });
    if (!res.ok) return j(404, res);
    if (!res.changed) taskProjection.ensureWorkspace(res.task.workspaceId);
    return j(200, res);
  }
  return undefined;
}
