/**
 * The Review float — the meeting's second one-tap ask, beside Make Plan.
 *
 * Bryan's framing for mid-meeting help (task "ask for help in one or two
 * taps"): the actions have to cost the person almost nothing to trigger.
 * Make Plan is one of them; this is the other. Pressing it asks the doc's
 * agent to read the notes and the transcript and put clarifying questions
 * on the lines that need them. Like Make Plan, the ask IS a comment — a
 * subject thread from the presser, filed by `POST /review-request` — so it
 * rides the channel every watching agent already listens to.
 *
 * Two faces:
 *
 *   Review             — a huddle doc a writer can press. Subtitle names
 *                        the board's lead, so the press is predictable.
 *   Review requested   — pressed, and the ask thread is still open. A
 *                        receipt, disabled: a second press would file a
 *                        second identical thread, which is not a recovery
 *                        path (plan-gate.ts learned this the hard way).
 *
 * Unlike a plan, a review is asked for more than once in a meeting, so the
 * receipt is not for good: the server stamps the thread's id, and when that
 * thread is resolved — the agent answered — the face goes back to Review.
 * The thread lives in the doc's own Yjs `threads` map, which this client is
 * already connected to, so watching it is free (injected, like the meta
 * watch, so a test drives it without Yjs).
 *
 * Only on a huddle doc (`meta.huddle`), whichever kind: a discussion has no
 * Make Plan and still wants this.
 */

import type { LeadPresence, User } from '@feedback/core';
import { api } from './doc-path.ts';
import { floatDock } from './float-dock.ts';
import { leadReceiptSuffix } from './lead-banner.ts';

/** What the subtitle calls the agent when the board names no lead. */
const FALLBACK_LEAD = 'your agent';

export interface ReviewFloatOpts {
  docId: string;
  /** The doc's editor pane — the float docks into `#editor-pane`, or into
   *  `root` itself when there is no pane (a test, a stripped embed). */
  root: HTMLElement;
  user: User;
  canWrite: boolean;
  /** Injected so a test drives this without a server. */
  fetchJson?: (url: string, init?: RequestInit) => Promise<unknown>;
  /** The doc's own metadata — the stamp lands there, so another tab's
   *  press flips this one to the receipt. Re-reads on any change. */
  watchDocMeta?: (onChange: () => void) => () => void;
  /**
   * Whether the ask thread is still open. `undefined` means the thread is
   * not in the local map (yet): treated as OPEN, because before the doc has
   * synced the map is empty, and a face that read "Review" for that moment
   * would invite the second press the receipt exists to prevent.
   */
  threadOpen?: (threadId: string) => boolean | undefined;
  /** The threads map — a resolve is what turns the receipt back into an
   *  offer. Re-renders on any change; nothing is fetched. */
  watchThreads?: (onChange: () => void) => () => void;
  /**
   * Whether anybody is listening — the lead banner's own read and stream
   * (`lead-banner.ts`), shared rather than duplicated. While the seat is
   * empty the receipt says so in its second line: Bryan pressed Review on
   * prod with the agent offline and the float read "waiting for your
   * agent" as if one were coming (2026-09-01). Absent, the receipt reads
   * as it always did.
   */
  watchLeadPresence?: (onChange: (presence: LeadPresence | null) => void) => () => void;
}

export type ReviewFloatFace = 'none' | 'ask' | 'requested';

export interface ReviewFloatHandle {
  destroy(): void;
  /** Which face is showing — the whole render decision, for a test. */
  face(): ReviewFloatFace;
  /** The initial load, so a test can await the first render. */
  ready: Promise<void>;
}

