/**
 * A respawned session gets its watch set AND its attachments back.
 *
 * Re-subscribing alone was the original half-fix: the keys came back, the
 * attachment record hydrated with the heartbeat from before the restart, and
 * every lead-addressed delivery — which asks for a LIVE attachment — kept
 * queuing for a session that was listening and invisible. This suite drives
 * both halves, plus the backlog the attach response drains and the notice
 * that has to reach the session unprompted.
 *
 * `createWatchRestore` takes the HTTP client, the registry, the deferred
 * emitter, the notification sink and the clock as arguments, so the backoff
 * is advanced rather than waited on. All fixtures synthetic.
 */
import { describe, expect, it } from 'vitest';
import { type DeferredEmitter, createDeferredEmitter } from '../src/deferred-emit.ts';
import type { Watcher } from '../src/sse-loop.ts';
import type { WatchCoverage } from '../src/watch-coverage.ts';
import type { WatchRegistry } from '../src/watch-registry.ts';
import { type WatchRestoreDeps, createWatchRestore } from '../src/watch-restore.ts';

const AUTHOR = { id: 'agent-workspaces', name: 'Workspaces' };
const WATCHES_PATH = '/api/agents/agent-workspaces/watches';

type Sent = { method: string; path: string; body: unknown };

/** A coverage block naming one board this session leads and has gone stale on. */
function coverageWithStaleBoard(workspaceId = 'w1'): WatchCoverage {
  return {
    agentId: AUTHOR.id,
    workspaces: [
      {
        key: `ws:${workspaceId}`,
        workspaceId,
        kind: 'board',
        lead: true,
        attached: true,
        heartbeatFresh: false,
      },
    ],
    unattachedBoards: [],
  };
}

function harness(
  opts: {
    respond?: (method: string, path: string, body: unknown) => unknown;
    coverage?: WatchCoverage;
    identityIsShared?: boolean;
    now?: () => number;
    /** Pins the retry backoff's jitter draw, so the schedule is readable. */
    random?: () => number;
    alreadyWatched?: string[];
    deferredEmits?: DeferredEmitter;
  } = {},
) {
  const sent: Sent[] = [];
  const watched: Array<{ kind: 'doc' | 'ws'; key: string; persist?: boolean }> = [];
  const attached: string[] = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const notified: Array<{ content: string; meta: Record<string, unknown> }> = [];
  let coverage = opts.coverage;
  let refreshes = 0;
  const watchers = new Map<string, Watcher>(
    (opts.alreadyWatched ?? []).map((k) => [
      k,
      { controller: new AbortController(), docId: k, open: true },
    ]),
  );
  const registry: WatchRegistry = {
    watchDoc: async (docId, persist) => {
      watched.push({ kind: 'doc', key: docId, persist });
      return true;
    },
    watchWorkspace: async (workspaceId, persist) => {
      watched.push({ kind: 'ws', key: workspaceId, persist });
      return { open: true, persisted: true };
    },
    unwatchDoc: async () => true,
    streamMode: () => 'multiplexed',
    refreshCoverage: async () => {
      refreshes += 1;
      return coverage;
    },
    coverage: () => coverage,
    setCoverage: (next) => {
      coverage = next;
    },
    watchPersistenceMode: () => 'server',
    lastPersistError: () => undefined,
    watchesPath: () => WATCHES_PATH,
  };
  const deferredEmits = opts.deferredEmits ?? createDeferredEmitter((fn) => fn());
  const deps: WatchRestoreDeps = {
    http: async (method, path, body) => {
      sent.push({ method, path, body });
      const answer = opts.respond?.(method, path, body);
      if (answer instanceof Error) throw answer;
      return answer ?? {};
    },
    registry,
    watchers,
    author: AUTHOR,
    pluginVersion: '0.1.999',
    processId: 'process-nonce',
    markAttached: (id) => attached.push(id),
    notify: async (n) => {
      notified.push(n.params);
    },
    emitChannelMessage: async (event, payload) => {
      emitted.push({ event, payload });
    },
    shouldForward: () => true,
    deferredEmits,
    identityIsShared: opts.identityIsShared ?? false,
    now: opts.now,
    ...(opts.random ? { random: opts.random } : {}),
  };
  return {
    restore: createWatchRestore(deps),
    sent,
    watched,
    attached,
    emitted,
    notified,
    refreshes: () => refreshes,
  };
}

