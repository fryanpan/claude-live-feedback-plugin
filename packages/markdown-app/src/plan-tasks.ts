/**
 * "Work derived from this doc" — the strip between the format bar and the
 * prose that shows the tasks filed FROM this doc, as live status chips, with
 * the plan gate's one control (Approve) when the doc is a pending plan.
 *
 * The server has known this tie for a while (origin refs, POST
 * /api/refs/backlinks); this is the surface that finally draws it — the
 * "backlinked and then never drawn" gap hub-render.ts named. Chips, not
 * prose: the strip re-reads one endpoint and re-renders, so a task moving on
 * the board updates here without anyone editing the doc.
 *
 * A sibling of the editor, not a plugin inside it (the task-link-chips
 * extension decorates links WRITTEN in the prose; this strip draws rows that
 * may appear nowhere in the text). Same shape as meeting-bot-row: one
 * endpoint, one event stream per board, injectable for tests, hides itself
 * when there is nothing to show.
 */

import type { User } from '@feedback/core';
import { statusChipLabel } from './link-titles.ts';

export interface PlanTaskEntry {
  id: string;
  title: string;
  status: string;
  assignee: string;
  /** Owner-only enrichment; a share visitor's chip has none of these. */
  workspaceId?: string;
  planHeld?: boolean;
  possiblyStale?: boolean;
}

export interface PlanTasksOpts {
  docId: string;
  root: HTMLElement;
  user: User;
  canWrite: boolean;
  /** Injected so a test drives this without a server or an EventSource. */
  fetchJson?: (url: string, init?: RequestInit) => Promise<unknown>;
  subscribe?: (workspaceId: string, onTaskEvent: () => void) => () => void;
}

export interface PlanTasksHandle {
  destroy(): void;
  /** What is currently rendered. For tests. */
  entries(): PlanTaskEntry[];
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
  // Transitions move chips; creates add them (an agent filing more rows from
  // this doc while it is open should not need a reload to show up).
  es.addEventListener('task.transitioned', onTaskEvent);
  es.addEventListener('task.created', onTaskEvent);
  return () => {
    es.removeEventListener('task.transitioned', onTaskEvent);
    es.removeEventListener('task.created', onTaskEvent);
    es.close();
  };
}

export function mountPlanTasks(opts: PlanTasksOpts): PlanTasksHandle {
  const { docId, root, user, canWrite } = opts;
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const subscribe = opts.subscribe ?? defaultSubscribe;
  const docUrl = `/api/docs/${encodeURIComponent(docId)}`;

  const row = document.createElement('div');
  row.className = 'plan-tasks';
  row.hidden = true;

  const label = document.createElement('span');
  label.className = 'plan-tasks-label';
  const list = document.createElement('span');
  list.className = 'plan-tasks-list';

  const approve = document.createElement('button');
  approve.type = 'button';
  approve.className = 'plan-tasks-approve';
  approve.textContent = 'Approve plan';
  approve.hidden = true;

  const error = document.createElement('span');
  error.className = 'plan-tasks-error';
  // Assertive: only ever appears in answer to a press.
  error.setAttribute('aria-live', 'assertive');

  row.append(label, list, approve, error);
  root.append(row);

  let current: PlanTaskEntry[] = [];
  let state: string | undefined;
  let busy = false;
  let disposed = false;
  const streams = new Map<string, () => void>();

  function chipFor(t: PlanTaskEntry): HTMLElement {
    const chip = document.createElement(t.workspaceId !== undefined ? 'a' : 'span');
    chip.className = 'plan-task-chip';
    if (t.planHeld === true) chip.classList.add('is-draft');
    if (t.possiblyStale === true) chip.classList.add('is-stale');
    if (chip instanceof HTMLAnchorElement && t.workspaceId !== undefined) {
      chip.href = `/workspaces/${encodeURIComponent(t.workspaceId)}?task=${encodeURIComponent(t.id)}`;
    }
    const title = document.createElement('span');
    title.className = 'plan-task-title';
    title.textContent = t.title;
    const status = document.createElement('span');
    status.className = `ws-status-chip ws-chip-${t.status}`;
    // A held draft's honest status is the hold, not "triage" — triage reads
    // as "someone should look", and nobody should until the plan is approved.
    status.textContent = t.planHeld === true ? 'Draft' : statusChipLabel(t.status);
    chip.append(title, status);
    if (t.possiblyStale === true) {
      const stale = document.createElement('span');
      stale.className = 'plan-task-stale';
      stale.textContent = 'plan edited';
      stale.title = 'The doc changed after this task was filed — the body may be out of date.';
      chip.append(stale);
    }
    return chip;
  }

  function render(): void {
    const pending = state === 'pending';
    if (current.length === 0 && !pending) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    label.textContent = pending ? 'Plan drafts' : 'From this doc';
    list.replaceChildren(...current.map(chipFor));
    approve.hidden = !(pending && canWrite);
    approve.disabled = busy;
  }

  /** One stream per board the entries live on; boards that dropped out of
   *  the answer are closed rather than accumulating. */
  function syncStreams(): void {
    const want = new Set(
      current.map((t) => t.workspaceId).filter((w): w is string => w !== undefined),
    );
    for (const [wsId, stop] of streams) {
      if (!want.has(wsId)) {
        stop();
        streams.delete(wsId);
      }
    }
    for (const wsId of want) {
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
        tasks?: PlanTaskEntry[];
      };
      if (disposed) return;
      current = body.tasks ?? [];
      state = body.meta?.planState;
      render();
      syncStreams();
    } catch {
      // A server that cannot answer leaves the strip as it was; the doc
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
    entries: () => current,
    planState: () => state,
    ready,
  };
}
