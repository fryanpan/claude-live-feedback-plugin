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
 */

import type { User } from '@feedback/core';

export interface PlanGateOpts {
  docId: string;
  root: HTMLElement;
  user: User;
  canWrite: boolean;
  /** Injected so a test drives this without a server. */
  fetchJson?: (url: string, init?: RequestInit) => Promise<unknown>;
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

export function mountPlanGate(opts: PlanGateOpts): PlanGateHandle {
  const { docId, root, user, canWrite } = opts;
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
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

  async function load(): Promise<void> {
    try {
      const body = (await fetchJson(docUrl)) as {
        meta?: { planState?: string };
        tasks?: Array<{ planHeld?: boolean }>;
      };
      if (disposed) return;
      state = body.meta?.planState;
      heldCount = (body.tasks ?? []).filter((t) => t.planHeld === true).length;
      render();
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
      row.remove();
    },
    planState: () => state,
    ready,
  };
}
