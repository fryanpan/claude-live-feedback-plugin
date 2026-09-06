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
import { type BoardBootEnv, bootBoard } from '../../src/board/board-app.ts';
import type { BoardGoal, BoardTask } from '../../src/board/board-model.ts';
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

export { settle };
