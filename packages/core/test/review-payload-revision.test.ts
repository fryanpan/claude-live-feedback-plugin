/**
 * `applyReviewRevision` and friends — the pure half of correcting a review
 * item, shared by the ticket path and the doc-thread one.
 *
 * It is tested here rather than only through the two routes because it is the
 * single place that decides what a revision IS: which patches are legal, where
 * the changed span fell, and what the superseded reading was. Two surfaces
 * read it, so a change of mind here has to be a deliberate one.
 */
import { describe, expect, it } from 'vitest';
import {
  applyReviewRevision,
  readReviewPayload,
  reviewPayloadRevision,
  withRevision,
} from '../src/review-item.ts';
import type { ReviewPayload } from '../src/review-item.ts';

const BASE: ReviewPayload = {
  shape: 'review',
  headline: 'Does the phone layout need the call to action moved?',
  detail: 'At 430px the call to action falls below the fold. Worth moving it above the gallery?',
};

const AT = 1_700_000_000_000;
const OPTS = { by: 'Cartographer', at: AT };

describe('applyReviewRevision', () => {
  it('patches only the fields given and records the previous reading', () => {
    const res = applyReviewRevision(
      BASE,
      { detail: 'It is above the fold; the gallery scrolls sideways instead.' },
      OPTS,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.next.headline).toBe(BASE.headline);
    expect(res.next.detail).toBe('It is above the fold; the gallery scrolls sideways instead.');
    expect(res.previous.headline).toBe(BASE.headline);
    expect(res.previous.detail).toBe(BASE.detail);
    expect(res.previous.by).toBe('Cartographer');
    expect(res.previous.at).toBe(AT);
  });

  it('derives the changed span, and honours an explicit one', () => {
    const derived = applyReviewRevision(BASE, { detail: `${BASE.detail} One more line.` }, OPTS);
    expect(derived.ok).toBe(true);
    if (derived.ok) expect(derived.previous.revisedRange).toBeTruthy();

    const explicit = applyReviewRevision(
      BASE,
      { detail: 'abcdefghij' },
      { ...OPTS, revisedRange: { start: 2, end: 5 } },
    );
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.previous.revisedRange).toEqual({ start: 2, end: 5 });
  });

  it('refuses a range past the new detail, an empty patch, and an answered item', () => {
    const past = applyReviewRevision(
      BASE,
      { detail: 'short' },
      { ...OPTS, revisedRange: { start: 0, end: 400 } },
    );
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.error).toBe('bad-range');

    const nothing = applyReviewRevision(BASE, {}, OPTS);
    expect(nothing.ok).toBe(false);
    if (!nothing.ok) expect(nothing.error).toBe('empty-patch');

    const answered = applyReviewRevision(
      { ...BASE, answeredAt: AT, answerText: 'Leave it.' },
      { detail: 'new words' },
      OPTS,
    );
    expect(answered.ok).toBe(false);
    if (!answered.ok) expect(answered.error).toBe('answered');
  });
});

describe('withRevision and reviewPayloadRevision', () => {
  it('appends oldest-first and reads back the newest', () => {
    const first = applyReviewRevision(BASE, { detail: 'Second reading of the problem.' }, OPTS);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const once = withRevision(first.next, first.previous);
    expect(once.revisions).toHaveLength(1);

    const second = applyReviewRevision(
      once,
      { detail: 'Third reading of the problem.' },
      { ...OPTS, at: AT + 5 },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const twice = withRevision(second.next, second.previous);
    expect(twice.revisions).toHaveLength(2);
    // Oldest first — nothing a person may have read is displaced.
    expect(twice.revisions?.[0]?.detail).toBe(BASE.detail);
    expect(twice.revisions?.[1]?.detail).toBe('Second reading of the problem.');
    expect(reviewPayloadRevision(twice)?.at).toBe(AT + 5);
  });

  it('says nothing about an unrevised item, or an answered one', () => {
    expect(reviewPayloadRevision(BASE)).toBeUndefined();
    const revised = applyReviewRevision(BASE, { detail: 'Corrected.' }, OPTS);
    if (!revised.ok) throw new Error('setup failed');
    const payload = withRevision(revised.next, revised.previous);
    // Answered closes it: what the reader needs to see then is the answer,
    // not that the words once changed.
    expect(reviewPayloadRevision({ ...payload, answeredAt: AT })).toBeUndefined();
  });

  it('survives a round trip through readReviewPayload', () => {
    const revised = applyReviewRevision(BASE, { detail: 'Corrected.' }, OPTS);
    if (!revised.ok) throw new Error('setup failed');
    const stored = withRevision(revised.next, revised.previous);
    // The payload is persisted as a plain value in a ydoc and read back
    // defensively; history that does not survive the reader is history the
    // person never sees.
    const back = readReviewPayload(JSON.parse(JSON.stringify(stored)));
    expect(back?.revisions).toHaveLength(1);
    expect(back?.revisions?.[0]?.detail).toBe(BASE.detail);
    expect(reviewPayloadRevision(back as ReviewPayload)?.by).toBe('Cartographer');
  });
});
