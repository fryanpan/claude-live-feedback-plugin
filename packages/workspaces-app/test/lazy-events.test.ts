/**
 * The activity log loads only when something reads it.
 *
 * The log is ~1000 rows (~590KB decompressed on the live board) and only two
 * surfaces read it: the Activity view and an open detail panel. It used to be
 * fetched unconditionally at boot AND re-fetched on every SSE task event —
 * dead weight on exactly the load Bryan measured at 10+ seconds on his iPad.
 *
 * DRIVEN, NOT GREPPED. This file used to read the seventeen board boot modules
 * as one string and match `if (!eventsConsumerActive()) return;` and
 * `void loadEvents();` against it. Two of the three cases were absences, and
 * an absence in source text is the weakest evidence there is: a regex for the
 * exact boot sequence that used to contain the call goes green the moment the
 * sequence is reformatted, reordered or moved to another module, whether or
 * not the fetch came back. What is actually in question is whether a request
 * for `/events` leaves the page — so boot the board and read the fetch log.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BoardBootEnv, bootBoard } from '../src/board/board-app.ts';
import {
  FakeEventSource,
  type FakeServer,
  fakeHistory,
  fakeLocation,
  fakeSockets,
  fakeStorage,
  installFakeBeacon,
  installFakeEventSource,
  installFakeServer,
  pathsAsked,
  settle,
} from './boot-harness.ts';

const server: FakeServer = installFakeServer();
installFakeEventSource();
installFakeBeacon();

const WS = 'w-board';
const NAME_KEY = 'feedback-user-name';
const NOW = 1_700_000_000_000;

type Booted = { location: ReturnType<typeof fakeLocation>; window: EventTarget };

async function boot(url: string): Promise<Booted> {
  const sockets = fakeSockets();
  document.body.innerHTML = '<div id="board-root"></div>';
  const location = fakeLocation(url);
  const window = new EventTarget();
  const env: BoardBootEnv = {
    document,
    location,
    history: fakeHistory(),
    localStorage: fakeStorage({ [NAME_KEY]: 'Ada' }),
    window,
    connect: sockets.connect,
  };
  const running = bootBoard(env);
  await settle();
  if (sockets.opened.length > 0) sockets.first().sync();
  await running;
  await settle();
  return { location, window };
}

/** A history traversal to another nav — the browser moves the address, then
 *  fires the event, which is the order the boot's own listener assumes. */
async function traverseTo(booted: Booted, url: string): Promise<void> {
  booted.location.moveTo(url);
  booted.window.dispatchEvent(new Event('popstate'));
  await settle();
}

/** Every path the boot asked for that is the activity log. */
const eventReads = (): string[] =>
  pathsAsked(server).filter((p) => p.endsWith(`/workspaces/${WS}/events`));

beforeEach(() => {
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
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the activity log loads only when something reads it', () => {
  it('CONTROL: the boot really did run and really did fetch', async () => {
    // Everything below is "no /events request". Without this, a boot that
    // died on its first line would satisfy every one of them.
    await boot(`https://board.test/workspaces/${WS}/home`);
    expect(pathsAsked(server).length).toBeGreaterThan(2);
    expect(pathsAsked(server)).toContain(`/workspaces/${WS}/review-items`);
  });

  it('boot does not fetch the log on Home', async () => {
    await boot(`https://board.test/workspaces/${WS}/home`);
    expect(eventReads(), `asked: ${pathsAsked(server).join(', ')}`).toEqual([]);
  });

  it('boot does not fetch the log on the board pane either', async () => {
    await boot(`https://board.test/workspaces/${WS}/tasks`);
    expect(eventReads(), `asked: ${pathsAsked(server).join(', ')}`).toEqual([]);
  });

  it('a live task event with nothing on screen to read it fetches nothing', async () => {
    // The gate's own case. Every board event refreshes the trail
    // (board-live-wiring.ts), and with neither the Activity view nor a detail
    // panel open there is nobody to show ~590KB to — so the refresh has to
    // come back free. The old form asserted the guard's SOURCE TEXT, which
    // says nothing about whether the refresh path reaches it.
    await boot(`https://board.test/workspaces/${WS}/tasks`);
    FakeEventSource.last().dispatchEvent(new Event('task.transitioned'));
    await settle();
    expect(eventReads(), `asked: ${pathsAsked(server).join(', ')}`).toEqual([]);
  });

  it('the same live event WITH the Activity view open does fetch', async () => {
    // The control for the case above: the refresh listener is wired and does
    // reach `loadEvents`, so the silence up there is the gate deciding and
    // not a listener that was never registered.
    const booted = await boot(`https://board.test/workspaces/${WS}/tasks`);
    await traverseTo(booted, `https://board.test/workspaces/${WS}/activity`);
    const before = server.calls.length;
    FakeEventSource.last().dispatchEvent(new Event('task.transitioned'));
    await settle();
    const after = server.calls
      .slice(before)
      .filter((c) => c.url.includes(`/workspaces/${WS}/events`));
    expect(after.length).toBeGreaterThan(0);
  });

  it('opening the Activity view loads it', async () => {
    // The positive half, and the reason the two absences above are about the
    // GATE rather than about a route nothing ever calls. Boot on the board
    // pane, then navigate to Activity: the reader arrives and the fetch
    // follows it.
    const booted = await boot(`https://board.test/workspaces/${WS}/tasks`);
    expect(eventReads()).toEqual([]);
    await traverseTo(booted, `https://board.test/workspaces/${WS}/activity`);
    expect(eventReads().length, `asked: ${pathsAsked(server).join(', ')}`).toBeGreaterThan(0);
  });
});
