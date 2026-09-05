import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardActions } from '../src/board/board-actions.ts';
import { boardData } from '../src/board/board-island.tsx';
import { createBoardRegion } from '../src/board/board-region.ts';
import { boardState, mountShell, task } from './support/board-region-harness.ts';

/**
 * The board pane: the bands, the restore list beside them, the Activity view
 * of the same column, and the one opener every task tap goes through.
 *
 * The rules driven here are the ones that were invisible while this was forty
 * functions inside a closure: the board island's host is never written by
 * vanilla code (which is why the restore list has a container of its own),
 * every surface that hides with the task list hides together, and opening a
 * row from anywhere clears the queue's aim so a stale mark cannot point at
 * the wrong thread.
 */
function region(over: Partial<Parameters<typeof createBoardRegion>[0]> = {}) {
  const el = mountShell();
  const state = boardState({
    info: {
      id: 'w-1',
      name: 'harbor-relay',
      goals: [{ id: 'g-1', title: 'Ship' }],
      createdAt: 1,
    } as never,
    tasks: new Map([['t-1', task('t-1', { goalId: 'g-1' } as never)]]),
  });
  const calls: string[] = [];
  const actions = new Proxy(
    {},
    {
      get:
        (_t, name: string) =>
        (...args: unknown[]) => {
          calls.push(`${name}:${String((args[0] as { id?: string })?.id ?? args[0])}`);
        },
    },
  ) as BoardActions;
  const renderDetail = vi.fn();
  const renderWalkthrough = vi.fn();
  const syncBoardUrl = vi.fn();
  const setNav = vi.fn();
  const api = createBoardRegion({
    state,
    user: { name: 'Bryan' },
    el,
    actions,
    taskList: () => [...state.tasks.values()],
    titleOf: (id) => state.tasks.get(id)?.title ?? id,
    currentQueue: () => ({ items: [], counts: {} }) as never,
    renderDetail,
    renderWalkthrough,
    syncBoardUrl,
    setNav,
    ...over,
  });
  return { el, state, calls, renderDetail, renderWalkthrough, syncBoardUrl, setNav, ...api };
}

describe('createBoardRegion', () => {
  beforeEach(() => {
    boardData.value = {
      sections: [],
      pane: 'board',
      showArchived: false,
      knownAgentIds: [],
      tasksById: new Map(),
      archivedCount: 0,
    };
  });

  it('opens a task and clears the queue’s aim, so no stale mark survives', () => {
    const r = region();
    r.state.detailThreadId = 'th-old';
    r.state.detailGoalId = 'g-1';
    r.openTaskDetail(task('t-1'), 'activity');
    expect(r.state.detailTaskId).toBe('t-1');
    expect(r.state.detailTab).toBe('activity');
    expect(r.state.detailGoalId).toBeNull();
    expect(r.state.detailThreadId).toBeNull();
    expect(r.renderDetail).toHaveBeenCalled();
  });

  it('opens a goal band on the goal panel, closing whatever task was up', () => {
    const r = region();
    r.state.detailTaskId = 't-1';
    r.boardHandlers.onOpenGoal?.({ id: 'g-1' } as never);
    expect(r.state.detailGoalId).toBe('g-1');
    expect(r.state.detailTaskId).toBeNull();
  });

  it('sends a row gesture through the REST verbs, never into the projection', () => {
    const r = region();
    r.boardHandlers.onStatusSet(task('t-1'), 'in-progress');
    r.boardHandlers.onAssign(task('t-1'), 'agent-a');
    expect(r.calls).toEqual(['transitionTask:t-1', 'assignTask:t-1']);
  });

  it('counts the lead among the people a task can be handed to', () => {
    // Whether or not the lead's session is currently attached: they own goal
    // changes here, so they are somebody.
    const r = region();
    r.state.agents = [{ agentId: 'a-1', state: 'active', stateLabel: 'active', lastToolCallAt: 1 }];
    (r.state.info as { leadAgentId?: string }).leadAgentId = 'a-lead';
    expect(r.knownAgentIds()).toEqual(['a-1', 'a-lead']);
  });

  it('paints the board through the signal, carrying the pane with it', () => {
    const r = region();
    r.state.pane = 'home';
    r.renderBoardRegion();
    expect(boardData.value.pane).toBe('home');
    expect(boardData.value.sections.length).toBeGreaterThan(0);
  });

  it('swaps the restore list in beside the island, never inside it', () => {
    // `#board` is the island's host for the life of the page, so the
    // archived view has to be a sibling container.
    const r = region();
    r.setShowArchived(true);
    expect(r.el('board').classList.contains('hidden')).toBe(true);
    expect(r.el('board-archived').classList.contains('hidden')).toBe(false);
    expect(r.el('board-archived').children.length).toBeGreaterThan(0);
    expect(r.syncBoardUrl).toHaveBeenCalled();
  });

  it('writes the address only when the archived filter actually moved', () => {
    const r = region();
    r.setShowArchived(false);
    expect(r.syncBoardUrl).not.toHaveBeenCalled();
  });

  it('counts archived bands in the door back to the restore list', () => {
    // A board whose only archived thing is a GOAL must not read "0 archived"
    // and hide the way in.
    const r = region();
    (r.state.info as { goals: unknown[] }).goals = [
      { id: 'g-1', title: 'Ship' },
      { id: 'g-2', title: 'Old', archivedAt: 5 },
    ];
    r.renderBoardRegion();
    expect(boardData.value.archivedCount).toBe(1);
  });

  it('hides everything that belongs to the task list when Activity is up', () => {
    const r = region();
    r.state.view = 'activity';
    r.renderActivityRegion();
    for (const id of ['board-quick', 'board-decisions', 'board-archived']) {
      expect(r.el(id).classList.contains('board-hidden-by-view')).toBe(true);
    }
    expect(r.el('board-activity').classList.contains('hidden')).toBe(false);
    expect(r.el('board').classList.contains('hidden')).toBe(true);
  });

  it('brings them all back when the reader leaves Activity', () => {
    const r = region();
    r.state.view = 'activity';
    r.renderActivityRegion();
    r.state.view = 'board';
    r.renderActivityRegion();
    for (const id of ['board-quick', 'board-decisions', 'board-archived']) {
      expect(r.el(id).classList.contains('board-hidden-by-view')).toBe(false);
    }
    expect(r.el('board-activity').classList.contains('hidden')).toBe(true);
  });
});
