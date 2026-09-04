import { describe, expect, it } from 'vitest';
import { homeReviewData } from '../src/hub/home-review-island.tsx';
import { mountHubIslands } from '../src/hub/hub-islands.ts';
import { hubState, mountShell, task } from './support/hub-region-harness.ts';

/**
 * The islands the page keeps for its whole life.
 *
 * The contract they share is a LIFETIME, not a feature: each owns a wrapper
 * inside its host from the moment it mounts, and no vanilla code may wipe
 * that host again. So what these drive is that every host actually receives
 * an island, that the handlers reach the regions built after them (every one
 * arrives as a thunk, which is the cycle a mount-before-build creates), and
 * that a second mount is not needed for the page to repaint.
 */
function islands(over: Partial<Parameters<typeof mountHubIslands>[0]> = {}) {
  const el = mountShell();
  const state = hubState({ tasks: new Map([['t-1', task('t-1')]]) });
  const seen: string[] = [];
  const assigned: string[] = [];
  mountHubIslands({
    state,
    user: { id: 'u-1', name: 'Bryan', kind: 'human', color: '#000' } as never,
    el,
    location: { assign: (u: string) => assigned.push(u) },
    openInQueue: () => seen.push('openInQueue'),
    openReviewItem: () => {
      seen.push('openReviewItem');
      return true;
    },
    openReviewThread: () => {
      seen.push('openReviewThread');
      return true;
    },
    startWalkthrough: () => seen.push('startWalkthrough'),
    openTaskDetail: (t, tab) => seen.push(`openTaskDetail:${t.id}:${tab}`),
    commentOnActivity: async () => null,
    replyOnActivity: async () => null,
    renderPresenceRegion: () => seen.push('renderPresenceRegion'),
    ...over,
  });
  return { el, state, seen, assigned };
}

const HOSTS = [
  'hub-home-review',
  'hub-home-activity',
  'hub-walkthrough',
  'hub-detail',
  'hub-goal-detail',
  'hub-people',
  'hub-drift',
];

describe('mountHubIslands', () => {
  it('puts an island in every host it owns', () => {
    const i = islands();
    for (const id of HOSTS) {
      expect(i.el(id).children.length, `${id} has no island`).toBeGreaterThan(0);
    }
  });

  it('leaves the board host alone — that one mounts at the end of boot', () => {
    // `#hub-board` is deliberately not here: its host is the one the restore
    // list used to share, and the ordering of that mount is load-bearing.
    const i = islands();
    expect(i.el('hub-board').children.length).toBe(0);
  });

  it('repaints from a signal write, with no second mount', () => {
    const i = islands();
    const before = i.el('hub-home-review').firstElementChild;
    homeReviewData.value = { queue: { items: [], counts: {} }, settled: [], now: 1 } as never;
    expect(i.el('hub-home-review').firstElementChild).toBe(before);
  });

  it('gives each host exactly one wrapper to own', () => {
    // The contract is a lifetime: the island owns a wrapper inside its host
    // and nothing may wipe it. Two wrappers in one host would mean a second
    // mount happened, which is the bug this file exists to catch.
    const i = islands();
    for (const id of HOSTS) {
      expect(i.el(id).children.length, id).toBe(1);
    }
  });

  it('calls no region verb while mounting — every handler is a thunk', () => {
    // The islands mount BEFORE the regions and the review controller exist.
    // A handler invoked eagerly here would reach a `const` still in its
    // temporal dead zone, so the mount must only wire them.
    const i = islands();
    expect(i.seen).toEqual([]);
    expect(i.assigned).toEqual([]);
  });
});
