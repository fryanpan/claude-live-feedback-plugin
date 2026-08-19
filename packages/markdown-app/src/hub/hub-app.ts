/**
 * The workspace hub page (plan §3.9): goal strip → board with goals as
 * sections → decisions strip → docs + open-threads sidebars → presence strip
 * → activity view. The board renders in realtime from the ws:<workspaceId>
 * ydoc projection (server-owned `tasks` / `workspace` Y.Maps); every
 * mutation goes through the REST gate — never by writing into the maps,
 * which the server would revert.
 */
import { type ReviewPayload, type User, connect, escapeHtml } from '@feedback/core';
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
  type DriftNotice,
  type HomePayload,
  type HubGoal,
  type HubNav,
  type HubPane,
  type HubTask,
  type HubWorkspaceInfo,
  type PendingBucketReviewView,
  type PendingRetriageView,
  type PluginRelease,
  type PresenceAgent,
  type PresenceChip,
  type PresencePerson,
  type ReorderTarget,
  type ReviewItem,
  type ReviewThreadItem,
  type UptimeReport,
  advanceWalk,
  applyRefresh,
  boardSections,
  clientDriftNotice,
  goalLabel,
  initialsOf,
  navFromPath,
  navPath,
  paneForNav,
  parseQuickAdd,
  pluginDriftNotice,
  presenceChips,
  refreshReviewItems,
  reviewQueue,
  reviewRow,
  shouldPollHome,
  tabForNav,
  unplacedNotice,
  walkPosition,
} from './hub-model.ts';
import {
  type TaskDiscussion,
  type TaskThread,
  type WalkProgress,
  discussionIsBusy,
  renderActivity,
  renderBoard,
  renderGoalStrip,
  renderHomeBrief,
  renderHomeReview,
  renderLeadStrip,
  renderPresence,
  renderQuickAdd,
  renderReviewBanner,
  renderReviewWalkthrough,
  renderTaskDetail,
  renderUnplacedStrip,
} from './hub-render.ts';
import { createTaskBodyEditorHost } from './task-body-editor.ts';

