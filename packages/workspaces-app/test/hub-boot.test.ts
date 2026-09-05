/**
 * The board's boot sequence, driven.
 *
 * `bootHub` used to be `main()` running on import against the live DOM and a
 * real socket, which is why everything about it was pinned by reading its own
 * source text. It takes its environment now, so these drive the real sequence
 * and assert what it did: which workspace it read, which pane it mounted, the
 * socket it opened, what it restored from storage, and what a deep-linked
 * `?task=` opened.
 *
 * All fixtures synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type HubBootEnv, WALK_HANDOFF_DEADLINE_MS, bootHub } from '../src/hub/hub-app.ts';
import { type HubGoal, type HubTask } from '../src/hub/hub-board-model.ts';
import { SIGN_IN_REQUIRED } from '../src/signin/write-gate.ts';
import {
  type FakeServer,
  type FakeSockets,
  type FakeStorage,
  fakeHistory,
  fakeLocation,
  fakeSockets,
  fakeStorage,
  firstAt,
  installFakeBeacon,
  installFakeEventSource,
  installFakeServer,
  settle,
} from './boot-harness.ts';

const server: FakeServer = installFakeServer();
installFakeEventSource();
installFakeBeacon();

const WS = 'w-board';
const NAME_KEY = 'feedback-user-name';

interface Booted {
  env: HubBootEnv;
  sockets: FakeSockets;
  storage: FakeStorage;
  location: ReturnType<typeof fakeLocation>;
  history: ReturnType<typeof fakeHistory>;
  window: EventTarget;
}

function shell(): HTMLElement {
  document.body.innerHTML = '<div id="hub-root"></div>';
  return document.getElementById('hub-root') as HTMLElement;
}

const NOW = 1_700_000_000_000;

function row(id: string, title: string): HubTask {
  return {
    id,
    title,
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
  };
}

/** A board with two rows on one goal — enough for the queue, the bands and a
 *  `?task=` deep link to have something real to resolve against. */
function seedProjection(sockets: FakeSockets): void {
  const client = sockets.first();
  const tasks = client.ydoc.getMap('tasks');
  const ws = client.ydoc.getMap('workspace');
  const goals: HubGoal[] = [{ id: 'g-1', title: 'Ship the hob' }];
  client.ydoc.transact(() => {
    ws.set('id', WS);
    ws.set('name', 'Kitchen rebuild');
    ws.set('createdAt', NOW);
    ws.set('goals', goals);
    tasks.set('t-1', row('t-1', 'Measure the alcove'));
    tasks.set('t-2', row('t-2', 'Order the hob'));
  });
}

async function boot(url: string, seed: Record<string, string> = {}): Promise<Booted> {
  const sockets = fakeSockets();
  const storage = fakeStorage({ [NAME_KEY]: 'Ada', ...seed });
  const location = fakeLocation(url);
  const history = fakeHistory();
  const window = new EventTarget();
  shell();
  const env: HubBootEnv = {
    document,
    location,
    history,
    localStorage: storage,
    window,
    connect: sockets.connect,
  };
  const running = bootHub(env);
  await settle();
  if (sockets.opened.length > 0) {
    seedProjection(sockets);
    sockets.first().sync();
  }
  await running;
  await settle();
  return { env, sockets, storage, location, history, window };
}

beforeEach(() => {
  server.reset();
  server.on('/api/auth/session', { authenticated: false, canWrite: true });
  server.on(`/api/workspaces/${WS}`, {
    workspace: { id: WS, name: 'Kitchen rebuild', goals: [], createdAt: 1_700_000_000_000 },
  });
  server.on(`/api/workspaces/${WS}/agents`, { agents: [] });
  server.on(`/api/workspaces/${WS}/review-items`, { items: [] });
  server.on(`/api/workspaces/${WS}/home`, {
    workspaceId: WS,
    lastReadAt: 0,
    since: NOW - 86_400_000,
    instructions: '',
    brief: { markdown: 'Nothing new since yesterday.', generatedAt: NOW, source: 'deterministic' },
    generating: false,
  });
  server.on(`/api/workspaces/${WS}/settings`, {});
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the board reads its workspace out of the address', () => {
  it('builds the shell for the workspace the path names', async () => {
    const { sockets } = await boot(`https://board.test/workspaces/${WS}/home`);
    expect(sockets.opened.length).toBeGreaterThan(0);
    expect(document.getElementById('hub-board')).not.toBeNull();
    expect(document.getElementById('hub-ws-name-text')?.textContent).toBe('Kitchen rebuild');
  });

  it('does nothing at all on a path that names no workspace', async () => {
    const sockets = fakeSockets();
    shell();
    await bootHub({
      document,
      location: fakeLocation('https://board.test/'),
      history: fakeHistory(),
      localStorage: fakeStorage({ [NAME_KEY]: 'Ada' }),
      window: new EventTarget(),
      connect: sockets.connect,
    });
    await settle(2);
    // No shell, no socket: a boot with nothing to open must not open anything.
    expect(sockets.opened).toHaveLength(0);
    expect(document.getElementById('hub-board')).toBeNull();
  });

  it('falls back to the id when the workspace read answers nothing', async () => {
    server.on(`/api/workspaces/${WS}`, {}, 500);
    const sockets = fakeSockets();
    shell();
    await bootHub({
      document,
      location: fakeLocation(`https://board.test/workspaces/${WS}/tasks`),
      history: fakeHistory(),
      localStorage: fakeStorage({ [NAME_KEY]: 'Ada' }),
      window: new EventTarget(),
      connect: sockets.connect,
    });
    await settle();
    expect(document.getElementById('hub-ws-name-text')?.textContent).toBe(WS);
  });
});

