/**
 * The plan gate's one control — a floating "Approve Plan" button, shown ONLY
 * while the doc is a plan whose drafts are held, gone for good once somebody
 * approves. Ordinary docs never render anything here.
 *
 * This is the ticket #536 named and left for: the doc page used to carry a
 * one-line bar above the prose ("Plan pending — N draft tasks held") plus a
 * derived-work chip strip; both came out (Bryan, 2026-08-31 — "don't design
 * for plan approval here", "For docs, please depend on links inside the doc
 * — they're there already"). The tasks a doc produced read through the links
 * written in its prose now (task-link-chips.ts decorates those, including
 * the held-draft state), so the only job left is the Approve press that
 * releases the drafts — and the approved mock makes that press the loudest
 * thing on the page: a floating pill, always visible however far the plan
 * has been scrolled, anchored to `#editor-pane` rather than the viewport so
 * it stays clear of the doc-list sidebar on desktop.
 *
 * Live like the strip it replaced: one event stream per board the held
 * drafts live on, so an approval from ANYWHERE (another tab, an agent over
 * MCP) releases the drafts, fires their transitions, and this button hides
 * itself rather than offering a stale Approve.
 */

import type { User } from '@feedback/core';

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
}

export interface PlanGateHandle {
  destroy(): void;
  planState(): string | undefined;
  /** The initial load, so a test can await the first render. */
  ready: Promise<void>;
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
  const es = new EventSource(`/events/workspace/${encodeURIComponent(workspaceId)}`);
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

export function mountPlanGate(opts: PlanGateOpts): PlanGateHandle {
  const { docId, root, user, canWrite } = opts;
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const subscribe = opts.subscribe ?? defaultSubscribe;
  const docUrl = `/api/docs/${encodeURIComponent(docId)}`;

  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'plan-approve-float';
  // Just the label (Bryan, on the mock): no checkmark, no held-drafts
  // subtext — the button is loud enough by being the only floating thing.
  approve.textContent = 'Approve Plan';
  approve.hidden = true;

  const error = document.createElement('span');
  error.className = 'plan-gate-error';
  // Assertive: only ever appears in answer to a press.
  error.setAttribute('aria-live', 'assertive');
  error.hidden = true;

  // Anchors to `#editor-pane`'s `position: relative` so it pins to the
  // visible pane whatever the scroll position; a bare root (a test) anchors
  // it to itself instead.
  const anchor = root.closest('#editor-pane') ?? root;
  anchor.append(approve, error);

  let state: string | undefined;
  let canApprove = false;
  let busy = false;
  let disposed = false;
  const streams = new Map<string, () => void>();

  function render(): void {
    const pending = state === 'pending';
    approve.hidden = !pending || !canWrite;
    approve.disabled = busy;
    if (!pending) error.hidden = true;
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
      const body = (await fetchJson(docUrl)) as {
        meta?: { planState?: string };
        tasks?: Array<{ planHeld?: boolean; workspaceId?: string }>;
      };
      if (disposed) return;
      state = body.meta?.planState;
      canApprove = true;
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

  approve.addEventListener('click', () => {
    if (busy || !canApprove) return;
    error.hidden = true;
    error.textContent = '';
    busy = true;
    render();
    void fetchJson(`${docUrl}/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'approved', author: user }),
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

  return {
    destroy(): void {
      disposed = true;
      for (const stop of streams.values()) stop();
      streams.clear();
      approve.remove();
      error.remove();
    },
    planState: () => state,
    ready,
  };
}
