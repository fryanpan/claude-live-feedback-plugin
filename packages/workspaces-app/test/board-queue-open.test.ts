import { describe, expect, it, vi } from 'vitest';
import type { BoardHandlers } from '../src/board/board-island.tsx';
import { createBoardQueueOpeners } from '../src/board/board-queue-open.ts';
import type { ReviewItem } from '../src/board/board-review-model.ts';
import { boardState, task } from './support/board-region-harness.ts';

/**
 * Five kinds of row land in one queue and each has a different "there". What
 * these drive is the routing — which surface each kind opens, that the panel
 * is AIMED at the queued thread rather than dropped at its top, and the one
 * return value the walkthrough keys its repaint on.
 */
function openers(over: Partial<Parameters<typeof createBoardQueueOpeners>[0]> = {}) {
  const state = boardState({ tasks: new Map([['t-1', task('t-1')]]) });
  const opened: string[] = [];
  const assigned: string[] = [];
  const renderDetail = vi.fn();
  const boardHandlers = {
    onOpenTask: (t: { id: string }) => {
      opened.push(t.id);
    },
  } as unknown as BoardHandlers;
  const api = createBoardQueueOpeners({
    state,
    workspaceId: 'w-1',
    boardHandlers,
    renderDetail,
    location: { assign: (u: string) => assigned.push(u) },
    ...over,
  });
  return { state, opened, assigned, renderDetail, ...api };
}

const item = (over: Record<string, unknown>): ReviewItem =>
  ({ key: 'k', ...over }) as unknown as ReviewItem;

describe('createBoardQueueOpeners', () => {
  it('opens a task-thread row on its task, aimed at the queued thread', () => {
    const o = openers();
    const still = o.openReviewItem(
      item({ thread: { kind: 'task-thread', taskId: 't-1', threadId: 'th-9', docId: 'task:t-1' } }),
    );
    expect(o.opened).toEqual(['t-1']);
    expect(o.state.detailThreadId).toBe('th-9');
    expect(still).toBe(true);
  });

  it('opens a goal-band row on the GOAL panel, never the task panel', () => {
    const o = openers();
    o.state.detailTaskId = 't-1';
    o.openReviewItem(
      item({ thread: { kind: 'goal-thread', taskId: 'g-2', threadId: 'th-3', docId: 'goal:g-2' } }),
    );
    expect(o.state.detailGoalId).toBe('g-2');
    expect(o.state.detailTaskId).toBeNull();
    expect(o.state.detailThreadId).toBe('th-3');
    expect(o.opened).toEqual([]);
  });

  it('opens a ticket-borne item on its task and never navigates', () => {
    // The fall-through below used to send this row to `/review/undefined`.
    const o = openers();
    o.openReviewItem(
      item({ thread: { kind: 'task-review', taskId: 't-1', threadId: 'th-1', docId: 'task:t-1' } }),
    );
    expect(o.opened).toEqual(['t-1']);
    expect(o.assigned).toEqual([]);
  });

  it('leaves the page for a doc comment, and says so', () => {
    const o = openers();
    const still = o.openReviewItem(
      item({ thread: { kind: 'doc', docId: 'plan-a', threadId: 'th-7' } }),
    );
    expect(still).toBe(false);
    expect(o.assigned).toEqual(['/workspaces/w-1/docs/plan-a?thread=th-7']);
  });

  it('carries the reader’s queue place onto the doc URL, but only when asked', () => {
    const o = openers();
    o.openReviewItem(item({ thread: { kind: 'doc', docId: 'plan-a', threadId: 'th-7' } }), 'k-42');
    expect(o.assigned[0]).toContain('&item=k-42');

    const bare = openers();
    bare.openReviewItem(item({ thread: { kind: 'doc', docId: 'plan-a', threadId: 'th-7' } }));
    expect(bare.assigned[0]).not.toContain('item=');
  });

  it('opens a revised decision’s question on the task doc that holds it', () => {
    const o = openers();
    o.openReviewThread(
      item({
        decision: { task: task('t-1') } as never,
        revision: { threadId: 'th-rev' } as never,
      }),
    );
    expect(o.opened).toEqual(['t-1']);
    expect(o.state.detailThreadId).toBe('th-rev');
  });

  it('does nothing but stay put when the row names a task the board has lost', () => {
    const o = openers();
    const still = o.openTaskThread('t-gone', 'th-1');
    expect(still).toBe(true);
    expect(o.opened).toEqual([]);
    expect(o.renderDetail).not.toHaveBeenCalled();
  });
});
