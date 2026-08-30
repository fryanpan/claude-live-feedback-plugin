/**
 * Withdrawing a review item — the asker's own exit from its own ask.
 *
 * Tested here, at the pure layer, because "withdrawn" is a fact every surface
 * reads: the queue decides whether to carry a row from it, the doc panel
 * decides whether to offer an Answer box, and `pendingDeclaration` decides
 * which ask a thread is even about. One rule, one place to change it.
 *
 * The fall-through case is the reason the verb exists at all. Two asks on one
 * doc thread collapse to the newest everywhere except the doc, so an agent
 * that corrected itself by filing a second one had no way to retire the
 * first: answering it invents a reply the reader never gave, and resolving
 * the thread takes the live ask down with the stale one.
 */
import { describe, expect, it } from 'vitest';
import {
  applyReviewRevision,
  pendingDeclaration,
  readReviewPayload,
  reinstateReview,
  reviewWithdrawn,
  withdrawReview,
} from '../src/review-item.js';
import type { ReviewPayload } from '../src/review-item.js';

const ask = (headline: string): ReviewPayload => ({
  shape: 'review',
  headline,
  detail: 'Some words of context, long enough to read like a real ask rather than a stub.',
});

describe('withdrawReview', () => {
  it('retires the item without touching a word of it', () => {
    const before = ask('Move the CTA above the fold?');
    const out = withdrawReview(before, { by: 'Cartographer', at: 1000, reason: 'superseded' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(reviewWithdrawn(out.next)).toBe(true);
    expect(out.next.withdrawnBy).toBe('Cartographer');
    expect(out.next.withdrawnReason).toBe('superseded');
    // The authored words are the part a reader may already have read.
    expect(out.next.headline).toBe(before.headline);
    expect(out.next.detail).toBe(before.detail);
    // and the original is untouched
    expect(reviewWithdrawn(before)).toBe(false);
  });

  it('refuses an answered item, so an answer cannot be retracted by its asker', () => {
    const answered: ReviewPayload = { ...ask('Ship it?'), answeredAt: 900, answeredBy: 'Bryan' };
    const out = withdrawReview(answered, { by: 'Cartographer', at: 1000 });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('answered');
  });

  it('refuses a repeat, so the original withdrawal time survives', () => {
    const first = withdrawReview(ask('Move the CTA?'), { by: 'Cartographer', at: 1000 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = withdrawReview(first.next, { by: 'Cartographer', at: 2000 });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error).toBe('already-withdrawn');
    expect(first.next.withdrawnAt).toBe(1000);
  });

  it('drops a blank reason rather than storing an empty line', () => {
    const out = withdrawReview(ask('Move the CTA?'), { by: 'C', at: 1, reason: '   ' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect('withdrawnReason' in out.next).toBe(false);
  });
});

describe('reinstateReview', () => {
  it('puts it back, clearing every stamp', () => {
    const gone = withdrawReview(ask('Move the CTA?'), { by: 'C', at: 1, reason: 'oops' });
    expect(gone.ok).toBe(true);
    if (!gone.ok) return;
    const back = reinstateReview(gone.next, { by: 'C', at: 2 });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(reviewWithdrawn(back.next)).toBe(false);
    expect('withdrawnBy' in back.next).toBe(false);
    expect('withdrawnReason' in back.next).toBe(false);
    expect(back.next.headline).toBe('Move the CTA?');
  });

  it('refuses an item that was never withdrawn', () => {
    const out = reinstateReview(ask('Move the CTA?'));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('not-withdrawn');
  });
});

describe('applyReviewRevision on a withdrawn item', () => {
  it('refuses, rather than correcting words nobody is being asked about', () => {
    const gone = withdrawReview(ask('Move the CTA?'), { by: 'C', at: 1 });
    expect(gone.ok).toBe(true);
    if (!gone.ok) return;
    const out = applyReviewRevision(
      gone.next,
      { headline: 'Move the CTA below?' },
      { by: 'C', at: 2 },
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('withdrawn');
    expect(out.message).toMatch(/reinstate/);
  });
});

describe('pendingDeclaration', () => {
  const thread = (comments: Array<{ ts: number; review?: ReviewPayload }>) => ({
    status: 'open',
    comments,
  });

  it('steps over a withdrawn ask and falls through to the live one underneath', () => {
    const stale = ask('STALE: move the CTA above the fold?');
    const gone = withdrawReview(stale, { by: 'C', at: 300, reason: 'superseded' });
    expect(gone.ok).toBe(true);
    if (!gone.ok) return;
    const live = ask('LIVE: is the gallery scrolling sideways?');
    // The stale one is NEWER, which before this verb meant it decided the
    // thread and buried the live one.
    const t = thread([
      { ts: 100, review: live },
      { ts: 200, review: gone.next },
    ]);
    expect(pendingDeclaration(t)?.review?.headline).toBe(
      'LIVE: is the gallery scrolling sideways?',
    );
  });

  it('withdrawing the older one leaves the newer untouched', () => {
    const older = withdrawReview(ask('OLDER'), { by: 'C', at: 300 });
    expect(older.ok).toBe(true);
    if (!older.ok) return;
    const t = thread([
      { ts: 100, review: older.next },
      { ts: 200, review: ask('NEWER') },
    ]);
    expect(pendingDeclaration(t)?.review?.headline).toBe('NEWER');
  });

  it('a thread whose only ask is withdrawn has nothing pending', () => {
    const gone = withdrawReview(ask('Only ask'), { by: 'C', at: 300 });
    expect(gone.ok).toBe(true);
    if (!gone.ok) return;
    expect(pendingDeclaration(thread([{ ts: 100, review: gone.next }]))).toBeNull();
  });

  it('still stops at an ANSWERED newest ask — withdrawal is the only fall-through', () => {
    const answered: ReviewPayload = { ...ask('NEWER'), answeredAt: 400 };
    const t = thread([
      { ts: 100, review: ask('OLDER') },
      { ts: 200, review: answered },
    ]);
    expect(pendingDeclaration(t)).toBeNull();
  });
});

describe('readReviewPayload', () => {
  it('round-trips the stamps through a sync', () => {
    const gone = withdrawReview(ask('Move the CTA?'), {
      by: 'Cartographer',
      at: 1234,
      reason: 'superseded',
    });
    expect(gone.ok).toBe(true);
    if (!gone.ok) return;
    const back = readReviewPayload(JSON.parse(JSON.stringify(gone.next)));
    expect(back?.withdrawnAt).toBe(1234);
    expect(back?.withdrawnBy).toBe('Cartographer');
    expect(back?.withdrawnReason).toBe('superseded');
  });

  it('a junk stamp neither retires a live ask nor revives a retracted one', () => {
    const junk = readReviewPayload({ ...ask('Live ask'), withdrawnAt: 'yesterday' });
    expect(junk && reviewWithdrawn(junk)).toBe(false);
    const nan = readReviewPayload({ ...ask('Live ask'), withdrawnAt: Number.NaN });
    expect(nan && reviewWithdrawn(nan)).toBe(false);
  });
});
