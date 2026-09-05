/**
 * Subscribing, unsubscribing, and mirroring the set onto the server.
 *
 * The registry's contract has two halves that must never be collapsed into
 * one boolean: whether the STREAM opened (events now) and whether the WATCH
 * persisted (events after the next respawn). A caller told `true` for the
 * pair it did not ask about is exactly how a session ended up reassured about
 * the half that worked.
 *
 * `createWatchRegistry` takes the HTTP client, this session's identity, the
 * SSE loop starter, the session's ONE multiplexed loop and the shared watcher
 * map as arguments, so all of that is a fake here. No socket, no server, no
 * clock.
 *
 * The transport moved under this contract on 2026-09-04 and the contract did
 * not move with it. N watches now ride ONE stream — that is what the socket
 * exhaustion forced — so the default harness gives the registry a working mux
 * and counts how many loops it starts. The per-key assertions did not go away:
 * they moved under `muxUnsupported`, which is the live rollout state of a
 * bundle talking to a server that predates the route, and they still have to
 * hold there.
 */
import { describe, expect, it } from 'vitest';
import type { Watcher } from '../src/sse-loop.ts';
import {
  SHARED_IDENTITY_REASON,
  type WatchRegistryDeps,
  createWatchRegistry,
  isSharedIdentity,
} from '../src/watch-registry.ts';

const AUTHOR = { id: 'agent-workspaces', name: 'Workspaces' };
const WATCHES_PATH = '/api/agents/agent-workspaces/watches';

type Sent = { method: string; path: string; body: unknown };
type Opened = { label: string; path: string };

/** A stand-in for the session's one multiplexed loop. `starts` is the number
 *  of times it actually connected — the "N watches, one socket" measurement. */
function fakeMux(over: { opens?: boolean; unsupported?: boolean } = {}) {
  const state = {
    running: false,
    open: false,
    starts: 0,
    stops: 0,
    /** Cursor keys the registry asked the loop to forget. */
    dropped: [] as string[],
  };
  return {
    state,
    loop: {
      ensureOpen: async () => {
        if (over.unsupported) return false;
        if (!state.running) {
          state.running = true;
          state.starts += 1;
          state.open = over.opens ?? true;
        }
        return state.open;
      },
      stop: () => {
        if (!state.running) return;
        state.running = false;
        state.open = false;
        state.stops += 1;
      },
      isOpen: () => state.open,
      unsupported: () => over.unsupported === true,
      loopCount: () => (state.running ? 1 : 0),
      dropCursor: (key: string) => {
        state.dropped.push(key);
      },
      cursorCount: () => 0,
    },
  };
}

function harness(
  over: Partial<WatchRegistryDeps> & {
    opens?: boolean;
    httpFails?: boolean;
    muxUnsupported?: boolean;
  } = {},
) {
  const watchers = new Map<string, Watcher>();
  const sent: Sent[] = [];
  const opened: Opened[] = [];
  const logged: unknown[][] = [];
  const mux = fakeMux({
    ...(over.opens !== undefined ? { opens: over.opens } : {}),
    ...(over.muxUnsupported ? { unsupported: true } : {}),
  });
  const deps: WatchRegistryDeps = {
    watchers,
    http: async (method, path, body) => {
      sent.push({ method, path, body });
      if (over.httpFails) throw new Error('server down');
      return {};
    },
    author: AUTHOR,
    startSseLoop: async (label, path, controller) => {
      opened.push({ label, path });
      const w = watchers.get(label);
      const open = over.opens ?? true;
      if (w) w.open = open;
      void controller;
      return open;
    },
    mux: mux.loop,
    identityIsShared: false,
    log: (...args) => logged.push(args),
    ...over,
  };
  return { registry: createWatchRegistry(deps), watchers, sent, opened, logged, mux: mux.state };
}

describe('isSharedIdentity names the one id that must not key a watch set', () => {
  it('is true only for the anonymous fallback', () => {
    expect(isSharedIdentity('known-agent')).toBe(true);
    expect(isSharedIdentity('agent-workspaces')).toBe(false);
    expect(isSharedIdentity('known-bryan')).toBe(false);
  });

  it('says how to fix it', () => {
    expect(SHARED_IDENTITY_REASON).toContain('CW_AGENT_NAME');
  });
});

