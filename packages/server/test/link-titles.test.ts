/**
 * POST /api/links/titles — resolve pasted workspace URLs to display titles.
 *
 * Render-time title lookup for the client's comment renderer: the stored
 * comment keeps the raw URL, the reader sees the resource's current title.
 * All fixtures are synthetic — the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

describe('POST /api/links/titles', () => {
  let dataDir: string;
  let handle: ServerHandle;
  let base: string;
  let wsId = '';
  let otherWsId = '';
  let taskId = '';
  let docId = '';

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

  const titlesFor = async (urls: string[]): Promise<Record<string, string | null>> => {
    const r = await post('/api/links/titles', { urls });
    expect(r.status).toBe(200);
    return ((await r.json()) as { titles: Record<string, string | null> }).titles;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'link-titles-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;

    const ws = await post('/api/workspaces', { name: 'Link Titles Board', goal: 'Ship.' });
    wsId = ((await ws.json()) as { workspace: { id: string } }).workspace.id;
    const other = await post('/api/workspaces', { name: 'Unrelated Board', goal: 'Else.' });
    otherWsId = ((await other.json()) as { workspace: { id: string } }).workspace.id;

    const t = await post(`/api/workspaces/${wsId}/tasks`, {
      title: 'Ship the widget',
      goal: 'chores',
      assignee: 'human',
    });
    taskId = ((await t.json()) as { task: { id: string } }).task.id;

    const mdPath = join(dataDir, 'design.md');
    writeFileSync(mdPath, '# Design\n\nBody.\n');
    const doc = await post('/api/docs', {
      docId: 'lt-design',
      type: 'markdown',
      sourceUrl: mdPath,
      title: 'Redline Design',
    });
    docId = ((await doc.json()) as { docId: string }).docId;
    // File the doc on the board, so the board-scoped address is truthful —
    // the route refuses to resolve a doc through a board it isn't on.
    const attach = await post(`/api/workspaces/${wsId}/docs`, { docId });
    expect(attach.status).toBe(200);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('resolves a doc URL (both address shapes) to the doc title', async () => {
    const modern = `${base}/workspaces/${wsId}/docs/${encodeURIComponent(docId)}`;
    const legacy = `${base}/review/${encodeURIComponent(docId)}`;
    const titles = await titlesFor([modern, legacy]);
    expect(titles[modern]).toBe('Redline Design');
    expect(titles[legacy]).toBe('Redline Design');
  });

  it('resolves a workspace URL to the workspace name', async () => {
    const url = `${base}/workspaces/${wsId}`;
    const titles = await titlesFor([url]);
    expect(titles[url]).toBe('Link Titles Board');
  });

  it('resolves a task deep link to the task title', async () => {
    const url = `${base}/workspaces/${wsId}?task=${taskId}`;
    const titles = await titlesFor([url]);
    expect(titles[url]).toBe('Ship the widget');
  });

  it('answers null for unresolvable ids and non-workspace URLs — never an error', async () => {
    const ghostDoc = `${base}/review/no-such-doc-xyz`;
    const ghostWs = `${base}/workspaces/w-nope`;
    const external = 'https://github.com/owner/repo/pull/1';
    const titles = await titlesFor([ghostDoc, ghostWs, external]);
    expect(titles[ghostDoc]).toBeNull();
    expect(titles[ghostWs]).toBeNull();
    expect(titles[external]).toBeNull();
  });

  it('refuses to resolve a resource through a workspace it does not belong to', async () => {
    // A valid id under the WRONG board must not leak its title — the URL is
    // lying about where the resource lives. Positive controls for both ids
    // are the resolving tests above.
    const docWrongWs = `${base}/workspaces/${otherWsId}/docs/${encodeURIComponent(docId)}`;
    const taskWrongWs = `${base}/workspaces/${otherWsId}?task=${taskId}`;
    const titles = await titlesFor([docWrongWs, taskWrongWs]);
    expect(titles[docWrongWs]).toBeNull();
    expect(titles[taskWrongWs]).toBeNull();
  });

  it('refuses a malformed body', async () => {
    expect((await post('/api/links/titles', {})).status).toBe(400);
    expect((await post('/api/links/titles', { urls: 'nope' })).status).toBe(400);
  });

  it('caps the batch instead of resolving unbounded input', async () => {
    const urls = Array.from({ length: 250 }, (_, i) => `${base}/review/bulk-${i}`);
    const r = await post('/api/links/titles', { urls });
    expect(r.status).toBe(200);
    const { titles } = (await r.json()) as { titles: Record<string, string | null> };
    expect(Object.keys(titles).length).toBeLessThanOrEqual(100);
  });
});
