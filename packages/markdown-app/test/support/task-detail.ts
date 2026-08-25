/**
 * The task detail panel is a Preact island now, and this is the old call shape
 * over it.
 *
 * The panel's state reaches the island through `taskDetailData` — including
 * the handlers, which close over the task and the review rows each paint drew
 * and so cannot be bound at mount. That is the right shape for the app and the
 * wrong shape for the hundred-odd cases that only want a panel on screen, so
 * this puts the old call back: mount once per container, then write the
 * signal. A container somebody emptied (`root.replaceChildren()`) is remounted
 * rather than left dead.
 *
 * Crucially it does NOT remount on every call. A remount rebuilds everything,
 * which is the property the repaint cases exist to disprove — so calling this
 * twice with the same task is a real repaint of a live island, exactly like a
 * board event.
 */
import { options } from 'preact';
import type { HubTask } from '../../src/hub/hub-model.ts';
import type { DetailHandlers, TaskDiscussion } from '../../src/hub/hub-render.ts';
import { mountTaskDetailIsland, taskDetailData } from '../../src/hub/task-detail-island.tsx';

// Component re-renders are SCHEDULED, not synchronous: a signal write or a
// `useState` from a tap lands on the following microtask. That is invisible to
// a reader (it is still before the next paint) and very visible to a test
// asserting on the very next line, so renders are flushed inline here.
options.debounceRendering = (cb: () => void) => cb();

let mounted: { host: HTMLElement; dispose: () => void } | null = null;

export function renderTaskDetail(
  container: HTMLElement,
  task: HubTask | null,
  handlers: DetailHandlers,
  discussion?: TaskDiscussion,
): void {
  const live =
    mounted !== null &&
    mounted.host === container &&
    container.querySelector('[data-preact-island="task-detail"]') !== null;
  // Retired BEFORE the write, not after: a stale island still subscribed to
  // the signal would paint this same data into its own detached tree first,
  // and its effects (a focus, a scroll, an editor hand-over) would run twice.
  if (!live) {
    mounted?.dispose();
    mounted = null;
  }
  taskDetailData.value =
    discussion === undefined ? { task, handlers } : { task, discussion, handlers };
  if (mounted === null) {
    mounted = { host: container, dispose: mountTaskDetailIsland(container) };
  }
}

/** Dispose whatever is mounted. An island left alive keeps a subscription to
 *  the module-level signal, so the next file's first write would paint a panel
 *  into a detached node. */
export function disposeTaskDetail(): void {
  mounted?.dispose();
  mounted = null;
}
