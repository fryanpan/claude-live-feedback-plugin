import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REPAINT_GRACE_MS,
  REPAINT_WATCHDOG_MS,
  createRepaintGuard,
} from '../src/hub/repaint-guard.ts';

/**
 * Background repaints must not land under the reader's finger.
 *
 * The bug (reported from the iPad, 2026-08-25: options often took two taps):
 * every `thread.*` / `task.transitioned` SSE event repaints Home, and the
 * repaint `replaceChildren()`s the decision card — destroying and recreating
 * every option button. iOS Safari drops the synthetic `click` entirely when
 * the element under the finger is replaced between touchstart and touchend
 * (WebKit-level; W3C webevents #3), so a repaint landing mid-press eats the
 * tap. Touch presses are longer than mouse clicks, which is why the iPad
 * hits the window "often" and desktop never does.
 *
 * The guard holds any repaint scheduled during a pointer interaction and
 * flushes it once the tap has fully completed (click observed, or a short
 * grace after release for Safari's click synthesis). Repaints scheduled with
 * no interaction in flight run immediately — the reader's own tap is never
 * made to wait, because the click that carries it ends the window before its
 * handlers run.
 *
 * Safari's click-drop itself can't run in happy-dom, so these tests model
 * it: the tap's click is delivered only if the pressed button survived to
 * touchend (`isConnected`), which is exactly the behavior the WebKit issue
 * describes.
 */

describe('createRepaintGuard', () => {
  let container: HTMLDivElement;
  let btn: HTMLButtonElement;
  let taps: number;
  let guard: ReturnType<typeof createRepaintGuard>;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    btn = document.createElement('button');
    btn.textContent = 'Ship it';
    btn.addEventListener('click', () => {
      taps++;
    });
    container.append(btn);
    document.body.append(container);
    taps = 0;
    guard = createRepaintGuard({ dom: document, win: window });
  });

  afterEach(() => {
    guard.dispose();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const press = () => btn.dispatchEvent(new Event('pointerdown', { bubbles: true }));

  /** Finish the tap the way Safari does: release, then a synthetic click —
   *  delivered only when the element under the finger is still in the
   *  document. A detached target gets no click at all. */
  const completeTap = () => {
    window.dispatchEvent(new Event('pointerup'));
    if (btn.isConnected) btn.dispatchEvent(new Event('click', { bubbles: true }));
  };

  /** The repaint under test: what `renderHomeReview` does to the card. */
  const repaint = () => {
    const rebuilt = document.createElement('button');
    rebuilt.textContent = 'Ship it';
    container.replaceChildren(rebuilt);
  };

  // ── Negative control: today's behavior, no guard ─────────────────────────

  it('control: an unguarded repaint mid-press eats the tap', () => {
    press();
    repaint(); // SSE event repaints while the finger is down
    completeTap();
    expect(taps).toBe(0); // the tap died — this is the bug being fixed
  });

  it('control: the same tap with no repaint registers (the probe can see)', () => {
    press();
    completeTap();
    expect(taps).toBe(1);
  });

  // ── The guard ────────────────────────────────────────────────────────────

  it('defers a repaint scheduled during a press, so the first tap registers', () => {
    press();
    guard.schedule(repaint); // SSE event arrives mid-press
    expect(btn.isConnected).toBe(true); // nothing repainted under the finger
    completeTap();
    expect(taps).toBe(1); // ONE tap answered
    vi.runAllTimers();
    // …and the deferred repaint landed once the interaction was over.
    expect(btn.isConnected).toBe(false);
    expect(container.textContent).toBe('Ship it');
  });

  it('coalesces many events into one repaint — latest wins, no queue buildup', () => {
    const paint = vi.fn();
    press();
    guard.schedule(paint);
    guard.schedule(paint);
    guard.schedule(paint);
    completeTap();
    vi.runAllTimers();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('keeps distinct repaints distinct — coalescing is per closure, not global', () => {
    const paintA = vi.fn();
    const paintB = vi.fn();
    press();
    guard.schedule(paintA);
    guard.schedule(paintB);
    guard.schedule(paintA);
    completeTap();
    vi.runAllTimers();
    expect(paintA).toHaveBeenCalledTimes(1);
    expect(paintB).toHaveBeenCalledTimes(1);
  });

  it('runs immediately when no interaction is in flight', () => {
    const paint = vi.fn();
    guard.schedule(paint);
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('never defers the render the tap itself asked for', () => {
    // The user's own answer handler repaints from inside the click. The
    // guard's capture-phase click listener has already ended the window by
    // the time the button's handler runs, so that repaint is immediate.
    const paint = vi.fn();
    btn.addEventListener('click', () => guard.schedule(paint));
    press();
    completeTap();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('flushes after the grace period when no click ever arrives', () => {
    // A drag or a scroll ends in pointerup with no click; Safari's click
    // synthesis window is what the grace covers.
    const paint = vi.fn();
    press();
    guard.schedule(paint);
    window.dispatchEvent(new Event('pointerup'));
    expect(paint).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REPAINT_GRACE_MS + 1);
    vi.runAllTimers();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('flushes after a pointercancel — no click is coming', () => {
    const paint = vi.fn();
    press();
    guard.schedule(paint);
    window.dispatchEvent(new Event('pointercancel'));
    vi.runAllTimers();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('a held finger cannot starve the board forever — the watchdog flushes', () => {
    const paint = vi.fn();
    press();
    guard.schedule(paint);
    vi.advanceTimersByTime(REPAINT_WATCHDOG_MS + 1);
    vi.runAllTimers();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('a new press before the flush keeps holding the repaint', () => {
    const paint = vi.fn();
    press();
    guard.schedule(paint);
    window.dispatchEvent(new Event('pointerup'));
    // Second tap begins inside the first tap's grace window.
    press();
    vi.advanceTimersByTime(REPAINT_GRACE_MS + 1);
    expect(paint).not.toHaveBeenCalled();
    completeTap();
    vi.runAllTimers();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('dispose stops listening and runs schedules immediately', () => {
    const paint = vi.fn();
    guard.dispose();
    press();
    guard.schedule(paint);
    expect(paint).toHaveBeenCalledTimes(1);
  });
});
