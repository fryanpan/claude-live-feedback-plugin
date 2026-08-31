/**
 * The plan gate's one control — a single quiet line above the prose, shown
 * ONLY while the doc is a plan whose drafts are held, gone for good once
 * somebody approves. Ordinary docs never render anything here.
 *
 * This replaces the derived-work chips strip (Bryan, 2026-08-31: *"For docs,
 * please depend on links inside the doc — they're there already. No need to
 * surface at the top and take up precious screen space."*). The tasks a doc
 * produced now read through the links written in its prose — the
 * task-link-chips extension decorates those with live status, including the
 * held-draft state — so the only job left up here is the Approve press that
 * releases the drafts, and that job exists only while the plan is pending.
 *
 * Live like the strip was: one event stream per board the held drafts live
 * on, so an approval from ANYWHERE (another tab, an agent over MCP) releases
 * the drafts, fires their transitions, and this line reloads itself away
 * rather than offering a stale Approve.
 */

import type { User } from '@feedback/core';

export interface PlanGateOpts {
  docId: string;
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
  // Transitions are how an approval reaches this line (the release moves the
  // held rows); creates matter too — an agent filing more drafts while the
  // doc is open changes the count.
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

  const row = document.createElement('div');
  row.className = 'plan-gate';
  row.hidden = true;

  const label = document.createElement('span');
  label.className = 'plan-gate-label';

  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'plan-gate-approve';
  approve.textContent = 'Approve plan';
  approve.hidden = true;

  const error = document.createElement('span');
  error.className = 'plan-gate-error';
  // Assertive: only ever appears in answer to a press.
  error.setAttribute('aria-live', 'assertive');

  row.append(label, approve, error);
  root.append(row);

  let state: string | undefined;
  let heldCount = 0;
  let busy = false;
  let disposed = false;
  const streams = new Map<string, () => void>();

  function render(): void {
    if (state !== 'pending') {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    label.textContent =
      heldCount > 0
        ? `Plan pending — ${heldCount} draft ${heldCount === 1 ? 'task' : 'tasks'} held`
        : 'Plan pending';
    approve.hidden = !canWrite;
    approve.disabled = busy;
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
      const tasks = body.tasks ?? [];
      heldCount = tasks.filter((t) => t.planHeld === true).length;
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
    if (busy) return;
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
      row.remove();
    },
    planState: () => state,
    ready,
  };
}
