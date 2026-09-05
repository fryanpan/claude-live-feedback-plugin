/**
 * A band's archive and restore, and the ordered goal list the board is ranked by.
 *
 * Lifted verbatim out of `createServer`'s request closure; the handlers
 * read their collaborators off `WorkspaceRoutesContext` instead of the scope.
 */
import { type GoalListEntry } from '../tasks.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

// Moved down from server.ts with the route below, its only caller.
/**
 * Structural validation for PUT /workspaces/:id/goals. Returns the
 * sanitized list, or null if any entry is malformed. Unknown keys are
 * dropped rather than persisted — the sidecar shape is a contract, not a
 * A stored or in-flight `subgoals` array is still ACCEPTED and validated one
 * level deep — the REST route has callers this build cannot restart, and a
 * board written before subgoals were removed still has them on disk. The
 * store FLATTENS what comes through; nothing here nests any more.
 *
 * `id` is OPTIONAL and that is the create/keep switch (see `GoalListEntry`):
 * omitted means "create this band, mint me an id", present means "the band
 * you already have with this id". A present-but-empty id is still malformed —
 * it is a caller trying to say something, not a caller omitting the key, and
 * reading it as "create" would turn a bug into a silent new band.
 */
function parseGoalList(raw: unknown): GoalListEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const goals: GoalListEntry[] = [];
  for (const entry of raw) {
    const g = entry as Record<string, unknown>;
    if (g?.id !== undefined && (typeof g.id !== 'string' || g.id.length === 0)) return null;
    if (typeof g?.title !== 'string' || g.title.length === 0) return null;
    if (g.dueAt !== undefined && typeof g.dueAt !== 'number') return null;
    let subgoals: Array<{ id?: string; title: string; dueAt?: number }> | undefined;
    if (g.subgoals !== undefined) {
      if (!Array.isArray(g.subgoals)) return null;
      subgoals = [];
      for (const sub of g.subgoals) {
        const s = sub as Record<string, unknown>;
        if (s?.id !== undefined && (typeof s.id !== 'string' || s.id.length === 0)) return null;
        if (typeof s?.title !== 'string' || s.title.length === 0) return null;
        if (s.dueAt !== undefined && typeof s.dueAt !== 'number') return null;
        if (s.subgoals !== undefined) return null;
        subgoals.push({
          ...(s.id !== undefined ? { id: s.id as string } : {}),
          title: s.title,
          ...(s.dueAt !== undefined ? { dueAt: s.dueAt as number } : {}),
        });
      }
    }
    goals.push({
      ...(g.id !== undefined ? { id: g.id as string } : {}),
      title: g.title,
      ...(g.dueAt !== undefined ? { dueAt: g.dueAt as number } : {}),
      ...(subgoals !== undefined ? { subgoals } : {}),
    });
  }
  return goals;
}

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleWorkspaceGoals(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const { taskStore, taskProjection, j, safeJson } = ctx;
  const { req, pathname, authorFor } = rq;
  // The same pair for a BAND, and deliberately its own path rather than
  // a goal id squeezed through `/api/tasks/:id/archive`. The transition
  // route accepts either kind because a status change is literally the
  // same write on both; an archive is not — this one cascades to the
  // band's tasks, and its response carries the ids it moved. A caller that cannot tell which of those two things it just
  // did is a caller that cannot report the count to the person who
  // asked for it.
  //
  // What the count is FOR: the confirmation the board shows before the
  // write ("Archive this goal and its 14 tasks?"). `GET .../cascade`
  // answers it from the same walk the archive runs, so the sentence and
  // the act cannot disagree.
  const goalCascadeMatch = pathname.match(/^\/workspaces\/[^/]+\/goals\/([^/]+)\/cascade$/);
  if (goalCascadeMatch && req.method === 'GET') {
    const goalId = decodeURIComponent(goalCascadeMatch[1] ?? '');
    // No existence check here any more. `middleware/workspace-scope.ts` has
    // already asked which board holds this band and refused the request when
    // the answer was "none" or "a different one" — which is the whole of what
    // this line used to do, minus the half it could not do at all.
    return j(200, taskStore.goalCascade(goalId));
  }
  const goalArchiveMatch = pathname.match(/^\/workspaces\/[^/]+\/goals\/([^/]+)\/archive$/);
  if (goalArchiveMatch && req.method === 'POST') {
    const goalId = decodeURIComponent(goalArchiveMatch[1] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const res = taskStore.archiveGoal(goalId, {
      actor: author,
      ...(typeof body?.reason === 'string' ? { reason: body.reason } : {}),
    });
    if (!res.ok) return j(404, res);
    if (!res.changed) taskProjection.ensureWorkspace(res.goal.workspaceId);
    return j(200, res);
  }
  const goalRestoreMatch = pathname.match(/^\/workspaces\/[^/]+\/goals\/([^/]+)\/restore$/);
  if (goalRestoreMatch && req.method === 'POST') {
    const goalId = decodeURIComponent(goalRestoreMatch[1] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const res = taskStore.unarchiveGoal(goalId, { actor: author });
    if (!res.ok) return j(404, res);
    if (!res.changed) taskProjection.ensureWorkspace(res.goal.workspaceId);
    return j(200, res);
  }
  // set_goal_list (§3.2 edit contract): replace the ordered board
  // sections. Structural validation happens HERE because the store
  // trusts its callers with shapes — a junk entry that reached the
  // sidecar would render as a broken section forever.
  const wsGoalsMatch = pathname.match(/^\/workspaces\/([^/]+)\/goals$/);
  if (wsGoalsMatch && req.method === 'PUT') {
    const workspaceId = decodeURIComponent(wsGoalsMatch[1] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const goals = parseGoalList(body?.goals);
    if (!goals) {
      return j(400, { error: 'goals must be [{id?, title, dueAt?, subgoals?}]' });
    }
    // `drop` is the caller's explicit "yes, remove that band even
    // though it holds work". A malformed value must NOT read as absent
    // — silently treating a string as no acknowledgement would turn a
    // typo into a refusal the caller cannot explain.
    const drop = body?.drop;
    if (
      drop !== undefined &&
      (!Array.isArray(drop) || drop.some((id) => typeof id !== 'string' || id.length === 0))
    ) {
      return j(400, { error: 'drop must be an array of goal ids' });
    }
    const res = taskStore.setGoalList(workspaceId, goals, {
      actor: author,
      ...(drop !== undefined ? { drop: drop as string[] } : {}),
    });
    if (!res.ok) {
      // The refusal is the whole feature, so it has to name the way
      // out: the MCP layer surfaces this body verbatim as the error
      // text an agent reads.
      // An id this board does not hold is the re-key gesture arriving
      // by its other spelling ("submit the list with a new id"), so the
      // message has to name both ways out rather than just saying no.
      const detail =
        res.error === 'unknown-goal-id'
          ? {
              message:
                `this board has no goal with id ${res.unknownIds
                  .map((id) => `"${id}"`)
                  .join(', ')}. ` +
                'Goal ids are generated and permanent: to CREATE a band, send the entry ' +
                'with no `id` at all and the new id comes back in `created`; to change a ' +
                "band's title, use rename_goal, which cannot move a task. There is no " +
                "way to give an existing band a different id, because a task's band IS " +
                'its goal id — re-keying one is what strands everything filed under it.',
            }
          : res.error === 'would-strand-tasks'
            ? {
                message:
                  'this replace would strand work filed under ' +
                  `${res.stranding
                    .map((s) => `"${s.title}" (${s.id}: ${s.openTasks} open, ${s.doneTasks} done)`)
                    .join('; ')}. ` +
                  'If you meant to RENAME a band, use rename_goal — it changes the title ' +
                  'in place and cannot move a task. If you meant to remove it, say so by ' +
                  'listing its id in `drop`; open tasks then land at the bottom of Backlog ' +
                  'and done tasks keep pointing at the removed id, both reported back.',
              }
            : {};
      return j(res.error === 'workspace-not-found' ? 404 : 400, { ...res, ...detail });
    }
    return j(200, res);
  }
  // rename_goal (§3.2): change a band's TITLE without touching its id.
  // Its own route rather than a flag on the PUT above, because the
  // whole value is that it cannot reach the replace path at all — a
  // task's band IS its goal id, and nothing here changes an id.
  const wsRenameMatch = pathname.match(/^\/workspaces\/([^/]+)\/goals\/rename$/);
  if (wsRenameMatch && req.method === 'POST') {
    const workspaceId = decodeURIComponent(wsRenameMatch[1] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const goalId = body?.goal;
    if (typeof goalId !== 'string' || goalId.length === 0) {
      return j(400, { error: 'goal must be a goal id' });
    }
    const title = body?.title;
    if (typeof title !== 'string' || title.trim().length === 0) {
      return j(400, { error: 'title must be a non-empty string' });
    }
    // `null` clears dueAt, a number sets it, absent leaves it alone —
    // three distinct meanings, so the parse keeps them distinct.
    const dueAt = body?.dueAt;
    if (dueAt !== undefined && dueAt !== null && typeof dueAt !== 'number') {
      return j(400, { error: 'dueAt must be a number, or null to clear it' });
    }
    const res = taskStore.renameGoal(
      workspaceId,
      goalId,
      {
        title: title.trim(),
        ...(dueAt !== undefined ? { dueAt: dueAt as number | null } : {}),
      },
      { actor: author },
    );
    if (!res.ok) {
      // `chores` is a 400, not a 404: it is a row the caller really
      // saw, so "no such goal" would send them hunting for a typo.
      const status =
        res.error === 'reserved-goal-id' ? 400 : res.error === 'goal-not-found' ? 404 : 404;
      return j(status, res);
    }
    return j(200, res);
  }
  // add_goal: append ONE band. Separate from the PUT above for the same
  // reason rename is — that one replaces the list, so a board adding a
  // band through it submits the list it last read and removes anything
  // another writer added in between.
  const wsAddGoalMatch = pathname.match(/^\/workspaces\/([^/]+)\/goals\/add$/);
  if (wsAddGoalMatch && req.method === 'POST') {
    const workspaceId = decodeURIComponent(wsAddGoalMatch[1] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const title = body?.title;
    if (typeof title !== 'string' || title.trim().length === 0) {
      return j(400, { error: 'title must be a non-empty string' });
    }
    const dueAt = body?.dueAt;
    if (dueAt !== undefined && typeof dueAt !== 'number') {
      return j(400, { error: 'dueAt must be a number' });
    }
    const after = body?.after;
    if (after !== undefined && (typeof after !== 'string' || after.length === 0)) {
      return j(400, { error: 'after must be a goal id' });
    }
    const res = taskStore.addGoal(
      workspaceId,
      {
        title: title.trim(),
        ...(dueAt !== undefined ? { dueAt: dueAt as number } : {}),
        ...(after !== undefined ? { after: after as string } : {}),
      },
      { actor: author },
    );
    if (!res.ok) {
      const status = res.error === 'rejected' ? 400 : 404;
      return j(status, res);
    }
    return j(200, res);
  }
  // reorder_goals (§3.2): the priority gesture, permutation-only. A
  // separate route from the PUT above because that one REPLACES the
  // list — the two params here (`order`, `parent`) are the whole
  // contract, and `parent` is exactly the kind of param a hand-copying
  // route drops while still answering 200, so both are asserted
  // end-to-end in goal-reorder.test.ts (the `groups` lesson).
  const wsReorderMatch = pathname.match(/^\/workspaces\/([^/]+)\/goals\/reorder$/);
  if (wsReorderMatch && req.method === 'POST') {
    const workspaceId = decodeURIComponent(wsReorderMatch[1] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const order = body?.order;
    if (!Array.isArray(order) || order.some((id) => typeof id !== 'string' || id.length === 0)) {
      return j(400, { error: 'order must be an array of goal ids' });
    }
    const parent = body?.parent;
    if (parent !== undefined && (typeof parent !== 'string' || parent.length === 0)) {
      return j(400, { error: 'parent must be a goal id' });
    }
    const res = taskStore.reorderGoals(workspaceId, order as string[], {
      actor: author,
      ...(parent !== undefined ? { parent: parent as string } : {}),
    });
    if (!res.ok) {
      // The refusal has to be readable by the agent that hit it: the
      // MCP layer surfaces the raw body as the error text, so the ids
      // and what to do about them belong right here.
      const detail =
        res.error === 'order-mismatch'
          ? {
              message:
                'order must be exactly the goal ids at this scope. ' +
                `unknown: [${res.unknownIds.join(', ')}]; ` +
                // Named separately because the fix differs: an unknown
                // id means re-read, a reserved one means drop it.
                `reserved (never ordered — leave these out): [${res.reservedIds.join(', ')}]; ` +
                `missing: [${res.missingIds.join(', ')}]; ` +
                `duplicated: [${res.duplicateIds.join(', ')}]. ` +
                `Re-read the list with GET /workspaces/${workspaceId} and send back every ` +
                'row at this scope whose `reorderable` is true.',
            }
          : {};
      return j(res.error === 'workspace-not-found' ? 404 : 400, { ...res, ...detail });
    }
    return j(200, res);
  }
  return undefined;
}