describe('the board opens exactly one socket, at the address it derived', () => {
  it('connects once, to the workspace room, over wss on an https page', async () => {
    const { sockets } = await boot(`https://board.test/workspaces/${WS}/tasks`);
    const board = sockets.opened.filter((c) => c.url.includes('type=workspace'));
    expect(board).toHaveLength(1);
    expect(board[0]?.url).toBe(
      `wss://board.test/y/${encodeURIComponent(`ws:${WS}`)}?type=workspace`,
    );
  });

  it('uses a plain ws socket on an http page', async () => {
    const { sockets } = await boot(`http://localhost:8787/workspaces/${WS}/tasks`);
    const board = sockets.opened.filter((c) => c.url.includes('type=workspace'));
    expect(board[0]?.url.startsWith('ws://localhost:8787/y/')).toBe(true);
  });
});

describe('the pane that mounts matches the route', () => {
  it('/home shows the Home pane and hides the board column', async () => {
    await boot(`https://board.test/workspaces/${WS}/home`);
    expect(document.getElementById('hub-home')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('hub-main')?.classList.contains('hub-main--home')).toBe(true);
  });

  it('/tasks shows the board and leaves Home hidden', async () => {
    await boot(`https://board.test/workspaces/${WS}/tasks`);
    expect(document.getElementById('hub-home')?.classList.contains('hidden')).toBe(true);
    expect(document.getElementById('hub-main')?.classList.contains('hub-main--home')).toBe(false);
    const active = document.querySelector('.hub-nav-item-active');
    expect((active as HTMLElement | null)?.dataset.nav).toBe('tasks');
  });

  it('/activity mounts the activity view rather than the rows', async () => {
    await boot(`https://board.test/workspaces/${WS}/activity`);
    expect(document.getElementById('hub-activity')?.classList.contains('hidden')).toBe(false);
    const active = document.querySelector('.hub-nav-item-active');
    expect((active as HTMLElement | null)?.dataset.nav).toBe('activity');
  });

  it('names the tab after the workspace and the pane', async () => {
    await boot(`https://board.test/workspaces/${WS}/home`);
    expect(document.title).toContain('Kitchen rebuild');
  });
});

