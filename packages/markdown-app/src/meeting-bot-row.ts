/**
 * "Invite a bot to this call" — the doc's entry into the Recall path.
 *
 * DELIBERATELY NOT PART OF THE MEETING STRIP. The strip owns a state machine
 * with a microphone, a permission prompt that can outlive the press, and a
 * socket that IS the meeting; a bot is none of those things and shares none
 * of that state. Bolting it on would put two lifecycles in one machine, and
 * the strip's is the one that breaks expensively. This is a sibling row that
 * renders under it, reads one endpoint and one event, and owns nothing else.
 *
 * WHAT IT SHOWS AND WHAT IT DOES NOT. The bot's STATE — joining, waiting to
 * be let in, waiting on the host's recording consent, recording, gone. Not
 * the live transcript: a bot meeting's words have no socket back to this
 * browser (the strip's words come down the socket that sent the audio), and
 * pushing them over the doc's SSE channel would evict every real doc event
 * from its 200-event replay buffer inside a minute. The notes still compose
 * themselves into the doc, which is the thing the meeting was for. A live
 * ticker for bot meetings needs its own observer channel and is not here.
 *
 * IT HIDES ITSELF WHEN THE SERVER CANNOT DO THIS. No key, or no public URL
 * for Recall to dial back on, means no row at all rather than a button that
 * always fails.
 */

import {
  MEETING_BOT_EVENT,
  type MeetingBotStatus,
  describeBotState,
  isTerminalBotState,
  meetingPlatformOf,
} from '@feedback/core';

export interface MeetingBotRowOpts {
  docId: string;
  root: HTMLElement;
  /** Injected so a test drives this without a server or an EventSource. */
  fetchJson?: (url: string, init?: RequestInit) => Promise<unknown>;
  subscribe?: (docId: string, onStatus: (status: MeetingBotStatus) => void) => () => void;
}

export interface MeetingBotRowHandle {
  destroy(): void;
  /** The state currently rendered. For tests and for the strip's own tests. */
  status(): MeetingBotStatus | null;
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

function defaultSubscribe(docId: string, onStatus: (status: MeetingBotStatus) => void): () => void {
  const es = new EventSource(`/events/${encodeURIComponent(docId)}`);
  const handler = (ev: MessageEvent): void => {
    try {
      onStatus(JSON.parse(ev.data) as MeetingBotStatus);
    } catch {
      // A frame we cannot read is not a reason to tear the row down.
    }
  };
  es.addEventListener(MEETING_BOT_EVENT, handler as EventListener);
  return () => {
    es.removeEventListener(MEETING_BOT_EVENT, handler as EventListener);
    es.close();
  };
}

export function mountMeetingBotRow(opts: MeetingBotRowOpts): MeetingBotRowHandle {
  const { docId, root } = opts;
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const subscribe = opts.subscribe ?? defaultSubscribe;
  const base = `/api/docs/${encodeURIComponent(docId)}/meeting-bot`;

  const row = document.createElement('div');
  row.className = 'meeting-bot-row';
  row.hidden = true;

  const state = document.createElement('span');
  state.className = 'meeting-bot-state';
  // Polite, not assertive: a bot changing state is news, not an alarm, and
  // it can change four times in the first ten seconds of a call.
  state.setAttribute('aria-live', 'polite');

  const form = document.createElement('form');
  form.className = 'meeting-bot-form';
  const input = document.createElement('input');
  input.type = 'url';
  input.className = 'meeting-bot-url';
  input.placeholder = 'Paste a Zoom or Meet link';
  input.setAttribute('aria-label', 'Meeting link for the bot to join');
  const invite = document.createElement('button');
  invite.type = 'submit';
  invite.className = 'meeting-bot-invite';
  invite.textContent = 'Invite bot';
  form.append(input, invite);

  const leave = document.createElement('button');
  leave.type = 'button';
  leave.className = 'meeting-bot-leave';
  leave.textContent = 'Send home';
  leave.hidden = true;

  const error = document.createElement('span');
  error.className = 'meeting-bot-error';
  // Assertive: this one only ever appears in answer to a press, and it is
  // the reason the thing the person just asked for did not happen.
  error.setAttribute('aria-live', 'assertive');

  row.append(state, form, leave, error);
  root.append(row);

  let current: MeetingBotStatus | null = null;
  let busy = false;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;

  function render(): void {
    const live = current && !isTerminalBotState(current.state) ? current : null;
    if (live) {
      const who = live.speakers.length ? ` · ${live.speakers.join(', ')}` : '';
      state.textContent = `${describeBotState(live.state)}${who}`;
      form.hidden = true;
      leave.hidden = false;
      leave.disabled = busy;
    } else {
      // A bot that has left still says so, once, next to the form that can
      // send another — "the host declined recording" is the whole reason a
      // person would look at this row, and hiding it on the state change
      // would take the answer away at the moment it arrived.
      state.textContent = current ? describeBotState(current.state) : '';
      form.hidden = false;
      leave.hidden = true;
      invite.disabled = busy;
      input.disabled = busy;
    }
  }

  function fail(message: string): void {
    error.textContent = message;
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (busy) return;
    error.textContent = '';
    const meetingUrl = input.value.trim();
    // Checked here as well as on the server so a typo costs a glance rather
    // than a round trip — the server's check is the one that counts.
    if (!meetingPlatformOf(meetingUrl)) {
      fail('That is not a Zoom, Google Meet or Teams link.');
      return;
    }
    busy = true;
    render();
    void fetchJson(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meetingUrl }),
    })
      .then((body) => {
        const status = (body as { bot?: MeetingBotStatus }).bot;
        if (status) {
          current = status;
          input.value = '';
        }
      })
      .catch((err: Error) => fail(err.message))
      .finally(() => {
        busy = false;
        if (!disposed) render();
      });
  });

  leave.addEventListener('click', () => {
    if (busy) return;
    error.textContent = '';
    busy = true;
    render();
    void fetchJson(base, { method: 'DELETE' })
      .catch((err: Error) => fail(err.message))
      .finally(() => {
        busy = false;
        if (!disposed) render();
      });
  });

  // The first read decides whether this row exists at all.
  void fetchJson(base)
    .then((body) => {
      if (disposed) return;
      const payload = body as { configured?: boolean; bot?: MeetingBotStatus | null };
      if (!payload.configured) return;
      current = payload.bot ?? null;
      row.hidden = false;
      render();
      unsubscribe = subscribe(docId, (status) => {
        if (disposed) return;
        current = status;
        render();
      });
    })
    .catch(() => {
      // A server that cannot answer this is a server without the feature as
      // far as this row is concerned. Silent: the doc still works.
    });

  return {
    destroy(): void {
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      row.remove();
    },
    status: () => current,
  };
}
