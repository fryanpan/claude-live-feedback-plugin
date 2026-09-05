/**
 * A review item raised on a TICKET stays in the task's comment history after
 * it is answered — at the time it was raised, in an answered state.
 *
 * Bryan, 2026-09-01: *"Review items disappear and I can't find them any
 * more."* A ticket-borne item reached the panel only through the review-items
 * route, which ships what is still waiting; answering it dropped it from that
 * list and nothing else drew `task.reviews` except the held note. These pin
 * the stream, the row, and the Activity line for the ask.
 *
 * Fixtures are synthetic — invented ids and generic personas.
 */
import { options } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type DetailHandlers,
  type TaskDiscussion,
  type TaskThread,
} from '../src/board/board-detail-render.ts';
import { commentRow, discussionStream } from '../src/board/board-discussion-render.ts';
import { type BoardReviewItem, type BoardTask, CHORES_ID } from '../src/board/board-model.ts';
import { describeEvent } from '../src/board/board-presence-model.ts';
import { reviewItemRow } from '../src/board/board-review-render.ts';
import { mountTaskDetailIsland, taskDetailData } from '../src/board/task-detail-island.tsx';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

options.debounceRendering = (cb: () => void) => cb();

function item(id: string, over: Partial<BoardReviewItem> = {}): BoardReviewItem {
  return {
    id,
    review: { shape: 'decision', headline: `Ask ${id}`, detail: 'Because of the cost.' },
    createdBy: 'Scheduler Agent',
    createdAt: NOW - 2 * HOUR,
    judge: { at: NOW - 2 * HOUR, verdict: 'ok', reason: 'fine' },
    ...over,
  };
}

const ANSWERED = item('ri-answered', {
  answer: { text: 'Keep disk', by: 'Reviewer', ts: NOW - HOUR, answeredWith: 'o-1' },
});

const c = (author: string, ts: number) => ({ author, text: `${author} at ${ts}`, ts });

describe('discussionStream', () => {
  it('places a ticket-borne item among the comments at the time it was raised', () => {
    const threads: TaskThread[] = [
      { id: 'th-a', comments: [c('Jordan', NOW - 3 * HOUR), c('Jordan', NOW - HOUR)] },
    ];
    const rows = discussionStream(threads, [ANSWERED]);
    expect(rows.map((r) => (r.kind === 'comment' ? r.row.comment.ts : r.item.createdAt))).toEqual([
      NOW - 3 * HOUR,
      NOW - 2 * HOUR,
      NOW - HOUR,
    ]);
    expect(rows[1]?.kind).toBe('review-item');
  });

  it('keeps an ANSWERED item in the stream — the regression', () => {
    const rows = discussionStream([], [ANSWERED]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind === 'review-item' && rows[0].item.answer?.text).toBe('Keep disk');
  });

  it('shows an open item too, so answering it changes its state rather than its presence', () => {
    const rows = discussionStream([], [item('ri-open')]);
    expect(rows.map((r) => r.kind)).toEqual(['review-item']);
  });

  it('leaves out an item the gate is holding or still judging — it has not been asked yet', () => {
    const rows = discussionStream(
      [],
      [
        item('ri-held', { judge: { at: NOW, verdict: 'held', reason: 'No stakes.' } }),
        item('ri-pending', { judge: { at: NOW, verdict: 'pending', reason: '' } }),
        // Control: a held item somebody ANSWERED anyway (released, then
        // answered) is history and stays.
        item('ri-held-answered', {
          judge: { at: NOW, verdict: 'held', reason: 'No stakes.' },
          answer: { text: 'fine' },
        }),
      ],
    );
    expect(rows.map((r) => (r.kind === 'review-item' ? r.item.id : ''))).toEqual([
      'ri-held-answered',
    ]);
  });

  it('is exactly the comments when a task has no items, and empty with neither', () => {
    const threads: TaskThread[] = [{ id: 'th', comments: [c('Jo', 1)] }];
    expect(discussionStream(threads, undefined).map((r) => r.kind)).toEqual(['comment']);
    expect(discussionStream([], undefined)).toEqual([]);
  });
});

describe('reviewItemRow', () => {
  it('renders the ask, who raised it, and the answered record with who and when', () => {
    const li = reviewItemRow(ANSWERED, NOW, 'Someone Else');
    expect(li.dataset.reviewItemId).toBe('ri-answered');
    expect(li.querySelector('.board-comment-author')?.textContent).toBe('Scheduler Agent');
    expect(li.querySelector('.board-comment-review-k')?.textContent).toBe('Decision');
    expect(li.querySelector('.board-comment-review-k')?.classList.contains('is-answered')).toBe(
      true,
    );
    expect(li.querySelector('.board-comment-review-headline')?.textContent).toBe('Ask ri-answered');
    expect(li.querySelector('.board-comment-body')?.textContent).toContain('Because of the cost.');
    const record = li.querySelector('.board-comment-answered');
    expect(record?.textContent).toContain('Answered by Reviewer: “Keep disk”');
    expect(record?.querySelector('.board-comment-when')?.textContent).toBe('1h ago');
  });

  it('says "Answered by you" for the reader’s own answer', () => {
    const li = reviewItemRow(ANSWERED, NOW, 'Reviewer');
    expect(li.querySelector('.board-comment-answered')?.textContent).toContain(
      'Answered by you: “Keep disk”',
    );
  });

  it('draws an open item as a question with no record, and a withdrawn one as withdrawn', () => {
    const open = reviewItemRow(item('ri-open', { review: { headline: 'Open ask' } }), NOW);
    expect(open.querySelector('.board-comment-review-k')?.textContent).toBe('Question');
    expect(open.querySelector('.board-comment-answered')).toBeNull();
    const gone = reviewItemRow(
      item('ri-gone', { review: { shape: 'decision', headline: 'Gone', withdrawnAt: NOW } }),
      NOW,
    );
    expect(gone.querySelector('.board-comment-review-k')?.textContent).toBe('Withdrawn');
    expect(
      gone.querySelector('.board-comment-review-headline')?.classList.contains('is-withdrawn'),
    ).toBe(true);
  });
});