describe('the stored set comes back', () => {
  it('re-wires every key the server was holding, without re-persisting it', async () => {
    const h = harness({
      respond: () => ({ watches: [{ key: 'plan' }, { key: 'ws:w1' }], pruned: ['gone'] }),
    });
    await h.restore.ensureWatchesRestored();
    expect(h.watched).toEqual([
      { kind: 'doc', key: 'plan', persist: false },
      { kind: 'ws', key: 'w1', persist: false },
    ]);
    const state = h.restore.state();
    expect(state.status).toBe('restored');
    expect(state.from).toBe('server');
    expect(state.restored).toEqual(['plan', 'ws:w1']);
    expect(state.pruned).toEqual(['gone']);
    expect(state.attempts).toBe(1);
  });

  it('leaves a key this run already wired alone', async () => {
    const h = harness({
      alreadyWatched: ['plan'],
      respond: () => ({ watches: [{ key: 'plan' }, { key: 'spec' }] }),
    });
    await h.restore.ensureWatchesRestored();
    expect(h.watched).toEqual([{ kind: 'doc', key: 'spec', persist: false }]);
    expect(h.restore.state().restored).toEqual(['spec']);
  });

  it('is a no-op once restored', async () => {
    const h = harness({ respond: () => ({ watches: [] }) });
    await h.restore.ensureWatchesRestored();
    await h.restore.ensureWatchesRestored();
    expect(h.sent.filter((s) => s.method === 'GET')).toHaveLength(1);
  });

  it('runs one request for two concurrent callers', async () => {
    const h = harness({ respond: () => ({ watches: [{ key: 'plan' }] }) });
    await Promise.all([h.restore.ensureWatchesRestored(), h.restore.ensureWatchesRestored()]);
    expect(h.sent.filter((s) => s.method === 'GET')).toHaveLength(1);
  });

  it('asks the server for nothing when the identity is shared', async () => {
    const h = harness({ identityIsShared: true, respond: () => ({ watches: [{ key: 'x' }] }) });
    await h.restore.ensureWatchesRestored();
    expect(h.sent).toEqual([]);
    expect(h.restore.state().status).toBe('session-only');
  });
});

describe('the attachment comes back too, not just the subscription', () => {
  it('re-attaches every stale board it already led, and marks it fresh', async () => {
    const h = harness({
      coverage: coverageWithStaleBoard(),
      respond: (method, path) =>
        method === 'GET' && path === WATCHES_PATH
          ? { watches: [], coverage: coverageWithStaleBoard() }
          : {},
    });
    await h.restore.ensureWatchesRestored();
    const attach = h.sent.find((s) => s.path === '/api/workspaces/w1/attachments');
    expect(attach).toEqual({
      method: 'POST',
      path: '/api/workspaces/w1/attachments',
      body: {
        agentId: AUTHOR.id,
        agentName: AUTHOR.name,
        runtime: 'claude-code-local',
        pluginVersion: '0.1.999',
        processId: 'process-nonce',
      },
    });
    expect(h.attached).toEqual(['w1']);
    expect(h.restore.state().reattached).toEqual(['w1']);
  });

  it('re-reads coverage after attaching, so the notice describes the state it is in now', async () => {
    const h = harness({
      coverage: coverageWithStaleBoard(),
      respond: () => ({ watches: [], coverage: coverageWithStaleBoard() }),
    });
    await h.restore.ensureWatchesRestored();
    expect(h.refreshes()).toBe(1);
  });

  it('attaches to no board when nothing was stale', async () => {
    const h = harness({ respond: () => ({ watches: [] }) });
    await h.restore.ensureWatchesRestored();
    expect(h.sent.filter((s) => s.method === 'POST')).toEqual([]);
    expect(h.restore.state().reattached).toEqual([]);
  });

  it('still finishes when one board refuses the attach', async () => {
    const h = harness({
      coverage: coverageWithStaleBoard(),
      respond: (_method, path) =>
        path.endsWith('/attachments')
          ? new Error('board gone')
          : { watches: [], coverage: coverageWithStaleBoard() },
    });
    await h.restore.ensureWatchesRestored();
    expect(h.restore.state().status).toBe('restored');
    expect(h.restore.state().reattached).toEqual([]);
  });
});

