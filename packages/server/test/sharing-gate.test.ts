/**
 * The sharing master switch, driven through the real route table.
 *
 * The unit assertions cover persistence and the env lock; the HTTP ones are
 * the ones that matter, because the gate has to sit AHEAD of authentication —
 * a valid session cookie must not get further than an absent one — and
 * because the route layer is the part nothing type-checks.
 *
 * Every "is refused" assertion is an absence, so each block first proves the
 * same request SUCCEEDS while sharing is on.
 *
 * The visitor fixture is a WORKSPACE link over a one-file folder bind — a
 * workspace is the unit of sharing (2026-08-17), so `{docId}` no longer
 * mints anything. Nothing about the master switch changes with it: the gate
 * sits ahead of both the share lookup and authentication.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SharingGate } from '../src/share/sharing-gate.ts';
import { type AccessHarness, accessHarness, mintAccessShare } from './access-share.ts';

/** The board this file's docs, tasks and reviews are filed under. */

describe('SharingGate (unit)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'gate-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults to enabled when never configured', () => {
    expect(new SharingGate({ dataDir: dir }).isEnabled()).toBe(true);
  });

  it('persists across instances', () => {
    expect(new SharingGate({ dataDir: dir }).setEnabled(false)).toEqual({
      ok: true,
      enabled: false,
    });
    expect(new SharingGate({ dataDir: dir }).isEnabled()).toBe(false);
    new SharingGate({ dataDir: dir }).setEnabled(true);
    expect(new SharingGate({ dataDir: dir }).isEnabled()).toBe(true);
  });

  it('fails CLOSED on a corrupt state file', () => {
    const bad = mkdtempSync(join(tmpdir(), 'gate-bad-'));
    writeFileSync(join(bad, 'sharing.json'), '{ not json');
    const gate = new SharingGate({ dataDir: bad });
    expect(gate.isEnabled()).toBe(false);
    expect(gate.status().loadError).toBeTruthy();
    rmSync(bad, { recursive: true, force: true });
  });

  it('fails closed when "enabled" is not a boolean', () => {
    const bad = mkdtempSync(join(tmpdir(), 'gate-bad2-'));
    writeFileSync(join(bad, 'sharing.json'), '{"enabled":"yes"}');
    expect(new SharingGate({ dataDir: bad }).isEnabled()).toBe(false);
    rmSync(bad, { recursive: true, force: true });
  });

  it('env lock forces off and refuses to be reopened', () => {
    const locked = mkdtempSync(join(tmpdir(), 'gate-lock-'));
    // Even with an explicit enabled:true on disk, the env wins.
    writeFileSync(join(locked, 'sharing.json'), '{"enabled":true}');
    const gate = new SharingGate({ dataDir: locked, envLocked: true });
    expect(gate.isEnabled()).toBe(false);
    expect(gate.isLocked()).toBe(true);
    expect(gate.setEnabled(true)).toEqual({ ok: false, error: 'env_locked' });
    expect(gate.isEnabled()).toBe(false); // the refused call changed nothing
    rmSync(locked, { recursive: true, force: true });
  });
});

