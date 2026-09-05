/**
 * The review-item CONTRACT, exercised through the three modules written in
 * terms of it.
 *
 * `review-item-types.ts` declares shapes and nothing else, so there is no
 * function here to call directly. What it can be held to is the two claims
 * the split was made for, and both are runtime facts:
 *
 *  - it EMITS NOTHING, which is what lets the quality gate and the defensive
 *    readers reach the contract without importing the verbs that act on it.
 *    They used to import `review-item.ts` for its types, so the module that
 *    imports them imported them back — a cycle that only stayed harmless
 *    because the import happened to be type-only.
 *  - the names `review-item.ts` re-exports are the SAME shapes, so nothing
 *    downstream had to move. Every value below is annotated with a type
 *    imported from the new file and then handed to a function imported from
 *    the old one; if the re-export ever named something else, this file would
 *    not compile.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'vitest';
import type {
  DecisionTaskLike,
  ReviewOption,
  ReviewPayload,
  TaskReviewItem,
} from '../src/review-item-types.ts';
import * as contract from '../src/review-item-types.ts';
import {
  applyReviewRevision,
  checkReviewPayload,
  readReviewPayload,
  readTaskReviewItem,
  reviewAnswered,
  reviewFromDecisionTask,
  reviewItemState,
  withdrawReview,
} from '../src/review-item.ts';

describe('the contract is a runtime-empty leaf', () => {
  it('contributes no exports to the bundle at all', () => {
    // A single runtime export here would put `review-item-check.ts` and
    // `review-item-wire.ts` back in a real import cycle with the verbs.
    expect(Object.keys(contract)).toEqual([]);
  });
});

describe('a payload written against the contract survives the gate and the reader', () => {
  const options: ReviewOption[] = [
    { id: 'o1', label: 'Ship now' },
    { id: 'o2', label: 'Hold for the audit', detail: 'Costs a day.' },
  ];
  const payload: ReviewPayload = {
    shape: 'decision',
    headline: 'Which way for the index refresh?',
    detail: 'Both readers agree; only the cost differs.',
    options,
  };

  it('passes the quality gate the check module applies to it', () => {
    expect(checkReviewPayload(payload).ok).toBe(true);
  });

  it('comes back out of the wire reader with every authored field intact', () => {
    const read = readReviewPayload(payload);
    expect(read).toEqual(payload);
    expect(read?.options?.map((o) => o.id)).toEqual(['o1', 'o2']);
    expect(reviewAnswered(payload)).toBe(false);
  });

  it('revises and withdraws through the verbs that still live next door', () => {
    const revised = applyReviewRevision(
      payload,
      { detail: 'Both readers agree; the audit is the only cost.' },
      { by: 'Index Keeper', at: 2_000 },
    );
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.previous.headline).toBe(payload.headline);
    expect(revised.next.detail).toContain('the only cost');

    const taken = withdrawReview(revised.next, { by: 'Index Keeper', at: 3_000 });
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    expect(taken.next.withdrawnAt).toBe(3_000);
    // A withdrawal is a change of standing, never an edit of the words.
    expect(taken.next.headline).toBe(payload.headline);
  });
});

describe('the wrapper shapes drive the state the queue reads', () => {
  const item: TaskReviewItem = {
    id: 'r-9f2a',
    review: { shape: 'review', headline: 'Cache size', detail: 'A pass reads the index once.' },
    createdAt: 1_000,
    createdBy: 'Index Keeper',
    infoRequests: [{ text: 'Once per what?', by: 'Jordan', ts: 1_500, threadId: 't-1' }],
    judge: { at: 1_100, verdict: 'ok', reason: 'Reads clearly.' },
  };

  it('reads back off the wire and reports the state its own facts imply', () => {
    const read = readTaskReviewItem(item);
    expect(read?.id).toBe('r-9f2a');
    expect(read?.infoRequests?.[0]?.threadId).toBe('t-1');
    expect(reviewItemState(item)).toBe('waiting');
    expect(
      reviewItemState({
        ...item,
        revisions: [{ at: 1_600, by: 'Index Keeper', headline: 'Cache size', threadId: 't-1' }],
      }),
    ).toBe('revised');
  });
});

describe('the legacy decision-task shape is part of the same contract', () => {
  it('migrates into a payload of the same contract, ids and answer intact', () => {
    const task: DecisionTaskLike = {
      title: 'Where should the trial banner live?',
      body: 'Both screens are built either way.',
      options: [{ id: 'd1', label: 'Above the fold' }],
      answer: { optionId: 'd1' },
    };
    const migrated: ReviewPayload = reviewFromDecisionTask(task);
    expect(migrated).toEqual({
      shape: 'decision',
      headline: 'Where should the trial banner live?',
      detail: 'Both screens are built either way.',
      options: [{ id: 'd1', label: 'Above the fold' }],
      answeredWith: 'd1',
    });
    // The migrated payload is an ordinary one: the reader takes it unchanged.
    expect(readReviewPayload(migrated)).toEqual(migrated);
    expect(reviewAnswered(migrated)).toBe(true);
  });
});
