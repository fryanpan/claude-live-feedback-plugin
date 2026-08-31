/**
 * The workspace hub page: a left nav over two panes — Home (the "What's New?"
 * brief, the "For Your Review" queue, and the walkthrough that answers it)
 * and the board (goals as bands, quick add, review banner), with Activity as
 * a view of the board pane. Presence, lead and drift notices live in the
 * settings panel. The board renders in realtime from the ws:<workspaceId>
 * ydoc projection (server-owned `tasks` / `workspace` Y.Maps); every
 * mutation goes through the REST gate — never by writing into the maps,
 * which the server would revert.
 */
import {
  type CaptureMode,
  type ReviewPayload,
  type Thread,
  type User,
  connect,
  escapeHtml,
} from '@feedback/core';
import {
  renderConnectionBanner,
  renderLiveStaleNotice,
  watchConnection,
  watchLiveSync,
} from '../connection-state.ts';
import { HUDDLE_MODE_PARAM } from '../huddle-entry.ts';
import { MIC_ICON, SVG, SVG_ENDS } from '../icons.ts';
import { ensureUserIdentity } from '../identity-prompt.ts';
import { wireKeyboardInset } from '../keyboard-inset.ts';
import { staleTaskLinkStatuses } from '../link-titles.ts';
import { startReadingTracker } from '../reading-tracker.ts';
import { pageSentry } from '../sentry-page.ts';
import {
  asBackgroundWrite,
  fetchWriteAccess,
  installWriteGateNotice,
  showSignInBar,
} from '../signin/write-gate.ts';
import { installStaleClientNotice } from '../stale-client.ts';
import { type VoiceAck, createVoiceCapture } from '../voice-capture.ts';
import { activityCommentRequest, asksOf } from './activity-model.ts';
import { type BoardHandlers, boardData, mountBoardIsland } from './board-island.tsx';
import {
  type BoardLocation,
  buildBoardUrl,
  goalShareUrl,
  historyStep,
  parseBoardLocation,
  resourceOf,
  taskShareUrl,
} from './board-url.ts';
import { goalDetailData, mountGoalDetailIsland } from './goal-detail-island.tsx';
import { homeActivityData, mountHomeActivityIsland } from './home-activity-island.tsx';
import { startHomeClock } from './home-clock.ts';
import { homeReviewData, mountHomeReviewIsland } from './home-review-island.tsx';
import {
  ACTIVITY_REFRESH_EVENTS,
  type ActivityEvent,
  type ActivityFilter,
  type BoardSection,
  type BoardTab,
  CLOSED_WALK,
  type ClientRelease,
  DEFAULT_DONE_WINDOW,
  DONE_WINDOWS,
  type DoneWindow,
  type DriftNotice,
  type HomePayload,
  type HubGoal,
  type HubNav,
  type HubPane,
  type HubReviewItem,
  type HubTask,
  type HubWorkspaceInfo,
  type LeadSeatView,
  type PluginRelease,
  type PresenceAgent,
  type PresencePerson,
  type ReorderTarget,
  type ReviewItem,
  type ReviewThreadItem,
  type UptimeReport,
  type WalkAim,
  type WalkHold,
  type WalkSources,
  advanceWalk,
  applyRefresh,
  archivedGoals,
  archivedTasks,
  bandOfGoal,
  boardCalibration,
  boardSections,
  boardSectionsWithEffort,
  cascadePhrase,
  clientDriftNotice,
  goalBandIds,
  goalLabel,
  goalSection,
  holdWaitingItem,
  hubTabTitle,
  humanBlockerRows,
  initialsOf,
  isTaskArchived,
  paneForNav,
  panelAsks,
  pluginDriftNotice,
  presenceChips,
  presenceIdentity,
  refreshReviewItems,
  reviewItemAskRequest,
  reviewQueue,
  reviewReplyRequest,
  reviewRow,
  shouldPollHome,
  tabForNav,
  voiceHubContext,
  walkAimAfterOpen,
  walkHandoff,
  walkHandoffReady,
  walkNextUrl,
  walkPosition,
} from './hub-model.ts';
import {
  type PanelReviewItem,
  type TaskDiscussion,
  type TaskThread,
  discussionIsBusy,
  panelAnswerRequest,
  renderActivity,
  renderArchivedList,
  renderHomeBrief,
  renderLeadStrip,
  renderQuickActions,
  renderReviewBanner,
  renderWorkspaceIdentity,
} from './hub-render.ts';
import { hubShortcutKeydown } from './hub-shortcuts.ts';
import { mountIslandProbe } from './island-probe.tsx';
import { wireMeMenu } from './me-menu.ts';
import {
  driftData,
  mountDriftIsland,
  mountPresenceIsland,
  presenceData,
} from './presence-island.tsx';
import { mountPushToggle } from './push-toggle.ts';
import { createRepaintGuard } from './repaint-guard.ts';
import { mountReviewCriteria } from './review-criteria.ts';
import { GOAL_PLACEHOLDER_TEXT, createTaskBodyEditorHost } from './task-body-editor.ts';
import { type DetailTab, mountTaskDetailIsland, taskDetailData } from './task-detail-island.tsx';
import {
  type WalkProgress,
  mountWalkthroughIsland,
  walkthroughData,
} from './walkthrough-island.tsx';

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
  /**
   * The board column is showing the restore list instead of the lanes.
   *
   * A flag on the board rather than a fifth `nav` destination, and it is the
   * shape the design asked for: the phone rail has four seats, and the way in
   * is one line above the first goal. It rides `?view=archived` so a reload
   * or a shared link lands back on it, and any nav tap clears it — leaving the
   * board is leaving this.
   */
  showArchived: boolean;
  activityFilter: ActivityFilter;
  events: ActivityEvent[];
  /** Deploy readiness (§3.12 commit 11) — null until the log has lines. */
  uptime: UptimeReport | null;
  agents: PresenceAgent[];
  /** Whether the lead seat has anybody in it — read off the attachments poll
   *  rather than the projected workspace info, because it changes with time
   *  alone and a value stamped into the doc would still say "fine" hours
   *  after the lead stopped answering. Null until the first read lands, and
   *  null on any server older than the field: no claim, not a clear seat. */
  seat: LeadSeatView | null;
  /** Plugin versions: what the deploy source would install, and which
   *  attached sessions are running something older. Null until the first
   *  attachments read lands. */
  pluginRelease: PluginRelease | null;
  /** What the browser itself is running, and whether this deployment could
   *  not replace it. Null on any server that publishes no client release
   *  (dev, staging) — those must not report the prod machine's deploy. */
  clientRelease: ClientRelease | null;
  detailTaskId: string | null;
  /** Which tab the task panel opens on. `comments` every way in but one: the
   *  Home activity pane's title tap opens on Activity (Bryan, 2026-08-29).
   *  Reset to `comments` when the panel closes, so nothing lingers into the
   *  paths (deep link, `o`) that set `detailTaskId` without going through
   *  `openTaskDetail`. */
  detailTab: DetailTab;
  /** The open GOAL, when the detail container is showing a goal band rather
   *  than a task. The two panels share the container, so at most one of this
   *  and `detailTaskId` is set — each opener clears the other, and
   *  `renderDetail` enforces task-wins for the paths (deep link, voice) that
   *  set a task id without knowing a goal was open. */
  detailGoalId: string | null;
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
  /** The item the reader just asked on, kept on its card while the server's
   *  queue has dropped it (it is the owner's turn) — see `holdWaitingItem`.
   *  Cleared by anything that moves the reader off the card. */
  walkHold: WalkHold | null;
  followedKey: string | null;
}

function workspaceIdFromPath(): string {
  const m = location.pathname.match(/\/workspaces\/([^/?#]+)/);
  return m?.[1] ? decodeURIComponent(m[1]) : '';
}

/** How long an armed ?walk=1 handoff waits for the board to produce a queue
 *  before concluding it is genuinely clear. Generous against a slow ydoc
 *  sync; short enough that a truly cleared board hands off while the reader
 *  is still looking at it. */
const WALK_HANDOFF_DEADLINE_MS = 4000;

/**
 * The shareable address of one task: the deep link the app reads at start-up,
 * so the link a person pastes into a message opens the workspace AND the task,
 * and says which workspace it belongs to on its face rather than being an
 * opaque id. Always the canonical bare-path shape — `board-url.ts` owns it —
 * whatever nav page it is copied from, because that is the shape the link-chip
 * renderer resolves to a title.
 */
function taskUrl(taskId: string): string {
  return taskShareUrl(location.origin, workspaceIdFromPath(), taskId);
}

/** The same, for a band — `?goal=`. See `taskUrl`. */
function goalUrl(goalId: string): string {
  return goalShareUrl(location.origin, workspaceIdFromPath(), goalId);
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
/**
 * The board's one-line report, optionally carrying a way to take it back.
 *
 * `action` is what makes an undoable act safe to perform without a dialog:
 * the row leaves, and the way back is in the same place the news arrived,
 * for as long as the toast stands. Ten seconds for an archive rather than
 * the default three and a half — a confirm dialog is what this replaces, and
 * three seconds is not long enough to read a sentence and decide against it.
 */
function showToast(msg: string, action?: { label: string; run: () => void; ms?: number }): void {
  const el = document.getElementById('hub-toast');
  if (!el) return;
  el.replaceChildren(document.createTextNode(msg));
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hub-toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      // Dismiss FIRST. The action re-renders the board, and a toast still
      // offering "Undo" over a row that is already back reads as an undo
      // that did not take.
      if (toastTimer) clearTimeout(toastTimer);
      el.classList.add('hidden');
      action.run();
    });
    el.append(btn);
  }
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), action?.ms ?? 3500);
}

/** How long the Undo stands after an archive. Ten seconds, and it is the
 *  reason no confirm dialog is asked for. */
const ARCHIVE_UNDO_MS = 10_000;

/** Icons. The four nav glyphs are the approved mockup's (home-pane-mockup-v1);
 *  share and settings are new, for the top-right cluster. The shared
 *  attributes and the mic come from `../icons.ts`, because the mic is mounted
 *  by three surfaces and only one of them is a hub module. */
