import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
/**
 * What to work on next, the load reports behind it, and the board's event feed.
 *
 * Lifted verbatim out of `createServer`'s request closure; the handlers
 * read their collaborators off `WorkspaceRoutesContext` instead of the scope.
 */
import { redactHubEventForVisitor } from '../share/redact-hub-events.ts';
import { buildQueue } from '../task-queue.ts';
import { eventsLogPath, isRetired, retiredNotice } from '../tasks.ts';
import { SERVER_TICK_EVENT, analyzeUptime } from '../uptime.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleWorkspaceNext(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const { taskStore, taskProjection, dataDir, opts, j, safeJson, parallelismCapView } = ctx;
  const { req, pathname, url, visitor } = rq;
  // The work queue: priority order, dependency-aware, grouped into
  // waves that can run at once (§3.9 agent side).
  const wsNextMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/next$/);
  if (wsNextMatch && req.method === 'GET') {
    const workspaceId = decodeURIComponent(wsNextMatch[1] ?? '');
    const workspace = taskStore.getWorkspace(workspaceId);
    if (!workspace) return j(404, { error: 'workspace not found' });
    const limitRaw = url.searchParams.get('limit');
    // Same additive flag as `/tasks`, and the same default: an archived
    // row is not work to pick up, so it leaves the queue unless a caller
    // asks for it by name.
    const includeArchived = url.searchParams.get('includeArchived') === 'true';
    const wantedOwner = url.searchParams.get('assignee') || undefined;
    const tasks = taskStore.listTasks(workspaceId, { includeArchived });
    const rows = buildQueue(tasks, workspace.goals, {
      ...(wantedOwner !== undefined ? { assignee: wantedOwner } : {}),
      // By id as well as by name: the store's matcher finds every
      // spelling the roster folds into one agent, and `idOf` puts
      // that id on the row.
      owner: {
        ...(wantedOwner !== undefined ? { matches: taskStore.ownerMatcher(wantedOwner) } : {}),
        idOf: (t) => taskStore.ownerIdOf(t),
      },
      ...(limitRaw !== null && Number.isFinite(Number(limitRaw))
        ? { limit: Number(limitRaw) }
        : {}),
      includeBlocked: url.searchParams.get('includeBlocked') === 'true',
      // So each row can say whether its BAND has been agreed to. The
      // row is still listed either way — a lead reading the queue
      // should see the band and be able to disagree with it.
      goalRows: taskStore.listGoalRows(workspaceId),
      // The discussion the queue has always dropped. Every one of the
      // five known stale-premise pickups had a comment on the task
      // saying the premise had moved, and none of them reached the
      // next reader, because this route returned `body` and nothing
      // else. Passed as a reader rather than a map so `buildQueue`
      // stays pure and only the armed rows pay for their notes.
      discussion: (taskId) => taskProjection.discussionNotes(taskId),
      ...(opts.premiseStaleAfterMs !== undefined ? { staleAfterMs: opts.premiseStaleAfterMs } : {}),
    });
    // WHO IS ALREADY ON EACH ROW, on the surface where the pickup
    // decision is actually made. `list_tasks` has carried
    // `ownerSession` for a while and this route did not, so the read
    // existed and was one call away from every dispatcher who needed
    // it — which on 2026-08-17 is how two sessions each built a
    // complete answer to the same board task (#186 merged, #190 thrown
    // away) with neither able to detect the other.
    //
    // Two fields because they answer two questions and the whole
    // failure was one signal being read as an answer to the other:
    // `ownerSession` is the session behind the row's OWNER, and
    // `claimedBy` is the session that last moved it into in-progress —
    // which is the only one that exists when nobody assigned it, since
    // a transition never touches `assignee`.
    //
    // Both are recency reads (heartbeat + observed work), never content
    // identity: a session that thinks for an hour produces no new
    // commit and must still read as taken. Informational only — nothing
    // here refuses anyone, because two agents on one row is sometimes
    // right.
    const ownerSessionOf = taskProjection.ownerSessionReader(workspaceId);
    const claimSessionOf = taskProjection.claimSessionReader(workspaceId);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const withPresence = rows.map((row) => {
      const task = byId.get(row.id);
      if (!task) return row;
      const owner = ownerSessionOf(task);
      const claim = claimSessionOf(task);
      return {
        ...row,
        ...(owner !== undefined ? { ownerSession: owner } : {}),
        ...(claim !== undefined ? { claimedBy: claim } : {}),
      };
    });
    // The queue still ranks — a retired board's in-flight work is
    // finishable — but the caller is told what it is looking at BEFORE
    // it picks a row. This is the surface an agent hits when it asks
    // "what should I do next", so silence here is the lost night.
    //
    // THE PARALLELISM CAP TRIMS WHAT IS OFFERED. A `todo` row is an
    // offer to dispatch, and the board may only have `free` more
    // builders, so only the top `free` todo rows are listed — the same
    // trim the ready-work nudge applies, so the two surfaces cannot tell
    // a lead two different queues. In-progress rows pass through
    // untouched: they are the work already in flight (a builder reading
    // this route to find its own row must still find it), and hiding
    // them would not free a slot. `capacity` says what was withheld, so
    // a short list reads as the cap at work and not as a short queue.
    const capView = parallelismCapView(workspaceId);
    let offers = capView?.free ?? Number.POSITIVE_INFINITY;
    let heldForCapacity = 0;
    const withinCapacity = withPresence.filter((row) => {
      const task = byId.get(row.id);
      if (!task || task.status !== 'todo') return true;
      if (offers > 0) {
        offers -= 1;
        return true;
      }
      heldForCapacity += 1;
      return false;
    });
    return j(200, {
      workspaceId,
      tasks: withinCapacity,
      ...(capView
        ? {
            capacity: {
              cap: capView.cap,
              inUse: capView.inUse,
              free: capView.free,
              ...(heldForCapacity > 0 ? { heldForCapacity } : {}),
            },
          }
        : {}),
      ...(isRetired(workspace) ? { retired: retiredNotice(workspace) } : {}),
    });
  }
  // Activity view (§3.9): the per-workspace events.jsonl audit log,
  // read back as rows. This is the surface where the after-the-fact
  // 80/95 review happens, built on the same file every subscriber saw
  // (§3.6: the audit log can never disagree with what subscribers saw).
  // Board load reports: one line per browser boot,
  // appended by the client after its first paint, read back newest-first
  // so "how slow was the board, and in which phase" is a recorded fact
  // rather than a memory of watching a spinner. No external service —
  // the report is a JSON object the client shaped, stamped here with
  // when it arrived and what sent it.
  const wsLoadMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/load-reports$/);
  if (wsLoadMatch) {
    const workspaceId = decodeURIComponent(wsLoadMatch[1] ?? '');
    if (!taskStore.getWorkspace(workspaceId)) {
      return j(404, { error: 'workspace not found' });
    }
    const logPath = join(dataDir, 'workspaces', `${workspaceId}.load-reports.jsonl`);
    if (req.method === 'POST') {
      const body = await safeJson(req);
      if (!body || typeof body !== 'object') return j(400, { error: 'report required' });
      // Body first, stamps last: ts and ua are the server's own record
      // of when the report arrived and what sent it, and a body that
      // claims its own must not be able to overwrite them.
      const row = {
        ...body,
        ts: Date.now(),
        ...(req.headers.get('user-agent') ? { ua: req.headers.get('user-agent') } : {}),
      };
      // The sidecar flush that normally creates this dir is debounced,
      // so a report can arrive before it exists (same guard every other
      // writer in tasks.ts carries).
      mkdirSync(join(dataDir, 'workspaces'), { recursive: true });
      appendFileSync(logPath, `${JSON.stringify(row)}\n`);
      return j(200, { ok: true });
    }
    if (req.method === 'GET') {
      let reports: unknown[] = [];
      if (existsSync(logPath)) {
        reports = readFileSync(logPath, 'utf8')
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              // Same rule as the events log: a torn tail line must not
              // take the whole read down.
              return [];
            }
          });
      }
      // Newest first, capped — the file grows, the read does not.
      reports = reports.slice(-50).reverse();
      return j(200, { workspaceId, reports });
    }
  }
  const wsAuditMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/events$/);
  if (wsAuditMatch && req.method === 'GET') {
    const workspaceId = decodeURIComponent(wsAuditMatch[1] ?? '');
    if (!taskStore.getWorkspace(workspaceId)) {
      return j(404, { error: 'workspace not found' });
    }
    const logPath = eventsLogPath(dataDir, workspaceId);
    let rows: Array<{ event?: unknown; ts?: unknown }> = [];
    if (existsSync(logPath)) {
      rows = readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as { event?: unknown; ts?: unknown }];
          } catch {
            // A torn tail line (crash mid-append) must not take the
            // whole activity view down with it.
            return [];
          }
        });
    }
    // Uptime (§3.12 commit 11): every line — real event or liveness
    // marker — is proof the server was alive when it was written, so
    // the gap analysis runs over ALL timestamps, before any filtering.
    const uptime = analyzeUptime(
      rows.map((r) => r.ts).filter((t): t is number => typeof t === 'number'),
      {
        now: Date.now(),
        ...(opts.uptimeTickMs !== undefined ? { tickMs: opts.uptimeTickMs } : {}),
      },
    );
    // Ticks are measurement substrate, not activity — strip them from
    // the review list (BEFORE the cap, so a week of beats can't crowd
    // real rows out of it). server.started stays: a restart is honest
    // activity.
    let events: unknown[] = rows.filter((r) => r.event !== SERVER_TICK_EVENT);
    // Cap the payload: the newest rows are the review's working set.
    if (events.length > 1000) events = events.slice(-1000);
    /**
     * A member reads the Activity tab, through the SAME redaction the board's
     * live event stream already applies (`redactHubEventForVisitor`): actors
     * reduced to display name and kind, tasks to the visitor projection, a
     * voice utterance's transcript dropped.
     *
     * ONE rule for both doors, deliberately. The log and the stream are the
     * same bytes modulo transport (`TaskEventBus.appendAudit` writes exactly
     * what subscribers receive), so a second redaction written for this route
     * would agree today and drift later — and the one that drifts open is a
     * breach. It is applied AFTER the cap for no reason but cost: redacting a
     * thousand rows beats redacting a year of them.
     */
    if (visitor) {
      events = events.map((row) =>
        typeof (row as { event?: unknown })?.event === 'string'
          ? redactHubEventForVisitor(row as { event: string })
          : row,
      );
    }
    return j(200, { workspaceId, events, uptime });
  }
  return undefined;
}
