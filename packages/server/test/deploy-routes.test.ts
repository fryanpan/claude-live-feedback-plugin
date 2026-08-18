/**
 * The deploy request, driven through the REAL route.
 *
 * The unit tests prove the deployer. They cannot prove anyone can reach it,
 * and the route is this codebase's established place for a parameter to be
 * accepted, answered 200, and discarded — which for `force` would mean a
 * caller who overrode the busy-document refusal and was quietly refused
 * anyway.
 *
 * Every test injects a fake deployer. Nothing in the suite may reach a real
 * git checkout or a real `launchctl`: a test run that pulled and restarted
 * would be a deploy triggered by CI.
 *
 * Fixtures are synthetic.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DeployRequest, type DeployResult, Deployer } from '../src/deploy.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const DEPLOYED: DeployResult = {
  ok: true,
  status: 'deployed',
  before: 'aaaaaaa',
  after: 'bbbbbbb',
  changed: true,
  behind: 24,
  ahead: 0,
  restartRequested: true,
  message: 'deploy source aaaaaaa → bbbbbbb (24 commits); restarting the server',
  ranAt: 1_700_000_000_000,
};

describe('/api/deploy', () => {
  let handle: ServerHandle | null = null;
  let dataDir: string | null = null;

  const start = (deployer?: Deployer) => {
    dataDir = mkdtempSync(join(tmpdir(), 'deploy-route-'));
    handle = createServer({ port: 0, dataDir, ...(deployer ? { deployer } : {}) });
    return `http://localhost:${handle.port}`;
  };

  const fake = (seen: DeployRequest[], result: DeployResult = DEPLOYED) =>
    new Deployer({
      run: async (req) => {
        seen.push(req);
        return result;
      },
    });

  afterEach(async () => {
    await handle?.stop();
    handle = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  const call = (base: string, method: string, port: number, body?: unknown) =>
    fetch(`${base}/api/deploy`, {
      method,
      headers: { host: `localhost:${port}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('runs the deploy and reports the ref either side of it', async () => {
    const seen: DeployRequest[] = [];
    const base = start(fake(seen));
    const res = await call(base, 'POST', handle?.port ?? 0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deploy: DeployResult };
    expect(seen).toHaveLength(1);
    expect(body.deploy.status).toBe('deployed');
    expect(body.deploy.before).toBe('aaaaaaa');
    expect(body.deploy.after).toBe('bbbbbbb');
    expect(body.deploy.restartRequested).toBe(true);
  });

  it('forwards force and requestedBy instead of dropping them', async () => {
    // The route is the layer nothing type-checks. `force` silently discarded
    // would refuse a caller who explicitly accepted the risk, with a message
    // saying they should pass the flag they just passed.
    const seen: DeployRequest[] = [];
    const base = start(fake(seen));
    await call(base, 'POST', handle?.port ?? 0, { force: true, requestedBy: 'Test Agent' });
    expect(seen[0]).toEqual({ force: true, requestedBy: 'Test Agent' });
  });

  it('defaults force to false, and only `true` turns it on', async () => {
    const seen: DeployRequest[] = [];
    const base = start(fake(seen));
    await call(base, 'POST', handle?.port ?? 0);
    await call(base, 'POST', handle?.port ?? 0, { force: 'yes' });
    expect(seen.map((r) => r.force)).toEqual([false, false]);
  });

  it('GET reports the last result without deploying anything', async () => {
    // The board reads this. A read that pulled and restarted would turn
    // every page load into a deploy.
    const seen: DeployRequest[] = [];
    const base = start(fake(seen));
    const before = (await (await call(base, 'GET', handle?.port ?? 0)).json()) as {
      deploy: DeployResult | null;
    };
    expect(before.deploy).toBeNull();
    expect(seen).toHaveLength(0);

    await call(base, 'POST', handle?.port ?? 0);
    const after = (await (await call(base, 'GET', handle?.port ?? 0)).json()) as {
      deploy: DeployResult | null;
    };
    expect(after.deploy?.after).toBe('bbbbbbb');
    expect(seen).toHaveLength(1);
  });

  it('says so plainly when this server is not the deploy', async () => {
    // Dev, staging, and every test spin a server with no deployer. A 404
    // would read as "the route does not exist"; the honest answer is that it
    // exists and this deployment must not perform it.
    const base = start();
    const res = await call(base, 'POST', handle?.port ?? 0);
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toContain('not enabled');
  });

  it('a refusal is a 200 carrying the refusal, not a 500', async () => {
    // The caller asked "can you deploy". Answering with a stack-shaped error
    // loses which refusal it was and what to do about it.
    const seen: DeployRequest[] = [];
    const base = start(
      fake(seen, {
        ...DEPLOYED,
        ok: false,
        status: 'refuse-busy',
        changed: false,
        restartRequested: false,
        busyDocs: [{ docId: 'd1', path: '/repo/docs/live-plan.md' }],
        message: '1 bound document in the deploy source has un-flushed edits',
      }),
    );
    const res = await call(base, 'POST', handle?.port ?? 0);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deploy: DeployResult };
    expect(body.deploy.ok).toBe(false);
    expect(body.deploy.status).toBe('refuse-busy');
    expect(body.deploy.busyDocs?.[0]?.path).toContain('live-plan.md');
  });

  it('refuses a method it does not serve', async () => {
    const seen: DeployRequest[] = [];
    const base = start(fake(seen));
    const res = await call(base, 'DELETE', handle?.port ?? 0);
    expect(res.status).toBe(405);
    expect(seen).toHaveLength(0);
  });
});
