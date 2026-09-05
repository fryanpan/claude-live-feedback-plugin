import type { Task } from '@feedback/core/task-wire';
import type {
  BoardWorkspace,
  DecisionAnswerWithdrawnEvent,
  DecisionAnsweredEvent,
  DecisionInfoRequestedEvent,
  RenameTaskResult,
  ReviewItemAddedEvent,
  ReviewItemRevisedEvent,
  ReviewItemWithdrawnEvent,
} from '../tasks.ts';

/**
 * The six board events a review item can cause — and no others.
 *
 * Narrower than `TaskStoreEvent` on purpose: the whole union would let this
 * module emit a transition or an archive, which is exactly the reach the
 * split exists to take away. Assignable INTO `TaskStoreEvent`, so the store
 * that owns the fan-out accepts these unchanged.
 */
export type ReviewItemStoreEvent =
  | DecisionAnsweredEvent
  | DecisionAnswerWithdrawnEvent
  | DecisionInfoRequestedEvent
  | ReviewItemAddedEvent
  | ReviewItemRevisedEvent
  | ReviewItemWithdrawnEvent;

/**
 * Everything `ReviewItemStore` needs from the world, and nothing else.
 *
 * Declared HERE rather than in tasks.ts, by the module that consumes it:
 * that is what makes the dependency one-way and readable. `TaskStore`
 * satisfies it with an adapter, and so can a plain object in a test — the
 * store has never held a `TaskStore` and cannot reach one.
 *
 * The rows handed back are LIVE: the review verbs mutate the task they are
 * given and then call `save`, exactly as they did while they lived inside
 * the store. A copy here would make every write a silent no-op, so this
 * contract is explicit about it rather than leaving it to be discovered.
 */
export interface ReviewItemPersistence {
  /** The live row, or undefined when no such ticket exists. */
  getTask(taskId: string): Task | undefined;
  /** Every live row on a board, in board order. Empty for a board that does
   *  not exist — the callers here treat "no board" and "no rows" alike. */
  listTasksIn(workspaceId: string): Iterable<Task>;
  /** Every board id, for the lookup that addresses an item by bare id. */
  listWorkspaceIds(): Iterable<string>;
  /** The board's own record — read AND written for the judging criteria,
   *  which is a workspace setting rather than a task field. */
  getWorkspaceRecord(workspaceId: string): BoardWorkspace | undefined;
  /** Persist a board's rows after a mutation (debounced by the owner). */
  save(workspaceId: string): void;
  /** Publish one board event; the owner appends the audit line and fans out. */
  emit(event: ReviewItemStoreEvent): void;
  /** Wall clock, injectable so a test can hold it still. */
  now(): number;
  /**
   * The body door — stamps `bodyWrittenAt`, bumps the words revision,
   * applies the title in the same act and emits ONE `task.body_edited`.
   * Rewriting a ticket's own decision writes its detail through here rather
   * than assigning `task.body`, which is what keeps the audit trail
   * identical whichever door the words moved through.
   */
  noteBodyEdited(
    taskId: string,
    opts: { actor: { id: string; name: string; kind?: string }; title?: string; reason?: string },
  ): boolean;
  /** The title door, for the same reason. */
  renameTask(
    taskId: string,
    title: string,
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): RenameTaskResult;
}