describe('a deep-linked task opens on boot', () => {
  it('opens the panel for the task the address names', async () => {
    await boot(`https://board.test/workspaces/${WS}/tasks?task=t-2`);
    const panel = document.getElementById('hub-detail');
    expect(panel?.classList.contains('hidden')).toBe(false);
    expect(panel?.textContent).toContain('Order the hob');
  });

  it('leaves the panel shut when the address names no task', async () => {
    await boot(`https://board.test/workspaces/${WS}/tasks`);
    expect(document.getElementById('hub-detail')?.classList.contains('hidden')).toBe(true);
  });

  it('says the link is outdated, and shuts the panel, once the deadline passes', async () => {
    // "Not here yet" and "not here" are the same picture until the deadline:
    // the projection lands after first paint, so the board waits before it
    // calls a deep link unresolvable. Fake timers because the wait is the
    // behaviour — a suite that slept for it would be timing the machine.
    vi.useFakeTimers();
    try {
      const sockets = fakeSockets();
      shell();
      const running = bootHub({
        document,
        location: fakeLocation(`https://board.test/workspaces/${WS}/tasks?task=t-gone`),
        history: fakeHistory(),
        localStorage: fakeStorage({ [NAME_KEY]: 'Ada' }),
        window: new EventTarget(),
        connect: sockets.connect,
      });
      await vi.advanceTimersByTimeAsync(0);
      seedProjection(sockets);
      sockets.first().sync();
      await running;
      // No panel in the meantime — an unresolvable id never paints the empty
      // frame this test is named for.
      expect(document.getElementById('hub-detail')?.classList.contains('hidden')).toBe(true);
      expect(document.getElementById('hub-toast')?.classList.contains('hidden')).toBe(true);
      await vi.advanceTimersByTimeAsync(WALK_HANDOFF_DEADLINE_MS + 100);
      // Then the board says so, in as many words.
      expect(document.getElementById('hub-toast')?.textContent).toBe(
        'Nothing on this board matches that link — it may be outdated.',
      );
      expect(document.getElementById('hub-detail')?.classList.contains('hidden')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('what the boot restores from storage', () => {
  const NAV_KEY = 'cw-hub-nav-collapsed';

  it('reads the collapsed rail once and applies it', async () => {
    const { storage } = await boot(`https://board.test/workspaces/${WS}/tasks`, {
      [NAV_KEY]: '1',
    });
    expect(storage.reads.filter((k) => k === NAV_KEY)).toHaveLength(1);
    expect(document.getElementById('hub-nav')?.classList.contains('hub-nav--collapsed')).toBe(true);
  });

  it('leaves the rail open on a value that means nothing', async () => {
    await boot(`https://board.test/workspaces/${WS}/tasks`, { [NAV_KEY]: 'yes-please' });
    expect(document.getElementById('hub-nav')?.classList.contains('hub-nav--collapsed')).toBe(
      false,
    );
  });

  it('leaves the rail open when storage holds nothing', async () => {
    const { storage } = await boot(`https://board.test/workspaces/${WS}/tasks`);
    expect(storage.reads).toContain(NAV_KEY);
    expect(document.getElementById('hub-nav')?.classList.contains('hub-nav--collapsed')).toBe(
      false,
    );
  });

  it('takes the reader name from storage rather than prompting for one', async () => {
    await boot(`https://board.test/workspaces/${WS}/tasks`);
    expect(document.querySelector('.identity-prompt')).toBeNull();
  });
});

describe('Back and Forward move the board, not the page', () => {
  it('a popstate entry without a task shuts the panel the boot link opened', async () => {
    const { location, window } = await boot(`https://board.test/workspaces/${WS}/tasks?task=t-2`);
    expect(document.getElementById('hub-detail')?.classList.contains('hidden')).toBe(false);
    // The browser changes the address, THEN fires the event.
    location.moveTo(`https://board.test/workspaces/${WS}/tasks`);
    window.dispatchEvent(new Event('popstate'));
    await settle(4);
    expect(document.getElementById('hub-detail')?.classList.contains('hidden')).toBe(true);
  });

  it('a popstate entry naming a task opens it', async () => {
    const { location, window } = await boot(`https://board.test/workspaces/${WS}/tasks`);
    location.moveTo(`https://board.test/workspaces/${WS}/tasks?task=t-1`);
    window.dispatchEvent(new Event('popstate'));
    await settle(4);
    const panel = document.getElementById('hub-detail');
    expect(panel?.classList.contains('hidden')).toBe(false);
    expect(panel?.textContent).toContain('Measure the alcove');
  });

  it('rewrites a deep link to its canonical address through history, never a reload', async () => {
    const { history, location } = await boot(`https://board.test/workspaces/${WS}/tasks?task=t-2`);
    // The browser was never sent anywhere: the whole point of the URL writer.
    expect(location.navigations).toHaveLength(0);
    // A pasted link is the session's first entry, so the boot REWRITES it —
    // pushing would put a Back step in front of leaving the app.
    expect(history.entries.every((e) => e.kind === 'replace')).toBe(true);
    expect(history.url()).toBe(`/workspaces/${WS}?task=t-2`);
  });
});

describe('the load report survives a page with no Sentry SDK', () => {
  it('posts the boot timing anyway', async () => {
    await boot(`https://board.test/workspaces/${WS}/tasks`);
    const report = server.calls.find((c) => c.url.includes('/load-reports'));
    expect(report?.method).toBe('POST');
    expect((report?.body as { msToBoot?: number })?.msToBoot).toBeTypeOf('number');
  });
});

describe('a browser that may not write is told before it tries', () => {
  it('raises the sign-in bar under the header, and only when refused', async () => {
    server.on('/api/auth/session', { authenticated: false, canWrite: false });
    await boot(`https://board.test/workspaces/${WS}/tasks`);
    expect(document.querySelector('.signin-bar')).not.toBeNull();
  });

  it('shows no bar when the server says this browser may write', async () => {
    await boot(`https://board.test/workspaces/${WS}/tasks`);
    expect(document.querySelector('.signin-bar')).toBeNull();
  });

  it('offers a ticket no Plan or Review ask when this browser may not write', async () => {
    // The panel draws the two asks only when the board hands it `onAsk`, and
    // the board must withhold that from a reader who cannot write — the same
    // way the plan and review floats hide themselves on `!canWrite`. Pressed
    // by a signed-out reader or a share visitor the ask comes back 403, and
    // all they get is a failure toast: no sign-in path, no way to make it.
    server.on('/api/auth/session', { authenticated: false, canWrite: false });
    await boot(`https://board.test/workspaces/${WS}/tasks?task=t-2`);
    const panel = document.getElementById('hub-detail');
    expect(panel?.classList.contains('hidden')).toBe(false);
    expect(panel?.querySelectorAll('button.hub-task-ask')).toHaveLength(0);
  });

  it('offers both asks on the same ticket when this browser may write', async () => {
    // The positive control for the case above: with the ONLY difference the
    // session's `canWrite`, the same deep-linked ticket draws both buttons.
    // Without it the assertion above passes on a panel that never renders
    // the row at all, and the gate it is meant to pin could be deleted.
    await boot(`https://board.test/workspaces/${WS}/tasks?task=t-2`);
    const panel = document.getElementById('hub-detail');
    const asks = [...(panel?.querySelectorAll('button.hub-task-ask') ?? [])];
    expect(asks.map((b) => b.textContent)).toEqual(['Plan', 'Review']);
  });

  it('wraps fetch for the sign-in notice before it opens the board room', async () => {
    // A FRESH module registry. `installWriteGateNotice` installs once per
    // process and returns early ever after, so a boot later in this file
    // would find the wrapper already there and pass without having asked for
    // it — the test would hold on a boot that never made the call.
    vi.resetModules();
    const { bootHub: freshBoot } = await import('../src/hub/hub-app.ts');
    const beforeBoot = globalThis.fetch;
    const sockets = fakeSockets();
    let wrappedWhenSocketOpened = false;
    shell();
    const running = freshBoot({
      document,
      location: fakeLocation(`https://board.test/workspaces/${WS}/tasks`),
      history: fakeHistory(),
      localStorage: fakeStorage({ [NAME_KEY]: 'Ada' }),
      window: new EventTarget(),
      connect: (url) => {
        wrappedWhenSocketOpened = globalThis.fetch !== beforeBoot;
        return sockets.connect(url);
      },
    });
    await settle();
    seedProjection(sockets);
    sockets.first().sync();
    await running;
    await settle();
    expect(sockets.opened).toHaveLength(1);
    expect(wrappedWhenSocketOpened).toBe(true);

    // And it is the write gate's wrapper, not merely something new on the
    // global: the board's own `send()` reports a refusal as "Couldn't save",
    // which a signed-out person cannot act on, so the wrapper is what turns
    // that into something they can.
    server.on('/api/probe-write', { error: SIGN_IN_REQUIRED }, 401);
    await fetch('/api/probe-write', { method: 'POST' });
    await settle();
    expect(document.querySelector('.signin-required')).not.toBeNull();
  });

  it('has the write answer IN HAND before it opens the board room', async () => {
    server.on('/api/auth/session', { authenticated: false, canWrite: false });
    const sockets = fakeSockets();
    shell();
    // Read at the moment the room opens. The request log alone cannot carry
    // this: `ensureUserIdentity` asks the SAME endpoint, so a boot that never
    // awaited the write answer still shows a session request before the
    // socket.
    let barUpWhenSocketOpened = false;
    const running = bootHub({
      document,
      location: fakeLocation(`https://board.test/workspaces/${WS}/tasks`),
      history: fakeHistory(),
      localStorage: fakeStorage({ [NAME_KEY]: 'Ada' }),
      window: new EventTarget(),
      connect: (url) => {
        barUpWhenSocketOpened = document.querySelector('.signin-bar') !== null;
        return sockets.connect(url);
      },
    });
    await settle();
    seedProjection(sockets);
    sockets.first().sync();
    await running;
    await settle();
    expect(barUpWhenSocketOpened).toBe(true);
    const session = firstAt('/api/auth/session');
    const socket = firstAt('socket ');
    expect(session).toBeGreaterThanOrEqual(0);
    expect(session).toBeLessThan(socket);
  });
});
