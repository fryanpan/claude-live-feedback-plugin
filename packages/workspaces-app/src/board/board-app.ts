/**
 * The workspace board page: a left nav over two panes — Home (the "What's New?"
 * brief, the "For Your Review" queue, and the walkthrough that answers it)
 * and the board (goals as bands, quick add, review banner), with Activity as
 * a view of the board pane. Presence, lead and drift notices live in the
 * settings panel. The board renders in realtime from the ws:<workspaceId>
 * ydoc projection (server-owned `tasks` / `workspace` Y.Maps); every
 * mutation goes through the REST gate — never by writing into the maps,
 * which the server would revert.
 *
 * What is left in THIS file is the boot sequence and the address bar. Every
 * region the boot composes — the board pane, Home, the detail panel, the
 * discussion, the chrome cluster, the islands, the REST reads — is a module
 * that takes `BoardState` plus one explicit dependency object, and hands back
 * the renders the sequence below calls. Read the order of the `const`s in
 * `bootBoard` and you have read the page: nothing between them is a surprise,
 * because a region can only reach what its deps object names.
 */
import type { FeedbackClient, User } from '@feedback/core';
import type { BootHistory, BootLocation, BootStorage, BootWindow } from '../boot-env.ts';
import { renderConnectionBanner, watchConnection } from '../connection-state.ts';
import { ensureUserIdentity } from '../identity-prompt.ts';
import { wireKeyboardInset } from '../keyboard-inset.ts';
import { pageSentry } from '../sentry-page.ts';
import { fetchWriteAccess, installWriteGateNotice, showSignInBar } from '../signin/write-gate.ts';
import { installStaleClientNotice } from '../stale-client.ts';
import {
  type BoardState,
  createBoardActions,
  fetchJson,
  send,
  showToast,
} from './board-actions.ts';
import { createBoardChromeRegion } from './board-chrome-region.ts';
import { createBoardLoads } from './board-data-loads.ts';
import { createBoardDeepLinks } from './board-deep-links.ts';
import { createBoardDetailPanel } from './board-detail-panel.ts';
import { createBoardDiscussion } from './board-discussion.ts';
import { createBoardHomeRegion } from './board-home-region.ts';
import { mountBoardIsland } from './board-island.tsx';
import { mountBoardIslands } from './board-islands.ts';
import { wireBoardLive } from './board-live-wiring.ts';
import { postLoadReport } from './board-load-report.ts';
import {
  type BoardTask,
  type BoardWorkspaceInfo,
  type DoneWindow,
  isTaskArchived,
} from './board-model.ts';
import { type BoardNav, paneForNav, tabForNav } from './board-presence-model.ts';
import { createBoardProjection, initialBoardState } from './board-projection.ts';
import { createBoardQueueOpeners } from './board-queue-open.ts';
import { createBoardRegion } from './board-region.ts';
import { renderQuickActions } from './board-render.ts';
import { createBoardReviewController } from './board-review-controller.ts';
import { type WalkSources, reviewQueue } from './board-review-model.ts';
import { wireBoardSettingsPanel } from './board-settings-panel.ts';
import { buildShell, wireNavCollapse } from './board-shell.ts';
import { wireBoardShortcuts } from './board-shortcuts.ts';
import {
  type BoardLocation,
  buildBoardUrl,
  goalShareUrl,
  historyStep,
  parseBoardLocation,
  resourceOf,
  taskShareUrl,
} from './board-url.ts';
import { wireBoardVoice } from './board-voice.ts';
import { createBoardWalkthrough } from './board-walkthrough.ts';
import { mountIslandProbe } from './island-probe.tsx';
import { createRepaintGuard } from './repaint-guard.ts';

/**
 * Everything the board's boot reaches outside its own module.
 *
 * The page passes the real globals at the bottom of this file; a test passes a
 * throwaway document, a synthetic address and a fake socket. Inside `bootBoard`
 * these are destructured under their own names, so the body reads exactly as it
 * did when they were ambient — see the note on the destructure.
 */
