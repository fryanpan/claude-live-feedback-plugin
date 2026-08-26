import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { walkHandoff, walkNextUrl } from '../src/hub/hub-model';

// The landing page's review chip and "Review all" bar (t-DA4rBTmdP0d2) hand
// the client `?walk=1` (open the walkthrough on arrival) and `&then=<ids>`
// (workspaces still holding items, to visit after this queue drains). These
// two pure helpers are the whole contract; hub-app just wires them.

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

// hub-app has no boot harness (same pin pattern as home-nav-reset.test.ts):
// assert the wiring exists in source — the boot reads the handoff, an armed
// walk auto-opens after the first review-items load, and a drained queue
// chains to the next workspace instead of dead-ending on a cleared card.
describe('hub-app wires the handoff', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'hub', 'hub-app.ts'), 'utf8');

  it('reads walkHandoff from the boot URL', () => {
    expect(src).toContain('walkHandoff(location.search)');
  });

  it('auto-opens the walkthrough after the first review-items load', () => {
    expect(src).toMatch(/loadReviewItems\(\)\.then\(maybeAutoWalk\)/);
  });

  it('chains to walkNextUrl when the queue drains', () => {
    expect(src).toContain('walkNextUrl(');
  });
});
