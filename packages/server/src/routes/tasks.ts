/**
 * The task REST block, in the order it is matched.
 *
 * Order is behaviour here, not style. These routes were written as one long
 * if-chain inside `createServer`, and two of them overlap enough that their
 * positions matter: `/api/tasks/:id/links` is tested before
 * `/api/refs/backlinks`, and `.../review-items/:id/withdraw` before the
 * fields below it. Splitting the chain into files kept the sequence exactly,
 * and `route-order.test.ts` asserts it.
 */
import { handleTaskAnswers } from './task-answers.ts';
import { handleTaskFields } from './task-fields.ts';
import { handleTaskReviewItems } from './task-review-items.ts';
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';
import { handleTaskStatusAndLinks } from './task-status-links.ts';
import { handleTaskBatch } from './tasks-batch.ts';
import { handleTaskListCreate } from './tasks-list-create.ts';

export type { ReviewGate, TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';

/**
 * The task routes, tried in source order. `undefined` means none of them
 * matched and the caller's chain continues.
 */
export async function handleTaskRoutes(
  ctx: TaskRoutesContext,
  rq: TaskRouteRequest,
): Promise<Response | undefined> {
  return (
    (await handleTaskListCreate(ctx, rq)) ??
    (await handleTaskBatch(ctx, rq)) ??
    (await handleTaskStatusAndLinks(ctx, rq)) ??
    (await handleTaskAnswers(ctx, rq)) ??
    (await handleTaskReviewItems(ctx, rq)) ??
    (await handleTaskFields(ctx, rq))
  );
}
