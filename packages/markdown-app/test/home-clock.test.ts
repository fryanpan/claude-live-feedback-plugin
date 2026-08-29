/**
 * The Home pane's minute clock: ages ("4m") and the time-keyed flags
 * (`dark`) are computed from `now` at paint time, and a paint only used to
 * happen on a board event — a quiet board showed a line "4m" old for an
 * hour. The clock repaints Home once a minute, only while Home is showing,
 * and stops when told to (the same beforeunload that clears the presence
 * tick).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOME_CLOCK_MS, startHomeClock } from '../src/hub/home-clock.ts';

describe('startHomeClock', () => {
  afterEach(() => vi.useRealTimers());

  it('repaints once a minute while Home is showing, and not while another pane is', () => {
    vi.useFakeTimers();
    const repaint = vi.fn();
    let pane = 'home';
    const stop = startHomeClock(() => pane === 'home', repaint);
    expect(HOME_CLOCK_MS).toBe(60_000);
    vi.advanceTimersByTime(HOME_CLOCK_MS - 1);
    expect(repaint).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(repaint).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HOME_CLOCK_MS);
    expect(repaint).toHaveBeenCalledTimes(2);
    pane = 'board';
    vi.advanceTimersByTime(3 * HOME_CLOCK_MS);
    expect(repaint).toHaveBeenCalledTimes(2);
    pane = 'home';
    vi.advanceTimersByTime(HOME_CLOCK_MS);
    expect(repaint).toHaveBeenCalledTimes(3);
    stop();
  });

  it('a stopped clock never fires again', () => {
    vi.useFakeTimers();
    const repaint = vi.fn();
    const stop = startHomeClock(() => true, repaint);
    vi.advanceTimersByTime(HOME_CLOCK_MS);
    expect(repaint).toHaveBeenCalledTimes(1);
    stop();
    vi.advanceTimersByTime(10 * HOME_CLOCK_MS);
    expect(repaint).toHaveBeenCalledTimes(1);
  });
});
