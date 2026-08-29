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
import { networkInterfaces, tmpdir } from 'node:os';
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

  it('agentsWatching is the reverse lookup — that key only, shared identities excluded', () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-watches-'));
    const store = new AgentWatches({ dataDir: dir, now: () => 1_000 });
    store.update('agent-alpha', { add: ['ws:w-1', 'doc-a'] });
    store.update('agent-beta', { add: ['ws:w-1'] });
    store.update('agent-gamma', { add: ['ws:w-2'] });
    // A shared identity can end up in the file (the refusal lives at the
    // route); the reverse lookup must never address it — nothing could ever
    // re-send or receipt to "agent".
    store.update('agent', { add: ['ws:w-1'] });
    expect(store.agentsWatching('ws:w-1').sort()).toEqual(['agent-alpha', 'agent-beta']);
    // Positive control: the neighbouring key still answers.
    expect(store.agentsWatching('ws:w-2')).toEqual(['agent-gamma']);
    expect(store.agentsWatching('ws:w-none')).toEqual([]);
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
    // The doc's OWN id, which is what a watch is stored under whichever name
    // the caller watched by.
    return ((await res.json()) as { docId: string }).docId;
  };

  it('remembers what one identity watched, and hands a different identity nothing', async () => {
    const base = start();
    const oneId = await createDoc(base, 'doc-one');
    const twoId = await createDoc(base, 'doc-two');

    // Watched by their READABLE names; stored under the ids they resolve to.
    // Compared SORTED: the watch set is a set, and its order only ever looked
    // meaningful because `doc-one` sorts before `doc-two`.
    const keysOf = (r: { json: Record<string, unknown> }): string[] =>
      (r.json.watches as Array<{ key: string }>).map((w) => w.key).sort();
    const expected = [oneId, twoId].sort();
    const post = await call(base, 'agent-alpha', 'POST', { add: ['doc-one', 'doc-two'] });
    expect(post.status).toBe(200);
    expect(keysOf(post)).toEqual(expected);

    // The restore read — what a respawned child asks.
    const restored = await call(base, 'agent-alpha', 'GET');
    expect(restored.status).toBe(200);
    expect(keysOf(restored)).toEqual(expected);
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
    const oneId = await createDoc(base, 'doc-one');
    const twoId = await createDoc(base, 'doc-two');
    await call(base, 'agent-alpha', 'POST', { add: ['doc-one'] });
    // A second live session with the same name reports only its own doc…
    const second = await call(base, 'agent-alpha', 'POST', { add: ['doc-two'] });
    // …and the set is the union, not the last writer.
    expect((second.json.watches as Array<{ key: string }>).map((w) => w.key).sort()).toEqual(
      [oneId, twoId].sort(),
    );
    // Unwatching by the readable name still finds the canonical key.
    const removed = await call(base, 'agent-alpha', 'POST', { remove: ['doc-one'] });
    expect((removed.json.watches as Array<{ key: string }>).map((w) => w.key)).toEqual([twoId]);
  });

  it('prunes a watch whose doc is gone on read — and keeps the live one beside it', async () => {
    const base = start();
    const liveId = await createDoc(base, 'doc-live');
    // `doc-ghost` was watched before it existed (the auto-watch fires ahead
    // of the creating tool) and the tool then failed, so it never appeared.
    // It resolves to nothing, so it is stored — and pruned — as written.
    await call(base, 'agent-alpha', 'POST', { add: ['doc-live', 'doc-ghost'] });
    const res = await call(base, 'agent-alpha', 'GET');
    expect((res.json.watches as Array<{ key: string }>).map((w) => w.key)).toEqual([liveId]);
    expect(res.json.pruned).toEqual(['doc-ghost']);
    // The read is what the store persisted, so it does not come back later.
    const again = await call(base, 'agent-alpha', 'GET');
    expect(again.json.pruned).toEqual([]);
    expect(handle?.agentWatches.list('agent-alpha', () => true).watches.map((w) => w.key)).toEqual([
      liveId,
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

/**
 * A merge re-keys the durable watch set — and the only assertion worth
 * having is DELIVERY under the new id. A re-keyed entry that never carries a
 * comment is the silent-loss shape this store exists to end, one layer down.
 */
describe('POST /api/agents/:id/merge re-keys watches so delivery follows the new id', () => {
  let handle: ServerHandle | null = null;
  let dataDir: string | null = null;

  afterEach(async () => {
    await handle?.stop();
    handle = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  it('a comment posted after the merge reaches the new id, and the old id holds nothing', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-merge-'));
    handle = createServer({ port: 0, dataDir });
    const base = `http://localhost:${handle.port}`;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { host: `localhost:${handle?.port ?? 0}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const get = async (path: string) => {
      const res = await fetch(`${base}${path}`, {
        headers: { host: `localhost:${handle?.port ?? 0}` },
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };

    // A board led by a THIRD agent, so the merged agent is addressed only
    // through its durable watch — not through the lead seat.
    const created = await post('/api/workspaces', {
      name: 'merge-hub',
      goal: 'Ship it.',
      leadAgentId: 'agent-lead',
    });
    const wsId = (created.json.workspace as { id: string }).id;
    const file = join(dataDir, 'watched.md');
    writeFileSync(file, '# Watched\n\nBody.\n');
    expect((await post('/api/docs', { docId: 'watched', sourceUrl: file })).status).toBe(200);
    expect((await post(`/api/workspaces/${wsId}/docs`, { docId: 'watched' })).status).toBe(200);

    // The old identity attaches (a bystander) and persists its board watch.
    expect(
      (
        await post(`/api/workspaces/${wsId}/attachments`, {
          agentId: 'agent-old',
          agentName: 'Old Name',
          runtime: 'claude-code-local',
        })
      ).status,
    ).toBe(200);
    expect((await post('/api/agents/agent-old/watches', { add: [`ws:${wsId}`] })).status).toBe(200);

    const comment = (text: string) =>
      post('/api/docs/watched/threads', {
        author: { id: 'known-jordan', name: 'Jordan', kind: 'person' },
        text,
        anchor: { kind: 'subject' },
      });
    const queuedFor = async (agentId: string): Promise<string[]> => {
      const r = await post(`/api/workspaces/${wsId}/attachments`, {
        agentId,
        runtime: 'claude-code-local',
      });
      expect(r.status).toBe(200);
      const rows = (r.json.queuedComments as Array<{ id: string; text: string }>) ?? [];
      // Receipt each row the way the MCP does, so a later attach is not
      // re-offered what this one already took.
      for (const q of rows) {
        expect((await post(`/api/workspaces/${wsId}/comment-queue/${q.id}/ack`, {})).status).toBe(
          200,
        );
      }
      return rows.map((q) => q.text);
    };

    // POSITIVE CONTROL: before the merge, the watch delivers to the old id.
    expect((await comment('first, to the old id')).status).toBe(200);
    expect(await queuedFor('agent-old')).toEqual(['first, to the old id']);

    const merged = await post('/api/agents/agent-old/merge', {
      into: 'agent-new',
      author: { id: 'agent-new', name: 'New Name', kind: 'agent' },
    });
    expect(merged.status, JSON.stringify(merged.json)).toBe(200);
    expect(merged.json.watches).toEqual([`ws:${wsId}`]);

    // The set is under the new id now, and only there.
    const restored = await get('/api/agents/agent-new/watches');
    expect((restored.json.watches as Array<{ key: string }>).map((w) => w.key)).toEqual([
      `ws:${wsId}`,
    ]);
    expect((await get('/api/agents/agent-old/watches')).json.watches).toEqual([]);

    // END TO END: a comment after the merge is queued for the NEW id.
    expect((await comment('second, to the new id')).status).toBe(200);
    expect(await queuedFor('agent-new')).toEqual(['second, to the new id']);
    // …and not for the old one: nothing is addressed to it any more, and
    // it cannot even attach — the id was merged away, and the refusal names
    // the survivor.
    const stale = await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: 'agent-old',
      runtime: 'claude-code-local',
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe('merged-away');
    expect(stale.json.into).toBe('agent-new');
    expect(handle.tasks.listQueuedComments(wsId).map((q) => q.agentId)).not.toContain('agent-old');

    // The roster folded the old id into the new one.
    expect(handle.identities.get('agent-old')?.id).toBe('agent-new');
    expect(handle.identities.get('agent-new')?.mergedFrom).toEqual(['agent-old']);
  });

  it('refuses to merge INTO the shared identity, and refuses a self-merge', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-merge-refuse-'));
    handle = createServer({ port: 0, dataDir });
    const base = `http://localhost:${handle.port}`;
    const merge = async (from: string, body: unknown) => {
      const res = await fetch(`${base}/api/agents/${from}/merge`, {
        method: 'POST',
        headers: { host: `localhost:${handle?.port ?? 0}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.status;
    };
    expect(await merge('agent-old', { into: 'known-agent' })).toBe(400);
    expect(await merge('agent-old', { into: 'agent-old' })).toBe(400);
    expect(await merge('agent-old', {})).toBe(400);
  });
});

/**
 * Security review of the merge verb (PR #440). Three findings, each with its
 * own test because each one was invisible to the test above:
 *  - an UN-ACKED backlog stayed keyed to the old id (the e2e test acked
 *    every row before merging, so it could not see this);
 *  - `from` could be an id a PERSON row already folds (`known-bryan`, or an
 *    anon id from the link file), so two rows claimed it;
 *  - any tailnet caller could move a lead seat — the route only refused
 *    share visitors, and a deploy-grade action deserves the deploy gate.
 */
describe('POST /api/agents/:id/merge — review findings', () => {
  let handle: ServerHandle | null = null;
  let dataDir: string | null = null;

  afterEach(async () => {
    await handle?.stop();
    handle = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  const req = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const port = handle?.port ?? 0;
    const res = await fetch(`http://localhost:${port}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { host: `localhost:${port}`, 'content-type': 'application/json' },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  /** A board led by a third agent, a watched doc, and `agent-old` attached
   *  with a durable board watch — the shape of the e2e test above. */
  async function seed(): Promise<string> {
    const created = await req('/api/workspaces', {
      body: { name: 'merge-hub', goal: 'Ship it.', leadAgentId: 'agent-lead' },
    });
    const wsId = (created.json.workspace as { id: string }).id;
    const file = join(dataDir as string, 'watched.md');
    writeFileSync(file, '# Watched\n\nBody.\n');
    expect((await req('/api/docs', { body: { docId: 'watched', sourceUrl: file } })).status).toBe(
      200,
    );
    expect((await req(`/api/workspaces/${wsId}/docs`, { body: { docId: 'watched' } })).status).toBe(
      200,
    );
    expect(
      (
        await req(`/api/workspaces/${wsId}/attachments`, {
          body: { agentId: 'agent-old', agentName: 'Old Name', runtime: 'claude-code-local' },
        })
      ).status,
    ).toBe(200);
    expect(
      (await req('/api/agents/agent-old/watches', { body: { add: [`ws:${wsId}`] } })).status,
    ).toBe(200);
    return wsId;
  }

  it('an un-acked backlog follows the merge to the new id', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-merge-backlog-'));
    handle = createServer({ port: 0, dataDir });
    const wsId = await seed();

    // A comment lands while nobody is attached to receive it: queued for
    // agent-old, and NOT acked — the case the e2e test cannot reach.
    expect(
      (
        await req('/api/docs/watched/threads', {
          body: {
            author: { id: 'known-jordan', name: 'Jordan', kind: 'person' },
            text: 'posted before the merge, never acked',
            anchor: { kind: 'subject' },
          },
        })
      ).status,
    ).toBe(200);
    // POSITIVE CONTROL: the row is on the books for the old id (the lead is
    // addressed too; that row is not under test).
    const addressees = () => handle?.tasks.listQueuedComments(wsId).map((q) => q.agentId) ?? [];
    expect(addressees()).toContain('agent-old');
    expect(addressees()).not.toContain('agent-new');

    const merged = await req('/api/agents/agent-old/merge', {
      body: { into: 'agent-new', author: { id: 'agent-new', name: 'New Name', kind: 'agent' } },
    });
    expect(merged.status, JSON.stringify(merged.json)).toBe(200);
    // The response says the backlog moved, per board — same shape as seats.
    expect(merged.json.comments).toEqual([wsId]);

    // The new id's first attach hands the row over…
    const attached = await req(`/api/workspaces/${wsId}/attachments`, {
      body: { agentId: 'agent-new', runtime: 'claude-code-local' },
    });
    expect(attached.status).toBe(200);
    expect(
      ((attached.json.queuedComments as Array<{ text: string }>) ?? []).map((q) => q.text),
    ).toEqual(['posted before the merge, never acked']);
    // …and the old id holds nothing: the row was moved, not copied.
    expect(addressees()).not.toContain('agent-old');
    expect(addressees().filter((id) => id === 'agent-new')).toHaveLength(1);
  });

  it('a dry run reports the backlog it WOULD move and moves nothing', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-merge-backlog-dry-'));
    handle = createServer({ port: 0, dataDir });
    const wsId = await seed();
    expect(
      (
        await req('/api/docs/watched/threads', {
          body: {
            author: { id: 'known-jordan', name: 'Jordan', kind: 'person' },
            text: 'still here after the dry run',
            anchor: { kind: 'subject' },
          },
        })
      ).status,
    ).toBe(200);
    const dry = await req('/api/agents/agent-old/merge', {
      body: { into: 'agent-new', dryRun: true },
    });
    expect(dry.status).toBe(200);
    expect(dry.json.comments).toEqual([wsId]);
    const addressees = handle.tasks.listQueuedComments(wsId).map((q) => q.agentId);
    expect(addressees).toContain('agent-old');
    expect(addressees).not.toContain('agent-new');
  });

  it('refuses a `from` that a person row already folds, including a link-file anon id', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-merge-person-'));
    // Boot seeding folds `known-bryan` into the owner's email identity.
    handle = createServer({ port: 0, dataDir, ownerEmail: 'owner@example.com' });
    const owner = handle.identities.byEmail('owner@example.com');
    expect(owner?.kind).toBe('person');
    // POSITIVE CONTROL: the id under test really does resolve to a person.
    expect(handle.identities.get('known-bryan')?.id).toBe(owner?.id);
    handle.identities.addMergedFrom(owner?.id ?? '', 'anon-x1');
    expect(handle.identities.get('anon-x1')?.kind).toBe('person');

    for (const from of ['known-bryan', 'anon-x1', owner?.id ?? '']) {
      const r = await req(`/api/agents/${encodeURIComponent(from)}/merge`, {
        body: { into: 'agent-evil', author: { id: 'agent-evil', name: 'Evil', kind: 'agent' } },
      });
      expect(r.status, `${from}: ${JSON.stringify(r.json)}`).toBe(400);
      expect(r.json.error).toBe('from-not-agent');
      // Nothing claimed the id: the owner still resolves to the owner.
      expect(handle.identities.get(from)?.id).toBe(owner?.id);
    }
    // The agent row the attempt would have created must not exist either.
    expect(handle.identities.get('agent-evil')?.mergedFrom ?? []).toEqual([]);
  });

  it('is loopback-only, like /api/deploy — a tailnet caller cannot move a seat', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'agent-merge-loopback-'));
    handle = createServer({ port: 0, dataDir });
    const wsId = await seed();
    const addrs = nonLoopbackIPv4();
    if (addrs.length === 0) {
      // Stated, not silently skipped: this machine cannot host the scenario.
      expect(addrs).toEqual([]);
      return;
    }
    const from = addrs[0] as string;
    const port = handle.port;
    const res = await fetch(`http://${from}:${port}/api/agents/agent-old/merge`, {
      method: 'POST',
      // The spoof attempt is the test: a Host-based gate would let this in.
      headers: { host: `localhost:${port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ into: 'agent-new' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain('loopback');
    // The refusal happened before the work: nothing moved.
    expect(handle.tasks.listAttachments(wsId).map((a) => a.agentId)).toEqual(['agent-old']);
    // POSITIVE CONTROL on the same address: an ordinary trusted-local read works.
    const ok = await fetch(`http://${from}:${port}/api/docs`, {
      headers: { host: `localhost:${port}` },
    });
    expect(ok.status).toBe(200);
    // …and the loopback caller still can.
    const local = await req('/api/agents/agent-old/merge', { body: { into: 'agent-new' } });
    expect(local.status).toBe(200);
  });
});

function nonLoopbackIPv4(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}
