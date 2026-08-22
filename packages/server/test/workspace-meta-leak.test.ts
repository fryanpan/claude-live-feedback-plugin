/**
 * A workspace share visitor must not learn where the review lives.
 *
 * `/api/docs/<id>` has been redacted since the share-visitor hardening work,
 * but the two WORKSPACE endpoints in a visitor's scope built their payload
 * themselves rather than returning a DocMeta, so nothing redacted them:
 *
 *   GET /api/workspaces/<id>/tree   → `root` (absolute host path) + every
 *   GET /api/workspaces/<id>/files     node's `reviewUrl` on the tailnet host
 *
 * Found by probing the RUNNING server with a real workspace link over the
 * public hostname, not by reading the code — the unit layer was fine and the
 * doc route was fine; only these two siblings leaked.
 *
 * Every assertion here is an absence, so each one is paired with a control:
 * the owner's copy must still CONTAIN the field, otherwise "the visitor
 * doesn't see root" would pass on an endpoint that returns nothing at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';

const PUBLIC_HOST = 'feedback.example.com';
const TAILNET = 'mac-mini.tail-test.ts.net';

describe('workspace share does not leak host details', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;
  let boardId: string;
  let workspaceId: string;
  let cookie: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const visitor = (path: string) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      headers: {
        host: PUBLIC_HOST,
        'x-forwarded-proto': 'https',
        cookie: `${SHARE_COOKIE}=${cookie}`,
      },
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'wsleak-data-'));
    folder = mkdtempSync(join(tmpdir(), 'wsleak-secretname-'));
    mkdirSync(join(folder, 'sub'), { recursive: true });
    writeFileSync(join(folder, 'README.md'), '# Entry\n\nbody\n');
    writeFileSync(join(folder, 'sub', 'two.md'), '# Two\n\nmore\n');

    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
      // Make the tailnet name appear in reviewUrl the way it does in prod.
      trustedHosts: [TAILNET],
    });
    base = `http://localhost:${handle.port}`;

    // A board is the unit of sharing; the bind is filed on one. What this
    // test measures — which meta fields a share visitor may see — is reached
    // through the grouping either way.
    const board = await local('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Meta board' }),
    }).then((r) => r.json());
    boardId = board.workspace.id as string;
    expect(boardId).toBeTruthy();

    workspaceId = (
      await local('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify({ folderPath: folder, hubWorkspaceId: boardId }),
      }).then((r) => r.json())
    ).workspaceId;
    expect(workspaceId).toBeTruthy();

    const share = await local('/api/share/link', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: boardId }),
    }).then((r) => r.json());
    const redeemed = await fetch(`${base}/s/${share.share.slug}`, {
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

  /** Every absolute http(s) host appearing anywhere in a JSON payload. */
  const hostsIn = (raw: string): string[] => [
    ...new Set([...raw.matchAll(/https?:\/\/([^/"]+)/g)].map((m) => m[1] as string)),
  ];

  for (const ep of ['tree', 'files'] as const) {
    it(`CONTROL: the owner's /${ep} DOES carry root and an absolute reviewUrl`, async () => {
      const raw = await local(`/api/workspaces/${workspaceId}/${ep}`).then((r) => r.text());
      // Without this, the visitor assertions below could pass on an empty body.
      expect(raw).toContain('"root"');
      expect(raw).toContain(folder);
      expect(hostsIn(raw).length).toBeGreaterThan(0);
    });

    it(`visitor's /${ep} omits root and the absolute path`, async () => {
      const res = await visitor(`/api/workspaces/${workspaceId}/${ep}`);
      expect(res.status).toBe(200);
      const raw = await res.text();
      expect(raw).not.toContain('"root"');
      expect(raw).not.toContain(folder);
      // Still useful: the paths WITHIN the review are the thing being reviewed.
      expect(raw).toContain('README.md');
    });

    it(`visitor's /${ep} exposes no hostname at all`, async () => {
      const raw = await visitor(`/api/workspaces/${workspaceId}/${ep}`).then((r) => r.text());
      expect(hostsIn(raw)).toEqual([]);
      expect(raw).not.toContain(TAILNET);
      expect(raw).not.toContain('.ts.net');
    });

    it(`visitor's /${ep} keeps reviewUrl usable as a relative path`, async () => {
      const raw = await visitor(`/api/workspaces/${workspaceId}/${ep}`).then((r) => r.text());
      const urls = [...raw.matchAll(/"reviewUrl":"([^"]+)"/g)].map((m) => m[1] as string);
      expect(urls.length).toBeGreaterThan(0); // control: there ARE reviewUrls
      // Relative, AND under the workspace this visitor was actually shared.
      // The second half is the one with teeth: the server mints under the
      // first workspace holding the doc, which can be a different board — and
      // that URL would both name a workspace nobody shared and 403 at the
      // guard, which checks the workspace segment against the share.
      // NOTE the id: the SHARED board, not the review whose tree this is.
      // A visitor's share is scoped to a board, so that is the segment their
      // links must carry.
      for (const u of urls) {
        expect(u.startsWith(`/workspaces/${boardId}/`), u).toBe(true);
      }
    });
  }

  it('nested children are redacted too, not just the top level', async () => {
    // Folder binds are LAZY: only the entry doc is bound up front, so the
    // tree has one node until a member is opened. Open the nested file first
    // — which also exercises the lazy-bind path a real visitor uses.
    const opened = await fetch(`${base}/api/workspaces/${workspaceId}/context-file`, {
      method: 'POST',
      headers: {
        host: PUBLIC_HOST,
        'x-forwarded-proto': 'https',
        cookie: `${SHARE_COOKIE}=${cookie}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ relPath: 'sub/two.md' }),
    });
    expect(opened.status).toBe(200);

    const raw = await visitor(`/api/workspaces/${workspaceId}/tree`).then((r) => r.text());
    // sub/two.md now lives one level down — a shallow redactor would miss it.
    expect(raw).toContain('two.md');
    expect(hostsIn(raw)).toEqual([]);
    expect(raw).not.toContain(folder);
  });
});
