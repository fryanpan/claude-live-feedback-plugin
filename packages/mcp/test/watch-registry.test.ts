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
 * SSE loop starter and the shared watcher map as arguments, so all of that is
 * a fake here. No socket, no server, no clock.
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

function harness(over: Partial<WatchRegistryDeps> & { opens?: boolean; httpFails?: boolean } = {}) {
  const watchers = new Map<string, Watcher>();
  const sent: Sent[] = [];
  const opened: Opened[] = [];
  const logged: unknown[][] = [];
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
    identityIsShared: false,
    log: (...args) => logged.push(args),
    ...over,
  };
  return { registry: createWatchRegistry(deps), watchers, sent, opened, logged };
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

describe('watching a doc opens one stream and mirrors the change', () => {
  it('opens the doc stream and posts the addition', async () => {
    const { registry, sent, opened, watchers } = harness();
    await expect(registry.watchDoc('plan')).resolves.toBe(true);
    expect(opened).toEqual([{ label: 'plan', path: '/events/plan' }]);
    expect(sent).toEqual([
      { method: 'POST', path: WATCHES_PATH, body: { add: ['plan'], name: 'Workspaces' } },
    ]);
    expect(watchers.get('plan')?.open).toBe(true);
  });

  it('percent-encodes a docId that would otherwise break the path', async () => {
    const { registry, opened } = harness();
    await registry.watchDoc('a/b c');
    expect(opened[0]?.path).toBe('/events/a%2Fb%20c');
  });

  it('opens the stream once for a doc already watched', async () => {
    const { registry, opened } = harness();
    await registry.watchDoc('plan');
    await registry.watchDoc('plan');
    expect(opened).toHaveLength(1);
  });

  it('still re-posts a doc already watched, because an earlier persist may have failed', async () => {
    const { registry, sent } = harness();
    await registry.watchDoc('plan');
    await registry.watchDoc('plan');
    expect(sent).toHaveLength(2);
  });

  it('skips the mirror when the caller asked for a local-only watch', async () => {
    const { registry, sent, opened } = harness();
    await expect(registry.watchDoc('plan', false)).resolves.toBe(false);
    expect(opened).toHaveLength(1);
    expect(sent).toEqual([]);
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

  it('reports the open stream and the failed persist separately', async () => {
    const { registry } = harness({ httpFails: true });
    await expect(registry.watchWorkspace('w1')).resolves.toEqual({
      open: true,
      persisted: false,
    });
  });

  it('names itself on the workspace stream so the server can address it', async () => {
    const { registry, opened } = harness();
    await registry.watchWorkspace('w1');
    expect(opened).toEqual([
      { label: 'ws:w1', path: '/events/workspace/w1?agentId=agent-workspaces' },
    ]);
  });

  it('reports an already-open workspace without re-opening the stream', async () => {
    const { registry, opened } = harness();
    await registry.watchWorkspace('w1');
    await expect(registry.watchWorkspace('w1')).resolves.toEqual({
      open: true,
      persisted: true,
    });
    expect(opened).toHaveLength(1);
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

describe('unwatching aborts the stream and forgets the key on the server', () => {
  it('aborts, deletes and posts the removal', async () => {
    const { registry, watchers, sent } = harness();
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
    const { registry, sent, opened } = harness({ identityIsShared: true });
    await expect(registry.watchDoc('plan')).resolves.toBe(false);
    expect(opened).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(registry.watchPersistenceMode()).toBe('session-only');
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
            unattachedBoards: [{ workspaceId: 'w1', name: 'Hub', queuedTotal: 2 }],
          },
        };
      },
    });
    const cov = await registry.refreshCoverage();
    expect(cov?.unattachedBoards).toEqual([{ workspaceId: 'w1', name: 'Hub', queuedTotal: 2 }]);
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
