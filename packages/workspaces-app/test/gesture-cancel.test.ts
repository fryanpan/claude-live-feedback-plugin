import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GESTURE_WATCHDOG_MS, trackGesture } from '../src/gesture.ts';

/**
 * Touch-gesture tracking for the comment pill.
 *
 * The pill is suppressed while a gesture is in flight — otherwise it hops
 * around under the finger mid-drag. Every path that can SHOW the pill is
 * gated on that flag, so whatever clears it is load-bearing: if a gesture
 * never ends, the comment affordance is dead for the rest of the page load
 * and nothing says so.
 *
 * The shipped bug was exactly that. Only `pointerup` ended a gesture, and
 * mobile browsers fire `pointercancel` INSTEAD of `pointerup` whenever a
 * touch is taken over by a system gesture — scrolling with a finger on the
 * document text being the every-single-time case, iOS's long-press selection
 * takeover being the other. One cancelled touch and the pill never came back.
 *
 * So: a gesture must end on cancel as well as release, and — because the
 * failure mode is silent and total — it must also end on its own if neither
 * event ever arrives.
 */

describe('trackGesture', () => {
  let dom: HTMLElement;
  let begins: number;
  let ends: number;

  beforeEach(() => {
    vi.useFakeTimers();
    dom = document.createElement('div');
    document.body.appendChild(dom);
    begins = 0;
    ends = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  function track(watchdogMs?: number) {
    return trackGesture({
      dom,
      win: window,
      onBegin: () => {
        begins++;
      },
      onEnd: () => {
        ends++;
      },
      ...(watchdogMs === undefined ? {} : { watchdogMs }),
    });
  }

  const down = () => dom.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  const up = () => window.dispatchEvent(new Event('pointerup'));
  const cancel = () => window.dispatchEvent(new Event('pointercancel'));

  it('starts on a pointerdown over the document and ends on release', () => {
    const g = track();
    down();
    // Positive control for every assertion below: the tracker really does see
    // events dispatched this way, and a plain release really does end it.
    expect(g.active).toBe(true);
    expect(begins).toBe(1);
    up();
    expect(g.active).toBe(false);
    expect(ends).toBe(1);
    g.dispose();
  });

  it('ends on pointercancel — the release that never comes', () => {
    const g = track();
    down();
    expect(g.active).toBe(true);
    cancel();
    expect(g.active).toBe(false);
    expect(ends).toBe(1);
    // And the affordance is live again: a second gesture behaves like the first.
    down();
    expect(g.active).toBe(true);
    up();
    expect(g.active).toBe(false);
    expect(ends).toBe(2);
    g.dispose();
  });

  it('ends itself when neither release nor cancel ever arrives', () => {
    const g = track();
    down();
    vi.advanceTimersByTime(GESTURE_WATCHDOG_MS - 1);
    // Positive control: still in flight right up to the deadline, so the
    // assertion below is about the watchdog and not about time passing.
    expect(g.active).toBe(true);
    expect(ends).toBe(0);
    vi.advanceTimersByTime(2);
    expect(g.active).toBe(false);
    expect(ends).toBe(1);
    g.dispose();
  });

  it('re-arms the watchdog per gesture rather than counting from the first', () => {
    const g = track(1000);
    down();
    vi.advanceTimersByTime(900);
    up();
    down();
    vi.advanceTimersByTime(900);
    // 1800ms since the first pointerdown, but only 900 into THIS gesture.
    expect(g.active).toBe(true);
    vi.advanceTimersByTime(200);
    expect(g.active).toBe(false);
    g.dispose();
  });

  it('stops listening once disposed — a torn-down mount gets no callbacks', () => {
    const g = track();
    down();
    g.dispose();
    // The pending watchdog must not fire into a destroyed editor either.
    vi.advanceTimersByTime(GESTURE_WATCHDOG_MS * 2);
    const endsAfterDispose = ends;
    up();
    cancel();
    down();
    expect(ends).toBe(endsAfterDispose);
    expect(begins).toBe(1);
  });
});
