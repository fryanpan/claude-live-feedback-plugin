/**
 * The reconnect schedule — the half of the 2026-09-04 outage that made it
 * self-sustaining.
 *
 * The old backoff was a bare 1.5s constant on a client holding one loop per
 * watched key, so every session redialled every key at the same instant after
 * every drop. What ends that is not the growth on its own: it is FULL jitter,
 * because half-jitter still lands the whole fleet in the back half of one
 * window. These tests pin both, and the cap that bounds recovery.
 *
 * The draw is injected, so nothing here samples `Math.random` and nothing
 * here is flaky.
 */
import { describe, expect, it } from 'vitest';
import {
  RECONNECT_BASE_MS,
  RECONNECT_CAP_MS,
  reconnectDelayMs,
  reconnectWindowMs,
} from '../src/backoff.ts';

describe('the reconnect window grows and then stops', () => {
  it('doubles per attempt from the base', () => {
    expect(reconnectWindowMs(1)).toBe(RECONNECT_BASE_MS);
    expect(reconnectWindowMs(2)).toBe(RECONNECT_BASE_MS * 2);
    expect(reconnectWindowMs(3)).toBe(RECONNECT_BASE_MS * 4);
  });

  it('honours the cap, so a recovered server is found within it', () => {
    expect(reconnectWindowMs(50)).toBe(RECONNECT_CAP_MS);
    // The exponent overflows to Infinity long before this; the cap still wins.
    expect(reconnectWindowMs(5_000)).toBe(RECONNECT_CAP_MS);
    expect(RECONNECT_CAP_MS).toBeGreaterThanOrEqual(30_000);
  });

  it('treats a first or nonsense attempt as the base window', () => {
    expect(reconnectWindowMs(0)).toBe(RECONNECT_BASE_MS);
    expect(reconnectWindowMs(Number.NaN)).toBe(RECONNECT_BASE_MS);
  });
});

describe('the delay is drawn from the WHOLE window, not the back of it', () => {
  it('reaches zero on a low draw', () => {
    // Half-jitter cannot produce this, and that is the difference: a fleet
    // that all waits at least half a window is still a herd.
    expect(reconnectDelayMs(4, () => 0)).toBe(0);
  });

  it('stays strictly inside the window on the highest draw', () => {
    const window = reconnectWindowMs(3);
    expect(reconnectDelayMs(3, () => 0.999999)).toBeLessThan(window);
    expect(reconnectDelayMs(3, () => 0.999999)).toBeGreaterThan(window * 0.99);
  });

  it('never exceeds the cap however many attempts have failed', () => {
    for (const attempt of [1, 2, 8, 40, 4_000]) {
      expect(reconnectDelayMs(attempt, () => 0.999999)).toBeLessThan(RECONNECT_CAP_MS);
    }
  });

  it('spreads a fleet of clients across the window rather than onto one instant', () => {
    // Twenty clients redialling after the same restart, each with its own
    // draw: the spread is the property, and a constant backoff has none.
    const delays = Array.from({ length: 20 }, (_, i) => reconnectDelayMs(4, () => i / 20));
    expect(new Set(delays).size).toBe(20);
    expect(Math.min(...delays)).toBe(0);
    expect(Math.max(...delays)).toBeLessThan(reconnectWindowMs(4));
  });

  it('clamps a draw outside [0,1) rather than producing a negative wait', () => {
    expect(reconnectDelayMs(2, () => -1)).toBe(0);
    expect(reconnectDelayMs(2, () => 5)).toBeLessThanOrEqual(reconnectWindowMs(2));
  });
});
