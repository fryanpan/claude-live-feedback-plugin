/**
 * Where a review item stands is derived from the item's own facts — and the
 * facts have to decide a TIE.
 *
 * `reviewItemState` first compared clocks alone: a question newer than the
 * last revision meant "waiting". A revision and the next question landing in
 * the same millisecond — which the route-level suite produced four runs in
 * five — tied, and a tie read as "revised": the item went back on the
 * reader's queue while their new question sat unanswered. The item carries a
 * better fact: every revision is stamped with the thread of the question it
 * was made against, so a revision that does not name the latest question's
 * thread was made before it, whatever the clocks say.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'vitest';
import { type TaskReviewItem, reviewItemState } from '../src/review-item.ts';

const base = (): TaskReviewItem => ({
  id: 'r-abc1',
  review: {
    shape: 'review',
    headline: 'Cache size',
    detail: 'A full pass reads the index once.',
  },
  createdAt: 1_000,
  createdBy: 'Index Keeper',
});
const question = (ts: number, threadId: string) => ({
  text: 'Twice per what?',
  by: 'Jordan',
  ts,
  threadId,
  range: { text: 'once' },
});
const revision = (at: number, threadId?: string) => ({
  at,
  by: 'Index Keeper',
  headline: 'Cache size',
  detail: 'old words',
  ...(threadId ? { threadId } : {}),
});

describe('reviewItemState', () => {
  it('is open with nothing asked and nothing revised', () => {
    expect(reviewItemState(base())).toBe('open');
  });

  it('is waiting once a question is asked doc-style and nobody has revised', () => {
    expect(reviewItemState({ ...base(), infoRequests: [question(2_000, 'th-1')] })).toBe('waiting');
  });

  it('is revised once the owner revises against that question', () => {
    expect(
      reviewItemState({
        ...base(),
        infoRequests: [question(2_000, 'th-1')],
        revisions: [revision(3_000, 'th-1')],
      }),
    ).toBe('revised');
  });

  it('is waiting again when a second question arrives after the revision', () => {
    expect(
      reviewItemState({
        ...base(),
        infoRequests: [question(2_000, 'th-1'), question(4_000, 'th-2')],
        revisions: [revision(3_000, 'th-1')],
      }),
    ).toBe('waiting');
  });

  it('TIE: a second question in the same millisecond as the revision is still waiting', () => {
    // The revision names th-1, so it was made before th-2 existed — the
    // clocks tying says nothing.
    expect(
      reviewItemState({
        ...base(),
        infoRequests: [question(2_000, 'th-1'), question(3_000, 'th-2')],
        revisions: [revision(3_000, 'th-1')],
      }),
    ).toBe('waiting');
  });

  it('TIE the other way: a revision against the question in the same millisecond answers it', () => {
    // POSITIVE CONTROL for the case above: the tie-breaker is the thread,
    // not "ties are waiting" — a revision stamped with the question's own
    // thread was made after it, however close the clocks.
    expect(
      reviewItemState({
        ...base(),
        infoRequests: [question(3_000, 'th-1')],
        revisions: [revision(3_000, 'th-1')],
      }),
    ).toBe('revised');
  });

  it('a spontaneous revision (no question) is revised, and a later question makes it waiting', () => {
    const revisedOnly = { ...base(), revisions: [revision(2_000)] };
    expect(reviewItemState(revisedOnly)).toBe('revised');
    expect(reviewItemState({ ...revisedOnly, infoRequests: [question(2_000, 'th-1')] })).toBe(
      'waiting',
    );
  });

  it('is answered whatever else happened', () => {
    expect(
      reviewItemState({
        ...base(),
        infoRequests: [question(4_000, 'th-2')],
        revisions: [revision(3_000, 'th-1')],
        answer: { text: 'Keep it', by: 'Jordan', ts: 5_000 },
      }),
    ).toBe('answered');
  });
});
