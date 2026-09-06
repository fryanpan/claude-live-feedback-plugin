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
 * hand-copies body fields into the doc-store call and nothing type-checks it,
 * which is exactly how `groups` was accepted and discarded.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { seedBoard } from './workspace-seed.ts';

/**
 * `hubWorkspaceId` — the BOARD the doc belongs to — and deliberately not
 * `meta.workspaceId`, which is the doc-GROUPING tag folder binds and diff
 * reviews use. Same word, two things; the response keeps them apart.
 */
interface DocResponse {
  docId: string;
  hubWorkspaceId?: string;
  meta: { docId?: string; workspaceId?: string; type?: string };
}

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

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

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-workspace-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);
  });

  afterAll(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('honours the workspace the caller names', async () => {
    // Positive control for every "it got a workspace" assertion below: when a
    // workspace IS supplied, that specific one is what comes back — so a
    // non-empty workspaceId in the other tests means something.
    const ws = await post('/workspaces', { name: 'named-ws', goal: 'Ship.' });
    const wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    WS = wsId;
    // The body an MCP `attach_markdown` call puts on the wire, so this also
    // covers the layer that hand-copies fields into the doc-store call.
    const r = await post(`/workspaces/${wsId}/docs`, {
      docId: 'doc-named-ws',
      type: 'markdown',
      sourceUrl: mdFile('named.md'),
      owner: '/tmp/some-agent-cwd',
      hubWorkspaceId: wsId,
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as DocResponse).hubWorkspaceId).toBe(wsId);
  });

  it('honours a caller-named workspace for a mockup bind too', async () => {
    // bind_mock's wire shape. The param is accepted on one route by one
    // handler, but two MCP tools reach it and only one of them was written
    // with a workspace in mind.
    const ws = await post('/workspaces', { name: 'mock-ws', goal: 'Ship.' });
    const wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    WS = wsId;
    const r = await post(`/workspaces/${wsId}/docs`, {
      docId: 'doc-named-mock-ws',
      type: 'mockup',
      owner: '/tmp/some-agent-cwd',
      hubWorkspaceId: wsId,
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as DocResponse).hubWorkspaceId).toBe(wsId);
  });

  it('materializes one when the caller has none — still a single call', async () => {
    const r = await post(`/workspaces/${WS}/docs`, {
      docId: 'doc-no-ws',
      type: 'markdown',
      sourceUrl: mdFile('orphan.md'),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as DocResponse;
    // The whole point: no error, no second call, and the doc is in a workspace.
    expect(body.hubWorkspaceId).toBeTruthy();

    // And it's a REAL workspace — one the board can open, not just a string
    // stamped on the doc. This is the assertion that would catch "we set the
    // field and never created anything".
    const ws = await local(`/workspaces/${body.hubWorkspaceId}?format=json`);
    expect(ws.status).toBe(200);

    // Attached, not merely reported: the doc has to be reachable FROM the
    // workspace as well, or the id in the response is a label on nothing.
    // The board holds the MINTED id — the address — not the name the caller
    // asked for, so that two spellings never produce two memberships.
    const wsBody = (await ws.json()) as { workspace: { docIds: string[] } };
    expect(wsBody.workspace.docIds).toContain(body.docId);

    // ...and the readable name the caller chose still gets there.
    const viaAlias = await local(`/workspaces/${WS}/docs/doc-no-ws?format=json`);
    expect(viaAlias.status).toBe(200);
    expect(((await viaAlias.json()) as DocResponse).meta.docId).toBe(body.docId);
  });

  it('puts the auto-created workspace in the list the board renders', async () => {
    const r = await post(`/workspaces/${WS}/docs`, {
      docId: 'doc-listed-ws',
      type: 'markdown',
      sourceUrl: mdFile('listed.md'),
    });
    const wsId = ((await r.json()) as DocResponse).hubWorkspaceId;
    // Without this line the test passes vacuously today: `toContain` on an
    // undefined needle against a list that happens not to hold one.
    expect(wsId).toBeTruthy();
    const list = await local('/workspaces');
    const ids = ((await list.json()) as { boardWorkspaces: { id: string }[] }).boardWorkspaces.map(
      (w) => w.id,
    );
    // A workspace the server materialized was never named to anyone, so a
    // list is the only way it can be found at all.
    expect(ids).toContain(wsId as string);
  });

  it('reuses one auto-created workspace instead of minting one per doc', async () => {
    // A workspace per doc is the same as no workspace: the board fills with
    // single-doc boards and the grouping stops meaning anything.
    const a = await post(`/workspaces/${WS}/docs`, {
      docId: 'doc-auto-a',
      type: 'markdown',
      sourceUrl: mdFile('auto-a.md'),
    });
    const b = await post(`/workspaces/${WS}/docs`, {
      docId: 'doc-auto-b',
      type: 'markdown',
      sourceUrl: mdFile('auto-b.md'),
    });
    const wsA = ((await a.json()) as DocResponse).hubWorkspaceId;
    const wsB = ((await b.json()) as DocResponse).hubWorkspaceId;
    expect(wsA).toBeTruthy();
    expect(wsB).toBe(wsA as string);
  });

  it('leaves a mockup doc in a workspace too, not just markdown', async () => {
    const r = await post(`/workspaces/${WS}/docs`, { docId: 'doc-mockup-ws', type: 'mockup' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as DocResponse).hubWorkspaceId).toBeTruthy();
  });

  it('files a created doc on the board in its PATH, and attaching adds a second address', async () => {
    // The holding pen is not on this route any more: the path names the board,
    // so `POST /workspaces/<ws>/docs` files there and there is nothing to be
    // swept out of. (The pen still catches a folder bind, which is top-level
    // and names no board — group-bind-workspace.test.ts covers the move.)
    //
    // What replaces the old one-home invariant: a doc filed on two boards has
    // TWO addresses, deliberately, and both answer. That is the shape share
    // scoping reads now — a set, not a single winner — so the failure this
    // test was written against (a visitor 403'd because `workspaceOfDoc`
    // happened to answer with the other board) cannot recur through it.
    const created = await post(`/workspaces/${WS}/docs`, {
      docId: 'doc-then-attached',
      type: 'markdown',
      sourceUrl: mdFile('then-attached.md'),
    });
    const createdBody = (await created.json()) as DocResponse;
    const docId = createdBody.docId;
    expect(createdBody.hubWorkspaceId).toBe(WS);
    expect(handle.tasks.getWorkspace(WS)?.docIds).toContain(docId);

    const ws = await post('/workspaces', { name: 'real-home', goal: 'Ship.' });
    const realId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    // Positive control that `realId` is a DIFFERENT board, so "both answer"
    // below is a claim about two of them.
    expect(realId).not.toBe(WS);
    // Attached by the READABLE name — the attach route resolves it, and the
    // membership it writes is still keyed by the minted id below.
    expect(
      (await post(`/workspaces/${realId}/docs:attach`, { docId: 'doc-then-attached' })).status,
    ).toBe(200);

    expect(handle.tasks.getWorkspace(realId)?.docIds).toContain(docId);
    expect(handle.tasks.getWorkspace(WS)?.docIds).toContain(docId);
    for (const board of [WS, realId]) {
      const r = await local(`/workspaces/${board}/docs/${docId}?format=json`);
      expect(r.status, board).toBe(200);
    }
  });

  it('a deleted doc leaves no link behind on the board', async () => {
    // Filing every doc means a board would otherwise collect one tombstone per
    // deleted doc — invisible in the UI (a dangling id renders as nothing) and
    // permanent in the store.
    const created = await post(`/workspaces/${WS}/docs`, {
      docId: 'doc-to-delete',
      type: 'markdown',
      sourceUrl: mdFile('to-delete.md'),
    });
    const createdBody = (await created.json()) as DocResponse;
    const docId = createdBody.docId;
    const wsId = createdBody.hubWorkspaceId as string;
    // Positive control: it is linked right now, so "not linked" below is a
    // claim about the delete rather than about a link that never existed.
    expect(handle.tasks.getWorkspace(wsId)?.docIds).toContain(docId);

    // Deleted by the readable name — which must unlink the minted id it
    // resolves to, not a second membership under the alias.
    const del = await local(`/workspaces/${wsId}/docs/doc-to-delete?format=json`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    expect(handle.tasks.getWorkspace(wsId)?.docIds).not.toContain(docId);
  });

  it('files the doc the WIDGET conjures, not just the ones a route creates', async () => {
    // A mockup doc auto-creates on the `/y/<id>` websocket connect — the
    // widget is a third creation path next to POST /api/docs and the MCP
    // tools, and it is the one no REST test would ever reach.
    //
    // On its OWN server with the sign-in write gate off, because creating a
    // doc over this socket is now a write and a signed-out browser is
    // refused it (`ws-create-signin.test.ts` is what pins that). This test
    // is about where a conjured doc gets FILED, so it boots the state in
    // which one gets conjured at all.
    const wsDataDir = mkdtempSync(join(tmpdir(), 'doc-workspace-widget-'));
    const open = createServer({ port: 0, dataDir: wsDataDir, requireSignInToWrite: false });
    try {
      const docId = 'doc-widget-ws';
      const ws = new WebSocket(
        `ws://localhost:${open.port}/workspaces/${WS}/docs/${docId}/y?type=mockup`,
        // The socket is refused without an allowed browser Origin.
        { headers: { origin: `http://localhost:${open.port}` } } as unknown as string[],
      );
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve());
        ws.addEventListener('error', () => reject(new Error('ws failed to open')));
      });
      ws.close();

      // Positive control: the socket really did create the doc, so a claim
      // about its workspace is a claim about something that exists.
      expect(open.docStore.get(docId)).toBeTruthy();
      expect(open.tasks.workspaceOfDoc(docId)).toBeTruthy();
    } finally {
      await open.stop();
      rmSync(wsDataDir, { recursive: true, force: true });
    }
  });
});