describe('watching a doc rides the one stream and mirrors the change', () => {
  it('starts the one loop and posts the addition', async () => {
    const { registry, sent, opened, watchers, mux } = harness();
    await expect(registry.watchDoc('plan')).resolves.toBe(true);
    // No per-key socket at all — the whole point of the change.
    expect(opened).toEqual([]);
    expect(mux.starts).toBe(1);
    expect(sent).toEqual([
      { method: 'POST', path: WATCHES_PATH, body: { add: ['plan'], name: 'Workspaces' } },
    ]);
    expect(watchers.get('plan')?.open).toBe(true);
    expect(registry.streamMode()).toBe('multiplexed');
  });

  it('holds N watches on ONE loop', async () => {
    // The measurement the outage was about: a lead session with 214 watches
    // held 214 sockets, and the fleet's 332 exhausted the kernel's socket
    // memory. Fifty here, one connection.
    const { registry, mux, opened, watchers } = harness();
    for (let i = 0; i < 50; i++) await registry.watchDoc(`doc-${i}`);
    expect(watchers.size).toBe(50);
    expect(mux.starts).toBe(1);
    expect(opened).toEqual([]);
  });

  it('still re-posts a doc already watched, because an earlier persist may have failed', async () => {
    const { registry, sent } = harness();
    await registry.watchDoc('plan');
    await registry.watchDoc('plan');
    expect(sent).toHaveLength(2);
  });

  it('skips the mirror when the caller asked for a local-only watch', async () => {
    const { registry, sent, mux } = harness();
    await expect(registry.watchDoc('plan', false)).resolves.toBe(false);
    expect(mux.starts).toBe(1);
    expect(sent).toEqual([]);
  });

  it('mirrors the addition BEFORE wiring, because the persisted set IS the channel set', async () => {
    // The server fans out the set it holds, so a key that has not landed
    // there yet is a key the stream does not carry. Order, not decoration.
    const order: string[] = [];
    const { registry } = harness({
      http: async (method, path, body) => {
        order.push(`persist ${JSON.stringify((body as { add?: string[] }).add)}`);
        void method;
        void path;
        return {};
      },
      mux: {
        ensureOpen: async () => {
          order.push('ensureOpen');
          return true;
        },
        stop: () => {},
        isOpen: () => true,
        unsupported: () => false,
        dropCursor: () => {},
        cursorCount: () => 0,
        loopCount: () => 1,
      },
    });
    await registry.watchDoc('plan');
    expect(order).toEqual(['persist ["plan"]', 'ensureOpen']);
  });
});

describe('a server that predates the mux route falls back to a stream per key', () => {
  it('opens the doc stream and posts the addition', async () => {
    const { registry, sent, opened, watchers } = harness({ muxUnsupported: true });
    await expect(registry.watchDoc('plan')).resolves.toBe(true);
    expect(opened).toEqual([{ label: 'plan', path: '/events/plan' }]);
    expect(sent).toEqual([
      { method: 'POST', path: WATCHES_PATH, body: { add: ['plan'], name: 'Workspaces' } },
    ]);
    expect(watchers.get('plan')?.open).toBe(true);
    expect(registry.streamMode()).toBe('per-key');
  });

  it('percent-encodes a docId that would otherwise break the path', async () => {
    const { registry, opened } = harness({ muxUnsupported: true });
    await registry.watchDoc('a/b c');
    expect(opened[0]?.path).toBe('/events/a%2Fb%20c');
  });

  it('opens the stream once for a doc already watched', async () => {
    const { registry, opened } = harness({ muxUnsupported: true });
    await registry.watchDoc('plan');
    await registry.watchDoc('plan');
    expect(opened).toHaveLength(1);
  });

  it('names itself on the workspace stream so the server can address it', async () => {
    const { registry, opened } = harness({ muxUnsupported: true });
    await registry.watchWorkspace('w1');
    expect(opened).toEqual([
      { label: 'ws:w1', path: '/events/workspace/w1?agentId=agent-workspaces' },
    ]);
  });
});

