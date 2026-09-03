/**
 * Holds background repaints while a pointer interaction is in flight.
 *
 * iOS Safari drops the synthetic `click` entirely when the element under the
 * finger is replaced between touchstart and touchend (WebKit-level; W3C
 * webevents #3). The hub repaints Home, the board and the open panel with
 * `replaceChildren()` on every `thread.*` / `task.transitioned` SSE event —
 * on a busy board that is every few seconds — so a repaint landing mid-press
 * eats the tap, and a decision option takes two taps. Touch presses are
 * longer than mouse clicks, which is why the iPad hits the window "often"
 * and a desktop never does.
 *
 * `schedule(repaint)` is the one door: with no interaction in flight the
 * repaint runs synchronously — identical to calling it directly — and during
 * one it is parked and flushed after the tap completes. Parking is a Set of
 * closures, so callers who pass STABLE references coalesce for free: ten SSE
 * events during one press become one repaint, reading the latest state.
 *
 * The reader's own tap is never made to wait. The window ends on the `click`
 * itself, observed at the capture phase — so by the time the tapped button's
 * own handler runs (bubble phase) the window is already over, and any render
 * that handler asks for goes straight through. The flush still waits one
 * macrotask so the dispatch in progress finishes on the DOM it started on.
 *
 * Sibling of `trackGesture` (src/gesture.ts), which suppresses the comment
 * pill for the same family of reasons — and which taught this module that
 * `pointercancel` fires INSTEAD of `pointerup` under scrolling and system
 * gestures, and that a watchdog must end what no event ever does.
 */

/** Release-to-click headroom: Safari synthesizes the click just after
 *  touchend, so a flush on `pointerup` alone could still land under it.
 *  The `click` listener usually ends the window well before this. */
export const REPAINT_GRACE_MS = 250;

/** Longest a single press may hold repaints — a finger resting on the screen
 *  (or a drag whose end events never arrive) must not starve the board. It
 *  can only ever flush early, which is today's behavior, not a new failure. */
export const REPAINT_WATCHDOG_MS = 10_000;

export interface RepaintGuard {
  /** Is a pointer interaction (press, or its click-synthesis grace) in flight? */
  readonly active: boolean;
  /** Run `repaint` now, or after the current interaction ends. Pass a stable
   *  reference: identical closures scheduled during one press run once. */
  schedule(repaint: () => void): void;
  dispose(): void;
}

export interface RepaintGuardOpts {
  /** Where presses start — the app's root. */
  dom: EventTarget;
  /** Where releases, cancels and clicks are observed. A cancelled touch may
   *  never deliver anything to `dom`, so these watch the window. */
  win: EventTarget;
  graceMs?: number;
  watchdogMs?: number;
}

export function createRepaintGuard(opts: RepaintGuardOpts): RepaintGuard {
  const graceMs = opts.graceMs ?? REPAINT_GRACE_MS;
  const watchdogMs = opts.watchdogMs ?? REPAINT_WATCHDOG_MS;
  const pending = new Set<() => void>();
  let active = false;
  let grace: ReturnType<typeof setTimeout> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clearTimer(t: ReturnType<typeof setTimeout> | null): null {
    if (t != null) clearTimeout(t);
    return null;
  }

  function flush(): void {
    // A new press since the end that queued this flush keeps the park —
    // the repaints run when THAT interaction ends.
    if (disposed || active) return;
    const jobs = [...pending];
    pending.clear();
    for (const job of jobs) job();
  }

  function begin(): void {
    if (disposed) return;
    active = true;
    grace = clearTimer(grace);
    watchdog = clearTimer(watchdog);
    watchdog = setTimeout(end, watchdogMs);
  }

  /** Pointer lifted: give Safari its click-synthesis window before ending. */
  function release(): void {
    if (disposed || !active) return;
    grace = clearTimer(grace);
    grace = setTimeout(end, graceMs);
  }

  /** The interaction is over — click observed, cancel, grace, or watchdog. */
  function end(): void {
    if (disposed) return;
    active = false;
    grace = clearTimer(grace);
    watchdog = clearTimer(watchdog);
    // One macrotask later, never synchronously: on the click path this
    // listener runs at capture, mid-dispatch, and the repaint must not swap
    // the DOM out from under the event still propagating through it.
    if (pending.size > 0) setTimeout(flush, 0);
  }

  opts.dom.addEventListener('pointerdown', begin, { capture: true, passive: true });
  opts.win.addEventListener('pointerup', release, { capture: true, passive: true });
  opts.win.addEventListener('pointercancel', end, { capture: true, passive: true });
  // Capture phase, deliberately: ending here is what keeps the tapped
  // button's own bubble-phase handler free to render immediately.
  opts.win.addEventListener('click', end, true);

  return {
    get active() {
      return active;
    },
    schedule(repaint: () => void): void {
      if (disposed || !active) {
        repaint();
        return;
      }
      pending.add(repaint);
    },
    dispose() {
      disposed = true;
      active = false;
      pending.clear();
      grace = clearTimer(grace);
      watchdog = clearTimer(watchdog);
      opts.dom.removeEventListener('pointerdown', begin, { capture: true });
      opts.win.removeEventListener('pointerup', release, { capture: true });
      opts.win.removeEventListener('pointercancel', end, { capture: true });
      opts.win.removeEventListener('click', end, true);
    },
  };
}