describe('a doc that predates the rule has no address', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'doc-legacy-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);
    // The gate lives in the route, so going straight at DocStore produces the
    // shape a doc persisted before this rule has: meta with no workspaceId.
    const p = join(dataDir, 'legacy.md');
    writeFileSync(p, '# Legacy\n\nStill here.\n');
    handle.docStore.getOrCreate('legacy-doc', { type: 'markdown', sourceUrl: p });
  });

  afterAll(() => {
    handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('404s under every board, because it belongs to none', async () => {
    // It used to be served at `/review/<id>`, which named no board — and that
    // is exactly why "unfiled" was a state nobody ever met. That address is
    // deleted with the rest of the pre-cutover paths, so a doc filed nowhere
    // now has nowhere to be reached from, and the 404 is the prompt to file
    // it. Reaching it from every board instead would put the retired
    // compatibility back under another name.
    //
    // Positive control that the fixture is the shape we mean: it really has no
    // workspace, so the 404 is a claim about an orphan.
    expect(handle.tasks.workspaceOfDoc('legacy-doc')).toBeNull();
    expect(handle.docStore.get('legacy-doc')?.meta.workspaceId ?? '').toBe('');
    const r = await fetch(`${base}/workspaces/${WS}/docs/legacy-doc?format=json`, {
      headers: { host: `localhost:${handle.port}` },
    });
    expect(r.status).toBe(404);

    // …and it is the ORPHAN being refused, not the board or the route: a doc
    // filed on this same board answers on the same spelling.
    const filedPath = join(dataDir, 'filed.md');
    writeFileSync(filedPath, '# Filed\n\nOn a board.\n');
    const made = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: `localhost:${handle.port}` },
      body: JSON.stringify({ docId: 'filed-doc', type: 'markdown', sourceUrl: filedPath }),
    });
    expect(made.status).toBe(200);
    const filedId = ((await made.json()) as { docId: string }).docId;
    const control = await fetch(`${base}/workspaces/${WS}/docs/${filedId}?format=json`, {
      headers: { host: `localhost:${handle.port}` },
    });
    expect(control.status).toBe(200);
  });
});
