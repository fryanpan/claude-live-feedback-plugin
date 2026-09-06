import { parseAgentNote, resolveNoteTarget } from '../agent-notes.ts';
import { SHARED_IDENTITY_ERROR, SHARED_IDENTITY_MESSAGE } from '../agent-watches.ts';
import { isSharedAgentName } from '../chat-audit.ts';
import { isValidDispatchTaskId } from '../dispatch-registry.ts';
/**
 * Builder dispatches, and the notes a session writes onto the row it holds.
 *
 * Lifted verbatim out of `createServer`'s request closure; the handlers
 * read their collaborators off `TaskRoutesContext` instead of the scope.
 */
import { matchRest, restIs } from '../middleware/workspace-scope.ts';
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleDispatchAndNoteRoutes(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  const {
    taskStore,
    dispatches,
    agentNotes,
    j,
    safeJson,
    holdersClause,
    parallelismCapView,
    proposeAllowRule,
  } = ctx;
  const { req, pathname, scope, visitor } = rq;
  // --- REST: builder dispatches ---
  // The lead's statement that a builder is working a task in a private
  // worktree, so the stall loop can read worktree churn as the row
  // moving. POST registers {taskId, worktreePath} (re-POST replaces);
  // DELETE /workspaces/<ws>/dispatches/<taskId> closes on terminal. The registry
  // validates paths and prunes dispatches whose worktree is gone. See
  // dispatch-registry.ts.
  if (restIs(scope, 'dispatches')) {
    // Same defense-in-depth posture as the agent-watches route: no
    // share host reaches here today, and this keeps a later
    // allowlisting from exposing host filesystem paths to an external
    // reviewer.
    if (visitor) return j(403, { error: 'not available to share visitors' });
    if (req.method === 'GET') {
      return j(200, { dispatches: dispatches.list() });
    }
    if (req.method === 'POST') {
      const body = await safeJson(req);
      const taskId = body?.taskId;
      const worktreePath = body?.worktreePath;
      const agentName = typeof body?.agentName === 'string' ? body.agentName.trim() : '';
      if (!isValidDispatchTaskId(taskId)) return j(400, { error: 'bad-task-id' });
      if (typeof worktreePath !== 'string' || worktreePath.length === 0) {
        return j(400, { error: 'path-not-absolute' });
      }
      // The workspace's parallelism cap (Bryan, 2026-08-31), checked before
      // the registry ever sees the call. Re-registering the SAME task
      // replaces its own slot rather than taking a second one, so it is
      // excluded from the count it is being checked against — otherwise
      // a builder's own re-dispatch (a worktree replaced after a crash)
      // would be refused for the slot it already holds.
      //
      // A task this store has no record of (soft-deleted, or a stray
      // id) cannot be attributed to a board, so the cap cannot be
      // evaluated — the same "cannot look, so cannot enforce" posture
      // the ready-gate takes with an unreadable row, applied here to a
      // dispatch instead of a wake.
      const task = taskStore.getTask(taskId);
      const view = task ? parallelismCapView(task.workspaceId, taskId) : undefined;
      if (view && view.free === 0) {
        return j(409, {
          error: 'parallelism-cap-reached',
          message: `parallelism cap (${view.cap}) reached — held by: ${holdersClause(view.holders)}`,
          cap: view.cap,
          holders: view.holders,
        });
      }
      const res = dispatches.register(taskId, worktreePath, agentName || undefined);
      if (!res.ok) return j(400, { error: res.error });
      return j(200, res);
    }
    return j(405, { error: 'method not allowed' });
  }
  const dispatchCloseMatch = matchRest(scope, /^dispatches\/([^/]+)$/);
  if (dispatchCloseMatch) {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    if (req.method === 'DELETE') {
      const taskId = decodeURIComponent(dispatchCloseMatch[1] ?? '');
      return j(200, dispatches.close(taskId));
    }
    return j(405, { error: 'method not allowed' });
  }
  // --- REST: a status note on a NAMED row ---
  // The MCP verb's route: the agent knows which row it is reporting on
  // and says so, where the hook route below has to resolve the current
  // claim (and finds nothing for a row the agent never claimed). Same
  // body rules as the hook route — `parseAgentNote`, so a shared agent
  // name is refused identically — same append, same per-agent ring.
  // 202 to match: a status is fire-and-forget for the poster too.
  const taskNotesMatch = matchRest(scope, /^tasks\/([^/]+)\/notes$/);
  if (taskNotesMatch) {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
    const taskId = decodeURIComponent(taskNotesMatch[1] ?? '');
    const raw = await safeJson(req);
    // The URL names the row; a body `taskId` is ignored here rather
    // than validated — this route accepted unknown fields before the
    // hook route learned the field, and must keep doing so.
    if (raw !== null && typeof raw === 'object') {
      (raw as Record<string, unknown>).taskId = undefined;
    }
    const parsed = parseAgentNote(raw);
    if (!parsed.ok) return j(400, { error: parsed.error, message: parsed.message });
    const { note } = parsed;
    const res = taskStore.appendNote(taskId, {
      kind: note.kind,
      text: note.text,
      agent: note.agent,
      ts: note.at,
      ...(note.sessionId !== undefined ? { sessionId: note.sessionId } : {}),
    });
    if (!res.ok) return j(404, { error: res.error });
    proposeAllowRule(res.task, note);
    agentNotes.record({ ...note, taskId: res.task.id, workspaceId: res.task.workspaceId });
    return j(202, { ok: true, taskId: res.task.id, workspaceId: res.task.workspaceId });
  }
  // --- REST: agent turn / denial / status notes on the CURRENT row ---
  // The plugin's Stop and PermissionDenied hooks post once per turn;
  // the server pins it to the agent's current row ONLY when that is
  // unambiguous — exactly one in-progress claim held. An agent holding
  // several rows gets the note kept in its ring marked `needsFiling`
  // rather than guessed onto the newest claim (the guess measured
  // wrong ~3 in 4 — see agent-notes.ts). A body `taskId` is an
  // explicit address and always wins. 202 rather than 200: the hook
  // fires with the turn already over and never reads the answer.
  if (pathname === '/api/agent-notes') {
    // Same defense-in-depth posture as the agent-watches route: no
    // share host reaches here today, and this keeps a later
    // allowlisting from letting an external reviewer write a session's
    // words onto a board row.
    if (visitor) return j(403, { error: 'not available to share visitors' });
    if (req.method !== 'POST') return j(405, { error: 'method not allowed' });
    const parsed = parseAgentNote(await safeJson(req));
    if (!parsed.ok) return j(400, { error: parsed.error, message: parsed.message });
    const { note } = parsed;
    if (note.taskId !== undefined) {
      // The caller named its row; a bad address is its error to hear,
      // not a silent ring drop.
      const res = taskStore.appendNote(note.taskId, {
        kind: note.kind,
        text: note.text,
        agent: note.agent,
        ts: note.at,
        ...(note.sessionId !== undefined ? { sessionId: note.sessionId } : {}),
      });
      if (!res.ok) return j(404, { error: res.error });
      proposeAllowRule(res.task, note);
      agentNotes.record({ ...note, taskId: res.task.id, workspaceId: res.task.workspaceId });
      return j(202, { ok: true, taskId: res.task.id, workspaceId: res.task.workspaceId });
    }
    const target = resolveNoteTarget(taskStore, note.agent);
    const task = target.task;
    if (task) {
      const res = taskStore.appendNote(task.id, {
        kind: note.kind,
        text: note.text,
        agent: note.agent,
        ts: note.at,
        ...(note.sessionId !== undefined ? { sessionId: note.sessionId } : {}),
      });
      if (!res.ok) return j(500, { error: res.error });
      proposeAllowRule(res.task, note);
    }
    agentNotes.record({
      ...note,
      ...(task ? { taskId: task.id, workspaceId: task.workspaceId } : {}),
      ...(target.ambiguous ? { needsFiling: true } : {}),
    });
    return j(202, {
      ok: true,
      ...(task ? { taskId: task.id, workspaceId: task.workspaceId } : {}),
      ...(target.ambiguous ? { needsFiling: true } : {}),
    });
  }
  const agentNotesMatch = pathname.match(/^\/api\/agents\/([^/]+)\/notes$/);
  if (agentNotesMatch) {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    if (req.method !== 'GET') return j(405, { error: 'method not allowed' });
    const agent = decodeURIComponent(agentNotesMatch[1] ?? '').trim();
    if (agent.length === 0 || agent.length > 200) return j(400, { error: 'bad agent' });
    if (isSharedAgentName(agent)) {
      return j(400, { error: SHARED_IDENTITY_ERROR, message: SHARED_IDENTITY_MESSAGE });
    }
    // Display fields only — sessionId stays in the store, like the
    // task-projection read (projectNotes) already keeps it out.
    const notes = agentNotes.list(agent).map((n) => ({
      at: n.at,
      kind: n.kind,
      text: n.text,
      agent: n.agent,
      ...(n.taskId !== undefined ? { taskId: n.taskId } : {}),
      ...(n.workspaceId !== undefined ? { workspaceId: n.workspaceId } : {}),
      ...(n.needsFiling === true ? { needsFiling: true } : {}),
    }));
    return j(200, { agent, notes });
  }
  return undefined;
}
