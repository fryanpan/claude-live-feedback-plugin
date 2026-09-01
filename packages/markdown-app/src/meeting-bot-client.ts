/**
 * The doc's meeting-bot lifecycle, headless — state in, verbs out, no DOM.
 *
 * This used to be `meeting-bot-row.ts`: a self-rendering row under the old
 * bottom strip with its own paste-a-link form. The top-bar overhaul moved
 * every meeting surface into one place (the Record button's strip, menu and
 * start chooser), so the form went there and what remains here is the part
 * that was never about pixels: one endpoint, one SSE event, and the rule that
 * a server without a Recall key has no bot feature at all.
 *
 * STILL DELIBERATELY NOT PART OF THE STRIP'S STATE MACHINE. The strip owns a
 * microphone, a permission prompt that can outlive the press, and a socket
 * that IS the meeting; a bot is none of those things and shares none of that
 * state. The chrome renders both; it does not merge them.
 *
 * WHAT IT CARRIES. The bot's STATE — joining, waiting to be let in, waiting
 * on the host's recording consent, recording, gone — and its WORDS: one
 * `meeting.transcript` per vendor frame, partials included, on the SAME
 * EventSource. Both ride the doc's existing event stream (no second socket
 * per tab for a bot that has no browser of its own); the words are transient
 * on the wire — never buffered, never given an id — so they cannot evict the
 * doc's real events from the replay window. See `MEETING_TRANSCRIPT_EVENT`
 * in core for the contract. The strip folds them through the same
 * `rollTranscript` the microphone's socket frames go through.
 */

import {
  MEETING_BOT_EVENT,
  MEETING_TRANSCRIPT_EVENT,
  type MeetingBotStatus,
  type MeetingTranscriptEvent,
  isTerminalBotState,
  meetingPlatformOf,
  parseMeetingTranscriptEvent,
} from '@feedback/core';

/** The two things the doc's stream tells this client. One subscription
 *  carries both — the point is that there is exactly one stream. */
export interface MeetingBotStreamHandlers {
  onStatus: (status: MeetingBotStatus) => void;
  onTranscript: (frame: MeetingTranscriptEvent) => void;
}

export interface MeetingBotClientOpts {
  docId: string;
  /** Injected so a test drives this without a server or an EventSource. */
  fetchJson?: (url: string, init?: RequestInit) => Promise<unknown>;
  subscribe?: (docId: string, handlers: MeetingBotStreamHandlers) => () => void;
}

export interface MeetingBotClient {
  destroy(): void;
  /** Resolved once the first read has answered (or failed). */
  ready: Promise<void>;
  /** Whether this server can run a bot at all. False until `ready`. */
  configured(): boolean;
  /** The last status seen, terminal or not. Null before any bot existed. */
  status(): MeetingBotStatus | null;
  /** The status only while something will still happen without a new invite. */
  live(): MeetingBotStatus | null;
  /**
   * Send a bot to a call. Rejects with a message a person can read — the
   * platform check runs here as well as on the server so a typo costs a
   * glance rather than a round trip; the server's check is the one that
   * counts. `botName` is the name in the call's participant list; absent, the
   * server's configured default stands.
   */
  invite(meetingUrl: string, botName?: string): Promise<void>;
  leave(): Promise<void>;
  /** Fires on every status change, however it arrived. Returns a canceller. */
  onChange(cb: () => void): () => void;
  /**
   * Fires on every live transcript frame — partials included, the same
   * turn number arriving again with more (or corrected) words. Nothing is
   * retained here: a listener attached mid-meeting sees the frames from
   * then on, exactly like a tab opened mid-meeting.
   */
  onTranscript(cb: (frame: MeetingTranscriptEvent) => void): () => void;
}

async function defaultFetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : `request failed (${res.status})`;
    throw new Error(message);
  }
  return body;
}

function defaultSubscribe(docId: string, handlers: MeetingBotStreamHandlers): () => void {
  const es = new EventSource(`/events/${encodeURIComponent(docId)}`);
  const onStatus = (ev: MessageEvent): void => {
    try {
      handlers.onStatus(JSON.parse(ev.data) as MeetingBotStatus);
    } catch {
      // A frame we cannot read is not a reason to tear the channel down.
    }
  };
  const onTranscript = (ev: MessageEvent): void => {
    const frame = parseMeetingTranscriptEvent(ev.data);
    if (frame) handlers.onTranscript(frame);
  };
  es.addEventListener(MEETING_BOT_EVENT, onStatus as EventListener);
  es.addEventListener(MEETING_TRANSCRIPT_EVENT, onTranscript as EventListener);
  return () => {
    es.removeEventListener(MEETING_BOT_EVENT, onStatus as EventListener);
    es.removeEventListener(MEETING_TRANSCRIPT_EVENT, onTranscript as EventListener);
    es.close();
  };
}

export function createMeetingBotClient(opts: MeetingBotClientOpts): MeetingBotClient {
  const { docId } = opts;
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const subscribe = opts.subscribe ?? defaultSubscribe;
  const base = `/api/docs/${encodeURIComponent(docId)}/meeting-bot`;

  let current: MeetingBotStatus | null = null;
  let isConfigured = false;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const transcriptListeners = new Set<(frame: MeetingTranscriptEvent) => void>();

  function notify(): void {
    for (const cb of listeners) cb();
  }

  // The first read decides whether the feature exists at all: no key or no
  // public URL for the vendor to dial back on means no bot source in the
  // chooser rather than a button that always fails.
  const ready = fetchJson(base)
    .then((body) => {
      if (disposed) return;
      const payload = body as { configured?: boolean; bot?: MeetingBotStatus | null };
      if (!payload.configured) return;
      isConfigured = true;
      current = payload.bot ?? null;
      unsubscribe = subscribe(docId, {
        onStatus: (status) => {
          if (disposed) return;
          current = status;
          notify();
        },
        onTranscript: (frame) => {
          if (disposed) return;
          for (const cb of transcriptListeners) cb(frame);
        },
      });
      notify();
    })
    .catch(() => {
      // A server that cannot answer this is a server without the feature as
      // far as this client is concerned. Silent: the doc still works.
    });

  return {
    ready,
    configured: () => isConfigured,
    status: () => current,
    live: () => (current && !isTerminalBotState(current.state) ? current : null),
    invite: async (meetingUrl: string, botName?: string) => {
      if (!meetingPlatformOf(meetingUrl)) {
        throw new Error('That is not a Zoom, Google Meet or Teams link.');
      }
      const body = await fetchJson(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          meetingUrl,
          ...(botName !== undefined && botName.trim() !== '' ? { botName: botName.trim() } : {}),
        }),
      });
      const status = (body as { bot?: MeetingBotStatus }).bot;
      if (status && !disposed) {
        current = status;
        notify();
      }
    },
    leave: async () => {
      await fetchJson(base, { method: 'DELETE' });
    },
    onChange: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onTranscript: (cb) => {
      transcriptListeners.add(cb);
      return () => transcriptListeners.delete(cb);
    },
    destroy: () => {
      disposed = true;
      listeners.clear();
      transcriptListeners.clear();
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
