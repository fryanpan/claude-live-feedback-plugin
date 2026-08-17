/**
 * The workspace hub page (plan §3.9): goal strip → board with goals as
 * sections → decisions strip → docs + open-threads sidebars → presence strip
 * → activity view. The board renders in realtime from the ws:<workspaceId>
 * ydoc projection (server-owned `tasks` / `workspace` Y.Maps); every
 * mutation goes through the REST gate — never by writing into the maps,
 * which the server would revert.
 */
import { type User, connect, escapeHtml } from '@feedback/core';
import type { StoredGoalSummary } from '@feedback/core/goal-summary';
import { renderConnectionBanner, watchConnection } from '../connection-state.ts';
import { ensureUserIdentity } from '../identity-prompt.ts';
import { eventPath, typingInPath } from '../keyboard-target.ts';
import { installStaleClientNotice } from '../stale-client.ts';
import { type VoiceAck, createVoiceCapture } from '../voice-capture.ts';
import {
  type ActivityEvent,
  type ActivityFilter,
  type BoardTab,
  type ClientRelease,
  DEFAULT_DONE_WINDOW,
  DONE_WINDOWS,
  type DoneWindow,
  type HubGoal,
  type HubTask,
  type HubWorkspaceInfo,
  type PendingRetriageView,
  type PluginRelease,
  type PresenceAgent,
  type PresenceChip,
  type PresencePerson,
  type ReorderTarget,
  type ReviewItem,
  type ReviewThreadItem,
  type UptimeReport,
  applyRefresh,
  boardSections,
  clientDriftNotice,
  goalLabel,
  parseQuickAdd,
  pluginDriftNotice,
  presenceChips,
  refreshReviewItems,
  reviewQueue,
  reviewRow,
} from './hub-model.ts';
import {
  type SidebarDoc,
  type SidebarThread,
  type TaskDiscussion,
  type TaskThread,
  discussionIsBusy,
  renderActivity,
  renderBoard,
  renderDocsSidebar,
  renderGoalStrip,
  renderLeadStrip,
  renderPresence,
  renderQuickAdd,
  renderReviewStrip,
  renderReviewWalkthrough,
  renderTaskDetail,
  renderThreadsSidebar,
} from './hub-render.ts';
import { sidebarEntriesFor } from './hub-sidebar.ts';

