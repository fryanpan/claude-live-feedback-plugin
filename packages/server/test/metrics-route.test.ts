/**
 * `GET /api/metrics` — what this process currently costs, on demand.
 *
 * The 2026-08-29 jetsam kill left nothing to read: the server had reached
 * 2.6 GB and the only evidence of how it got there was the absence of the
 * process. The same numbers go to the log every five minutes; this route is
 * what lets the NEXT incident be sampled over time rather than reconstructed
 * afterwards.
 *
 * The two things worth pinning are that the counts track a seeded fixture
 * (a route that always answered zero would look healthy through any storm)
 * and that it stays counts-only — no doc ids, paths or titles, which is what
 * makes it safe to serve.
 *
 * Synthetic fixture, port 0. No production server is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

interface Metrics {
  rssMb: number;
  rooms: number;
  bindings: number;
  activeBindings: number;
  awareness: number;
  timers: number;
  uptimeSec: number;
  activations: { tag: string; count: number }[];
  activationsTotal: number;
}

describe('GET /api/metrics', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let srcDir: string;
  let base: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'metrics-route-'));
    srcDir = mkdtempSync(join(tmpdir(), 'metrics-route-src-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  async function metrics(): Promise<Metrics> {
    const res = await local('/api/metrics');
    expect(res.status).toBe(200);
    return (await res.json()) as Metrics;
  }

  it('counts the rooms and bindings a seeded fixture actually creates', async () => {
    const before = await metrics();

    for (let i = 0; i < 5; i++) {
      const path = join(srcDir, `m-${i}.md`);
      writeFileSync(path, `# Doc ${i}\n\nbody\n`);
      const res = await local('/api/docs', {
        method: 'POST',
        body: JSON.stringify({ docId: `metrics-${i}`, type: 'markdown', sourceUrl: path }),
      });
      expect(res.status).toBe(200);
    }

    const after = await metrics();
    // The positive control: the numbers MOVE. A route hard-wired to zero, or
    // reading a Rooms that is not the serving one, would pass every shape
    // assertion below and fail this one.
    // Five docs plus the hub workspace room they get filed under, so the
    // room count moves by more than five — but the BINDING count is exact:
    // a hub-owned room is never file-bound.
    expect(after.rooms).toBeGreaterThanOrEqual(before.rooms + 5);
    expect(after.bindings).toBe(before.bindings + 5);
    // Creating a doc reaches for it, so those five are in the fast lane; the
    // count is bounded by the bindings that exist either way.
    expect(after.activeBindings).toBeLessThanOrEqual(after.bindings);
    // Nobody has opened a websocket, so no room has built an Awareness.
    expect(after.awareness).toBe(0);
    // Timers do NOT scale with the corpus — the point of the change. Right
    // after five creates the count is briefly higher: each doc has a 200ms
    // debounced `.ydoc` write pending, and those are counted honestly. What
    // must be true is that they DRAIN, leaving a constant that does not grow
    // with the number of docs.
    expect(after.timers).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1200));
    const settled = await metrics();
    expect(settled.timers).toBeLessThanOrEqual(before.timers + 1);
    expect(settled.rooms).toBe(after.rooms);
  });

  it('reports plausible memory and uptime', async () => {
    const m = await metrics();
    expect(m.rssMb).toBeGreaterThan(0);
    expect(m.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it('is counts only — no doc ids, paths or titles', async () => {
    const path = join(srcDir, 'secret-name.md');
    writeFileSync(path, '# Confidential heading\n\nbody\n');
    await local('/api/docs', {
      method: 'POST',
      body: JSON.stringify({ docId: 'metrics-leak-probe', type: 'markdown', sourceUrl: path }),
    });

    const res = await local('/api/metrics');
    const body = await res.text();
    // Control first: the doc really is on this server, so a body that leaked
    // would have something to leak.
    const docs = await (await local('/api/docs')).text();
    expect(docs).toContain('metrics-leak-probe');

    expect(body).not.toContain('metrics-leak-probe');
    expect(body).not.toContain('secret-name');
    expect(body).not.toContain(srcDir);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (key === 'activations') continue;
      expect(typeof value).toBe('number');
    }
    // `activations` is the one non-scalar field: source locations and counts.
    // A tag is a repo-relative path into `packages/` and nothing else — never
    // an absolute host path, and never anything derived from a doc.
    const activations = parsed.activations as { tag: string; count: number }[];
    expect(Array.isArray(activations)).toBe(true);
    for (const row of activations) {
      expect(typeof row.count).toBe('number');
      expect(row.tag).toMatch(/^(packages\/[\w./-]+:\d+|external|unknown|other)$/);
      expect(row.tag.startsWith('/')).toBe(false);
    }
  });

  it('names the caller that put a binding in the fast lane', async () => {
    const path = join(srcDir, 'attributed.md');
    writeFileSync(path, '# Doc\n\nbody\n');
    await local('/api/docs', {
      method: 'POST',
      body: JSON.stringify({ docId: 'metrics-attributed', type: 'markdown', sourceUrl: path }),
    });
    handle.rooms.resetDerivedCaches();

    const before = await metrics();
    // Reading a doc over HTTP is a genuine access, and the route that serves
    // it lives in server.ts — so that is the file the tag must name.
    expect((await local('/api/docs/metrics-attributed')).status).toBe(200);
    const after = await metrics();

    // Positive control: the read really did activate something. Without it,
    // an attribution map that never records anything would pass every shape
    // assertion below.
    expect(after.activeBindings).toBeGreaterThan(before.activeBindings);
    expect(after.activationsTotal).toBeGreaterThan(before.activationsTotal);
    const top = after.activations[0];
    expect(top).toBeDefined();
    expect(top?.tag).toContain('packages/server/src/server.ts:');
    expect(top?.count).toBeGreaterThan(0);
  });
});
