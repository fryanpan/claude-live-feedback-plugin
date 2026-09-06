/**
 * Whether a meeting's asks have anybody to land on — and telling the doc
 * page when that changes.
 *
 * A meeting doc's floats and spoken asks all address the board's LEAD seat:
 * Make Plan, Review, "can you research X", a task said aloud. Every one of
 * them files fine into an empty doc, and until this existed the doc
 * looked the same either way — the ask sat in a queue nobody was draining,
 * and the person who asked found out an hour later. So the doc says it,
 * plainly and persistently, while it is true: no lead agent is listening,
 * asks will queue until one attaches. Recording is never held up by it.
 *
 * "Attached" is the store's own word for it, not a new one: the lead seat is
 * held AND its holder is deliverable — a stream open, or observed within the
 * delivery window — which is what `hasLiveLeadAttachment` gates board-wide
 * requests on. Merely connected is not enough, for exactly the reason that
 * predicate exists: a session that attached and died an hour ago would
 * still be "attached" by the roster and would answer nothing.
 *
 * The push is change-only, and it goes only to docs a page has ASKED about
 * (the GET registers the doc): presence is a property of the board, so one
 * seat change would otherwise fan out to every doc the board ever held. A
 * sweep re-reads the watched docs on a short clock because the delivery
 * window closes silently — nothing fires when a heartbeat simply stops.
 */

import { LEAD_PRESENCE_EVENT, type LeadPresence } from '@feedback/core';

export { LEAD_PRESENCE_EVENT, type LeadPresence };

/** The two reads this needs, as the server holds them. */
export interface LeadPresenceSource {
  /** The board holding the doc — the same answer the doc's back arrow gives. */
  boardOf(docId: string): string | undefined;
  /** The seat as `TaskStore.leadSeatHealth` reports it. */
  seat(workspaceId: string): { leadAgentId?: string; live: boolean; lastObservedAt?: number };
}

export function readLeadPresence(source: LeadPresenceSource, docId: string): LeadPresence {
  const workspaceId = source.boardOf(docId);
  if (!workspaceId) return { event: LEAD_PRESENCE_EVENT, docId, live: false };
  const seat = source.seat(workspaceId);
  return {
    event: LEAD_PRESENCE_EVENT,
    docId,
    workspaceId,
    ...(seat.leadAgentId !== undefined ? { leadAgentId: seat.leadAgentId } : {}),
    live: seat.live,
    ...(seat.lastObservedAt !== undefined ? { observedAt: seat.lastObservedAt } : {}),
  };
}

/** The store events after which a seat's answer can have changed. */
const SEAT_EVENTS = new Set([
  'agent.attached',
  'agent.detached',
  'agent.heartbeat',
  'workspace.lead_changed',
]);

export interface LeadPresenceMonitorDeps {
  source: LeadPresenceSource;
  /** Deliver a changed answer to the doc's open pages. */
  broadcast(docId: string, presence: LeadPresence): void;
  /** Subscribe to the store's events; returns the unsubscribe. */
  onEvent(listener: (event: { type: string; workspaceId?: string }) => void): () => void;
  /** Whether any page still has the doc open. A watched doc nobody is
   *  reading is dropped on the next sweep. Absent, docs stay watched. */
  hasListeners?: (docId: string) => boolean;
  /** How often the watched docs are re-read for a change no event announced
   *  (the delivery window closing). Default 15s; 0 disables the sweep. */
  sweepMs?: number;
}

export interface LeadPresenceMonitor {
  /** Answer for the doc now, and keep the doc's pages told of changes. */
  watch(docId: string): LeadPresence;
  /** A board's seat may have changed for a reason no store event names —
   *  the lead's stream opening or closing. Re-reads that board's docs. */
  notify(workspaceId: string): void;
  /** Re-read every watched doc and push what changed. Exposed for tests;
   *  the sweep timer calls it. */
  sweep(): void;
  /** The docs currently kept told. */
  watched(): string[];
  stop(): void;
}

export function createLeadPresenceMonitor(deps: LeadPresenceMonitorDeps): LeadPresenceMonitor {
  // docId → the last `live` its pages were told. Change-only is keyed on
  // this one bit: it is what the banner shows, and an observedAt that ticks
  // on every heartbeat is not a change anybody needs to hear about.
  const last = new Map<string, boolean>();

  const reread = (docId: string): void => {
    const presence = readLeadPresence(deps.source, docId);
    const before = last.get(docId);
    if (before === presence.live) return;
    last.set(docId, presence.live);
    deps.broadcast(docId, presence);
  };

  const notify = (workspaceId: string): void => {
    for (const docId of last.keys()) {
      if (deps.source.boardOf(docId) === workspaceId) reread(docId);
    }
  };

  const unsubscribe = deps.onEvent((event) => {
    if (!SEAT_EVENTS.has(event.type) || !event.workspaceId) return;
    notify(event.workspaceId);
  });

  const sweep = (): void => {
    for (const docId of [...last.keys()]) {
      if (deps.hasListeners && !deps.hasListeners(docId)) {
        last.delete(docId);
        continue;
      }
      reread(docId);
    }
  };
  const sweepMs = deps.sweepMs ?? 15_000;
  const timer = sweepMs > 0 ? setInterval(sweep, sweepMs) : null;
  if (timer && typeof timer === 'object' && 'unref' in timer) timer.unref();

  return {
    watch(docId) {
      const presence = readLeadPresence(deps.source, docId);
      last.set(docId, presence.live);
      return presence;
    },
    notify,
    sweep,
    watched: () => [...last.keys()],
    stop() {
      unsubscribe();
      if (timer) clearInterval(timer);
      last.clear();
    },
  };
}
