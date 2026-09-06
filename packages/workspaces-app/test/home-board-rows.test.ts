/**
 * Home carries no board rows.
 *
 * The board column is `display: none` on Home (`.board-main--home .board-col`),
 * and until this test existed the render path ran there anyway: `setNav`
 * called `renderBoardRegion()` for every destination, so arriving at Home
 * built one `.board-task-row` per task — 70 of them on the real board, measured
 * headless at 430x932 and 1180x820 — each with its selects and its drag and
 * keyboard listeners, and then collapsed the lot to zero height.
 *
 * Zero-height rows are not merely waste. They answer DOM queries, so anything
 * that reads the board by selector gets a full row set on a page showing
 * none, and `document.scrollHeight` on Home reported 998px against a 932px
 * viewport — a scroll probe that looks like it ran and saw nothing.
 *
 * The comment that used to justify the hiding said the board "keeps its
 * realtime projection warm underneath". The projection is `state.tasks`, fed
 * by the ydoc; the rows are derived output rebuilt from it in one pass. So the
 * fix is to stop rendering them, and the round-trip case below is what proves
 * the unmount is not one-way.
 *
 * All fixtures are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BoardFilters,
  type BoardGoal,
  type BoardTask,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  boardSections,
} from '../src/board/board-model.ts';
import { WS, boardRow, bootTestBoard, resetBoardServer } from './support/board-drive.ts';
import { type ShimHandlers as BoardHandlers, disposeBoards, renderBoard } from './support/board.ts';

const NOW = 1_700_000_000_000;

const GOALS: BoardGoal[] = [{ id: 'g-pr', title: '1. Get the PR out' }];

const filters: BoardFilters = {
  tab: 'all',
  userName: 'Jordan',
  doneWindow: DEFAULT_DONE_WINDOW,
  now: NOW,
};

function task(n: number): BoardTask {
  return {
    id: `t-${n}`,
    title: `Task ${n}`,
    status: 'todo',
    assignee: 'agent',
    goal: n % 2 === 0 ? 'g-pr' : CHORES_ID,
    order: n,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${n}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const TASKS = Array.from({ length: 12 }, (_, i) => task(i + 1));

function handlers(): BoardHandlers {
  return {
    onStatusSet: vi.fn(),
    onGoalTitleCommit: vi.fn(),
    onGoalAdd: vi.fn(),
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
afterEach(disposeBoards);

const rowCount = () => root.querySelectorAll('.board-task-row').length;

describe('the board island’s pane gate', () => {
  it('renders the rows on the board — the control the Home case is measured against', () => {
    renderBoard(root, boardSections(GOALS, TASKS, filters), handlers(), 'board');
    expect(rowCount()).toBe(TASKS.length);
  });

  it('renders NOTHING on Home — not a hidden row set, no rows at all', () => {
    renderBoard(root, boardSections(GOALS, TASKS, filters), handlers(), 'home');
    expect(rowCount()).toBe(0);
    // The sections and the "New goal" row go with them: the whole column is
    // off screen, so nothing in it has a reader. What is left is the island's
    // own wrapper — the container Preact owns, which must not be torn down and
    // rebuilt per pane — and it is EMPTY, which is the claim being made here.
    expect(root.querySelectorAll('.board-section')).toHaveLength(0);
    const wrapper = root.querySelector('[data-preact-island="board"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.childNodes.length).toBe(0);
    expect(root.childElementCount).toBe(1);
  });

  it('clears rows already on screen when the reader leaves the board for Home', () => {
    renderBoard(root, boardSections(GOALS, TASKS, filters), handlers(), 'board');
    expect(rowCount()).toBe(TASKS.length);
    renderBoard(root, boardSections(GOALS, TASKS, filters), handlers(), 'home');
    expect(rowCount()).toBe(0);
  });

  it('brings them back on the way in — the unmount is not one-way', () => {
    renderBoard(root, boardSections(GOALS, TASKS, filters), handlers(), 'home');
    renderBoard(root, boardSections(GOALS, TASKS, filters), handlers(), 'board');
    expect(rowCount()).toBe(TASKS.length);
    // Live, not a corpse: the row still carries the wiring a fresh render
    // gives it, so returning to the board is a working board.
    const row = root.querySelector('.board-task-row') as HTMLElement;
    expect(row.querySelector('.board-status-select')).not.toBeNull();
    expect(row.querySelector('.board-drag-handle')).not.toBeNull();
  });
});

/**
 * The gate, on a real board rather than on the render shim.
 *
 * DRIVEN, NOT GREPPED. This used to read the seventeen board boot modules as
 * one string, cut `renderBoardRegion` out with a regex and match
 * `boardData.value = { … pane: state.pane,` inside it. That is a claim about
 * how the signal write is SPELLED: `pane` reaching the island from anywhere
 * else, or reaching it hard-coded, satisfies it — and the measurement that
 * started this ticket was a DOM query (70 zero-height `.board-task-row` nodes
 * answering selectors on a page showing none), so make the same query.
 *
 * The four cases above drive the island directly and are the gate's own unit
 * tests. These two are the wiring: the real boot, on the real route, and the
 * rows counted in the document.
 */
describe('the board wires the pane through', () => {
  beforeEach(resetBoardServer);
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const rowsInDocument = () => document.querySelectorAll('.board-task-row').length;
  const booted = Array.from({ length: 6 }, (_, i) => boardRow(`t-${i + 1}`, { order: i + 1 }));

  it('a boot on /tasks paints the rows — the control the Home case is measured against', async () => {
    await bootTestBoard({ url: `https://board.test/workspaces/${WS}/tasks`, tasks: booted });
    expect(rowsInDocument()).toBe(booted.length);
  });

  it('a boot on /home paints none of them, not a hidden set', async () => {
    // The 998px scrollHeight on a 932px viewport: rows that answer queries on
    // a page showing none. `document`, not the island's container, because
    // "anything that reads the board by selector" is the thing that broke.
    await bootTestBoard({ url: `https://board.test/workspaces/${WS}/home`, tasks: booted });
    expect(rowsInDocument()).toBe(0);
    // Positive control: the projection really did land — the rows are absent
    // because the pane says so, not because the board has no tasks.
    expect(document.getElementById('board-home')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('board-main')?.classList.contains('board-main--home')).toBe(
      true,
    );
  });

  it('walking Home → board → Home builds them and takes them away again', async () => {
    // The signal write is per-paint, so the gate has to hold on every arrival,
    // not only on the one the boot happened to start at.
    const board = await bootTestBoard({
      url: `https://board.test/workspaces/${WS}/home`,
      tasks: booted,
    });
    expect(rowsInDocument()).toBe(0);
    await board.traverseTo(`https://board.test/workspaces/${WS}/tasks`);
    expect(rowsInDocument()).toBe(booted.length);
    await board.traverseTo(`https://board.test/workspaces/${WS}/home`);
    expect(rowsInDocument()).toBe(0);
  });
});
