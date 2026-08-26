/**
 * The goal detail panel is a Preact island now, and this is the old call shape
 * over it.
 *
 * Same shim as `task-detail.ts`, for the same reason: the panel's state reaches
 * the island through `goalDetailData` — handlers included, since they close
 * over the section and the clock each paint resolved — and that is the right
 * shape for the app and the wrong shape for the behavioural cases that only
 * want a panel on screen.
 *
 * Crucially it does NOT remount on every call. A remount rebuilds everything,
 * which is the property the repaint cases exist to disprove, so calling this
 * twice with the same goal is a real repaint of a live island.
 */
import { options } from 'preact';
import { goalDetailData, mountGoalDetailIsland } from '../../src/hub/goal-detail-island.tsx';
import type { BoardSection } from '../../src/hub/hub-model.ts';
import type { GoalDetailHandlers, TaskDiscussion } from '../../src/hub/hub-render.ts';

// A signal write re-renders on the next microtask — still before the next
// paint, and still after the next line of a test. Flushed inline.
options.debounceRendering = (cb: () => void) => cb();

let mounted: { host: HTMLElement; dispose: () => void } | null = null;

export function renderGoalDetail(
  container: HTMLElement,
  section: BoardSection | null,
  handlers: GoalDetailHandlers,
  discussion?: TaskDiscussion,
): void {
  const live =
    mounted !== null &&
    mounted.host === container &&
    container.querySelector('[data-preact-island="goal-detail"]') !== null;
  // Retired BEFORE the write: a stale island still subscribed to the signal
  // would paint this same data into its own detached tree first, and its
  // effects would run twice.
  if (!live) {
    mounted?.dispose();
    mounted = null;
  }
  goalDetailData.value =
    discussion === undefined ? { section, handlers } : { section, discussion, handlers };
  if (mounted === null) {
    mounted = { host: container, dispose: mountGoalDetailIsland(container) };
  }
}

/** Dispose whatever is mounted. An island left alive keeps a subscription to
 *  the module-level signal, so the next file's first write would paint into a
 *  detached node. */
export function disposeGoalDetail(): void {
  mounted?.dispose();
  mounted = null;
}
