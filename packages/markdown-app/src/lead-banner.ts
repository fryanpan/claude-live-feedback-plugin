/**
 * The meeting doc's "nobody is listening" line.
 *
 * Every ask a meeting doc makes — the Make Plan and Review floats, a task or
 * research ask said aloud — is addressed to the board's lead agent, and all
 * of them file fine into an empty seat. The person then waits on an answer
 * that is not coming, and finds out later. So while it is true, the doc
 * says it, plainly and persistently: no lead agent is listening, asks will
 * queue until one attaches. Recording is never held up by it, and nothing
 * here is dismissable — the state is the thing to fix.
 *
 * "Listening" is the server's word (`GET /api/docs/:id/lead-presence`): the
 * seat is held and its holder can be handed something now, not merely
 * connected. The GET registers this page; changes then arrive on the doc's
 * event stream as `lead.presence`, and the banner shows or goes with them.
 * Unknown (the GET failed) shows nothing: a false alarm on a doc whose
 * board is fine would teach people to ignore the line.
 */
import { LEAD_PRESENCE_EVENT, type LeadPresence } from '@feedback/core';

export interface LeadBannerOpts {
  docId: string;
  /** Where the line goes — prepended, so it sits above the prose. */
  parent: HTMLElement;
  /** Injected so a test drives this without a server or an EventSource. */
  fetchJson?: (url: string) => Promise<unknown>;
  subscribe?: (docId: string, onPresence: (presence: LeadPresence) => void) => () => void;
}

export interface LeadBanner {
  element: HTMLElement;
  /** Resolved once the first read has answered (or failed). */
  ready: Promise<void>;
  /** The last answer seen; null until one arrives. */
  presence(): LeadPresence | null;
  destroy(): void;
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`request failed (${res.status})`);
  return res.json();
}

function defaultSubscribe(docId: string, onPresence: (p: LeadPresence) => void): () => void {
  const es = new EventSource(`/events/${encodeURIComponent(docId)}`);
  const onFrame = (ev: MessageEvent): void => {
    const parsed = parseLeadPresence(ev.data);
    if (parsed) onPresence(parsed);
  };
  es.addEventListener(LEAD_PRESENCE_EVENT, onFrame as EventListener);
  return () => {
    es.removeEventListener(LEAD_PRESENCE_EVENT, onFrame as EventListener);
    es.close();
  };
}

export function parseLeadPresence(raw: unknown): LeadPresence | null {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  const p = data as Partial<LeadPresence>;
  if (typeof p.docId !== 'string' || typeof p.live !== 'boolean') return null;
  return {
    event: LEAD_PRESENCE_EVENT,
    docId: p.docId,
    live: p.live,
    ...(typeof p.workspaceId === 'string' ? { workspaceId: p.workspaceId } : {}),
    ...(typeof p.leadAgentId === 'string' ? { leadAgentId: p.leadAgentId } : {}),
    ...(typeof p.observedAt === 'number' ? { observedAt: p.observedAt } : {}),
  };
}

/** What the line says, by what is true. Null means nothing to say. */
export function leadBannerText(presence: LeadPresence | null): string | null {
  if (!presence || presence.live) return null;
  if (!presence.workspaceId) {
    return 'This doc is on no board, so nothing is listening for asks made here.';
  }
  return 'No lead agent is listening — asks made here will queue until one attaches.';
}

export function mountLeadBanner(opts: LeadBannerOpts): LeadBanner {
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const subscribe = opts.subscribe ?? defaultSubscribe;
  const doc = opts.parent.ownerDocument;

  const element = doc.createElement('div');
  element.className = 'lead-banner';
  element.setAttribute('role', 'status');
  element.hidden = true;
  const dot = doc.createElement('span');
  dot.className = 'lead-banner__dot';
  dot.setAttribute('aria-hidden', 'true');
  const text = doc.createElement('span');
  text.className = 'lead-banner__text';
  element.append(dot, text);
  opts.parent.prepend(element);

  let current: LeadPresence | null = null;
  let disposed = false;

  const render = (): void => {
    const line = leadBannerText(current);
    element.hidden = line === null;
    text.textContent = line ?? '';
  };

  const apply = (presence: LeadPresence): void => {
    if (disposed || presence.docId !== opts.docId) return;
    current = presence;
    render();
  };

  const unsubscribe = subscribe(opts.docId, apply);
  const ready = fetchJson(`/api/docs/${encodeURIComponent(opts.docId)}/lead-presence`)
    .then((body) => {
      const parsed = parseLeadPresence(body);
      if (parsed) apply(parsed);
    })
    .catch(() => {
      // Unknown shows nothing — see the header.
    });

  return {
    element,
    ready,
    presence: () => current,
    destroy() {
      disposed = true;
      unsubscribe();
      element.remove();
    },
  };
}