describe('a stream that did not open and a watch that did not persist stay apart', () => {
  it('reports the closed stream and the successful persist separately', async () => {
    const { registry } = harness({ opens: false });
    await expect(registry.watchWorkspace('w1')).resolves.toEqual({
      open: false,
      persisted: true,
    });
  });

  it('reports the open stream and the failed persist separately, per key', async () => {
    // On the per-key transport the two really are independent: the socket for
    // this key is up whatever the server remembers.
    const { registry } = harness({ httpFails: true, muxUnsupported: true });
    await expect(registry.watchWorkspace('w1')).resolves.toEqual({
      open: true,
      persisted: false,
    });
  });

  it('multiplexed, a failed persist also means this key is not being delivered', async () => {
    // The mux stream's channel set IS the persisted set, so a persist that
    // did not land leaves this key uncovered even though the connection is
    // fine. Reporting `open: true` here would be the reassurance about the
    // half that worked which this pair exists to prevent.
    const { registry } = harness({ httpFails: true });
    await expect(registry.watchWorkspace('w1')).resolves.toEqual({
      open: false,
      persisted: false,
    });
  });

  it('reports an already-open workspace without re-opening the stream', async () => {
    const { registry, mux } = harness();
    await registry.watchWorkspace('w1');
    await expect(registry.watchWorkspace('w1')).resolves.toEqual({
      open: true,
      persisted: true,
    });
    expect(mux.starts).toBe(1);
  });
});

describe('a failed mirror is reported, never thrown', () => {
  it('keeps the reason and logs it', async () => {
    const { registry, logged } = harness({ httpFails: true });
    await expect(registry.watchDoc('plan')).resolves.toBe(false);
    expect(registry.lastPersistError()).toBe('server down');
    expect(logged).toHaveLength(1);
  });

  it('clears the reason on the next mirror that lands', async () => {
    let fail = true;
    const { registry } = harness({
      http: async () => {
        if (fail) throw new Error('server down');
        return {};
      },
    });
    await registry.watchDoc('plan');
    expect(registry.lastPersistError()).toBe('server down');
    fail = false;
    await registry.watchDoc('spec');
    expect(registry.lastPersistError()).toBeUndefined();
  });
});

describe('unwatching one key never hangs up the stream the others ride', () => {
  it('keeps the one loop running while any watch remains', async () => {
    const { registry, mux } = harness();
    await registry.watchDoc('plan');
    await registry.watchDoc('spec');
    await registry.unwatchDoc('plan');
    expect(mux.stops).toBe(0);
    expect(mux.running).toBe(true);
  });

  it('closes the loop when the LAST watch goes away', async () => {
    const { registry, mux } = harness();
    await registry.watchDoc('plan');
    await registry.watchDoc('spec');
    await registry.unwatchDoc('plan');
    await registry.unwatchDoc('spec');
    expect(mux.stops).toBe(1);
    expect(mux.running).toBe(false);
  });

  it('re-opens one loop, not two, when a watch comes back', async () => {
    const { registry, mux } = harness();
    await registry.watchDoc('plan');
    await registry.unwatchDoc('plan');
    await registry.watchDoc('plan');
    expect(mux.starts).toBe(2);
    expect(mux.running).toBe(true);
  });
});

describe('unwatching aborts the stream and forgets the key on the server', () => {
  it('aborts, deletes and posts the removal', async () => {
    const { registry, watchers, sent } = harness({ muxUnsupported: true });
    await registry.watchDoc('plan');
    const aborted = watchers.get('plan')?.controller.signal;
    await expect(registry.unwatchDoc('plan')).resolves.toBe(true);
    expect(aborted?.aborted).toBe(true);
    expect(watchers.has('plan')).toBe(false);
    expect(sent.at(-1)).toEqual({
      method: 'POST',
      path: WATCHES_PATH,
      body: { remove: ['plan'], name: 'Workspaces' },
    });
  });

  it('forgets a key this session never wired, because a sibling may have recorded it', async () => {
    const { registry, sent } = harness();
    await expect(registry.unwatchDoc('never-watched')).resolves.toBe(true);
    expect(sent).toEqual([
      {
        method: 'POST',
        path: WATCHES_PATH,
        body: { remove: ['never-watched'], name: 'Workspaces' },
      },
    ]);
  });
});

