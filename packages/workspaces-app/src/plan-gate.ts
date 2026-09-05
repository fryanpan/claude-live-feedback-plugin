/**
 * The plan doc's one floating control — the whole "Make a plan" arc in a
 * single button at the bottom of the editor pane, wearing whichever of four
 * faces the doc has earned:
 *
 *   Make Plan       — a plan doc nobody has asked about yet. Pressing it
 *                     ASKS: it files an ordinary comment from the presser,
 *                     which is how the agent hears (see plan-request on the
 *                     server). On EITHER huddle kind — a discussion turns
 *                     into a plan as often as a planning session does
 *                     (Bryan, 2026-09-01: "there should be a plan button in
 *                     discussions too"). An ordinary doc has no agent
 *                     waiting on a goal, so it gets nothing.
 *   Plan requested  — somebody pressed and the agent has not answered yet.
 *                     Not a control, just the honest state: pressing again is
 *                     allowed, so the button stays live.
 *   Approve Plan    — the doc is a plan whose drafts are held. Keyed on
 *                     `planState` ALONE, not on the huddle kind: an agent can
 *                     mark any doc a pending plan and the approval must show.
 *   ✓ Plan Approved — the few seconds after a press, naming what the release
 *                     actually did. Then it goes away for good.
 *
 * This is the ticket #536 named and left for: the doc page used to carry a
 * one-line bar above the prose ("Plan pending — N draft tasks held") plus a
 * derived-work chip strip; both came out (Bryan, 2026-08-31 — "don't design
 * for plan approval here", "For docs, please depend on links inside the doc
 * — they're there already"). The tasks a doc produced read through the links
 * written in its prose now (task-link-chips.ts decorates those, including
 * the held-draft state), so the only chrome left is this float — anchored to
 * `#editor-pane` rather than the viewport so it stays clear of the doc-list
 * sidebar on desktop.
 *
 * Live like the strip it replaced: one event stream per board the held
 * drafts live on, so an approval from ANYWHERE (another tab, an agent over
 * MCP) releases the drafts, fires their transitions, and this button hides
 * itself rather than offering a stale Approve.
 */

import type { LeadPresence, User } from '@feedback/core';
import { floatDock } from './float-dock.ts';
import { leadReceiptSuffix } from './lead-banner.ts';

/** How long "✓ Plan Approved" stays before the doc is just a doc again. It
 *  is a receipt for a press the person just made, not a state to live in. */
const APPROVED_NOTICE_MS = 6000;

/** What the Make Plan subtitle calls the agent when the board names no lead
 *  — every board has somebody watching it, even unnamed. */
const FALLBACK_LEAD = 'your agent';

export interface PlanGateOpts {
  docId: string;
  /** The doc's editor pane — the float anchors to its `position: relative`
   *  so it pins to the visible pane, not to the scrolling prose. A bare
   *  root (a test, a stripped embed) anchors it to `root` itself. */
  root: HTMLElement;
  user: User;
  canWrite: boolean;
  /** Injected so a test drives this without a server or an EventSource. */
  fetchJson?: (url: string, init?: RequestInit) => Promise<unknown>;
  subscribe?: (workspaceId: string, onTaskEvent: () => void) => () => void;
  /**
   * Watch the doc's own metadata for a change, and re-read when one lands.
   *
   * This is how the float learns the plan ARRIVED. The board streams below
   * carry `task.transitioned` and `task.created` and nothing else, and
   * `POST /plan {state:'pending'}` fires neither — only the `approved` branch
   * touches the task projection. So a doc sitting on `Plan requested` had no
   * event that could reach it and stayed on that label until a reload, which
   * is exactly what the UX review measured.
   *
   * The signal it needs is already there: `setPlanState` writes `planState`
   * into the room's Yjs `meta` map, and this client is connected to that doc.
   * Observing the map turns the arrival into a live flip with no new server
   * surface. Injected rather than reached for so a test drives it without Yjs.
   */
  watchDocMeta?: (onChange: () => void) => () => void;
  /** Whether anybody is listening — see `ReviewFloatOpts.watchLeadPresence`;
   *  the "Plan requested" receipt says the same second line. */
  watchLeadPresence?: (onChange: (presence: LeadPresence | null) => void) => () => void;
  /** Injected so a test can retire the approved notice without waiting on a
   *  real clock. Defaults to the real timers. */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (handle: number) => void;
}

/** Which face the float is wearing, or `'none'` when there is no float. */
export type PlanFloatFace = 'none' | 'make' | 'requested' | 'approve' | 'approved';

export interface PlanGateHandle {
  destroy(): void;
  planState(): string | undefined;
  /** Which face is showing — the whole render decision, for a test to read. */
  face(): PlanFloatFace;
  /** The initial load, so a test can await the first render. */
  ready: Promise<void>;
}

