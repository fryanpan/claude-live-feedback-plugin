/**
 * Durable agent watches — the store, and the route in front of it.
 *
 * The route is the layer a unit test misses ("the route layer silently drops
 * params"), so every behaviour that matters to the MCP child is asserted
 * through real HTTP against a real server, and the store's own tests cover
 * the parts the route only forwards (union, prune, persistence, corrupt
 * file). Every absence assertion sits next to its positive control in the
 * same test: a different agent reading `[]` proves nothing unless the agent
 * that DID watch reads its set back in the same pass.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentWatches,
  SHARED_IDENTITY_ERROR,
  isValidAgentId,
  isValidWatchKey,
} from '../src/agent-watches.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

describe('AgentWatches store', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('unions on add, deletes on remove, and keeps `since` across re-adds', () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-watches-'));
    let t = 1_000;
    const store = new AgentWatches({ dataDir: dir, now: () => t });
    store.update('agent-alpha', { add: ['doc-a', 'doc-b'] });
    t = 2_000;
    // A second writer for the same identity — its set MERGES.
    const merged = store.update('agent-alpha', { add: ['doc-b', 'doc-c'] });
    expect(merged.watches.map((w) => w.key)).toEqual(['doc-a', 'doc-b', 'doc-c']);
    expect(merged.added).toEqual(['doc-c']);
    // doc-b was re-added: its `since` is the FIRST time, not the second.
    expect(merged.watches.find((w) => w.key === 'doc-b')?.since).toBe(1_000);

    const removed = store.update('agent-alpha', { remove: ['doc-a', 'never-there'] });
    expect(removed.removed).toEqual(['doc-a']);
    expect(removed.watches.map((w) => w.key)).toEqual(['doc-b', 'doc-c']);
  });

  it('survives a new instance over the same data dir (the whole point)', () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-watches-'));
    new AgentWatches({ dataDir: dir }).update('agent-alpha', { add: ['doc-a'], name: 'Alpha' });
    const again = new AgentWatches({ dataDir: dir });
    expect(again.loadError).toBeNull();
    expect(again.list('agent-alpha', () => true).watches.map((w) => w.key)).toEqual(['doc-a']);
    // And the identity next door is untouched — the positive control for
    // "keyed on the agent, not on the server".
    expect(again.list('agent-beta', () => true).watches).toEqual([]);
  });

  it('prunes keys the caller says no longer exist, on read, and reports them', () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-watches-'));
    const store = new AgentWatches({ dataDir: dir });
    store.update('agent-alpha', { add: ['live', 'gone', 'ws:gone-too'] });
    const res = store.list('agent-alpha', (k) => k === 'live');
    expect(res.watches.map((w) => w.key)).toEqual(['live']);
    expect(res.pruned.sort()).toEqual(['gone', 'ws:gone-too']);
    // The prune persisted: a fresh reader with an all-yes predicate does not
    // see the dead keys come back.
    const again = new AgentWatches({ dataDir: dir });
    expect(again.list('agent-alpha', () => true).watches.map((w) => w.key)).toEqual(['live']);
  });

  it('moves a corrupt file aside rather than overwriting it', () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-watches-'));
    writeFileSync(join(dir, 'agent-watches.json'), '{ not json');
    const store = new AgentWatches({ dataDir: dir });
    expect(store.loadError).toMatch(/moved to/);
    // Starts empty and usable…
    store.update('agent-alpha', { add: ['doc-a'] });
    expect(store.list('agent-alpha', () => true).watches.map((w) => w.key)).toEqual(['doc-a']);
    // …and the bad bytes are still on disk under a sibling name.
    const aside = readdirSync(dir).filter((f) => f.startsWith('agent-watches.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0] as string), 'utf8')).toBe('{ not json');
  });

  it('validates keys and ids the way the docId rules do', () => {
    expect(isValidWatchKey('doc-a')).toBe(true);
    expect(isValidWatchKey('ws:abc123')).toBe(true);
    expect(isValidWatchKey('task:t-abc')).toBe(true);
    expect(isValidWatchKey('.hidden')).toBe(false);
    expect(isValidWatchKey('has space')).toBe(false);
    expect(isValidWatchKey('')).toBe(false);
    expect(isValidWatchKey(42)).toBe(false);
    expect(isValidAgentId('agent-alpha')).toBe(true);
    expect(isValidAgentId('known-bryan')).toBe(true);
    expect(isValidAgentId('')).toBe(false);
    expect(isValidAgentId('a/b')).toBe(false);
  });
});

describe('/api/agents/:agentId/watches', () => {
  let handle: ServerHandle | null = null;
  let dataDir: string | null = null;

  const start = () => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-watches-route-'));
    handle = createServer({ port: 0, dataDir });
    return `http://localhost:${handle.port}`;
  };

  afterEach(async () => {
    await handle?.stop();
    handle = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  const call = async (base: string, agentId: string, method: 'GET' | 'POST', body?: unknown) => {
    const res = await fetch(`${base}/api/agents/${encodeURIComponent(agentId)}/watches`, {
      method,
      headers: {
        host: `localhost:${handle?.port ?? 0}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  const createDoc = async (base: string, docId: string) => {
    const path = join(dataDir as string, `${docId}.md`);
    writeFileSync(path, `# ${docId}\n\nBody.\n`);
    const res = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { host: `localhost:${handle?.port ?? 0}`, 'content-type': 'application/json' },
      body: JSON.stringify({ docId, sourceUrl: path }),
    });
    expect(res.status).toBe(200);
  };

  it('remembers what one identity watched, and hands a different identity nothing', async () => {
    const base = start();
    await createDoc(base, 'doc-one');
    await createDoc(base, 'doc-two');

    const post = await call(base, 'agent-alpha', 'POST', { add: ['doc-one', 'doc-two'] });
    expect(post.status).toBe(200);
    expect((post.json.watches as Array<{ key: string }>).map((w) => w.key)).toEqual([
      'doc-one',
      'doc-two',
    ]);

    // The restore read — what a respawned child asks.
    const restored = await call(base, 'agent-alpha', 'GET');
    expect(restored.status).toBe(200);
    expect((restored.json.watches as Array<{ key: string }>).map((w) => w.key)).toEqual([
      'doc-one',
      'doc-two',
    ]);
    expect(restored.json.pruned).toEqual([]);

    // Positive control for the absence below: alpha's read is non-empty in
    // the same pass, so beta's `[]` is an answer about beta, not about the
    // route being blind.
    const other = await call(base, 'agent-beta', 'GET');
    expect(other.status).toBe(200);
    expect(other.json.watches).toEqual([]);
    expect(other.json.updatedAt).toBeNull();

    // And the store the route wrote is the store on disk.
    expect(existsSync(join(dataDir as string, 'agent-watches.json'))).toBe(true);
  });

  it('unions a second writer for the same identity instead of replacing', async () => {
    const base = start();
    await createDoc(base, 'doc-one');
    await createDoc(base, 'doc-two');
    await call(base, 'agent-alpha', 'POST', { add: ['doc-one'] });
    // A second live session with the same name reports only its own doc…
    const second = await call(base, 'agent-alpha', 'POST', { add: ['doc-two'] });
    // …and the set is the union, not the last writer.
    expect((second.json.watches as Array<{ key: string }>).map((w) => w.key)).toEqual([
      'doc-one',
      'doc-two',
    ]);
    const removed = await call(base, 'agent-alpha', 'POST', { remove: ['doc-one'] });
    expect((removed.json.watches as Array<{ key: string }>).map((w) => w.key)).toEqual(['doc-two']);
  });

  it('prunes a watch whose doc is gone on read — and keeps the live one beside it', async () => {
    const base = start();
    await createDoc(base, 'doc-live');
    // `doc-ghost` was watched before it existed (the auto-watch fires ahead
    // of the creating tool) and the tool then failed, so it never appeared.
    await call(base, 'agent-alpha', 'POST', { add: ['doc-live', 'doc-ghost'] });
    const res = await call(base, 'agent-alpha', 'GET');
    expect((res.json.watches as Array<{ key: string }>).map((w) => w.key)).toEqual(['doc-live']);
    expect(res.json.pruned).toEqual(['doc-ghost']);
    // The read is what the store persisted, so it does not come back later.
    const again = await call(base, 'agent-alpha', 'GET');
    expect(again.json.pruned).toEqual([]);
    expect(handle?.agentWatches.list('agent-alpha', () => true).watches.map((w) => w.key)).toEqual([
      'doc-live',
    ]);
  });

  it('treats `ws:<id>` as live for a hub workspace, and dead for a workspace nobody made', async () => {
    const base = start();
    const ws = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { host: `localhost:${handle?.port ?? 0}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'watch-ws', goal: 'Keep watching.' }),
    });
    expect(ws.status).toBe(200);
    const wsId = ((await ws.json()) as { workspace?: { id?: string } }).workspace?.id as string;
    expect(wsId).toBeTruthy();

    await call(base, 'agent-alpha', 'POST', { add: [`ws:${wsId}`, 'ws:no-such-workspace'] });
    const res = await call(base, 'agent-alpha', 'GET');
    expect((res.json.watches as Array<{ key: string }>).map((w) => w.key)).toEqual([`ws:${wsId}`]);
    expect(res.json.pruned).toEqual(['ws:no-such-workspace']);
  });

  it('refuses the shared identity with a message that says how to fix it — and reports no coverage for it', async () => {
    const base = start();
    await createDoc(base, 'doc-one');
    for (const shared of ['known-agent', 'agent']) {
      const res = await call(base, shared, 'POST', { add: ['doc-one'] });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe(SHARED_IDENTITY_ERROR);
      expect(String(res.json.message)).toContain('CW_AGENT_NAME');
      const read = await call(base, shared, 'GET');
      expect(read.status).toBe(400);
      // ABSENT, not fabricated. A shared identity is the union of every
      // anonymous session, so any coverage answer here would describe
      // somebody — just nobody in particular. An empty coverage block would
      // read as "you are fully covered", which is the exact reassuring lie
      // this whole readout exists to stop telling.
      expect(read.json.coverage).toBeUndefined();
    }
    // Positive control: a named identity on the same server is served, and
    // DOES get a coverage block — so the absence above is about the identity
    // rather than about the route having quietly stopped building one.
    const ok = await call(base, 'agent-alpha', 'POST', { add: ['doc-one'] });
    expect(ok.status).toBe(200);
    const named = await call(base, 'agent-alpha', 'GET');
    expect(named.status).toBe(200);
    expect((named.json.coverage as { agentId: string }).agentId).toBe('agent-alpha');
  });

  it('refuses a malformed key rather than storing it', async () => {
    const base = start();
    const res = await call(base, 'agent-alpha', 'POST', { add: ['ok-key', 'has space'] });
    expect(res.status).toBe(400);
    expect(res.json.key).toBe('has space');
    // Nothing from the refused request landed — including the valid half.
    expect(handle?.agentWatches.list('agent-alpha', () => true).watches).toEqual([]);
  });
});
