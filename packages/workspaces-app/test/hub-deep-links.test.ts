import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WALK_HANDOFF_DEADLINE_MS, createHubDeepLinks } from '../src/hub/hub-deep-links.ts';
import { type ReviewQueue, reviewQueue } from '../src/hub/hub-review-model.ts';
import { hubState, task } from './support/hub-region-harness.ts';

/**
 * What the boot URL claimed, resolved against a projection that has not
 * landed yet.
 *
 * Every assertion here is about the WAITING. The claims themselves are
 * written into state before first paint; what this module owns is that a
 * claim is never burned early (the rows may still be coming), never burned
 * twice, and never left hanging forever — one deadline decides all three
 * kinds, because they are the same bet about the same sync.
 */
function deepLinks(over: Partial<Parameters<typeof createHubDeepLinks>[0]> = {}, search = '') {
  const state = hubState({ pane: 'home', nav: 'home' });
  const navigations: string[] = [];
  const opened: Array<{ key: string; index: number }> = [];
  const startWalkthrough = vi.fn();
  /** Whether the deadline released the boot URL's unconfirmed goal claim —
   *  `renderDetail` may only close such a panel once it has. */
  let goalClaimReleased = false;
  const renderDetail = vi.fn();
  const syncBoardUrl = vi.fn();
  let queue: ReviewQueue = reviewQueue([], [], Date.now());
  const api = createHubDeepLinks({
    state,
    bootLoc: { nav: 'home', task: null, goal: null, thread: null, item: null, archived: false },
    location: {
      search,
      get href() {
        return 'http://x/';
      },
      set href(next: string) {
        navigations.push(next);
      },
    },
    currentQueue: () => queue,
    walkSources: { reviewItems: true, projection: true },
    openInQueue: (item, index) => opened.push({ key: item.key, index }),
    startWalkthrough,
    syncBoardUrl,
    renderDetail,
    boot: {
      item: () => state.walkKey,
      clearItem: () => {
        state.walkKey = null;
      },
      clearGoal: () => {
        goalClaimReleased = true;
      },
    },
    ...over,
  });
  return {
    state,
    navigations,
    opened,
    startWalkthrough,
    renderDetail,
    syncBoardUrl,
    goalClaimReleased: () => goalClaimReleased,
    setQueue: (q: ReviewQueue) => {
      queue = q;
    },
    ...api,
  };
}

function queueOf(keys: string[]): ReviewQueue {
  return { items: keys.map((key) => ({ key })), counts: {} } as unknown as ReviewQueue;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('createHubDeepLinks', () => {
  it('waits rather than burning ?item= while the queue is still empty', () => {
    const d = deepLinks();
    d.state.walkKey = 'k-2';
    d.deepLinkTick();
    expect(d.opened).toEqual([]);
    expect(d.state.walkKey).toBe('k-2');
  });

  it('opens ?item= at its place in the queue as soon as the rows arrive', () => {
    const d = deepLinks();
    d.state.walkKey = 'k-2';
    d.setQueue(queueOf(['k-1', 'k-2', 'k-3']));
    d.deepLinkTick();
    expect(d.opened).toEqual([{ key: 'k-2', index: 1 }]);
  });

  it('opens it once — a later tick must not re-open what the reader closed', () => {
    const d = deepLinks();
    d.state.walkKey = 'k-1';
    d.setQueue(queueOf(['k-1']));
    d.deepLinkTick();
    d.deepLinkTick();
    expect(d.opened).toHaveLength(1);
  });

  it('gives up on an unresolvable claim at the deadline, and tidies the URL', () => {
    const d = deepLinks({
      bootLoc: {
        nav: 'home',
        task: null,
        goal: null,
        thread: null,
        item: 'k-gone',
        archived: false,
      },
    });
    d.state.walkKey = 'k-gone';
    vi.advanceTimersByTime(WALK_HANDOFF_DEADLINE_MS);
    expect(d.state.walkKey).toBeNull();
    expect(d.syncBoardUrl).toHaveBeenCalled();
  });

  it('releases the boot URL’s goal claim at the same deadline', () => {
    // Until it is released, `renderDetail` must not close an unconfirmed goal
    // the way it closes one that genuinely left the board.
    const d = deepLinks({
      bootLoc: { nav: 'tasks', task: null, goal: 'g-1', thread: null, item: null, archived: false },
    });
    expect(d.goalClaimReleased()).toBe(false);
    vi.advanceTimersByTime(WALK_HANDOFF_DEADLINE_MS);
    expect(d.goalClaimReleased()).toBe(true);
  });

  it('closes a panel whose ?task= never appeared, and says the link is outdated', () => {
    const state = hubState({ detailTaskId: 't-gone', pane: 'board' });
    const d = deepLinks({
      state,
      bootLoc: {
        nav: 'tasks',
        task: 't-gone',
        goal: null,
        thread: null,
        item: null,
        archived: false,
      },
    });
    vi.advanceTimersByTime(WALK_HANDOFF_DEADLINE_MS);
    expect(state.detailTaskId).toBeNull();
    expect(d.renderDetail).toHaveBeenCalled();
  });

  it('leaves a ?task= panel alone once the projection carries the row', () => {
    const state = hubState({
      detailTaskId: 't-1',
      tasks: new Map([['t-1', task('t-1')]]),
      pane: 'board',
    });
    deepLinks({
      state,
      bootLoc: { nav: 'tasks', task: 't-1', goal: null, thread: null, item: null, archived: false },
    });
    vi.advanceTimersByTime(WALK_HANDOFF_DEADLINE_MS);
    expect(state.detailTaskId).toBe('t-1');
  });

  it('arms ?walk=1 only on Home, and opens once the queue holds anything', () => {
    const d = deepLinks({}, '?walk=1');
    d.setQueue(queueOf(['k-1']));
    d.deepLinkTick();
    expect(d.startWalkthrough).toHaveBeenCalledTimes(1);
  });

  it('does not open an armed walk while only one half of the queue has landed', () => {
    const d = deepLinks({ walkSources: { reviewItems: true, projection: false } }, '?walk=1');
    d.setQueue(queueOf(['k-1']));
    d.deepLinkTick();
    expect(d.startWalkthrough).not.toHaveBeenCalled();
  });

  it('hops to the next board in the ?then= chain when this one drains', () => {
    const d = deepLinks({}, '?walk=1&then=w-b,w-c');
    d.chainWalkDrain();
    expect(d.navigations[0]).toContain('w-b');
  });
});
