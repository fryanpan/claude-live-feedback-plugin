/**
 * The board's read of the server-owned ydoc projection, and the two headers
 * that must follow it.
 *
 * One responsibility, and the thing that makes it one is the "called from
 * both writers" rule the two syncs carry. `state.info` has exactly two
 * writers — the boot REST fetch and every projection read — so a header
 * painted at one of them is wrong the moment the other fires, and this page
 * never reloads. Keeping the read and the two repaints in one module is what
 * makes that rule checkable by looking at one file.
 *
 * Nothing here mutates the ydoc. The `tasks` / `workspace` Y.Maps are
 * server-owned: the board renders FROM them and writes through the REST gate,
 * which is why this module takes them read-only and returns no setter.
 *
 * `HubProjectionDeps` is the whole list of what the read may reach.
 */
import type * as Y from 'yjs';
import type { BoardLocation } from './board-url.ts';
import type { HubState } from './hub-actions.ts';
import { DEFAULT_DONE_WINDOW, type HubGoal, type HubTask } from './hub-board-model.ts';
import { hubTabTitle, paneForNav, tabForNav } from './hub-presence-model.ts';
import { renderWorkspaceIdentity } from './hub-render.ts';

/**
 * The projection as it stands before anything has been read into it.
 *
 * It lives beside the read rather than in `bootHub` because it is the same
 * object the read below fills: every field here is either empty or a claim the
 * address bar made, and the panel ids are claims on purpose — the projection
 * they resolve against arrives after the first paint, and the deep-link
 * deadline is what finally decides a claim was stale.
 */
export function initialHubState(bootLoc: BoardLocation): HubState {
  const nav = bootLoc.nav;
  return {
    seat: null,
    info: null,
    tasks: new Map(),
    nav,
    pane: paneForNav(nav),
    settingsOpen: false,
    home: null,
    homeEditingRecipe: false,
    homeSettled: new Map(),
    homePollStarted: 0,
    tab: tabForNav(nav) ?? 'all',
    doneWindow: DEFAULT_DONE_WINDOW,
    view: nav === 'activity' ? 'activity' : 'board',
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
    followedKey: null,
  };
}

/** Everything the projection read needs from `bootHub`, and nothing else. */
export interface HubProjectionDeps {
  /** The board's one projection — the read writes `tasks` and `info`. LIVE. */
  state: HubState;
  /** The board being read, and the name the header falls back to. */
  workspaceId: string;
  /** Where the header and the tab title are written. */
  document: Document;
  /** The board room's two server-owned Y.Maps. A THUNK because the header
   *  paints once before the socket is built — `bootHub` constructs this
   *  module beside the shell and opens the connection after it. */
  maps(): { tasks: Y.Map<unknown>; ws: Y.Map<unknown> };
}

/** What `bootHub` keeps: the read, plus the two repaints its other writer
 *  (the boot REST fetch, and `setNav` for the title) calls directly. */
export interface HubProjection {
  readProjection(): void;
  syncHeader(): void;
  syncTabTitle(): void;
}

export function createHubProjection(deps: HubProjectionDeps): HubProjection {
  const { state, workspaceId, document, maps } = deps;

  function readProjection(): void {
    const { tasks: tasksMap, ws: wsMap } = maps();
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

  return { readProjection, syncHeader, syncTabTitle };
}
