/**
 * The workspace REST block, in the order it is matched.
 *
 * Order is behaviour here, not style. These routes were written as one long
 * if-chain inside `createServer`, and the chain is walked top to bottom, so
 * a route that moves up or down can start answering a path that used to
 * reach a different one. Splitting the chain into files kept the sequence
 * exactly. Nothing in the suite asserts the ORDER on its own — the guard is
 * the per-route HTTP tests (attachments.test.ts, delete-workspace.test.ts,
 * the goal-*.test.ts family and the board-*.test.ts family), each of which
 * fails if its path starts reaching a different handler.
 *
 * FOUR entry points because the block sits in four places, not one. The task
 * routes run between the board's own routes and its goal list; five hundred
 * lines of chat-audit, plugin, push and deploy routes run between the goals
 * and the agent attachments; and the archive routes run between those and
 * the DELETE. Each entry point is called from the position its routes
 * occupied, so nothing overtakes anything.
 */
import { handleWorkspaceAttachments } from './workspace-attachments.ts';
import { handleWorkspaceContent } from './workspace-content.ts';
import { handleWorkspaceDelete } from './workspace-delete.ts';
import { handleWorkspaceGoals } from './workspace-goals.ts';
import { handleWorkspaceHome } from './workspace-home.ts';
import { handleWorkspaceNext } from './workspace-next.ts';
import { handleWorkspaceRelated } from './workspace-related.ts';
import type {
  WorkspaceDeleteRequest,
  WorkspaceRouteRequest,
  WorkspaceRoutesContext,
} from './workspace-routes-context.ts';
import { handleWorkspaceSettings } from './workspace-settings.ts';
import { handleWorkspaceCreateRead } from './workspaces-create-read.ts';

export type {
  WorkspaceDeleteRequest,
  WorkspaceRouteRequest,
  WorkspaceRoutesContext,
} from './workspace-routes-context.ts';

/**
 * The board's own routes, tried in source order. `undefined` means none of
 * them matched and the caller's chain continues.
 */
export async function handleWorkspaceRoutes(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  return (
    (await handleWorkspaceCreateRead(ctx, rq)) ??
    (await handleWorkspaceHome(ctx, rq)) ??
    (await handleWorkspaceNext(ctx, rq)) ??
    // Reads the board's goals and plan docs to answer "is somebody already
    // planning this". Above the settings block only because that is where it
    // was added; its path matches nothing else, anchored like every regex
    // here, so its position carries no behaviour.
    (await handleWorkspaceRelated(ctx, rq)) ??
    (await handleWorkspaceSettings(ctx, rq)) ??
    (await handleWorkspaceContent(ctx, rq))
  );
}

/** The band archive/restore pair and the ordered goal list, below the tasks. */
export async function handleWorkspaceGoalRoutes(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  return await handleWorkspaceGoals(ctx, rq);
}

/** Which agents are attached to a board, and the receipts that clear them. */
export async function handleWorkspaceAttachmentRoutes(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  return await handleWorkspaceAttachments(ctx, rq);
}

/** The board delete, which sits below the review and doc archive routes. */
export async function handleWorkspaceDeleteRoute(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceDeleteRequest,
): Promise<Response | undefined> {
  return await handleWorkspaceDelete(ctx, rq);
}
