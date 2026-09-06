import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WALK_HANDOFF_DEADLINE_MS } from '../src/board/board-app.ts';
import { type BoardTask, CHORES_ID } from '../src/board/board-model';
import {
  type ReviewQueue,
  type ReviewThreadItem,
  reviewQueue,
  walkHandoff,
  walkHandoffReady,
  walkNextUrl,
  walkPosition,
} from '../src/board/board-review-model';
import {
  NOW,
  WS,
  boardRow,
  bootTestBoard,
  resetBoardServer,
  server,
  settle,
} from './support/board-drive.ts';

// The landing page's review chip and "Review all" bar (the walkthrough
// handoff ticket) hand
// the client `?walk=1` (open the walkthrough on arrival) and `&then=<ids>`
// (workspaces still holding items, to visit after this queue drains). These
// two pure helpers are the whole contract; board-app just wires them.

describe('walkHandoff', () => {
  it('reads walk + the handoff chain from a query string', () => {
    expect(walkHandoff('?walk=1&then=w-a,w-b')).toEqual({ walk: true, chain: ['w-a', 'w-b'] });
  });

  it('is inert without the walk param — a plain ?task= link opens nothing', () => {
    expect(walkHandoff('?task=t-1')).toEqual({ walk: false, chain: [] });
  });

  it('walk with no chain is a single-board sitting', () => {
    expect(walkHandoff('?walk=1')).toEqual({ walk: true, chain: [] });
  });

  it('drops empty segments so a trailing comma cannot produce a hop to nowhere', () => {
    expect(walkHandoff('?walk=1&then=w-a,,')).toEqual({ walk: true, chain: ['w-a'] });
  });
});

describe('walkNextUrl', () => {
  it('builds the next hop and carries the rest of the chain', () => {
    expect(walkNextUrl(['w-a', 'w-b'])).toBe('/workspaces/w-a/home?walk=1&then=w-b');
  });

  it('the last hop carries no then', () => {
    expect(walkNextUrl(['w-a'])).toBe('/workspaces/w-a/home?walk=1');
  });

  it('an empty chain has nowhere to go', () => {
    expect(walkNextUrl([])).toBe(null);
  });
});

// ── Where the handoff walk STARTS ──────────────────────────────────────────
//
// The walk aims by item KEY (walkPosition), and the key is chosen from the
// queue as it stands when the walk opens. On a cold load the two halves of
// the queue land separately: the REST review-items list and the ydoc task
// projection. A queue built from review items alone has no tasks to rank
// against, so every item takes the tail rank ordered by age — and a walk that
// opened on it aimed at the OLDEST ask. When the projection landed, the key
// followed that ask to its real rank, which is the bottom of the queue:
// "Review all" opened on N of N. All fixtures are synthetic.