interface HubState {
  info: HubWorkspaceInfo | null;
  tasks: Map<string, HubTask>;
  /** Which of the four nav destinations is showing. THE source: `pane`,
   *  `tab` and `view` below are derived from it in `setNav` and never set
   *  anywhere else, so a deep link and a click cannot disagree. */
  nav: HubNav;
  /** Which page of the shell is showing — Home or the board. Derived. */
  pane: HubPane;
  /** The settings popover is open. App state rather than DOM state, so a
   *  repaint cannot close it under someone mid-change. */
  settingsOpen: boolean;
  /** The Home payload for THIS reader, or null before the first load. */
  home: HomePayload | null;
  /** The recipe editor is open. App state, not DOM state, so a repaint
   *  mid-edit cannot silently close the panel. */
  homeEditingRecipe: boolean;
  /** What this sitting has cleared, by key — answered items stay in the Home
   *  stack marked done instead of vanishing (approved design). Client-side
   *  and per-sitting on purpose: the server cannot un-answer a decision, so
   *  "done" here is a display fact about this visit, not a stored one. */
  homeSettled: Map<string, ReviewItem>;
  /** When the current generating-poll run started; 0 when not polling. */
  homePollStarted: number;
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
  /** Which conversation the discussion's one composer is pointed at: a thread
   *  id, `null` for a new thread, `undefined` for "nobody has chosen yet, take
   *  the default". Reset when the panel moves to another task — a target is
   *  about a discussion, not about the reader. */
  replyThreadId: string | null | undefined;
  /**
   * The thread-shaped half of "what needs you" — task discussions and doc
   * comments whose newest word is an agent's. Server-computed, because
   * whether a comment is an agent's is `classifyActor`'s call and there must
   * not be a second one. Decisions are derived from `tasks` here.
   */
  reviewItems: ReviewThreadItem[];
  /** Position in the review walkthrough; -1 when it is closed. A CACHE of
   *  where `walkKey` resolved on the last render — see `walkPosition`. */
  walkIndex: number;
  /** What the walkthrough is aimed AT. The queue re-derives on every render
   *  and shrinks under the reader, so the index alone steps over an item
   *  whenever anything before it drops out. Null when nothing is aimed
   *  (closed, or run off the end into the done state). */
  walkKey: string | null;
  /** What this sitting has cleared, so the surface can say that answering
   *  moved you rather than leaving you to infer it from a shrinking total. */
  walkProgress: WalkProgress;
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

const SVG = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"';
const SVG_ENDS = 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/** Icons. The four nav glyphs are the approved mockup's (home-pane-mockup-v1);
 *  share and settings are new, for the top-right cluster. */
const NAV_ICONS = {
  home: `<svg ${SVG} ${SVG_ENDS}><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/></svg>`,
  tasks: `<svg ${SVG} ${SVG_ENDS}><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>`,
  mine: `<svg ${SVG} ${SVG_ENDS}><circle cx="12" cy="8" r="3.4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>`,
  activity: `<svg ${SVG} ${SVG_ENDS}><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>`,
  collapse: `<svg ${SVG} ${SVG_ENDS}><polyline points="14 6 8 12 14 18"/></svg>`,
  expand: `<svg ${SVG} ${SVG_ENDS}><polyline points="10 6 16 12 10 18"/></svg>`,
  share: `<svg ${SVG} ${SVG_ENDS}><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.3 10.8 7.4-4.3M8.3 13.2l7.4 4.3"/></svg>`,
  settings: `<svg ${SVG} ${SVG_ENDS}><circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.4M12 19.1v2.4M21.5 12h-2.4M4.9 12H2.5M18.7 5.3l-1.7 1.7M7 17l-1.7 1.7M18.7 18.7 17 17M7 7 5.3 5.3"/></svg>`,
};

/** The nav, in the order it renders. `mine` sits beside `tasks` rather than
 *  inside it: "what is mine" is a place a person navigates to, and as a
 *  segmented filter on somebody else's list it had no URL and did not
 *  survive a reload. */
const NAV_ITEMS: ReadonlyArray<{ nav: HubNav; label: string; icon: string }> = [
  { nav: 'home', label: 'Home', icon: NAV_ICONS.home },
  { nav: 'tasks', label: 'Tasks', icon: NAV_ICONS.tasks },
  { nav: 'mine', label: 'My Tasks', icon: NAV_ICONS.mine },
  { nav: 'activity', label: 'Activity', icon: NAV_ICONS.activity },
];

/** Static shell — built once; regions re-render into their containers. */
function buildShell(root: HTMLElement, name: string): void {
  root.innerHTML = `
    <header class="hub-topbar">
      <a href="/" class="back-link" title="All workspaces" aria-label="Back">←</a>
      <span class="hub-ws-name">${escapeHtml(name)}</span>
      <div class="hub-cluster">
        <div id="hub-people" class="hub-presence hub-people hidden"></div>
        <button type="button" id="hub-share" class="hub-icon-btn" title="Share workspace" aria-label="Share workspace">${NAV_ICONS.share}</button>
        <button type="button" id="hub-settings" class="hub-icon-btn" title="Workspace settings" aria-label="Workspace settings" aria-expanded="false">${NAV_ICONS.settings}<span id="hub-settings-alarm" class="hub-alarm-dot hidden" aria-hidden="true"></span></button>
        <span id="hub-me" class="hub-me" title="Signed in"></span>
      </div>
      <div id="hub-settings-panel" class="hub-settings-panel hidden" role="region" aria-label="Workspace settings">
        <div id="hub-drift" class="hub-presence hidden"></div>
        <div id="hub-goal" class="hub-goal"></div>
        <div id="hub-lead" class="hub-lead"></div>
        <label class="hub-settings-row" for="hub-done-filter">Show done tasks from
          <select id="hub-done-filter" class="hub-select" aria-label="Done task visibility"></select>
        </label>
      </div>
    </header>
    <div id="hub-connection" class="conn-banner hidden" role="status" aria-live="polite"></div>
    <div class="hub-main" id="hub-main">
      <nav id="hub-nav" class="hub-nav" aria-label="Workspace pages">
        ${NAV_ITEMS.map(
          (
            n,
          ) => `<button type="button" class="hub-nav-item" data-nav="${n.nav}" title="${escapeHtml(n.label)}">
          <span class="hub-nav-icon" aria-hidden="true">${n.icon}</span><span class="hub-nav-label">${escapeHtml(n.label)}</span>
        </button>`,
        ).join('')}
        <button type="button" id="hub-nav-collapse" class="hub-nav-item hub-nav-collapse" title="Collapse">
          <span class="hub-nav-icon" aria-hidden="true">${NAV_ICONS.collapse}</span><span class="hub-nav-label">Collapse</span>
        </button>
      </nav>
      <section id="hub-home" class="hub-home hidden">
        <div id="hub-home-page">
          <div id="hub-home-brief"></div>
          <div id="hub-home-review"></div>
        </div>
        <div id="hub-walkthrough" class="hub-walkthrough hidden"></div>
      </section>
      <section class="hub-board-col">
        <div id="hub-decisions" class="hub-decisions hidden"></div>
        <div id="hub-quick" class="hub-quick"></div>
        <div id="hub-unplaced" class="hub-unplaced hidden"></div>
        <div id="hub-board" class="hub-board"></div>
        <div id="hub-activity" class="hub-activity hidden"></div>
      </section>
    </div>
    <div id="hub-detail" class="hub-detail hidden"></div>
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

  const initialNav = navFromPath(location.pathname);
  const state: HubState = {
    info: null,
    tasks: new Map(),
    nav: initialNav,
    pane: paneForNav(initialNav),
    settingsOpen: false,
    home: null,
    homeEditingRecipe: false,
    homeSettled: new Map(),
    homePollStarted: 0,
    tab: tabForNav(initialNav) ?? 'all',
    doneWindow: DEFAULT_DONE_WINDOW,
    view: initialNav === 'activity' ? 'activity' : 'board',
    activityFilter: 'all',
    events: [],
    uptime: null,
    agents: [],
    pluginRelease: null,
    clientRelease: null,
    detailTaskId: null,
    detailThreadId: null,
    discussion: { loading: false, threads: [] },
    discussionTaskId: null,
    replyThreadId: undefined,
    reviewItems: [],
    walkIndex: -1,
    walkKey: null,
    walkProgress: { cleared: 0, last: null },
    followedKey: null,
  };

  const initial = await fetchJson<{ workspace: HubWorkspaceInfo }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}`,
  );
  if (initial) state.info = initial.workspace;
  buildShell(root, state.info?.name ?? workspaceId);

