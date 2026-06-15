import type { User } from '@feedback/core';

/**
 * Interaction-bounded reading-session tracker — IRONCLAD against idle
 * inflation (the Weekly Review agent is paranoid about it).
 *
 * Contract:
 *   - A session's `durationMs` is the SUM OF ACTIVE-INTERACTION SPANS only,
 *     never (endTs - startTs). Idle gaps are excluded.
 *   - Each interaction marks a window of `ACTIVE_WINDOW_MS` as active around
 *     it. Overlapping windows (interactions within ACTIVE_WINDOW_MS of each
 *     other) merge into one continuous span; a gap larger than the window
 *     closes the span and is excluded as idle. `durationMs` is the total
 *     length of those merged active spans — so a SINGLE interaction is worth
 *     one window, and the last interaction's window is always counted (the
 *     two cases the naive "sum the gaps between interactions" model dropped).
 *   - "Interaction" = scroll | pointerdown | keydown. A bare `pointermove`
 *     only EXTENDS an already-open session; it never opens one, so a stray
 *     mouse twitch on a focused-but-unread tab stays noise.
 *   - After IDLE_GAP_MS of NO interaction, the session ENDS and is flushed.
 *     The idle gap itself never counts toward durationMs.
 *   - A focused tab with ZERO opening interaction emits NOTHING (never opens
 *     a session).
 *   - A single session caps at MAX_SESSION_MS (20 min); exceeding it flushes
 *     and a fresh session starts on the next interaction.
 *   - maxScrollDepthPct is tracked across the session.
 *   - On pagehide / visibilitychange→hidden, any in-flight session flushes.
 *   - A `doc_open` event is emitted exactly once, on load.
 */

export const IDLE_GAP_MS = 45_000; // 45s of no interaction ends the session
export const MAX_SESSION_MS = 20 * 60_000; // cap a single session at 20 min
// Each interaction marks this much wall time as "active" around it. Windows
// within ACTIVE_WINDOW_MS of each other merge; a larger gap is idle.
export const ACTIVE_WINDOW_MS = 5_000;

/**
 * Pure active-span accumulator — the accrual math, factored out so it's
 * unit-testable without DOM/timers. Tracks the running union-length of the
 * active windows around each interaction.
 *
 * `durationMs` holds the length of already-CLOSED spans; the in-flight span
 * runs `[spanStartMs, spanEndMs)`. The reported duration is `spanDuration()`
 * (closed + in-flight).
 */
export interface ActiveSpanState {
  durationMs: number;
  spanStartMs: number;
  spanEndMs: number;
}

/** Open the first active window around an interaction at `nowMs`. */
export function openSpan(nowMs: number): ActiveSpanState {
  return { durationMs: 0, spanStartMs: nowMs, spanEndMs: nowMs + ACTIVE_WINDOW_MS };
}

/**
 * Fold an interaction at `nowMs` into the state: extend the current window if
 * it's still active, otherwise close the previous span (excluding the idle
 * gap) and open a fresh window.
 */
export function extendSpan(s: ActiveSpanState, nowMs: number): void {
  if (nowMs <= s.spanEndMs) {
    // Contiguous activity — stretch the active window forward.
    s.spanEndMs = nowMs + ACTIVE_WINDOW_MS;
  } else {
    // Gap exceeded the window — bank the closed span, drop the idle gap,
    // start a new window.
    s.durationMs += s.spanEndMs - s.spanStartMs;
    s.spanStartMs = nowMs;
    s.spanEndMs = nowMs + ACTIVE_WINDOW_MS;
  }
}

/** Total active time: closed spans + the in-flight span. */
export function spanDuration(s: ActiveSpanState): number {
  return s.durationMs + (s.spanEndMs - s.spanStartMs);
}

export interface ReadingTrackerOptions {
  docId: string;
  user: User;
  /** Element whose scrollTop/scrollHeight define scroll depth. Falls back to
   *  the document scrolling element. */
  scrollEl?: HTMLElement | null;
  /** Override the POST target base (defaults to same-origin). Used in tests. */
  apiBase?: string;
}

