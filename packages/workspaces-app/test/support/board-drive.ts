/**
 * One board boot, driven, for the suites that used to read the boot's source.
 *
 * `board-boot.test.ts`, `lazy-events.test.ts` and `load-beacon.test.ts` each
 * grew their own copy of the same forty lines — install the fakes, answer the
 * five routes every boot asks for, build the env, seed the ydoc, settle. The
 * suites converted off source-text reads need exactly that and nothing new, so
 * it lives here once.
 *
 * Not a second implementation of the boot: everything below is the same
 * `boot-harness.ts` fakes, assembled. What is under test is always the real
 * `bootBoard`.
 *
 * The fake fetch dispatcher is installed at MODULE load, because
 * `installWriteGateNotice` wraps `window.fetch` once per process and binds
 * whatever it finds — see `installFakeServer`. Vitest isolates a module
 * registry per test file, so one install per file is what happens.
 */
import { vi } from 'vitest';
import { type BoardBootEnv, bootBoard } from '../../src/board/board-app.ts';
import type { BoardGoal, BoardTask } from '../../src/board/board-model.ts';
import { LONG_PRESS_MS } from '../../src/board/presence-island.tsx';
import {
  type FakeClient,
  type FakeHistory,
  type FakeLocation,
  type FakeServer,
  type FakeSockets,
  type FakeStorage,
  fakeHistory,
  fakeLocation,
  fakeSockets,
  fakeStorage,
  installFakeBeacon,
  installFakeEventSource,
  installFakeServer,
  settle,
} from '../boot-harness.ts';

export const WS = 'w-board';
export const NOW = 1_700_000_000_000;
export const NAME_KEY = 'feedback-user-name';

export const server: FakeServer = installFakeServer();
installFakeEventSource();
installFakeBeacon();

/**
 * Drop every route and answer the ones a board boot asks for unconditionally.
 *
 * Call it in `beforeEach`. Later `server.on` calls win over earlier ones, so a
 * test overrides one of these by naming it again.
 */
export function resetBoardServer(): void {
  server.reset();
  server.on('/api/auth/session', { authenticated: false, canWrite: true });
  server.on(`/workspaces/${WS}`, {
    workspace: { id: WS, name: 'Kitchen rebuild', goals: [], createdAt: NOW },
  });
  server.on(`/workspaces/${WS}/agents`, { agents: [] });
  server.on(`/workspaces/${WS}/review-items`, { items: [] });
  server.on(`/workspaces/${WS}/events`, { events: [] });
  server.on(`/workspaces/${WS}/home`, {
    workspaceId: WS,
    lastReadAt: 0,
    since: NOW - 86_400_000,
    instructions: '',
    brief: { markdown: 'Nothing new since yesterday.', generatedAt: NOW, source: 'deterministic' },
    generating: false,
  });
  server.on(`/workspaces/${WS}/settings`, {});
}

/** A projected row, with the defaults every board fixture repeats. */
export function boardRow(id: string, over: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    title: `Task ${id}`,
    status: 'todo',
    assignee: 'Ada',
    goal: 'g-1',
    order: 1,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

export const DEFAULT_GOALS: BoardGoal[] = [{ id: 'g-1', title: 'Ship the hob' }];

/** Put a workspace and some rows into the ydoc the boot is reading. */
export function seedProjection(client: FakeClient, tasks: BoardTask[] = [], goals = DEFAULT_GOALS) {
  const tasksMap = client.ydoc.getMap('tasks');
  const ws = client.ydoc.getMap('workspace');
  client.ydoc.transact(() => {
    ws.set('id', WS);
    ws.set('name', 'Kitchen rebuild');
    ws.set('createdAt', NOW);
    ws.set('goals', goals);
    for (const t of tasks) tasksMap.set(t.id, t);
  });
}

export interface Booted {
  env: BoardBootEnv;
  sockets: FakeSockets;
  storage: FakeStorage;
  location: FakeLocation;
  history: FakeHistory;
  window: EventTarget;
  /** Push a further projection at the board and let it settle. */
  project(tasks: BoardTask[], goals?: BoardGoal[]): Promise<void>;
  /** A history traversal: the browser moves the address, THEN fires the event. */
  traverseTo(url: string): Promise<void>;
}

export interface BootOptions {
  /** Defaults to the board pane of the standard workspace. */
  url?: string;
  /** Rows to put in the ydoc before the sync the boot is waiting on. */
  tasks?: BoardTask[];
  goals?: BoardGoal[];
  /** Extra localStorage on top of the reader's name. */
  storage?: Record<string, string>;
  /** Leave the socket unsynced — the cold-connection case. */
  noSync?: boolean;
}

/** Boot the real board against the fakes and hand back what it touched. */
export async function bootTestBoard(opts: BootOptions = {}): Promise<Booted> {
  const sockets = fakeSockets();
  const storage = fakeStorage({ [NAME_KEY]: 'Ada', ...opts.storage });
  const location = fakeLocation(opts.url ?? `https://board.test/workspaces/${WS}/tasks`);
  const history = fakeHistory();
  const window = new EventTarget();
  document.body.innerHTML = '<div id="board-root"></div>';
  const env: BoardBootEnv = {
    document,
    location,
    history,
    localStorage: storage,
    window,
    connect: sockets.connect,
  };
  const running = bootBoard(env);
  await settle();
  if (sockets.opened.length > 0 && !opts.noSync) {
    seedProjection(sockets.first(), opts.tasks ?? [], opts.goals ?? DEFAULT_GOALS);
    sockets.first().sync();
  }
  await running;
  await settle();
  return {
    env,
    sockets,
    storage,
    location,
    history,
    window,
    async project(tasks, goals = DEFAULT_GOALS) {
      seedProjection(sockets.first(), tasks, goals);
      await settle();
    },
    async traverseTo(url) {
      location.moveTo(url);
      window.dispatchEvent(new Event('popstate'));
      await settle();
    },
  };
}

/**
 * Leave any open task detail panel, and let the leaving settle.
 *
 * Opening the panel starts a dynamic import of the body editor's chunk. If a
 * test ends while that import is still in flight, its `.then`/`.catch` lands
 * after vitest has torn the environment down and touches a `document` that is
 * gone — an unhandled rejection that vitest reports as an error on a passing
 * run, intermittently. Closing the panel first makes the late callback take
 * its own `mount !== m` early return, which is the guard the editor already
 * has for a reader who closed the panel mid-load.
 */
export async function closeDetailPanel(board: Booted): Promise<void> {
  const url = new URL(board.location.href);
  url.searchParams.delete('task');
  await board.traverseTo(url.href);
}

/** An element the boot built, by id — a miss is a loud failure, not a null. */
export function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the boot never built #${id}`);
  return found;
}