describe('a shared identity keys nothing on the server', () => {
  it('watches locally and mirrors nothing', async () => {
    const { registry, sent, opened, mux } = harness({ identityIsShared: true });
    await expect(registry.watchDoc('plan')).resolves.toBe(false);
    // A shared identity has no server-side set to fan out — the server refuses
    // to key one on it — so these sessions keep the per-key transport.
    expect(opened).toHaveLength(1);
    expect(mux.starts).toBe(0);
    expect(sent).toEqual([]);
    expect(registry.watchPersistenceMode()).toBe('session-only');
    expect(registry.streamMode()).toBe('per-key');
  });

  it('asks for no coverage read at all', async () => {
    const { registry, sent } = harness({ identityIsShared: true });
    await expect(registry.refreshCoverage()).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  it('reports server persistence for a session with its own identity', () => {
    expect(harness().registry.watchPersistenceMode()).toBe('server');
  });
});

describe('coverage is never fabricated out of a failed request', () => {
  it('reads the block the server sent', async () => {
    const asked: string[] = [];
    const { registry } = harness({
      http: async (method, path) => {
        asked.push(`${method} ${path}`);
        return {
          coverage: {
            agentId: AUTHOR.id,
            workspaces: [],
            unattachedBoards: [{ workspaceId: 'w1', name: 'Board', queuedTotal: 2 }],
          },
        };
      },
    });
    const cov = await registry.refreshCoverage();
    expect(cov?.unattachedBoards).toEqual([{ workspaceId: 'w1', name: 'Board', queuedTotal: 2 }]);
    expect(asked).toEqual([`GET ${WATCHES_PATH}`]);
  });

  it('leaves the previous answer alone when the server is unreachable', async () => {
    let down = false;
    const { registry } = harness({
      http: async () => {
        if (down) throw new Error('server down');
        return { coverage: { agentId: AUTHOR.id, workspaces: [], unattachedBoards: [] } };
      },
    });
    const first = await registry.refreshCoverage();
    expect(first).toBeDefined();
    down = true;
    await expect(registry.refreshCoverage()).resolves.toBe(first);
    expect(registry.coverage()).toBe(first);
  });

  it('stays undefined rather than reading as an all-clear when nothing is known', async () => {
    const { registry } = harness({
      http: async () => {
        throw new Error('server down');
      },
    });
    await expect(registry.refreshCoverage()).resolves.toBeUndefined();
    expect(registry.coverage()).toBeUndefined();
  });

  it('accepts a coverage block read elsewhere', () => {
    const { registry } = harness();
    registry.setCoverage({ agentId: AUTHOR.id, workspaces: [], unattachedBoards: [] });
    expect(registry.coverage()).toEqual({
      agentId: AUTHOR.id,
      workspaces: [],
      unattachedBoards: [],
    });
  });
});

describe('an unwatched key stops costing the reconnect header', () => {
  it("forgets that key's replay position", async () => {
    const h = harness();
    await h.registry.watchDoc('doc-a');
    await h.registry.watchDoc('doc-b');
    await h.registry.unwatchDoc('doc-a');
    // A position on a channel the server will no longer send is a position
    // that can never advance, and the reconnect header's byte budget is
    // finite — every stale entry is one a live key does not get to spend.
    expect(h.mux.dropped).toEqual(['doc-a']);
  });

  it("leaves the surviving keys' positions alone", async () => {
    const h = harness();
    await h.registry.watchDoc('doc-a');
    await h.registry.watchDoc('doc-b');
    await h.registry.unwatchDoc('doc-a');
    expect(h.mux.dropped).not.toContain('doc-b');
    // And the stream the survivor rides is still up.
    expect(h.mux.stops).toBe(0);
  });
});
