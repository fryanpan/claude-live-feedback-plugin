/**
 * The board's reading of the `triage` status — a row an agent filed that
 * nobody has vetted yet.
 *
 * Two halves, and they fail differently. The DOM half pins what the renderer
 * emits: the row's class, the mark's class, and a dropdown that offers triage
 * so clearing it is one tap. The treatment half pins what those classes BUY —
 * a dashed yellow ring, a muted title, and the yellow edge down the left of
 * the row — by installing the page's sheets and reading the computed value
 * off the row the board rendered. It used to grep `hub.css` for the
 * declarations, which passes against any file that still holds the strings:
 * against a rule a later one overrides, against a selector the row no longer
 * carries, against a media query that does not match at the width being read.
 *
 * The last case is about somebody else's client: a status string this bundle
 * has never heard of must render as itself rather than as `undefined`, since
 * a shared server can hand an older tab a status its enum predates.
 *
 * All fixtures are synthetic — invented names, jordan@partner.example register.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BoardFilters,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  TASK_STATUS_ORDER,
  boardSections,
} from '../src/hub/hub-board-model.ts';
import { IPAD, installSheets, setViewport, styleOf } from './css-harness.ts';
import { type ShimHandlers as BoardHandlers, disposeBoards, renderBoard } from './support/board.ts';

/** The value a design token resolves to, so an assertion names the token the
 *  stylesheet names rather than a hex string copied out of it. */
function token(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  expect(value, `no value for ${name}`).not.toBe('');
  return value;
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
/** The page's own sheets, in the order the hub shell loads them. Installing
 *  them changes no text and no structure, so the DOM cases above are
 *  unaffected; the viewport is stated because happy-dom's default (1024px)
 *  sits inside this project's mobile tier and a media query would silently
 *  decide the answer. */
let sheets = () => {};
beforeEach(() => {
  setViewport(IPAD);
  sheets = installSheets('hub.css', 'styles.css');
  root = document.createElement('div');
  root.className = 'hub-board';
  document.body.replaceChildren(root);
});
// The board is a mounted island now, not a call that returns; every mount
// holds a live subscription to the module-level signal until it is disposed.
afterEach(() => {
  sheets();
  disposeBoards();
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

/**
 * The treatment, measured on the row the board rendered.
 *
 * `paint` mounts a real board holding one triage row and one ordinary one, so
 * every assertion below reads a value off an element the renderer produced —
 * and the ordinary row is the control that says the difference is the triage
 * classes and not the sheet failing to attach.
 */
describe('the triage treatment', () => {
  function paint(): { triage: HTMLElement; plain: HTMLElement; done: HTMLElement } {
    const rows = [
      task({ goal: 'g-pr', order: 1, status: 'triage' }),
      task({ goal: 'g-pr', order: 2, status: 'todo' }),
      task({ goal: 'g-pr', order: 3, status: 'done' }),
    ];
    renderBoard(root, boardSections(GOALS, rows, { ...filters, doneWindow: 'all' }), handlers());
    const found = [...root.querySelectorAll('.hub-task-row')] as HTMLElement[];
    expect(found, 'the board did not render three rows').toHaveLength(3);
    return { triage: found[0], plain: found[1], done: found[2] };
  }

  it('draws the status ring dashed and yellow', () => {
    const { triage, plain } = paint();
    const mark = triage.querySelector('.hub-status-mark-triage') as HTMLElement;
    expect(mark).not.toBeNull();
    expect(styleOf(mark).borderStyle).toBe('dashed');
    expect(styleOf(mark).borderColor).toBe(token('--yellow'));
    // Control: an ordinary row's mark is reached by the same cascade and is
    // NOT dashed, so `dashed` above is the triage rule and not a default.
    const plainMark = plain.querySelector('.hub-status-mark') as HTMLElement;
    expect(styleOf(plainMark).borderStyle).not.toBe('dashed');
    expect(styleOf(plainMark).borderWidth).not.toBe('');
  });

  it('mutes the title and runs a yellow edge down the left of the row', () => {
    const { triage, plain } = paint();
    expect(styleOf(triage).boxShadow).toBe(`inset 2px 0 0 ${token('--yellow')}`);
    const title = triage.querySelector('.hub-task-title') as HTMLElement;
    expect(styleOf(title).color).toBe(token('--fg-muted'));
    // Control: the same element on an untriaged row reads the ordinary
    // foreground, so "muted" is a difference and not the whole board's colour.
    const plainTitle = plain.querySelector('.hub-task-title') as HTMLElement;
    expect(styleOf(plainTitle).color).not.toBe(token('--fg-muted'));
    expect(styleOf(plain).boxShadow).not.toBe(`inset 2px 0 0 ${token('--yellow')}`);
  });

  it('does not strike the title through — that reading belongs to done', () => {
    const { triage, done } = paint();
    const title = triage.querySelector('.hub-task-title') as HTMLElement;
    expect(styleOf(title).textDecoration).not.toContain('line-through');
    // Control: a DONE row's title is struck through by the same cascade, so
    // the absence above is an absence and not a property happy-dom cannot see.
    const doneTitle = done.querySelector('.hub-task-title') as HTMLElement;
    expect(styleOf(doneTitle).textDecoration).toContain('line-through');
  });
});