interface HubState {
  info: HubWorkspaceInfo | null;
  tasks: Map<string, HubTask>;
  tab: BoardTab;
  doneWindow: DoneWindow;
  view: 'board' | 'activity';
  activityFilter: ActivityFilter;
  events: ActivityEvent[];
  /** Deploy readiness (§3.12 commit 11) — null until the log has lines. */
  uptime: UptimeReport | null;
  agents: PresenceAgent[];
  /** Plugin versions: what the deploy source would install, and which
   *  attached sessions are running something older. Null until the first
   *  attachments read lands. */
  pluginRelease: PluginRelease | null;
  /** What the browser itself is running, and whether this deployment could
   *  not replace it. Null on any server that publishes no client release
   *  (dev, staging) — those must not report the prod machine's deploy. */
  clientRelease: ClientRelease | null;
  docs: SidebarDoc[];
  threads: SidebarThread[];
  detailTaskId: string | null;
  /** The thread the review queue aimed at, when the panel was opened from it.
   *  Null every other way in. */
  detailThreadId: string | null;
  /**
   * The open task's discussion, and the id it was fetched FOR. Keyed rather
   * than just held, because a load that lands after the reader has moved to
   * another task would otherwise show them someone else's argument.
   */
  discussion: TaskDiscussion;
  discussionTaskId: string | null;
  /**
   * The thread-shaped half of "what needs you" — task discussions and doc
   * comments whose newest word is an agent's. Server-computed, because
   * whether a comment is an agent's is `classifyActor`'s call and there must
   * not be a second one. Decisions are derived from `tasks` here.
   */
  reviewItems: ReviewThreadItem[];
  /** Position in the review walkthrough; -1 when it is closed. */
  walkIndex: number;
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
    <div id="hub-connection" class="conn-banner hidden" role="status" aria-live="polite"></div>
    <div id="hub-presence" class="hub-presence hidden"></div>
    <div id="hub-lead" class="hub-lead"></div>
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
        <div id="hub-quick" class="hub-quick"></div>
        <div id="hub-board" class="hub-board"></div>
        <div id="hub-activity" class="hub-activity hidden"></div>
      </section>
      <aside id="hub-threads" class="hub-side hub-side-threads"></aside>
    </div>
    <div id="hub-detail" class="hub-detail hidden"></div>
    <div id="hub-walkthrough" class="hub-walkthrough hidden"></div>
    <div id="hub-help" class="hub-help hidden">
      <div class="hub-help-card">
        <h2>Keyboard shortcuts</h2>
        <dl>
          <dt>j / k</dt><dd>next / previous task</dd>
          <dt>o or Enter</dt><dd>open the focused task</dd>
          <dt>s</dt><dd>open the focused task's status dropdown</dd>
          <dt>a</dt><dd>open the focused task's assignee picker</dd>
          <dt>alt + ↑ / ↓</dt><dd>move the focused task up / down — past the ends of its goal it moves into the next one</dd>
          <dt>tab to ⠿, then ↑ / ↓</dt><dd>the same move from the drag handle</dd>
          <dt>c</dt><dd>capture a task — type it however you like, Enter files it</dd>
          <dt>?</dt><dd>toggle this help</dd>
        </dl>
      </div>
    </div>
    <div id="hub-toast" class="hub-toast hidden"></div>
    <button type="button" id="hub-mic" class="voice-mic" title="Hold to talk (or hold Space)" aria-label="Hold to talk">🎙</button>
    <div id="hub-voice" class="voice-indicator hidden" aria-live="polite"></div>`;
  const doneSelect = document.getElementById('hub-done-filter') as HTMLSelectElement;
  for (const w of DONE_WINDOWS) {
    const opt = document.createElement('option');
    opt.value = w.id;
    opt.textContent = w.label;
    doneSelect.append(opt);
  }
  doneSelect.value = DEFAULT_DONE_WINDOW;
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
    uptime: null,
    agents: [],
    pluginRelease: null,
    clientRelease: null,
    docs: [],
    threads: [],
    detailTaskId: null,
    detailThreadId: null,
    discussion: { loading: false, threads: [] },
    discussionTaskId: null,
    reviewItems: [],
    walkIndex: -1,
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
  installStaleClientNotice(client);
  // The board had no reading of its own connection at all, in any viewport —
  // during a restart it just stopped updating. Wired here rather than in
  // renderAll: this subscribes once, to THIS client, and the banner it drives
  // is not a projection of board state.
  watchConnection({
    onStatus: (cb) => client.onStatus(cb),
    onView: (view) => renderConnectionBanner(document.getElementById('hub-connection'), view),
  });
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
        ...(wsMap.get('goalSummary')
          ? { goalSummary: wsMap.get('goalSummary') as StoredGoalSummary }
          : {}),
        goals: (wsMap.get('goals') as HubGoal[] | undefined) ?? [],
        docIds: (wsMap.get('docIds') as string[] | undefined) ?? [],
        ...(wsMap.get('leadAgentId') ? { leadAgentId: String(wsMap.get('leadAgentId')) } : {}),
        ...(wsMap.get('pendingRetriage')
          ? { pendingRetriage: wsMap.get('pendingRetriage') as PendingRetriageView }
          : {}),
        createdAt: Number(wsMap.get('createdAt') ?? 0),
      };
    }
  }

  // ── Region renders ──────────────────────────────────────────────────────
  const taskList = () => [...state.tasks.values()];
  const titleOf = (taskId: string) => state.tasks.get(taskId)?.title ?? taskId;

  const boardHandlers = {
    onStatusSet: (task: HubTask, to: HubTask['status']) => void transitionTask(task, to),
    onGoalTitleCommit: (sectionId: string, title: string) => void retitleGoal(sectionId, title),
    onOpenTask: (task: HubTask) => {
      state.detailTaskId = task.id;
      // Opening the task any other way clears the queue's aim, so a mark left
      // over from the last walkthrough item can't point at the wrong thread.
      state.detailThreadId = null;
      renderDetail();
    },
    onReorder: (task: HubTask, target: ReorderTarget) => void placeTask(task, target),
    onTitleCommit: (task: HubTask, title: string) => void renameTask(task, title),
    onAssign: (task: HubTask, assignee: string) => void assignTask(task, assignee),
  };

  /** Re-derived on every render rather than stored: the decision half comes
   *  from the live projection, so an answer anyone posts drops its item out
   *  without a fetch. */
  const currentQueue = () => reviewQueue(taskList(), state.reviewItems, Date.now());

  /**
   * "Exactly the place where I need to review and make the choice" — the
   * whole point of the queue. A decision opens its task panel; a task comment
   * opens that task's discussion; a doc comment opens the doc AT the comment
   * (`?thread=`), not the doc's top.
   */
  function openReviewItem(item: ReviewItem): void {
    // A decision and a human-owned blocker are both a task — `reviewRow` is
    // the one reader for "which task is this row about", so a new band cannot
    // land in the strip with a chip that taps into nothing.
    const row = reviewRow(item);
    if (row) {
      boardHandlers.onOpenTask(row.task);
      return;
    }
    const t = item.thread;
    if (!t) return;
    if (t.kind === 'task-thread') {
      const task = t.taskId ? state.tasks.get(t.taskId) : undefined;
      if (!task) return;
      boardHandlers.onOpenTask(task);
      // The task is the container; the thread is the errand. On a task with
      // six discussions, landing on the panel top is the same "now go find
      // it" the strip exists to remove — so aim at the one that was queued.
      state.detailThreadId = t.threadId;
      renderDetail();
      return;
    }
    location.assign(
      `/review/${encodeURIComponent(t.docId)}?thread=${encodeURIComponent(t.threadId)}`,
    );
  }

  /** Everyone a task can be handed to besides a person: the agents attached
   *  to this workspace, plus the lead (who owns goal changes here and is
   *  therefore somebody, whether or not their session is currently up). */
  function knownAgentIds(): string[] {
    const lead = state.info?.leadAgentId;
    return [...new Set([...state.agents.map((a) => a.agentId), ...(lead ? [lead] : [])])];
  }

  function renderGoal(): void {
    renderGoalStrip(
      el('hub-goal'),
      state.info?.goal ?? '',
      { onGoalCommit: (goal, summary) => void saveGoal(goal, summary) },
      state.info?.goalSummary,
    );
  }

  function renderLead(): void {
    renderLeadStrip(
      el('hub-lead'),
      state.info?.leadAgentId,
      state.agents.map((agent) => agent.agentId),
      { onLeadCommit: (leadAgentId) => void saveLead(leadAgentId) },
      state.info?.pendingRetriage,
    );
  }

  function renderBoardRegion(): void {
    const filters = {
      tab: state.tab,
      userName: user.name,
      doneWindow: state.doneWindow,
      now: Date.now(),
    };
    // Every render replaces the rows, so whatever had focus is destroyed with
    // them. That is fatal to keyboard reordering specifically: the move
    // re-renders the board, and without this the second Alt+Arrow has nothing
    // to act on — the shortcut works exactly once and then silently stops.
    const active = document.activeElement as HTMLElement | null;
    const focusedRow = active?.closest?.('.hub-task-row') as HTMLElement | null;
    const focusedTaskId = focusedRow?.dataset.taskId;
    const focusedHandle = active?.classList.contains('hub-drag-handle') ?? false;
    renderBoard(
      el('hub-board'),
      boardSections(state.info?.goals ?? [], taskList(), filters),
      // Read at render time, not once at wiring time: attachments arrive
      // after the first paint and change while the board is open, and a
      // picker built from a stale list offers agents who have left.
      { ...boardHandlers, knownAgentIds: knownAgentIds() },
    );
    if (focusedTaskId) {
      // By scan, not by attribute selector: a task id is server-generated but
      // it is still untrusted text to a selector parser, and CSS.escape is
      // one more thing to be missing.
      const row = Array.from(document.querySelectorAll<HTMLElement>('.hub-task-row')).find(
        (r) => r.dataset.taskId === focusedTaskId,
      );
      const back = focusedHandle
        ? (row?.querySelector<HTMLElement>('.hub-drag-handle') ?? row)
        : row;
      back?.focus();
    }
    renderReviewStrip(el('hub-decisions'), currentQueue(), {
      onOpen: openReviewItem,
      onWalkthrough: () => {
        state.walkIndex = 0;
        renderWalkthrough();
      },
    });
    renderWalkthrough();
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
      renderActivity(
        activity,
        state.events,
        state.activityFilter,
        titleOf,
        (f) => {
          state.activityFilter = f;
          renderActivityRegion();
        },
        state.uptime,
      );
    } else {
      board.classList.remove('hidden');
      activity.classList.add('hidden');
      toggle.textContent = 'Activity';
    }
  }

  function renderDetail(): void {
    const task = state.detailTaskId ? (state.tasks.get(state.detailTaskId) ?? null) : null;
    // Fetch here rather than at each of the four places that open the panel
    // (row tap, `o`, deep link, voice navigate) — one of them would be missed
    // otherwise, and the miss looks like a task with no discussion. Safe from
    // recursion: loadDiscussion claims the id before it re-renders.
    if (task && state.discussionTaskId !== task.id) void loadDiscussion(task);
    if (!task) state.discussionTaskId = null;
    // Only pass a discussion that belongs to the task on screen. An in-flight
    // load for a task the reader has left must not paint under this one.
    const discussion =
      task && state.discussionTaskId === task.id
        ? state.discussion
        : { loading: true, threads: [] };
    renderTaskDetail(
      el('hub-detail'),
      task,
      {
        onClose: () => {
          state.detailTaskId = null;
          state.detailThreadId = null;
          renderDetail();
        },
        onStatusSet: (t, to) => void transitionTask(t, to),
        onTitleCommit: (t, title) => void renameTask(t, title),
        onAnswer: (t, text) => void answerDecision(t, text),
        onAssign: (t, assignee) => void assignTask(t, assignee),
        knownAgentIds: knownAgentIds(),
        goalLabel: (id) => goalLabel(state.info?.goals ?? [], id),
        onComment: (t, text, threadId) => postTaskComment(t, text, threadId),
        ...(state.detailThreadId ? { focusThreadId: state.detailThreadId } : {}),
      },
      task ? discussion : undefined,
    );
  }

  // ── Task discussion ─────────────────────────────────────────────────────

  /**
   * A task's comments live in its body doc (`task:<taskId>`), so this is the
   * ordinary thread API pointed at the task room — no second store, and the
   * same threads an agent sees through `create_thread`.
   */
  async function loadDiscussion(task: HubTask, quiet = false): Promise<void> {
    state.discussionTaskId = task.id;
    if (!quiet) {
      // A quiet reload is a refresh of something already on screen; flipping
      // it to "Loading…" would blank a discussion the reader is reading.
      state.discussion = { loading: true, threads: [] };
      renderDetail();
    }
    const payload = await fetchJson<{
      threads?: Array<{
        id: string;
        status?: string;
        comments?: Array<{ author?: { name?: string }; text?: string; ts?: number }>;
      }>;
    }>(`/api/docs/${encodeURIComponent(task.bodyDocId)}/threads`);
    // The reader may have moved on while this was in flight.
    if (state.discussionTaskId !== task.id) return;
    const threads: TaskThread[] = (payload?.threads ?? []).map((t) => ({
      id: t.id,
      status: t.status === 'resolved' ? 'resolved' : 'open',
      comments: (t.comments ?? []).map((c) => ({
        author: c.author?.name ?? 'Someone',
        text: c.text ?? '',
        ts: c.ts ?? Date.now(),
      })),
    }));
    state.discussion = { loading: false, threads };
    renderDetail();
  }

  /** Resolves to whether the comment actually landed — the composer keeps the
   *  text until it hears yes, so a failed post is retryable. */
  async function postTaskComment(task: HubTask, text: string, threadId?: string): Promise<boolean> {
    const doc = encodeURIComponent(task.bodyDocId);
    const res = threadId
      ? await send(`/api/docs/${doc}/threads/${encodeURIComponent(threadId)}/comments`, 'POST', {
          author,
          text,
        })
      : // No anchor to point at — the comment is about the task itself, which
        // is what a subject anchor means. A task's description is often empty,
        // so there is frequently nothing in it to point at at all.
        await send(`/api/docs/${doc}/threads`, 'POST', {
          author,
          text,
          anchor: { kind: 'subject' },
        });
    if (!res.ok) {
      showToast('Posting the comment failed — your text is still in the box');
      return false;
    }
    await loadDiscussion(task);
    return true;
  }

  /**
   * The walkthrough re-derives its queue from the live projection on every
   * render, and the position is an INDEX into that queue rather than a task
   * id. So answering the card you're on drops it out of the queue and the
   * same index lands on the next one — six answers without six navigations —
   * and a decision another peer answers while you sit here simply isn't
   * offered to you.
   */
  function renderWalkthrough(): void {
    renderReviewWalkthrough(el('hub-walkthrough'), currentQueue(), state.walkIndex, {
      onAnswer: (t, text, optionId) => void answerDecision(t, text, optionId),
      onMoreInfo: (t, question) => void requestMoreInfo(t, question),
      onReply: (item, text) => void replyToReviewItem(item, text),
      onOpenItem: (item) => {
        state.walkIndex = -1;
        renderWalkthrough();
        openReviewItem(item);
      },
      onStep: (i) => {
        state.walkIndex = Math.max(0, i);
        renderWalkthrough();
      },
      onClose: () => {
        state.walkIndex = -1;
        renderWalkthrough();
      },
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
    renderPresence(
      el('hub-presence'),
      chips,
      state.followedKey,
      {
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
      },
      [pluginDriftNotice(state.pluginRelease), clientDriftNotice(state.clientRelease, Date.now())],
    );
  }

  function renderAll(): void {
    // Mounted, not rendered: `renderQuickAdd` is a no-op after the first call
    // so a board repaint can never take the caret out of a half-typed idea.
    renderQuickAdd(el('hub-quick'), {
      onCapture: (text, quote) => captureTask(text, quote),
      // Dictation FILLS the box; it never files. The board-wide dock routes an
      // utterance to the agent, which is right when you're talking to it and
      // wrong when you're capturing — a misheard task filed silently costs
      // more than one tap on Add. `spaceHotkey: false` because the dock owns
      // Space: two captures on one press would both record and both finalize.
      mountVoice: ({ button, indicator, deliver }) =>
        void createVoiceCapture({
          button,
          indicator,
          spaceHotkey: false,
          getContext: () => ({ surface: 'hub' }),
          send: async (transcript) => {
            deliver(transcript);
            // Not "Added": nothing has been filed yet. The words are in the
            // box and stay there until a tap, which is the entire point of
            // dictating into capture rather than at the agent.
            return { route: 'capture', ack: 'In the box — edit, then tap Add' };
          },
        }),
    });
    renderGoal();
    renderLead();
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
      // Not a dead end any more: the mark clears when evidence is attached
      // afterwards, so the toast says the move is still open to proof.
      if (unproven) showToast('Marked without evidence — a commit or thread can still be attached');
    }
  }

  async function assignTask(task: HubTask, assignee: string): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/assignee`, 'POST', {
      assignee,
      author,
    });
    if (!res.ok) showToast('Assignment failed');
  }

  /**
   * A drag or an arrow-key move, sent as the placement it already is: goal +
   * fractional position, the same `set_task_goal` write an agent performs.
   * There is deliberately no reordering API of its own — `task.order` has
   * always been fractional, so "between these two rows" is a number, and a
   * cross-goal drop is this same call with a different goal.
   */
  async function placeTask(task: HubTask, target: ReorderTarget): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/goal`, 'POST', {
      goal: target.goal,
      position: target.position,
      author,
    });
    if (!res.ok) showToast('Move failed');
  }

  async function renameTask(task: HubTask, title: string): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/title`, 'POST', {
      title,
      author,
    });
    if (!res.ok) showToast('Rename failed');
  }

  /**
   * Retitle one band. This used to clone the client's copy of the goal list,
   * edit one title in it, and PUT the whole thing back — which is a full
   * REPLACE keyed by id built from a read that may be minutes old. A band
   * another writer added in between was simply absent from the clone, so the
   * replace removed it: its open tasks to Chores, its done tasks orphaned.
   * The rename route touches one row by id and cannot move a task, so the
   * stale copy stops being able to do damage at all.
   */
  async function retitleGoal(sectionId: string, title: string): Promise<void> {
    const res = await send(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/goals/rename`,
      'POST',
      { goal: sectionId, title, author },
    );
    if (!res.ok) showToast('Goal rename failed');
  }

  async function saveGoal(goal: string, summary: string): Promise<void> {
    const res = await send(`/api/workspaces/${encodeURIComponent(workspaceId)}/goal`, 'PUT', {
      goal,
      // Always sent, including empty — clearing the short line is how a
      // reviewer goes back to the deterministic clip, and an omitted field
      // would silently mean "keep whatever was there".
      summary,
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

  async function saveLead(leadAgentId: string): Promise<void> {
    const res = await send(`/api/workspaces/${encodeURIComponent(workspaceId)}/lead`, 'PUT', {
      leadAgentId,
      author,
    });
    if (!res.ok) {
      showToast('Lead agent update failed');
      renderLead();
      return;
    }
    showToast(`${leadAgentId} now leads this workspace`);
    // The projection carries the new lead back through wsMap; render now so
    // the strip does not sit on the old value until that round-trips.
    if (state.info) state.info = { ...state.info, leadAgentId };
    renderLead();
  }

  async function answerDecision(task: HubTask, text: string, optionId?: string): Promise<void> {
    // Posted with the PERSON's own identity: answer.by shows who decided.
    // `text` is always the verbatim answer — tapping an option sends the
    // option's label as the answer and its id alongside, so nothing about the
    // recorded answer depends on the option list still existing later.
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/answer`, 'POST', {
      text,
      ...(optionId ? { optionId } : {}),
      author,
    });
    if (!res.ok) showToast('Recording the answer failed');
  }

  /** "I can't answer this yet" — the decision stays open and unanswered. */
  async function requestMoreInfo(task: HubTask, question: string): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/more-info`, 'POST', {
      question,
      author,
    });
    showToast(
      res.ok ? 'Asked — it stays open until you have the answer' : 'Sending the question failed',
    );
  }

  /**
   * Answer a queued comment from the queue itself. The reply is an ordinary
   * thread comment — the same POST the doc and the task panel use — which is
   * what takes the item OUT of the queue: `awaitingPerson` reports a thread
   * only while an agent spoke last, so there is no separate dismissed flag to
   * write and none to keep in sync.
   */
  async function replyToReviewItem(item: ReviewItem, text: string): Promise<void> {
    const t = item.thread;
    if (!t) return;
    const res = await send(
      `/api/docs/${encodeURIComponent(t.docId)}/threads/${encodeURIComponent(t.threadId)}/comments`,
      'POST',
      { author, text },
    );
    if (!res.ok) {
      showToast('Posting the reply failed — your text is still in the box');
      return;
    }
    // Refresh BEFORE re-rendering: the walkthrough steps by position, so the
    // answered item has to be gone from the queue for the same index to land
    // on the next thing rather than re-showing the one just answered.
    await loadReviewItems();
  }

  /**
   * File a captured line as a task.
   *
   * It lands in TRIAGE — `goal` is deliberately omitted, which is what routes
   * it there — because ranking an idea against the goals it competes with is
   * exactly the judgement capture must not force at capture time.
   *
   * It is assigned to the workspace's lead agent when there is one, falling
   * back to the person capturing. Reversible either way (one dropdown on the
   * row), and this is the direction Bryan asked for: "mostly by just
   * discussing it with you" — an idea he captures is one he wants picked up,
   * not one he means to file to himself and never see again.
   */
  async function captureTask(text: string, quote?: string): Promise<boolean> {
    const parsed = parseQuickAdd(text);
    if (!parsed) return false;
    const res = await send(`/api/workspaces/${encodeURIComponent(workspaceId)}/tasks`, 'POST', {
      title: parsed.title,
      ...(parsed.body !== undefined ? { body: parsed.body } : {}),
      // What was actually said, when any of it was dictated. Kept verbatim so
      // a misheard word corrected in the box doesn't cost the agent the
      // phrasing it was corrected from.
      ...(quote !== undefined ? { quote } : {}),
      ...(state.info?.leadAgentId ? { assignee: state.info.leadAgentId } : {}),
      author,
    });
    if (!res.ok) {
      const why = typeof res.data?.message === 'string' ? res.data.message : 'Capture failed';
      showToast(why);
      // False, so the box KEEPS the words. A toast the reader may have already
      // scrolled past is not a copy of their idea.
      return false;
    }
    // The row itself arrives over the ydoc; the toast is the receipt for the
    // words that just left the box.
    showToast(`Captured — “${parsed.title}” is in triage`);
    return true;
  }

  async function loadReviewItems(): Promise<void> {
    await refreshReviewItems(state, () =>
      fetchJson<{ items: ReviewThreadItem[] }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/review-items`,
      ),
    );
    renderBoardRegion();
  }

  // ── Sidebars ────────────────────────────────────────────────────────────
  async function loadSidebars(): Promise<void> {
    const docIds = state.info?.docIds ?? [];
    const docs: SidebarDoc[] = [];
    const threads: SidebarThread[] = [];
    const entries = await Promise.all(
      docIds.map((docId) => sidebarEntriesFor(docId, (url) => fetchJson(url))),
    );
    for (const entry of entries) {
      docs.push(...entry.docs);
      threads.push(...entry.threads);
    }
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
      pluginRelease?: PluginRelease;
      clientRelease?: ClientRelease;
    }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/attachments`);
    const before = knownAgentIds().join('\n');
    // Which sessions can't run what was merged. Rides the read the board
    // already makes, so nobody has to think to check.
    // Same guard as the review strip: a refresh that never reached the server
    // must not empty the presence row. During a restart every session looks
    // detached for as long as the fetch keeps failing, which reads as the
    // fleet going down rather than the server coming back.
    state.pluginRelease = applyRefresh(state.pluginRelease, res, (r) => r.pluginRelease ?? null);
    // …and which client every browser here is running. A failed build keeps
    // the previous release live, which is right — but it announced itself
    // only on the supervisor's stderr, so the split widened unread. Guarded
    // the same way: an unreachable server must not read as "no release".
    state.clientRelease = applyRefresh(state.clientRelease, res, (r) => r.clientRelease ?? null);
    state.agents = applyRefresh(state.agents, res, (r) =>
      (r.attachments ?? []).map((a) => ({
        agentId: a.agentId,
        state: a.state ?? 'away',
        stateLabel: a.stateLabel ?? a.state ?? 'away',
        lastToolCallAt: a.lastToolCallAt,
      })),
    );
    renderPresenceRegion();
    // The picker's options come from the attachment list, so a fresh list is
    // also a fresh set of agents to hand the board to.
    renderLead();
    // …and the board and the open task render their pickers from a snapshot
    // taken when they last painted. This load is the ONLY thing that changes
    // that list: the first one lands after the first paint, so without this
    // the very first board offers nobody but 'human' until an unrelated task
    // update happens to repaint it. Guarded on the SET rather than fired on
    // every load, because `agent.heartbeat` arrives constantly and a board
    // re-render would close a picker somebody is reading.
    if (knownAgentIds().join('\n') !== before) {
      renderBoardRegion();
      renderDetail();
    }
  }

  async function loadEvents(): Promise<void> {
    const res = await fetchJson<{ events: ActivityEvent[]; uptime: UptimeReport | null }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/events`,
    );
    state.events = applyRefresh(state.events, res, (r) => r.events ?? []);
    state.uptime = applyRefresh(state.uptime, res, (r) => r.uptime ?? null);
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
    renderLead();
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
    'task.evidence_amended',
    'task.regrouped',
    'decision.answered',
    'decision.info_requested',
    'workspace.goal_updated',
    'workspace.goals_changed',
  ]) {
    es.addEventListener(name, () => void loadEvents());
  }
  // A reply to the question you just asked is the case this whole surface is
  // for, so it lands in the open panel without a reload. These events reach
  // the workspace channel only because a task body room fans out to it — the
  // board is not subscribed to each task's own doc stream.
  for (const name of ['thread.created', 'thread.replied', 'thread.resolved', 'thread.reopened']) {
    es.addEventListener(name, () => {
      // Every one of these can change what is waiting on a person — a new
      // question arrives, someone answers one, a thread is closed. The strip
      // is the surface that has to be right when Bryan comes back, so it
      // refreshes whether or not a task panel happens to be open.
      void loadReviewItems();
      const open = state.detailTaskId ? state.tasks.get(state.detailTaskId) : undefined;
      if (!open || discussionIsBusy(document)) return;
      void loadDiscussion(open, true);
    });
  }
  // A task going done takes its discussion out of the queue.
  es.addEventListener('task.transitioned', () => void loadReviewItems());

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

  // Voice (§2.4/§3.8): hold Space or the mic button; the context object sent
  // with each utterance anchors it to wherever the speaker is NOW — the hub
  // board, or the open task detail. Every utterance gets an explicit ack.
  createVoiceCapture({
    button: el('hub-mic'),
    indicator: el('hub-voice'),
    getContext: () =>
      state.detailTaskId ? { surface: 'task', taskId: state.detailTaskId } : { surface: 'hub' },
    send: async (transcript, context) => {
      const res = await send(`/api/workspaces/${encodeURIComponent(workspaceId)}/voice`, 'POST', {
        transcript,
        context,
        author,
      });
      return res.ok && res.data ? (res.data as unknown as VoiceAck) : null;
    },
    onNavigate: (u) => {
      // A task lookup on this same hub opens the detail in place — the
      // session survives navigation (§3.8); everything else is a page move.
      const url = new URL(u, location.origin);
      const taskParam = url.searchParams.get('task');
      if (taskParam && url.pathname === location.pathname) {
        state.detailTaskId = taskParam;
        renderDetail();
      } else {
        location.assign(u);
      }
    },
  });

  // Gmail-style shortcuts (§3.9): j/k walk rows, o/Enter opens, s opens the
  // status dropdown, ? shows help. Never while typing — including while typing
  // inside an embedded component's shadow root, which `ev.target` cannot see
  // (see hotkeysBlocked).
  document.addEventListener('keydown', (ev) => {
    if (typingInPath(eventPath(ev))) return;
    if (ev.key === '?') {
      el('hub-help').classList.toggle('hidden');
      return;
    }
    // Gmail's compose key. Before the row shortcuts, and before the
    // rows-are-empty bail below it — capture has to work on a board with
    // nothing on it, which is exactly when it is needed most.
    if (ev.key === 'c') {
      const box = document.querySelector<HTMLTextAreaElement>('.hub-quick-input');
      if (box) {
        box.focus();
        ev.preventDefault();
      }
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
    } else if ((ev.key === 'o' || ev.key === 's' || ev.key === 'a') && focusedIdx >= 0) {
      const taskId = rows[focusedIdx]?.dataset.taskId;
      const task = taskId ? state.tasks.get(taskId) : undefined;
      if (!task) return;
      if (ev.key === 'o') {
        state.detailTaskId = task.id;
        renderDetail();
      } else if (ev.key === 'a') {
        // Focus the picker rather than choosing for them — for the same
        // reason `s` does below, and because there is no longer an "other
        // end" to flip to: a workspace can hold any number of agents.
        rows[focusedIdx]?.querySelector<HTMLSelectElement>('.hub-row-assignee')?.focus();
      } else {
        // Focus the row's dropdown rather than picking a status for them —
        // the keyboard path must not re-introduce the linear assumption the
        // dropdown exists to remove.
        rows[focusedIdx]?.querySelector<HTMLSelectElement>('.hub-status-select')?.focus();
      }
      ev.preventDefault();
    }
  });

  // Deep link: /workspaces/<id>?task=<taskId> opens the detail on load —
  // this is also how the voice fast path lands a task lookup from another
  // surface.
  const deepLinkTask = new URLSearchParams(location.search).get('task');
  if (deepLinkTask) state.detailTaskId = deepLinkTask;

  // First paint from REST (the ydoc syncs in behind it), then the
  // REST-backed regions.
  readProjection();
  renderAll();
  void loadSidebars();
  void loadAgents();
  void loadEvents();
  void loadReviewItems();
}

void main();
