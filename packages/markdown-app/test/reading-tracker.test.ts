import { describe, expect, it } from 'vitest';
import {
  ACTIVE_WINDOW_MS,
  type ActiveSpanState,
  extendSpan,
  openSpan,
  spanDuration,
} from '../src/reading-tracker.ts';

/**
 * The read-session duration is the union-length of the ACTIVE_WINDOW_MS
 * windows around each interaction. These tests pin the two regressions the
 * old "sum the gaps BETWEEN interactions" model had: a single interaction
 * counted as 0 (so a scroll-once-then-read session emitted nothing), and the
 * final interaction's window was never banked.
 */
describe('reading-tracker active-span accrual', () => {
  it('a single interaction is worth one active window (not zero)', () => {
    const s = openSpan(1_000);
    // The naive model left this at 0 and the session was dropped as noise.
    expect(spanDuration(s)).toBe(ACTIVE_WINDOW_MS);
  });

  it('interactions within the window merge into one continuous span', () => {
    const s = openSpan(0);
    extendSpan(s, 2_000); // still inside [0, 5000)
    extendSpan(s, 4_000); // still inside the (extended) window
    // window now runs [0, 4000+5000) = 9000ms of contiguous active time
    expect(spanDuration(s)).toBe(4_000 + ACTIVE_WINDOW_MS);
  });

  it('a gap larger than the window is excluded as idle', () => {
    const s = openSpan(0);
    // 20s gap >> ACTIVE_WINDOW_MS: closes [0,5000), opens [20000,25000).
    extendSpan(s, 20_000);
    // Two 5s windows counted; the 15s idle gap is NOT.
    expect(spanDuration(s)).toBe(2 * ACTIVE_WINDOW_MS);
  });

  it('the last interaction window is always banked', () => {
    const s = openSpan(0);
    extendSpan(s, 3_000); // contiguous → window to 8000
    // The trailing window past the final interaction counts (the old model
    // dropped it): total active = 8000.
    expect(spanDuration(s)).toBe(3_000 + ACTIVE_WINDOW_MS);
  });

  it('accumulates closed spans across multiple idle gaps', () => {
    const s: ActiveSpanState = openSpan(0);
    extendSpan(s, 100_000); // gap → bank 5000, open [100000,105000)
    extendSpan(s, 200_000); // gap → bank 5000, open [200000,205000)
    expect(spanDuration(s)).toBe(3 * ACTIVE_WINDOW_MS);
  });
});
