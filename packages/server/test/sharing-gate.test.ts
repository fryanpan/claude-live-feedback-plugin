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
import { SHARE_COOKIE } from '../src/share/link-session.ts';
import { SharingGate } from '../src/share/sharing-gate.ts';

const PUBLIC_HOST = 'feedback.example.com';

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
  let cookie: string;
  let slug: string;
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

  const pub = (path: string, withCookie = true) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      headers: {
        host: PUBLIC_HOST,
        'x-forwarded-proto': 'https',
        ...(withCookie ? { cookie: `${SHARE_COOKIE}=${cookie}` } : {}),
      },
    });

  const setSharing = (enabled: boolean) =>
    local('/api/share/enabled', { method: 'POST', body: JSON.stringify({ enabled }) });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'gate-http-data-'));
    folder = mkdtempSync(join(tmpdir(), 'gate-http-src-'));
    const docPath = join(folder, 'note.md');
    writeFileSync(docPath, '# Note\n\nbody\n');

    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;

    const bind = await local('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ folderPath: folder }),
    });
    expect(bind.status).toBe(200);
    const bound = (await bind.json()) as {
      workspaceId: string;
      files: Array<{ docId: string }>;
    };
    docId = bound.files[0]?.docId ?? '';
    docSeg = encodeURIComponent(docId);
    expect(docId).not.toBe('');

    const share = await local('/api/share/link', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: bound.workspaceId }),
    }).then((r) => r.json());
    slug = share.share.slug;
    expect(slug).toBeTruthy();

    const redeemed = await fetch(`${base}/s/${slug}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST, 'x-forwarded-proto': 'https' },
    });
    expect(redeemed.status).toBe(302);
    cookie = (redeemed.headers.get('set-cookie') ?? '').match(
      new RegExp(`${SHARE_COOKIE}=([^;]+)`),
    )?.[1] as string;
    expect(cookie).toBeTruthy();
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it('CONTROL: a visitor reaches the doc while sharing is on', async () => {
    const r = await pub(`/api/docs/${docSeg}`);
    expect(r.status).toBe(200);
    expect((await r.json()).meta.docId).toBe(docId);
  });

  it('CONTROL: a fresh slug redeems while sharing is on', async () => {
    const r = await fetch(`${base}/s/${slug}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST, 'x-forwarded-proto': 'https' },
    });
    expect(r.status).toBe(302);
  });

  it('refuses a valid session once sharing is off', async () => {
    expect((await setSharing(false)).status).toBe(200);
    const r = await pub(`/api/docs/${docSeg}`);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('sharing_disabled');
  });

  it('refuses slug redemption once sharing is off', async () => {
    const r = await fetch(`${base}/s/${slug}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST, 'x-forwarded-proto': 'https' },
    });
    expect(r.status).toBe(403);
  });

  it('refuses the websocket upgrade once sharing is off', async () => {
    const r = await fetch(`${base}/y/${docSeg}`, {
      headers: {
        host: PUBLIC_HOST,
        'x-forwarded-proto': 'https',
        cookie: `${SHARE_COOKIE}=${cookie}`,
        origin: `https://${PUBLIC_HOST}`,
      },
    });
    expect(r.status).toBe(403);
  });

  it('refuses the SSE stream once sharing is off', async () => {
    const r = await pub(`/events/${docSeg}`);
    expect(r.status).toBe(403);
  });

  it('gates BEFORE auth — no cookie looks the same as a good one', async () => {
    const withOut = await pub(`/api/docs/${docSeg}`, false);
    expect(withOut.status).toBe(403);
    expect((await withOut.json()).error).toBe('sharing_disabled');
  });

  it('leaves the LOCAL surface working while sharing is off', async () => {
    const r = await local(`/api/docs/${docSeg}`);
    expect(r.status).toBe(200);
    const list = await local('/api/docs');
    expect(list.status).toBe(200);
  });

  it('reports its state on GET /api/share', async () => {
    const s = await local('/api/share').then((r) => r.json());
    expect(s.sharing).toEqual({ enabled: false, locked: false });
  });

  it('restores access when switched back on', async () => {
    expect((await setSharing(true)).status).toBe(200);
    const r = await pub(`/api/docs/${docSeg}`);
    expect(r.status).toBe(200);
  });
});
