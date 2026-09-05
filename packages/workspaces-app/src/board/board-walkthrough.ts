/**
 * The Home walkthrough: where the reader stands in the review queue, what
 * answering a card does to that position, and the one render that draws it.
 *
 * One responsibility, and it is a subtle one. The walk re-derives its queue
 * from the live projection on every render and holds its place as an INDEX
 * plus a KEY rather than as a task id, so that answering the card you are on
 * drops it out of the queue and the same index lands on the next one. Every
 * function here exists to keep that invariant true across a repaint, a
 * history step, and a peer answering the same item from another tab. Read
 * together they are a small state machine; read scattered through `bootBoard`
 * they were four functions that happened to touch the same three fields.
 *
 * What did NOT move is the boot handoff — `chainWalkDrain`, `autoWalkTick`
 * and `walkSources` stay in `bootBoard`, because they are wired from the
 * landing page's `?walk=1` and read by the deep-link deadline at the bottom
 * of boot. The drain reaches this file as `onQueueDrained`, which is the
 * only one of the three the walk itself calls.
 *
 * The store holds no board: `BoardWalkthroughDeps` is the whole list of what a
 * walk verb may reach. The three review-write callbacks arrive as thunks
 * because `createBoardReviewController` takes `render` as one of ITS inputs —
 * the cycle is real and predates this file, and a thunk is how it was
 * already resolved inside the closure.
 */
import type { BoardState } from './board-actions.ts';
import type { BoardTask } from './board-model.ts';
import {
  CLOSED_WALK,
  type ReviewItem,
  type ReviewQueue,
  type WalkAim,
  advanceWalk,
  walkAimAfterOpen,
  walkPosition,
} from './board-review-model.ts';
import { walkthroughData } from './walkthrough-island.tsx';

/** Everything the walkthrough needs from `bootBoard`, and nothing else. */
export interface BoardWalkthroughDeps {
  /** The board's one projection. The walk reads and writes four fields on
   *  it — `walkIndex`, `walkKey`, `walkProgress`, `homeSettled` — and the
   *  object is LIVE, the same contract `wireBoardLive` is written against. */
  state: BoardState;
  /** The review queue as it stands right now, re-derived per render. */
  currentQueue: () => ReviewQueue;
  /** `getElementById`, already narrowed — `bootBoard`'s own `el`. */
  el(id: string): HTMLElement;
  /** Write the address for the item on screen. The walk is one `walk`
   *  resource to `historyStep` however far it steps. */
  syncBoardUrl(): void;
  /** Repaint Home, which shows the sitting's settled items. */
  renderHomeRegion(): void;
  /** Open one queue item's task panel; false when the opener left the page. */
  openReviewItem(item: ReviewItem, returnItem?: string | null): boolean;
  /** The same, aimed at the item's thread. */
  openReviewThread(item: ReviewItem, returnItem?: string | null): boolean;
  /** The three review writes, from `createBoardReviewController`. Thunks, not
   *  values: the controller is built after this store and takes its `render`. */
  answerDecision: (
    task: BoardTask,
    text: string,
    optionId?: string,
  ) => Promise<'answered' | 'asked' | false>;
  askOnReviewItem: (
    item: ReviewItem,
    phrase: { text: string } | null,
    question: string,
  ) => Promise<boolean>;
  replyToReviewItem: (
    item: ReviewItem,
    text: string,
    optionId?: string,
  ) => Promise<'answered' | 'asked' | false>;
  /** This board's queue just drained. `bootBoard` decides whether the sitting
   *  continues on another board (`?then=`) or ends here. */
  onQueueDrained(): void;
}

/** What `bootBoard` keeps: the two verbs the rest of the page calls. */
export interface BoardWalkthrough {
  /** Draw the walkthrough for wherever the reader now stands. */
  render(): void;
  /** Put it away and forget the sitting's tally. */
  close(): void;
}

