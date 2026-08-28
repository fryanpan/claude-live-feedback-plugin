/**
 * The board's address, whole, in one place.
 *
 * Every openable thing on the hub — a nav destination, a task or goal panel,
 * the thread a panel is aimed at, the walkthrough's current review item, the
 * archived filter — reads from and writes to the URL through this module, so
 * a copied address bar IS the deep link and a deep link IS the state it
 * names. `hub-app.ts` owns WHEN history is written (its one `syncBoardUrl`
 * writer); this module owns WHAT the address says and which kind of history
 * write a state change deserves, because those are decisions a test can hold
 * still.
 *
 * Query params rather than new path segments, deliberately: the server
 * enumerates servable paths with no SPA fallback (`home-routes.test.ts`
 * pins that), so a param-shaped deep link reloads without a route addition —
 * which is why `?task=` already worked this way, and why `parseWorkspaceLink`
 * (the chip renderer's contract) recognizes params on the workspace path.
 */
import { type HubNav, navFromPath, navPath } from './hub-model.ts';

export interface BoardLocation {
  nav: HubNav;
  /** The open task panel's task. */
  task: string | null;
  /** The open goal panel's goal. Never set alongside `task` — task wins,
   *  matching `renderDetail`'s rule for the two panels' shared screen. */
  goal: string | null;
  /** The thread the open panel is aimed at. Meaningless without a panel. */
  thread: string | null;
  /** The review item the Home walkthrough is on (`ReviewItem.key`). The
   *  walkthrough is a page inside Home, so the param only means anything
   *  there. */
  item: string | null;
  /** The board's restore-list filter (`?view=archived`). */
  archived: boolean;
}

/** Params that belong to the reader's session rather than to the place, so
 *  every URL this module builds carries them forward. `walk`/`then` are
 *  deliberately NOT here: the handoff is one-shot, and reasserting it would
 *  re-open a walkthrough the reader closed on the next reload. */
const CARRIED_PARAMS = ['as'];

export function parseBoardLocation(pathname: string, search: string): BoardLocation {
  const nav = navFromPath(pathname);
  const params = new URLSearchParams(search);
  const task = params.get('task');
  const goal = task ? null : params.get('goal');
  const thread = task || goal ? params.get('thread') : null;
  const item = nav === 'home' ? params.get('item') : null;
  return {
    nav,
    task,
    goal,
    thread,
    item,
    archived: params.get('view') === 'archived',
  };
}

/**
 * The address (path + query) for a board state. `carryFrom` is the current
 * `location.search`, from which session params ride along.
 */
export function buildBoardUrl(workspaceId: string, loc: BoardLocation, carryFrom = ''): string {
  const params = new URLSearchParams();
  const current = new URLSearchParams(carryFrom);
  for (const name of CARRIED_PARAMS) {
    const v = current.get(name);
    if (v !== null) params.set(name, v);
  }
  if (loc.task) params.set('task', loc.task);
  else if (loc.goal) params.set('goal', loc.goal);
  if ((loc.task || loc.goal) && loc.thread) params.set('thread', loc.thread);
  if (loc.nav === 'home' && loc.item) params.set('item', loc.item);
  if (loc.archived) params.set('view', 'archived');
  const q = params.toString();
  return `${navPath(workspaceId, loc.nav)}${q ? `?${q}` : ''}`;
}

/**
 * The identity of the OPENED thing, for history granularity: one entry per
 * opened resource. The walkthrough is one resource however many items it
 * advances through — stepping is reading, not navigating — and a panel opened
 * over it takes over as the thing Back should close first.
 */
export function resourceOf(loc: BoardLocation): string | null {
  if (loc.task) return `task:${loc.task}`;
  if (loc.goal) return `goal:${loc.goal}`;
  if (loc.nav === 'home' && loc.item) return 'walk';
  return null;
}

export type HistoryStep = 'push' | 'replace' | 'close';

/**
 * Which history write a state change deserves.
 *
 * `push` makes a place Back can return to: a nav change, or a resource
 * opening or swapping. `replace` rewrites the current place: aiming at a
 * thread, the walkthrough advancing, the archived filter — refinements of
 * where the reader already is. `close` is the resource going away with the
 * nav unchanged; the caller unwinds it (Back when this document pushed the
 * entry, a clean rewrite when the entry arrived from outside).
 */
export function historyStep(prev: BoardLocation, next: BoardLocation): HistoryStep {
  if (prev.nav !== next.nav) return 'push';
  const from = resourceOf(prev);
  const to = resourceOf(next);
  if (from === to) return 'replace';
  if (to === null) return 'close';
  return 'push';
}

/**
 * The shareable address of one task: the BARE board path plus `?task=`,
 * whatever page it is copied from. The bare path is the shape
 * `parseWorkspaceLink` resolves to a title chip, and it says which workspace
 * the task belongs to on its face rather than being an opaque id.
 */
export function taskShareUrl(origin: string, workspaceId: string, taskId: string): string {
  return `${origin}/workspaces/${encodeURIComponent(workspaceId)}?task=${encodeURIComponent(taskId)}`;
}

/** The shareable address of one goal — the task link's shape, `?goal=`. */
export function goalShareUrl(origin: string, workspaceId: string, goalId: string): string {
  return `${origin}/workspaces/${encodeURIComponent(workspaceId)}?goal=${encodeURIComponent(goalId)}`;
}