  const el = (id: string) => document.getElementById(id) as HTMLElement;

  // ── The description, edited in place ────────────────────────────────────
  //
  // A second room, opened per task rather than per board: the task's body is
  // `task:<taskId>`, the same room an agent rewrites through `set_doc_content`
  // and the same one `/review/task:<id>` opens. Mounting the review surface's
  // editor over it is what makes the reader's typing and an agent's rewrite
  // merge as CRDT edits instead of one overwriting the other.
  //
  // The editor itself is behind a dynamic import so the board's bundle stays a
  // board — see task-body-editor-chunk.ts.
  const bodyEditor = createTaskBodyEditorHost({
    connect: (docId) => connect(wsUrl(docId, 'markdown')),
    loadEditor: () => import('./task-body-editor-chunk.ts'),
    user: { name: user.name, color: user.color },
  });

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
        ...(wsMap.get('leadAgentId') ? { leadAgentId: String(wsMap.get('leadAgentId')) } : {}),
        ...(wsMap.get('pendingRetriage')
          ? { pendingRetriage: wsMap.get('pendingRetriage') as PendingRetriageView }
          : {}),
        ...(wsMap.get('pendingBucketReview')
          ? { pendingBucketReview: wsMap.get('pendingBucketReview') as PendingBucketReviewView }
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
    onGoalAdd: (title: string, after?: string) => void addGoal(title, after),
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
   *  without a fetch.
   *
   *  The goal list is what makes the queue's priority order the BOARD's order
   *  rather than a second one — without it every ask lands in one band and the
   *  goal ranking silently does nothing. It comes from the same projection, so
   *  a goal reorder re-ranks the queue on the next render. */
  const currentQueue = () =>
    reviewQueue(taskList(), state.reviewItems, Date.now(), state.info?.goals ?? []);

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
      state.info?.pendingBucketReview,
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
    // Counted over EVERY task, not over the sections just rendered: the tab
    // and done-window filters decide what is worth looking at right now, and
    // a bucket that empties itself when you switch to "My Tasks" is a reading
    // that lies in the quiet direction — which is the whole failure mode.
    renderUnplacedStrip(el('hub-unplaced'), unplacedNotice(taskList(), filters.now), {
      onOpenOldest: (taskId) => {
        const task = state.tasks.get(taskId);
        if (task) boardHandlers.onOpenTask(task);
      },
    });
    // The board's read of the queue is one line now — the full list lives on
    // Home. Two surfaces both claiming to be the queue would drift the first
    // time only one of them learned something.
    renderReviewBanner(el('hub-decisions'), currentQueue(), {
      onGoHome: () => setNav('home'),
    });
    renderWalkthrough();
  }

  // ── The Home pane ───────────────────────────────────────────────────────

  function startWalkthrough(): void {
    // A sitting starts empty: the tally counts what THIS pass cleared, so
    // carrying the last one's over would open on "4 cleared" before the
    // reader has answered anything.
    state.walkProgress = { cleared: 0, last: null };
    state.walkIndex = 0;
    state.walkKey = currentQueue().items[0]?.key ?? null;
    renderWalkthrough();
  }

