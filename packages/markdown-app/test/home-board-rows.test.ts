/**
 * Home carries no board rows.
 *
 * The board column is `display: none` on Home (`.hub-main--home .hub-board-col`),
 * and until this test existed the render path ran there anyway: `setNav`
 * called `renderBoardRegion()` for every destination, so arriving at Home
 * built one `.hub-task-row` per task — 70 of them on the real board, measured
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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BoardFilters,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  boardSections,
} from '../src/hub/hub-model.ts';
import { type ShimHandlers as BoardHandlers, disposeBoards, renderBoard } from './support/board.ts';

const HUB_APP = readFileSync(resolve(import.meta.dirname, '../src/hub/hub-app.ts'), 'utf8');

const NOW = 1_700_000_000_000;

const GOALS: HubGoal[] = [{ id: 'g-pr', title: '1. Get the PR out' }];

const filters: BoardFilters = {
  tab: 'all',
  userName: 'Jordan',
  doneWindow: DEFAULT_DONE_WINDOW,
  now: NOW,
};

function task(n: number): HubTask {
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

const rowCount = () => root.querySelectorAll('.hub-task-row').length;

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
    expect(root.querySelectorAll('.hub-section')).toHaveLength(0);
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
    const row = root.querySelector('.hub-task-row') as HTMLElement;
    expect(row.querySelector('.hub-status-select')).not.toBeNull();
    expect(row.querySelector('.hub-drag-handle')).not.toBeNull();
  });
});

describe('the hub wires the pane through', () => {
  it('renderBoardRegion writes state.pane into the signal, so the gate cannot be bypassed', () => {
    const body = HUB_APP.match(/function renderBoardRegion\([\s\S]*?\n {2}\}\n/)?.[0] ?? '';
    expect(body, 'renderBoardRegion went missing from hub-app.ts').not.toBe('');
    expect(body).toMatch(/boardData\.value = \{[\s\S]*?pane: state\.pane,/);
  });
});
