import { describe, expect, it } from 'vitest';
import {
  REVIEW_LIMITS,
  type ReviewPayload,
  checkReviewPayload,
  readReviewPayload,
  reviewAnswered,
  reviewGapAdvice,
  reviewPayloadMessage,
} from './review-item.ts';

/** All fixtures are synthetic — invented names, ids and copy throughout. */

function decision(over: Partial<ReviewPayload> = {}): unknown {
  return {
    shape: 'decision',
    headline: 'Should a resolved thread stay visible inline?',
    why: 'Blocks the inline-comments branch; two callers already disagree.',
    lookFor: 'Whether hiding it loses the audit trail.',
    detail:
      'Threads resolve often and the list gets long, but a hidden reply is a reply nobody sees.',
    options: [
      { id: 'hide', label: 'Hide them', detail: 'Shortest list. A late reply is invisible.' },
      { id: 'dim', label: 'Keep dimmed', detail: 'Longer list, nothing disappears.' },
    ],
    ...over,
  };
}

function review(over: Partial<ReviewPayload> = {}): unknown {
  return {
    shape: 'review',
    headline: 'Read the new onboarding copy',
    why: 'Ships with the next release; nobody outside the team has read it.',
    lookFor: 'Whether the second screen explains the trial.',
    detail: 'Three screens of copy. The second one is the one I am least sure about.',
    ...over,
  };
}

describe('checkReviewPayload — the happy path is pinned first', () => {
  // A positive control for every case below. Without it, a checker that
  // refused EVERYTHING would satisfy each individual refusal assertion.
  it('accepts a well-formed decision with no gaps', () => {
    const c = checkReviewPayload(decision());
    expect(c.errors).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.gaps).toEqual([]);
  });

  it('accepts a well-formed review with no gaps', () => {
    const c = checkReviewPayload(review());
    expect(c.errors).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.gaps).toEqual([]);
  });
});

describe('checkReviewPayload — what refuses', () => {
  it('refuses a missing headline', () => {
    const c = checkReviewPayload(decision({ headline: undefined }));
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain('review.headline is required');
  });

  it('refuses a blank headline, not only an absent one', () => {
    expect(checkReviewPayload(decision({ headline: '   ' })).ok).toBe(false);
  });

  it('refuses an over-long headline rather than truncating it', () => {
    const long = 'x'.repeat(REVIEW_LIMITS.headline + 1);
    const c = checkReviewPayload(decision({ headline: long }));
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain(`the limit is ${REVIEW_LIMITS.headline}`);
  });

  it('accepts a headline exactly at the limit — the boundary is inclusive', () => {
    expect(checkReviewPayload(decision({ headline: 'x'.repeat(REVIEW_LIMITS.headline) })).ok).toBe(
      true,
    );
  });

  it('refuses a headline containing a line break', () => {
    const c = checkReviewPayload(decision({ headline: 'Two\nlines' }));
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain('single line');
  });

  it('refuses a missing why', () => {
    const c = checkReviewPayload(decision({ why: undefined }));
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain('review.why is required');
  });

  it('refuses a decision with fewer than two options', () => {
    const c = checkReviewPayload(decision({ options: [{ id: 'a', label: 'Only one' }] }));
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain('at least 2 options');
  });

  it('refuses options on a review — that shape is answered in the reader’s words', () => {
    const c = checkReviewPayload(review({ options: [{ id: 'a', label: 'Yes' }] }));
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain("belong to a 'decision'");
  });

  it('refuses an option label longer than three words', () => {
    const c = checkReviewPayload(
      decision({
        options: [
          { id: 'a', label: 'Hide the resolved threads entirely' },
          { id: 'b', label: 'Keep them' },
        ],
      }),
    );
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain('is 5 words');
  });

  it('refuses duplicate option ids', () => {
    const c = checkReviewPayload(
      decision({
        options: [
          { id: 'same', label: 'One' },
          { id: 'same', label: 'Two' },
        ],
      }),
    );
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain('used twice');
  });

  // The two word budgets are Bryan's own numbers and they DIFFER by shape, so
  // a fixture that passed both would not tell them apart. This pair asserts
  // the same body is accepted for one shape and refused for the other.
  it('applies the 50-word body budget to a decision and the 150-word one to a review', () => {
    const body = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    expect(checkReviewPayload(decision({ detail: body })).ok).toBe(false);
    expect(checkReviewPayload(review({ detail: body })).ok).toBe(true);
  });

  it('refuses a body over the review budget too', () => {
    const body = Array.from(
      { length: REVIEW_LIMITS.detailWords.review + 1 },
      (_, i) => `w${i}`,
    ).join(' ');
    expect(checkReviewPayload(review({ detail: body })).ok).toBe(false);
  });

  it('refuses an unknown shape', () => {
    expect(checkReviewPayload(decision({ shape: 'links' as never })).ok).toBe(false);
  });

  it('refuses a non-object', () => {
    for (const v of [null, undefined, 'a string', 42, ['array']]) {
      expect(checkReviewPayload(v).ok).toBe(false);
    }
  });
});

describe('checkReviewPayload — what only advises', () => {
  it('accepts a decision with no lookFor and reports it as a gap', () => {
    const c = checkReviewPayload(decision({ lookFor: undefined }));
    expect(c.ok).toBe(true);
    expect(c.gaps).toContain('lookFor');
  });

  it('accepts a review with no detail and reports it as a gap', () => {
    const c = checkReviewPayload(review({ detail: undefined }));
    expect(c.ok).toBe(true);
    expect(c.gaps).toContain('detail');
  });
});

