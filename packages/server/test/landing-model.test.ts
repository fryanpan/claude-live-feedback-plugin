import { describe, expect, it } from 'bun:test';
import { ACTIVE_WINDOW_MS, type LandingWorkspaceInput, buildLandingModel } from '../src/landing.ts';

/**
 * The landing model's shaping rules, unit-tested away from HTTP.
 *
 * The model is deliberately small — split workspaces into active/inactive on
 * one stated window, order both by recency, and mint hrefs. What is worth
 * pinning is exactly the part a person reads off the page and cannot check:
 * which side of the fold a board lands on, that the newest board is first,
 * and that the links go where the rest of the product already navigates.
 * The HTML e2e (`landing-workspaces.test.ts`) proves the route feeds this
 * model real signals; this file proves the split is right.
 */

const NOW = 1_000_000_000_000;
const DAY = 86_400_000;

function ws(over: Partial<LandingWorkspaceInput> & { id: string }): LandingWorkspaceInput {
  return { name: over.id, lastActivity: NOW, ...over };
}

describe('the active/inactive split', () => {
  it('splits on the window, keeping the boundary itself active', () => {
    const model = buildLandingModel(
      [
        ws({ id: 'fresh', lastActivity: NOW - DAY }),
        ws({ id: 'edge', lastActivity: NOW - ACTIVE_WINDOW_MS }),
        ws({ id: 'stale', lastActivity: NOW - ACTIVE_WINDOW_MS - 1 }),
      ],
      [],
      NOW,
    );
    // Positive control in the same pass: the split CAN see both sides on this
    // fixture, so neither list's membership is a harness that sorted
    // everything one way.
    expect(model.active.map((w) => w.id)).toEqual(['fresh', 'edge']);
    expect(model.inactive.map((w) => w.id)).toEqual(['stale']);
    expect(model.windowMs).toBe(ACTIVE_WINDOW_MS);
  });

  it('a workspace with no recorded activity at all is inactive, not front-page', () => {
    const model = buildLandingModel([ws({ id: 'blank', lastActivity: 0 })], [], NOW);
    expect(model.active).toEqual([]);
    expect(model.inactive.map((w) => w.id)).toEqual(['blank']);
  });
});

describe('ordering', () => {
  it('orders both lists newest first', () => {
    const model = buildLandingModel(
      [
        ws({ id: 'older', lastActivity: NOW - 3 * DAY }),
        ws({ id: 'newest', lastActivity: NOW - DAY }),
        ws({ id: 'mid', lastActivity: NOW - 2 * DAY }),
        ws({ id: 'long-gone', lastActivity: NOW - 40 * DAY }),
        ws({ id: 'gone', lastActivity: NOW - 30 * DAY }),
      ],
      [],
      NOW,
    );
    expect(model.active.map((w) => w.id)).toEqual(['newest', 'mid', 'older']);
    expect(model.inactive.map((w) => w.id)).toEqual(['gone', 'long-gone']);
  });

  it('breaks recency ties by name so the page is deterministic across requests', () => {
    const t = NOW - DAY;
    const model = buildLandingModel(
      [
        ws({ id: 'w2', name: 'beta', lastActivity: t }),
        ws({ id: 'w1', name: 'alpha', lastActivity: t }),
      ],
      [],
      NOW,
    );
    expect(model.active.map((w) => w.name)).toEqual(['alpha', 'beta']);
  });
});

describe('links', () => {
  it('a workspace row links to its Home pane, id URL-encoded', () => {
    const model = buildLandingModel([ws({ id: 'w/1' })], [], NOW);
    expect(model.active[0]?.href).toBe(`/workspaces/${encodeURIComponent('w/1')}/home`);
  });

  it('a folded-away workspace opens on Home too', () => {
    const model = buildLandingModel([ws({ id: 'cold', lastActivity: 0 })], [], NOW);
    expect(model.inactive[0]?.href).toBe('/workspaces/cold/home');
  });

  it('project links go to /projects/<owner> encoded, in label order', () => {
    const model = buildLandingModel(
      [],
      [
        { owner: '/proj/zeta', label: 'zeta' },
        { owner: '/proj/alpha', label: 'alpha' },
      ],
      NOW,
    );
    expect(model.projects.map((p) => p.label)).toEqual(['alpha', 'zeta']);
    expect(model.projects[0]?.href).toBe(`/projects/${encodeURIComponent('/proj/alpha')}`);
  });
});
