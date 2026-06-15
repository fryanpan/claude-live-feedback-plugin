import type { User } from '@feedback/core';

/**
 * Interaction-bounded reading-session tracker — IRONCLAD against idle
 * inflation (the Weekly Review agent is paranoid about it).
 *
 * Contract:
 *   - A session's `durationMs` is the SUM OF ACTIVE-INTERACTION SPANS only,
 *     never (endTs - startTs). Idle gaps are excluded.
 *   - "Interaction" = scroll | pointer (move/down) | keydown.
 *   - After IDLE_GAP_MS of NO interaction, the session ENDS and is flushed.
 *     The idle gap itself never counts toward durationMs.
 *   - A focused tab with ZERO interaction emits NOTHING (never opens a
 *     session). Only the first interaction opens a session.
 *   - A single session caps at MAX_SESSION_MS (20 min); exceeding it flushes
 *     and a fresh session starts on the next interaction.
 *   - maxScrollDepthPct is tracked across the session.
 *   - On pagehide / visibilitychange→hidden, any in-flight session flushes.
 *   - A `doc_open` event is emitted exactly once, on load.
 *
 * Active span accounting: each interaction extends the current "active span"
 * to a window of ACTIVE_WINDOW_MS around it. We accrue the wall time between
 * consecutive interactions ONLY when that gap is <= ACTIVE_WINDOW_MS;
 * larger gaps are treated as idle and excluded.
 */

const IDLE_GAP_MS = 45_000; // 45s of no interaction ends the session
const MAX_SESSION_MS = 20 * 60_000; // cap a single session at 20 min
// Wall time between two interactions is counted as "active" only up to this
// window; a longer gap is idle (and, past IDLE_GAP_MS, ends the session).
const ACTIVE_WINDOW_MS = 5_000;

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
  /** Accrued active-interaction time (ms) — the reported durationMs. */
  durationMs: number;
  /** Wall-clock time of the most recent interaction. */
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
    // Only emit sessions that accrued real active time. A zero-duration
    // session (e.g. a single stray pointermove) is noise.
    if (s.durationMs <= 0) return;
    post('read_session', {
      sessionId: s.sessionId,
      startTs: new Date(s.startMs).toISOString(),
      endTs: new Date(endMs).toISOString(),
      durationMs: Math.min(s.durationMs, MAX_SESSION_MS),
      maxScrollDepthPct: s.maxScrollDepthPct,
      interactionBounded: true,
    });
  };

  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // No interaction for IDLE_GAP_MS — end the session at the last
      // interaction time (the idle gap is excluded from durationMs).
      if (session) flush(session.lastInteractionMs);
    }, IDLE_GAP_MS);
  };

  const onInteraction = (): void => {
    const now = Date.now();
    if (!session) {
      // First interaction opens a session. A focus-only tab never gets here.
      session = {
        sessionId: randomSessionId(),
        startMs: now,
        durationMs: 0,
        lastInteractionMs: now,
        maxScrollDepthPct: scrollDepthPct(),
      };
      armIdleTimer();
      return;
    }
    const gap = now - session.lastInteractionMs;
    // Accrue active time for the gap, but only up to ACTIVE_WINDOW_MS — a
    // longer gap was (partly) idle and must not inflate durationMs.
    session.durationMs += Math.min(gap, ACTIVE_WINDOW_MS);
    session.lastInteractionMs = now;
    const depth = scrollDepthPct();
    if (depth > session.maxScrollDepthPct) session.maxScrollDepthPct = depth;
    // Cap a single session at MAX_SESSION_MS; flush + let the next
    // interaction open a fresh one.
    if (session.durationMs >= MAX_SESSION_MS) {
      flush(now);
      return;
    }
    armIdleTimer();
  };

  const interactionEvents = ['scroll', 'pointerdown', 'pointermove', 'keydown'] as const;
  for (const ev of interactionEvents) {
    window.addEventListener(ev, onInteraction, { passive: true, capture: true });
  }

  const onHide = (): void => {
    if (session) flush(Date.now());
  };
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') onHide();
  };
  window.addEventListener('pagehide', onHide);
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    for (const ev of interactionEvents) {
      window.removeEventListener(ev, onInteraction, { capture: true } as EventListenerOptions);
    }
    window.removeEventListener('pagehide', onHide);
    document.removeEventListener('visibilitychange', onVisibility);
    if (idleTimer) clearTimeout(idleTimer);
    if (session) flush(Date.now());
  };
}