export function createBoardWalkthrough(deps: BoardWalkthroughDeps): BoardWalkthrough {
  const {
    state,
    currentQueue,
    el,
    syncBoardUrl,
    renderHomeRegion,
    openReviewItem,
    openReviewThread,
    answerDecision,
    askOnReviewItem,
    replyToReviewItem,
  } = deps;

  /**
   * Put the walkthrough away and forget the sitting's tally.
   *
   * Does not render — the two callers render different amounts afterwards
   * (`setNav` repaints every region anyway), and a render in here would run
   * twice on the path that matters.
   */
  function closeWalkthrough(): void {
    state.walkIndex = CLOSED_WALK.index;
    state.walkKey = CLOSED_WALK.key;
    state.walkProgress = { cleared: 0, last: null };
  }

  /**
   * Open one of the walkthrough's own items, and leave the walk aimed for
   * whichever way the reader then goes.
   *
   * Close-in-state first, but render the OPEN first: the close and the open
   * are one user action, and they must reach `syncBoardUrl` as one step
   * (walk → panel, a push). Rendering the close ahead of the open wrote a
   * `close` step whose `history.back()` — an async traversal — landed after
   * the open's `pushState`, and its popstate re-applied the old `?item=`
   * entry: the tapped task closed itself and the reader bounced back to Home.
   *
   * When the item is a DOC the opener leaves the page instead, and the card
   * repaint is skipped outright — a close-step `back()` queued beside
   * `location.assign` races it. That is why the close is undone on that path
   * (`walkAimAfterOpen`): nothing rendered, so it bought nothing, and the
   * closed state is exactly what bfcache freezes for the trip back.
   *
   * The aim doubles as the return address handed to the opener, so the doc
   * can point its back arrow at the queue. Only an OPEN walk has one to give.
   */
  function openFromWalk(open: (returnItem: string | null) => boolean): void {
    const aim: WalkAim = { index: state.walkIndex, key: state.walkKey };
    const back = aim.index >= 0 ? aim.key : null;
    state.walkIndex = CLOSED_WALK.index;
    state.walkKey = CLOSED_WALK.key;
    const stillHere = open(back);
    const next = walkAimAfterOpen(aim, stillHere);
    state.walkIndex = next.index;
    state.walkKey = next.key;
    if (stillHere) renderWalkthrough();
  }

  /**
   * The walkthrough re-derives its queue from the live projection on every
   * render, and the position is an INDEX into that queue rather than a task
   * id. So answering the card you're on drops it out of the queue and the
   * same index lands on the next one — six answers without six navigations —
   * and a decision another peer answers while you sit here simply isn't
   * offered to you.
   */
  function renderWalkthrough(): void {
    const queue = currentQueue();
    // Resolve the aim before rendering, and write the result back: from here
    // on the index is a cache of where the key IS, not an independent claim
    // about where the reader stands.
    const index = walkPosition(queue, state.walkIndex, state.walkKey);
    state.walkIndex = index;
    const current = queue.items[index] ?? null;
    const next = queue.items[index + 1] ?? null;
    // A PAGE inside Home, not an overlay over the board — so the Home content
    // it replaces has to go away while it is up. One toggle rather than a
    // class on each region: a region added to Home later is covered by it
    // without anyone remembering this line exists.
    el('board-home-page').classList.toggle('hidden', index >= 0);
    // The island's one input. A plain signal write, not a render call: the
    // card re-renders itself, keyed on `ReviewItem.key`, so a repaint of the
    // item the reader is working keeps its DOM — which is what carries the
    // half-typed answer and the expansions they opened across it.
    //
    // The handlers ride along because they are NOT stable: each one closes
    // over `current` / `next`, the item this paint drew and the one after it.
    // A set bound once at mount would be answering about a queue several
    // answers old.
    walkthroughData.value = {
      queue,
      index,
      progress: state.walkProgress,
      now: Date.now(),
      handlers: {
        // `current` rather than a lookup by task id: it is the item this
        // render drew, so the key that gets advanced past cannot be a
        // different row that happens to share a task.
        onAnswer: async (t, text, optionId) => {
          // The write first, then the advance — and only an ANSWER advances.
          // A question converted server-side leaves the decision open on the
          // queue, so settling it would mark done a row still waiting.
          const wrote = await answerDecision(t, text, optionId);
          if (wrote === 'asked') return true;
          return finishWalkItem(current, next, async () => wrote === 'answered');
        },
        // Not a finish either: nothing was answered. The item is the
        // owner's now, so the queue drops it and the next card takes its
        // place — the toast is what says the question went (Bryan,
        // 2026-08-31: the card that stayed put read as "nothing happened").
        onAskOnItem: (item, phrase, question) => askOnReviewItem(item, phrase, question),
        onQuestionOnItem: (item, question) => askOnReviewItem(item, null, question),
        onReply: async (item, text, optionId) => {
          // Same split as `onAnswer`: a reply the server read as a question
          // is an ask, not an answer — the item leaves the queue for its
          // owner's turn without being counted as cleared.
          const wrote = await replyToReviewItem(item, text, optionId);
          if (wrote === 'asked') return true;
          return finishWalkItem(item, next, async () => wrote === 'answered');
        },
        onOpenItem: (item) => openFromWalk((back) => openReviewItem(item, back)),
        // Same one-step close-then-open as `onOpenItem`, aimed at the thread —
        // and the same doc jump underneath when the item has no thread on a
        // task to aim at, so it needs the same care on the way out.
        onOpenThread: (item) => openFromWalk((back) => openReviewThread(item, back)),
        onStep: (i) => {
          // Skip and back are positional by nature — the reader is pointing at
          // a place in the list they can see. Re-aim from that position so the
          // next repaint follows the item rather than the number.
          const to = Math.max(0, i);
          // Aim by the KEY the reader can see at that position, so the step
          // lands on the item pointed at even if the queue moved under it.
          const target = queue.items[to]?.key ?? null;
          state.walkKey = target;
          const at = target ? queue.items.findIndex((it) => it.key === target) : -1;
          state.walkIndex = at >= 0 ? at : Math.min(to, queue.items.length);
          renderWalkthrough();
        },
        onClose: () => {
          closeWalkthrough();
          renderWalkthrough();
        },
      },
    };
    // The address names the item on screen (`?item=`): opening the
    // walkthrough is a push, advancing through it rewrites in place, closing
    // unwinds — `historyStep` sees one `walk` resource however far it steps.
    syncBoardUrl();
  }

  /**
   * Answering moves you on, and the surface says so.
   *
   * Order is the whole point: the write, THEN the advance. The advance is the
   * confirmation that the answer landed, so a refused write has to leave the
   * reader on the same card with their words still in the box — otherwise the
   * queue moves and nothing recorded it, which is the one failure this flow
   * cannot afford.
   */
  async function finishWalkItem(
    item: ReviewItem | null,
    next: ReviewItem | null,
    write: () => Promise<boolean>,
  ): Promise<boolean> {
    const ok = await write();
    if (!ok || !item) return ok;
    state.walkProgress = { cleared: state.walkProgress.cleared + 1, last: item };
    // Answered items stay in the Home stack marked done (approved design)
    // instead of vanishing — a per-sitting display ledger, not stored state.
    state.homeSettled.set(item.key, item);
    const queue = currentQueue();
    state.walkIndex = advanceWalk(queue, state.walkIndex, item.key, next?.key ?? null);
    state.walkKey = queue.items[state.walkIndex]?.key ?? null;
    // This board's queue just drained: if the landing page handed over more
    // boards (?then=), continue the sitting there instead of dead-ending.
    if (queue.items.length === 0) deps.onQueueDrained();
    renderWalkthrough();
    renderHomeRegion();
    return ok;
  }

  return { render: renderWalkthrough, close: closeWalkthrough };
}
