/**
 * The four review-item stores over a FAKE persistence — no `TaskStore`, no
 * data dir, no disk.
 *
 * This is the point of the split. The review verbs used to live in the middle
 * of an 8,000-line class and could reach anything on it; now the whole of
 * what they may touch is the nine-member `ReviewItemPersistence`, and the
 * proof of that is that the plain object below satisfies it — a Map of rows
 * and a number for a clock. If a future change reaches back into the task
 * store for something else, this file stops compiling, which is the guard;
 * the assertions are the second line.
 *
 * The behaviour itself is pinned by the suites that already exercise these
 * verbs through `TaskStore` (review-item-gate, review-item-history,
 * task-review-items, decisions, decision-gate-store). Those are unchanged.
 *
 * All fixtures are synthetic — invented ids and generic personas. The repo is
 * public.
 */
import { describe, expect, it } from 'bun:test';
import type { ReviewPayload } from '@feedback/core';
import type { Task } from '@feedback/core/task-wire';
import { TaskDecisionStore } from '../src/review-items/decisions.ts';
import { LEGACY_REVIEW_ITEM_ID } from '../src/review-items/derive.ts';
import { ReviewJudgementStore } from '../src/review-items/judgements.ts';
import type {
  ReviewItemPersistence,
  ReviewItemStoreEvent,
} from '../src/review-items/persistence.ts';
import { ReviewItemQueries } from '../src/review-items/queries.ts';
import { ReviewItemStore } from '../src/review-items/store.ts';
import type { HubWorkspace } from '../src/tasks.ts';

const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'known' };
const AGENT = { id: 'agent-scheduler', name: 'Scheduler Agent', kind: 'known' };

/** A fixed clock, so every assertion about `ts` is about the injected one. */
const T0 = 1_800_000_000_000;

function payload(over: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    shape: 'decision',
    headline: 'Which cache do we keep?',
    detail: 'Both caches answer the same reads; keeping both doubles the invalidation paths.',
    options: [
      { id: 'o-7f3a', label: 'Keep disk' },
      { id: 'o-2b91', label: 'Keep memory' },
    ],
    ...over,
  } as ReviewPayload;
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't-cache',
    workspaceId: 'w-fake',
    title: 'Collapse the two caches',
    assignee: 'Reviewer',
    goal: 'chores',
    order: 1,
    status: 'todo',
    after: [],
    links: [],
    transitions: [],
    createdAt: T0 - 5_000,
    updatedAt: T0 - 5_000,
    ...over,
  } as Task;
}

/**
 * The whole world the store is allowed to see. Nothing here is a `TaskStore`
 * — the rows are a Map and the clock is a number.
 */
function fake(tasks: Task[] = [task()]) {
  const rows = new Map(tasks.map((t) => [t.id, t]));
  const workspace: HubWorkspace = {
    id: 'w-fake',
    name: 'Fake board',
    goals: [],
    docIds: [],
    createdAt: T0 - 10_000,
  };
  const events: ReviewItemStoreEvent[] = [];
  const saved: string[] = [];
  let clock = T0;
  const renamed: { taskId: string; title: string }[] = [];
  const bodiesEdited: { taskId: string; title?: string }[] = [];
  const persistence: ReviewItemPersistence = {
    getTask: (taskId) => rows.get(taskId),
    listTasksIn: (workspaceId) => (workspaceId === workspace.id ? Array.from(rows.values()) : []),
    listWorkspaceIds: () => [workspace.id],
    getWorkspaceRecord: (workspaceId) => (workspaceId === workspace.id ? workspace : undefined),
    save: (workspaceId) => {
      saved.push(workspaceId);
    },
    emit: (event) => {
      events.push(event);
    },
    now: () => clock,
    noteBodyEdited: (taskId, opts) => {
      const row = rows.get(taskId);
      if (!row) return false;
      if (opts.title !== undefined) row.title = opts.title;
      bodiesEdited.push({ taskId, ...(opts.title !== undefined ? { title: opts.title } : {}) });
      return true;
    },
    renameTask: (taskId, title) => {
      const row = rows.get(taskId);
      if (!row) return { ok: false, error: 'not-found' };
      row.title = title;
      renamed.push({ taskId, title });
      return { ok: true, task: row, changed: true };
    },
  };
  return {
    store: new ReviewItemStore(persistence),
    decisions: new TaskDecisionStore(persistence),
    judgements: new ReviewJudgementStore(persistence),
    queries: new ReviewItemQueries(persistence),
    rows,
    workspace,
    events,
    saved,
    renamed,
    bodiesEdited,
    tick: (to: number) => {
      clock = to;
    },
  };
}

