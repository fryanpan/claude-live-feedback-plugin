/**
 * The operator routes are for agents, not pages.
 *
 * `POST /api/deploy` restarts this process out of its deploy source and
 * `POST /api/plugin/refresh` spawns a plugin update. Nothing in the browser
 * apps calls either; every real caller is an MCP tool, a hook, or a curl from
 * the box.
 *
 * Neither route could tell a page from an agent before this. The deploy
 * route's loopback test reads the PEER ADDRESS, and a page served from this
 * machine has a loopback one; the cross-origin write gate admits any
 * machine-local hostname on ANY port; a local dev origin is same-site with
 * this server, so a session cookie rides along; and `cf-ray` is absent on a
 * request that never went through the edge. That is the same
 * page-on-this-machine class `browser_cannot_bind` was written to close, and
 * these two routes did not carry it.
 *
 * Every refusal below is paired with the agent request that must still
 * succeed — the same body, the same route, without the headers a page cannot
 * suppress.
 *
 * Every test injects a fake deployer / refresher. Nothing here may reach a
 * real git checkout, a real `launchctl`, or this machine's plugin cache.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DeployRequest, type DeployResult, Deployer } from '../src/deploy.ts';
import { PluginRefresher, type RefreshResult } from '../src/plugin-refresh.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const DEPLOYED: DeployResult = {
  ok: true,
  status: 'deployed',
  before: 'aaaaaaa',
  after: 'bbbbbbb',
  changed: true,
  behind: 2,
  ahead: 0,
  restartRequested: true,
  message: 'deploy source aaaaaaa → bbbbbbb (2 commits); restarting the server',
  ranAt: 1_700_000_000_000,
};

const REFRESHED: RefreshResult = {
  ok: true,
  before: '0.1.26',
  after: '0.1.27',
  changed: true,
  message: 'plugin cache 0.1.26 → 0.1.27 — sessions pick it up when they restart',
  ranAt: 1_700_000_000_000,
};

describe('operator routes refuse browser callers', () => {
  let handle: ServerHandle | null = null;
  let dataDir: string | null = null;
  const deploys: DeployRequest[] = [];
  const refreshes = { n: 0 };

  const start = (): string => {
    dataDir = mkdtempSync(join(tmpdir(), 'operator-browser-'));
    handle = createServer({
      port: 0,
      dataDir,
      // The sign-in gate is ON by default and would refuse these browser
      // POSTs first, with a 401 — which is exactly the state the attack does
      // NOT have: the hole this file pins is a page running while the
      // operator IS signed in, and a session cookie is same-site with a
      // local origin. Off here, so what refuses is the operator gate alone.
      requireSignInToWrite: false,
      deployer: new Deployer({
        run: async (req) => {
          deploys.push(req);
          return DEPLOYED;
        },
      }),
      pluginRefresher: new PluginRefresher({
        run: async () => {
          refreshes.n++;
          return REFRESHED;
        },
        minIntervalMs: 0,
      }),
    });
    return `http://localhost:${handle.port}`;
  };

  afterEach(async () => {
    await handle?.stop();
    handle = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
    deploys.length = 0;
    refreshes.n = 0;
  });

  /** What a page on another local port sends: the origin policy admits it. */
  const devServerPage = (): Record<string, string> => ({
    origin: 'http://localhost:5173',
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'cors',
  });
  /** The app's own origin — same-origin, the widest trust the policy has. */
  const samePage = (base: string): Record<string, string> => ({
    origin: base,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
  });

  const post = (base: string, path: string, extra: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        host: `localhost:${handle?.port ?? 0}`,
        'content-type': 'application/json',
        ...extra,
      },
      body: JSON.stringify({}),
    });

  const expectRefused = async (r: Response) => {
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toBe('browser_cannot_operate');
  };

  describe('POST /api/deploy', () => {
    it('positive control: an agent over loopback deploys', async () => {
      const base = start();
      expect((await post(base, '/api/deploy')).status).toBe(200);
      expect(deploys).toHaveLength(1);
    });

    it('a page on another local port cannot deploy', async () => {
      const base = start();
      await expectRefused(await post(base, '/api/deploy', devServerPage()));
      expect(deploys).toHaveLength(0);
    });

    it('nor can a same-origin page — the board never deploys from the browser', async () => {
      const base = start();
      await expectRefused(await post(base, '/api/deploy', samePage(base)));
      expect(deploys).toHaveLength(0);
    });
  });

  describe('POST /api/plugin/refresh', () => {
    it('positive control: an agent refreshes the plugin cache', async () => {
      const base = start();
      expect((await post(base, '/api/plugin/refresh')).status).toBe(200);
      expect(refreshes.n).toBe(1);
    });

    it('a page on another local port cannot refresh', async () => {
      const base = start();
      await expectRefused(await post(base, '/api/plugin/refresh', devServerPage()));
      expect(refreshes.n).toBe(0);
    });

    it('nor can a same-origin page', async () => {
      const base = start();
      await expectRefused(await post(base, '/api/plugin/refresh', samePage(base)));
      expect(refreshes.n).toBe(0);
    });
  });
});
