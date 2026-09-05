/**
 * The one DELETE that fronts two stores, dispatching on whether the id names a board.
 *
 * Lifted verbatim out of `createServer`'s request closure; the handlers
 * read their collaborators off `WorkspaceRoutesContext` instead of the scope.
 */
import type { WorkspaceDeleteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleWorkspaceDelete(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceDeleteRequest,
): Promise<Response | undefined> {
  const { taskStore, taskProjection, j } = ctx;
  const { req, pathname, url, deleteReview } = rq;
  const wsDeleteMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
  if (wsDeleteMatch && req.method === 'DELETE') {
    const workspaceId = decodeURIComponent(wsDeleteMatch[1] ?? '');
    const force = url.searchParams.get('force') === 'true';
    // COMPAT — this ONE route fronts two stores, dispatching by id, and
    // it is the last place that does. A board is what it deletes now;
    // a review id still resolves because `delete_workspace(reviewId)` is
    // what every shipped plugin bundle and skill has always called, from
    // sessions nobody can restart. New callers use DELETE
    // /api/reviews/<setId> above, which cannot touch a board at all.
    // Ask the task store first: `rooms.deleteWorkspace` enumerates DOC
    // members, so a board — which has none — always came back not-found,
    // and a board created for a five-minute experiment was permanent.
    if (taskStore.getWorkspace(workspaceId)) {
      const openTasks = taskStore.openTaskCount(workspaceId) ?? 0;
      if (openTasks > 0 && !force) {
        return j(409, { ok: false, error: 'has-open-tasks', openTasks });
      }
      // Three steps, ordered so that nothing irreversible happens
      // while the operation can still fail. (1) STAGE the rooms' files
      // — a rename, so it proves they are removable and can be undone;
      // orphan .ydocs must not outlive the board, because once the
      // store entry is gone the id no longer resolves as a board and
      // nothing can come back for them. (2) Delete the board: the
      // commit point. (3) Only now tear the live rooms down, which
      // destroys each task's discussion threads and is therefore the
      // one step that must never run ahead of a refusal. Both failure
      // paths unstage, so a failed DELETE costs nothing at all — not
      // even to a restart that lands right after it.
      // Attached docs are untouched throughout: attachDoc is a LINK,
      // so a doc a deleted board merely cited keeps working.
      // Archived rows included: each still owns a `.ydoc`, and a stage
      // that skipped them would orphan those files under a board that
      // no longer exists — the exact outcome the staging step exists to
      // prevent.
      const taskIds = taskStore.listTasks(workspaceId, { includeArchived: true }).map((t) => t.id);
      if (!taskProjection.stageWorkspaceFiles(workspaceId, taskIds).ok) {
        taskProjection.unstageWorkspaceFiles(workspaceId, taskIds);
        return j(500, { ok: false, error: 'rooms-cleanup-failed' });
      }
      // force: the open-task guard was applied above.
      const board = taskStore.deleteWorkspace(workspaceId, { force: true });
      if (!board.ok) {
        taskProjection.unstageWorkspaceFiles(workspaceId, taskIds);
        // 'persist-failed' is a 500, not a 404: the board is still
        // there, and the caller must not read the refusal as "already
        // gone" and stop asking.
        return j(board.error === 'persist-failed' ? 500 : 404, board);
      }
      taskProjection.dropWorkspaceRooms(workspaceId, board.taskIds);
      return j(200, { ok: true, deletedTasks: board.deletedTasks });
    }
    return deleteReview(workspaceId, force, url.searchParams.get('purge') === 'true');
  }
  return undefined;
}
