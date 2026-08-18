/**
 * The board DRAWS the title and description nudges.
 *
 * Both advisories are computed on the server, projected onto the row, and
 * consumed by exactly one thing: this renderer. So the server tests can be
 * entirely green while the badge does not exist — the failure this repo
 * recorded as "a flag nobody renders is not a feature", where a field was
 * computed, returned, put on an event, and shown to nobody.
 *
 * The title badge shipped one release earlier WITHOUT a test at this layer.
 * This file covers both, so that gap closes rather than repeating.
 *
 * All fixtures are synthetic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BoardFilters,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  boardSections,
} from '../src/hub/hub-model.ts';
import { type BoardHandlers, renderBoard } from '../src/hub/hub-render.ts';

const NOW = 1_700_000_000_000;
let seq = 0;
function task(overrides: Partial<HubTask> = {}): HubTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'todo',
    assignee: 'agent',
    goal: CHORES_ID,
    order: seq,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${seq}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}
const GOALS: HubGoal[] = [{ id: 'g-pr', title: '1. Ship the board' }];
const filters: BoardFilters = {
  tab: 'all',
  userName: 'Ada Fenwick',
  doneWindow: DEFAULT_DONE_WINDOW,
  now: NOW,
};
function handlers(): BoardHandlers {
  return {
    onStatusSet: vi.fn(),
    onGoalTitleCommit: vi.fn(),
    onOpenTask: vi.fn(),
    onReorder: vi.fn(),
    onTitleCommit: vi.fn(),
    onAssign: vi.fn(),
    inlineTitleEdit: () => true,
  };
}

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.replaceChildren(root);
});

/** Badge classes present on each rendered row, in row order. */
function badgeClassesPerRow(tasks: HubTask[]): string[][] {
  renderBoard(root, boardSections(GOALS, tasks, filters), handlers());
  return Array.from(root.querySelectorAll('.hub-task-row')).map((row) =>
    Array.from(row.querySelectorAll('[class*="hub-badge-"]')).map((b) => b.className),
  );
}

describe('shape badges on the board', () => {
  it('draws the description badge for a row whose body has no story', () => {
    // Asserted beside a clean row in the SAME render, so "absent" on the
    // control is a judgement rather than a renderer that draws no badges at
    // all in this harness.
    const [flagged, clean] = badgeClassesPerRow([
      task({ bodyGaps: ['no-story'] }),
      task({}),
    ]);
    expect(flagged?.some((c) => c.includes('hub-badge-body-gap'))).toBe(true);
    expect(clean?.some((c) => c.includes('hub-badge-body-gap'))).toBe(false);
  });

  it('draws the title badge for a row whose title misses the standard', () => {
    const [flagged, clean] = badgeClassesPerRow([
      task({ titleGaps: ['no-persona'] }),
      task({}),
    ]);
    expect(flagged?.some((c) => c.includes('hub-badge-title-gap'))).toBe(true);
    expect(clean?.some((c) => c.includes('hub-badge-title-gap'))).toBe(false);
  });

  it('draws BOTH independently, since they are separate fixes', () => {
    // A row can be perfectly named and still not say who the work is for, and
    // the reverse. One badge standing in for both would hide half the ask.
    const [both, titleOnly, bodyOnly] = badgeClassesPerRow([
      task({ titleGaps: ['no-persona'], bodyGaps: ['no-story'] }),
      task({ titleGaps: ['too-long'] }),
      task({ bodyGaps: ['empty'] }),
    ]);
    expect(both?.filter((c) => c.includes('gap')).length).toBe(2);
    expect(titleOnly?.some((c) => c.includes('hub-badge-title-gap'))).toBe(true);
    expect(titleOnly?.some((c) => c.includes('hub-badge-body-gap'))).toBe(false);
    expect(bodyOnly?.some((c) => c.includes('hub-badge-body-gap'))).toBe(true);
    expect(bodyOnly?.some((c) => c.includes('hub-badge-title-gap'))).toBe(false);
  });

  it('says "no description" rather than "why?" when the body is missing entirely', () => {
    // Two different problems deserve two different words: a body that says
    // the wrong thing is a rewrite, a body that says nothing is a write.
    renderBoard(
      root,
      boardSections(GOALS, [task({ bodyGaps: ['empty'] }), task({ bodyGaps: ['no-story'] })], filters),
      handlers(),
    );
    const labels = Array.from(root.querySelectorAll('.hub-badge-body-gap')).map(
      (b) => b.textContent ?? '',
    );
    expect(labels).toContain('no description');
    expect(labels).toContain('why?');
  });

  it('stays quiet on a row with neither gap', () => {
    // The everyday case. A marker on most of the board is a marker everyone
    // learns to skim past, so silence here is load-bearing.
    const [only] = badgeClassesPerRow([task({})]);
    expect(only?.some((c) => c.includes('gap'))).toBe(false);
  });
});