describe('sharing gate over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;
  let visitorHeaders: Record<string, string>;
  let access: AccessHarness;
  let boardId: string;
  /** Member docId of the bound folder — `<group>:<relPath>`, so it carries a
   *  colon and every URL below uses the encoded form. */
  let docId: string;
  let docSeg: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  /** A visitor request. `withToken: false` keeps the share's hostname and
   *  drops the Access token — the "proves nothing" caller. */
  const pub = (path: string, withToken = true) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      headers: withToken
        ? { ...visitorHeaders, 'x-forwarded-proto': 'https' }
        : { host: visitorHeaders.host as string, 'x-forwarded-proto': 'https' },
    });

  const setSharing = (enabled: boolean) =>
    local('/api/share/enabled', { method: 'POST', body: JSON.stringify({ enabled }) });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'gate-http-data-'));
    folder = mkdtempSync(join(tmpdir(), 'gate-http-src-'));
    const docPath = join(folder, 'note.md');
    writeFileSync(docPath, '# Note\n\nbody\n');

    access = await accessHarness();
    handle = createServer({
      port: 0,
      dataDir,
      ...access.serverOptions,
    });
    base = `http://localhost:${handle.port}`;

    // A board is the unit of sharing, so the bind is filed on one and the
    // share below covers that board. The bind's own id is a GROUPING and can
    // no longer be shared on its own.
    const board = await local('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Gate board' }),
    }).then((r) => r.json());
    boardId = board.workspace.id as string;
    expect(boardId).toBeTruthy();

    const bind = await local('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ folderPath: folder, hubWorkspaceId: boardId }),
    });
    expect(bind.status).toBe(200);
    const bound = (await bind.json()) as {
      workspaceId: string;
      files: Array<{ docId: string }>;
    };
    docId = bound.files[0]?.docId ?? '';
    docSeg = encodeURIComponent(docId);
    expect(docId).not.toBe('');

    visitorHeaders = (await mintAccessShare(base, access, boardId)).headers;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it('CONTROL: a visitor reaches the doc while sharing is on', async () => {
    const r = await pub(`/workspaces/${boardId}/docs/${docSeg}?format=json`);
    expect(r.status).toBe(200);
    expect((await r.json()).meta.docId).toBe(docId);
  });

  it('CONTROL: a fresh share mints while sharing is on', async () => {
    const r = await local('/api/share/link', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: boardId, allowDomains: ['@partner.example'] }),
    });
    expect(r.status).toBe(200);
  });

  it('refuses a valid session once sharing is off', async () => {
    expect((await setSharing(false)).status).toBe(200);
    const r = await pub(`/workspaces/${boardId}/docs/${docSeg}?format=json`);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('sharing_disabled');
  });

  it('lets the box mint, and refuses the visitor that share would have let in', async () => {
    // Minting is a LOCAL call and stays reachable — the switch is about the
    // outside door, and the operator has to be able to prepare a share for
    // the moment they reopen it. What the switch owes is that the fresh
    // share buys nothing while it is off, which is the second half here.
    const minted = await mintAccessShare(base, access, boardId);
    const r = await fetch(`${base}/workspaces/${boardId}/docs/${docSeg}?format=json`, {
      redirect: 'manual',
      headers: { ...minted.headers, 'x-forwarded-proto': 'https' },
    });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe('sharing_disabled');
  });

  it('refuses the websocket upgrade once sharing is off', async () => {
    const r = await fetch(`${base}/workspaces/${boardId}/docs/${docSeg}/y`, {
      headers: {
        ...visitorHeaders,
        'x-forwarded-proto': 'https',
        origin: `https://${visitorHeaders.host}`,
      },
    });
    expect(r.status).toBe(403);
  });

  it('refuses the SSE stream once sharing is off', async () => {
    const r = await pub(`/workspaces/${boardId}/docs/${docSeg}/events:stream`);
    expect(r.status).toBe(403);
  });

  it('gates BEFORE auth — no token looks the same as a good one', async () => {
    const withOut = await pub(`/workspaces/${boardId}/docs/${docSeg}?format=json`, false);
    expect(withOut.status).toBe(403);
    expect((await withOut.json()).error).toBe('sharing_disabled');
  });

  it('leaves the LOCAL surface working while sharing is off', async () => {
    const r = await local(`/workspaces/${boardId}/docs/${docSeg}?format=json`);
    expect(r.status).toBe(200);
    const list = await local(`/workspaces/${boardId}/docs`);
    expect(list.status).toBe(200);
  });

  it('reports its state on GET /api/share', async () => {
    const s = await local('/api/share').then((r) => r.json());
    expect(s.sharing).toEqual({ enabled: false, locked: false });
  });

  it('restores access when switched back on', async () => {
    expect((await setSharing(true)).status).toBe(200);
    const r = await pub(`/workspaces/${boardId}/docs/${docSeg}?format=json`);
    expect(r.status).toBe(200);
  });
});