interface DocAnswer {
  meta?: {
    huddle?: boolean;
    reviewRequestedAt?: number;
    reviewRequestedBy?: string;
    reviewThreadId?: string;
  };
  leadAgentId?: string;
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

export function mountReviewFloat(opts: ReviewFloatOpts): ReviewFloatHandle {
  const { docId, root, user, canWrite } = opts;
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const docUrl = api(`docs/${encodeURIComponent(docId)}`);

  const float = document.createElement('button');
  float.type = 'button';
  // `plan-float` for the shape it shares; `review-float` for its own faces.
  float.className = 'plan-float review-float';
  float.hidden = true;
  const labelEl = document.createElement('span');
  labelEl.className = 'plan-float-label';
  const subEl = document.createElement('span');
  subEl.className = 'plan-float-sub';
  float.append(labelEl, subEl);

  const error = document.createElement('span');
  error.className = 'plan-gate-error';
  error.setAttribute('aria-live', 'assertive');
  error.hidden = true;

  const anchor = root.closest('#editor-pane') ?? root;
  floatDock(anchor).append(float);
  anchor.append(error);

  let huddle = false;
  let requestedAt: number | undefined;
  let requestedBy: string | undefined;
  let threadId: string | undefined;
  let lead: string | undefined;
  let presence: LeadPresence | null = null;
  let loaded = false;
  let busy = false;
  let disposed = false;

  function askOpen(): boolean {
    if (requestedAt === undefined) return false;
    // A stamp with no thread id (never written by this server, but meta is
    // a map) has nothing to watch: it reads as an open ask.
    if (threadId === undefined) return true;
    return opts.threadOpen?.(threadId) !== false;
  }

  function faceFor(): ReviewFloatFace {
    if (!canWrite || !loaded || !huddle) return 'none';
    return askOpen() ? 'requested' : 'ask';
  }

  function render(): void {
    const face = faceFor();
    float.hidden = face === 'none';
    float.disabled = busy || face === 'requested';
    float.dataset.face = face;
    float.classList.toggle('review-float--ask', face === 'ask');
    float.classList.toggle('plan-float--requested', face === 'requested');
    const named = lead ?? FALLBACK_LEAD;
    if (face === 'ask') {
      labelEl.textContent = 'Review';
      subEl.textContent = `Ask ${named} to review the notes`;
    } else if (face === 'requested') {
      labelEl.textContent = 'Review requested';
      // The second half tells the truth about the wait: "waiting for X"
      // while X is listening, and "no lead attached" while nobody
      // is — an unanswered ask that explains itself.
      const wait = leadReceiptSuffix(presence) ?? `waiting for ${named}`;
      subEl.textContent = requestedBy
        ? `Asked by ${requestedBy} — ${wait}`
        : `${wait[0]?.toUpperCase()}${wait.slice(1)}`;
    }
    subEl.hidden = subEl.textContent === '';
    if (face !== 'ask') error.hidden = true;
  }

  async function load(): Promise<void> {
    try {
      const body = (await fetchJson(docUrl)) as DocAnswer;
      if (disposed) return;
      huddle = body.meta?.huddle === true;
      requestedAt = body.meta?.reviewRequestedAt;
      requestedBy = body.meta?.reviewRequestedBy;
      threadId = body.meta?.reviewThreadId;
      lead = body.leadAgentId;
      loaded = true;
      render();
    } catch {
      // A server that cannot answer leaves the float as it was.
    }
  }

  float.addEventListener('click', () => {
    if (busy || !loaded || faceFor() !== 'ask') return;
    error.hidden = true;
    error.textContent = '';
    busy = true;
    render();
    void fetchJson(`${docUrl}/review-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: user }),
    })
      .then(() => load())
      .catch((err: Error) => {
        error.textContent = err.message;
        error.hidden = false;
      })
      .finally(() => {
        busy = false;
        if (!disposed) render();
      });
  });

  const ready = load();
  const stopMetaWatch = opts.watchDocMeta?.(() => {
    if (!disposed) void load();
  });
  const stopThreadWatch = opts.watchThreads?.(() => {
    if (!disposed && loaded) render();
  });
  const stopPresenceWatch = opts.watchLeadPresence?.((p) => {
    presence = p;
    if (!disposed && loaded) render();
  });

  return {
    destroy(): void {
      disposed = true;
      stopMetaWatch?.();
      stopThreadWatch?.();
      stopPresenceWatch?.();
      float.remove();
      error.remove();
    },
    face: faceFor,
    ready,
  };
}