describe('the backlog the attach drains is delivered, not swallowed by its own arrival', () => {
  it('emits each queued comment and acks it afterwards', async () => {
    const order: string[] = [];
    const h = harness({
      coverage: coverageWithStaleBoard(),
      respond: (_method, path) => {
        if (path.endsWith('/attachments')) {
          return {
            queuedComments: [
              {
                id: 'row-1',
                docId: 'plan',
                threadId: 't1',
                event: 'thread.replied',
                text: 'queued while you were gone',
              },
            ],
          };
        }
        if (path.includes('/comment-queue/')) order.push(`ack:${path}`);
        return { watches: [], coverage: coverageWithStaleBoard() };
      },
    });
    await h.restore.ensureWatchesRestored();
    expect(h.emitted.map((e) => e.event)).toEqual(['thread.replied']);
    expect(order).toEqual(['ack:/api/workspaces/w1/comment-queue/row-1/ack']);
  });

  it('holds the notice until the tool call in flight has answered', async () => {
    // The measured incident: the restore runs inside the first tool call's
    // await, so a notice written there lands between a `tools/call` request
    // and its response — the one window a session does not read.
    let flush: (() => void) | undefined;
    const deferredEmits = createDeferredEmitter((fn) => {
      flush = fn;
    });
    const h = harness({
      deferredEmits,
      respond: () => ({ watches: [{ key: 'plan' }] }),
    });
    const endToolCall = deferredEmits.beginToolCall();
    await h.restore.ensureWatchesRestored();
    expect(h.notified).toEqual([]);
    expect(deferredEmits.pending()).toBe(1);
    endToolCall();
    flush?.();
    // The emitter drains on its own microtask once released.
    for (let i = 0; i < 50 && h.notified.length === 0; i++) await Promise.resolve();
    expect(h.notified).toHaveLength(1);
  });
});

describe('the notice reaches the session unprompted, or says nothing', () => {
  it('names what was re-wired and what was re-attached', async () => {
    const h = harness({
      coverage: coverageWithStaleBoard(),
      respond: (_method, path) =>
        path.endsWith('/attachments')
          ? {}
          : { watches: [{ key: 'plan' }], coverage: coverageWithStaleBoard() },
    });
    await h.restore.ensureWatchesRestored();
    expect(h.notified).toHaveLength(1);
    const notice = h.notified[0] as { content: string; meta: Record<string, unknown> };
    expect(notice.content).toContain('[watches restored]');
    expect(notice.content).toContain('plan');
    expect(notice.content).toContain('[attachments restored]');
    expect(notice.meta).toMatchObject({ event: 'watches.restored', restored: ['plan'] });
  });

  it('says nothing when there is nothing to report', async () => {
    const h = harness({ respond: () => ({ watches: [] }) });
    await h.restore.ensureWatchesRestored();
    expect(h.notified).toEqual([]);
  });
});

describe('a server that did not answer is retried, on a backoff', () => {
  it('records the failure rather than throwing', async () => {
    const h = harness({ respond: () => new Error('ECONNREFUSED') });
    await expect(h.restore.ensureWatchesRestored()).resolves.toBeUndefined();
    const state = h.restore.state();
    expect(state.status).toBe('failed');
    expect(state.error).toContain('ECONNREFUSED');
    expect(state.attempts).toBe(1);
  });

  it('makes no request again until the backoff has lapsed', async () => {
    let clock = 0;
    // Full jitter with the draw pinned at the top of the window: the first
    // failure's window is 2s, so this waits just under it.
    const h = harness({
      respond: () => new Error('down'),
      now: () => clock,
      random: () => 0.999,
    });
    await h.restore.ensureWatchesRestored();
    clock = 1_000;
    await h.restore.ensureWatchesRestored();
    expect(h.sent).toHaveLength(1);
    clock = 3_000;
    await h.restore.ensureWatchesRestored();
    expect(h.sent).toHaveLength(2);
    expect(h.restore.state().attempts).toBe(2);
  });

  it('draws the retry delay from the whole window, so restarts do not reconverge', async () => {
    // Restore-on-attach is the one call every session makes at the same
    // moment after a server restart. An unjittered schedule puts the whole
    // fleet back on one instant — the herd that turned a single restart into
    // twenty. A low draw retries immediately; a high one waits nearly the
    // full window.
    let clock = 0;
    const eager = harness({
      respond: () => new Error('down'),
      now: () => clock,
      random: () => 0,
    });
    await eager.restore.ensureWatchesRestored();
    clock = 1;
    await eager.restore.ensureWatchesRestored();
    expect(eager.sent).toHaveLength(2);

    clock = 0;
    const patient = harness({
      respond: () => new Error('down'),
      now: () => clock,
      random: () => 0.999,
    });
    await patient.restore.ensureWatchesRestored();
    clock = 1;
    await patient.restore.ensureWatchesRestored();
    expect(patient.sent).toHaveLength(1);
  });

  it('succeeds on a later attempt and stops retrying', async () => {
    let clock = 0;
    let down = true;
    const h = harness({
      respond: () => (down ? new Error('down') : { watches: [{ key: 'plan' }] }),
      now: () => clock,
    });
    await h.restore.ensureWatchesRestored();
    down = false;
    clock = 10_000;
    await h.restore.ensureWatchesRestored();
    expect(h.restore.state().status).toBe('restored');
    expect(h.restore.state().restored).toEqual(['plan']);
  });
});
