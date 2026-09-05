/**
 * The Preact islands this page mounts ONCE, and the stable handlers they keep.
 *
 * One responsibility, and it is a lifetime rather than a feature: every island
 * below owns a wrapper inside its host from the moment it is mounted, and no
 * vanilla code may wipe that host again (the contract `island-probe.tsx`
 * states). So all seven mounts happen here, in one place, immediately after
 * `buildShell` — the last vanilla write of `#board-root` — and each is a mount
 * rather than a render because everything an island holds that the DOM does
 * not (a half-typed answer, an expansion the reader opened, a long-press in
 * progress, focus on a keyed row) used to die with the nodes each repaint
 * replaced. What changes per paint travels through the signals instead, from
 * the region modules.
 *
 * `#board` is deliberately NOT here: it is mounted at the very bottom of
 * boot, after the deep-link arming, because its host is the one the restore
 * list used to share and the ordering of that mount is load-bearing.
 *
 * `BoardIslandDeps` is the whole list of what a handler may reach. Every verb on
 * it arrives as a thunk: the islands mount before the regions and the review
 * controller are built, and a handler is only ever called by a tap long after
 * boot has finished — which is exactly the cycle a thunk exists to resolve.
 */
import type { Thread, User } from '@feedback/core';
import type { BootLocation } from '../boot-env.ts';
import { type BoardState, showToast } from './board-actions.ts';
import type { BoardTask } from './board-model.ts';
import type { ReviewItem } from './board-review-model.ts';
import { mountGoalDetailIsland } from './goal-detail-island.tsx';
import { mountHomeActivityIsland } from './home-activity-island.tsx';
import { mountHomeReviewIsland } from './home-review-island.tsx';
import { mountDriftIsland, mountPresenceIsland } from './presence-island.tsx';
import { type DetailTab, mountTaskDetailIsland } from './task-detail-island.tsx';
import { mountWalkthroughIsland } from './walkthrough-island.tsx';

/** Everything the islands' handlers need from `bootBoard`, and nothing else. */
export interface BoardIslandDeps {
  /** The board's one projection: the row a tap names, and the followed chip. */
  state: BoardState;
  /** Who is reading — the activity pane stamps its own comments. */
  user: User;
  /** `getElementById`, already narrowed — `bootBoard`'s own `el`. */
  el(id: string): HTMLElement;
  /** The address bar. Only `assign` is read — a presence chip leaves for the
   *  doc that person is in. */
  location: Pick<BootLocation, 'assign'>;
  /** Open the queue's item at a position, as a sitting. */
  openInQueue(item: ReviewItem, index: number): void;
  /** Open one queue item where it can be answered. */
  openReviewItem(item: ReviewItem): boolean;
  /** The same, aimed at the item's thread. */
  openReviewThread(item: ReviewItem): boolean;
  /** Start a sitting from the top of the queue. */
  startWalkthrough(): void;
  /** The one opener behind every task tap. */
  openTaskDetail(task: BoardTask, tab?: DetailTab): void;
  /** The Home activity pane's two writes — the same thread on the task's doc
   *  the panel's own Activity tab posts to. */
  commentOnActivity(taskId: string, phrase: { text: string }, text: string): Promise<Thread | null>;
  replyOnActivity(taskId: string, threadId: string, text: string): Promise<Thread | null>;
  /** Repaint the presence strip, after a long-press changed who is followed. */
  renderPresenceRegion(): void;
}

/**
 * Mount every island the board keeps for the life of the page.
 *
 * Call once, straight after `buildShell`. Nothing here renders anything: the
 * first paint of each island arrives with the first signal write from its
 * region.
 */
export function mountBoardIslands(deps: BoardIslandDeps): void {
  const {
    state,
    user,
    el,
    location,
    openInQueue,
    openReviewItem,
    openReviewThread,
    startWalkthrough,
    openTaskDetail,
    commentOnActivity,
    replyOnActivity,
    renderPresenceRegion,
  } = deps;

  // The "For Your Review" pane — the first real Preact island (contract per
  // island-probe: it owns a wrapper inside #board-home-review, and no vanilla
  // code may wipe that container while the island lives in it). Mounted once,
  // here, because buildShell above was the last vanilla write of this subtree;
  // from now on the pane repaints itself from `homeReviewData` writes in
  // renderHomeRegion. The handlers reach the same stable closures the vanilla
  // renderer received.
  mountHomeReviewIsland(el('board-home-review'), {
    onReview: (item, index) => openInQueue(item, index),
    onOpen: (item) => openReviewItem(item),
    onOpenThread: (item) => void openReviewThread(item),
    onWalkthrough: () => startWalkthrough(),
  });

  // "Recent activity" — the second island on Home, under the queue and above
  // the brief (approved mock, 2026-08-29). Same contract, same mount-once
  // reason. Its one handler opens the task the way a queue row does;
  // `boardHandlers` is built by the board region and only read when a row is
  // tapped.
  mountHomeActivityIsland(
    el('board-home-activity'),
    {
      onOpenTask: (taskId) => {
        const task = state.tasks.get(taskId);
        // On the Activity tab: the reader was looking at what happened to
        // the task, and the panel opens on the rest of that.
        if (task) openTaskDetail(task, 'activity');
      },
      onComment: (taskId, phrase, text) => commentOnActivity(taskId, phrase, text),
      onReply: (taskId, threadId, text) => replyOnActivity(taskId, threadId, text),
    },
    user,
  );

  // The card that pane opens on — the walkthrough. Mounted once for the
  // reason the board island is: this surface is repainted by every board
  // event, and everything the card holds (a half-typed answer, an expansion
  // the reader opened) used to die with the nodes each repaint replaced.
  // It takes no handlers here; they change per paint and ride the signal.
  mountWalkthroughIsland(el('board-walkthrough'));

  // The task detail panel. Mounted once for the same reason again: it is
  // repainted by every `thread.*` and `task.transitioned` event, and the tab,
  // the review queue's position, an unfolded capture and every half-typed
  // draft used to die with the nodes each repaint replaced. Handlers ride
  // `taskDetailData` — they close over the task, the review rows and the clock
  // this paint resolved.
  mountTaskDetailIsland(el('board-detail'));
  mountGoalDetailIsland(el('board-goal-detail'));

  // The presence strip, in both places it renders: who is here in the
  // top-right cluster, and the drift notices in the settings panel. Same
  // contract, and mounted once for the same reason — the strip repaints on
  // every awareness update and a 30s tick, and a rebuilt circle used to drop
  // the long-press running on it.
  mountPresenceIsland(
    el('board-people'),
    {
      onTap: (chip) => {
        if (chip.docId) location.assign(`/review/${encodeURIComponent(chip.docId)}`);
      },
      onLongPress: (chip) => {
        state.followedKey = state.followedKey === chip.key ? null : chip.key;
        showToast(
          state.followedKey
            ? `Following ${chip.label} — long-press again to stop`
            : 'Stopped following',
        );
        renderPresenceRegion();
      },
      // The "+N" circle's names have to reach a touch screen, where a title
      // attribute never shows. A toast is enough: it answers "who else".
      onOverflow: (hiddenChips) =>
        showToast(`Also here: ${hiddenChips.map((c) => c.label).join(', ')}`),
    },
    { compact: true },
  );
  mountDriftIsland(el('board-drift'));
}