describe('the review-item stores over a fake persistence', () => {
  it('files an item, saves the board, and emits review_item.added on the injected clock', () => {
    const f = fake();
    f.tick(T0 + 1_000);
    const res = f.store.addReviewItem('t-cache', payload(), { actor: AGENT });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');

    expect(res.item.review.headline).toBe('Which cache do we keep?');
    expect(res.item.createdAt).toBe(T0 + 1_000);
    expect(f.rows.get('t-cache')?.reviews?.length).toBe(1);
    expect(f.saved).toEqual(['w-fake']);
    expect(f.events.map((e) => e.type)).toEqual(['review_item.added']);
  });

  it('refuses a payload the shared gate rejects, and writes nothing', () => {
    const f = fake();
    const res = f.store.addReviewItem('t-cache', { shape: 'decision' }, { actor: AGENT });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('bad-review');
    expect(f.rows.get('t-cache')?.reviews).toBeUndefined();
    expect(f.saved).toEqual([]);
  });

  it('counts open items, and counts a held one apart', () => {
    const f = fake();
    const added = f.store.addReviewItem('t-cache', payload(), { actor: AGENT });
    if (!added.ok) throw new Error('unreachable');
    expect(f.queries.reviewState('t-cache')).toEqual({ open: 1, unreadable: 0, held: 0 });

    const judged = f.judgements.recordReviewJudgement(
      't-cache',
      added.item.id,
      { at: T0 + 5, verdict: 'held', reason: 'no options named' },
      { actor: AGENT },
    );
    expect(judged.ok).toBe(true);
    expect(f.queries.reviewState('t-cache')).toEqual({ open: 0, unreadable: 0, held: 1 });
  });

  /**
   * `reviewState.open` is what the stall clock reads to decide a row is
   * legitimately waiting on a person, so it has to agree with the Home
   * queue's own filter item for item. Where the two disagree the row parks on
   * an ask nobody can see: off the queue, so never answerable, so never
   * cleared, and the watchdog stays off that row for good.
   *
   * Each case below is a state the queue drops (review-queue.ts) that the
   * count used to keep. The first `it` is the positive control and must stay
   * first: without it, three assertions that a number is zero would all pass
   * against a counter that had simply stopped counting.
   */
  it('counts an ordinary open ask — the control the three exclusions below need', () => {
    const f = fake();
    const added = f.store.addReviewItem('t-cache', payload(), { actor: AGENT });
    if (!added.ok) throw new Error('unreachable');
    expect(f.queries.reviewState('t-cache')).toEqual({ open: 1, unreadable: 0, held: 0 });
  });

  it('stops counting an ask its filer WITHDREW — off the queue, so not parking the row', () => {
    const f = fake();
    const added = f.store.addReviewItem('t-cache', payload(), { actor: AGENT });
    if (!added.ok) throw new Error('unreachable');
    expect(f.queries.reviewState('t-cache')?.open).toBe(1);

    const gone = f.store.withdrawReviewItem('t-cache', added.item.id, {
      actor: AGENT,
      reason: 'answered itself once the cache was measured',
    });
    expect(gone.ok).toBe(true);
    expect(f.queries.reviewState('t-cache')).toEqual({ open: 0, unreadable: 0, held: 0 });
  });

  it("stops counting an ask the reader asked BACK on — that is the owner's turn", () => {
    const f = fake();
    const added = f.store.addReviewItem('t-cache', payload(), { actor: AGENT });
    if (!added.ok) throw new Error('unreachable');
    expect(f.queries.reviewState('t-cache')?.open).toBe(1);

    // `threadId` is load-bearing, not decoration: `reviewItemState` reads
    // `waiting` off the latest THREADED question, so a doc-style ask back is
    // the shape the queue drops. A typed question without one leaves the item
    // `open` on both surfaces, which is the next case.
    const asked = f.store.requestMoreInfoOnReview(
      't-cache',
      added.item.id,
      'Which reads actually hit both caches?',
      { actor: PERSON, threadId: 'th-cache-q1' },
    );
    expect(asked.ok).toBe(true);
    expect(f.queries.reviewState('t-cache')).toEqual({ open: 0, unreadable: 0, held: 0 });
  });

  it('keeps counting a TYPED question — the queue keeps that one too, so they agree', () => {
    const f = fake();
    const added = f.store.addReviewItem('t-cache', payload(), { actor: AGENT });
    if (!added.ok) throw new Error('unreachable');

    const asked = f.store.requestMoreInfoOnReview(
      't-cache',
      added.item.id,
      'Which reads actually hit both caches?',
      { actor: PERSON },
    );
    expect(asked.ok).toBe(true);
    expect(f.queries.reviewState('t-cache')?.open).toBe(1);
  });

  it('stops counting an ANSWERED ask', () => {
    const f = fake();
    const added = f.store.addReviewItem('t-cache', payload(), { actor: AGENT });
    if (!added.ok) throw new Error('unreachable');
    expect(f.queries.reviewState('t-cache')?.open).toBe(1);

    const answered = f.store.answerTaskReview('t-cache', added.item.id, 'Keep disk.', {
      actor: PERSON,
      answeredWith: 'o-7f3a',
    });
    expect(answered.ok).toBe(true);
    expect(f.queries.reviewState('t-cache')).toEqual({ open: 0, unreadable: 0, held: 0 });
  });

  it('reports a held item to the stall monitor with its filer', () => {
    const f = fake();
    const added = f.store.addReviewItem('t-cache', payload(), { actor: AGENT });
    if (!added.ok) throw new Error('unreachable');
    f.judgements.recordReviewJudgement(
      't-cache',
      added.item.id,
      { at: T0 + 5, verdict: 'held', reason: 'no options named' },
      { actor: AGENT },
    );
    const held = f.queries.heldReviewItems('w-fake');
    expect(held.length).toBe(1);
    expect(held[0]?.taskId).toBe('t-cache');
    expect(held[0]?.reason).toBe('no options named');
    expect(held[0]?.filerAgentId).toBe('agent-scheduler');
    expect(f.queries.heldReviewItems('w-missing')).toEqual([]);
  });

  it('answers one item, keeps the superseded answer, and emits decision.answered', () => {
    const f = fake();
    const added = f.store.addReviewItem('t-cache', payload(), { actor: AGENT });
    if (!added.ok) throw new Error('unreachable');
    f.tick(T0 + 2_000);
    const first = f.store.answerTaskReview('t-cache', added.item.id, 'Keep disk', {
      actor: PERSON,
      answeredWith: 'o-7f3a',
    });
    expect(first.ok).toBe(true);
    f.tick(T0 + 3_000);
    const second = f.store.answerTaskReview('t-cache', added.item.id, 'Keep memory instead', {
      actor: PERSON,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.item.answer?.text).toBe('Keep memory instead');
    expect(second.item.answer?.ts).toBe(T0 + 3_000);
    expect(second.item.priorAnswers?.[0]?.text).toBe('Keep disk');
    expect(f.events.map((e) => e.type)).toEqual([
      'review_item.added',
      'decision.answered',
      'decision.answered',
    ]);
  });

  it('refuses an answeredWith that names no option on the row', () => {
    const f = fake();
    const added = f.store.addReviewItem('t-cache', payload(), { actor: AGENT });
    if (!added.ok) throw new Error('unreachable');
    const res = f.store.answerTaskReview('t-cache', added.item.id, 'Neither', {
      actor: PERSON,
      answeredWith: 'o-not-here',
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('unknown-option');
  });

  it('keeps the superseded words on revise and re-queues the item', () => {
    const f = fake();
    const added = f.store.addReviewItem('t-cache', payload(), { actor: AGENT });
    if (!added.ok) throw new Error('unreachable');
    const res = f.store.reviseReviewItem(
      't-cache',
      added.item.id,
      { headline: 'Which cache survives the merge?' },
      { actor: AGENT },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.item.review.headline).toBe('Which cache survives the merge?');
    expect(res.item.revisions?.[0]?.headline).toBe('Which cache do we keep?');
    expect(f.events.at(-1)?.type).toBe('review_item.revised');
  });

  it('withdraws an item and puts it back', () => {
    const f = fake();
    const added = f.store.addReviewItem('t-cache', payload(), { actor: AGENT });
    if (!added.ok) throw new Error('unreachable');
    const gone = f.store.withdrawReviewItem('t-cache', added.item.id, {
      actor: AGENT,
      reason: 'asked twice',
    });
    expect(gone.ok).toBe(true);
    expect(f.events.at(-1)?.type).toBe('review_item.withdrawn');

    // Withdrawing twice is refused rather than silently succeeding — two
    // readers racing the same retraction must not both be told they took it
    // back.
    const again = f.store.withdrawReviewItem('t-cache', added.item.id, { actor: AGENT });
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('unreachable');
    expect(again.error).toBe('already-withdrawn');

    const back = f.store.withdrawReviewItem('t-cache', added.item.id, { actor: AGENT, undo: true });
    expect(back.ok).toBe(true);
    const backAgain = f.store.withdrawReviewItem('t-cache', added.item.id, {
      actor: AGENT,
      undo: true,
    });
    expect(backAgain.ok).toBe(false);
    if (backAgain.ok) throw new Error('unreachable');
    expect(backAgain.error).toBe('not-withdrawn');
  });

  it('finds which ticket holds an item, and says nothing for an unknown id', () => {
    const f = fake();
    const added = f.store.addReviewItem('t-cache', payload(), { actor: AGENT });
    if (!added.ok) throw new Error('unreachable');
    expect(f.queries.findReviewItem(added.item.id)).toEqual({
      taskId: 't-cache',
      workspaceId: 'w-fake',
    });
    expect(f.queries.findReviewItem('r-nosuchitem')).toBeUndefined();
  });

  it('reads the board criteria as the default until the board sets its own', () => {
    const f = fake();
    const first = f.queries.reviewItemCriteria('w-fake');
    expect(first?.isDefault).toBe(true);
    expect(first?.value.length).toBeGreaterThan(0);

    const set = f.queries.setReviewItemCriteria('w-fake', '  one option minimum  ', {
      actor: PERSON,
    });
    expect(set.ok).toBe(true);
    if (!set.ok) throw new Error('unreachable');
    expect(set.criteria).toEqual({ value: 'one option minimum', isDefault: false });
    expect(f.workspace.reviewItemCriteria).toBe('one option minimum');

    const cleared = f.queries.setReviewItemCriteria('w-fake', '', { actor: PERSON });
    expect(cleared.ok).toBe(true);
    expect(f.queries.reviewItemCriteria('w-fake')?.isDefault).toBe(true);
    expect(f.queries.reviewItemCriteria('w-missing')).toBeUndefined();
  });

  it("derives the ticket's own decision as r-legacy and answers it through the task fields", () => {
    const decision = task({
      id: 't-decide',
      needs: 'decision',
      body: 'Pick a retention window before the next deploy.',
      options: [{ id: 'o-30', label: '30 days' }],
      createdBy: 'Scheduler Agent',
    });
    const f = fake([decision]);
    const items = f.queries.listReviewItems('t-decide');
    expect(items.map((i: { id: string }) => i.id)).toEqual([LEGACY_REVIEW_ITEM_ID]);
    expect(items[0]?.createdBy).toBe('Scheduler Agent');

    f.tick(T0 + 9_000);
    const res = f.store.answerTaskReview('t-decide', LEGACY_REVIEW_ITEM_ID, '30 days', {
      actor: PERSON,
      answeredWith: 'o-30',
    });
    expect(res.ok).toBe(true);
    expect(f.rows.get('t-decide')?.answer).toEqual({
      text: '30 days',
      by: 'Reviewer',
      ts: T0 + 9_000,
      optionId: 'o-30',
    });
    expect(f.queries.reviewState('t-decide')).toEqual({ open: 0, unreadable: 0, held: 0 });
  });

  it("rewrites a decision's words through the persistence doors, never by assignment", () => {
    const decision = task({
      id: 't-decide',
      needs: 'decision',
      body: 'How long do we keep transcripts? Legal has not named a number yet.',
      options: [{ id: 'o-30', label: '30 days' }],
    });
    const f = fake([decision]);
    const res = f.decisions.reviseTaskDecision(
      't-decide',
      {
        headline: 'How long do we keep transcripts?',
        detail: 'How long do we keep transcripts? Legal wants one number, not a range.',
      },
      { actor: AGENT, reason: 'the ask had no question in it' },
    );
    expect(res.ok).toBe(true);
    expect(f.bodiesEdited).toEqual([
      { taskId: 't-decide', title: 'How long do we keep transcripts?' },
    ]);
    expect(f.rows.get('t-decide')?.decisionRevisions?.[0]?.headline).toBe(
      'Collapse the two caches',
    );
  });

  it('refuses every verb for a ticket the persistence does not hold', () => {
    const f = fake();
    expect(f.store.addReviewItem('t-nope', payload(), { actor: AGENT }).ok).toBe(false);
    expect(f.queries.listReviewItems('t-nope')).toEqual([]);
    expect(f.queries.reviewState('t-nope')).toBeUndefined();
    expect(f.store.answerTaskReview('t-nope', 'r-x', 'x', { actor: PERSON }).ok).toBe(false);
    expect(f.saved).toEqual([]);
  });
});
