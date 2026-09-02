/**
 * A deploy or a plugin refresh can never be triggered through the edge.
 *
 * `POST /api/deploy` is loopback-only by peer address. That test was written
 * for LAN and tailnet callers, and it holds for them — but cloudflared runs
 * ON this box, so a request that came through the Cloudflare tunnel arrives
 * from 127.0.0.1 and passes it. An operator on the proxied hostname, holding
 * a valid Access token, could therefore restart prod from anywhere; and the
 * refresh route had no address test at all. (Urgent-fixes ticket,
 * 2026-09-02.) Both POSTs now refuse a proxied request outright — the same
 * `cf-ray` test the host guard uses, because Cloudflare stamps it on
 * everything it proxies and strips any the client sent.
 *
 * The fixture is the proxied-trusted-host one (proxied-trusted-host.test.ts):
 * an Access-fronted operator hostname, because that is the ONE path a
 * proxied request has to these routes — on any other Host a proxied request
 * is refused by the host guard long before the route, and a test there would
 * pass against a build with no route check at all. Every refusal is paired
 * with a GET on the same path through the same hop (the route is reached) and
 * a loopback POST without the hop (the route still works).
 *
 * Fake deployer and refresher throughout: nothing here may pull a checkout,
 * restart a process, or touch a plugin cache.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type DeployRequest, type DeployResult, Deployer } from '../src/deploy.ts';
import { PluginRefresher, type RefreshResult } from '../src/plugin-refresh.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'deploy-proxied-kid';
const OPERATOR_AUD = 'aud-for-the-operator-app';
const PROXIED_HOST = 'operator.example.com';
const OPERATOR_EMAIL = 'operator@example.com';
/** Cloudflare stamps this on everything it proxies; its presence IS the hop. */
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

const DEPLOYED: DeployResult = {
  ok: true,
  status: 'deployed',
  before: 'aaaaaaa',
  after: 'bbbbbbb',
  changed: true,
  behind: 1,
  ahead: 0,
  restartRequested: true,
  message: 'fixture deploy',
  ranAt: 1_700_000_000_000,
};
const REFRESHED: RefreshResult = {
  ok: true,
  before: '0.1.26',
  after: '0.1.27',
  changed: true,
  message: 'fixture refresh',
  ranAt: 1_700_000_000_000,
};

let h: ServerHandle;
let dataDir: string;
let jwt: string;
const deploys: DeployRequest[] = [];
const refreshes = { n: 0 };

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const jwks: JSONWebKeySet = { keys: [publicJwk] };
  jwt = await new SignJWT({ email: OPERATOR_EMAIL })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(`https://${TEAM_DOMAIN}`)
    .setAudience(OPERATOR_AUD)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
    .setSubject('cf-access-operator-1')
    .sign(privateKey);

  dataDir = mkdtempSync(join(tmpdir(), 'deploy-proxied-'));
  h = createServer({
    port: 0,
    dataDir,
    cfAccess: { teamDomain: TEAM_DOMAIN, audience: OPERATOR_AUD, jwks },
    // With `shares` wired, Access gates only known share hostnames and
    // loopback stays open — prod's shape. Without it the legacy branch
    // gates EVERY request, and the from-the-box control below would be
    // refused for a reason this file is not about.
    share: { config: { publicHostname: 'links.example.com' } },
    proxiedTrustedHosts: [PROXIED_HOST],
    proxiedTrustedEmails: [OPERATOR_EMAIL],
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
});

afterAll(async () => {
  await h.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

/** The operator, through the edge, with a valid Access token. */
const viaEdge = (path: string, method: string) =>
  fetch(`http://localhost:${h.port}${path}`, {
    method,
    headers: {
      host: PROXIED_HOST,
      ...CF_RAY,
      'cf-access-jwt-assertion': jwt,
      'content-type': 'application/json',
    },
  });

/** The same call from the box itself — no hop. */
const fromBox = (path: string, method: string) =>
  fetch(`http://localhost:${h.port}${path}`, {
    method,
    headers: { host: `localhost:${h.port}`, 'content-type': 'application/json' },
  });

describe('POST /api/deploy through the edge', () => {
  it('positive control: the operator REACHES the route through the edge (GET)', async () => {
    const r = await viaEdge('/api/deploy', 'GET');
    expect(r.status).toBe(200);
    expect(((await r.json()) as { deploy: unknown }).deploy).toBeNull();
  });

  it('refuses the POST, naming the hop, and runs nothing', async () => {
    const before = deploys.length;
    const r = await viaEdge('/api/deploy', 'POST');
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/proxied|edge|tunnel/i);
    expect(deploys.length).toBe(before);
  });

  it('positive control: the same POST from the box still deploys', async () => {
    const before = deploys.length;
    const r = await fromBox('/api/deploy', 'POST');
    expect(r.status).toBe(200);
    expect(deploys.length).toBe(before + 1);
  });
});

describe('POST /api/plugin/refresh through the edge', () => {
  it('positive control: the operator REACHES the route through the edge (GET)', async () => {
    const r = await viaEdge('/api/plugin/refresh', 'GET');
    expect(r.status).toBe(200);
  });

  it('refuses the POST, naming the hop, and runs nothing', async () => {
    const before = refreshes.n;
    const r = await viaEdge('/api/plugin/refresh', 'POST');
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/proxied|edge|tunnel/i);
    expect(refreshes.n).toBe(before);
  });

  it('positive control: the same POST from the box still refreshes', async () => {
    const before = refreshes.n;
    const r = await fromBox('/api/plugin/refresh', 'POST');
    expect(r.status).toBe(200);
    expect(refreshes.n).toBe(before + 1);
  });
});
