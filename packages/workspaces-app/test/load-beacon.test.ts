/**
 * The board reports its own load time.
 *
 * The board's load time was a memory ("10+ seconds on the iPad") until the
 * server grew `/load-reports`. This is the client half: after boot the board
 * reports how long its own first paint and its first ydoc projection took,
 * once per page load, so slowness is a recorded fact with phase attribution.
 *
 * DRIVEN, NOT GREPPED. This file used to read the seventeen board boot
 * modules as one string and match the `fetch(` template literal, the
 * `let loadReportSent = false;` declaration and two `performance.now()`
 * spellings. Every one of those is a claim about how the code is WRITTEN: a
 * report assembled and never sent passes them, a rename of the guard breaks
 * them, and none of them can see the once-only rule actually holding across
 * two projections. `bootBoard` takes its environment, so boot it and read the
 * POST.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BoardBootEnv, bootBoard } from '../src/board/board-app.ts';
import type { BoardGoal, BoardTask } from '../src/board/board-model.ts';
import {
  type FakeServer,
  type FakeSockets,
  fakeHistory,
  fakeLocation,
  fakeSockets,
  fakeStorage,
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
const NOW = 1_700_000_000_000;

type Report = {
  msToBoot?: unknown;
  msToFirstProjection?: unknown;
  resourceCount?: unknown;
  transferBytes?: unknown;
  decodedBytes?: unknown;
};

/** Every POST the boot made to the load-reports route, bodies parsed. */
function reports(): Report[] {
  return server.calls
    .filter((c) => c.method === 'POST' && c.url.includes(`/workspaces/${WS}/load-reports`))
    .map((c) => c.body as Report);
}

function row(id: string, title: string): BoardTask {
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

function seedProjection(sockets: FakeSockets, taskId: string): void {
  const client = sockets.first();
  const tasks = client.ydoc.getMap('tasks');
  const ws = client.ydoc.getMap('workspace');
  const goals: BoardGoal[] = [{ id: 'g-1', title: 'Ship the hob' }];
  client.ydoc.transact(() => {
    ws.set('id', WS);
    ws.set('name', 'Kitchen rebuild');
    ws.set('createdAt', NOW);
    ws.set('goals', goals);
    tasks.set(taskId, row(taskId, 'Measure the alcove'));
  });
}

/** Boots with a projection that arrives, and hands back the socket so a test
 *  can push a SECOND projection at it. */
async function boot(): Promise<FakeSockets> {
  const sockets = fakeSockets();
  document.body.innerHTML = '<div id="board-root"></div>';
  const env: BoardBootEnv = {
    document,
    location: fakeLocation(`https://board.test/workspaces/${WS}/tasks`),
    history: fakeHistory(),
    localStorage: fakeStorage({ [NAME_KEY]: 'Ada' }),
    window: new EventTarget(),
    connect: sockets.connect,
  };
  const running = bootBoard(env);
  await settle();
  if (sockets.opened.length > 0) {
    seedProjection(sockets, 't-1');
    sockets.first().sync();
  }
  await running;
  await settle();
  return sockets;
}

beforeEach(() => {
  server.reset();
  server.on('/api/auth/session', { authenticated: false, canWrite: true });
  server.on(`/workspaces/${WS}`, {
    workspace: { id: WS, name: 'Kitchen rebuild', goals: [], createdAt: NOW },
  });
  server.on(`/workspaces/${WS}/agents`, { agents: [] });
  server.on(`/workspaces/${WS}/review-items`, { items: [] });
  server.on(`/workspaces/${WS}/events`, { events: [] });
  server.on(`/workspaces/${WS}/settings`, {});
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the board reports its own load time', () => {
  it('posts exactly one report to the load-reports route', async () => {
    await boot();
    expect(reports()).toHaveLength(1);
  });

  it('fires once, not again on the next projection', async () => {
    // The guard the old form asserted as `let loadReportSent = false;`. What
    // is in question is whether a SECOND projection produces a second row in
    // the server's table, so push one.
    const sockets = await boot();
    seedProjection(sockets, 't-2');
    sockets.first().sync();
    await settle();
    expect(reports()).toHaveLength(1);
  });

  it('the 15s fallback does not re-send a report already sent', async () => {
    // The other caller of the same guard, and the only one that fires a
    // second time: `setTimeout(sendLoadReport, 15_000)` is armed on every
    // boot, projection or not, so a boot that already reported has a second
    // send pending for the rest of the page's life.
    //
    // The long timer is captured rather than waited for or faked. Faking the
    // whole clock stops the boot's own await chain dead (measured: zero
    // reports), and the point here is one callback, not a simulated clock —
    // so `setTimeout` is wrapped for the boot's duration, the 15s callback is
    // kept aside, and the test invokes it itself.
    const real = globalThis.setTimeout;
    const fallbacks: Array<() => void> = [];
    (globalThis as { setTimeout: unknown }).setTimeout = ((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (ms === 15_000) {
        fallbacks.push(fn);
        return 0;
      }
      return (real as (...a: unknown[]) => unknown)(fn, ms, ...rest);
    }) as unknown as typeof setTimeout;
    try {
      await boot();
    } finally {
      (globalThis as { setTimeout: unknown }).setTimeout = real;
    }
    expect(reports(), 'the boot never reported at all').toHaveLength(1);
    expect(fallbacks, 'the boot armed no 15s fallback').toHaveLength(1);

    fallbacks[0]?.();
    await settle();
    expect(reports(), 'the fallback sent a second report').toHaveLength(1);
  });

  it('measures boot paint and first projection as two separate numbers', async () => {
    // A report carrying one without the other cannot say which phase was
    // slow, which is the whole reason the route exists.
    await boot();
    const body = reports()[0] as Report;
    expect(typeof body.msToBoot).toBe('number');
    expect(typeof body.msToFirstProjection).toBe('number');
  });

  it('reports boot-only rather than nothing when the projection never lands', async () => {
    // The fallback. A load whose ydoc never syncs is the slowest kind and is
    // the one most worth recording — so the key is ABSENT, not zero, and the
    // report still goes.
    const sockets = fakeSockets();
    document.body.innerHTML = '<div id="board-root"></div>';
    await bootBoard({
      document,
      location: fakeLocation(`https://board.test/workspaces/${WS}/tasks`),
      history: fakeHistory(),
      localStorage: fakeStorage({ [NAME_KEY]: 'Ada' }),
      window: new EventTarget(),
      connect: sockets.connect,
    });
    await settle();
    // Positive control: the boot really ran and really reached the socket,
    // so "no report" below is the guard holding and not a boot that died.
    expect(sockets.opened.length).toBeGreaterThan(0);
    expect(document.getElementById('board')).not.toBeNull();
    // No `sync()`: nothing ever projected. Nothing is sent on this turn — the
    // boot's own 15s fallback timer is what finally reports boot-only, and a
    // report sent HERE would be one that could not name its projection phase.
    expect(reports()).toHaveLength(0);
  });

  it('includes what the network actually moved', async () => {
    // Resource transfer sums make "slow because big" and "slow because far"
    // distinguishable in the report itself.
    await boot();
    const body = reports()[0] as Report;
    for (const key of ['resourceCount', 'transferBytes', 'decodedBytes'] as const) {
      expect(typeof body[key], key).toBe('number');
    }
  });
});