describe('reviewPayloadMessage', () => {
  it('quotes every refusal so a retrying model can act on the text alone', () => {
    const c = checkReviewPayload(decision({ headline: undefined, why: undefined }));
    const msg = reviewPayloadMessage(c);
    for (const e of c.errors) expect(msg).toContain(e);
    expect(c.errors.length).toBeGreaterThan(1);
  });
});

describe('reviewGapAdvice — the advice half, which nothing used to read', () => {
  it('says nothing at all about a complete payload', () => {
    // The positive control for every assertion below: the same helper DOES
    // speak when there is something to say, so an empty answer here is a
    // judgement about this payload rather than a helper that never fires.
    expect(reviewGapAdvice(checkReviewPayload(decision()).gaps)).toBeUndefined();
    expect(reviewGapAdvice(['detail'])).toBeDefined();
  });

  // Both directions, because either alone passes against a helper that names
  // one field unconditionally — mutation-tested: making the lookFor branch
  // unconditional survives the first of these and is killed by the second.
  it('names the missing field, and only the missing one', () => {
    const advice = reviewGapAdvice(checkReviewPayload(decision({ lookFor: undefined })).gaps);
    expect(advice).toContain('review.lookFor');
    expect(advice).not.toContain('review.detail');
  });

  it('names only detail when only detail is missing', () => {
    const advice = reviewGapAdvice(checkReviewPayload(review({ detail: undefined })).gaps);
    expect(advice).toContain('review.detail');
    expect(advice).not.toContain('review.lookFor');
  });

  it('names both when both are absent', () => {
    const gaps = checkReviewPayload(decision({ lookFor: undefined, detail: undefined })).gaps;
    const advice = reviewGapAdvice(gaps) ?? '';
    expect(advice).toContain('review.lookFor');
    expect(advice).toContain('review.detail');
  });

  it('reads as filed-but-thin, never as a refusal', () => {
    // The distinction the whole two-tier design rests on. If this text reads
    // like reviewPayloadMessage, an author retries a write that already
    // succeeded and files the item twice.
    const advice = reviewGapAdvice(['detail']) ?? '';
    expect(advice).toContain('Filed.');
    expect(advice).not.toContain('cannot be filed');
  });
});

describe('readReviewPayload — loose on the way out, so nothing already stored vanishes', () => {
  it('round-trips a full payload', () => {
    const p = decision() as ReviewPayload;
    expect(readReviewPayload(p)).toEqual(p);
  });

  it('reads a payload whose fields exceed today’s limits', () => {
    // The gate guards the door; the reader must not re-litigate it, or
    // tightening a limit would make already-filed items disappear from the
    // queue rather than merely stop new ones being written.
    const over = decision({ headline: 'x'.repeat(REVIEW_LIMITS.headline + 50) });
    expect(checkReviewPayload(over).ok).toBe(false);
    expect(readReviewPayload(over)?.headline).toHaveLength(REVIEW_LIMITS.headline + 50);
  });

  it('returns undefined for anything that is not a review payload', () => {
    for (const v of [null, undefined, 'x', 7, [], {}, { shape: 'decision' }]) {
      expect(readReviewPayload(v)).toBeUndefined();
    }
  });

  it('drops malformed options instead of throwing', () => {
    const p = readReviewPayload(
      decision({ options: [{ id: 'a', label: 'Keep' }, 'not an object', { id: 'b' }] as never }),
    );
    expect(p?.options).toEqual([{ id: 'a', label: 'Keep' }]);
  });

  it('drops the options key entirely when none survive', () => {
    expect(readReviewPayload(decision({ options: ['junk'] as never }))?.options).toBeUndefined();
  });

  it('carries answeredWith through', () => {
    expect(readReviewPayload(decision({ answeredWith: 'dim' }))?.answeredWith).toBe('dim');
  });

  it('carries answeredAt through, and refuses a stamp that is not a number', () => {
    expect(readReviewPayload(decision({ answeredAt: 1_700_000_000_000 }))?.answeredAt).toBe(
      1_700_000_000_000,
    );
    // A peer can sync anything into this map. A stamp that arrived as a string
    // or as NaN must not read as an answer — that would silently retire a
    // question — so it is dropped and the item stays on the queue.
    for (const junk of ['1700000000000', Number.NaN, null, {}]) {
      expect(readReviewPayload(decision({ answeredAt: junk as never }))?.answeredAt).toBeUndefined();
    }
  });
});

/**
 * One predicate for "has a person answered this", because the queue and the
 * card must not each decide it — and because two stamps mean the same thing:
 * `answeredAt` on every answer since it existed, `answeredWith` alone on an
 * option tapped before it did.
 */
describe('reviewAnswered', () => {
  const payload = (over: Partial<ReviewPayload> = {}): ReviewPayload =>
    readReviewPayload(decision(over)) as ReviewPayload;

  it('is true for a typed answer, an option tap, and a legacy option tap', () => {
    expect(reviewAnswered(payload({ answeredAt: 1 }))).toBe(true);
    expect(reviewAnswered(payload({ answeredAt: 1, answeredWith: 'dim' }))).toBe(true);
    expect(reviewAnswered(payload({ answeredWith: 'dim' }))).toBe(true);
  });

  it('is false for an item nobody has answered', () => {
    expect(reviewAnswered(payload())).toBe(false);
  });
});
