/**
 * What the boot URL claimed, resolved against a projection that has not
 * landed yet.
 *
 * One responsibility, and it is a piece of timing rather than a piece of UI:
 * `?task=`, `?goal=`, `?thread=` and `?item=` are written into `BoardState`
 * before the first paint (see `bootLoc` in `bootBoard`), so what is left is the
 * WAITING. The board's rows arrive over the ydoc after that paint, which
 * means "not here yet" and "not here" are indistinguishable until a deadline
 * says so — one deadline, `WALK_HANDOFF_DEADLINE_MS`, shared by both claims
 * because they are the same bet about the same sync.
 *
 * `?walk=1` is the third claim and belongs with them for the same reason,
 * with one extra rule: it waits for BOTH halves of the queue. The review
 * items come over REST and the tasks they rank against come over the ydoc, so
 * a walk opened on one half alone aims at a head the other half re-ranks to
 * the bottom — measured as "Review all" landing on N of N. `walkHandoffReady`
 * is the pure half of that decision; `walkSources` is what fills it in.
 *
 * Every claim is ONE-SHOT. An SSE-driven reload must not re-open a
 * walkthrough the reader closed, and a Back press means the reader left the
 * claim behind — which is why `bootBoard` keeps the three pending `let`s next
 * to the address bar and this module reaches them through `BootClaims`.
 */
import type { BootLocation } from '../boot-env.ts';
import { type BoardState, showToast } from './board-actions.ts';
import { goalSection } from './board-model.ts';
import {
  type ReviewItem,
  type ReviewQueue,
  type WalkSources,
  walkHandoff,
  walkHandoffReady,
  walkNextUrl,
} from './board-review-model.ts';
import { type BoardLocation } from './board-url.ts';

/** How long an armed ?walk=1 handoff waits for the board to produce a queue
 *  before concluding it is genuinely clear. Generous against a slow ydoc
 *  sync; short enough that a truly cleared board hands off while the reader
 *  is still looking at it. Shared with the ?task=/?goal=/?item= deadline:
 *  same bet, same sync. */
export const WALK_HANDOFF_DEADLINE_MS = 4000;

/** The boot URL's unresolved claims, owned by `bootBoard` because the address
 *  bar and the detail panel read them too. */
export interface BootClaims {
  /** The `?item=` key still waiting for a queue that holds it. */
  item(): string | null;
  /** Give up on `?item=` — it was opened, or it was never coming. */
  clearItem(): void;
  /** Give up on `?goal=` — after this, `renderDetail` may close an
   *  unconfirmed goal panel the way it closes one that left the board. */
  clearGoal(): void;
}

/** Everything the waiting needs from `bootBoard`, and nothing else. */
export interface BoardDeepLinkDeps {
  /** The board's one projection — what the claims are checked against. LIVE. */
  state: BoardState;
  /** What the address said at boot, parsed. */
  bootLoc: BoardLocation;
  /** The address bar. `search` arms the handoff; `href` hops the chain. */
  location: Pick<BootLocation, 'search'> & { href: string };
  /** The queue as it stands right now — re-derived, never cached. */
  currentQueue(): ReviewQueue;
  /** Which halves of the queue have landed. LIVE — `bootBoard` writes it from
   *  the ydoc's onReady and from every review-items load. */
  walkSources: WalkSources;
  /** Open the queue's item at a position, as a sitting. */
  openInQueue(item: ReviewItem, index: number): void;
  /** Start a sitting from the top of the queue. */
  startWalkthrough(): void;
  /** The one writer of the address bar. */
  syncBoardUrl(): void;
  renderDetail(): void;
  /** The three pending claims `bootBoard` holds beside the address bar. */
  boot: BootClaims;
}

/** What `bootBoard` keeps. */
export interface BoardDeepLinks {
  /** Re-check every armed claim. Called from the ydoc's initial sync, its
   *  observer, and each review-items load — whichever arrives first. */
  deepLinkTick(): void;
  /** The sitting for THIS board is over; hand the reader to the next board
   *  in the `?then=` chain. `bootBoard` gives this to the walkthrough. */
  chainWalkDrain(): void;
}

