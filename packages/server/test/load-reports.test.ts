import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

/**
 * The monitoring half of the slow-board-load ticket: Bryan measured a 10+
 * second board load on his iPad and nothing recorded where the time went. Each browser
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
    const mk = await fetch(`${base}/workspaces`, {
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
    const post = await fetch(`${base}/workspaces/${wsId}/load-reports`, {
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

    const got = await fetch(`${base}/workspaces/${wsId}/load-reports`);
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
    const post = await fetch(`${base}/workspaces/${wsId}/load-reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'RealPad/2.0' },
      body: JSON.stringify({ msToBoot: 9, ts: 0, ua: 'forged' }),
    });
    expect(post.status).toBe(200);
    const got = await fetch(`${base}/workspaces/${wsId}/load-reports`);
    const body = (await got.json()) as { reports: Array<{ ts: number; ua?: string }> };
    expect(body.reports[0]?.ua).toBe('RealPad/2.0');
    expect(body.reports[0]?.ts).toBeGreaterThanOrEqual(before);
  });

  it('refuses a report for a workspace that does not exist', async () => {
    const res = await fetch(`${base}/workspaces/w-nope/load-reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msToBoot: 1 }),
    });
    expect(res.status).toBe(404);
  });

  /**
   * The route is on the share-member table, so every one of these is a write
   * to a file on the OWNER's disk by anybody holding a link to the board. It
   * used to take whatever JSON parsed and append it, unexamined and
   * unbounded, which makes a telemetry endpoint a place to park data.
   */
  describe('what it will accept', () => {
    const post = (body: unknown, raw?: string) =>
      fetch(`${base}/workspaces/${wsId}/load-reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw ?? JSON.stringify(body),
      });

    it('refuses a report far larger than a boot timing', async () => {
      const res = await post({ msToBoot: 1, note: 'x'.repeat(50_000) });
      expect(res.status).toBe(400);
      // Control: the same field within the limit is a report like any other.
      expect((await post({ msToBoot: 1, note: 'x'.repeat(20) })).status).toBe(200);
    });

    it('refuses a nested structure — a report is flat numbers, not a document', async () => {
      expect((await post({ msToBoot: 1, resources: [1, 2, 3] })).status).toBe(400);
      expect((await post({ msToBoot: 1, detail: { phase: 'boot' } })).status).toBe(400);
    });

    it('refuses a body that is not an object at all', async () => {
      expect((await post(undefined, '[1,2,3]')).status).toBe(400);
      expect((await post(undefined, '"just a string"')).status).toBe(400);
      expect((await post(undefined, '17')).status).toBe(400);
    });

    it('refuses a report with far more fields than the client sends', async () => {
      const wide: Record<string, number> = {};
      for (let i = 0; i < 200; i++) wide[`f${i}`] = i;
      expect((await post(wide)).status).toBe(400);
    });

    it('keeps the log bounded, so a member cannot fill the owner’s disk', async () => {
      const logPath = join(dataDir, 'workspaces', `${wsId}.load-reports.jsonl`);
      // Each of these is a legal report at close to the per-row ceiling —
      // four fields at the per-string limit. The file must stop growing well
      // before their sum.
      const filler = 'y'.repeat(390);
      for (let i = 0; i < 400; i++) {
        const res = await post({ msToBoot: i, a: filler, b: filler, c: filler, d: filler });
        expect(res.status, `report ${i}`).toBe(200);
      }
      const bytes = statSync(logPath).size;
      // 400 rows of ~1.6 KB is ~640 KB unbounded. Asserted as a ceiling
      // rather than a value, because what matters is that it stopped, not
      // exactly where.
      expect(bytes).toBeLessThan(400_000);
      // …and the read still works and is still newest-first, so the bound
      // costs the feature nothing.
      const got = await fetch(`${base}/workspaces/${wsId}/load-reports`);
      const body = (await got.json()) as { reports: Array<{ msToBoot?: number }> };
      expect(body.reports[0]?.msToBoot).toBe(399);
    });
  });

  it('caps the read at the newest 50 so the file can grow without the read growing', async () => {
    for (let i = 0; i < 60; i++) {
      await fetch(`${base}/workspaces/${wsId}/load-reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msToBoot: i }),
      });
    }
    const got = await fetch(`${base}/workspaces/${wsId}/load-reports`);
    const body = (await got.json()) as { reports: Array<{ msToBoot?: number }> };
    expect(body.reports.length).toBe(50);
    expect(body.reports[0]?.msToBoot).toBe(59);
  });
});
