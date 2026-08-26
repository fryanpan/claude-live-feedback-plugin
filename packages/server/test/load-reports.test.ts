import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * The monitoring half of t-scWMQmOZcpu1: Bryan measured a 10+ second board
 * load on his iPad and nothing recorded where the time went. Each browser
 * boot posts one timing report; the server keeps them per workspace and
 * hands back the recent ones, so "how slow was it, and in which phase" is a
 * read instead of a guess. No external service — the decision on Sentry is
 * its own review item.
 */
describe('board load reports', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsId: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'load-reports-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const mk = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'timed board' }),
    });
    wsId = ((await mk.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('accepts a report and hands it back newest-first with a server stamp', async () => {
    const post = await fetch(`${base}/api/workspaces/${wsId}/load-reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'TestPad/1.0' },
      body: JSON.stringify({
        msToBoot: 4200,
        msToFirstProjection: 6100,
        transferBytes: 2300000,
        resourceCount: 14,
      }),
    });
    expect(post.status, await post.clone().text()).toBe(200);

    const got = await fetch(`${base}/api/workspaces/${wsId}/load-reports`);
    expect(got.status).toBe(200);
    const body = (await got.json()) as {
      reports: Array<{ ts: number; ua?: string; msToBoot?: number }>;
    };
    expect(body.reports.length).toBe(1);
    expect(body.reports[0]?.msToBoot).toBe(4200);
    expect(body.reports[0]?.ua).toBe('TestPad/1.0');
    expect(typeof body.reports[0]?.ts).toBe('number');
  });

  it('the server stamp wins over a forged ts/ua in the body', async () => {
    // The row spreads the body FIRST so the server's ts and ua land last —
    // a client claiming { ts: 0, ua: 'fake' } must not be able to rewrite
    // when the report arrived or what sent it (codex review on PR 384).
    const before = Date.now();
    const post = await fetch(`${base}/api/workspaces/${wsId}/load-reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'RealPad/2.0' },
      body: JSON.stringify({ msToBoot: 9, ts: 0, ua: 'forged' }),
    });
    expect(post.status).toBe(200);
    const got = await fetch(`${base}/api/workspaces/${wsId}/load-reports`);
    const body = (await got.json()) as { reports: Array<{ ts: number; ua?: string }> };
    expect(body.reports[0]?.ua).toBe('RealPad/2.0');
    expect(body.reports[0]?.ts).toBeGreaterThanOrEqual(before);
  });

  it('refuses a report for a workspace that does not exist', async () => {
    const res = await fetch(`${base}/api/workspaces/w-nope/load-reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msToBoot: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it('caps the read at the newest 50 so the file can grow without the read growing', async () => {
    for (let i = 0; i < 60; i++) {
      await fetch(`${base}/api/workspaces/${wsId}/load-reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msToBoot: i }),
      });
    }
    const got = await fetch(`${base}/api/workspaces/${wsId}/load-reports`);
    const body = (await got.json()) as { reports: Array<{ msToBoot?: number }> };
    expect(body.reports.length).toBe(50);
    expect(body.reports[0]?.msToBoot).toBe(59);
  });
});
