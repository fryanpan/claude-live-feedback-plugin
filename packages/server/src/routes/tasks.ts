/**
 * The task REST block, in the order it is matched.
 *
 * Order is preserved, not load-bearing — today. Every pattern reachable from
 * `handleTaskRoutes` is anchored (`^...$`) or an exact-equality test, and no
 * two of them can match one pathname: the `/api/refs/*` and `/api/links/*`
 * routes share no prefix with `/api/tasks/...`, and the single `([^/]+)`
 * segment in each task pattern cannot span a slash, so
 * `.../review-items/:id/withdraw` is unreachable by any field route. These
 * routes were written as one long if-chain inside `createServer`, and the
 * sequence was kept exactly through the split so the files stay auditable
 * against the pre-move closure. An earlier version of this header claimed two
 * concrete overlaps and a `route-order.test.ts`; neither existed.
 *
 * So: any future route whose pattern CAN overlap an existing one has to be
 * placed deliberately and covered by task-routes.test.ts — the order is not
 * currently guarding anything, and nothing here will catch it for you.
 *
 * Two entry points because the chain has two positions: the tasks proper,
 * and — further down, after the agent routes — dispatches and notes.
 */
import { handleDispatchAndNoteRoutes } from './dispatch-and-notes.ts';
import { handleTaskAnswers } from './task-answers.ts';
import { handleTaskFields } from './task-fields.ts';
import { handleTaskReviewItems } from './task-review-items.ts';
import type { TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';
import { handleTaskStatusAndLinks } from './task-status-links.ts';
import { handleTaskBatch } from './tasks-batch.ts';
import { handleTaskListCreate } from './tasks-list-create.ts';

export type { ReviewGate, TaskRouteRequest, TaskRoutesContext } from './task-routes-context.ts';
export { handleDispatchAndNoteRoutes };

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
