/**
 * Where a review-queue row goes when it is opened.
 *
 * One responsibility: turn an item on the queue into the place the reader can
 * answer it. Five kinds of row land in one list — a decision on a ticket, a
 * ticket-borne review item, a thread on a task, a thread on a goal band, and a
 * comment on a document — and each of the five has a different "there". Read
 * scattered through `bootHub` they were three functions among forty; read
 * together they are the whole of "exactly the place where I need to review and
 * make the choice", which is the queue's reason for existing.
 *
 * The shared return contract is the second reason these belong in one file:
 * every opener answers whether the reader is STILL ON THIS PAGE afterwards.
 * Only the doc jump answers false, and the walkthrough keys its card repaint
 * on that answer — a repaint after `location.assign` paints over a page that
 * is leaving.
 *
 * `HubQueueOpenDeps` is the whole list of what an opener may reach. It opens a
 * task only through `boardHandlers.onOpenTask` — the ONE opener behind every
 * task tap — so a queue row and a board row open a panel the same way.
 */
import type { BootLocation } from '../boot-env.ts';
import type { BoardHandlers } from './board-island.tsx';
import type { HubState } from './hub-actions.ts';
import { type ReviewItem, reviewRow } from './hub-review-model.ts';

/** Everything the openers need from `bootHub`, and nothing else. */
export interface HubQueueOpenDeps {
  /** The board's one projection. The openers read `tasks` and write the three
   *  panel-aim fields on it. LIVE, the same contract `wireHubLive` uses. */
  state: HubState;
  /** The board a doc link is addressed within. */
  workspaceId: string;
  /** The board island's stable callbacks. Only `onOpenTask` is read: it is
   *  the one opener behind every task tap, so a queue row and a board row open
   *  the panel the same way. */
  boardHandlers: BoardHandlers;
  /** Repaint the panel, after the aim has been set. */
  renderDetail(): void;
  /** The address bar. Only `assign` is read — the doc jump leaves the page. */
  location: Pick<BootLocation, 'assign'>;
}

/** What `bootHub` keeps: the three openers. */
export interface HubQueueOpeners {
  openReviewItem(item: ReviewItem, returnItem?: string | null): boolean;
  openReviewThread(item: ReviewItem, returnItem?: string | null): boolean;
  openTaskThread(taskId: string, threadId: string): boolean;
}

export function createHubQueueOpeners(deps: HubQueueOpenDeps): HubQueueOpeners {
  const { state, workspaceId, boardHandlers, renderDetail, location } = deps;

  /**
   * "Exactly the place where I need to review and make the choice" — the
   * whole point of the queue. A decision opens its task panel; a task comment
   * opens that task's discussion; a doc comment opens the doc AT the comment
   * (`?thread=`), not the doc's top.
   *
   * Returns whether the reader is still on THIS page afterwards — false only
   * for the doc jump, which leaves via location.assign. The walkthrough's
   * hand-off keys its card repaint on it (see onOpenItem).
   *
   * `returnItem` is the reader's place in the review queue, and only the
   * walkthrough passes one. It rides the doc's URL so the doc's back arrow
   * can bring them back to the sitting rather than to the bare board — the
   * doc page has no referrer and cannot work this out for itself. Every other
   * caller omits it, which is what keeps a doc opened from a board row (or a
   * pasted link) from returning a visitor into a queue they were never in.
   */
  function openReviewItem(item: ReviewItem, returnItem?: string | null): boolean {
    // `reviewRow` is the one reader for "which task is this row about", so a
    // future band that carries a task row cannot land in the strip with a
    // chip that taps into nothing.
    const row = reviewRow(item);
    if (row) {
      boardHandlers.onOpenTask(row.task);
      return true;
    }
    const t = item.thread;
    if (!t) return true;
    if (t.kind === 'task-review') {
      // A ticket-borne review item lives on the TASK — there is no thread to
      // aim at, so the panel itself is the place. Without this branch the
      // fall-through below navigated to `/review/undefined`.
      const task = t.taskId ? state.tasks.get(t.taskId) : undefined;
      if (task) boardHandlers.onOpenTask(task);
      return true;
    }
    if (t.kind === 'goal-thread' && t.taskId) {
      // The goal PANEL, not the task panel and not the raw doc: the row is a
      // band, and the question was asked about the band. Aim at the queued
      // thread the same way a task row does — landing on the panel top is the
      // "now go find it" the queue exists to remove.
      state.detailGoalId = t.taskId;
      state.detailTaskId = null;
      state.detailThreadId = t.threadId;
      renderDetail();
      return true;
    }
    if (t.kind === 'task-thread') {
      const task = t.taskId ? state.tasks.get(t.taskId) : undefined;
      if (!task) return true;
      boardHandlers.onOpenTask(task);
      // The task is the container; the thread is the errand. On a task with
      // six discussions, landing on the panel top is the same "now go find
      // it" the strip exists to remove — so aim at the one that was queued.
      state.detailThreadId = t.threadId;
      renderDetail();
      return true;
    }
    // The doc's canonical workspace address rather than the legacy `/review/`
    // one, so what lands in the reader's address bar is the shape every other
    // surface emits and the link-chip renderer titles.
    const back = returnItem ? `&item=${encodeURIComponent(returnItem)}` : '';
    location.assign(
      `/workspaces/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(t.docId)}?thread=${encodeURIComponent(t.threadId)}${back}`,
    );
    return false;
  }

  /**
   * The thread a question on a review item lives on — the reader's question
   * and the owner's reply, where they were written. A ticket-borne item's
   * threads are on its task's doc, so this is the task panel aimed at that
   * thread, the way a `task-thread` row opens. Anything without a thread to
   * aim at falls back to opening the item itself. Same return contract as
   * `openReviewItem`: whether the reader is still on this page.
   */
  function openReviewThread(item: ReviewItem, returnItem?: string | null): boolean {
    // A revised DECISION's thread is on its task doc, like a ticket item's.
    if (item.decision && item.revision?.threadId) {
      return openTaskThread(item.decision.task.id, item.revision.threadId);
    }
    const t = item.thread;
    const threadId = item.revision?.threadId ?? t?.threadId;
    if (!t || t.kind !== 'task-review' || !t.taskId || !threadId)
      return openReviewItem(item, returnItem);
    return openTaskThread(t.taskId, threadId);
  }

  /** The task panel, aimed at one thread on it — the shared tail of
   *  `openReviewThread` and the stale-view fallback below, which knows the
   *  OPEN thread's id from a 409 rather than from the item's own fields. */
  function openTaskThread(taskId: string, threadId: string): boolean {
    const task = state.tasks.get(taskId);
    if (!task) return true;
    boardHandlers.onOpenTask(task);
    state.detailThreadId = threadId;
    renderDetail();
    return true;
  }

  return { openReviewItem, openReviewThread, openTaskThread };
}