  function renderHomeRegion(): void {
    // Nav active state, all four destinations.
    for (const btn of document.querySelectorAll<HTMLButtonElement>('.hub-nav-item')) {
      const active = btn.dataset.nav === state.nav;
      btn.classList.toggle('hub-nav-item-active', active);
      btn.setAttribute('aria-current', active ? 'page' : 'false');
    }
    const main = el('hub-main');
    // Home is a clean frame: content only, none of the board's side columns.
    // The pane-scoped `hub-root--home` class went with the board chrome it
    // used to suppress — presence, lead and the goal banner live in the
    // settings panel now, which is not a pane's to hide.
    main.classList.toggle('hub-main--home', state.pane === 'home');
    el('hub-home').classList.toggle('hidden', state.pane !== 'home');
    if (state.pane !== 'home') return;
    renderHomeBrief(el('hub-home-brief'), state.home, Date.now(), state.homeEditingRecipe, {
      onMarkCaughtUp: () => void markCaughtUp(),
      onSaveInstructions: (text) => void saveInstructions(text),
      onEditRecipe: (open) => {
        state.homeEditingRecipe = open;
        renderHomeRegion();
      },
    });
    renderHomeReview(
      el('hub-home-review'),
      currentQueue(),
      { onOpen: openReviewItem, onWalkthrough: startWalkthrough },
      [...state.homeSettled.values()],
    );
  }

  /**
   * The one writer of `nav`, `pane`, `tab` and `view`. Four destinations that
   * used to be a pane switch, a segmented filter and a toggle button, each
   * setting its own piece of state — so "My Tasks" had no URL and a reload
   * dropped you back on All.
   *
   * `tab` is left alone for Home and Activity (`tabForNav` answers undefined):
   * neither renders task rows, so resetting the filter there would silently
   * undo the reader's choice on the way back.
   */
  function setNav(nav: HubNav, push = true): void {
    const same = state.nav === nav;
    state.nav = nav;
    state.pane = paneForNav(nav);
    state.view = nav === 'activity' ? 'activity' : 'board';
    const tab = tabForNav(nav);
    if (tab !== undefined) state.tab = tab;
    if (push && !same) history.pushState(null, '', navPath(workspaceId, nav));
    renderHomeRegion();
    renderBoardRegion();
    renderActivityRegion();
    if (nav === 'home') void loadHome();
    if (nav === 'activity') void loadEvents();
  }