export function createBoardDeepLinks(deps: BoardDeepLinkDeps): BoardDeepLinks {
  const {
    state,
    bootLoc,
    location,
    currentQueue,
    walkSources,
    openInQueue,
    startWalkthrough,
    syncBoardUrl,
    renderDetail,
    boot,
  } = deps;

  const maybeOpenBootItem = (): void => {
    const pendingBootItem = boot.item();
    if (!pendingBootItem) return;
    const q = currentQueue();
    const idx = q.items.findIndex((i) => i.key === pendingBootItem);
    const item = q.items[idx];
    if (!item) return; // don't burn — the projection may still be coming
    boot.clearItem();
    openInQueue(item, idx);
  };
  if (bootLoc.task || bootLoc.goal || bootLoc.item) {
    setTimeout(() => {
      if (boot.item()) {
        boot.clearItem();
        showToast('That review item is not in the queue any more — it may already be answered.');
        syncBoardUrl();
      }
      boot.clearGoal();
      const goneTask =
        bootLoc.task !== null &&
        state.detailTaskId === bootLoc.task &&
        !state.tasks.has(bootLoc.task);
      // `goalSection` rather than a scan of the board's own sections, because
      // an archived goal is on no board at all. The scan this replaces called
      // that "gone" and closed the panel four seconds after it opened.
      const goneGoal =
        bootLoc.goal !== null &&
        state.detailGoalId === bootLoc.goal &&
        goalSection(state.info?.goals ?? [], bootLoc.goal) === null;
      if (goneTask || goneGoal) {
        state.detailTaskId = null;
        state.detailGoalId = null;
        state.detailThreadId = null;
        showToast('Nothing on this board matches that link — it may be outdated.');
        renderDetail();
      }
    }, WALK_HANDOFF_DEADLINE_MS);
  }

  // Deep link from the landing page's review chip / "Review all" bar:
  // ?walk=1 opens the walkthrough once the queue arrives, and ?then= names
  // the workspaces to visit after this one drains (walkNextUrl hops there).
  // One-shot — SSE-driven reloads must not re-open a walkthrough the reader
  // closed, so the flag burns on first use.
  const handoff = walkHandoff(location.search);
  let pendingWalk = handoff.walk && state.pane === 'home';
  const maybeAutoWalk = (deadlinePassed = false): void => {
    if (!pendingWalk) return;
    // Neither half landing alone burns the flag: on a cold connection the
    // ydoc task projection (decisions, and the tasks threads rank against)
    // and the review-items list arrive in either order, and a walk opened on
    // one half aims at a head the other half re-ranks to the bottom. The
    // projection's onReady, its observer, and every review-items load call
    // back in; only the deadline below stops waiting.
    if (!walkHandoffReady(currentQueue(), walkSources, deadlinePassed)) return;
    pendingWalk = false;
    startWalkthrough();
  };
  const deepLinkTick = (): void => {
    maybeAutoWalk();
    maybeOpenBootItem();
  };
  if (pendingWalk) {
    // Still nothing by now and the sync has had its chance: the board is
    // genuinely clear (someone answered since the landing page rendered).
    // Hop to the next board holding items, or stand down on Home.
    setTimeout(() => {
      if (!pendingWalk) return;
      // Whatever has landed by now is the queue: open on it. Only a board
      // with nothing in hand is clear enough to hop.
      maybeAutoWalk(true);
      if (!pendingWalk) return;
      pendingWalk = false;
      const next = walkNextUrl(handoff.chain);
      if (next) location.href = next;
    }, WALK_HANDOFF_DEADLINE_MS);
  }
  const chainWalkDrain = (): void => {
    // The sitting for THIS board is over; hand the reader to the next board
    // in the chain rather than dead-ending on the cleared card.
    const next = walkNextUrl(handoff.chain);
    if (next) location.href = next;
  };

  return { deepLinkTick, chainWalkDrain };
}