interface DocAnswer {
  meta?: {
    planState?: string;
    huddleKind?: string;
    planRequestedAt?: number;
    planRequestedBy?: string;
    planApprovedBy?: string;
  };
  tasks?: Array<{ planHeld?: boolean; workspaceId?: string }>;
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

function defaultSubscribe(workspaceId: string, onTaskEvent: () => void): () => void {
  const es = new EventSource(`/workspaces/${encodeURIComponent(workspaceId)}/events:stream`);
  // Transitions are how an approval reaches this button (the release moves
  // the held rows); creates matter too — an agent filing more drafts while
  // the doc is open changes the count, though the count no longer renders.
  es.addEventListener('task.transitioned', onTaskEvent);
  es.addEventListener('task.created', onTaskEvent);
  return () => {
    es.removeEventListener('task.transitioned', onTaskEvent);
    es.removeEventListener('task.created', onTaskEvent);
    es.close();
  };
}

/** The receipt's second line. The release reports the rows it moved and
 *  nothing else, so this claims tickets and never a goal — a plan that
 *  released no held row gets no second line rather than a made-up one. */
function approvedSubLabel(released: number): string {
  if (released <= 0) return '';
  return `${released} ticket${released === 1 ? '' : 's'} created — work started`;
}

export function mountPlanGate(opts: PlanGateOpts): PlanGateHandle {
  const { docId, root, user, canWrite } = opts;
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const subscribe = opts.subscribe ?? defaultSubscribe;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
  const docUrl = `/api/docs/${encodeURIComponent(docId)}`;

  const float = document.createElement('button');
  float.type = 'button';
  float.className = 'plan-float';
  float.hidden = true;
  const labelEl = document.createElement('span');
  labelEl.className = 'plan-float-label';
  const subEl = document.createElement('span');
  subEl.className = 'plan-float-sub';
  float.append(labelEl, subEl);

  const error = document.createElement('span');
  error.className = 'plan-gate-error';
  // Assertive: only ever appears in answer to a press.
  error.setAttribute('aria-live', 'assertive');
  error.hidden = true;

  // Anchors to `#editor-pane`'s `position: relative` so it pins to the
  // visible pane whatever the scroll position; a bare root (a test) anchors
  // it to itself instead.
  const anchor = root.closest('#editor-pane') ?? root;
  // Into the pane's shared float dock, beside the Review float
  // (review-float.ts): one row at the bottom of the pane, whichever of the
  // two mounted first. The error stays on the pane itself.
  floatDock(anchor).append(float);
  anchor.append(error);

  let state: string | undefined;
  let kind: string | undefined;
  let presence: LeadPresence | null = null;
  let requestedAt: number | undefined;
  let requestedBy: string | undefined;
  let lead: string | undefined;
  let loaded = false;
  let busy = false;
  let disposed = false;
  /** Set only for the seconds after a press HERE, and it outranks the meta
   *  while it stands — the doc reads `approved` the instant the POST lands,
   *  and without this the receipt would never get a frame. */
  let approvedNotice: number | null = null;
  let noticeTimer: number | undefined;
  const streams = new Map<string, () => void>();

  function faceFor(): PlanFloatFace {
    if (!canWrite || !loaded) return 'none';
    if (approvedNotice !== null) return 'approved';
    if (state === 'pending') return 'approve';
    if (state !== undefined) return 'none';
    // No plan state yet: only a huddle doc offers to start one. Both kinds
    // — this used to read `kind !== 'plan'`, and the discussion Bryan
    // started had nowhere to ask for the plan it had arrived at.
    if (kind !== 'plan' && kind !== 'discussion') return 'none';
    return requestedAt === undefined ? 'make' : 'requested';
  }

  function render(): void {
    const face = faceFor();
    float.hidden = face === 'none';
    // `requested` is a RECEIPT, not a control. It used to stay pressable so
    // an agent that missed the first comment could be asked again, but every
    // press filed another identical thread — three presses, three threads,
    // with nothing on screen saying the first had been heard. The ask is a
    // comment and the doc has a comment box; a second identical thread is not
    // the recovery path it looked like.
    float.disabled = busy || face === 'approved' || face === 'requested';
    float.dataset.face = face;
    // One class per face so the stylesheet can colour them apart; the base
    // class carries the shape and the `[hidden]` guard.
    float.classList.toggle('plan-float--make', face === 'make');
    float.classList.toggle('plan-float--requested', face === 'requested');
    float.classList.toggle('plan-float--approve', face === 'approve');
    float.classList.toggle('plan-float--done', face === 'approved');
    const named = lead ?? FALLBACK_LEAD;
    if (face === 'make') {
      labelEl.textContent = 'Make Plan';
      subEl.textContent = `Ask ${named} to create a plan`;
    } else if (face === 'requested') {
      labelEl.textContent = 'Plan requested';
      // Name who asked, so the press has a receipt and not just a label that
      // could equally mean "nothing happened". No clock: "asked by" is the
      // fact a second presser needs, and a relative time would go stale in
      // place with nothing to re-render it.
      const wait = leadReceiptSuffix(presence) ?? `waiting for ${named}`;
      subEl.textContent = requestedBy
        ? `Asked by ${requestedBy} — ${wait}`
        : `${wait[0]?.toUpperCase()}${wait.slice(1)}`;
    } else if (face === 'approve') {
      labelEl.textContent = 'Approve Plan';
      subEl.textContent = 'Creates the goal and tickets, starts work';
    } else if (face === 'approved') {
      labelEl.textContent = '✓ Plan Approved';
      subEl.textContent = approvedSubLabel(approvedNotice ?? 0);
    }
    // An empty second line must not reserve its own row.
    subEl.hidden = subEl.textContent === '';
    if (face !== 'approve' && face !== 'make') error.hidden = true;
  }

  /** One stream per board the held drafts live on; boards that dropped out
   *  of the answer are closed rather than accumulating. Streams are only
   *  needed while the gate is live — an approved plan closes them all. */
  function syncStreams(boards: Set<string>): void {
    if (state !== 'pending') boards.clear();
    for (const [wsId, stop] of streams) {
      if (!boards.has(wsId)) {
        stop();
        streams.delete(wsId);
      }
    }
    for (const wsId of boards) {
      if (!streams.has(wsId)) {
        streams.set(
          wsId,
          subscribe(wsId, () => {
            if (!disposed) void load();
          }),
        );
      }
    }
  }

  async function load(): Promise<void> {
    try {
      const body = (await fetchJson(docUrl)) as DocAnswer;
      if (disposed) return;
      state = body.meta?.planState;
      kind = body.meta?.huddleKind;
      requestedAt = body.meta?.planRequestedAt;
      requestedBy = body.meta?.planRequestedBy;
      lead = body.leadAgentId;
      loaded = true;
      const tasks = body.tasks ?? [];
      render();
      syncStreams(
        new Set(tasks.map((t) => t.workspaceId).filter((w): w is string => w !== undefined)),
      );
    } catch {
      // A server that cannot answer leaves the gate as it was; the doc
      // still works.
    }
  }

  /** Both presses share this: refuse while busy or unloaded, clear the last
   *  refusal, run, reload, and put a failure where the press was. */
  function press(run: () => Promise<unknown>): void {
    if (busy || !loaded) return;
    error.hidden = true;
    error.textContent = '';
    busy = true;
    render();
    void run()
      .then(() => load())
      .catch((err: Error) => {
        error.textContent = err.message;
        error.hidden = false;
      })
      .finally(() => {
        busy = false;
        if (!disposed) render();
      });
  }

  float.addEventListener('click', () => {
    const face = faceFor();
    // `requested` is disabled above and files nothing — one ask, one thread.
    if (face === 'make') {
      press(() =>
        fetchJson(`${docUrl}/plan-request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ author: user }),
        }),
      );
      return;
    }
    if (face !== 'approve') return;
    press(async () => {
      const res = (await fetchJson(`${docUrl}/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: 'approved', author: user }),
      })) as { released?: unknown[] };
      // The receipt counts what the RELEASE reported, not what the doc
      // guessed: a plan whose rows were already moved releases none, and
      // saying "3 tickets" there would be a lie the doc cannot back up.
      approvedNotice = Array.isArray(res?.released) ? res.released.length : 0;
      if (noticeTimer !== undefined) clearTimer(noticeTimer);
      noticeTimer = setTimer(() => {
        approvedNotice = null;
        noticeTimer = undefined;
        if (!disposed) render();
      }, APPROVED_NOTICE_MS);
    });
  });

  const ready = load();

  // The doc's own metadata, watched from mount — this is what carries the
  // plan's ARRIVAL (see `watchDocMeta`). Unconditional rather than gated on a
  // face: the gate that used to decide when to listen is the bug.
  const stopPresenceWatch = opts.watchLeadPresence?.((p) => {
    presence = p;
    if (!disposed && loaded) render();
  });
  const stopMetaWatch = opts.watchDocMeta?.(() => {
    if (!disposed) void load();
  });

  return {
    destroy(): void {
      disposed = true;
      stopMetaWatch?.();
      stopPresenceWatch?.();
      if (noticeTimer !== undefined) clearTimer(noticeTimer);
      for (const stop of streams.values()) stop();
      streams.clear();
      float.remove();
      error.remove();
    },
    planState: () => state,
    face: faceFor,
    ready,
  };
}