interface Session {
  sessionId: string;
  startMs: number;
  span: ActiveSpanState;
  /** Wall-clock time of the most recent interaction (idle-timer + endTs). */
  lastInteractionMs: number;
  maxScrollDepthPct: number;
}

function randomSessionId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * Start tracking. Returns a teardown function (mainly for tests; in the live
 * app the page-load lifetime owns the tracker).
 */
export function startReadingTracker(opts: ReadingTrackerOptions): () => void {
  const base = opts.apiBase ?? '';
  const postUrl = `${base}/api/docs/${encodeURIComponent(opts.docId)}/activity`;

  const post = (type: 'read_session' | 'doc_open', payload: Record<string, unknown>): void => {
    const body = JSON.stringify({ type, payload, author: opts.user });
    // Prefer sendBeacon for the page-hide flush so it survives unload.
    try {
      if (type === 'read_session' && typeof navigator !== 'undefined' && navigator.sendBeacon) {
        const blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(postUrl, blob)) return;
      }
    } catch {
      // fall through to fetch
    }
    try {
      void fetch(postUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
      });
    } catch {
      // best-effort; never throw from a tracker
    }
  };

  // doc_open — exactly once on load.
  post('doc_open', { sessionId: randomSessionId() });

  let session: Session | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const scrollDepthPct = (): number => {
    const el = opts.scrollEl ?? (document.scrollingElement as HTMLElement | null);
    if (!el) return 0;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return 100; // nothing to scroll = fully "seen"
    const pct = (el.scrollTop / max) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  };

  const flush = (endMs: number): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (!session) return;
    const s = session;
    session = null;
    const durationMs = Math.min(spanDuration(s.span), MAX_SESSION_MS);
    // Defensive: a session always banks at least one window once opened, so
    // this is never <= 0, but guard anyway rather than emit empty noise.
    if (durationMs <= 0) return;
    post('read_session', {
      sessionId: s.sessionId,
      startTs: new Date(s.startMs).toISOString(),
      endTs: new Date(endMs).toISOString(),
      durationMs,
      maxScrollDepthPct: s.maxScrollDepthPct,
      interactionBounded: true,
    });
  };

  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // No interaction for IDLE_GAP_MS — end the session at the last
      // interaction time (the idle gap is excluded from durationMs; the
      // last interaction's active window is still banked via spanDuration).
      if (session) flush(session.lastInteractionMs);
    }, IDLE_GAP_MS);
  };

  // `opensSession=false` (a bare pointermove) extends an open session but
  // never starts one — a stray twitch on an unread tab stays noise.
  const onSignal = (opensSession: boolean): void => {
    const now = Date.now();
    if (!session) {
      if (!opensSession) return;
      session = {
        sessionId: randomSessionId(),
        startMs: now,
        span: openSpan(now),
        lastInteractionMs: now,
        maxScrollDepthPct: scrollDepthPct(),
      };
      armIdleTimer();
      return;
    }
    extendSpan(session.span, now);
    session.lastInteractionMs = now;
    const depth = scrollDepthPct();
    if (depth > session.maxScrollDepthPct) session.maxScrollDepthPct = depth;
    // Cap a single session at MAX_SESSION_MS; flush + let the next
    // opening interaction start a fresh one.
    if (spanDuration(session.span) >= MAX_SESSION_MS) {
      flush(now);
      return;
    }
    armIdleTimer();
  };

  const onOpener = (): void => onSignal(true);
  const onMove = (): void => onSignal(false);
  const openerEvents = ['scroll', 'pointerdown', 'keydown'] as const;
  for (const ev of openerEvents) {
    window.addEventListener(ev, onOpener, { passive: true, capture: true });
  }
  window.addEventListener('pointermove', onMove, { passive: true, capture: true });

  const onHide = (): void => {
    if (session) flush(Date.now());
  };
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') onHide();
  };
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    for (const ev of openerEvents) {
      window.removeEventListener(ev, onOpener, { capture: true } as EventListenerOptions);
    }
    window.removeEventListener('pointermove', onMove, { capture: true } as EventListenerOptions);
    window.removeEventListener('pagehide', onHide);
    document.removeEventListener('visibilitychange', onVisibility);
    if (idleTimer) clearTimeout(idleTimer);
    if (session) flush(Date.now());
  };
}