  let homePollTimer: ReturnType<typeof setTimeout> | null = null;
  async function loadHome(): Promise<void> {
    const res = await fetchJson<HomePayload>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/home?user=${encodeURIComponent(user.name)}`,
    );
    // A failed fetch keeps the previous payload — same rule as every other
    // REST-fed region: "the request did not complete" is not "there is
    // nothing here".
    if (res) state.home = res;
    renderHomeRegion();
    // Poll while the server says a generation is actually queued, so the
    // generated brief lands without a manual reload. The flag is grounded in
    // a queued call; the cap stops a wedged payload from polling forever.
    if (homePollTimer) {
      clearTimeout(homePollTimer);
      homePollTimer = null;
    }
    if (res?.generating) {
      if (state.homePollStarted === 0) state.homePollStarted = Date.now();
      if (shouldPollHome(res, state.homePollStarted, Date.now())) {
        homePollTimer = setTimeout(() => void loadHome(), 1500);
      }
    } else {
      state.homePollStarted = 0;
    }
  }

  async function markCaughtUp(): Promise<void> {
    const res = await send(`/api/workspaces/${encodeURIComponent(workspaceId)}/home/read`, 'POST', {
      author,
    });
    if (!res.ok) {
      showToast('Could not mark caught up — try again.');
      return;
    }
    showToast('Caught up — the brief starts here now.');
    await loadHome();
  }

  async function saveInstructions(text: string): Promise<void> {
    const res = await send(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/home/instructions`,
      'PUT',
      { instructions: text, author },
    );
    if (!res.ok) {
      showToast('Could not save the instructions — try again.');
      return;
    }
    state.homeEditingRecipe = false;
    if (res.data) state.home = res.data as unknown as HomePayload;
    renderHomeRegion();
    // The save dropped every cached brief; pick up the regeneration.
    state.homePollStarted = 0;
    await loadHome();
  }

  function renderActivityRegion(): void {
    const board = el('hub-board');
    const activity = el('hub-activity');
    // Everything the task list is made of hides with it. Activity used to be
    // a button that swapped ONE div, so the capture box and the unplaced
    // strip stayed on screen over a feed they have nothing to do with.
    for (const id of ['hub-quick', 'hub-unplaced', 'hub-decisions']) {
      el(id).classList.toggle('hub-hidden-by-view', state.view === 'activity');
    }
    if (state.view === 'activity') {
      board.classList.add('hidden');
      activity.classList.remove('hidden');
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
    }
  }

  function renderDetail(): void {
    const task = state.detailTaskId ? (state.tasks.get(state.detailTaskId) ?? null) : null;
    // Fetch here rather than at each of the four places that open the panel
    // (row tap, `o`, deep link, voice navigate) — one of them would be missed
    // otherwise, and the miss looks like a task with no discussion. Safe from
    // recursion: loadDiscussion claims the id before it re-renders.
    if (task && state.discussionTaskId !== task.id) {
      // Here rather than at each of the four places that open the panel, for
      // the same reason the fetch is: a composer target belongs to a
      // discussion, not to the reader, and carrying one across would point
      // this task's box at another task's thread.
      state.replyThreadId = undefined;
      void loadDiscussion(task);
    }
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
        replyThreadId: state.replyThreadId,
        onReplyTarget: (threadId) => {
          state.replyThreadId = threadId;
          renderDetail();
          // Re-render first, then take the caret: the panel is rebuilt, so the
          // textarea this focuses is the one the new render made. Focusing
          // before would put the caret in a node about to be thrown away, and
          // the tap would look like it did nothing.
          document.querySelector<HTMLTextAreaElement>('.hub-comment-form textarea')?.focus();
        },
        ...(state.detailThreadId ? { focusThreadId: state.detailThreadId } : {}),
        // This task's rows from the review queue the strip already reads, so
        // the panel says the same thing the row that sent them here said. The
        // filter is by taskId: a doc-thread item has none and never matches,
        // which is correct — it belongs to a doc, not to this panel.
        asks: task ? state.reviewItems.filter((i) => i.taskId === task.id) : [],
        now: Date.now(),
      },
      task ? discussion : undefined,
    );
    // After the render, never before: the slot this hands over is the one the
    // render just decided on — a rebuilt element when the panel was opened or
    // switched, the SAME element when a repaint kept a live editor in place.
    // Idempotent for an unchanged pair, so the repaints that arrive while
    // somebody is typing cost nothing.
    bodyEditor.sync(
      task ? { id: task.id, bodyDocId: task.bodyDocId } : null,
      el('hub-detail').querySelector<HTMLElement>('.hub-detail-body-slot'),
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
        anchor?: { kind?: string; snippet?: { text?: string } };
        comments?: Array<{
          author?: { name?: string };
          text?: string;
          ts?: number;
          review?: ReviewPayload;
        }>;
      }>;
    }>(`/api/docs/${encodeURIComponent(task.bodyDocId)}/threads`);
    // The reader may have moved on while this was in flight.
    if (state.discussionTaskId !== task.id) return;
    const threads: TaskThread[] = (payload?.threads ?? []).map((t) => ({
      id: t.id,
      status: t.status === 'resolved' ? 'resolved' : 'open',
      // Only a text-range anchor names a passage. A subject anchor is the
      // whole task, which the panel is already showing — quoting it would put
      // the description above every one of its own threads.
      ...(t.anchor?.kind === 'text-range' && t.anchor.snippet?.text
        ? { anchorText: t.anchor.snippet.text }
        : {}),
      comments: (t.comments ?? []).map((c) => ({
        author: c.author?.name ?? 'Someone',
        text: c.text ?? '',
        ts: c.ts ?? Date.now(),
        // Forwarded, not re-validated: the server refuses a malformed
        // declaration at the write, and re-deciding here would be a second
        // copy of one rule free to drift from the first.
        ...(c.review ? { review: c.review } : {}),
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
    // Stay where the comment went. A reply keeps its thread; a NEW thread goes
    // back to the default, which is the last thread on screen — and after the
    // reload that is the one just created. Either way the next thing typed
    // lands in the conversation the reader just joined, rather than starting
    // another one beside it.
    state.replyThreadId = threadId;
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
    const queue = currentQueue();
    // Resolve the aim before rendering, and write the result back: from here
    // on the index is a cache of where the key IS, not an independent claim
    // about where the reader stands.
    const index = walkPosition(queue, state.walkIndex, state.walkKey);
    state.walkIndex = index;
    const current = queue.items[index] ?? null;
    const next = queue.items[index + 1] ?? null;
    // A PAGE inside Home, not an overlay over the board — so the Home content
    // it replaces has to go away while it is up. One toggle rather than a
    // class on each region: a region added to Home later is covered by it
    // without anyone remembering this line exists.
    el('hub-home-page').classList.toggle('hidden', index >= 0);
    renderReviewWalkthrough(
      el('hub-walkthrough'),
      queue,
      index,
      {
        // `current` rather than a lookup by task id: it is the item this
        // render drew, so the key that gets advanced past cannot be a
        // different row that happens to share a task.
        onAnswer: (t, text, optionId) =>
          finishWalkItem(current, next, () => answerDecision(t, text, optionId)),
        // Not a finish. The decision stays open and unanswered, so advancing
        // would claim something happened that did not.
        onMoreInfo: (t, question) => requestMoreInfo(t, question),
        onReply: (item, text, optionId) =>
          finishWalkItem(item, next, () => replyToReviewItem(item, text, optionId)),
        onOpenItem: (item) => {
          state.walkIndex = -1;
          state.walkKey = null;
          renderWalkthrough();
          openReviewItem(item);
        },
        onStep: (i) => {
          // Skip and back are positional by nature — the reader is pointing at
          // a place in the list they can see. Re-aim from that position so the
          // next repaint follows the item rather than the number.
          const to = Math.max(0, i);
          state.walkIndex = to;
          state.walkKey = queue.items[to]?.key ?? null;
          renderWalkthrough();
        },
        onClose: () => {
          state.walkIndex = -1;
          state.walkKey = null;
          state.walkProgress = { cleared: 0, last: null };
          renderWalkthrough();
        },
        contextLabel: walkContextLabel,
      },
      state.walkProgress,
    );
  }

  /**
   * The card's project chip.
   *
   * The mockup's Home spans several projects and chips each card with one.
   * This Home is per-workspace, so the workspace name would be the same word
   * on every card — the honest within-workspace answer to "which body of work
   * is this" is the GOAL. Null where there is no task to read one off (a doc
   * comment), which renders no chip rather than a placeholder.
   */
  function walkContextLabel(item: ReviewItem): string | null {
    const taskId = reviewRow(item)?.task.id ?? item.thread?.taskId;
    if (!taskId) return null;
    const task = taskList().find((t) => t.id === taskId);
    if (!task) return null;
    return goalLabel(state.info?.goals ?? [], task.goal);
  }

  /**
   * Answering moves you on, and the surface says so.
   *
   * Order is the whole point: the write, THEN the advance. The advance is the
   * confirmation that the answer landed, so a refused write has to leave the
   * reader on the same card with their words still in the box — otherwise the
   * queue moves and nothing recorded it, which is the one failure this flow
   * cannot afford.
   */
  async function finishWalkItem(
    item: ReviewItem | null,
    next: ReviewItem | null,
    write: () => Promise<boolean>,
  ): Promise<boolean> {
    const ok = await write();
    if (!ok || !item) return ok;
    state.walkProgress = { cleared: state.walkProgress.cleared + 1, last: item };
    // Answered items stay in the Home stack marked done (approved design)
    // instead of vanishing — a per-sitting display ledger, not stored state.
    state.homeSettled.set(item.key, item);
    const queue = currentQueue();
    state.walkIndex = advanceWalk(queue, state.walkIndex, item.key, next?.key ?? null);
    state.walkKey = queue.items[state.walkIndex]?.key ?? null;
    renderWalkthrough();
    renderHomeRegion();
    return ok;
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

  /**
   * The presence strip renders in TWO places now, from one function called
   * twice: who is here goes in the top-right cluster, and the drift notices
   * go in the settings panel. Same renderer, so every existing assertion
   * about how a notice looks still describes what ships — and `renderPresence`
   * already handles chips-with-no-notices and notices-with-no-chips, which is
   * what makes the split free.
   *
   * A notice in a closed panel is an alarm nobody sees, so the settings button
   * carries a dot whenever something in there is asking for attention. The
   * `coverage` notice deliberately does not arm it: it renders permanently by
   * design, and an always-on dot is one nobody reads.
   */
  function renderPresenceRegion(): void {
    const chips = presenceChips(peopleFromAwareness(), state.agents, Date.now());
    const handlers = {
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
      // The "+N" circle's names have to reach a touch screen, where a title
      // attribute never shows. A toast is enough: it answers "who else".
      onOverflow: (hiddenChips: PresenceChip[]) =>
        showToast(`Also here: ${hiddenChips.map((c) => c.label).join(', ')}`),
    };
    renderPresence(el('hub-people'), chips, state.followedKey, handlers, [], true);
    const notices = [
      pluginDriftNotice(state.pluginRelease),
      clientDriftNotice(state.clientRelease, Date.now()),
    ];
    renderPresence(el('hub-drift'), [], null, handlers, notices);
    renderSettingsAlarm(notices);
  }

  /** What in the settings panel is asking to be looked at. */
  function renderSettingsAlarm(notices: Array<DriftNotice | null>): void {
    const armed =
      notices.some((n) => n !== null && n.kind !== 'coverage') ||
      state.info?.pendingRetriage !== undefined ||
      state.info?.pendingBucketReview !== undefined;
    el('hub-settings-alarm').classList.toggle('hidden', !armed);
    // Both attributes, because the dot itself is `aria-hidden`: a reader who
    // never sees it would otherwise be told "Workspace settings" while the
    // button is visibly asking to be opened. `title` alone is announced
    // weakly or not at all depending on the reader.
    const label = armed ? 'Workspace settings — needs a look' : 'Workspace settings';
    el('hub-settings').setAttribute('title', label);
    el('hub-settings').setAttribute('aria-label', label);
  }

  /**
   * Who the board thinks you are. `ensureUserIdentity` has always decided
   * this — it is what stamps every comment and what "My Tasks" matches on —
   * and until now nothing rendered it, so a reader with the wrong name saved
   * found out by seeing their own comment signed by somebody else.
   */
  function renderMe(): void {
    const me = el('hub-me');
    me.textContent = initialsOf(user.name);
    me.setAttribute('title', `Signed in as ${user.name}`);
    me.setAttribute('aria-label', `Signed in as ${user.name}`);
    if (user.color) me.style.background = user.color;
  }

  function renderSettingsPanel(): void {
    el('hub-settings-panel').classList.toggle('hidden', !state.settingsOpen);
    el('hub-settings').setAttribute('aria-expanded', String(state.settingsOpen));
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
    renderMe();
    renderSettingsPanel();
    renderBoardRegion();
    renderActivityRegion();
    renderDetail();
    renderPresenceRegion();
    renderHomeRegion();
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
   * A drag or an arrow-key move, sent as the placement it already is — the
   * same `set_task_goal` write an agent performs, so there is deliberately no
   * reordering API of its own, and a cross-goal drop is this call with a
   * different goal.
   *
   * It sends `after` and NOT `position`. The two are alternative spellings of
   * one placement and the server prefers `after`, so sending both would just
   * be a number nobody reads — and a number the drop cannot compute correctly
   * anyway, which is the bug this replaced (see the reordering section of
   * hub-model.ts).
   */
  async function placeTask(task: HubTask, target: ReorderTarget): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/goal`, 'POST', {
      goal: target.goal,
      after: target.after,
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

  /** Add one band, for the same reason the rename above is its own route: a
   *  client-built full list can only add by re-asserting everything it last
   *  read, and what it did not read is what gets removed. */
  async function addGoal(title: string, after?: string): Promise<void> {
    const res = await send(`/api/workspaces/${encodeURIComponent(workspaceId)}/goals/add`, 'POST', {
      title,
      ...(after !== undefined ? { after } : {}),
      author,
    });
    if (!res.ok) showToast('Could not add the goal');
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

  /** Resolves to whether the answer LANDED — the walkthrough advances on that
   *  and on nothing else, and the composer keeps the text until it hears yes. */
  async function answerDecision(task: HubTask, text: string, optionId?: string): Promise<boolean> {
    // Posted with the PERSON's own identity: answer.by shows who decided.
    // `text` is always the verbatim answer — tapping an option sends the
    // option's label as the answer and its id alongside, so nothing about the
    // recorded answer depends on the option list still existing later.
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/answer`, 'POST', {
      text,
      ...(optionId ? { optionId } : {}),
      author,
    });
    if (!res.ok) showToast('Recording the answer failed — your words are still in the box');
    return res.ok;
  }

  /** "I can't answer this yet" — the decision stays open and unanswered. */
  async function requestMoreInfo(task: HubTask, question: string): Promise<boolean> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/more-info`, 'POST', {
      question,
      author,
    });
    showToast(
      res.ok ? 'Asked — it stays open until you have the answer' : 'Sending the question failed',
    );
    return res.ok;
  }

  /**
   * Answer a queued comment from the queue itself. The reply is an ordinary
   * thread comment — the same POST the doc and the task panel use — which is
   * what takes the item OUT of the queue: `awaitingPerson` reports a thread
   * only while an agent spoke last, so there is no separate dismissed flag to
   * write and none to keep in sync.
   */
  async function replyToReviewItem(
    item: ReviewItem,
    text: string,
    optionId?: string,
  ): Promise<boolean> {
    const t = item.thread;
    if (!t) return false;
    const doc = encodeURIComponent(t.docId);
    const thread = encodeURIComponent(t.threadId);
    // A declared item goes through `/answer`, which posts the SAME reply and
    // additionally records which candidate it came from on the declaring
    // comment. Not a second answer path: the reply is what takes the item out
    // of the queue in both cases, and `/answer` refuses rather than inventing
    // one when the comment declared nothing.
    const declared = item.review !== undefined && t.commentId !== undefined;
    const res = declared
      ? await send(`/api/docs/${doc}/threads/${thread}/answer`, 'POST', {
          author,
          text,
          commentId: t.commentId,
          ...(optionId !== undefined ? { optionId } : {}),
        })
      : await send(`/api/docs/${doc}/threads/${thread}/comments`, 'POST', { author, text });
    if (!res.ok) {
      showToast('Posting the reply failed — your text is still in the box');
      return false;
    }
    // Refresh BEFORE the advance: the queue has to have dropped the answered
    // item before the new position is computed against it, or the aim lands on
    // a list that still holds the thing just replied to.
    await loadReviewItems();
    return true;
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
    renderHomeRegion();
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
    // The Home queue is computed from the same tasks — without this the
    // first projection lands after Home's first paint and the queue stays
    // empty while the board banner (painted by renderBoardRegion) counts it.
    renderHomeRegion();
    renderDetail();
  });
  wsMap.observeDeep(() => {
    readProjection();
    renderGoal();
    renderLead();
    renderBoardRegion();
    renderHomeRegion();
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
    es.addEventListener(name, () => {
      void loadEvents();
      // The same board changes stale the Home brief. Refreshing only while
      // Home is showing keeps a background board tab from queueing model
      // calls nobody is reading.
      if (state.pane === 'home') void loadHome();
    });
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
  // Home / Tasks / My Tasks / Activity — pushState every way, and the back
  // button honours all four.
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.hub-nav-item[data-nav]')) {
    btn.addEventListener('click', () => setNav((btn.dataset.nav as HubNav) ?? 'tasks'));
  }
  // Rail collapse — persisted so the choice survives reloads. The button only
  // renders on wide screens (CSS hides it in the strip/bottom-bar bands).
  {
    const NAV_COLLAPSED_KEY = 'lf-hub-nav-collapsed';
    const nav = document.getElementById('hub-nav');
    const collapseBtn = document.getElementById('hub-nav-collapse');
    const apply = (collapsed: boolean) => {
      nav?.classList.toggle('hub-nav--collapsed', collapsed);
      if (collapseBtn) {
        const icon = collapseBtn.querySelector('.hub-nav-icon');
        if (icon) icon.innerHTML = collapsed ? NAV_ICONS.expand : NAV_ICONS.collapse;
        const label = collapseBtn.querySelector('.hub-nav-label');
        if (label) label.textContent = collapsed ? 'Expand' : 'Collapse';
        collapseBtn.title = collapsed ? 'Expand' : 'Collapse';
      }
    };
    apply(localStorage.getItem(NAV_COLLAPSED_KEY) === '1');
    collapseBtn?.addEventListener('click', () => {
      const next = !nav?.classList.contains('hub-nav--collapsed');
      localStorage.setItem(NAV_COLLAPSED_KEY, next ? '1' : '0');
      apply(next);
    });
  }
  window.addEventListener('popstate', () => {
    setNav(navFromPath(location.pathname), false);
  });
  (document.getElementById('hub-done-filter') as HTMLSelectElement).addEventListener(
    'change',
    (ev) => {
      state.doneWindow = (ev.target as HTMLSelectElement).value as DoneWindow;
      renderBoardRegion();
    },
  );
  el('hub-settings').addEventListener('click', () => {
    state.settingsOpen = !state.settingsOpen;
    renderSettingsPanel();
  });
  // A popover that only closes by hitting the same small button again is one
  // people leave open over the list they were trying to read.
  document.addEventListener('click', (ev) => {
    if (!state.settingsOpen) return;
    const t = ev.target as Node | null;
    if (!t) return;
    if (el('hub-settings-panel').contains(t) || el('hub-settings').contains(t)) return;
    state.settingsOpen = false;
    renderSettingsPanel();
  });
  // Escape closes it too — it floats over the board now, and a floating panel
  // that ignores Escape reads as stuck. Focus goes back to the button that
  // opened it, so a keyboard user is not dropped at the top of the document.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !state.settingsOpen) return;
    state.settingsOpen = false;
    renderSettingsPanel();
    el('hub-settings').focus();
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
  void loadAgents();
  void loadEvents();
  void loadReviewItems();
  // A deep link straight to /home needs its payload without a nav tap.
  if (state.pane === 'home') void loadHome();
}

void main();
