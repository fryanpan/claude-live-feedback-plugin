/**
 * A long goal displays short, and the full text is one TAP away.
 *
 * The goal is the biggest single thing on the board: measured on a 430px
 * phone the goal card alone ran 517px tall and pushed the first task row
 * 1018px down the page, and the same paragraph repeats verbatim inside every
 * task's "Triaged against" row. Both surfaces are covered here.
 *
 * The affordance is asserted as a real `<button>` with an `aria-expanded`
 * state rather than "some element becomes visible": on a phone there is no
 * hover, so a control that only appears or only works on hover is not a
 * control at all.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { clipGoal } from '@feedback/core/goal-summary';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHORES_ID, type HubTask } from '../src/hub/hub-model.ts';
import { renderGoalStrip, renderTaskDetail } from '../src/hub/hub-render.ts';

const LONG_GOAL = [
  'Make the intake queue smooth for the whole crew, then prove it with a week of real traffic.',
  'After that, wire the reporting surface so nobody has to ask where a request went.',
  'Everything else waits until those two hold under load.',
].join('\n\n');

let root: HTMLElement;
beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});

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
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  } as HubTask;
}

function detailHandlers() {
  return {
    onAssign: vi.fn(),
    onTitleCommit: vi.fn(),
    onStatusSet: vi.fn(),
    onOpenBody: vi.fn(),
    onAnswer: vi.fn(),
    onPostComment: vi.fn(),
    onOpenThread: vi.fn(),
    onClose: vi.fn(),
  };
}

describe('goal strip', () => {
  it('shows a short summary of a long goal, not the whole thing', () => {
    renderGoalStrip(root, LONG_GOAL, { onGoalCommit: vi.fn() });
    const body = root.querySelector('.hub-goal-body') as HTMLElement;
    expect(body.textContent).toContain('Make the intake queue smooth');
    expect(body.textContent).not.toContain('Everything else waits');
    expect(body.textContent?.trim()).toBe(clipGoal(LONG_GOAL));
  });

  it('reveals the full goal on a tap, and folds it back', () => {
    renderGoalStrip(root, LONG_GOAL, { onGoalCommit: vi.fn() });
    const more = root.querySelector('.hub-goal-more') as HTMLButtonElement;
    // A real button, reachable without a pointer that can hover.
    expect(more.tagName).toBe('BUTTON');
    expect(more.getAttribute('aria-expanded')).toBe('false');

    more.click();
    const expanded = root.querySelector('.hub-goal-more') as HTMLButtonElement;
    expect(expanded.getAttribute('aria-expanded')).toBe('true');
    expect((root.querySelector('.hub-goal-body') as HTMLElement).textContent).toContain(
      'Everything else waits',
    );

    expanded.click();
    expect((root.querySelector('.hub-goal-body') as HTMLElement).textContent).not.toContain(
      'Everything else waits',
    );
  });

  it('offers no toggle when the whole goal already fits, and keeps its markdown', () => {
    // Positive control: the long goal above DID produce a toggle, so this
    // absence is a decision and not a selector that never matches.
    renderGoalStrip(root, LONG_GOAL, { onGoalCommit: vi.fn() });
    expect(root.querySelector('.hub-goal-more')).not.toBeNull();

    renderGoalStrip(root, 'Ship **search v2**.', { onGoalCommit: vi.fn() });
    expect(root.querySelector('.hub-goal-more')).toBeNull();
    expect(root.querySelector('.hub-goal-body strong')?.textContent).toBe('search v2');
  });

  it('prefers a stored summary written for this goal', () => {
    renderGoalStrip(
      root,
      LONG_GOAL,
      { onGoalCommit: vi.fn() },
      {
        text: 'Intake, then reporting, then the rest.',
        goalHash: 'wrong-hash',
        ts: 1,
      },
    );
    // Stale by hash — the clip wins, so the board can never show a line
    // describing a goal that was replaced.
    expect((root.querySelector('.hub-goal-body') as HTMLElement).textContent?.trim()).toBe(
      clipGoal(LONG_GOAL),
    );
  });

  it('lets the summary be edited in place, alongside the goal', () => {
    const onGoalCommit = vi.fn();
    renderGoalStrip(root, LONG_GOAL, { onGoalCommit });
    (root.querySelector('.hub-goal-edit') as HTMLElement).click();
    const ta = root.querySelector('textarea') as HTMLTextAreaElement;
    const summary = root.querySelector('.hub-goal-summary-input') as HTMLInputElement;
    expect(summary).not.toBeNull();
    summary.value = 'Intake, then reporting, then the rest.';
    (root.querySelector('.hub-btn-primary') as HTMLElement).click();
    expect(onGoalCommit).toHaveBeenCalledWith(ta.value, 'Intake, then reporting, then the rest.');
  });
});

describe('task detail — triaged against', () => {
  it('shows the goal it was judged against short, with the full text on a tap', () => {
    renderTaskDetail(
      root,
      task({ triagedAgainst: { goalId: 'g-one', goal: LONG_GOAL, ts: 1 } }),
      detailHandlers(),
    );
    const row = root.querySelector('.hub-meta-collapsible') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).not.toContain('Everything else waits');

    const more = row.querySelector('button') as HTMLButtonElement;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    more.click();
    expect((root.querySelector('.hub-meta-collapsible') as HTMLElement).textContent).toContain(
      'Everything else waits',
    );
  });

  it('does not offer a toggle for a goal that already fits', () => {
    // Positive control above: the long goal produced one.
    renderTaskDetail(
      root,
      task({ triagedAgainst: { goalId: 'g-one', goal: 'Ship the search.', ts: 1 } }),
      detailHandlers(),
    );
    expect(root.textContent).toContain('Ship the search.');
    expect(root.querySelector('.hub-meta-collapsible button')).toBeNull();
  });
});
