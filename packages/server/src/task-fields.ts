/**
 * Small pure facts about ONE task row — read or written without the store.
 *
 * Their own LEAF module, and that is the whole point: `TaskStore` needs them
 * and so does the review-item store, and a helper left in tasks.ts would
 * force the review-item module to import the very file that imports it.
 * Nothing here touches the disk, the clock or a workspace.
 */
import { randomBytes } from 'node:crypto';
import type { Task } from '@feedback/core/task-wire';

/**
 * Is this row archived — soft-deleted, off every lane and every queue, and one
 * call from coming back?
 *
 * The ONE reader of `archivedAt`, deliberately: "archived" has to mean the
 * same thing to the board, the queue and the nudger, and a second comparison
 * of the field with a different default is how two surfaces come to disagree
 * about the same row.
 */
export function isArchived(task: { archivedAt?: number }): boolean {
  return task.archivedAt !== undefined;
}

/**
 * This row's words-and-goal revision, with the pre-field absence resolved.
 * One reader so the `?? 0` cannot disagree with itself across call sites —
 * the same shape `bodyWrittenAtOf` uses for `bodyWrittenAt`.
 */
export function wordsRevisionOf(task: { wordsRevision?: number }): number {
  return task.wordsRevision ?? 0;
}

/**
 * Advance the row's words-and-goal revision — the single definition of that
 * write, so the two stores that perform it cannot disagree about what it
 * means. `TaskStore` calls it from the four places a scoring run's inputs
 * actually move (the one title writer, the two `bodyWrittenAt` stamps, the
 * two goal assignments); the review-item store calls it when a decision's
 * OPTIONS moved and nothing else did.
 *
 * Every caller bumps BEFORE emitting the event that re-triggers scoring,
 * which is what makes the fresh run capture the post-edit value and the
 * overtaken run capture something strictly smaller.
 */
export function bumpWordsRevision(task: { wordsRevision?: number }): void {
  task.wordsRevision = wordsRevisionOf(task) + 1;
}

/**
 * Who is ASKING the decision a ticket carries — the display name every
 * surface spells after "Asked by". One reader for three writers (the derived
 * legacy review item, the board projection, and through those the REST
 * queue), so the Home card, the task panel and `GET /review-items` cannot
 * name three different people for one question.
 *
 * The creator when the row recorded one; otherwise whoever first moved the
 * ticket, which is the only actor a row written before `createdBy` holds and
 * is what the Home card named all along. Empty — never invented — when the
 * row holds neither, and the card then states the clock alone.
 */
export function taskAskedBy(task: Pick<Task, 'createdBy' | 'transitions'>): string {
  const created = task.createdBy?.trim();
  if (created) return created;
  return task.transitions[0]?.by.name?.trim() ?? '';
}

/** An opaque, server-generated id under a one-letter namespace. */
export function cryptoId(prefix: string): string {
  // 9 random bytes → 12 base64url chars. URL-safe, filename-safe, and every
  // char is legal in a docId (the future `task:<id>` body docs need that).
  return `${prefix}-${randomBytes(9).toString('base64url')}`;
}
