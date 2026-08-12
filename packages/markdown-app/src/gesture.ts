/**
 * Touch-gesture tracking for the comment pill.
 *
 * The pill hides while a gesture that started on the document is in flight,
 * so it doesn't hop around under the finger during a drag-select. That makes
 * "the gesture ended" load-bearing: every path that can show the pill is
 * gated on it, so a gesture that never ends kills inline commenting for the
 * rest of the page load, silently.
 *
 * Mobile browsers end a touch two different ways. `pointerup` is the release;
 * `pointercancel` fires INSTEAD of it whenever the touch is taken over by a
 * system gesture — scrolling with a finger on the text, or iOS handing a
 * long-press to its own selection UI. Listening only for the release is the
 * bug this module exists to prevent.
 *
 * The watchdog covers the case neither event arrives. It can only ever end a
 * gesture early, and ending one early just shows the pill next to a real
 * selection — noise, where the alternative is a dead affordance.
 */

/** Longest a single gesture may suppress the pill before it self-settles.
 *  Comfortably past a deliberate long-press-then-drag selection on iOS. */
export const GESTURE_WATCHDOG_MS = 6000;

export interface GestureTracker {
  /** Is a gesture that started on the document still in flight? */
  readonly active: boolean;
  dispose(): void;
}

export interface GestureOpts {
  /** Where gestures start — the editor's own DOM. */
  dom: EventTarget;
  /** Where releases and cancels are observed. A cancelled touch may not
   *  deliver anything to `dom`, so these are watched at the window. */
  win: EventTarget;
  onBegin: () => void;
  onEnd: () => void;
  watchdogMs?: number;
}

export function trackGesture(opts: GestureOpts): GestureTracker {
  const watchdogMs = opts.watchdogMs ?? GESTURE_WATCHDOG_MS;
  let active = false;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clearWatchdog(): void {
    if (watchdog != null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  }

  function begin(): void {
    if (disposed) return;
    active = true;
    clearWatchdog();
    watchdog = setTimeout(end, watchdogMs);
    opts.onBegin();
  }

  /** Ends the gesture, whichever way it ended. Runs `onEnd` even when no
   *  gesture was active: a bare release anywhere on the page has always
   *  re-evaluated the pill, and that is a separate contract from `active`. */
  function end(): void {
    if (disposed) return;
    active = false;
    clearWatchdog();
    opts.onEnd();
  }

  opts.dom.addEventListener('pointerdown', begin);
  opts.win.addEventListener('pointerup', end);
  opts.win.addEventListener('pointercancel', end);

  return {
    get active() {
      return active;
    },
    dispose() {
      disposed = true;
      active = false;
      clearWatchdog();
      opts.dom.removeEventListener('pointerdown', begin);
      opts.win.removeEventListener('pointerup', end);
      opts.win.removeEventListener('pointercancel', end);
    },
  };
}