describe('commentRow on an answered declaration', () => {
  it('carries the answered record against the question', () => {
    const li = commentRow(
      {
        threadId: 'th-1',
        comment: {
          id: 'c-1',
          author: 'Scheduler Agent',
          text: 'Which cache?',
          ts: NOW - 2 * HOUR,
          review: {
            shape: 'decision',
            headline: 'Which cache do we keep?',
            answeredAt: NOW - HOUR,
            answeredBy: 'Reviewer',
            answerText: 'Keep disk',
          },
        },
      },
      undefined,
      NOW,
      'Reviewer',
    );
    expect(li.querySelector('.board-comment-review-k')?.classList.contains('is-answered')).toBe(
      true,
    );
    expect(li.querySelector('.board-comment-answered')?.textContent).toContain(
      'Answered by you: “Keep disk”',
    );
    // Control: an unanswered declaration has no record.
    const open = commentRow(
      {
        threadId: 'th-2',
        comment: { author: 'A', text: 'x', ts: NOW, review: { shape: 'review', headline: 'H' } },
      },
      undefined,
      NOW,
    );
    expect(open.querySelector('.board-comment-answered')).toBeNull();
  });
});

describe('the Activity line for a raised item', () => {
  it('names the ask so the trail reads question-then-answer', () => {
    const line = describeEvent(
      {
        event: 'review_item.added',
        ts: NOW,
        taskId: 't-1',
        reviewItemId: 'ri-1',
        shape: 'decision',
        headline: 'Which cache do we keep?',
        actor: { id: 'agent-x', name: 'Scheduler Agent', kind: 'agent' },
      },
      () => 'Cache cleanup',
    );
    expect(line).toBe(
      'Scheduler Agent raised a decision on “Cache cleanup”: “Which cache do we keep?”',
    );
    const q = describeEvent(
      {
        event: 'review_item.added',
        ts: NOW,
        taskId: 't-1',
        shape: 'review',
        headline: 'Why?',
        actor: { name: 'Bot' },
      },
      () => 'Cache cleanup',
    );
    expect(q).toBe('Bot asked a question on “Cache cleanup”: “Why?”');
  });
});

describe('the task panel’s Comments tab', () => {
  let seq = 0;
  function task(overrides: Partial<BoardTask> = {}): BoardTask {
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
  const handlers = (extra: Partial<DetailHandlers> = {}): DetailHandlers => ({
    onClose: vi.fn(),
    onStatusSet: vi.fn(),
    onTitleCommit: vi.fn(),
    onAnswer: vi.fn(),
    onAssign: vi.fn(),
    onComment: vi.fn(async () => true),
    selfName: 'Reviewer',
    ...extra,
  });
  let live: (() => void) | null = null;
  afterEach(() => {
    live?.();
    live = null;
    taskDetailData.value = { task: null, handlers: handlers() };
  });

  it('shows an answered ticket-borne item in the comment stream, and not a held one', () => {
    const host = document.createElement('div');
    host.className = 'board-detail hidden';
    document.body.replaceChildren(host);
    live = mountTaskDetailIsland(host);
    const discussion: TaskDiscussion = {
      loading: false,
      threads: [{ id: 'th-1', comments: [c('Jordan', NOW - 3 * HOUR)] }],
    };
    taskDetailData.value = {
      task: task({
        reviews: [
          ANSWERED,
          item('ri-held', { judge: { at: NOW, verdict: 'held', reason: 'No stakes.' } }),
        ],
      }),
      discussion,
      handlers: handlers(),
    };
    const stream = host.querySelector('.board-comment-stream');
    expect(stream).not.toBeNull();
    const rows = Array.from(stream?.querySelectorAll('li.board-comment') ?? []);
    expect(rows.map((r) => (r as HTMLElement).dataset.reviewItemId ?? 'comment')).toEqual([
      'comment',
      'ri-answered',
    ]);
    expect(stream?.textContent).toContain('Answered by you: “Keep disk”');
    // The held item is on the ticket's held note, not in the history.
    expect(host.querySelector('.board-decide-held')?.getAttribute('data-review-item-id')).toBe(
      'ri-held',
    );
  });

  it('a task with only a ticket-borne item is not "No comments yet"', () => {
    const host = document.createElement('div');
    host.className = 'board-detail hidden';
    document.body.replaceChildren(host);
    live = mountTaskDetailIsland(host);
    taskDetailData.value = {
      task: task({ reviews: [ANSWERED] }),
      discussion: { loading: false, threads: [] },
      handlers: handlers(),
    };
    expect(host.querySelector('.board-discussion-empty')).toBeNull();
    expect(
      host.querySelector('.board-comment-stream li[data-review-item-id="ri-answered"]'),
    ).not.toBeNull();
  });
});
