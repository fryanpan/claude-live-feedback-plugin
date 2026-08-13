/**
 * The workspace hub page (plan §3.9): goal strip → board with goals as
 * sections → decisions strip → docs + open-threads sidebars → presence strip
 * → activity view. The board renders in realtime from the ws:<workspaceId>
 * ydoc projection (server-owned `tasks` / `workspace` Y.Maps); every
 * mutation goes through the REST gate — never by writing into the maps,
 * which the server would revert.
 */
import { type User, connect, escapeHtml } from '@feedback/core';
import { ensureUserIdentity } from '../identity-prompt.ts';
import {
  type ActivityEvent,
  type ActivityFilter,
  type BoardTab,
  DEFAULT_DONE_WINDOW,
  DONE_WINDOWS,
  type DoneWindow,
  type HubGoal,
  type HubTask,
  type HubWorkspaceInfo,
  type PresenceAgent,
  type PresenceChip,
  type PresencePerson,
  boardSections,
  decisionRows,
  nextStatus,
  presenceChips,
} from './hub-model.ts';
import {
  type SidebarDoc,
  type SidebarThread,
  renderActivity,
  renderBoard,
  renderDecisions,
  renderDocsSidebar,
  renderGoalStrip,
  renderPresence,
  renderTaskDetail,
  renderThreadsSidebar,
} from './hub-render.ts';

interface HubState {
  info: HubWorkspaceInfo | null;
  tasks: Map<string, HubTask>;
  tab: BoardTab;
  doneWindow: DoneWindow;
  view: 'board' | 'activity';
  activityFilter: ActivityFilter;
  events: ActivityEvent[];
  agents: PresenceAgent[];
  docs: SidebarDoc[];
  threads: SidebarThread[];
  detailTaskId: string | null;
  followedKey: string | null;
}

