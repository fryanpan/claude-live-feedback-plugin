/**
 * A board's worth of state and DOM, for the region modules that used to be
 * `hub-app.ts`'s render closure.
 *
 * Each region is now a factory over `HubState` plus one explicit dependency
 * object, so a suite can build the region alone. What it still needs is the
 * two things the closure used to supply for free: a `HubState` with every
 * field set, and the shell's containers — so both are here rather than
 * re-typed in a dozen files.
 *
 * `buildShell` paints the real markup, so `el('hub-home-review')` in a test
 * resolves to the same node it resolves to on the page. Nothing here fakes a
 * render.
 */
import type { HubState } from '../../src/hub/hub-actions.ts';
import { DEFAULT_DONE_WINDOW, type HubTask } from '../../src/hub/hub-board-model.ts';
import { buildShell } from '../../src/hub/hub-shell.ts';

/** A board state with every field at its boot value; override what the test
 *  is about. */
export function hubState(over: Partial<HubState> = {}): HubState {
  return {
    seat: null,
    info: null,
    tasks: new Map(),
    nav: 'tasks',
    pane: 'board',
    settingsOpen: false,
    home: null,
    homeEditingRecipe: false,
    homeSettled: new Map(),
    homePollStarted: 0,
    tab: 'all',
    doneWindow: DEFAULT_DONE_WINDOW,
    view: 'board',
    showArchived: false,
    activityFilter: 'all',
    events: [],
    uptime: null,
    agents: [],
    pluginRelease: null,
    clientRelease: null,
    detailTaskId: null,
    detailTab: 'comments',
    detailGoalId: null,
    detailThreadId: null,
    discussion: { loading: false, threads: [] },
    discussionTaskId: null,
    reviewItems: [],
    walkIndex: -1,
    walkKey: null,
    walkProgress: { cleared: 0, last: null },
    followedKey: null,
    ...over,
  };
}

/** The board's real shell, painted into a throwaway root. Returns `bootHub`'s
 *  own `el`. */
export function mountShell(
  name = 'harbor-relay',
  workspaceId = 'w-1',
): (id: string) => HTMLElement {
  const root = document.createElement('div');
  root.id = 'hub-root';
  document.body.replaceChildren(root);
  buildShell(document, root, name, workspaceId);
  return (id: string) => document.getElementById(id) as HTMLElement;
}

/** A board row, with only the fields a test cares about spelled out. */
export function task(id: string, over: Partial<HubTask> = {}): HubTask {
  return {
    id,
    title: id,
    status: 'todo',
    assignee: 'human',
    after: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as HubTask;
}
