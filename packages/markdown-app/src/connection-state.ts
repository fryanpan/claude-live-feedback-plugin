/**
 * "Reconnecting", said once and said deliberately.
 *
 * Restarting prod is standing policy, so the reconnect window is a normal
 * part of shipping rather than a crash symptom — and during it every surface
 * has to read as "back in a moment", not as the app falling over.
 *
 * The transport is already fine: ws-client emits connecting|closed|open and
 * backs off 500ms→10s on its own. What was missing is a reading of it. Two
 * rules make that reading deliberate:
 *
 *  1. A drop is only worth mentioning once it has LASTED. Below the grace
 *     window the socket usually repairs itself, and a banner that paints and
 *     unpaints inside a second is the flicker this exists to remove.
 *  2. The view changes, not the status. ws-client cycles connecting→closed
 *     on every retry attempt; all of those are one state to a reader, so
 *     onView fires on transitions between 'online' and 'reconnecting' and
 *     never once per attempt.
 *
 * Recovery needs no reload: 'open' clears the timer and, if a banner is up,
 * takes it down.
 */
import type { ConnectionStatus } from '@feedback/core';

export type ConnectionView = 'online' | 'reconnecting';

/**
 * How long a drop must persist before it is worth telling anyone about.
 *
 * Long enough that a routine socket blip never paints; short enough that a
 * real restart is announced while the reader is still looking at the screen
 * wondering what happened.
 */
export const RECONNECT_GRACE_MS = 1200;

export interface ConnectionWatchOptions {
  /** ws-client's subscribe: fires on transitions AND once with the current status. */
  onStatus: (cb: (s: ConnectionStatus) => void) => void;
  /** Called only when the reader-visible view CHANGES. */
  onView: (view: ConnectionView) => void;
  graceMs?: number;
}

export function watchConnection(opts: ConnectionWatchOptions): void {
  const { onStatus, onView } = opts;
  const graceMs = opts.graceMs ?? RECONNECT_GRACE_MS;

  let shown = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  onStatus((s) => {
    if (s === 'open') {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (shown) {
        shown = false;
        onView('online');
      }
      return;
    }
    // Already announced, or already counting down to announcing. Every retry
    // attempt after the first lands here, which is what keeps one outage to
    // one message.
    if (shown || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      shown = true;
      onView('reconnecting');
    }, graceMs);
  });
}

/**
 * The grace window governs what is SHOWN. It must never govern what is TRUE.
 *
 * The review surface has no per-update server ack, so "saved" is inferred
 * from "typing stopped and nothing went out for 500ms". That inference is
 * only valid if there was a server on the other end — with the socket down
 * the edit is still purely local no matter how long the reader has paused.
 * Letting the debounce settle inside the grace window therefore printed "All
 * changes saved" over a disconnected doc, which is a reassuring lie about the
 * one thing this indicator exists to be honest about.
 *
 * RESIDUAL, deliberately not fixed here: `wsOnline` means the SOCKET is open,
 * not that the reconnect's sync exchange has delivered the offline edits. The
 * caller waits 500ms after 'open' before settling, and ws-client pushes those
 * edits in the first sync round-trip — so the gap is a stalled handshake, not
 * a normal one. Closing it properly needs a per-reconnect "synced" signal on
 * ws-client, which is transport work this change deliberately stays out of.
 * The whole indicator is already a heuristic for an ack y-websocket does not
 * expose; this narrows it rather than removing it.
 */
export function settlePending(pendingEdits: number, wsOnline: boolean): number {
  return wsOnline ? 0 : pendingEdits;
}

export type SaveView = 'reconnecting' | 'dirty' | 'saved';

/**
 * `reconnecting` is the graced VIEW (from watchConnection), not the raw
 * socket status — a blip must not repaint the chip. `pendingEdits` carries
 * the truth through, because settlePending refuses to zero it while offline.
 */
export function saveStateView(o: { reconnecting: boolean; pendingEdits: number }): SaveView {
  if (o.reconnecting) return 'reconnecting';
  if (o.pendingEdits > 0) return 'dirty';
  return 'saved';
}

/**
 * The board's banner. Sits in the document flow directly under the topbar, so
 * it pushes the page down instead of covering a control — at 430px there is
 * no spare room to overlay anything a reader might be reaching for.
 */
export function renderConnectionBanner(el: HTMLElement | null, view: ConnectionView): void {
  if (!el) return;
  if (view === 'reconnecting') {
    // Names the cause, because the cause is almost always a deploy. "Offline"
    // and "connection error" both read as the app breaking.
    //
    // It does NOT say the work is safe, which the first draft did. There is
    // no local persistence: unsent updates live only in the in-memory Y.Doc,
    // and `client.close()` on navigate/reload destroys them. "Keep this tab
    // open" is the same reassurance turned into the one instruction that is
    // actually true — and the only action that changes the outcome.
    el.textContent = 'Reconnecting… the server is usually just restarting. Keep this tab open.';
    el.classList.remove('hidden');
    return;
  }
  el.textContent = '';
  el.classList.add('hidden');
}
