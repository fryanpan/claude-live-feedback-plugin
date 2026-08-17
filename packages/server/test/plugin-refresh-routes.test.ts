/**
 * The refresh request, driven through the REAL route.
 *
 * The unit tests prove the refresher. They cannot prove a peer can reach it,
 * and the route is this codebase's established place for a param or a
 * capability to be silently dropped — accepted, 200, discarded.
 *
 * Every test here injects a fake refresher. Nothing in the suite may spawn
 * `claude plugin update`: a test run that mutates this machine's plugin cache
 * would be a deploy triggered by CI.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRefresher, type RefreshResult } from '../src/plugin-refresh.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const RESULT: RefreshResult = {
  ok: true,
  before: '0.1.26',
  after: '0.1.27',
  changed: true,
  message: 'plugin cache 0.1.26 → 0.1.27 — sessions pick it up when they restart',
  ranAt: 1_700_000_000_000,
};

describe('POST /api/plugin/refresh', () => {
  let handle: ServerHandle | null = null;
  let dataDir: string | null = null;

  const start = (pluginRefresher?: PluginRefresher) => {
    dataDir = mkdtempSync(join(tmpdir(), 'plugin-refresh-'));
    handle = createServer({
      port: 0,
      dataDir,
      ...(pluginRefresher ? { pluginRefresher } : {}),
    });
    return `http://localhost:${handle.port}`;
  };

  const fake = (runs: { n: number }, result: RefreshResult = RESULT) =>
    new PluginRefresher({
      run: async () => {
        runs.n++;
        return result;
      },
      minIntervalMs: 0,
    });

  afterEach(async () => {
    await handle?.stop();
    handle = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  const call = (base: string, method: string, port: number) =>
    fetch(`${base}/api/plugin/refresh`, {
      method,
      headers: { host: `localhost:${port}`, 'content-type': 'application/json' },
    });

  it('runs the refresh and returns what actually moved', async () => {
    const runs = { n: 0 };
    const base = start(fake(runs));
    const res = await call(base, 'POST', handle?.port ?? 0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refresh: RefreshResult };
    expect(runs.n).toBe(1);
    expect(body.refresh.changed).toBe(true);
    expect(body.refresh.before).toBe('0.1.26');
    expect(body.refresh.after).toBe('0.1.27');
  });

  it('GET reports the last result without running anything', async () => {
    // The board reads this. A read that triggers a fetch would turn every
    // page load into a deploy.
    const runs = { n: 0 };
    const base = start(fake(runs));
    const before = (await (await call(base, 'GET', handle?.port ?? 0)).json()) as {
      refresh: RefreshResult | null;
    };
    expect(before.refresh).toBeNull();
    expect(runs.n).toBe(0);

    await call(base, 'POST', handle?.port ?? 0);
    const after = (await (await call(base, 'GET', handle?.port ?? 0)).json()) as {
      refresh: RefreshResult | null;
    };
    expect(after.refresh?.after).toBe('0.1.27');
    expect(runs.n).toBe(1);
  });

  it('says so plainly when this server cannot run an update', async () => {
    // Dev, staging, and every test spin a server with no refresher. A 404
    // here would read as "the tool does not exist"; the honest answer is
    // that it exists and this deployment cannot perform it.
    const base = start();
    const res = await call(base, 'POST', handle?.port ?? 0);
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toContain('not enabled');
  });

  it('a failed refresh is a 200 carrying the failure, not a 500', async () => {
    // The caller asked "did this work"; answering with a stack-shaped error
    // loses the before/after that says how far it got.
    const runs = { n: 0 };
    const base = start(
      fake(runs, {
        ok: false,
        before: '0.1.26',
        after: '0.1.26',
        changed: false,
        message: 'plugin update exited 1: marketplace not found',
        ranAt: 1,
      }),
    );
    const res = await call(base, 'POST', handle?.port ?? 0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refresh: RefreshResult };
    expect(body.refresh.ok).toBe(false);
    expect(body.refresh.message).toContain('marketplace not found');
  });
});