/** Click something the boot built and let the handlers run. */
export async function click(target: Element): Promise<void> {
  (target as HTMLElement).click();
  await settle();
}

/**
 * What is still out of reach from here, so the next gesture lands knowingly.
 *
 * Two board actions cannot be driven through this DOM, and neither is a
 * missing helper — both want a browser that lays pages out:
 *
 *  - **Drag to reorder a row** (`board-island.tsx` `onHandleDown`). The drop
 *    target comes from `document.elementFromPoint` and `getBoundingClientRect`
 *    on the rows under the finger, and happy-dom lays nothing out: every rect
 *    is zero and there is no element at any point. The ACTION is still
 *    reachable — Alt+Arrow on the row and the arrow keys on the focused handle
 *    run the same `onReorder`, and `dropIndexFor` is a pure function with its
 *    own tests in `board-model.test.ts` — so what is untestable here is the
 *    drag, not the reordering.
 *  - **Comment on a selection** (`selection-pill.ts`, `review-item-phrase.ts`,
 *    and the `getSelection` reads in the task-detail, home-activity and
 *    walkthrough islands). It needs a live `Selection` over rendered text;
 *    the suites that touch it stub `document.getSelection` instead (see the
 *    note in `inline-rename.ts`), and a driven version would need a real
 *    engine rather than a new helper here.
 */

/**
 * Press and hold something the boot built, long enough to arm a long-press.
 *
 * The board's one long-press is the presence circle's follow, and it is a
 * `pointerdown` that arms a `setTimeout` and any of `pointerup` /
 * `pointercancel` / `pointerleave` that disarms it (`presence-island.tsx`).
 * So the gesture is a real event sequence over a real clock, and the only
 * part a driver has to fake is the wait: `settle` turns the microtask queue
 * and `holdMs` is a threshold, not a duration to sleep through. Vitest's fake
 * clock is what lets the press be held for 550ms without the suite taking
 * 550ms — and only around the hold, so the boot's own intervals (the 30s
 * presence tick, the home clock) keep running on the real one.
 *
 * `holdMs` defaults past the board's own threshold, imported rather than
 * copied; pass a shorter one to drive a press that is released too early,
 * which is the control for any test asserting the long-press did something.
 *
 * The release goes to the element AND to `board.window`, because the fake env
 * splits the two: `document` is a real DOM the press bubbles through, but the
 * boot's `window` is a bare EventTarget, and the repaint guard listens for the
 * release there (`createRepaintGuard({ dom: document, win: window })`). In a
 * browser one `pointerup` reaches both. Skipping the window copy leaves the
 * guard armed and parks every background repaint until its 10s watchdog.
 */
export async function longPress(
  board: Booted,
  target: Element,
  holdMs = LONG_PRESS_MS + 50,
): Promise<void> {
  // A test may already be driving the clock; leave it as it found it.
  const borrowed = !vi.isFakeTimers();
  if (borrowed) vi.useFakeTimers();
  try {
    target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(holdMs);
  } finally {
    if (borrowed) vi.useRealTimers();
  }
  // The finger lifts, and the browser synthesizes the click that follows it.
  // Both are driven: a long-press that fired must not ALSO count as a tap,
  // and that is decided in the click handler.
  target.dispatchEvent(new Event('pointerup', { bubbles: true }));
  board.window.dispatchEvent(new Event('pointerup'));
  target.dispatchEvent(new Event('click', { bubbles: true }));
  board.window.dispatchEvent(new Event('click'));
  await settle();
}

export { settle };
