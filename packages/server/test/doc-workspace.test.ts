/**
 * Every doc belongs to a workspace (Bryan, 2026-08-13).
 *
 * The constraint that makes this non-trivial is the second half of the
 * decision: requiring a workspace must not add a step. "Bind a doc, send
 * Bryan the URL" in one call is the product, so a caller with no workspace in
 * hand gets one materialized for them rather than an error telling them to go
 * make one first.
 *
 * These go through the real HTTP routes on purpose — the route layer
 * hand-copies body fields into the rooms call and nothing type-checks it,
 * which is exactly how `groups` was accepted and discarded.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

interface DocResponse {
  docId: string;
  meta: { workspaceId?: string; type?: string };
}

describe('a doc always lands in a workspace', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const mdFile = (name: string): string => {
    const p = join(dataDir, name);
    writeFileSync(p, `# ${name}\n\nBody.\n`);
    return p;
  };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-workspace-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('honours the workspace the caller names', async () => {
    // Positive control for every "it got a workspace" assertion below: when a
    // workspace IS supplied, that specific one is what comes back — so a
    // non-empty workspaceId in the other tests means something.
    const ws = await post('/api/workspaces', { name: 'named-ws', goal: 'Ship.' });
    const wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    const r = await post('/api/docs', {
      docId: 'doc-named-ws',
      type: 'markdown',
      sourceUrl: mdFile('named.md'),
      workspaceId: wsId,
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as DocResponse).meta.workspaceId).toBe(wsId);
  });

  it('materializes one when the caller has none — still a single call', async () => {
    const r = await post('/api/docs', {
      docId: 'doc-no-ws',
      type: 'markdown',
      sourceUrl: mdFile('orphan.md'),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as DocResponse;
    // The whole point: no error, no second call, and the doc is in a workspace.
    expect(body.meta.workspaceId).toBeTruthy();

    // And it's a REAL workspace — one the hub can open, not just a string
    // stamped on the doc. This is the assertion that would catch "we set the
    // field and never created anything".
    const ws = await local(`/api/workspaces/${body.meta.workspaceId}`);
    expect(ws.status).toBe(200);
  });

  it('puts the auto-created workspace in the list the hub renders', async () => {
    const r = await post('/api/docs', {
      docId: 'doc-listed-ws',
      type: 'markdown',
      sourceUrl: mdFile('listed.md'),
    });
    const wsId = ((await r.json()) as DocResponse).meta.workspaceId;
    // Without this line the test passes vacuously today: `toContain` on an
    // undefined needle against a list that happens not to hold one.
    expect(wsId).toBeTruthy();
    const list = await local('/api/workspaces');
    const ids = ((await list.json()) as { workspaces: { id: string }[] }).workspaces.map(
      (w) => w.id,
    );
    expect(ids).toContain(wsId);
  });

  it('reuses one auto-created workspace instead of minting one per doc', async () => {
    // A workspace per doc is the same as no workspace: the hub fills with
    // single-doc boards and the grouping stops meaning anything.
    const a = await post('/api/docs', {
      docId: 'doc-auto-a',
      type: 'markdown',
      sourceUrl: mdFile('auto-a.md'),
    });
    const b = await post('/api/docs', {
      docId: 'doc-auto-b',
      type: 'markdown',
      sourceUrl: mdFile('auto-b.md'),
    });
    const wsA = ((await a.json()) as DocResponse).meta.workspaceId;
    const wsB = ((await b.json()) as DocResponse).meta.workspaceId;
    expect(wsA).toBeTruthy();
    expect(wsB).toBe(wsA as string);
  });

  it('leaves a mockup doc in a workspace too, not just markdown', async () => {
    const r = await post('/api/docs', { docId: 'doc-mockup-ws', type: 'mockup' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as DocResponse).meta.workspaceId).toBeTruthy();
  });
});

describe('docs that predate the rule stay reachable', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-legacy-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    // The gate lives in the route, so going straight at Rooms produces the
    // shape a doc persisted before this rule has: meta with no workspaceId.
    // That is the state we promise not to strand, and after this change it is
    // unreachable through any HTTP path — which is the point.
    const p = join(dataDir, 'legacy.md');
    writeFileSync(p, '# Legacy\n\nStill here.\n');
    handle.rooms.getOrCreate('legacy-doc', { type: 'markdown', sourceUrl: p });
  });

  afterAll(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('still serves a doc that has no workspace at all', async () => {
    // Positive control that the fixture is the shape we mean: it really has
    // no workspace, so "still reachable" is a claim about an orphan.
    expect(handle.rooms.get('legacy-doc')?.meta.workspaceId ?? '').toBe('');
    const r = await fetch(`${base}/api/docs/legacy-doc`, {
      headers: { host: `localhost:${handle.port}` },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { meta: { type?: string } };
    expect(body.meta.type).toBe('markdown');
  });
});
