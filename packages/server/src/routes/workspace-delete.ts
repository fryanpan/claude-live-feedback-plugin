/**
 * `DELETE /workspaces/<id>` — the board, and ONLY the board.
 *
 * It used to front two stores, dispatching on whether the id named a board and
 * falling through to the review destroy when it did not. That fall-through
 * was compatibility: `delete_workspace(reviewId)` was what every shipped
 * plugin bundle and skill called, from sessions nobody could restart.
 *
 * It is gone with the canonical cutover (owner's call), and the reason is the
 * cutover's own shape rather than tidiness. A review is not a board and never
 * was; it is a resource a board holds, so it is addressed under the board that
 * holds it — `DELETE /workspaces/<ws>/reviews/<setId>`, which the archive
 * family serves and which the scope middleware checks the pair of ids on. One
 * id in the board's slot could only ever mean one of the two things, and the
 * store that happened to know it was what decided which: an id that both
 * stores knew would have been destroyed by whichever was asked first.
 *
 * WHAT THIS COSTS, stated rather than discovered: a session still holding a
 * pre-cutover bundle that calls `delete_workspace(reviewId)` now gets a 404
 * instead of a destroyed review. That is the intended direction of the
 * failure — the whole cutover ships as one version bump with a session
 * restart behind it, and a stale caller failing to delete is the safe half of
 * "no old-path support".
 */
import type { WorkspaceDeleteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleWorkspaceDelete(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceDeleteRequest,
): Promise<Response | undefined> {
  const { taskStore, taskProjection, docStore, j } = ctx;
  const { req, pathname, url } = rq;
  const wsDeleteMatch = pathname.match(/^\/workspaces\/([^/]+)$/);
  if (wsDeleteMatch && req.method === 'DELETE') {
    const workspaceId = decodeURIComponent(wsDeleteMatch[1] ?? '');
    const force = url.searchParams.get('force') === 'true';
    // A board, or nothing. An id this store does not know answers not-found
    // rather than being handed to the review store — see the header.
    if (taskStore.getWorkspace(workspaceId)) {
      const openTasks = taskStore.openTaskCount(workspaceId) ?? 0;
      if (openTasks > 0 && !force) {
        return j(409, { ok: false, error: 'has-open-tasks', openTasks });
      }
      // Three steps, ordered so that nothing irreversible happens
      // while the operation can still fail. (1) STAGE the docs' files
      // — a rename, so it proves they are removable and can be undone;
      // orphan .ydocs must not outlive the board, because once the
      // store entry is gone the id no longer resolves as a board and
      // nothing can come back for them. (2) Delete the board: the
      // commit point. (3) Only now tear the live docs down, which
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
      // The docs this board LINKED, captured before the delete: the board
      // record is the only thing that remembers them.
      const linkedDocIds = taskStore.getWorkspace(workspaceId)?.docIds ?? [];
      const taskIds = taskStore.listTasks(workspaceId, { includeArchived: true }).map((t) => t.id);
      if (!taskProjection.stageWorkspaceFiles(workspaceId, taskIds).ok) {
        taskProjection.unstageWorkspaceFiles(workspaceId, taskIds);
        return j(500, { ok: false, error: 'docs-cleanup-failed' });
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
      taskProjection.dropWorkspaceDocs(workspaceId, board.taskIds);
      // A linked doc that ANOTHER board still holds keeps working and is left
      // exactly as it was — that is what `attachDoc` being a link means, and
      // the test above pins it.
      //
      // A doc this board was the ONLY holder of is the case that reasoning
      // never covered. It has just lost its last address: a doc is reachable
      // only THROUGH a board, so it would sit in the live store holding its
      // content and its comment threads with no URL in the product reaching
      // either, and nothing would ever surface it. Archive it instead —
      // reversible with `unarchiveDoc`, and the markdown on disk is untouched
      // either way. Eleven docs reached exactly this state on this deployment.
      //
      // The refusals answer themselves and are meant to be ignored here: a
      // review's member archives with its set rather than alone, and
      // `task:`/`ws:` docs were already torn down by the staging above.
      const stillHeld = new Set(taskStore.listWorkspaces().flatMap((w) => w.docIds ?? []));
      let archivedDocs = 0;
      for (const docId of linkedDocIds) {
        if (stillHeld.has(docId)) continue;
        const res = docStore.archiveDoc(docId, {
          archivedBy: 'board deleted',
          reason: `the only board holding it (${workspaceId}) was deleted`,
        });
        if (res.ok) archivedDocs++;
      }
      return j(200, { ok: true, deletedTasks: board.deletedTasks, archivedDocs });
    }
    return j(404, { ok: false, error: 'not-found' });
  }
  return undefined;
}