const NAV_ICONS = {
  home: `<svg ${SVG} ${SVG_ENDS}><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/></svg>`,
  tasks: `<svg ${SVG} ${SVG_ENDS}><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>`,
  mine: `<svg ${SVG} ${SVG_ENDS}><circle cx="12" cy="8" r="3.4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>`,
  activity: `<svg ${SVG} ${SVG_ENDS}><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>`,
  collapse: `<svg ${SVG} ${SVG_ENDS}><polyline points="14 6 8 12 14 18"/></svg>`,
  expand: `<svg ${SVG} ${SVG_ENDS}><polyline points="10 6 16 12 10 18"/></svg>`,
  share: `<svg ${SVG} ${SVG_ENDS}><circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="19" r="2.6"/><path d="m8.3 10.8 7.4-4.3M8.3 13.2l7.4 4.3"/></svg>`,
  settings: `<svg ${SVG} ${SVG_ENDS}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
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
      <span class="hub-ws-name"><span class="hub-ws-name-text" id="hub-ws-name-text">${escapeHtml(name)}</span><span id="hub-retired-badge" class="hub-retired-badge hidden">Retired</span></span>
      <div class="hub-cluster">
        <div id="hub-people" class="hub-presence hub-people hidden"></div>
        <button type="button" id="hub-share" class="hub-icon-btn" title="Share workspace" aria-label="Share workspace">${NAV_ICONS.share}</button>
        <button type="button" id="hub-settings" class="hub-icon-btn" title="Workspace settings" aria-label="Workspace settings" aria-expanded="false">${NAV_ICONS.settings}<span id="hub-settings-alarm" class="hub-alarm-dot hidden" aria-hidden="true"></span></button>
        <button type="button" id="hub-me" class="hub-me" title="Signed in" aria-haspopup="true" aria-expanded="false"></button>
      </div>
      <div id="hub-me-menu" class="hub-me-menu hidden" role="region" aria-label="Your identity"></div>
      <div id="hub-settings-panel" class="hub-settings-panel hidden" role="region" aria-label="Workspace settings">
        <div id="hub-drift" class="hub-presence hidden"></div>
        <div id="hub-lead" class="hub-lead"></div>
        <label class="hub-settings-row" for="hub-done-filter">Show done tasks from
          <select id="hub-done-filter" class="hub-select" aria-label="Done task visibility"></select>
        </label>
        <!-- Per DEVICE, not per account — a push subscription belongs to this
             browser on this machine, so the row says so rather than reading
             like a workspace-wide preference somebody set once. -->
        <label class="hub-settings-row hub-settings-row--push" for="hub-push-toggle">
          <span class="hub-settings-label">Notify me on this device
            <small id="hub-push-note" class="hub-settings-note"></small>
          </span>
          <input type="checkbox" id="hub-push-toggle" class="hub-check" aria-describedby="hub-push-note" />
        </label>
        <!-- What the quality gate judges an agent's ask against, in the
             owner's own words (Bryan, 2026-08-29: "Something we can change in
             the settings. It's a natural language prompt."). A textarea and
             not a rule table for that reason. It shows the DEFAULT when this
             board has never written one, so the words are always readable
             even when nobody has edited them — a criterion you cannot read is
             one your agents are judged against in secret. -->
        <div class="hub-settings-row hub-settings-row--criteria">
          <label class="hub-settings-label" for="hub-review-criteria">What makes a good review item
            <small id="hub-review-criteria-note" class="hub-settings-note"></small>
          </label>
          <textarea id="hub-review-criteria" class="hub-criteria" rows="5" aria-describedby="hub-review-criteria-note" placeholder="Plain English: what an agent’s ask has to do before it reaches you."></textarea>
          <div class="hub-criteria-actions">
            <button type="button" id="hub-review-criteria-save" class="hub-btn hub-btn-primary">Save</button>
            <button type="button" id="hub-review-criteria-default" class="hub-btn">Use the default</button>
          </div>
        </div>
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
        <div class="hub-nav-dock" role="group" aria-label="Voice">
          <button type="button" id="hub-mic" class="voice-mic" title="Hold to talk (or hold Space)" aria-label="Hold to talk">${MIC_ICON}</button>
          <div id="hub-voice" class="voice-indicator hidden" aria-live="polite"></div>
        </div>
      </nav>
      <section id="hub-home" class="hub-home hidden">
        <div id="hub-home-page">
          <div id="hub-home-review"></div>
          <div id="hub-home-activity"></div>
          <div id="hub-home-brief"></div>
        </div>
        <div id="hub-walkthrough" class="hub-walkthrough hidden"></div>
      </section>
      <section class="hub-board-col">
        <div id="hub-decisions" class="hub-decisions hidden"></div>
        <div id="hub-quick" class="hub-quick"></div>
        <div id="hub-board" class="hub-board"></div>
        <div id="hub-archived" class="hub-board hidden"></div>
        <div id="hub-activity" class="hub-activity hidden"></div>
      </section>
    </div>
    <div id="hub-detail" class="hub-detail hidden"></div>
    <!-- The GOAL panel's own container. It used to share #hub-detail with the
         task panel and rebuild it with replaceChildren, which no vanilla code
         may do to a node holding a live island — same resolution the archived
         list got when the board became one. -->
    <div id="hub-goal-detail" class="hub-detail hidden"></div>
    <div id="hub-help" class="hub-help hidden">
      <div class="hub-help-card">
        <h2>Keyboard shortcuts</h2>
        <dl>
          <dt>j / k</dt><dd>next / previous task</dd>
          <dt>o or Enter</dt><dd>open the focused task</dd>
          <dt>s</dt><dd>open the focused task's status dropdown</dd>
          <dt>a</dt><dd>open the focused task's assignee picker</dd>
          <dt>e</dt><dd>archive the focused task — it leaves the board, and a 10-second Undo offers it back. Nothing is destroyed; the archived list restores it later</dd>
          <dt>r or F2</dt><dd>rename the focused task in place — clicking its title does the same, with the cursor where you clicked</dd>
          <dt>alt + ↑ / ↓</dt><dd>move the focused task up / down — past the ends of its goal it moves into the next one</dd>
          <dt>tab to ⠿, then ↑ / ↓</dt><dd>the same move from the drag handle</dd>
          <dt>c</dt><dd>new task — an empty row opens in the panel with the title ready to type</dd>
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

async function main(): Promise<void> {
  // A refused write raises a sign-in prompt wherever it happened. The board's
  // `send()` reports every failure as a toast, and "Couldn't save" is not
  // something a signed-out person can act on. See signin/write-gate.ts.
  installWriteGateNotice();
  const root = document.getElementById('hub-root');
  const workspaceId = workspaceIdFromPath();
  if (!root || !workspaceId) return;

  // Publish `--kb-bottom` before anything is drawn. The doc surface has done
  // this since its composer first went under the keyboard; the hub is a
  // separate entry point and did not, so every bottom-docked thing here — the
  // task panel's Comment button most visibly — sat under the iOS keyboard and
  // its accessory bar with no scroll left to reach it.
  wireKeyboardInset();

  // Same order as the doc surface: the write answer decides whether the name
  // prompt is worth showing. See signin/write-gate.ts.
  const writeAccess = await fetchWriteAccess();
  // The bar is raised after `buildShell` below, not here: it mounts as a row
  // under `.hub-topbar`, and at this point `#hub-root` is still the empty div
  // the server sent. Raised here it would be wiped by the very next
  // `root.innerHTML`.
  const user: User = await ensureUserIdentity(
    new URLSearchParams(location.search).get('as'),
    {
      get: (k) => localStorage.getItem(k),
      set: (k, v) => localStorage.setItem(k, v),
    },
    writeAccess.canWrite ? {} : { suppressNamePrompt: true },
  );
  const author = { id: user.id, name: user.name, kind: user.kind, color: user.color };

  // Everything the address names, read once: nav destination, an open task
  // or goal (and the thread it is aimed at), Home's walkthrough item, the
  // archived filter. The panel ids go straight into state — the projection
  // they resolve against arrives after first paint, and the deadline near the
  // bottom of main() is what finally decides a claim was stale.
  const bootLoc = parseBoardLocation(location.pathname, location.search);
  const initialNav = bootLoc.nav;
  const state: HubState = {
    seat: null,
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
    showArchived: bootLoc.archived,
    activityFilter: 'all',
    events: [],
    uptime: null,
    agents: [],
    pluginRelease: null,
    clientRelease: null,
    detailTaskId: bootLoc.task,
    detailTab: 'comments',
    detailGoalId: bootLoc.goal,
    detailThreadId: bootLoc.thread,
    discussion: { loading: false, threads: [] },
    discussionTaskId: null,
    reviewItems: [],
    walkIndex: -1,
    walkKey: null,
    walkProgress: { cleared: 0, last: null },
    walkHold: null,
    followedKey: null,
  };

  // ── The address bar's working state (functions live next to setNav) ─────
  /** What the URL currently says, in parsed form — `historyStep`'s "prev". */
  let urlLoc: BoardLocation = bootLoc;
  /** True while popstate is writing URL → state, so the renders it triggers
   *  don't write state → URL back over the entry being applied. */
  let applyingHistory = false;
  /** The boot URL's goal claim, held until the projection confirms or the
   *  deadline denies it — `renderDetail` must not clear an unconfirmed goal
   *  the way it clears one that genuinely left the board. */
  let pendingBootGoal = bootLoc.goal;
  /** The boot URL aimed at a thread; checked once against the loaded
   *  discussion, then dropped. */
  let bootThreadPending = bootLoc.thread !== null;
  /** The row "New task" just filed: the panel opens it with the title in
   *  rename. Cleared the moment any other task is on screen. */
  let focusTitleTaskId: string | null = null;
  /** The boot URL named a walkthrough item; opened when the queue holds it. */
  let pendingBootItem = bootLoc.item;

  const initial = await fetchJson<{ workspace: HubWorkspaceInfo }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}`,
  );
  if (initial) state.info = initial.workspace;
  buildShell(root, state.info?.name ?? workspaceId);
  // Now that there is a header to sit under. See signin/write-gate.ts.
  if (!writeAccess.canWrite) showSignInBar();
  // The Preact proving island (hidden; owns its own wrapper under root).
  // buildShell wrote root.innerHTML just above, so this mounts AFTER the last
  // vanilla wipe of root — the contract is that no vanilla code wipes a
  // container while an island lives in it.
  mountIslandProbe(root);
  // The REST read above already knows whether this board is retired, and the
  // board room's first sync can be a second away on a cold connection. Paint
  // it now so nobody reads a retired board as live in that window.
  syncHeader();

  const el = (id: string) => document.getElementById(id) as HTMLElement;

  // The "For Your Review" pane — the first real Preact island (contract per
  // island-probe: it owns a wrapper inside #hub-home-review, and no vanilla
  // code may wipe that container while the island lives in it). Mounted once,
  // here, because buildShell above was the last vanilla write of this subtree;
  // from now on the pane repaints itself from `homeReviewData` writes in
  // renderHomeRegion. The handlers are hoisted function declarations below —
  // the same stable closures the vanilla renderer received.
  mountHomeReviewIsland(el('hub-home-review'), {
    onReview: (item, index) => openInQueue(item, index),
    onOpen: (item) => openReviewItem(item),
    onOpenThread: (item) => void openReviewThread(item),
    onWalkthrough: () => startWalkthrough(),
  });

  // "Recent activity" — the second island on Home, under the queue and above
  // the brief (approved mock, 2026-08-29). Same contract, same mount-once
  // reason. Its one handler opens the task the way a queue row does;
  // `boardHandlers` is declared below and only read when a row is tapped.
  mountHomeActivityIsland(
    el('hub-home-activity'),
    {
      onOpenTask: (taskId) => {
        const task = state.tasks.get(taskId);
        // On the Activity tab: the reader was looking at what happened to
        // the task, and the panel opens on the rest of that.
        if (task) openTaskDetail(task, 'activity');
      },
      onComment: (taskId, phrase, text) => commentOnActivity(taskId, phrase, text),
      onReply: (taskId, threadId, text) => replyOnActivity(taskId, threadId, text),
    },
    user,
  );

  // The card that pane opens on — the walkthrough. Mounted once for the
  // reason the board island is: this surface is repainted by every board
  // event, and everything the card holds (a half-typed answer, an expansion
  // the reader opened) used to die with the nodes each repaint replaced.
  // It takes no handlers here; they change per paint and ride the signal.
  mountWalkthroughIsland(el('hub-walkthrough'));

  // The task detail panel. Mounted once for the same reason again: it is
  // repainted by every `thread.*` and `task.transitioned` event, and the tab,
  // the review queue's position, an unfolded capture and every half-typed
  // draft used to die with the nodes each repaint replaced. Handlers ride
  // `taskDetailData` — they close over the task, the review rows and the clock
  // this paint resolved.
  mountTaskDetailIsland(el('hub-detail'));
  mountGoalDetailIsland(el('hub-goal-detail'));

  // The presence strip, in both places it renders: who is here in the
  // top-right cluster, and the drift notices in the settings panel. Same
  // contract, and mounted once for the same reason — the strip repaints on
  // every awareness update and a 30s tick, and a rebuilt circle used to drop
  // the long-press running on it.
  mountPresenceIsland(
    el('hub-people'),
    {
      onTap: (chip) => {
        if (chip.docId) location.assign(`/review/${encodeURIComponent(chip.docId)}`);
      },
      onLongPress: (chip) => {
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
      onOverflow: (hiddenChips) =>
        showToast(`Also here: ${hiddenChips.map((c) => c.label).join(', ')}`),
    },
    { compact: true },
  );
  mountDriftIsland(el('hub-drift'));

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
    // Already awaited above — the description box is never live before the
    // answer, and never live after a "no".
    canWrite: writeAccess.canWrite,
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
        goals: (wsMap.get('goals') as HubGoal[] | undefined) ?? [],
        ...(wsMap.get('leadAgentId') ? { leadAgentId: String(wsMap.get('leadAgentId')) } : {}),
        ...(wsMap.get('retiredAt') ? { retiredAt: Number(wsMap.get('retiredAt')) } : {}),
        ...(wsMap.get('retiredReason')
          ? { retiredReason: String(wsMap.get('retiredReason')) }
          : {}),
        createdAt: Number(wsMap.get('createdAt') ?? 0),
      };
    }
    syncHeader();
    syncTabTitle();
  }

  /**
   * The board's name and its retired badge, repainted from current state.
   * Called from both writers of what it reads — the boot fetch and every
   * projection read — because a header set once is wrong the moment somebody
   * renames or retires the board, and this page never reloads.
   */
  function syncHeader(): void {
    renderWorkspaceIdentity(
      document.getElementById('hub-ws-name-text'),
      document.getElementById('hub-retired-badge'),
      state.info,
      workspaceId,
    );
  }

  /**
   * Name the browser tab after this workspace and the pane showing in it.
   *
   * Called from both writers of what it reads — `setNav` (the reader moved)
   * and `readProjection` (the workspace was renamed under them) — because a
   * title set once at boot is wrong the moment either happens, and this page
   * never reloads.
   */
  function syncTabTitle(): void {
    document.title = hubTabTitle(state.info?.name ?? workspaceId, state.nav);
  }

  // ── Region renders ──────────────────────────────────────────────────────
  const taskList = () => [...state.tasks.values()];
  const titleOf = (taskId: string) => state.tasks.get(taskId)?.title ?? taskId;

  /** The one opener behind every task tap — board row, queue row, Home
   *  activity pane — so the panel opens the same way from each, with only
   *  the landing tab differing. */
  function openTaskDetail(task: HubTask, tab: DetailTab = 'comments'): void {
    state.detailTaskId = task.id;
    state.detailTab = tab;
    state.detailGoalId = null;
    // Opening the task any other way clears the queue's aim, so a mark left
    // over from the last walkthrough item can't point at the wrong thread.
    state.detailThreadId = null;
    renderDetail();
  }

  const boardHandlers: BoardHandlers = {
    onStatusSet: (task: HubTask, to: HubTask['status']) => void transitionTask(task, to),
    onGoalTitleCommit: (sectionId: string, title: string) => void retitleGoal(sectionId, title),
    onGoalAdd: (title: string, after?: string) => void addGoal(title, after),
    // The goal row's one gesture on a coarse pointer, and the desktop click
    // anywhere off the title's words (decision 4). The two panels share the
    // detail container, so opening a goal closes any task.
    onOpenGoal: (section: BoardSection) => {
      state.detailGoalId = section.id;
      state.detailTaskId = null;
      state.detailThreadId = null;
      renderDetail();
    },
    onOpenTask: (task: HubTask) => openTaskDetail(task),
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
   *
   * Returns whether the reader is still on THIS page afterwards — false only
   * for the doc jump, which leaves via location.assign. The walkthrough's
   * hand-off keys its card repaint on it (see onOpenItem).
   *
   * `returnItem` is the reader's place in the review queue, and only the
   * walkthrough passes one. It rides the doc's URL so the doc's back arrow
   * can bring them back to the sitting rather than to the bare board — the
   * doc page has no referrer and cannot work this out for itself. Every other
   * caller omits it, which is what keeps a doc opened from a board row (or a
   * pasted link) from returning a visitor into a queue they were never in.
   */
  function openReviewItem(item: ReviewItem, returnItem?: string | null): boolean {
    // `reviewRow` is the one reader for "which task is this row about", so a
    // future band that carries a task row cannot land in the strip with a
    // chip that taps into nothing.
    const row = reviewRow(item);
    if (row) {
      boardHandlers.onOpenTask(row.task);
      return true;
    }
    const t = item.thread;
    if (!t) return true;
    if (t.kind === 'task-review') {
      // A ticket-borne review item lives on the TASK — there is no thread to
      // aim at, so the panel itself is the place. Without this branch the
      // fall-through below navigated to `/review/undefined`.
      const task = t.taskId ? state.tasks.get(t.taskId) : undefined;
      if (task) boardHandlers.onOpenTask(task);
      return true;
    }
    if (t.kind === 'goal-thread' && t.taskId) {
      // The goal PANEL, not the task panel and not the raw doc: the row is a
      // band, and the question was asked about the band. Aim at the queued
      // thread the same way a task row does — landing on the panel top is the
      // "now go find it" the queue exists to remove.
      state.detailGoalId = t.taskId;
      state.detailTaskId = null;
      state.detailThreadId = t.threadId;
      renderDetail();
      return true;
    }
    if (t.kind === 'task-thread') {
      const task = t.taskId ? state.tasks.get(t.taskId) : undefined;
      if (!task) return true;
      boardHandlers.onOpenTask(task);
      // The task is the container; the thread is the errand. On a task with
      // six discussions, landing on the panel top is the same "now go find
      // it" the strip exists to remove — so aim at the one that was queued.
      state.detailThreadId = t.threadId;
      renderDetail();
      return true;
    }
    // The doc's canonical workspace address rather than the legacy `/review/`
    // one, so what lands in the reader's address bar is the shape every other
    // surface emits and the link-chip renderer titles.
    const back = returnItem ? `&item=${encodeURIComponent(returnItem)}` : '';
    location.assign(
      `/workspaces/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(t.docId)}?thread=${encodeURIComponent(t.threadId)}${back}`,
    );
    return false;
  }

  /**
   * The thread a question on a review item lives on — the reader's question
   * and the owner's reply, where they were written. A ticket-borne item's
   * threads are on its task's doc, so this is the task panel aimed at that
   * thread, the way a `task-thread` row opens. Anything without a thread to
   * aim at falls back to opening the item itself. Same return contract as
   * `openReviewItem`: whether the reader is still on this page.
   */
  function openReviewThread(item: ReviewItem, returnItem?: string | null): boolean {
    const t = item.thread;
    const threadId = item.revision?.threadId ?? t?.threadId;
    if (!t || t.kind !== 'task-review' || !t.taskId || !threadId)
      return openReviewItem(item, returnItem);
    return openTaskThread(t.taskId, threadId);
  }

  /** The task panel, aimed at one thread on it — the shared tail of
   *  `openReviewThread` and the stale-view fallback below, which knows the
   *  OPEN thread's id from a 409 rather than from the item's own fields. */
  function openTaskThread(taskId: string, threadId: string): boolean {
    const task = state.tasks.get(taskId);
    if (!task) return true;
    boardHandlers.onOpenTask(task);
    state.detailThreadId = threadId;
    renderDetail();
    return true;
  }

  /** Everyone a task can be handed to besides a person: the agents attached
   *  to this workspace, plus the lead (who owns goal changes here and is
   *  therefore somebody, whether or not their session is currently up). */
  function knownAgentIds(): string[] {
    const lead = state.info?.leadAgentId;
    return [...new Set([...state.agents.map((a) => a.agentId), ...(lead ? [lead] : [])])];
  }

  function renderLead(): void {
    renderLeadStrip(
      el('hub-lead'),
      state.info?.leadAgentId,
      state.agents.map((agent) => agent.agentId),
      { onLeadCommit: (leadAgentId) => void saveLead(leadAgentId) },
      state.seat ?? undefined,
    );
  }

  /**
   * Show or leave the restore list, and put it in the address bar.
   *
   * A filter on the board rather than a page: `historyStep` answers `replace`
   * for it, so Back still leaves the workspace rather than unwinding a list
   * somebody glanced at.
   */
  function setShowArchived(on: boolean): void {
    if (state.showArchived === on) return;
    state.showArchived = on;
    syncBoardUrl();
    renderBoardRegion();
  }

  /** The board state the URL names, read whole. `renderDetail`'s task-wins
   *  rule and the walkthrough's "-1 means closed" are folded in here so the
   *  address never claims a panel the screen is not showing. */
  function currentBoardLocation(): BoardLocation {
    const panel = state.detailTaskId ?? state.detailGoalId;
    return {
      nav: state.nav,
      task: state.detailTaskId,
      goal: state.detailTaskId ? null : state.detailGoalId,
      thread: panel ? state.detailThreadId : null,
      item: state.walkIndex >= 0 ? state.walkKey : null,
      archived: state.showArchived,
    };
  }

  /**
   * The one writer of the address bar. Reads the whole board state, asks
   * `historyStep` whether the change is a new place (push), a rewrite of the
   * current one (replace), or a resource closing, and writes accordingly —
   * every state change the URL can name funnels through here (`renderDetail`,
   * `renderWalkthrough`, `setNav`, `setShowArchived`), so the address bar is
   * always the deep link to what is on screen.
   *
   * Closing unwinds with Back only when THIS document pushed the entry — the
   * marker rides `history.state`. A panel arriving by pasted link is the
   * session's first entry, and Back from it would leave the app; that case
   * rewrites to the clean board URL instead. (`?task=` was replaceState-only
   * for exactly that fear; the marker is what makes push safe.)
   */
  function syncBoardUrl(): void {
    // While popstate applies an entry, the URL is the input, not the output.
    // While a boot ?item= waits for its queue, the renders that have not
    // opened it yet must not strip the param they have not honoured.
    if (applyingHistory || pendingBootItem) return;
    const next = currentBoardLocation();
    const step = historyStep(urlLoc, next);
    const closing = resourceOf(urlLoc);
    urlLoc = next;
    const url = buildBoardUrl(workspaceId, next, location.search);
    const here = `${location.pathname}${location.search}`;
    if (step === 'push') {
      if (url !== here) history.pushState({ res: resourceOf(next) }, '', url);
    } else if (step === 'close') {
      if ((history.state as { res?: string } | null)?.res === closing) history.back();
      else history.replaceState(null, '', url);
    } else if (url !== here) {
      history.replaceState(history.state, '', url);
    }
  }

  /**
   * URL → state, for Back/Forward. The inverse of `syncBoardUrl`, and
   * idempotent: it re-renders whatever the entry names, so landing on a state
   * the click path already produced paints nothing new.
   */
  function applyHistoryLocation(): void {
    const loc = parseBoardLocation(location.pathname, location.search);
    applyingHistory = true;
    try {
      setNav(loc.nav, false);
      setShowArchived(loc.archived);
      state.detailTaskId = loc.task;
      state.detailGoalId = loc.goal;
      state.detailThreadId = loc.thread;
      if (loc.item) {
        // Aim the walkthrough where the entry says. If the item was answered
        // since, `walkPosition`'s index fallback lands the reader nearby.
        state.walkProgress = { cleared: 0, last: null };
        state.walkKey = loc.item;
        state.walkIndex = Math.max(state.walkIndex, 0);
      } else if (state.walkIndex >= 0) {
        closeWalkthrough();
      }
      renderWalkthrough();
      renderDetail();
    } finally {
      applyingHistory = false;
    }
    urlLoc = loc;
  }

  function renderBoardRegion(): void {
    const filters = {
      tab: state.tab,
      userName: user.name,
      doneWindow: state.doneWindow,
      now: Date.now(),
    };
    // No focus save/restore here any more. It used to bracket this whole
    // function — snapshot the focused row's task id and whether the drag
    // handle held it, then find the row again afterwards by scanning every
    // `.hub-task-row` — because the vanilla renderer replaced every row on
    // every paint and keyboard reordering died after one press. The rows are
    // keyed Preact now: an unchanged row is the identical node, so a repaint
    // leaves focus where it was without anyone asking. What the keyed diff
    // still does is MOVE a reordered row, and re-inserting a node blurs it in
    // WebKit and Blink — that one case is handled inside the island, on the
    // node itself (see `Board`'s focus effect), which is a re-focus of a
    // reference rather than a search for a replacement.
    const archived = archivedTasks(taskList());
    const archivedBands = archivedGoals(state.info?.goals ?? []);
    const showArchived = state.pane === 'board' && state.showArchived;
    // The restore list is still a vanilla renderer, so it gets its OWN
    // container: no vanilla code may `replaceChildren` a node holding a live
    // island, and `#hub-board` is the island's host for the life of the page.
    el('hub-board').classList.toggle('hidden', showArchived);
    el('hub-archived').classList.toggle('hidden', !showArchived);
    if (showArchived) {
      renderArchivedList(
        el('hub-archived'),
        archived,
        {
          onRestore: (task) => void restoreTask(task),
          onOpenTask: (task) => boardHandlers.onOpenTask(task),
          onBack: () => setShowArchived(false),
          // A band opens the goal panel, which is where its Archived note and
          // its own Restore live — the same "the title still opens the row"
          // rule the task rows follow, for the same reason: the discussion on
          // an archived row is often why somebody came looking.
          onRestoreGoal: (goal) => {
            const s = goalSection(state.info?.goals ?? [], goal.id);
            if (s) void restoreGoal(s);
          },
          onOpenGoal: (goal) => {
            state.detailGoalId = goal.id;
            state.detailTaskId = null;
            renderDetail();
          },
        },
        archivedBands,
      );
    }
    // The island's one input. `pane` rides along rather than gating the write:
    // Home hides the board column outright, and a row built into it is a node
    // with listeners nobody can see — but the signal is still the only place
    // the board's state lives, so the island is what decides to draw nothing.
    // The agent list is read HERE, at paint time, for the same reason it
    // always was: attachments arrive after the first paint and change while
    // the board is open, and a picker built from a stale list offers agents
    // who have left.
    boardData.value = {
      sections: boardSectionsWithEffort(state.info?.goals ?? [], taskList(), filters, filters.now),
      pane: state.pane,
      showArchived,
      knownAgentIds: knownAgentIds(),
      // Bands count too: the chip is the way back to the restore list, and a
      // board whose only archived thing is a goal must not read "0 archived"
      // and hide the door.
      archivedCount: archived.length + archivedBands.length,
    };
    // No "N tasks have no goal yet" strip above the board any more (Bryan,
    // 2026-08-29, by voice: it "is taking out space and all of it's not
    // useful"). Backlog already holds every unplaced row; `unplacedNotice`
    // stays in the model for the lead's tools, and nothing here draws it.
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
    state.walkHold = null;
    state.walkIndex = 0;
    state.walkKey = currentQueue().items[0]?.key ?? null;
    renderWalkthrough();
  }

  /**
   * Tapping a row on Home: open the queue's card ON that row, in place.
   *
   * The same surface `Review All` opens, aimed at the item the reader pointed
   * at rather than at the top — one card anatomy, one answer path, and the
   * reader stays on Home. `walkKey` is what actually holds the aim; the index
   * is the fallback for the repaint after the item leaves the queue.
   */
  function openInQueue(item: ReviewItem, index: number): void {
    // A new sitting, exactly as `Review All` starts one: the tally counts what
    // this pass cleared, and a leftover count would open on "4 cleared".
    state.walkProgress = { cleared: 0, last: null };
    state.walkHold = null;
    state.walkIndex = index;
    state.walkKey = item.key;
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
    // The island's one input. A plain signal write, not a render call: the
    // pane re-renders itself, keyed on `ReviewItem.key`, so unchanged rows
    // keep their DOM nodes. Background events still reach this line through
    // `repaintGuard.schedule(...)` exactly as they reached the old renderer —
    // the guard's parked/flush path is upstream of the write, not bypassed.
    const queue = currentQueue();
    const now = Date.now();
    homeReviewData.value = {
      queue,
      settled: [...state.homeSettled.values()],
      now,
    };
    // The activity pane's one input: the projection as it stands, plus what
    // the queue above is already asking so the pane never says it twice. The
    // island groups and flags; this line only hands over the facts.
    homeActivityData.value = {
      tasks: taskList(),
      goals: state.info?.goals ?? [],
      asks: asksOf(queue.items),
      now,
    };
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
    state.nav = nav;
    state.pane = paneForNav(nav);
    // Leaving the board leaves the restore list. It is a view OF the board,
    // so carrying it across a nav tap would put a reader back on it later
    // with no memory of having asked.
    if (state.showArchived) setShowArchived(false);
    state.view = nav === 'activity' ? 'activity' : 'board';
    const tab = tabForNav(nav);
    if (tab !== undefined) state.tab = tab;
    // Arriving at Home means arriving at the TOP of Home: `/workspaces/<id>/home`
    // names the Home page, and the walkthrough's own address is that page plus
    // `?item=`. Unconditional — tapping Home while already on Home is exactly
    // the case that used to do nothing at all, with the reader stuck on a
    // review card and only its own close button out.
    if (nav === 'home') closeWalkthrough();
    // The address follows the state: a changed destination is a push, a
    // same-nav tap rewrites in place, and the walkthrough the line above
    // closed unwinds — `historyStep` owns the distinction, so `same` gates
    // nothing here any more. `push=false` is the popstate path, where the URL
    // is the input rather than the output.
    if (push) syncBoardUrl();
    syncTabTitle();
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
    // Through the guard: the generating-brief poll below re-runs this every
    // 1.5s, and Home is exactly the surface whose option buttons a mid-press
    // repaint was eating.
    repaintGuard.schedule(renderHomeRegion);
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
    // a button that swapped ONE div, so the capture box and the review strip
    // stayed on screen over a feed they have nothing to do with.
    for (const id of ['hub-quick', 'hub-decisions', 'hub-archived']) {
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

  /**
   * The element that opened the panel, so closing it puts the keyboard back
   * where it was.
   *
   * The panel takes focus when it opens (see `renderTaskDetail` — that is what
   * makes hold-Space work inside it), so without this, Escape would drop a
   * keyboard reader at the top of the document and the j/k walk they were in
   * the middle of would restart from row one.
   */
  let detailOpener: HTMLElement | null = null;
  /** Which task the panel is CURRENTLY showing, so open and close are
   *  distinguishable from a repaint. */
  let renderedDetailId: string | null = null;
  /** Which task the panel has already fetched audit rows for — one fetch per
   *  open, and the guard that keeps the fetch's own re-render from looping. */
  let detailEventsFor: string | null = null;
  /** Which GOAL the shared container is currently showing, so open, repaint
   *  and close are distinguishable — the goal panel's `renderedDetailId`. */
  let renderedGoalId: string | null = null;

  /**
   * Close the task panel — the island's own "no task" state.
   *
   * `handOverEditor` is for the one case where something ELSE is taking the
   * body editor in the same turn: the goal panel mounts it synchronously,
   * while this write's effect lands a microtask later, so without the hand-off
   * the closing task panel would report a null slot and unmount the goal's
   * editor from under it.
   */
  function closeTaskPanel(handOverEditor = false): void {
    const handlers = { ...taskDetailData.value.handlers };
    // `undefined` rather than `delete`: the island reaches this through
    // `handlers.onBodySlot?.(…)`, so an absent key and an undefined one are
    // the same absence to every reader of it.
    if (handOverEditor) handlers.onBodySlot = undefined;
    taskDetailData.value = { task: null, handlers };
  }

  /**
   * Reading-time capture for the open ticket — the same tracker the markdown,
   * redline and code surfaces mount, pointed at the task's body room.
   *
   * A ticket is a PANEL rather than a page, so there is no load to hang a
   * tracker off and no unload to flush it: this is the lifecycle. It is keyed
   * on the task id and called from every path that changes what the panel
   * shows, so a repaint — and `renderDetail` runs on every board event and
   * clock tick — is a no-op, while an open, a close, and a tap straight from
   * one row to another each do the right thing. The disposer flushes any
   * in-flight session, so closing a ticket banks its read rather than losing
   * it.
   */
  let readTracker: { taskId: string; stop: () => void } | null = null;
  function syncReadTracker(taskId: string | null, bodyDocId?: string): void {
    if (readTracker?.taskId === taskId) return;
    readTracker?.stop();
    readTracker = null;
    if (!taskId || !bodyDocId) return;
    const host = document.getElementById('hub-detail');
    if (!host) return;
    readTracker = {
      taskId,
      stop: startReadingTracker({
        docId: bodyDocId,
        user,
        // `.hub-detail-panel` is the element with `overflow: auto`, so it is
        // what scroll depth means here. A getter, not the element: this runs
        // during the signal write that opens the panel, and the panel is not
        // painted until a microtask later.
        scrollEl: () => host.querySelector<HTMLElement>('.hub-detail-panel'),
        // Scoped to the panel: the board is still behind it, and scrolling
        // the rows is not reading the ticket.
        root: host,
      }),
    };
  }

  function renderDetail(): void {
    // Task wins when both ids are somehow set: the deep-link and voice paths
    // set a task id without knowing a goal panel was open, and what they mean
    // is "show me this task".
    if (state.detailTaskId) state.detailGoalId = null;
    if (state.detailGoalId) {
      // Unfiltered on purpose: the panel's counts and advisory are facts
      // about the GOAL ("what would a done declaration leave open"), not
      // about whatever tab or done-window the board happens to be on.
      const section =
        boardSections(state.info?.goals ?? [], taskList(), {
          tab: 'all',
          userName: user.name,
          doneWindow: 'all',
          now: Date.now(),
        }).find((s) => s.id === state.detailGoalId) ??
        // An ARCHIVED band is on no board and so in no section — and the panel
        // is exactly where its Restore lives, reached from the restore list or
        // from a link somebody sent last week. `goalSection` is the lookup that
        // does not apply "off the board", the way `state.tasks` is for a task.
        goalSection(state.info?.goals ?? [], state.detailGoalId);
      if (section && !section.isChores) {
        if (renderedGoalId === null && renderedDetailId === null) {
          const active = document.activeElement;
          detailOpener = active instanceof HTMLElement && active !== document.body ? active : null;
        }
        // The goal's comments, fetched the same lazy way a task's are and
        // guarded by the same id — one fetch per open, and the guard is what
        // stops the fetch's own re-render from looping back through here.
        if (state.discussionTaskId !== section.id) {
          void loadDiscussion({ id: section.id, bodyDocId: goalBodyDocId(section) });
        }
        // Only a discussion that belongs to the goal on screen: an in-flight
        // load for a row the reader has left must not paint under this one.
        const goalDiscussion =
          state.discussionTaskId === section.id ? state.discussion : { loading: true, threads: [] };
        // The task panel closes first: the two share the screen, never the
        // container, so nothing else empties the island's host any more.
        closeTaskPanel(true);
        // A goal opening over a ticket ends the read of that ticket — this is
        // the one close that does not run through the task path below.
        syncReadTracker(null);
        goalDetailData.value = {
          section,
          discussion: goalDiscussion,
          handlers: {
            onClose: () => {
              state.detailGoalId = null;
              renderDetail();
            },
            onTitleCommit: (goalId, title) => void retitleGoal(goalId, title),
            onStatusSet: (goalId, to) => void transitionGoal(goalId, to),
            onComment: (goalId, text, threadId) =>
              postRowComment({ id: goalId, bodyDocId: goalBodyDocId(section) }, text, threadId),
            // The goal's description is a live room like a task's, so the SAME
            // editor host drives it — one mount at a time, which is what makes
            // "a body editor left mounted by the last open row" impossible
            // rather than something this branch has to remember to tear down.
            // The panel reports its own slot: a signal write does not paint
            // synchronously, so nothing out here can know when the slot exists.
            onBodySlot: (row, slot) =>
              bodyEditor.sync(
                row === null
                  ? null
                  : {
                      id: row.id,
                      bodyDocId: goalBodyDocId(row),
                      placeholder: GOAL_PLACEHOLDER_TEXT,
                    },
                slot,
              ),
            onCopyLink: (s) => void copyGoalLink(s),
            onCascadeCount: (goalId) => goalCascadeCount(goalId),
            onArchive: (s) => void archiveGoal(s),
            onRestore: (s) => void restoreGoal(s),
            ...(state.detailThreadId ? { focusThreadId: state.detailThreadId } : {}),
            now: Date.now(),
          },
        };
        // A deep-linked thread aim that the loaded discussion does not hold
        // is gone, not loading — drop it gracefully, once.
        if (state.discussionTaskId === section.id && !goalDiscussion.loading) {
          noteStaleBootThread(goalDiscussion);
        }
        renderedGoalId = section.id;
        renderedDetailId = null;
        detailEventsFor = null;
        syncBoardUrl();
        return;
      }
      // The goal left the board under us (removed from the list, or the
      // projection has not caught up) — fall through to an empty panel. A
      // boot deep link is the second case by construction, so its claim
      // survives until the deadline in main() gives up on it.
      if (state.detailGoalId !== pendingBootGoal) state.detailGoalId = null;
    }
    // Past this point the goal panel is not what is showing, and its container
    // is its own — so it has to be told to close rather than being replaced.
    goalDetailData.value = {
      section: null,
      handlers: { onClose: () => {}, onTitleCommit: () => {}, onStatusSet: () => {} },
    };
    const task = state.detailTaskId ? (state.tasks.get(state.detailTaskId) ?? null) : null;
    // An open-time act for ONE row: a row tap on any other task, or the panel
    // closing, ends it — reopening the same row later must not start a rename.
    if (state.detailTaskId !== focusTitleTaskId) focusTitleTaskId = null;
    if (task && renderedDetailId === null) {
      const active = document.activeElement;
      detailOpener = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    // Fetch here rather than at each of the four places that open the panel
    // (row tap, `o`, deep link, voice navigate) — one of them would be missed
    // otherwise, and the miss looks like a task with no discussion. Safe from
    // recursion: loadDiscussion claims the id before it re-renders.
    if (task && state.discussionTaskId !== task.id) {
      void loadDiscussion(task);
    }
    if (!task) state.discussionTaskId = null;
    // Every way the panel closes — the X, a goal opening over it, the task
    // being archived under it — lands here with no task; the next open
    // starts on Comments unless its opener says otherwise.
    if (!task) state.detailTab = 'comments';
    // The audit rows the Activity tab renders. Fetched on open rather than at
    // boot: a reader who never opens a ticket never needs them, and the
    // workspace Activity VIEW has always fetched them the same lazy way.
    // Guarded by task id, which is also what stops `loadEvents`'s own
    // re-render from coming back round here.
    if (task && detailEventsFor !== task.id) {
      detailEventsFor = task.id;
      void loadEvents();
    }
    if (!task) detailEventsFor = null;
    // Only pass a discussion that belongs to the task on screen. An in-flight
    // load for a task the reader has left must not paint under this one.
    const discussion =
      task && state.discussionTaskId === task.id
        ? state.discussion
        : { loading: true, threads: [] };
    // A deep-linked thread aim that the loaded discussion does not hold is
    // gone, not loading — drop it gracefully, once, leaving the panel open.
    if (task && state.discussionTaskId === task.id && !discussion.loading) {
      noteStaleBootThread(discussion);
    }
    taskDetailData.value = {
      task,
      discussion: task ? discussion : undefined,
      tab: state.detailTab,
      // Learned from the WHOLE board, not from this ticket's band: the panel
      // reports what the estimate was scaled by, and the scaling is a property
      // of everything that has closed. Unfiltered for the same reason the goal
      // rollup is — a correction that moved when the reader changed tabs would
      // be a correction about the reader.
      calibration: task ? boardCalibration(state.info?.goals ?? [], taskList()) : undefined,
      // The band the row renders under, which is the key its correction was
      // filed under. A ticket whose goal id matches no band shows Backlog's
      // arithmetic, exactly as it shows under Backlog on the board.
      calibrationGoal: task
        ? bandOfGoal(goalBandIds(state.info?.goals ?? []), task.goal)
        : undefined,
      handlers: {
        onClose: () => {
          state.detailTaskId = null;
          state.detailTab = 'comments';
          state.detailThreadId = null;
          renderDetail();
        },
        onCopyLink: (t) => void copyTaskLink(t),
        onStatusSet: (t, to) => void transitionTask(t, to),
        onTitleCommit: (t, title) => void renameTask(t, title),
        onAnswer: (t, text, optionId) => answerTaskDecision(t, text, optionId),
        onAnswerThread: (t, item, text, optionId) => answerPanelThreadItem(t, item, text, optionId),
        onUndoAnswer: (t) => undoTaskAnswer(t),
        onReleaseHeld: (t, item) => releaseHeldReviewItem(t, item),
        onUndoThreadAnswer: (t, item) => undoThreadAnswer(t, item),
        // So the answered record can say "Answered by you" for the reader's
        // own answer — the record compares display names, same as answer.by.
        selfName: author.name,
        ...(task ? { focusTitle: focusTitleTaskId === task.id } : {}),
        onAssign: (t, assignee) => void assignTask(t, assignee),
        knownAgentIds: knownAgentIds(),
        goalLabel: (id) => goalLabel(state.info?.goals ?? [], id),
        goals: state.info?.goals ?? [],
        onGoalSet: (t, goalId) => void setTaskGoal(t, goalId),
        onDueSet: (t, dueAt) => void setTaskDue(t, dueAt),
        onArchive: (t) => void archiveTask(t),
        onRestore: (t) => void restoreTask(t),
        onComment: (t, text, threadId) => postRowComment(t, text, threadId),
        // The Activity feed takes comments the way the Home pane does — the
        // same two writes, the same thread on the task's doc.
        onActivityComment: (t, phrase, text) => commentOnActivity(t.id, phrase, text),
        onActivityReply: (t, threadId, text) => replyOnActivity(t.id, threadId, text),
        user,
        ...(state.detailThreadId ? { focusThreadId: state.detailThreadId } : {}),
        // This task's rows from the review queue the strip already reads, so
        // the panel says the same thing the row that sent them here said.
        // `panelAsks` owns which rows qualify — by taskId, thread-borne and
        // ticket-borne alike, minus the derived legacy copy of the task's own
        // decision.
        asks: task ? panelAsks(state.reviewItems, task.id) : [],
        // A blocker is task state (design point 5): when the open task is a
        // person's own open work other tasks wait on, the panel — and only
        // the panel — says so, via the amber blocked note.
        blocked: task ? humanBlockerRows(taskList()).find((r) => r.task.id === task.id) : undefined,
        // The workspace's audit rows; the panel takes this task's out of them.
        // The same list the Activity view reads — one log, two surfaces.
        activity: state.events,
        now: Date.now(),
        // The panel reports its own slot, because a signal write does not
        // paint synchronously: reading `.hub-detail-body-slot` off the DOM on
        // the next line would find the slot as it stood BEFORE this write.
        // Idempotent for an unchanged pair, so the repaints that arrive while
        // somebody is typing cost nothing.
        onBodySlot: (t, slot) =>
          bodyEditor.sync(t ? { id: t.id, bodyDocId: t.bodyDocId } : null, slot),
      },
    };
    if (!task && (renderedDetailId !== null || renderedGoalId !== null)) {
      if (detailOpener?.isConnected) detailOpener.focus();
      detailOpener = null;
    }
    syncBoardUrl();
    // Open, close, and row-to-row all land here; keyed on the id, so the
    // repaints in between cost nothing.
    syncReadTracker(task?.id ?? null, task?.bodyDocId);
    renderedDetailId = task?.id ?? null;
    renderedGoalId = null;
  }

  /**
   * A boot deep link's `?thread=` aim, checked once against a discussion that
   * has actually loaded: absent then means gone (resolved away, or a stale
   * paste), and the graceful fallback is the panel without the aim — plus a
   * word about it, because a silent nothing reads as a broken link.
   */
  function noteStaleBootThread(discussion: TaskDiscussion): void {
    if (!bootThreadPending || !state.detailThreadId) return;
    bootThreadPending = false;
    if (discussion.threads.some((t) => t.id === state.detailThreadId)) return;
    state.detailThreadId = null;
    showToast('That comment thread is gone — the link may be outdated.');
  }

  /**
   * Clipboard write, with a fallback that is a real fallback: `writeText`
   * rejects on an insecure origin and in a few embedded webviews, and a "Copied"
   * toast over an empty clipboard is worse than no button. When it fails the
   * toast carries the URL itself, which is at least selectable.
   */
  async function copyTaskLink(task: HubTask): Promise<void> {
    const url = taskUrl(task.id);
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied');
    } catch {
      showToast(url);
    }
  }

  /** The same for a band. Separate only because the URL is — the clipboard
   *  refusal is handled identically, by showing the link so it can be copied
   *  by hand. */
  async function copyGoalLink(section: BoardSection): Promise<void> {
    const url = goalUrl(section.id);
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied');
    } catch {
      showToast(url);
    }
  }

  // ── Task discussion ─────────────────────────────────────────────────────

  /**
   * A row and its live body room — the only two things the discussion and the
   * description editor ever needed from a task, which is why a GOAL reaches
   * both through the same functions.
   */
  interface DiscussionRow {
    id: string;
    bodyDocId: string;
  }

  /**
   * Where a goal's description and comments live.
   *
   * Prefers what the projection sent, and falls back to deriving it. The
   * fallback is not defensive padding: a board served by a server that
   * predates the goal-body projection carries no `bodyDocId`, and without it
   * the panel would fetch `/api/docs//threads` and mount an editor on
   * nothing. Deriving is safe because the shape is a DECISION rather than a
   * lookup — `task:<goalId>`, settled in the goals-as-a-task-type design.
   */
  const goalBodyDocId = (section: { id: string; bodyDocId?: string }): string =>
    section.bodyDocId ?? `task:${section.id}`;

  /**
   * A row's comments live in its body doc (`task:<rowId>` for a task and for a
   * goal alike), so this is the ordinary thread API pointed at that room — no
   * second store, and the same threads an agent sees through `create_thread`.
   */
  async function loadDiscussion(task: DiscussionRow, quiet = false): Promise<void> {
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
        comments?: Array<{
          id?: string;
          author?: { name?: string };
          text?: string;
          ts?: number;
          review?: ReviewPayload;
        }>;
      }>;
    }>(`/api/docs/${encodeURIComponent(task.bodyDocId)}/threads`);
    // The reader may have moved on while this was in flight.
    if (state.discussionTaskId !== task.id) return;
    // Only the id and the words. The payload also carries each thread's
    // status and anchor, and the discussion model deliberately does not:
    // the panel renders every comment as a peer of every other, so the
    // fields fed nothing — see `TaskThread` in hub-render.
    const threads: TaskThread[] = (payload?.threads ?? []).map((t) => ({
      id: t.id,
      comments: (t.comments ?? []).map((c) => ({
        // The id is what the answered record's Undo names on the undo route;
        // absent from an older server's payload, and the record then renders
        // without the button rather than with one that could only fail.
        ...(c.id !== undefined ? { id: c.id } : {}),
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
   *  text until it hears yes, so a failed post is retryable. Takes a row
   *  rather than a task: a goal's discussion posts through the same route. */
  async function postRowComment(
    task: DiscussionRow,
    text: string,
    threadId?: string,
  ): Promise<boolean> {
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
   * Put the walkthrough away and forget the sitting's tally.
   *
   * Does not render — the two callers render different amounts afterwards
   * (`setNav` repaints every region anyway), and a render in here would run
   * twice on the path that matters.
   */
  function closeWalkthrough(): void {
    state.walkIndex = CLOSED_WALK.index;
    state.walkKey = CLOSED_WALK.key;
    state.walkProgress = { cleared: 0, last: null };
    state.walkHold = null;
  }

  /**
   * Open one of the walkthrough's own items, and leave the walk aimed for
   * whichever way the reader then goes.
   *
   * Close-in-state first, but render the OPEN first: the close and the open
   * are one user action, and they must reach `syncBoardUrl` as one step
   * (walk → panel, a push). Rendering the close ahead of the open wrote a
   * `close` step whose `history.back()` — an async traversal — landed after
   * the open's `pushState`, and its popstate re-applied the old `?item=`
   * entry: the tapped task closed itself and the reader bounced back to Home.
   *
   * When the item is a DOC the opener leaves the page instead, and the card
   * repaint is skipped outright — a close-step `back()` queued beside
   * `location.assign` races it. That is why the close is undone on that path
   * (`walkAimAfterOpen`): nothing rendered, so it bought nothing, and the
   * closed state is exactly what bfcache freezes for the trip back.
   *
   * The aim doubles as the return address handed to the opener, so the doc
   * can point its back arrow at the queue. Only an OPEN walk has one to give.
   */
  function openFromWalk(open: (returnItem: string | null) => boolean): void {
    const aim: WalkAim = { index: state.walkIndex, key: state.walkKey, hold: state.walkHold };
    const back = aim.index >= 0 ? aim.key : null;
    state.walkIndex = CLOSED_WALK.index;
    state.walkKey = CLOSED_WALK.key;
    state.walkHold = null;
    const stillHere = open(back);
    const next = walkAimAfterOpen(aim, stillHere);
    state.walkIndex = next.index;
    state.walkKey = next.key;
    state.walkHold = next.hold;
    if (stillHere) renderWalkthrough();
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
    // The item the reader just asked on stays on its card while the server's
    // queue (which drops a waiting item at once) catches up to the reader
    // stepping off it — otherwise the card they typed into is replaced under
    // them before the "waiting" note has been read.
    const queue = holdWaitingItem(currentQueue(), state.walkHold);
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
    // The island's one input. A plain signal write, not a render call: the
    // card re-renders itself, keyed on `ReviewItem.key`, so a repaint of the
    // item the reader is working keeps its DOM — which is what carries the
    // half-typed answer and the expansions they opened across it.
    //
    // The handlers ride along because they are NOT stable: each one closes
    // over `current` / `next`, the item this paint drew and the one after it.
    // A set bound once at mount would be answering about a queue several
    // answers old.
    walkthroughData.value = {
      queue,
      index,
      progress: state.walkProgress,
      now: Date.now(),
      handlers: {
        // `current` rather than a lookup by task id: it is the item this
        // render drew, so the key that gets advanced past cannot be a
        // different row that happens to share a task.
        onAnswer: async (t, text, optionId) => {
          // The write first, then the advance — and only an ANSWER advances.
          // A question converted server-side leaves the decision open on the
          // queue, so settling it would mark done a row still waiting.
          const wrote = await answerDecision(t, text, optionId);
          if (wrote === 'asked') return true;
          return finishWalkItem(current, next, async () => wrote === 'answered');
        },
        // Not a finish either: nothing was answered, and the card stays put
        // with the note that the item is now waiting on its owner.
        onAskOnItem: (item, phrase, question) => askOnReviewItem(item, phrase, question),
        onReply: async (item, text, optionId) => {
          // Same split as `onAnswer`: a reply the server read as a question
          // holds the card with its waiting note (`replyToReviewItem` sets the
          // hold) instead of settling and advancing past an unanswered ask.
          const wrote = await replyToReviewItem(item, text, optionId);
          if (wrote === 'asked') return true;
          return finishWalkItem(item, next, async () => wrote === 'answered');
        },
        onOpenItem: (item) => openFromWalk((back) => openReviewItem(item, back)),
        // Same one-step close-then-open as `onOpenItem`, aimed at the thread —
        // and the same doc jump underneath when the item has no thread on a
        // task to aim at, so it needs the same care on the way out.
        onOpenThread: (item) => openFromWalk((back) => openReviewThread(item, back)),
        onStep: (i) => {
          // Skip and back are positional by nature — the reader is pointing at
          // a place in the list they can see. Re-aim from that position so the
          // next repaint follows the item rather than the number.
          const to = Math.max(0, i);
          // Aim by the KEY the reader can see at that position, then release
          // the hold: the waiting item leaves the walkthrough the way it
          // already left Home, and the index is re-found in the queue without
          // it so the step lands on the item pointed at rather than skipping
          // one past the row that vanished.
          const target = queue.items[to]?.key ?? null;
          state.walkHold = null;
          state.walkKey = target;
          const after = currentQueue();
          const at = target ? after.items.findIndex((it) => it.key === target) : -1;
          state.walkIndex = at >= 0 ? at : Math.min(to, after.items.length);
          renderWalkthrough();
        },
        onClose: () => {
          closeWalkthrough();
          renderWalkthrough();
        },
      },
    };
    // The address names the item on screen (`?item=`): opening the
    // walkthrough is a push, advancing through it rewrites in place, closing
    // unwinds — `historyStep` sees one `walk` resource however far it steps.
    syncBoardUrl();
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
  // Filled in at boot from the landing-page handoff (see walkHandoff below):
  // when the queue drains mid-sitting, this hops to the next workspace still
  // holding items. Null until boot wires it; no-op without a chain.
  let chainWalkDrain: (() => void) | null = null;

  // Also filled in at boot: re-checks an armed ?walk=1 handoff when the task
  // projection arrives. Decisions ride the ydoc, not the REST review-items
  // list, so the first load can resolve before the board has synced — the
  // observer below gives the walk another look at the queue then.
  let autoWalkTick: (() => void) | null = null;

  // Which halves of the queue have landed. The armed walk opens only once
  // both are in (or the deadline passes): a walk opened on the review-items
  // half alone aimed at the oldest ask, which the task projection then
  // ranked to the bottom — "Review all" from the landing page opened on
  // N of N. See `walkHandoffReady`.
  const walkSources: WalkSources = { reviewItems: false, projection: false };

  async function finishWalkItem(
    item: ReviewItem | null,
    next: ReviewItem | null,
    write: () => Promise<boolean>,
  ): Promise<boolean> {
    const ok = await write();
    if (!ok || !item) return ok;
    state.walkProgress = { cleared: state.walkProgress.cleared + 1, last: item };
    // Answering a held item ends the hold — it was answered, not waited on.
    if (state.walkHold?.key === item.key) state.walkHold = null;
    // Answered items stay in the Home stack marked done (approved design)
    // instead of vanishing — a per-sitting display ledger, not stored state.
    state.homeSettled.set(item.key, item);
    const queue = currentQueue();
    state.walkIndex = advanceWalk(queue, state.walkIndex, item.key, next?.key ?? null);
    state.walkKey = queue.items[state.walkIndex]?.key ?? null;
    // This board's queue just drained: if the landing page handed over more
    // boards (?then=), continue the sitting there instead of dead-ending.
    if (queue.items.length === 0) chainWalkDrain?.();
    renderWalkthrough();
    renderHomeRegion();
    return ok;
  }

  function peopleFromAwareness(): PresencePerson[] {
    const people: PresencePerson[] = [];
    client.awareness.getStates().forEach((aw, clientId) => {
      const s = aw as {
        user?: { id?: string; name?: string };
        surface?: string;
        docId?: string;
        lastActive?: number;
      };
      // A nameless entry draws no chip at all. Left exactly as it was — it is
      // a separate question from this migration, and worth its own ticket.
      if (!s?.user?.name) return;
      people.push({
        clientId,
        // Absent from a hub tab still running a bundle that predates this
        // line. `presenceIdentity` falls back to that tab's own connection
        // there, so it keeps its own row and folds with nobody.
        userId: s.user.id,
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
   * The presence strip renders in TWO places: who is here goes in the
   * top-right cluster, and the drift notices go in the settings panel. Two
   * islands, one loader — this function is the whole vanilla half of the
   * bridge, and it is a pair of signal writes.
   *
   * A notice in a closed panel is an alarm nobody sees, so the settings button
   * carries a dot whenever something in there is asking for attention. The
   * `coverage` notice deliberately does not arm it: it renders permanently by
   * design, and an always-on dot is one nobody reads.
   */
  function renderPresenceRegion(): void {
    // Two signal writes, not two render calls: the islands mounted above own
    // the DOM from here on, and they re-render themselves keyed on the
    // participant — so a repaint that changes one person leaves everybody
    // else's circle as the identical node, mid-press and all.
    presenceData.value = {
      chips: presenceChips(peopleFromAwareness(), state.agents, Date.now()),
      followedKey: state.followedKey,
    };
    const notices = [
      pluginDriftNotice(state.pluginRelease),
      clientDriftNotice(state.clientRelease, Date.now()),
    ];
    driftData.value = notices;
    renderSettingsAlarm(notices);
  }

  /** What in the settings panel is asking to be looked at. */
  function renderSettingsAlarm(notices: Array<DriftNotice | null>): void {
    const armed = notices.some((n) => n !== null && n.kind !== 'coverage');
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
    me.setAttribute('title', `You: ${user.name}`);
    me.setAttribute('aria-label', `You: ${user.name}`);
    if (user.color) me.style.background = user.color;
  }
  // The chip's menu — sign in / sign out. Wired once (buildShell above was
  // the last write of this subtree); renderMe only repaints the chip face.
  wireMeMenu({ button: el('hub-me'), menu: el('hub-me-menu'), localName: user.name });

  function renderSettingsPanel(): void {
    el('hub-settings-panel').classList.toggle('hidden', !state.settingsOpen);
    el('hub-settings').setAttribute('aria-expanded', String(state.settingsOpen));
  }

  function renderAll(): void {
    // Mounted, not rendered: `renderQuickActions` is a no-op after the first
    // call, so a board repaint cannot rebuild a button mid-request.
    renderQuickActions(el('hub-quick'), {
      onNewTask: () => newTask(),
      onStartHuddle: () => startHuddle('solo'),
      onStartConversation: () => startHuddle('conversation'),
      // The board's create buttons are the doc surface's edit toggle: a
      // control that cannot work should say so before it is pressed, not
      // after. The rest of the board's writes still fail loudly through
      // `send()`'s toast and the sign-in prompt — see the PR note.
      canWrite: writeAccess.canWrite,
    });
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

  /**
   * Put the controls back to what the SERVER says, after a write it refused.
   *
   * A select and a rename are the two places on this board where the reader's
   * gesture changes the DOM before the server has agreed. When the write is
   * refused they were left showing the rejected value — a select reading
   * "Done" over a task the server still has in triage, a row wearing a title
   * nobody saved — and only a reload put it right. A board that displays a
   * status nobody set is worse than the refusal it just reported.
   *
   * "+ New goal" never had the problem, because it changes nothing locally
   * and waits for the projection to paint the row. This is that same rule
   * applied to the controls that cannot wait: repaint from `state`, which is
   * the projection and nothing else. `useSelectValue` and the title's
   * every-render text write (board-island.tsx, task-detail-island.tsx) then
   * put each control back on their next pass.
   */
  function revertToServerTruth(): void {
    renderAll();
  }

  async function transitionTask(task: HubTask, to: HubTask['status']): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/transition`, 'POST', {
      to,
      author,
    });
    if (res.status === 409) {
      const blockers = (res.data?.blockers as Array<{ taskId: string; title?: string }>) ?? [];
      const names = blockers.map((b) => b.title ?? b.taskId).join(', ');
      showToast(`Blocked by open dependency: ${names || 'an enforced dependency'}`);
      revertToServerTruth();
    } else if (!res.ok) {
      showToast('Status change failed');
      revertToServerTruth();
    }
  }

  async function assignTask(task: HubTask, assignee: string): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/assignee`, 'POST', {
      assignee,
      author,
    });
    if (!res.ok) {
      showToast('Assignment failed');
      revertToServerTruth();
    }
  }

  /**
   * The panel's Goal field. Sends the same `set_task_goal` write a drag does
   * and an agent does — no `after`, because picking a band is not a placement
   * within it, and inventing one would move the task to the end of the new
   * band for no reason the reader gave.
   */
  async function setTaskGoal(task: HubTask, goal: string): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/goal`, 'POST', {
      goal,
      author,
    });
    if (!res.ok) showToast('Moving to that goal failed');
  }

  /** The panel's Due field. `null` clears — the route reads it as the explicit
   *  clear it is, rather than as a missing value. */
  async function setTaskDue(task: HubTask, dueAt: number | null): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/due`, 'POST', {
      dueAt,
      author,
    });
    if (!res.ok)
      showToast(dueAt === null ? 'Clearing the due date failed' : 'Setting the due date failed');
  }

  /**
   * Take a task off the board, and offer the way back in the same breath.
   *
   * No confirm dialog, deliberately. Archiving is reversible by construction
   * — three fields on the row — and this is a SECONDARY action that must not
   * cost a modal (Bryan, on the design thread: *"It's a secondary action.
   * Should not take up space from primary flows."*). The ten-second Undo is
   * what pays for the missing dialog, and it is the only thing that does, so
   * it goes up on the success path only: a toast offering to undo a write
   * that never landed is worse than no toast.
   *
   * The open panel closes, because a panel left standing on a row that just
   * left the board is a surface with no way to explain itself.
   */
  async function archiveTask(task: HubTask): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/archive`, 'POST', { author });
    if (!res.ok) {
      showToast('Archiving failed — the task is still on the board');
      return;
    }
    if (state.detailTaskId === task.id) {
      state.detailTaskId = null;
      renderDetail();
    }
    showToast(`Archived “${task.title}”`, {
      label: 'Undo',
      run: () => void restoreTask(task),
      ms: ARCHIVE_UNDO_MS,
    });
  }

  /** Put an archived task back. The Undo button, the panel's Restore, and the
   *  restore list's rows are all this one call. */
  async function restoreTask(task: HubTask): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/restore`, 'POST', { author });
    if (!res.ok) {
      showToast('Restoring failed — the task is still archived');
      return;
    }
    showToast(`Restored “${task.title}”`);
  }

  /** How many rows the panel is about to say goodbye to. Straight from the
   *  server's own walk, so the sentence in the confirmation and the write that
   *  follows it cannot disagree. `null` = the question could not be asked, and
   *  the panel then refuses to offer Archive at all. */
  async function goalCascadeCount(goalId: string): Promise<{ tasks: number } | null> {
    const res = await fetchJson<{ taskIds?: string[] }>(
      `/api/goals/${encodeURIComponent(goalId)}/cascade`,
    );
    if (!res) return null;
    return { tasks: res.taskIds?.length ?? 0 };
  }

  /** How many rows a goal archive or restore actually moved, off the response.
   *  Read defensively: an older server answers without the lists, and the
   *  toast then names the band alone rather than inventing a zero. */
  function movedCount(data: Record<string, unknown> | null, key = 'taskIds'): number {
    const ids = data?.[key];
    return Array.isArray(ids) ? ids.length : 0;
  }

  /**
   * Take a BAND off the board, with everything under it.
   *
   * The panel has already asked and named the number — this is the commit, so
   * there is no second confirmation here. What there IS, exactly as on a task,
   * is Undo in the same breath: the archive is reversible by construction and
   * the toast is what makes that reachable without going and finding the
   * restore list.
   *
   * The toast counts what the SERVER moved, not what the confirmation
   * predicted. The two are the same in every ordinary case; when a peer files
   * a fifteenth ticket between the question and the answer, the honest number
   * is the one that happened.
   */
  async function archiveGoal(section: BoardSection): Promise<void> {
    const res = await send(`/api/goals/${encodeURIComponent(section.id)}/archive`, 'POST', {
      author,
    });
    if (!res.ok) {
      showToast('Archiving failed — the goal is still on the board');
      return;
    }
    if (state.detailGoalId === section.id) {
      state.detailGoalId = null;
      renderDetail();
    }
    // The same phrase the confirmation used, from the same builder: a reader
    // told "and its 5 tasks" and then "and 3 tasks" would have to conclude
    // two of them stayed.
    const rode = cascadePhrase(movedCount(res.data, 'taskIds'));
    showToast(`Archived “${section.title}”${rode ? ` and its ${rode}` : ''}`, {
      label: 'Undo',
      run: () => void restoreGoal(section),
      ms: ARCHIVE_UNDO_MS,
    });
  }

  /** Put an archived band back, with the rows its archive took. The Undo
   *  button, the panel's Restore and the restore list's rows are all this. */
  async function restoreGoal(section: BoardSection): Promise<void> {
    const res = await send(`/api/goals/${encodeURIComponent(section.id)}/restore`, 'POST', {
      author,
    });
    if (!res.ok) {
      showToast('Restoring failed — the goal is still archived');
      return;
    }
    const n = movedCount(res.data);
    showToast(
      `Restored “${section.title}”${n > 0 ? ` and ${n === 1 ? '1 task' : `${n} tasks`}` : ''}`,
    );
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
    if (!res.ok) {
      showToast('Move failed');
      revertToServerTruth();
    }
  }

  async function renameTask(task: HubTask, title: string): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/title`, 'POST', {
      title,
      author,
    });
    if (!res.ok) {
      showToast('Rename failed');
      revertToServerTruth();
    }
  }

  /**
   * Retitle one band. This used to clone the client's copy of the goal list,
   * edit one title in it, and PUT the whole thing back — which is a full
   * REPLACE keyed by id built from a read that may be minutes old. A band
   * another writer added in between was simply absent from the clone, so the
   * replace removed it: its open tasks to Backlog, its done tasks orphaned.
   * The rename route touches one row by id and cannot move a task, so the
   * stale copy stops being able to do damage at all.
   */
  async function retitleGoal(sectionId: string, title: string): Promise<void> {
    const res = await send(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/goals/rename`,
      'POST',
      { goal: sectionId, title, author },
    );
    if (!res.ok) {
      showToast('Goal rename failed');
      revertToServerTruth();
    }
  }

  /**
   * Declare a goal's status — the same one-gate transition route a task
   * uses (`tasks.ts` resolves goal rows through it too; that is the whole
   * point of a goal being a row). Open children are ADVISORY on the server
   * (enforce:false), so a done declaration over open tasks succeeds — the
   * panel says so before the reader picks it.
   */
  async function transitionGoal(goalId: string, to: HubTask['status']): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(goalId)}/transition`, 'POST', {
      to,
      author,
    });
    if (!res.ok) {
      showToast('Goal status change failed');
      revertToServerTruth();
    }
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
  async function answerDecision(
    task: HubTask,
    text: string,
    optionId?: string,
  ): Promise<'answered' | 'asked' | false> {
    // Posted with the PERSON's own identity: answer.by shows who decided.
    // `text` is always the verbatim answer — tapping an option sends the
    // option's label as the answer and its id alongside, so nothing about the
    // recorded answer depends on the option list still existing later.
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/answer`, 'POST', {
      text,
      ...(optionId ? { optionId } : {}),
      author,
    });
    if (!res.ok) {
      showToast('Recording the answer failed — your words are still in the box');
      return false;
    }
    // The server read the words as a QUESTION and recorded them as a request
    // for more context — the decision stays open, and nothing was answered,
    // so the caller must not settle or undo-toast it.
    if (res.data?.asked === true) {
      showToast('Sent as a question — the decision stays open until it is answered');
      return 'asked';
    }
    return 'answered';
  }

  /**
   * The task panel's three answering doors, all of which owe the reader the
   * same thing: the write, then a REPAINT of the panel they are looking at.
   *
   * The walkthrough got that for free — it re-derives its queue on every
   * render — and the panel did not, because its queue is handed down from
   * `state.reviewItems` and nothing re-rendered the panel when that list
   * moved. Measured 2026-08-18: a free-text answer on a thread item persisted
   * server-side and the card sat unchanged 2.5 seconds later, so the natural
   * retry posted it twice.
   */
  async function answerTaskDecision(
    task: HubTask,
    text: string,
    optionId?: string,
  ): Promise<boolean> {
    const wrote = await answerDecision(task, text, optionId);
    if (wrote === false) return false;
    // A question already toasted for itself, and there is no answer to undo.
    if (wrote === 'answered') showToast('Answer recorded — Undo is on the ticket');
    // The row itself arrives over the ydoc; this is what moves the panel's
    // own queue on, since the review items are a REST-fed projection.
    await loadReviewItems();
    return true;
  }

  /**
   * Take back an answer recorded on a THREAD-borne item — the in-place
   * record's persistent Undo. The server moves the stamps into
   * `answerHistory` (soft, like every delete here) and the reply stays in the
   * thread; every queue re-offers the item on its next read, so the repaint
   * below is the whole client-side story. A 400 usually means somebody else
   * undid it first — the refresh shows the reopened item either way.
   */
  async function undoThreadAnswer(task: HubTask, item: PanelReviewItem): Promise<boolean> {
    if (!item.threadId || item.commentId === undefined) return false;
    const doc = encodeURIComponent(item.docId ?? task.bodyDocId);
    const thread = encodeURIComponent(item.threadId);
    const res = await send(`/api/docs/${doc}/threads/${thread}/answer/undo`, 'POST', {
      author,
      commentId: item.commentId,
    });
    if (!res.ok) {
      showToast('Taking the answer back failed');
      // Repaint anyway: the likeliest refusal is that a peer already undid
      // it, and a fresh read shows the reopened item rather than a stale
      // record with a dead button.
      await loadDiscussion(task, true);
      await loadReviewItems();
      return false;
    }
    showToast('Answer taken back — the item is open again');
    // Both, and in this order: the discussion so the record leaves the card,
    // the review items so the reopened item comes back to every queue.
    await loadDiscussion(task, true);
    await loadReviewItems();
    return true;
  }

  async function undoTaskAnswer(task: HubTask): Promise<boolean> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/answer/undo`, 'POST', {
      author,
    });
    if (!res.ok) {
      showToast('Taking the answer back failed');
      return false;
    }
    showToast('Answer taken back — the decision is open again');
    await loadReviewItems();
    return true;
  }

  /**
   * Overrule the quality gate on one held item — "Ask me anyway".
   *
   * The item goes on the queue on the reader's authority, and the queue is
   * re-read so it appears in the same repaint the note leaves in. No confirm:
   * the act is undone by the filer revising, and a dialog in front of a
   * one-tap override is what makes readers leave the hold alone.
   */
  async function releaseHeldReviewItem(task: HubTask, item: HubReviewItem): Promise<boolean> {
    const res = await send(
      `/api/tasks/${encodeURIComponent(task.id)}/review-items/${encodeURIComponent(item.id)}/release`,
      'POST',
      { author },
    );
    if (!res.ok) {
      showToast('Could not put that item on your queue');
      return false;
    }
    showToast('On your queue — the gate was overruled');
    await loadReviewItems();
    return true;
  }

  /**
   * Answer an item the panel's queue got from a THREAD or from the TICKET.
   *
   * Same routes the walkthrough uses, for the same reason: a declared thread
   * item records the answer against its declaring comment, an inferred one is
   * answered by replying, and in both cases the REPLY is what takes the item
   * out of the queue; a ticket-borne item is stamped at the task review-item
   * route, which drops it from every queue's next read. The panel used to
   * send this through the plain comment handler, which has nowhere to put the
   * picked option and left the queue showing an item that had just been
   * answered. ONE spelling of the destination — `panelAnswerRequest` — so a
   * card with no thread cannot post at `/threads/undefined/…`.
   */
  async function answerPanelThreadItem(
    task: HubTask,
    item: PanelReviewItem,
    text: string,
    optionId?: string,
  ): Promise<boolean> {
    const reqSpec = panelAnswerRequest(task, item, text, optionId);
    if (!reqSpec) return false;
    const res = await send(reqSpec.path, 'POST', { ...reqSpec.body, author });
    if (!res.ok) {
      showToast('Posting the answer failed — your text is still in the box');
      return false;
    }
    // A question converted server-side answered nothing — say what actually
    // happened. The refreshes below repaint the row as waiting either way.
    showToast(
      res.data?.asked === true ? 'Sent as a question — the item stays open' : 'Answer posted',
    );
    // Both, and in this order: the discussion so a reply appears in the
    // stream below (a ticket-borne answer writes no comment, but the reload
    // is cheap and keeps one path), the review items so the card it answered
    // leaves the queue.
    await loadDiscussion(task, true);
    await loadReviewItems();
    return true;
  }

  /**
   * Ask on a phrase of a ticket-borne review item — a thread on the task's
   * doc anchored to that phrase of that item (`reviewItemAskRequest`). The
   * server records the question on the item and drops it from the queue
   * while it waits on its owner; the owner hears about it the way it hears
   * every task-doc thread. The hold keeps the card in front of the reader
   * across the refresh, carrying the note — "Waiting on Helper" — until they
   * step off it.
   *
   * The old `POST /api/tasks/:id/more-info` box that stood here is gone from
   * the hub (Bryan, 2026-08-29); the route stays for its other callers.
   */
  async function askOnReviewItem(
    item: ReviewItem,
    phrase: { text: string },
    question: string,
  ): Promise<boolean> {
    const reqSpec = reviewItemAskRequest(item, phrase.text, question);
    if (!reqSpec) return false;
    const res = await send(reqSpec.path, 'POST', { ...reqSpec.body, author });
    if (!res.ok) {
      // A stale card: the pill hides itself once THIS session learns the item
      // is waiting, but another session's question can put it there first.
      // The server refuses with the open thread's id rather than filing a
      // second question nobody would read — surface that thread instead of
      // the generic failure, and refresh so the pill goes away here too.
      if (res.status === 409 && res.data?.error === 'waiting') {
        const message =
          typeof res.data.message === 'string'
            ? res.data.message
            : 'Already waiting on the owner — add to the open thread instead';
        const openThreadId = typeof res.data.threadId === 'string' ? res.data.threadId : undefined;
        const taskId = item.thread?.taskId;
        showToast(
          message,
          openThreadId && taskId
            ? { label: 'Open thread', run: () => openTaskThread(taskId, openThreadId) }
            : undefined,
        );
        await loadReviewItems();
        return false;
      }
      showToast('Sending the question failed — your words are still in the box');
      return false;
    }
    const owner = item.thread?.askedBy ?? 'the owner';
    state.walkHold = {
      key: item.key,
      index: Math.max(0, state.walkIndex),
      item: { ...item, waiting: { question, owner } },
    };
    showToast(`Asked — waiting on ${owner}`);
    // Home drops the item now (it is the owner's turn); the hold above keeps
    // the walkthrough card where the reader is.
    await loadReviewItems();
    return true;
  }

  /**
   * Comment on a phrase of a task's note (or its title) from the activity
   * pane — a thread on the task's doc whose first comment quotes the phrase
   * (`activityCommentRequest` says why the anchor is the task itself). The
   * owner hears about it the way it hears every task-doc thread. Resolves to
   * the thread the server made, which the pane's card then shows.
   */
  async function commentOnActivity(
    taskId: string,
    phrase: { text: string },
    text: string,
  ): Promise<Thread | null> {
    const reqSpec = activityCommentRequest(taskId, phrase.text, text);
    const res = await send(reqSpec.path, 'POST', { ...reqSpec.body, author });
    const thread = res.ok ? (res.data?.thread as Thread | undefined) : undefined;
    if (!thread) {
      showToast('Posting the comment failed — your text is still in the box');
      return null;
    }
    return thread;
  }

  /** A further reply on the thread the activity pane's card is showing —
   *  the same POST the task panel's composer makes. Resolves to the thread
   *  as the server now has it. */
  async function replyOnActivity(
    taskId: string,
    threadId: string,
    text: string,
  ): Promise<Thread | null> {
    const doc = encodeURIComponent(`task:${taskId}`);
    const res = await send(
      `/api/docs/${doc}/threads/${encodeURIComponent(threadId)}/comments`,
      'POST',
      {
        author,
        text,
      },
    );
    const thread = res.ok ? (res.data?.thread as Thread | undefined) : undefined;
    if (!thread) {
      showToast('Posting the reply failed — your text is still in the box');
      return null;
    }
    return thread;
  }

  /**
   * Answer a queued comment from the queue itself. The reply is an ordinary
   * thread comment — the same POST the doc and the task panel use — which is
   * what takes the item OUT of the queue: the server ships a thread row only
   * while a declared item or a direct ask is still waiting on a person, and a
   * person's reply ends the unanswered run (`unansweredRun` in the server's
   * review-queue.ts), so there is no separate dismissed flag to write and
   * none to keep in sync. A declared item is retired the same way through
   * `/answer`, which records the choice on the declaring comment.
   */
  async function replyToReviewItem(
    item: ReviewItem,
    text: string,
    optionId?: string,
  ): Promise<'answered' | 'asked' | false> {
    // ONE spelling of "where does this answer go" (`reviewReplyRequest`): a
    // declared thread item goes through the thread `/answer` route, which
    // posts the SAME reply and additionally records which candidate it came
    // from; an undeclared one is a plain comment; and a TICKET-borne item
    // (`task-review`) posts to the task review-item answer route — it has no
    // thread, and before the routing was shared this handler would have
    // posted its answer at `/api/docs/undefined/…`.
    const reqSpec = reviewReplyRequest(item, text, optionId);
    if (!reqSpec) return false;
    const res = await send(reqSpec.path, 'POST', { ...reqSpec.body, author });
    if (!res.ok) {
      showToast('Posting the reply failed — your text is still in the box');
      return false;
    }
    // The server read the words as a QUESTION asked back at the item —
    // nothing was answered. A ticket-borne item is now waiting on its owner,
    // so hold its card exactly as `askOnReviewItem` does; a thread item stays
    // where the conversation is either way.
    if (res.data?.asked === true) {
      const owner = item.thread?.askedBy ?? 'the owner';
      if (item.thread?.kind === 'task-review') {
        state.walkHold = {
          key: item.key,
          index: Math.max(0, state.walkIndex),
          item: { ...item, waiting: { question: text, owner } },
        };
      }
      showToast(`Sent as a question — waiting on ${owner}`);
      await loadReviewItems();
      return 'asked';
    }
    // Refresh BEFORE the advance: the queue has to have dropped the answered
    // item before the new position is computed against it, or the aim lands on
    // a list that still holds the thing just replied to.
    await loadReviewItems();
    return 'answered';
  }

  /**
   * The Board's "New task": an EMPTY row, opened at once in the panel with the
   * title ready to type (Bryan, 2026-08-29: *"creates an empty item in the
   * usual task detail view"*). No prompt, no sheet — the panel IS the form.
   *
   * Filed as the person, to the person: the old capture box handed every idea
   * to the lead agent, but a row Bryan is about to type into is his, and the
   * route assigns it to the author when nobody else is named. `untitled` is
   * the one way past the blank-title refusal; the server stores its own
   * placeholder and clears the flag the moment a real title lands.
   *
   * The row itself arrives over the ydoc, not the response — so the panel is
   * pointed at the id and `renderDetail` paints it when the projection lands,
   * the way a boot deep link does.
   */
  async function newTask(): Promise<boolean> {
    const res = await send(`/api/workspaces/${encodeURIComponent(workspaceId)}/tasks`, 'POST', {
      untitled: true,
      author,
    });
    const created = res.data?.task as { id?: unknown } | undefined;
    const id = typeof created?.id === 'string' ? created.id : null;
    if (!res.ok || !id) {
      const why =
        typeof res.data?.message === 'string' ? res.data.message : 'Could not file a new task';
      showToast(why);
      return false;
    }
    focusTitleTaskId = id;
    state.detailTaskId = id;
    state.detailGoalId = null;
    state.detailThreadId = null;
    renderDetail();
    return true;
  }

  /**
   * The Board's two mic buttons: ONE call makes the huddle doc on this
   * board, and the page leaves for it at once with the flag the editor reads
   * to start the meeting assistant without a press. The click here is the
   * person's gesture; `huddle-entry.ts` is the other half.
   *
   * `mode` is the only difference between "Start a planning huddle" and
   * "Record a conversation" — the doc, the route and the file are the same.
   * Solo asks for no speaker labels and pays for none.
   */
  async function startHuddle(mode: CaptureMode): Promise<boolean> {
    const res = await send(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/huddles`,
      'POST',
      {},
    );
    const url = typeof res.data?.url === 'string' ? res.data.url : null;
    if (!res.ok || !url) {
      const why =
        typeof res.data?.message === 'string' ? res.data.message : 'Could not start a huddle';
      showToast(why);
      return false;
    }
    // The mode rides the address beside the start flag: this press is the
    // only thing that knows whether anyone else is in the room, and the
    // editor that opens the mic is a different page.
    location.assign(`${url}?huddle=1&${HUDDLE_MODE_PARAM}=${mode}`);
    return true;
  }

  // ── Repaints wait for the reader's finger ───────────────────────────────
  //
  // Reported from the iPad, 2026-08-25: answering a decision review item
  // often took two taps — the first one vanished. Every one of the repaint
  // doors below rebuilds its region with `replaceChildren()`, and iOS Safari
  // drops the synthetic click when the element under the finger is replaced
  // between touchstart and touchend — so a background event landing mid-press
  // ate the tap. The guard parks background-triggered repaints during a press
  // and flushes them (coalesced, latest state wins) once the tap completes.
  // The reader's OWN renders are never deferred: the click that carries them
  // ends the window before their handlers run. Sibling of `discussionIsBusy`,
  // which holds the discussion reload the same way for typing.
  const repaintGuard = createRepaintGuard({ dom: document, win: window });
  /** The three regions the tasks projection and the review-items list feed —
   *  every closure here is a STABLE reference, which is what lets the guard
   *  coalesce a burst of events during one press into one repaint. */
  const repaintQueueRegions = (): void => {
    renderBoardRegion();
    renderHomeRegion();
    renderDetail();
  };

  async function loadReviewItems(): Promise<void> {
    await refreshReviewItems(state, () =>
      fetchJson<{ items: ReviewThreadItem[] }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/review-items`,
      ),
    );
    // The task panel's review queue is handed down from this same list, so it
    // is stale until this repaint runs — which is why answering a card in the
    // panel repainted nothing at all before it was here.
    repaintGuard.schedule(repaintQueueRegions);
  }

  async function loadAgents(): Promise<void> {
    const res = await fetchJson<{
      attachments: Array<{
        agentId: string;
        state?: PresenceAgent['state'];
        stateLabel?: string;
        lastToolCallAt: number;
      }>;
      seat?: LeadSeatView;
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
    // Guarded like the releases above: a read that never reached the server
    // must not read as a healthy seat. `?? null` keeps an older server's
    // silence as "no claim", which the strip renders as it always did.
    state.seat = applyRefresh(state.seat, res, (r) => r.seat ?? null);
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
      repaintGuard.schedule(repaintBoardAndDetail);
    }
  }

  /** The agent-set repaint, held off the reader's finger like every other
   *  background repaint (stable reference — see `repaintQueueRegions`). */
  const repaintBoardAndDetail = (): void => {
    renderBoardRegion();
    renderDetail();
  };

  /** The activity log has a reader on screen. Only the Activity view and an
   *  open detail panel render `state.events` — everything else on the board
   *  lives off the projection — so with neither up, fetching ~1000 audit
   *  rows (~590KB on the live hub board) buys nothing. The SSE listeners
   *  keep calling in; this gate is what makes those calls free until one of
   *  the two readers opens, whose open paths already load on their own. */
  const eventsConsumerActive = (): boolean =>
    state.view === 'activity' || state.detailTaskId !== null || state.detailGoalId !== null;

  async function loadEvents(): Promise<void> {
    if (!eventsConsumerActive()) return;
    const res = await fetchJson<{ events: ActivityEvent[]; uptime: UptimeReport | null }>(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/events`,
    );
    state.events = applyRefresh(state.events, res, (r) => r.events ?? []);
    state.uptime = applyRefresh(state.uptime, res, (r) => r.uptime ?? null);
    repaintGuard.schedule(repaintActivityRegions);
  }

  /** Activity arrives on every board event, and the open panel re-reads the
   *  same rows — so this repaint fires constantly and must queue behind an
   *  in-flight tap. The conditions run at paint time, deliberately: what is
   *  showing when the repaint lands is what decides what it touches. */
  const repaintActivityRegions = (): void => {
    if (state.view === 'activity') renderActivityRegion();
    // The ticket's own Activity tab reads the same rows, so a refresh that
    // repainted only the workspace view left an open panel showing the
    // history as it stood when it opened.
    if (state.detailTaskId || state.detailGoalId) renderDetail();
  };

  // ── Sentry ──────────────────────────────────────────────────────────────
  // The board no longer inits its own client. `/app/sentry.js` does it for
  // every page type — board, doc, mockup, landing — so all four are
  // comparable and there is one place the release, the tags and the privacy
  // scrub are decided (see packages/server/src/browser-sentry.ts). This is
  // the read side: whatever that entry parked on `window`, or null.
  const sentry = pageSentry();

  // ── Load report ─────────────────────────────────────────────────────────
  // One line per page load, POSTed to /load-reports so "the board was slow"
  // is a recorded fact with phase attribution: msToBoot is the REST first
  // paint, msToFirstProjection is when the ydoc's task projection actually
  // arrived (the payload the iPad spent its 10 seconds on). Both are ms from
  // navigation start — performance.now()'s zero — so they compare across
  // loads. Sent once, when both phases are in, or at the fallback deadline
  // if the ydoc never syncs (that slow load is the one most worth recording).
  let msToBoot = 0;
  let msToFirstProjection: number | null = null;
  let loadReportSent = false;
  const sendLoadReport = (): void => {
    if (loadReportSent) return;
    loadReportSent = true;
    // What the network actually moved: "slow because big" and "slow because
    // far" need different fixes, and the report should tell them apart.
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    // Nobody asked for this POST — it is telemetry about the load that just
    // happened. Marked, so that a signed-out reader gets the standing bar
    // rather than a modal demanding they sign in to do something they never
    // did. Measured: unmarked, it raised the modal over the board within
    // four seconds of opening it.
    asBackgroundWrite(() => {
      void fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/load-reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          msToBoot,
          ...(msToFirstProjection !== null ? { msToFirstProjection } : {}),
          resourceCount: resources.length,
          transferBytes: resources.reduce((sum, r) => sum + (r.transferSize || 0), 0),
          decodedBytes: resources.reduce((sum, r) => sum + (r.decodedBodySize || 0), 0),
        }),
      }).catch(() => {});
    });
    // Same numbers onto the pageload trace, best-effort: if the SDK loaded
    // and the transaction is still open they land as measurements; if not,
    // the posted report above is still the durable record.
    try {
      sentry?.setMeasurement('ms_to_boot', msToBoot, 'millisecond');
      if (msToFirstProjection !== null) {
        sentry?.setMeasurement('ms_to_first_projection', msToFirstProjection, 'millisecond');
      }
    } catch {
      // The recorder never breaks the page it measures.
    }
  };
  // The ydoc's initial sync is the phase boundary, not the first tasksMap
  // mutation: an empty workspace's sync changes no task and would otherwise
  // report boot-only after the fallback, and any later peer edit would be
  // mistaken for the initial load (codex review on PR 384). onReady fires
  // once, after sync-step-2 lands — empty doc included.
  client.onReady(() => {
    if (msToFirstProjection === null) {
      msToFirstProjection = Math.round(performance.now());
      // onReady can beat the boot block below (the ydoc syncs concurrently)
      // — only send once boot has painted and stamped msToBoot.
      if (msToBoot > 0) sendLoadReport();
    }
    // The projection half of the queue is in — an EMPTY board's sync too,
    // which changes no task and so never reaches the observeDeep tick.
    walkSources.projection = true;
    autoWalkTick?.();
  });

  // ── Wiring ──────────────────────────────────────────────────────────────
  // Both observers read the projection at once (state must be current the
  // moment the ydoc moves) but paint through the guard: a peer's transition
  // arriving over the ydoc rebuilds the same regions the SSE path does, and
  // was eating taps the same way.
  tasksMap.observeDeep(() => {
    readProjection();
    // Home rides along with the board — without it the first projection lands
    // after Home's first paint and the queue stays empty while the board
    // banner (painted by renderBoardRegion) counts it.
    repaintGuard.schedule(repaintQueueRegions);
    autoWalkTick?.();
  });
  const repaintWorkspaceRegions = (): void => {
    renderLead();
    renderBoardRegion();
    renderHomeRegion();
    // Goal facts (title, status, owner, due) travel on the WORKSPACE map,
    // not the tasks map — an open goal panel repaints here or shows a peer's
    // rename never.
    if (state.detailGoalId) renderDetail();
  };
  wsMap.observeDeep(() => {
    readProjection();
    repaintGuard.schedule(repaintWorkspaceRegions);
  });

  client.awareness.setLocalState({
    // `id` rides along because the presence strip has to know WHO, and a
    // display name cannot answer that — two people called Alex would be one
    // chip, and following either would sometimes land on the other. `User.id`
    // is the stable per-browser id (localStorage, or a known user's own), so
    // it is the same across this person's tabs and different for anybody else:
    // exactly the two things the strip's row key must get right.
    user: { id: user.id, name: user.name, color: user.color },
    surface: 'hub',
    lastActive: Date.now(),
  });
  client.awareness.on('update', () => {
    renderPresenceRegion();
    // Follow (§2.7): when the followed person's surface moves, ours does too.
    // The key names the PERSON now, not one of their connections, so the
    // follow is resolved back through awareness by identity and lands on
    // whichever of their tabs moved most recently. That also means a follow
    // survives the followed person reloading — under the old `p-<clientId>`
    // key their new connection was a stranger, and the follow went quiet
    // without ever saying so.
    if (state.followedKey?.startsWith('p-')) {
      const identity = state.followedKey.slice(2);
      const [moved] = peopleFromAwareness()
        .filter((p) => presenceIdentity(p) === identity && p.docId)
        .sort((a, b) => b.lastActive - a.lastActive);
      if (moved?.docId) location.assign(`/review/${encodeURIComponent(moved.docId)}`);
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
  // Home's ages and time-keyed flags advance without a board event: a minute
  // tick, only while Home is showing (home-clock.ts).
  const stopHomeClock = startHomeClock(() => state.pane === 'home', renderHomeRegion);
  window.addEventListener('beforeunload', () => {
    clearInterval(presenceTick);
    stopHomeClock();
    client.close();
  });

  // SSE: agent presence + activity refresh. Board changes arrive via the
  // ydoc; SSE only nudges the REST-backed regions.
  const es = new EventSource(`/events/workspace/${encodeURIComponent(workspaceId)}`);
  for (const name of ['agent.attached', 'agent.detached', 'agent.heartbeat']) {
    es.addEventListener(name, () => void loadAgents());
  }
  // The list lives beside `describeEvent` in hub-model, because the two must
  // move together — an event the trail renders but this loop never hears is
  // an Activity tab that silently misses it, on the writer's own screen as
  // much as a peer's (the server echoes local writes back over SSE, which is
  // what puts a row under the due date you just set).
  for (const name of ACTIVITY_REFRESH_EVENTS) {
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
      // Whichever panel is open — a goal's discussion goes as stale as a
      // task's, and it is reached through the same room, so leaving it out
      // would mean a comment landing on a goal was invisible until the reader
      // closed and reopened the panel.
      const open: DiscussionRow | undefined = state.detailTaskId
        ? state.tasks.get(state.detailTaskId)
        : state.detailGoalId
          ? { id: state.detailGoalId, bodyDocId: `task:${state.detailGoalId}` }
          : undefined;
      if (!open || discussionIsBusy(document)) return;
      void loadDiscussion(open, true);
    });
  }
  // A task going done takes its discussion out of the queue.
  es.addEventListener('task.transitioned', () => void loadReviewItems());
  // …and stales every status chip a pasted task/goal link is wearing, so the
  // chips re-ask on the same push instead of showing the old status forever.
  es.addEventListener('task.transitioned', () => staleTaskLinkStatuses());

  // ── Catching up after the stream could not reach us ────────────────────
  //
  // Reported 2026-08-19: a new Home queue item did not appear until the page
  // was reloaded. Everything above is correct WHILE the stream is up — an
  // item posted against a healthy staging build paints in about a second.
  // The gap was the window where the stream is down: the server replays
  // nothing (there is no `Last-Event-ID` handling anywhere), and until now
  // every refetch after boot hung off one of these listeners — no error
  // handler, no reopen handler, no visibility handler, no poll. `EventSource`
  // reconnects by itself, so the page came back looking healthy and silently
  // missing whatever was created while it was away. That window is a server
  // restart (so, every deploy), a slept laptop, or a backgrounded phone.
  const streamStatus = (cb: (s: 'open' | 'closed') => void) => {
    es.addEventListener('open', () => cb('open'));
    // EventSource reports both a retriable drop and a fatal one here; the
    // difference does not change what the reader needs, which is a refetch
    // when it comes back and the truth on screen while it has not.
    es.addEventListener('error', () => cb('closed'));
  };
  const onVisible = (cb: () => void) => {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) cb();
    });
    // A network that comes back without the tab ever being hidden — the
    // phone that changed cells while its owner was reading.
    window.addEventListener('online', () => cb());
  };
  watchLiveSync({
    onStatus: streamStatus,
    onVisible,
    // Everything the listeners above keep fresh, refetched as one batch. The
    // brief is included only while Home is showing, for the same reason the
    // per-event path does it: a background tab must not queue model calls.
    resync: () => {
      void loadAgents();
      void loadEvents();
      void loadReviewItems();
      if (state.pane === 'home') void loadHome();
    },
  });
  // Its own line, under the reconnect banner rather than sharing it: that one
  // is about the editing socket and tells you to keep the tab open, this one
  // is about the queue being a stale read. A reader who is not told acts on
  // the stale list — silence that looks like calm.
  const staleNotice = document.createElement('div');
  staleNotice.className = 'conn-banner conn-banner--stale hidden';
  staleNotice.setAttribute('role', 'status');
  staleNotice.setAttribute('aria-live', 'polite');
  document.getElementById('hub-connection')?.after(staleNotice);
  watchConnection({
    onStatus: streamStatus,
    onView: (view) => renderLiveStaleNotice(staleNotice, view),
  });

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
    // A history move is the reader going somewhere; whatever a boot deep link
    // was still waiting for, they have left it behind.
    pendingBootItem = null;
    pendingBootGoal = null;
    bootThreadPending = false;
    applyHistoryLocation();
  });
  (document.getElementById('hub-done-filter') as HTMLSelectElement).addEventListener(
    'change',
    (ev) => {
      state.doneWindow = (ev.target as HTMLSelectElement).value as DoneWindow;
      renderBoardRegion();
    },
  );
  // Notifications for THIS device. Mounted once; its state is read from the
  // browser rather than held here, because the browser is where it actually
  // lives — a permission revoked in site settings has to show up on the row
  // without the app being told.
  const pushToggle = mountPushToggle({
    toggle: document.getElementById('hub-push-toggle') as HTMLInputElement,
    note: el('hub-push-note'),
    author: () => ({ id: user.id, name: user.name }),
  });
  void pushToggle.refresh();

  // What the quality gate judges an agent's ask against, in the owner's own
  // words. Read on every open, because an agent can rewrite it from a tool
  // while this tab sits here and a stale box that got saved would put the old
  // words back.
  const reviewCriteria = mountReviewCriteria({
    box: document.getElementById('hub-review-criteria') as HTMLTextAreaElement,
    note: el('hub-review-criteria-note'),
    save: el('hub-review-criteria-save') as HTMLButtonElement,
    useDefault: el('hub-review-criteria-default') as HTMLButtonElement,
    read: async () => {
      const data = await fetchJson<{
        reviewItemCriteria?: { value?: string; isDefault?: boolean };
      }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/settings`);
      const criteria = data?.reviewItemCriteria;
      return typeof criteria?.value === 'string'
        ? { value: criteria.value, isDefault: criteria.isDefault === true }
        : null;
    },
    write: async (value) => {
      const res = await send(`/api/workspaces/${encodeURIComponent(workspaceId)}/settings`, 'PUT', {
        reviewItemCriteria: value,
        author,
      });
      return res.ok;
    },
    toast: showToast,
  });

  el('hub-settings').addEventListener('click', () => {
    state.settingsOpen = !state.settingsOpen;
    renderSettingsPanel();
    // Re-read on open: permission can change in site settings while the tab
    // sits here, and the row is only ever read at the moment it is opened.
    // Same reason for the criteria, which an agent can rewrite from a tool.
    if (state.settingsOpen) {
      void pushToggle.refresh();
      void reviewCriteria.refresh();
    }
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
    // The open detail panel OR the highlighted row — see `voiceHubContext`.
    // Both are "this ticket" to the person holding the mic.
    getContext: () =>
      voiceHubContext(
        state.detailTaskId,
        document.activeElement?.closest<HTMLElement>('.hub-task-row')?.dataset.taskId,
        // The review item the panel is aimed at, so "pick the second one"
        // answers THAT one when the ticket has several.
        state.detailThreadId,
        // Or the ticket's own single review row, when the panel is open on it.
        state.reviewItems,
      ),
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

  // Gmail-style row shortcuts — the handler lives in hub-shortcuts.ts so it
  // can be tested (this module runs main() on import, which nothing in a
  // test can satisfy).
  document.addEventListener(
    'keydown',
    hubShortcutKeydown({
      state,
      helpEl: () => el('hub-help'),
      openDetail: (taskId) => {
        state.detailTaskId = taskId;
        renderDetail();
      },
      closeDetail: () => {
        state.detailTaskId = null;
        // The goal panel closes on Escape too. It floats over the board the
        // same way the task panel does, and one overlay that ignores the key
        // its neighbour obeys reads as stuck rather than as different.
        state.detailGoalId = null;
        state.detailThreadId = null;
        renderDetail();
      },
      archiveTask: (taskId) => {
        const task = state.tasks.get(taskId);
        // An already-archived row is unreachable from the board (it is not in
        // a lane to focus) but IS reachable from the restore list, where `e`
        // must not re-archive what is already gone.
        if (task && !isTaskArchived(task)) void archiveTask(task);
      },
    }),
  );

  // Deep links (?task=, ?goal=, ?thread=, Home's ?item=) went into `state`
  // before the first render — see `bootLoc` at the top of main(). What is
  // left here is the waiting: the projection that can confirm them lands
  // after first paint, so "not here yet" and "not here" are only
  // distinguishable by a deadline — the same economics as ?walk= below.
  const maybeOpenBootItem = (): void => {
    if (!pendingBootItem) return;
    const q = currentQueue();
    const idx = q.items.findIndex((i) => i.key === pendingBootItem);
    const item = q.items[idx];
    if (!item) return; // don't burn — the projection may still be coming
    pendingBootItem = null;
    openInQueue(item, idx);
  };
  if (bootLoc.task || bootLoc.goal || bootLoc.item) {
    setTimeout(() => {
      if (pendingBootItem) {
        pendingBootItem = null;
        showToast('That review item is not in the queue any more — it may already be answered.');
        syncBoardUrl();
      }
      pendingBootGoal = null;
      const goneTask =
        bootLoc.task !== null &&
        state.detailTaskId === bootLoc.task &&
        !state.tasks.has(bootLoc.task);
      // `goalSection` rather than a scan of the board's own sections, because
      // an archived goal is on no board at all. The scan this replaces called
      // that "gone" and closed the panel four seconds after it opened.
      const goneGoal =
        bootLoc.goal !== null &&
        state.detailGoalId === bootLoc.goal &&
        goalSection(state.info?.goals ?? [], bootLoc.goal) === null;
      if (goneTask || goneGoal) {
        state.detailTaskId = null;
        state.detailGoalId = null;
        state.detailThreadId = null;
        showToast('Nothing on this board matches that link — it may be outdated.');
        renderDetail();
      }
    }, WALK_HANDOFF_DEADLINE_MS);
  }

  // Deep link from the landing page's review chip / "Review all" bar:
  // ?walk=1 opens the walkthrough once the queue arrives, and ?then= names
  // the workspaces to visit after this one drains (walkNextUrl hops there).
  // One-shot — SSE-driven reloads must not re-open a walkthrough the reader
  // closed, so the flag burns on first use.
  const handoff = walkHandoff(location.search);
  let pendingWalk = handoff.walk && state.pane === 'home';
  const maybeAutoWalk = (deadlinePassed = false): void => {
    if (!pendingWalk) return;
    // Neither half landing alone burns the flag: on a cold connection the
    // ydoc task projection (decisions, and the tasks threads rank against)
    // and the review-items list arrive in either order, and a walk opened on
    // one half aims at a head the other half re-ranks to the bottom. The
    // projection's onReady, its observer, and every review-items load call
    // back in; only the deadline below stops waiting.
    if (!walkHandoffReady(currentQueue(), walkSources, deadlinePassed)) return;
    pendingWalk = false;
    startWalkthrough();
  };
  const deepLinkTick = (): void => {
    maybeAutoWalk();
    maybeOpenBootItem();
  };
  autoWalkTick = deepLinkTick;
  if (pendingWalk) {
    // Still nothing by now and the sync has had its chance: the board is
    // genuinely clear (someone answered since the landing page rendered).
    // Hop to the next board holding items, or stand down on Home.
    setTimeout(() => {
      if (!pendingWalk) return;
      // Whatever has landed by now is the queue: open on it. Only a board
      // with nothing in hand is clear enough to hop.
      maybeAutoWalk(true);
      if (!pendingWalk) return;
      pendingWalk = false;
      const next = walkNextUrl(handoff.chain);
      if (next) location.href = next;
    }, WALK_HANDOFF_DEADLINE_MS);
  }
  chainWalkDrain = () => {
    // The sitting for THIS board is over; hand the reader to the next board
    // in the chain rather than dead-ending on the cleared card.
    const next = walkNextUrl(handoff.chain);
    if (next) location.href = next;
  };

  // The board itself — bands and rows. Same island contract as the two above,
  // mounted once, and the one thing to keep in mind at this call site is that
  // `#hub-board` is the island's host from here on: nothing vanilla may write
  // into it. That is why the restore list moved to `#hub-archived` next door.
  //
  // These are the STABLE callbacks; everything that changes per paint
  // (sections, the agent list, the archived count, which pane is showing)
  // arrives through `boardData` in renderBoardRegion, which `renderAll` below
  // is about to call for the first time.
  mountBoardIsland(el('hub-board'), {
    ...boardHandlers,
    onShowArchived: () => setShowArchived(true),
  });

  // First paint from REST (the ydoc syncs in behind it), then the
  // REST-backed regions.
  readProjection();
  renderAll();
  msToBoot = Math.round(performance.now());
  if (msToFirstProjection !== null) sendLoadReport();
  // Fallback: a load whose ydoc never syncs is the slowest kind and must
  // still get recorded — report boot-only after 15s rather than never.
  setTimeout(sendLoadReport, 15_000);
  void loadAgents();
  // No loadEvents here: the Activity view and the detail panel — the only
  // readers — each fetch the log on their own open, and boot fetching ~590KB
  // nobody is looking at was a measured slice of the iPad's 10-second load
  // (the board-observability ticket). loadEvents itself is gated on a visible reader too,
  // so the SSE refresh calls it safely.
  void loadReviewItems().then(() => {
    walkSources.reviewItems = true;
    deepLinkTick();
  });
  // A deep link straight to /home needs its payload without a nav tap.
  if (state.pane === 'home') void loadHome();
}

void main();