function workspaceIdFromPath(): string {
  const m = location.pathname.match(/\/workspaces\/([^/?#]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : '';
}

function wsUrl(docId: string, type: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/y/${encodeURIComponent(docId)}?type=${encodeURIComponent(type)}`;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function send(
  path: string,
  method: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }> {
  try {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string): void {
  const el = document.getElementById('hub-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

/** Static shell — built once; regions re-render into their containers. */
function buildShell(root: HTMLElement, name: string): void {
  root.innerHTML = `
    <header class="hub-topbar">
      <a href="/" class="back-link" title="All workspaces" aria-label="Back">←</a>
      <span class="hub-ws-name">${escapeHtml(name)}</span>
      <button type="button" id="hub-share" class="hub-btn">Share workspace</button>
    </header>
    <div id="hub-presence" class="hub-presence hidden"></div>
    <div id="hub-goal" class="hub-goal"></div>
    <div class="hub-main">
      <aside id="hub-docs" class="hub-side hub-side-docs"></aside>
      <section class="hub-board-col">
        <div class="hub-controls">
          <div class="hub-tabs" role="tablist">
            <button type="button" class="hub-tab" data-tab="all" role="tab">All</button>
            <button type="button" class="hub-tab" data-tab="mine" role="tab">My Tasks</button>
          </div>
          <select id="hub-done-filter" class="hub-select" aria-label="Done task visibility"></select>
          <button type="button" id="hub-view-toggle" class="hub-btn">Activity</button>
        </div>
        <div id="hub-decisions" class="hub-decisions hidden"></div>
        <div id="hub-board" class="hub-board"></div>
        <div id="hub-activity" class="hub-activity hidden"></div>
      </section>
      <aside id="hub-threads" class="hub-side hub-side-threads"></aside>
    </div>
    <div id="hub-detail" class="hub-detail hidden"></div>
    <div id="hub-help" class="hub-help hidden">
      <div class="hub-help-card">
        <h2>Keyboard shortcuts</h2>
        <dl>
          <dt>j / k</dt><dd>next / previous task</dd>
          <dt>o or Enter</dt><dd>open the focused task</dd>
          <dt>s</dt><dd>cycle the focused task's status</dd>
          <dt>?</dt><dd>toggle this help</dd>
        </dl>
      </div>
    </div>
    <div id="hub-toast" class="hub-toast hidden"></div>`;
  const doneSelect = document.getElementById('hub-done-filter') as HTMLSelectElement;
  for (const w of DONE_WINDOWS) {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = w.label;
    doneSelect.append(opt);
  }
  doneSelect.value = DEFAULT_DONE_WINDOW;
}

function docLabelOf(meta: {
  title?: string;
  relPath?: string;
  sourceUrl?: string;
  docId: string;
}): string {
  if (meta.title) return meta.title;
  if (meta.relPath) return meta.relPath;
  if (meta.sourceUrl) return meta.sourceUrl.split('/').pop() ?? meta.docId;
  return meta.docId;
}

function threadLabelOf(t: {
  comments?: Array<{ text?: string }>;
  anchor?: { snippet?: { text?: string } };
}): string {
  const first = t.comments?.[0]?.text?.trim();
  const snippet = t.anchor?.snippet?.text?.trim();
  const label = first || snippet || 'thread';
  return label.length > 80 ? `${label.slice(0, 79)}…` : label;
}

async function main(): Promise<void> {
  const root = document.getElementById('hub-root');
  const workspaceId = workspaceIdFromPath();
  if (!root || !workspaceId) return;

  const user: User = await ensureUserIdentity(new URLSearchParams(location.search).get('as'), {
    get: (k) => localStorage.getItem(k),
    set: (k, v) => localStorage.setItem(k, v),
  });
  const author = { id: user.id, name: user.name, kind: user.kind, color: user.color };

  const state: HubState = {
    info: null,
    tasks: new Map(),
    tab: 'all',
    doneWindow: DEFAULT_DONE_WINDOW,
    view: 'board',
    activityFilter: 'all',
    events: [],
    agents: [],
    docs: [],
    threads: [],
    detailTaskId: null,
    followedKey: null,
  };

  const initial = await fetchJson<{ workspace: HubWorkspaceInfo }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}`,
  );
  if (initial) state.info = initial.workspace;
  buildShell(root, state.info?.name ?? workspaceId);

  const el = (id: string) => document.getElementById(id) as HTMLElement;

  // ── Realtime: the ws:<id> board room ────────────────────────────────────
  const client = connect(wsUrl(`ws:${workspaceId}`, 'workspace'));
  const tasksMap = client.ydoc.getMap('tasks');
  const wsMap = client.ydoc.getMap('workspace');

  function readProjection(): void {
    const next = new Map<string, HubTask>();
    tasksMap.forEach((value, key) => {
      next.set(key, value as unknown as HubTask);
    });
    state.tasks = next;
    if (wsMap.get('id')) {
      state.info = {
        id: String(wsMap.get('id')),
        name: String(wsMap.get('name') ?? workspaceId),
        goal: String(wsMap.get('goal') ?? ''),
        goalUpdatedAt: Number(wsMap.get('goalUpdatedAt') ?? 0),
        goals: (wsMap.get('goals') as HubGoal[] | undefined) ?? [],
        docIds: (wsMap.get('docIds') as string[] | undefined) ?? [],
        createdAt: Number(wsMap.get('createdAt') ?? 0),
      };
    }
  }

  // ── Region renders ──────────────────────────────────────────────────────
  const taskList = () => [...state.tasks.values()];
  const titleOf = (taskId: string) => state.tasks.get(taskId)?.title ?? taskId;

  const boardHandlers = {
    onStatusTap: (task: HubTask) => void transitionTask(task, nextStatus(task.status)),
    onTitleCommit: (task: HubTask, title: string) => void renameTask(task, title),
    onGoalTitleCommit: (sectionId: string, title: string) => void retitleGoal(sectionId, title),
    onOpenTask: (task: HubTask) => {
      state.detailTaskId = task.id;
      renderDetail();
    },
  };

  function renderGoal(): void {
    renderGoalStrip(el('hub-goal'), state.info?.goal ?? '', {
      onGoalCommit: (goal) => void saveGoal(goal),
    });
  }

  function renderBoardRegion(): void {
    const filters = {
      tab: state.tab,
      userName: user.name,
      doneWindow: state.doneWindow,
      now: Date.now(),
    };
    renderBoard(
      el('hub-board'),
      boardSections(state.info?.goals ?? [], taskList(), filters),
      boardHandlers,
    );
    renderDecisions(el('hub-decisions'), decisionRows(taskList()), boardHandlers.onOpenTask);
    for (const btn of document.querySelectorAll<HTMLButtonElement>('.hub-tabs .hub-tab')) {
      btn.classList.toggle('hub-tab-active', btn.dataset.tab === state.tab);
      btn.setAttribute('aria-selected', String(btn.dataset.tab === state.tab));
    }
  }

  function renderActivityRegion(): void {
    const board = el('hub-board');
    const activity = el('hub-activity');
    const toggle = el('hub-view-toggle');
    if (state.view === 'activity') {
      board.classList.add('hidden');
      activity.classList.remove('hidden');
      toggle.textContent = 'Board';
      renderActivity(activity, state.events, state.activityFilter, titleOf, (f) => {
        state.activityFilter = f;
        renderActivityRegion();
      });
    } else {
      board.classList.remove('hidden');
      activity.classList.add('hidden');
      toggle.textContent = 'Activity';
    }
  }

  function renderDetail(): void {
    const task = state.detailTaskId ? (state.tasks.get(state.detailTaskId) ?? null) : null;
    renderTaskDetail(el('hub-detail'), task, {
      onClose: () => {
        state.detailTaskId = null;
        renderDetail();
      },
      onStatusSet: (t, to) => void transitionTask(t, to),
      onTitleCommit: (t, title) => void renameTask(t, title),
      onAnswer: (t, text) => void answerDecision(t, text),
    });
  }

  function peopleFromAwareness(): PresencePerson[] {
    const people: PresencePerson[] = [];
    client.awareness.getStates().forEach((aw, clientId) => {
      const s = aw as {
        user?: { name?: string };
        surface?: string;
        docId?: string;
        lastActive?: number;
      };
      if (!s?.user?.name) return;
      people.push({
        clientId,
        name: s.user.name,
        surface: s.surface ?? 'hub',
        docId: s.docId,
        lastActive: s.lastActive ?? Date.now(),
        self: clientId === client.awareness.clientID,
      });
    });
    return people;
  }

  function renderPresenceRegion(): void {
    const chips = presenceChips(peopleFromAwareness(), state.agents, Date.now());
    renderPresence(el('hub-presence'), chips, state.followedKey, {
      onTap: (chip: PresenceChip) => {
        if (chip.docId) location.assign(`/review/${encodeURIComponent(chip.docId)}`);
      },
      onLongPress: (chip: PresenceChip) => {
        state.followedKey = state.followedKey === chip.key ? null : chip.key;
        showToast(
          state.followedKey
            ? `Following ${chip.label} — long-press again to stop`
            : 'Stopped following',
        );
        renderPresenceRegion();
      },
    });
  }

  function renderAll(): void {
    renderGoal();
    renderBoardRegion();
    renderActivityRegion();
    renderDetail();
    renderPresenceRegion();
    renderDocsSidebar(el('hub-docs'), state.docs);
    renderThreadsSidebar(el('hub-threads'), state.threads);
  }

  // ── Mutations (all through the REST gate) ───────────────────────────────
  async function transitionTask(task: HubTask, to: HubTask['status']): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/transition`, 'POST', {
      to,
      author,
    });
    if (res.status === 409) {
      const blockers = (res.data?.blockers as Array<{ taskId: string; title?: string }>) ?? [];
      const names = blockers.map((b) => b.title ?? b.taskId).join(', ');
      showToast(`Blocked by open dependency: ${names || 'an enforced dependency'}`);
    } else if (!res.ok) {
      showToast('Status change failed');
    } else {
      const unproven = res.data?.unproven;
      if (unproven) showToast('Marked without evidence — attach a commit or thread when you can');
    }
  }

  async function renameTask(task: HubTask, title: string): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/title`, 'POST', {
      title,
      author,
    });
    if (!res.ok) showToast('Rename failed');
  }

  async function retitleGoal(sectionId: string, title: string): Promise<void> {
    const goals = structuredClone(state.info?.goals ?? []);
    let hit = false;
    for (const g of goals) {
      if (g.id === sectionId) {
        g.title = title;
        hit = true;
      }
      for (const sg of g.subgoals ?? []) {
        if (sg.id === sectionId) {
          sg.title = title;
          hit = true;
        }
      }
    }
    if (!hit) return;
    const res = await send(`/api/workspaces/${encodeURIComponent(workspaceId)}/goals`, 'PUT', {
      goals,
      author,
    });
    if (!res.ok) showToast('Goal rename failed');
  }

  async function saveGoal(goal: string): Promise<void> {
    const res = await send(`/api/workspaces/${encodeURIComponent(workspaceId)}/goal`, 'PUT', {
      goal,
      author,
    });
    if (!res.ok) {
      showToast('Goal update failed');
      return;
    }
    const retriage = res.data?.retriage as { requested?: boolean } | undefined;
    showToast(
      retriage?.requested
        ? 'Goal updated — the attached agent will re-triage open tasks'
        : 'Goal updated',
    );
    renderGoal();
  }

  async function answerDecision(task: HubTask, text: string): Promise<void> {
    // Posted with the PERSON's own identity: answer.by shows who decided.
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/answer`, 'POST', {
      text,
      author,
    });
    if (!res.ok) showToast('Recording the answer failed');
  }

  // ── Sidebars ────────────────────────────────────────────────────────────
  async function loadSidebars(): Promise<void> {
    const docIds = state.info?.docIds ?? [];
    const docs: SidebarDoc[] = [];
    const threads: SidebarThread[] = [];
    await Promise.all(
      docIds.map(async (docId) => {
        const meta = await fetchJson<{ meta: Record<string, unknown> }>(
          `/api/docs/${encodeURIComponent(docId)}`,
        );
        if (meta?.meta) {
          docs.push({
            docId,
            label: docLabelOf({ ...(meta.meta as { title?: string }), docId }),
            url: `/review/${encodeURIComponent(docId)}`,
          });
        } else {
          // A legacy grouping id (diff review / folder bind) attached as one
          // unit — no doc room of its own.
          docs.push({ docId, label: docId, url: `/review/${encodeURIComponent(docId)}` });
        }
        const docThreads = await fetchJson<{
          threads: Array<{
            id: string;
            comments?: Array<{ text?: string }>;
            anchor?: { snippet?: { text?: string } };
          }>;
        }>(`/api/docs/${encodeURIComponent(docId)}/threads?status=open`);
        for (const t of docThreads?.threads ?? []) {
          threads.push({
            docId,
            threadId: t.id,
            label: threadLabelOf(t),
            url: `/review/${encodeURIComponent(docId)}`,
            commentCount: t.comments?.length ?? 0,
          });
        }
      }),
    );
    docs.sort((a, b) => a.label.localeCompare(b.label));
    state.docs = docs;
    state.threads = threads;
    renderDocsSidebar(el('hub-docs'), state.docs);
    renderThreadsSidebar(el('hub-threads'), state.threads);
  }

  async function loadAgents(): Promise<void> {
    const res = await fetchJson<{
      attachments: Array<{
        agentId: string;
        state?: PresenceAgent['state'];
        stateLabel?: string;
        lastToolCallAt: number;
      }>;
    }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/attachments`);
    state.agents = (res?.attachments ?? []).map((a) => ({
      agentId: a.agentId,
      state: a.state ?? 'away',
      stateLabel: a.stateLabel ?? a.state ?? 'away',
      lastToolCallAt: a.lastToolCallAt,
    }));
    renderPresenceRegion();
  }

  async function loadEvents(): Promise<void> {
    const res = await fetchJson<{ events: ActivityEvent[] }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/events`,
    );
    state.events = res?.events ?? [];
    if (state.view === 'activity') renderActivityRegion();
  }

  // ── Wiring ──────────────────────────────────────────────────────────────
  tasksMap.observeDeep(() => {
    readProjection();
    renderBoardRegion();
    renderDetail();
  });
  wsMap.observeDeep(() => {
    readProjection();
    renderGoal();
    renderBoardRegion();
    void loadSidebars();
  });

  client.awareness.setLocalState({
    user: { name: user.name, color: user.color },
    surface: 'hub',
    lastActive: Date.now(),
  });
  client.awareness.on('update', () => {
    renderPresenceRegion();
    // Follow (§2.7): when the followed person's surface moves, ours does too.
    if (state.followedKey?.startsWith('p-')) {
      const clientId = Number(state.followedKey.slice(2));
      const aw = client.awareness.getStates().get(clientId) as { docId?: string } | undefined;
      if (aw?.docId) location.assign(`/review/${encodeURIComponent(aw.docId)}`);
    }
  });
  let lastActivePush = 0;
  const touch = () => {
    const now = Date.now();
    if (now - lastActivePush < 30_000) return;
    lastActivePush = now;
    const cur = client.awareness.getLocalState() ?? {};
    client.awareness.setLocalState({ ...cur, lastActive: now });
  };
  window.addEventListener('pointerdown', touch, { passive: true });
  window.addEventListener('keydown', touch, { passive: true });
  const presenceTick = setInterval(() => renderPresenceRegion(), 30_000);
  window.addEventListener('beforeunload', () => {
    clearInterval(presenceTick);
    client.close();
  });

  // SSE: agent presence + activity refresh. Board changes arrive via the
  // ydoc; SSE only nudges the REST-backed regions.
  const es = new EventSource(`/events/workspace/${encodeURIComponent(workspaceId)}`);
  for (const name of ['agent.attached', 'agent.detached', 'agent.heartbeat']) {
    es.addEventListener(name, () => void loadAgents());
  }
  for (const name of [
    'task.created',
    'task.transitioned',
    'task.regrouped',
    'decision.answered',
    'workspace.goal_updated',
    'workspace.goals_changed',
  ]) {
    es.addEventListener(name, () => void loadEvents());
  }

  // Controls.
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.hub-tabs .hub-tab')) {
    btn.addEventListener('click', () => {
      state.tab = (btn.dataset.tab as BoardTab) ?? 'all';
      renderBoardRegion();
    });
  }
  (document.getElementById('hub-done-filter') as HTMLSelectElement).addEventListener(
    'change',
    (ev) => {
      state.doneWindow = (ev.target as HTMLSelectElement).value as DoneWindow;
      renderBoardRegion();
    },
  );
  el('hub-view-toggle').addEventListener('click', () => {
    state.view = state.view === 'board' ? 'activity' : 'board';
    if (state.view === 'activity') void loadEvents();
    renderActivityRegion();
  });
  el('hub-share').addEventListener('click', () => {
    void navigator.clipboard?.writeText(location.href).then(
      () => showToast('Workspace URL copied'),
      () => showToast(location.href),
    );
  });

  // Gmail-style shortcuts (§3.9): j/k walk rows, o/Enter opens, s cycles
  // status, ? shows help. Never while typing.
  document.addEventListener('keydown', (ev) => {
    const target = ev.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable]')) return;
    if (ev.key === '?') {
      el('hub-help').classList.toggle('hidden');
      return;
    }
    if (ev.key === 'Escape') {
      el('hub-help').classList.add('hidden');
      if (state.detailTaskId) {
        state.detailTaskId = null;
        renderDetail();
      }
      return;
    }
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.hub-task-row'));
    if (rows.length === 0) return;
    const focusedIdx = rows.findIndex((r) => r === document.activeElement);
    if (ev.key === 'j' || ev.key === 'k') {
      const next =
        ev.key === 'j' ? Math.min(rows.length - 1, focusedIdx + 1) : Math.max(0, focusedIdx - 1);
      rows[next]?.focus();
      ev.preventDefault();
    } else if ((ev.key === 'o' || ev.key === 's') && focusedIdx >= 0) {
      const taskId = rows[focusedIdx]?.dataset.taskId;
      const task = taskId ? state.tasks.get(taskId) : undefined;
      if (!task) return;
      if (ev.key === 'o') {
        state.detailTaskId = task.id;
        renderDetail();
      } else {
        void transitionTask(task, nextStatus(task.status));
      }
      ev.preventDefault();
    }
  });

  // First paint from REST (the ydoc syncs in behind it), then the
  // REST-backed regions.
  readProjection();
  renderAll();
  void loadSidebars();
  void loadAgents();
  void loadEvents();
}

void main();
