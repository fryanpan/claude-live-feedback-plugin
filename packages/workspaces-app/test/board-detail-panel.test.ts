import type { FeedbackClient, User } from '@feedback/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardActions } from '../src/board/board-actions.ts';
import { createBoardDetailPanel } from '../src/board/board-detail-panel.ts';
import type { BoardDiscussion } from '../src/board/board-discussion.ts';
import type { BoardReviewController } from '../src/board/board-review-controller.ts';
import { goalDetailData } from '../src/board/goal-detail-island.tsx';
import { taskDetailData } from '../src/board/task-detail-island.tsx';
import { boardState, mountShell, task } from './support/board-region-harness.ts';

/**
 * One overlay, two things it can be showing.
 *
 * What these drive is the set of rules that only exist because the task panel
 * and the goal panel share a container: which of the two wins, that opening
 * one closes the other, that each fetch behind the panel happens once per
 * open rather than once per repaint (`renderDetail` runs on every board event
 * and clock tick), and that an in-flight load for a row the reader has left
 * never paints under the row they are on.
 */
function panel(over: Partial<Parameters<typeof createBoardDetailPanel>[0]> = {}) {
  const el = mountShell();
  const state = boardState({
    info: {
      id: 'w-1',
      name: 'harbor-relay',
      goals: [{ id: 'g-1', title: 'Ship' }],
      createdAt: 1,
    } as never,
    tasks: new Map([
      ['t-1', task('t-1', { goalId: 'g-1' } as never)],
      ['t-2', task('t-2', { goalId: 'g-1' } as never)],
    ]),
  });
  const loadDiscussion = vi.fn(async () => {});
  const loadEvents = vi.fn(async () => {});
  const noop = new Proxy({}, { get: () => () => undefined });
  const api = createBoardDetailPanel({
    state,
    user: { id: 'u-1', name: 'Bryan', kind: 'known', color: '#000' } as User,
    workspaceId: 'w-1',
    document,
    taskUrl: (id) => `https://board.example.com/workspaces/w-1?task=${id}`,
    goalUrl: (id) => `https://board.example.com/workspaces/w-1?goal=${id}`,
    actions: noop as BoardActions,
    review: noop as BoardReviewController,
    discussion: {
      goalBodyDocId: (s) => s.bodyDocId ?? `task:${s.id}`,
      loadDiscussion,
      postRowComment: async () => true,
    } as BoardDiscussion,
    taskList: () => [...state.tasks.values()],
    titleOf: (id) => id,
    knownAgentIds: () => [],
    loadEvents,
    syncBoardUrl: vi.fn(),
    connectMarkdown: () => ({}) as FeedbackClient,
    canWrite: true,
    boot: { goal: () => null, threadPending: () => false, clearThread: () => {} },
    ...over,
  });
  return { el, state, loadDiscussion, loadEvents, ...api };
}

beforeEach(() => {
  taskDetailData.value = { task: null } as never;
  goalDetailData.value = { section: null } as never;
});

describe('createBoardDetailPanel', () => {
  it('shows the task when both ids are somehow set — a task aim means "this task"', () => {
    const p = panel();
    p.state.detailGoalId = 'g-1';
    p.state.detailTaskId = 't-1';
    p.renderDetail();
    expect(p.state.detailGoalId).toBeNull();
    expect(taskDetailData.value.task?.id).toBe('t-1');
    expect(goalDetailData.value.section).toBeNull();
  });

  it('closes the task panel when a goal opens over it', () => {
    const p = panel();
    p.state.detailTaskId = 't-1';
    p.renderDetail();
    p.state.detailTaskId = null;
    p.state.detailGoalId = 'g-1';
    p.renderDetail();
    expect(goalDetailData.value.section?.id).toBe('g-1');
    expect(taskDetailData.value.task).toBeNull();
  });

  it('fetches a row’s comments once per open, not once per repaint', () => {
    // `renderDetail` runs on every board event and every clock tick; the
    // guard is the claimed discussion id, which is also what stops the
    // fetch's own re-render looping back through here.
    const p = panel();
    p.state.detailTaskId = 't-1';
    p.renderDetail();
    p.state.discussionTaskId = 't-1'; // what loadDiscussion claims
    p.renderDetail();
    p.renderDetail();
    expect(p.loadDiscussion).toHaveBeenCalledTimes(1);
  });

  it('fetches the audit rows once per open — never at boot, never per paint', () => {
    const p = panel();
    p.state.detailTaskId = 't-1';
    p.renderDetail();
    p.renderDetail();
    expect(p.loadEvents).toHaveBeenCalledTimes(1);
    p.state.detailTaskId = 't-2';
    p.renderDetail();
    expect(p.loadEvents).toHaveBeenCalledTimes(2);
  });

  it('holds the pane at "loading" rather than painting another row’s comments', () => {
    const p = panel();
    p.state.detailTaskId = 't-1';
    p.state.discussionTaskId = 't-2';
    p.state.discussion = { loading: false, threads: [{ id: 'th-other', comments: [] }] };
    p.renderDetail();
    expect(taskDetailData.value.discussion?.threads).toEqual([]);
    expect(taskDetailData.value.discussion?.loading).toBe(true);
  });

  it('starts the next open on Comments, whatever tab the last one ended on', () => {
    const p = panel();
    p.state.detailTaskId = 't-1';
    p.state.detailTab = 'activity';
    p.renderDetail();
    p.state.detailTaskId = null;
    p.renderDetail();
    expect(p.state.detailTab).toBe('comments');
  });

  it('gives the reader their place back when the panel closes', () => {
    const p = panel();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    p.state.detailTaskId = 't-1';
    p.renderDetail();
    p.state.detailTaskId = null;
    p.renderDetail();
    expect(document.activeElement).toBe(opener);
  });

  it('opens an ARCHIVED band, because the panel is where its Restore lives', () => {
    // An archived goal is in no board section at all; a link somebody sent
    // last week still has to open it.
    const p = panel();
    (p.state.info as { goals: unknown[] }).goals = [{ id: 'g-9', title: 'Old', archivedAt: 5 }];
    p.state.detailGoalId = 'g-9';
    p.renderDetail();
    expect(goalDetailData.value.section?.id).toBe('g-9');
  });

  it('leaves an unconfirmed boot goal alone, and clears one that truly left', () => {
    const pending = panel({
      boot: { goal: () => 'g-later', threadPending: () => false, clearThread: () => {} },
    });
    pending.state.detailGoalId = 'g-later';
    pending.renderDetail();
    expect(pending.state.detailGoalId).toBe('g-later');

    const denied = panel();
    denied.state.detailGoalId = 'g-gone';
    denied.renderDetail();
    expect(denied.state.detailGoalId).toBeNull();
  });

  it('aims one open at the title, and only that one', () => {
    // A task filed empty opens with the cursor in its name; reopening the
    // same row later must not start a rename.
    const p = panel();
    p.setFocusTitle('t-1');
    p.state.detailTaskId = 't-1';
    p.renderDetail();
    expect(taskDetailData.value.handlers?.focusTitle).toBe(true);
    p.state.detailTaskId = 't-2';
    p.renderDetail();
    p.state.detailTaskId = 't-1';
    p.renderDetail();
    expect(taskDetailData.value.handlers?.focusTitle).toBe(false);
  });
});
