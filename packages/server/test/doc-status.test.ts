/**
 * GET /api/docs/:docId/status — the cheap health check for a bound doc.
 *
 * The gap it closes, measured on a real board: `get_doc` returned 320KB for
 * one doc, which overflows tool-result caps — so an agent that only needed
 * "is this doc bound, is it wedged, how big is it" had NO call that answered
 * without paying for the whole body. Status is metadata the room and binding
 * already hold: no plainText, no blocks, no thread bodies.
 *
 * HTTP-level on purpose (the route layer hand-copies fields and is the layer
 * no unit test covers), same pattern as find-replace-bulk.test.ts. The share
 * half rides the real share flow because visitor redaction lives in the
 * route, not in rooms. All fixtures are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';

const PUBLIC_HOST = 'feedback.example.com';

interface DocStatus {
  docId: string;
  type: string;
  title?: string;
  bound: boolean;
  path?: string;
  syncError?: { message: string; at: number };
  lastActivityAt?: number;
  textLength: number;
  blockCount: number;
  threads: { open: number; resolved: number };
  pendingSuggestions: number;
}

describe('GET /api/docs/:docId/status', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boundPath: string;
  let cookie: string;

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
  const pub = (path: string) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST, cookie: `${SHARE_COOKIE}=${cookie}` },
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-doc-status-'));
    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;

    // A doc big enough that "status is small" is a real claim, not a claim
    // that would also hold for the full content payload.
    const bigSection = `Filler paragraph about synthetic rockets. ${'x'.repeat(400)}\n\n`;
    boundPath = join(dataDir, 'status-doc.md');
    writeFileSync(boundPath, `# Status Fixture\n\n${bigSection.repeat(80)}`);
    expect(
      (
        await post('/api/docs', {
          docId: 'status-doc',
          type: 'markdown',
          sourceUrl: boundPath,
          title: 'Status Fixture',
        })
      ).status,
    ).toBe(200);

    // One open + one resolved thread, so the counts are non-vacuous.
    const mkThread = async () => {
      const res = await post('/api/docs/status-doc/threads/by_find', {
        author: { id: 'a1', name: 'Agent One', kind: 'known', color: '#123456' },
        text: 'a comment',
        find: 'Status Fixture',
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { thread: { id: string } }).thread.id;
    };
    await mkThread();
    const resolvedId = await mkThread();
    expect((await post(`/api/docs/status-doc/threads/${resolvedId}/resolve`, {})).status).toBe(200);

    // Share the workspace the doc landed on so a visitor can reach it.
    const ws = await post('/api/workspaces', { name: 'status-board', goal: 'Check status.' });
    const boardId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    expect((await post(`/api/workspaces/${boardId}/docs`, { docId: 'status-doc' })).status).toBe(
      200,
    );
    const mint = await post('/api/share/link', { workspaceId: boardId, label: 'status share' });
    expect(mint.status).toBe(200);
    const slug = ((await mint.json()) as { share: { slug: string } }).share.slug;
    const redeemed = await fetch(`${base}/s/${slug}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST },
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
  });

  it('answers the metadata shape without any content payload, and stays small', async () => {
    const res = await local('/api/docs/status-doc/status');
    expect(res.status).toBe(200);
    const text = await res.text();
    const status = JSON.parse(text) as DocStatus;

    expect(status.docId).toBe('status-doc');
    expect(status.type).toBe('markdown');
    expect(status.title).toBe('Status Fixture');
    expect(status.bound).toBe(true);
    expect(status.path).toBe(boundPath);
    expect(typeof status.lastActivityAt).toBe('number');
    expect(status.textLength).toBeGreaterThan(10_000);
    expect(status.blockCount).toBeGreaterThan(50);
    expect(status.threads).toEqual({ open: 1, resolved: 1 });
    expect(status.pendingSuggestions).toBe(0);
    // A healthy binding reports no syncError — the field is passthrough, so
    // absence here plus presence in the type is the whole contract.
    expect(status.syncError).toBeUndefined();

    // The point of the route: no body. Not the keys, and not the content —
    // the fixture text must not ride along under any other name.
    expect(text).not.toContain('plainText');
    expect(text).not.toContain('"blocks"');
    expect(text).not.toContain('synthetic rockets');
    expect(text.length).toBeLessThan(1_000);
  });

  it('counts pending suggestions', async () => {
    const res = await post('/api/docs/status-doc/find_and_replace', {
      find: 'Status Fixture',
      replace: 'Status Fixture (proposed)',
      suggest: true,
      author: { id: 'a1', name: 'Agent One', kind: 'known', color: '#123456' },
    });
    expect(res.status).toBe(200);
    const status = (await (await local('/api/docs/status-doc/status')).json()) as DocStatus;
    expect(status.pendingSuggestions).toBe(1);
  });

  it('404s on an unknown docId', async () => {
    expect((await local('/api/docs/no-such-doc/status')).status).toBe(404);
  });

  it('omits the bound path (and any path-shaped detail) for a share visitor', async () => {
    const res = await pub('/api/docs/status-doc/status');
    expect(res.status).toBe(200); // the visitor really can read status
    const text = await res.text();
    const status = JSON.parse(text) as DocStatus;
    expect(status.bound).toBe(true); // …and really got the payload
    expect(status.threads).toEqual({ open: 1, resolved: 1 });
    expect(status.path).toBeUndefined();
    // Belt and braces: the path must not appear ANYWHERE in what they got.
    expect(text).not.toContain(dataDir);
  });
});
