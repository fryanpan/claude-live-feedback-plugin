/**
 * A row's status, its evidence, its cross-references and its goal placement.
 *
 * Lifted verbatim out of `createServer`'s request closure; the handlers
 * read their collaborators off `TaskRoutesContext` instead of the scope.
 */
import { linkTitlesFor } from '../link-titles.ts';
import { runRefsBackfill } from '../refs-backfill.ts';
import { BAD_REF_ERROR } from '../task-create.ts';
import { type TaskStatus, isValidRef, taskChip } from '../tasks.ts';
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleTaskStatusAndLinks(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const {
    taskStore,
    taskProjection,
    rooms,
    j,
    safeJson,
    boardIndexForListing,
    hubBoardsForDocIndexed,
  } = ctx;
  const { req, pathname, authorFor, visitor } = rq;
  // The single gate for status changes: attributed and
  // dependency-checked. 409 on an enforce-marked open dependency.
  const taskTransitionMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/transition$/);
  if (taskTransitionMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskTransitionMatch[1] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    const to = body?.to as TaskStatus | undefined;
    if (!author || !to) return j(400, { error: 'author + to required' });
    const res = taskStore.transition(taskId, to, {
      actor: author,
      note: body?.note as string | undefined,
      usage: body?.usage as { inputTokens: number; outputTokens: number } | undefined,
    });
    // `body.confirmed` (risk gate, removed 2026-08-18) and
    // `body.evidence` (removed 2026-08-25) are read by nothing now and
    // are deliberately NOT validated: peers on older bundles keep
    // sending them until they restart, and a request that starts
    // failing over a field the server no longer cares about is exactly
    // how a removal breaks a caller it never meant to touch.
    if (!res.ok) {
      // A gate refusal is a refusal, not a malformed request: same 409
      // an enforce-marked blocker returns, so callers have one shape
      // for "the gate said no". A plan-hold refusal is the same shape:
      // the gate said no, and the message names the release.
      const refused = res.error === 'blocked' || res.error === 'plan-unapproved';
      const status = res.error === 'not-found' ? 404 : refused ? 409 : 400;
      return j(status, res);
    }
    return j(200, res);
  }
  // Retired 2026-08-25 with the rest of evidence support, and kept as a
  // NO-OP rather than deleted. An old bundle reaches this route from a
  // session nobody here can restart, and the two failure modes a
  // deletion would hand it — a 404 from the fall-through, or a refusal
  // over a field the server stopped caring about — are both unreadable
  // from the caller's own version. So it answers the way it always did
  // for the two cases that were never about evidence (unknown task,
  // missing author) and records nothing for the rest. `ignored` is on
  // the response so a reader of a log can tell an accepted no-op from a
  // correction that landed.
  const taskEvidenceMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/evidence$/);
  if (taskEvidenceMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskEvidenceMatch[1] ?? '');
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const task = taskStore.getTask(taskId) ?? taskStore.getGoalRow(taskId);
    if (!task) return j(404, { ok: false, error: 'not-found' });
    return j(200, {
      ok: true,
      ignored: true,
      task,
      message:
        'Evidence is no longer recorded on transitions. This call was accepted and nothing was written; evidence already stored on older transitions is untouched.',
    });
  }
  // Cross-references (§3.10 `.../links`): links are STORED on the
  // task; backlinks are COMPUTED per read, never stored, so the two
  // directions can't drift.
  const taskLinksMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/links$/);
  if (taskLinksMatch && req.method === 'GET') {
    const taskId = decodeURIComponent(taskLinksMatch[1] ?? '');
    const task = taskStore.getTask(taskId);
    if (!task) return j(404, { error: 'task not found' });
    // `backlinksFor` spans every workspace, deliberately — a ref may cross a
    // board, and the whole point of a backlink is that the pointing row does
    // not have to be nearby. For a caller scoped to ONE board that span is a
    // read of boards they were never given: a private row's title, id, status
    // and assignee, arriving on a route they are allowed to call about a row
    // they are allowed to see. So a scoped caller is answered with the
    // backlinks from their own board, and a member is answered with none.
    const backlinks = taskStore
      .backlinksFor({ kind: 'task', taskId })
      .filter((t) => !visitor || t.workspaceId === visitor.workspaceId);
    return j(200, {
      taskId,
      links: task.links,
      backlinks: backlinks.map(taskChip),
    });
  }
  // The same question asked about an ARBITRARY ref. `backlinksFor`
  // always answered it; the HTTP surface could only pose it about a
  // task (above) or a doc/thread (`GET /api/docs/<id>/tasks`), so the
  // question the `url` kind was added for — "which tasks point at this
  // pull request" — had no route, and `diff` refs had none either.
  //
  // POST for a read is deliberate: a ref is a structured value whose
  // `url` kind carries a caller-supplied URL, and putting that in a
  // query string writes it into every access log and proxy on the path
  // for no gain. Nothing here mutates.
  if (pathname === '/api/refs/backlinks' && req.method === 'POST') {
    const body = await safeJson(req);
    const ref = body?.ref;
    // A malformed ref must NOT fall through to an empty answer: [] and
    // "I didn't understand you" are indistinguishable to the caller,
    // and the first one reads as "nothing points at this PR".
    if (!isValidRef(ref)) return j(400, { error: BAD_REF_ERROR });
    return j(200, { ref, tasks: taskStore.backlinksFor(ref).map(taskChip) });
  }
  // Mine the links people already wrote into structured refs — every
  // doc body, task body, goal body, and stored url ref, both
  // directions. Idempotent (a second run creates nothing), and
  // `dryRun: true` counts what WOULD land without writing, so the
  // sweep can be sized before it runs. One-shot per deployment in
  // practice; the settle-time scan keeps it from going stale.
  if (pathname === '/api/refs/backfill' && req.method === 'POST') {
    const body = await safeJson(req);
    const dryRun = body?.dryRun === true;
    const stats = runRefsBackfill({ rooms, tasks: taskStore, dryRun });
    // Link writes emit no store event (§3.6's exhaustive table), so
    // the projection refresh happens here — same as the links route.
    if (!dryRun) {
      for (const wsId of stats.workspacesTouched) taskProjection.ensureWorkspace(wsId);
    }
    return j(200, { dryRun, ...stats });
  }
  // Titles for pasted workspace URLs — the comment renderer's lookup.
  // Batched (one call per render burst, not one per link) and read-only.
  // Members only: the share-scope middleware above never whitelists this
  // path, so a share visitor's client falls back to raw URLs rather
  // than reading titles across the whole server.
  if (pathname === '/api/links/titles' && req.method === 'POST') {
    const body = await safeJson(req);
    const urls = body?.urls;
    if (!Array.isArray(urls)) return j(400, { error: 'urls: string[] required' });
    // One board index per REQUEST, built only if a board-scoped doc URL
    // actually needs it — the membership question is the same one the
    // /api/docs listing answers, asked through the same index.
    let boardIndex: Map<string, string[]> | null = null;
    // `titles` + `statuses` at the top level — the old `{ titles }`
    // shape is preserved for clients on a pre-status bundle.
    return j(
      200,
      linkTitlesFor(
        urls.filter((u): u is string => typeof u === 'string'),
        {
          docMeta: (docId) => rooms.peekMeta(docId),
          docInWorkspace: (docId, workspaceId) => {
            const meta = rooms.peekMeta(docId);
            if (!meta) return false;
            if (meta.workspaceId === workspaceId) return true;
            boardIndex ??= boardIndexForListing();
            return hubBoardsForDocIndexed(boardIndex, meta).has(workspaceId);
          },
          task: (taskId) => {
            // Goals answer here too: they share the id namespace and
            // the status machine, and a pasted goal link should read
            // as its title + status like any other row.
            const t = taskStore.getTask(taskId) ?? taskStore.getGoalRow(taskId);
            if (!t) return undefined;
            return {
              title: t.title,
              workspaceId: t.workspaceId,
              status: t.status,
              // Only a Task can be a held draft; a GoalRow never
              // carries the field.
              ...('planHold' in t && t.planHold !== undefined ? { planHeld: true } : {}),
            };
          },
          workspaceName: (workspaceId) => taskStore.getWorkspace(workspaceId)?.name,
        },
      ),
    );
  }
  if (taskLinksMatch && (req.method === 'POST' || req.method === 'DELETE')) {
    const taskId = decodeURIComponent(taskLinksMatch[1] ?? '');
    const body = await safeJson(req);
    const ref = body?.ref;
    if (!isValidRef(ref)) return j(400, { error: BAD_REF_ERROR });
    const res =
      req.method === 'POST' ? taskStore.linkRef(taskId, ref) : taskStore.unlinkRef(taskId, ref);
    if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
    // Link changes emit no store event (§3.6's exhaustive table has no
    // row for them), so refresh the projection by hand — the same
    // pattern as createWorkspace/attachDoc above.
    taskProjection.ensureWorkspace(res.task.workspaceId);
    return j(200, { ok: true, changed: res.changed, task: res.task });
  }
  // set_task_goal (§3.10): goal + exact position — the write
  // half of triage and the board's regroup gesture. Every field here is
  // hand-copied; each has an HTTP-level test in task-tool-routes.test.ts.
  //
  // `riskTier` used to be validated here and forwarded to the store. It
  // is now IGNORED, not refused: an older peer sends it on every
  // placement until it restarts, and the 400 this route used to be able
  // to return would now fire on a field that means nothing. Accept the
  // old payload shape; there is an HTTP-level test that sends it.
  const taskGoalMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/goal$/);
  if (taskGoalMatch && req.method === 'POST') {
    const taskId = decodeURIComponent(taskGoalMatch[1] ?? '');
    const body = await safeJson(req);
    const goal = body?.goal;
    if (typeof goal !== 'string' || goal.length === 0) {
      return j(400, { error: 'goal required' });
    }
    const author = authorFor(body?.author);
    if (!author) return j(400, { error: 'author required' });
    const batchId = body?.batchId;
    if (batchId !== undefined && typeof batchId !== 'string') {
      return j(400, { error: 'batchId must be a string' });
    }
    // `after` names the row this one lands behind, or null for the top
    // of the goal — the only spelling that can express a drop between
    // two rows sharing an `order`, which `position` cannot. Absent means
    // the caller is an older bundle still sending `position` alone.
    const after = body?.after;
    if (after !== undefined && after !== null && typeof after !== 'string') {
      return j(400, { error: 'after must be a task id or null' });
    }
    const res = taskStore.setTaskGoal(taskId, goal, {
      actor: author,
      position: typeof body?.position === 'number' ? Number(body.position) : undefined,
      ...(after !== undefined ? { after: after as string | null } : {}),
      batchId,
    });
    if (!res.ok) return j(res.error === 'not-found' ? 404 : 400, res);
    // A confirm-in-place (changed:false) mutates gated fields
    // (triagedAgainst, triagePendingTs) without emitting an event —
    // refresh the projection by hand, same as attachDoc.
    if (!res.changed) taskProjection.ensureWorkspace(res.task.workspaceId);
    return j(200, res);
  }
  return undefined;
}