export interface BoardBootEnv {
  document: Document;
  location: BootLocation;
  history: BootHistory;
  localStorage: BootStorage;
  window: BootWindow;
  connect: (url: string) => FeedbackClient;
}

// The deadline every boot claim is decided by now lives with the claims
// themselves (`board-deep-links.ts`). Re-exported rather than moved outright:
// it is part of this entry's published surface, and a caller asking the page
// how long it waits should not have to know which module holds the timer.
export { WALK_HANDOFF_DEADLINE_MS } from './board-deep-links.ts';

/**
 * The board's whole boot sequence, as a function of its environment.
 *
 * Nothing here runs on import: the one call at the bottom of this file is what
 * starts the page, and a test calls this with its own document, address and
 * socket instead. The destructure below deliberately re-binds each injected
 * thing to the name it had as a global — `document`, `location`, `history`,
 * `localStorage`, `window`, `connect` — so the lines that follow are the same
 * lines, and what changed is only where those names come from.
 */
export async function bootBoard(env: BoardBootEnv): Promise<void> {
  const { document, location, history, localStorage, window, connect } = env;

  function workspaceIdFromPath(): string {
    const m = location.pathname.match(/\/workspaces\/([^/?#]+)/);
    return m?.[1] ? decodeURIComponent(m[1]) : '';
  }

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

  // A refused write raises a sign-in prompt wherever it happened. The board's
  // `send()` reports every failure as a toast, and "Couldn't save" is not
  // something a signed-out person can act on. See signin/write-gate.ts.
  installWriteGateNotice();
  const root = document.getElementById('board-root');
  const workspaceId = workspaceIdFromPath();
  if (!root || !workspaceId) return;

  // Publish `--kb-bottom` before anything is drawn. The doc surface has done
  // this since its composer first went under the keyboard; the board is a
  // separate entry point and did not, so every bottom-docked thing here — the
  // task panel's Comment button most visibly — sat under the iOS keyboard and
  // its accessory bar with no scroll left to reach it.
  wireKeyboardInset();

  // Same order as the doc surface: the write answer decides whether the name
  // prompt is worth showing. See signin/write-gate.ts.
  const writeAccess = await fetchWriteAccess();
  // The bar is raised after `buildShell` below, not here: it mounts as a row
  // under `.board-topbar`, and at this point `#board-root` is still the empty div
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
  const state: BoardState = initialBoardState(bootLoc);

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
  /** The boot URL named a walkthrough item; opened when the queue holds it. */
  let pendingBootItem = bootLoc.item;

  const initial = await fetchJson<{ workspace: BoardWorkspaceInfo }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}`,
  );
  if (initial) state.info = initial.workspace;
  buildShell(document, root, state.info?.name ?? workspaceId, workspaceId);
  // Now that there is a header to sit under. See signin/write-gate.ts.
  if (!writeAccess.canWrite) showSignInBar();
  // The Preact proving island (hidden; owns its own wrapper under root).
  // buildShell wrote root.innerHTML just above, so this mounts AFTER the last
  // vanilla wipe of root — the contract is that no vanilla code wipes a
  // container while an island lives in it.
  mountIslandProbe(root);

  // The server-owned `tasks` / `workspace` projection, and the two headers
  // that must follow it — `board-projection.ts`. Built here, before the socket
  // below, because the header paints once from the REST read; the maps
  // arrive through a thunk for exactly that reason.
  const { readProjection, syncHeader, syncTabTitle } = createBoardProjection({
    state,
    workspaceId,
    document,
    maps: () => ({ tasks: tasksMap, ws: wsMap }),
  });
  // The REST read above already knows whether this board is retired, and the
  // board room's first sync can be a second away on a cold connection. Paint
  // it now so nobody reads a retired board as live in that window.
  syncHeader();

  const el = (id: string) => document.getElementById(id) as HTMLElement;

  // Every island this page keeps for its whole life, mounted here because
  // `buildShell` above was the last vanilla write of `#board-root`. The handlers
  // are thunks into regions built further down — see board-islands.ts.
  mountBoardIslands({
    state,
    user,
    el,
    location,
    openInQueue: (item, index) => openInQueue(item, index),
    openReviewItem: (item) => openReviewItem(item),
    openReviewThread: (item) => openReviewThread(item),
    startWalkthrough: () => startWalkthrough(),
    openTaskDetail: (task, tab) => openTaskDetail(task, tab),
    commentOnActivity: (taskId, phrase, text) => commentOnActivity(taskId, phrase, text),
    replyOnActivity: (taskId, threadId, text) => replyOnActivity(taskId, threadId, text),
    renderPresenceRegion: () => renderPresenceRegion(),
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
    onView: (view) => renderConnectionBanner(document.getElementById('board-connection'), view),
  });
  const tasksMap = client.ydoc.getMap('tasks');
  const wsMap = client.ydoc.getMap('workspace');

  // ── The projections every region reads ──────────────────────────────────
  const taskList = () => [...state.tasks.values()];
  const titleOf = (taskId: string) => state.tasks.get(taskId)?.title ?? taskId;

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

  // ── Mutations (all through the REST gate) ───────────────────────────────
  //
  // The board's REST verbs live in `board-actions.ts`, bound once to what they
  // used to capture. Built before the regions because every region that offers
  // a gesture ends in one of them; the three repaints they need arrive as
  // thunks, which is the same cycle `board-walkthrough.ts` resolves the same way.
  const actions = createBoardActions({
    workspaceId,
    author,
    state,
    renderAll,
    renderDetail: () => renderDetail(),
    renderLead: () => renderLead(),
    focusTitle: (taskId) => setFocusTitle(taskId),
  });
  const { newTask, startHuddle, archiveTask } = actions;

  // ── The review queue's controller ───────────────────────────────────────
  //
  // Opening an item, walking a sitting, and answering or asking back live in
  // `board-review-controller.ts`, bound here to what they used to capture.
  const review = createBoardReviewController({
    author,
    state,
    currentQueue,
    renderWalkthrough: () => renderWalkthrough(),
    loadReviewItems: () => loadReviewItems(),
    loadDiscussion: (row, quiet) => loadDiscussion(row, quiet),
    openTaskThread: (taskId, threadId) => openTaskThread(taskId, threadId),
  });
  const {
    startWalkthrough,
    openInQueue,
    answerDecision,
    askOnReviewItem,
    replyToReviewItem,
    commentOnActivity,
    replyOnActivity,
  } = review;

  // ── The board pane, and the openers that reach it ───────────────────────
  const {
    openTaskDetail,
    boardHandlers,
    knownAgentIds,
    renderLead,
    setShowArchived,
    renderBoardRegion,
    renderActivityRegion,
  } = createBoardRegion({
    state,
    user,
    el,
    actions,
    taskList,
    titleOf,
    currentQueue,
    renderDetail: () => renderDetail(),
    renderWalkthrough: () => renderWalkthrough(),
    syncBoardUrl,
    setNav,
  });

  const { openReviewItem, openReviewThread, openTaskThread } = createBoardQueueOpeners({
    state,
    workspaceId,
    boardHandlers,
    renderDetail: () => renderDetail(),
    location,
  });

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

  // ── The Home pane ───────────────────────────────────────────────────────
  const { renderHomeRegion, loadHome } = createBoardHomeRegion({
    state,
    workspaceId,
    author,
    user,
    document,
    el,
    currentQueue,
    taskList,
    schedule: (paint) => repaintGuard.schedule(paint),
  });

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
  function setNav(nav: BoardNav, push = true): void {
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

  // ── Task discussion ─────────────────────────────────────────────────────
  const discussion = createBoardDiscussion({
    state,
    author,
    renderDetail: () => renderDetail(),
  });
  const { loadDiscussion } = discussion;

  // ── The detail panel ────────────────────────────────────────────────────
  const { renderDetail, setFocusTitle } = createBoardDetailPanel({
    state,
    user,
    workspaceId,
    document,
    taskUrl,
    goalUrl,
    actions,
    review,
    discussion,
    taskList,
    titleOf,
    knownAgentIds,
    loadEvents: () => loadEvents(),
    syncBoardUrl,
    connectMarkdown: (docId) => connect(wsUrl(docId, 'markdown')),
    // Already awaited above — the description box is never live before the
    // answer, and never live after a "no".
    canWrite: writeAccess.canWrite,
    boot: {
      goal: () => pendingBootGoal,
      threadPending: () => bootThreadPending,
      clearThread: () => {
        bootThreadPending = false;
      },
    },
  });

  // ── The Home walkthrough ────────────────────────────────────────────────
  //
  // Where the reader stands in the review queue, and what answering does to
  // that position: `board-walkthrough.ts`.
  const walkthrough = createBoardWalkthrough({
    state,
    currentQueue,
    el,
    syncBoardUrl,
    renderHomeRegion,
    openReviewItem,
    openReviewThread,
    answerDecision: (task, text, optionId) => answerDecision(task, text, optionId),
    askOnReviewItem: (item, phrase, question) => askOnReviewItem(item, phrase, question),
    replyToReviewItem: (item, text, optionId) => replyToReviewItem(item, text, optionId),
    onQueueDrained: () => chainWalkDrain?.(),
  });
  // Destructured rather than wrapped: a local `function renderWalkthrough`
  // would shadow the real one for anybody — a reader or a source-shape test —
  // looking for where the walk is drawn.
  const { render: renderWalkthrough, close: closeWalkthrough } = walkthrough;

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

  // ── The chrome cluster ──────────────────────────────────────────────────
  const { peopleFromAwareness, renderPresenceRegion, renderMe, renderSettingsPanel } =
    createBoardChromeRegion({ state, user, el, awareness: client.awareness });

  function renderAll(): void {
    // Mounted, not rendered: `renderQuickActions` is a no-op after the first
    // call, so a board repaint cannot rebuild a button mid-request.
    renderQuickActions(el('board-quick'), {
      onNewTask: () => newTask(),
      onStartHuddle: () => startHuddle('plan', 'solo'),
      onStartConversation: () => startHuddle('discussion', 'conversation'),
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

  // ── What the board keeps learning from the server ───────────────────────
  const { loadReviewItems, loadAgents, loadEvents, repaintQueueRegions } = createBoardLoads({
    state,
    workspaceId,
    schedule: (paint: () => void) => repaintGuard.schedule(paint),
    renderBoardRegion,
    renderHomeRegion,
    renderDetail,
    renderActivityRegion,
    renderPresenceRegion,
    renderLead,
    knownAgentIds,
  });

  // ── Load report ─────────────────────────────────────────────────────────
  // One line per page load, POSTed to /load-reports so "the board was slow"
  // is a recorded fact with phase attribution. What a report CONTAINS is
  // `board-load-report.ts`; what boot owns is when each phase ended — the two
  // stamps below, and the guard that makes the report fire once, when both
  // phases are in or at the fallback deadline if the ydoc never syncs.
  //
  // The board no longer inits its own Sentry client: `/app/sentry.js` does it
  // for every page type — board, doc, mockup, landing — so all four are
  // comparable and there is one place the release, the tags and the privacy
  // scrub are decided. `pageSentry()` is the read side of that.
  const sentry = pageSentry();
  let msToBoot = 0;
  let msToFirstProjection: number | null = null;
  let loadReportSent = false;
  const sendLoadReport = (): void => {
    if (loadReportSent) return;
    loadReportSent = true;
    postLoadReport({ workspaceId, msToBoot, msToFirstProjection, sentry });
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
  //
  // The ydoc observers, the awareness feed, the SSE listeners and the catch-up
  // are `board-live-wiring.ts`, called here so subscription order is unchanged.
  wireBoardLive({
    workspaceId,
    user,
    state,
    client,
    tasksMap,
    wsMap,
    readProjection,
    repaintGuard,
    repaintQueueRegions,
    autoWalkTick: () => autoWalkTick?.(),
    renderLead,
    renderBoardRegion,
    renderHomeRegion,
    renderDetail,
    renderPresenceRegion,
    peopleFromAwareness,
    loadAgents,
    loadEvents,
    loadHome,
    loadReviewItems,
    loadDiscussion,
  });

  // Controls.
  // Home / Tasks / My Tasks / Activity — pushState every way, and the back
  // button honours all four.
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.board-nav-item[data-nav]')) {
    btn.addEventListener('click', () => setNav((btn.dataset.nav as BoardNav) ?? 'tasks'));
  }
  // Rail collapse — the rail's own behaviour, so it lives beside the markup
  // it toggles (`board-shell.ts`). Persisted, so the choice survives reloads.
  wireNavCollapse(document, localStorage);
  window.addEventListener('popstate', () => {
    // A history move is the reader going somewhere; whatever a boot deep link
    // was still waiting for, they have left it behind.
    pendingBootItem = null;
    pendingBootGoal = null;
    bootThreadPending = false;
    applyHistoryLocation();
  });
  (document.getElementById('board-done-filter') as HTMLSelectElement).addEventListener(
    'change',
    (ev) => {
      state.doneWindow = (ev.target as HTMLSelectElement).value as DoneWindow;
      renderBoardRegion();
    },
  );
  // The settings panel's three controls, the ways it opens and closes, and
  // the share button beside it. `board-settings-panel.ts`, called here so the
  // document-level click and keydown listeners register in the same order
  // relative to the ones around them.
  wireBoardSettingsPanel({
    document,
    el,
    workspaceId,
    author,
    user,
    fetchJson,
    send,
    showToast,
    isOpen: () => state.settingsOpen,
    setOpen: (open) => {
      state.settingsOpen = open;
    },
    renderSettingsPanel,
    href: () => location.href,
  });

  // Where an utterance lands: the open panel, or the row the keyboard is on.
  // `board-voice.ts` — one capture per page, because Space is a singleton.
  wireBoardVoice({ state, author, workspaceId, document, location, el, renderDetail });

  // Gmail-style row shortcuts — the handler lives in board-shortcuts.ts so a
  // test can call it directly with a state of its own, rather than booting a
  // board first and pressing keys at it.
  wireBoardShortcuts({
    document,
    state,
    el,
    renderDetail,
    archiveTask: (task) => archiveTask(task as BoardTask),
    isArchived: (task) => isTaskArchived(task as BoardTask),
  });

  // Deep links (?task=, ?goal=, ?thread=, Home's ?item=, and the landing
  // page's ?walk=1) went into `state` before the first render — see `bootLoc`
  // at the top of this function. What `board-deep-links.ts` owns is the
  // WAITING: the projection that can confirm a claim lands after first paint,
  // so "not here yet" and "not here" are only distinguishable by a deadline.
  const { deepLinkTick, chainWalkDrain: drainToNextBoard } = createBoardDeepLinks({
    state,
    bootLoc,
    location,
    currentQueue,
    walkSources,
    openInQueue,
    startWalkthrough,
    syncBoardUrl,
    renderDetail,
    boot: {
      item: () => pendingBootItem,
      clearItem: () => {
        pendingBootItem = null;
      },
      clearGoal: () => {
        pendingBootGoal = null;
      },
    },
  });
  autoWalkTick = deepLinkTick;
  chainWalkDrain = drainToNextBoard;

  // The board itself — bands and rows. Same island contract as the ones in
  // board-islands.ts, mounted once, and the one thing to keep in mind at this
  // call site is that `#board` is the island's host from here on: nothing
  // vanilla may write into it. That is why the restore list moved to
  // `#board-archived` next door.
  //
  // These are the STABLE callbacks; everything that changes per paint
  // (sections, the agent list, the archived count, which pane is showing)
  // arrives through `boardData` in renderBoardRegion, which `renderAll` below
  // is about to call for the first time.
  mountBoardIsland(el('board'), {
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
