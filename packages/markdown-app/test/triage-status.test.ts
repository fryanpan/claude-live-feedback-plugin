/**
 * The board's reading of the `triage` status — a row an agent filed that
 * nobody has vetted yet.
 *
 * Two halves, and they fail differently. The DOM half pins what the renderer
 * emits: the row's class, the mark's class, and a dropdown that offers triage
 * so clearing it is one tap. The stylesheet half pins the treatment those
 * classes buy, because none of it is reachable from a DOM assertion in a
 * layout-free runner — a dashed yellow ring, a muted title, and the yellow
 * edge down the left of the row.
 *
 * The last case is about somebody else's client: a status string this bundle
 * has never heard of must render as itself rather than as `undefined`, since
 * a shared server can hand an older tab a status its enum predates.
 *
 * All fixtures are synthetic — invented names, jordan@partner.example register.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BoardFilters,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  TASK_STATUS_ORDER,
  boardSections,
} from '../src/hub/hub-model.ts';
import { type BoardHandlers, renderBoard } from '../src/hub/hub-render.ts';

const CSS = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8');

/** The body of the `selector { … }` rule, asserted to exist so a renamed
 *  selector fails loudly rather than passing against an empty string. */
function ruleBody(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(CSS);
  expect(m, `no rule for ${selector}`).not.toBeNull();
  return m?.[1] ?? '';
}

const NOW = 1_700_000_000_000;

let seq = 0;
function task(overrides: Partial<HubTask> = {}): HubTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'todo',
    assignee: 'Search Revamp',
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

const GOALS: HubGoal[] = [{ id: 'g-pr', title: '1. Get the PR out' }];

const filters: BoardFilters = {
  tab: 'all',
  userName: 'Jordan',
  doneWindow: DEFAULT_DONE_WINDOW,
  now: NOW,
};

function handlers(over: Partial<BoardHandlers> = {}): BoardHandlers {
  return {
    onStatusSet: vi.fn(),
    onGoalTitleCommit: vi.fn(),
    onGoalAdd: vi.fn(),
    onOpenTask: vi.fn(),
    onReorder: vi.fn(),
    onTitleCommit: vi.fn(),
    onAssign: vi.fn(),
    inlineTitleEdit: () => true,
    ...over,
  };
}

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.replaceChildren(root);
});

describe('a triage row on the board', () => {
  it('is listed in its band, in its order — triage is a status, not a section', () => {
    const first = task({ goal: 'g-pr', order: 1, status: 'triage' });
    const second = task({ goal: 'g-pr', order: 2 });
    renderBoard(root, boardSections(GOALS, [first, second], filters), handlers());
    const rows = Array.from(root.querySelectorAll('.hub-task-row')) as HTMLElement[];
    expect(rows.map((r) => r.dataset.taskId)).toEqual([first.id, second.id]);
  });

  it('carries the row and mark classes the triage treatment hangs off', () => {
    const t = task({ goal: 'g-pr', status: 'triage' });
    renderBoard(root, boardSections(GOALS, [t], filters), handlers());
    const row = root.querySelector('.hub-task-row') as HTMLElement;
    expect(row.classList.contains('hub-status-triage')).toBe(true);
    expect(row.querySelector('.hub-status-mark-triage')).not.toBeNull();
    // Not the done treatment, which is the other muted state on this list.
    expect(row.classList.contains('hub-done')).toBe(false);
  });

  it('offers triage in the dropdown, so any move out is one tap', () => {
    const h = handlers();
    const t = task({ goal: 'g-pr', status: 'triage' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    const select = root.querySelector('.hub-status-select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([...TASK_STATUS_ORDER]);
    expect(select.value).toBe('triage');
    expect(select.getAttribute('aria-label')).toBe('Status: Triage');
    select.value = 'todo';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(h.onStatusSet).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }), 'todo');
  });

  it('orders triage first — it is what a row is before todo', () => {
    expect(TASK_STATUS_ORDER[0]).toBe('triage');
    expect([...TASK_STATUS_ORDER]).toEqual(['triage', 'todo', 'in-progress', 'done']);
  });

  it('renders a status this bundle has never heard of as itself, not as undefined', () => {
    // A shared server can hand an older tab a status its enum predates. The
    // row must still draw, and the label must still say something.
    const t = task({ goal: 'g-pr', status: 'parked-forever' as HubTask['status'] });
    renderBoard(root, boardSections(GOALS, [t], filters), handlers());
    const select = root.querySelector('.hub-status-select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toContain('parked-forever');
    expect(select.value).toBe('parked-forever');
    expect(select.getAttribute('aria-label')).toBe('Status: parked-forever');
  });
});

describe('the triage treatment in the stylesheet', () => {
  it('draws the status ring dashed and yellow', () => {
    const body = ruleBody('.hub-status-mark-triage');
    expect(body).toMatch(/border-style:\s*dashed/);
    expect(body).toMatch(/border-color:\s*var\(--yellow\)/);
  });

  it('mutes the title and runs a yellow edge down the left of the row', () => {
    expect(ruleBody('.hub-status-triage')).toMatch(
      /box-shadow:\s*inset\s+2px\s+0\s+0\s+var\(--yellow\)/,
    );
    expect(ruleBody('.hub-status-triage .hub-task-title')).toMatch(/color:\s*var\(--fg-muted\)/);
  });

  it('does not strike the title through — that reading belongs to done', () => {
    expect(ruleBody('.hub-status-triage .hub-task-title')).not.toMatch(/line-through/);
  });
});
