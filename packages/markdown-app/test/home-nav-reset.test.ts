/**
 * Tapping Home lands on the main Home page, from anywhere inside Home.
 *
 * Home has one drill-in: the review walkthrough. It is a PAGE inside Home
 * rather than an overlay — `renderWalkthrough` hides `#hub-home-page` whenever
 * the queue position resolves to 0 or more, and that covers both the card
 * itself and the end-of-queue done state you land on after answering the last
 * item. Neither has a URL of its own; both sit at `/workspaces/<id>/home`.
 *
 * So the Home nav item had nothing to do: `setNav` saw `state.nav === 'home'`
 * already, skipped the pushState, re-rendered the same three regions, and the
 * walkthrough — held in `walkIndex` / `walkKey`, which nothing in that path
 * touched — stayed up. One tap, no visible change, and the only way back to
 * the Home page was the card's own close button.
 *
 * The fix is that arriving at Home closes the walkthrough, whichever way you
 * arrive (nav tap, the board banner's "go home", or Back onto `/home`). The
 * URL is the authority and the walkthrough is not in it.
 *
 * All fixtures are synthetic.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHORES_ID,
  CLOSED_WALK,
  type HubTask,
  reviewQueue,
  walkPosition,
} from '../src/hub/hub-model.ts';

const HUB_APP = readFileSync(resolve(import.meta.dirname, '../src/hub/hub-app.ts'), 'utf8');

const NOW = 1_700_000_000_000;

function decision(n: number): HubTask {
  return {
    id: `t-${n}`,
    title: `Decision ${n}`,
    status: 'todo',
    assignee: 'human',
    needs: 'decision',
    goal: CHORES_ID,
    order: n,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${n}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** The one expression the render path reads: `#hub-home-page` is hidden while
 *  this is 0 or more, so "the reader is on a Home subpage" and "this is not
 *  -1" are the same statement. */
const onSubpage = (index: number, key: string | null) =>
  walkPosition(reviewQueue([decision(1), decision(2)], [], NOW), index, key) >= 0;

describe('CLOSED_WALK — the pair that means the Home page is showing', () => {
  const queue = reviewQueue([decision(1), decision(2)], [], NOW);

  it('positive control: an aimed walkthrough really is a subpage', () => {
    // Without this the -1 below could be a queue that was empty all along
    // rather than a walkthrough that closed.
    expect(onSubpage(0, queue.items[0]?.key ?? null)).toBe(true);
  });

  it('positive control: so is the done state you run off the end into', () => {
    // Answering the last item leaves the index past the end. The card that
    // says "all caught up" is still a page over Home, and a Home tap from it
    // was just as silent.
    expect(onSubpage(queue.items.length, null)).toBe(true);
  });

  it('resolves to no card, so the Home page renders', () => {
    expect(walkPosition(queue, CLOSED_WALK.index, CLOSED_WALK.key)).toBe(-1);
    expect(onSubpage(CLOSED_WALK.index, CLOSED_WALK.key)).toBe(false);
  });
});

/** `setNav` lives inside `main()` and is unreachable from a test — the module
 *  starts the app on import. These read the source instead, which is the
 *  established shape for hub-app wiring in this suite. */
function setNavBody(): string {
  const body = HUB_APP.match(/function setNav\([\s\S]*?\n {2}\}\n/)?.[0] ?? '';
  expect(body, 'setNav went missing from hub-app.ts').not.toBe('');
  return body;
}

describe('the Home nav item resets Home', () => {
  it('arriving at Home closes the walkthrough', () => {
    expect(setNavBody()).toMatch(/nav === 'home'[^\n]*closeWalkthrough\(\)/);
  });

  it('closes it even when Home is already the destination', () => {
    // The whole bug: `same` short-circuited the only thing the tap did. It
    // may gate the history entry and nothing else.
    const reset = setNavBody()
      .split('\n')
      .find((line) => line.includes('closeWalkthrough()'));
    // Asserted present first: `not.toContain` on a missing line is a pass that
    // means the opposite of what it reads as.
    expect(reset, 'no closeWalkthrough call in setNav').toBeDefined();
    expect(reset).not.toContain('same');
    expect(setNavBody()).toMatch(/if \(push && !same\) history\.pushState/);
  });

  it('writes no history entry of its own', () => {
    // Main Home and the walkthrough share one URL, so a pushState here would
    // leave a Back step that re-renders the page it came from — a Back tap
    // that looks broken. The only history call in setNav stays the one that
    // records an actual change of destination.
    expect(setNavBody().match(/history\.(pushState|replaceState)/g)).toEqual(['history.pushState']);
  });

  it('closes it the same way the card’s own close button does', () => {
    // Two spellings of "closed" is how the walkthrough comes back with a
    // stale tally under it.
    // Scoped to renderWalkthrough: the task detail panel has an `onClose` of
    // its own, and an unscoped match reads that one instead.
    const walkthrough = HUB_APP.match(/function renderWalkthrough\([\s\S]*?\n {2}\}\n/)?.[0] ?? '';
    expect(walkthrough, 'renderWalkthrough went missing').not.toBe('');
    const onClose = walkthrough.match(/onClose: \(\) => \{[\s\S]*?\n {8}\}/)?.[0] ?? '';
    expect(onClose, 'the walkthrough onClose handler moved').not.toBe('');
    expect(onClose).toContain('closeWalkthrough()');
    expect(onClose).not.toContain('state.walkKey = null');
  });
});