function task(id: string, order: number): BoardTask {
  return {
    id,
    title: `Task ${id}`,
    status: 'todo',
    assignee: 'agent',
    goal: CHORES_ID,
    order,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:${id}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function ask(taskId: string, ageMs: number): ReviewThreadItem {
  return {
    kind: 'task-thread',
    docId: `task:${taskId}`,
    threadId: `th-${taskId}`,
    taskId,
    title: `Task ${taskId}`,
    ask: `Question on ${taskId}?`,
    askedBy: 'Helper',
    since: NOW - ageMs,
    band: 'declared',
    commentId: `c-${taskId}`,
    review: { shape: 'review', headline: `Question on ${taskId}?`, detail: '' },
  };
}

// Board order is t-1, t-2, t-3; the OLDEST ask is on the LAST task.
const tasks = [task('t-1', 1), task('t-2', 2), task('t-3', 3)];
const asks = [ask('t-1', 60_000), ask('t-2', 120_000), ask('t-3', 180_000)];
const reviewItemsOnly = () => reviewQueue([], asks, NOW);
const fullQueue = () => reviewQueue(tasks, asks, NOW);

/** What `startWalkthrough` does: aim at the head of the queue it sees. */
const startAt = (queue: ReviewQueue) => ({ index: 0, key: queue.items[0]?.key ?? null });

describe('the handoff walk starts at item 1', () => {
  it('the mechanism: a walk opened on review items alone lands on the tail once tasks rank it', () => {
    const aim = startAt(reviewItemsOnly());
    // The premise the bug rests on — without tasks, the oldest ask is first.
    expect(aim.key).toBe('task-thread:task:t-3:th-t-3');
    expect(walkPosition(fullQueue(), aim.index, aim.key)).toBe(2); // "3 of 3"
  });

  it('waits for both halves of the queue before opening', () => {
    const partial = reviewItemsOnly();
    expect(partial.items).toHaveLength(3);
    expect(walkHandoffReady(partial, { reviewItems: true, projection: false })).toBe(false);
    expect(walkHandoffReady(fullQueue(), { reviewItems: false, projection: true })).toBe(false);
    const full = fullQueue();
    expect(walkHandoffReady(full, { reviewItems: true, projection: true })).toBe(true);
    // Entering from Home with a 3-item queue: item 1 of 3.
    const aim = startAt(full);
    expect(walkPosition(full, aim.index, aim.key)).toBe(0);
    expect(full.items[0]?.key).toBe('task-thread:task:t-1:th-t-1');
  });

  it('an empty queue is never ready — the flag stays armed for the projection', () => {
    expect(
      walkHandoffReady(reviewQueue([], [], NOW), { reviewItems: true, projection: true }),
    ).toBe(false);
  });

  it('the deadline opens on whatever has landed rather than hopping a board that has items', () => {
    const partial = reviewItemsOnly();
    expect(walkHandoffReady(partial, { reviewItems: true, projection: false }, true)).toBe(true);
    expect(
      walkHandoffReady(reviewQueue([], [], NOW), { reviewItems: true, projection: false }, true),
    ).toBe(false);
  });

  // Positive control: a deep link (`?item=<key>`) aims by key and is NOT
  // gated on the sources — `maybeOpenBootItem` waits for that item itself.
  it('a deep link to item 2 still opens item 2', () => {
    const full = fullQueue();
    const key = full.items[1]?.key ?? null;
    expect(key).toBe('task-thread:task:t-2:th-t-2');
    // openInQueue(item, idx) — and the key keeps the aim across a re-rank.
    expect(walkPosition(full, 1, key)).toBe(1); // "2 of 3"
    expect(walkPosition(reviewItemsOnly(), 1, key)).toBe(1);
  });
});

// ── The boot itself, driven ────────────────────────────────────────────────
//
// This used to be read out of the boot's source — twice, as "board-app wires
// the handoff" and "board-app gates the auto-walk on both sources" — on the
// grounds that a four-second deadline and a cross-workspace hop are not
// reachable from a test. Both are: the deadline is a `setTimeout` fake timers
// step over, and the hop writes to the INJECTED location, which never leaves
// the process. So the boot is booted, and what it does is what is asserted.
describe('the boot opens a ?walk=1 handoff on the queue, once', () => {
  beforeEach(() => {
    resetBoardServer();
    // `shouldAdvanceTime` keeps `settle()`'s own zero-delay turns running
    // while the 4s stand-down timer is faked.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  /** The sitting is a PAGE inside Home, so Home's content goes while it is
   *  up — the one toggle every region is covered by. */
  const sitting = (): boolean =>
    document.getElementById('board-home-page')?.classList.contains('hidden') === true;

  const ASK: ReviewThreadItem = {
    kind: 'doc-thread',
    docId: 'd-1',
    threadId: 'th-1',
    title: 'The hob spec',
    ask: 'Induction or gas?',
    askedBy: 'Ada',
    since: NOW - 60_000,
    band: 'declared',
  };
  /** A decision rides the ydoc projection, not the review-items list — the
   *  half that lands on `onReady` rather than on a fetch. */
  const DECISION = boardRow('t-1', { needs: 'decision', title: 'Which hob?' });

  it('opens the sitting the landing page asked for', async () => {
    server.on(`/workspaces/${WS}/review-items`, { items: [ASK] });
    await bootTestBoard({
      url: `https://board.test/workspaces/${WS}/home?walk=1`,
      tasks: [boardRow('t-2')],
    });
    expect(sitting()).toBe(true);
  });

  it('opens nothing without the flag — a plain link to Home is inert', async () => {
    server.on(`/workspaces/${WS}/review-items`, { items: [ASK] });
    await bootTestBoard({
      url: `https://board.test/workspaces/${WS}/home`,
      tasks: [boardRow('t-2')],
    });
    expect(sitting()).toBe(false);
  });

  it('waits for the ydoc projection, and an empty queue does not burn the flag', async () => {
    server.on(`/workspaces/${WS}/review-items`, { items: [ASK] });
    const board = await bootTestBoard({
      url: `https://board.test/workspaces/${WS}/home?walk=1`,
      noSync: true,
    });
    // The review-items load has resolved; the projection has not. Opening
    // here would aim at a head the projection re-ranks to the bottom.
    expect(sitting()).toBe(false);
    board.sockets.first().sync();
    await settle();
    expect(sitting()).toBe(true);
  });

  it('waits for the review-items list too, even when the projection alone fills the queue', async () => {
    // A decision makes the queue non-empty off the ydoc alone, which is
    // exactly the case a queue-length gate would open on.
    const realFetch = globalThis.fetch;
    let release!: () => void;
    const landed = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/review-items')) await landed;
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      server.on(`/workspaces/${WS}/review-items`, { items: [ASK] });
      await bootTestBoard({
        url: `https://board.test/workspaces/${WS}/home?walk=1`,
        tasks: [DECISION],
      });
      expect(sitting()).toBe(false);
      release();
      await settle();
      expect(sitting()).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('hops to the next board in the chain when this one is genuinely clear', async () => {
    const board = await bootTestBoard({
      url: `https://board.test/workspaces/${WS}/home?walk=1&then=w-b,w-c`,
    });
    expect(board.location.navigations).toEqual([]);
    await vi.advanceTimersByTimeAsync(WALK_HANDOFF_DEADLINE_MS + 1);
    expect(sitting()).toBe(false);
    expect(board.location.navigations).toEqual(['/workspaces/w-b/home?walk=1&then=w-c']);
  });

  it('a board with items in hand opens on them at the deadline instead of hopping', async () => {
    server.on(`/workspaces/${WS}/review-items`, { items: [ASK] });
    const board = await bootTestBoard({
      url: `https://board.test/workspaces/${WS}/home?walk=1&then=w-b`,
      noSync: true,
    });
    expect(sitting()).toBe(false);
    await vi.advanceTimersByTimeAsync(WALK_HANDOFF_DEADLINE_MS + 1);
    expect(sitting()).toBe(true);
    expect(board.location.navigations).toEqual([]);
  });
});
