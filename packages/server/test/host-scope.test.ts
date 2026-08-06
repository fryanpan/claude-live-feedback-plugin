/**
 * HTTP-level coverage for the two authorization fixes (2026-08-05 review):
 *
 *   A. Default-deny by host — an unknown hostname arriving over the tunnel
 *      must be refused, not waved past the Access gate.
 *   B. Share scoping — passing Access for ONE shared doc must not grant the
 *      rest of the server.
 *
 * host-guard.test.ts covers the predicates. These tests drive the real route
 * table, because the route layer is the part nothing type-checks — a gate
 * that returns the right decision but is wired in the wrong place, or after
 * a route that already answered, would still pass the unit tests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';
import { CfApi } from '../src/share/cf-api.ts';
import type { CfAccessApp, CfAccessPolicy } from '../src/share/cf-api.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const BASE_HOSTNAME = 'tunnel.example.com';
const KID = 'host-scope-kid';
const LOCAL_ALIAS = 'mac-mini-alias.example.test';

const SHARE_CONFIG = {
  cfAccountId: 'test-account',
  cfTeamDomain: TEAM_DOMAIN,
  baseHostname: BASE_HOSTNAME,
};

function makeMockCfApi(state: { apps: CfAccessApp[]; policies: CfAccessPolicy[] }) {
  // biome-ignore lint/suspicious/noExplicitAny: Bun fetch type compatibility
  const fetchImpl: any = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.endsWith('/access/apps')) {
      const body = JSON.parse(init?.body as string);
      const app: CfAccessApp = {
        id: `app-${state.apps.length + 1}`,
        name: body.name,
        domain: body.domain,
        aud: `aud-${state.apps.length + 1}`,
        session_duration: body.session_duration,
      };
      state.apps.push(app);
      return new Response(JSON.stringify({ success: true, result: app }), { status: 200 });
    }
    const policyMatch = url.match(/access\/apps\/([^/]+)\/policies$/);
    if (method === 'POST' && policyMatch) {
      const body = JSON.parse(init?.body as string);
      const policy: CfAccessPolicy = {
        id: `policy-${state.policies.length + 1}`,
        name: body.name,
        decision: body.decision,
      };
      state.policies.push(policy);
      return new Response(JSON.stringify({ success: true, result: policy }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unhandled' }), { status: 404 });
  };
  return new CfApi({ accountId: 'test-account', token: 'test-token', fetchImpl });
}

describe('host gate + share scoping over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let shareHost: string;
  let shareJwt: string;
  let signJwt: (aud: string) => Promise<string>;

  const SHARED = 'shared-doc';
  const OTHER = 'other-doc';

  /** Request against the real server with an arbitrary Host header. */
  const req = (path: string, host: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: { host, ...((init.headers as Record<string, string>) ?? {}) },
    });

  /** As an authenticated visitor on the share hostname. */
  const asVisitor = (path: string, init: RequestInit = {}) =>
    req(path, shareHost, {
      ...init,
      headers: {
        'cf-access-jwt-assertion': shareJwt,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const publicJwk = (await exportJWK(publicKey)) as JWK;
    publicJwk.kid = KID;
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    const jwks: JSONWebKeySet = { keys: [publicJwk] };

    signJwt = (aud: string) =>
      new SignJWT({ email: 'reviewer@partner.example' })
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(`https://${TEAM_DOMAIN}`)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .setSubject('cf-access-user-1')
        .sign(privateKey);

    dataDir = mkdtempSync(join(tmpdir(), 'host-scope-'));
    handle = createServer({
      port: 0,
      dataDir,
      trustedHosts: [LOCAL_ALIAS],
      // audience is overridden by the shares registry's per-share AUD
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: 'unused', jwks },
      share: { config: SHARE_CONFIG, cfApi: makeMockCfApi({ apps: [], policies: [] }) },
    });
    base = `http://localhost:${handle.port}`;

    // Two file-backed docs; only one of them gets shared.
    for (const id of [SHARED, OTHER]) {
      const path = join(dataDir, `${id}.md`);
      writeFileSync(path, `# ${id}\n\nBody.\n`);
      const r = await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: id, type: 'markdown', sourceUrl: path }),
      });
      expect(r.status).toBe(200);
    }

    const sr = await fetch(`${base}/api/share/doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: SHARED, allowDomains: ['partner.example'] }),
    });
    expect(sr.status).toBe(200);
    const shareBody = (await sr.json()) as { share: { hostname: string; audience: string } };
    shareHost = shareBody.share.hostname;
    shareJwt = await signJwt(shareBody.share.audience);
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('A. default-deny by host', () => {
    it('refuses an unknown hostname under the share wildcard', async () => {
      // Before the fix this reached the API unauthenticated: no active
      // share owned the host, so the gate concluded "not a share → skip".
      const r = await req('/api/docs', `not-a-share.${BASE_HOSTNAME}`);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'unknown_host' });
    });

    it('refuses an unrelated public hostname', async () => {
      const r = await req('/api/docs', 'attacker.example.com');
      expect(r.status).toBe(403);
    });

    it('refuses a lookalike of the share hostname', async () => {
      const r = await req('/api/docs', `${shareHost}.attacker.example.com`);
      expect(r.status).toBe(403);
      const r2 = await req('/api/docs', `evil-${shareHost}`);
      expect(r2.status).toBe(403);
    });

    it('does not leak the doc list to an unknown host even on a doc route', async () => {
      const r = await req(`/api/docs/${SHARED}`, 'attacker.example.com');
      expect(r.status).toBe(403);
      const r2 = await req(`/review/${SHARED}`, 'attacker.example.com');
      expect(r2.status).toBe(403);
    });

    it('still serves local callers unauthenticated (the agent over loopback)', async () => {
      const r = await req('/api/docs', `localhost:${handle.port}`);
      expect(r.status).toBe(200);
      const admin = await req('/api/share', `localhost:${handle.port}`);
      expect(admin.status).toBe(200);
    });

    it('honours an operator-declared trusted host', async () => {
      const r = await req('/api/docs', LOCAL_ALIAS);
      expect(r.status).toBe(200);
    });

    it('lets OPTIONS preflight through from any host (CORS runs first)', async () => {
      const r = await req('/api/docs', 'attacker.example.com', { method: 'OPTIONS' });
      expect(r.status).toBe(204);
    });
  });

  describe('B. share host authentication', () => {
    it('demands a token on the share hostname', async () => {
      const r = await req(`/api/docs/${SHARED}`, shareHost);
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'missing_jwt' });
    });

    it('rejects a token minted for a different share', async () => {
      const wrong = await signJwt('aud-for-some-other-share');
      const r = await req(`/api/docs/${SHARED}`, shareHost, {
        headers: { 'cf-access-jwt-assertion': wrong },
      });
      expect(r.status).toBe(401);
    });
  });

  describe('B. share scoping (authenticated visitor)', () => {
    it('can read the doc it was shared', async () => {
      const r = await asVisitor(`/api/docs/${SHARED}`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as { meta: { docId: string } };
      expect(body.meta.docId).toBe(SHARED);
    });

    it('can reach its own review page and event stream route', async () => {
      // Not asserting 200 — the markdown-app dist isn't built in tests.
      // What matters is that the scope check doesn't refuse them.
      expect((await asVisitor(`/review/${SHARED}`)).status).not.toBe(403);
      expect((await asVisitor(`/api/docs/${SHARED}/threads`)).status).not.toBe(403);
    });

    it('CANNOT enumerate every doc on the server', async () => {
      const r = await asVisitor('/api/docs');
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'out_of_share_scope' });
    });

    it('CANNOT read another doc', async () => {
      expect((await asVisitor(`/api/docs/${OTHER}`)).status).toBe(403);
      expect((await asVisitor(`/review/${OTHER}`)).status).toBe(403);
      expect((await asVisitor(`/api/docs/${OTHER}/threads`)).status).toBe(403);
    });

    it("CANNOT open another doc's websocket route", async () => {
      // Plain GET: the gate must answer before the upgrade handler.
      expect((await asVisitor(`/y/${OTHER}`)).status).toBe(403);
      expect((await asVisitor(`/events/${OTHER}`)).status).toBe(403);
    });

    it('CANNOT list, mint, or revoke shares', async () => {
      expect((await asVisitor('/api/share')).status).toBe(403);
      const mint = await asVisitor('/api/share/doc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: OTHER, allowDomains: ['attacker.example'] }),
      });
      expect(mint.status).toBe(403);
      expect((await asVisitor('/api/share/some-id', { method: 'DELETE' })).status).toBe(403);
    });

    it('CANNOT bind a folder or create a diff review (arbitrary filesystem read)', async () => {
      const ws = await asVisitor('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ folderPath: '/etc' }),
      });
      expect(ws.status).toBe(403);
      const diff = await asVisitor('/api/diffs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: '/', base: 'HEAD' }),
      });
      expect(diff.status).toBe(403);
    });

    it('CANNOT create a doc bound to an arbitrary path', async () => {
      const r = await asVisitor('/api/docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: 'evil', type: 'markdown', sourceUrl: '/etc/hosts' }),
      });
      expect(r.status).toBe(403);
    });

    it('can load the app shell it needs to render the review', async () => {
      expect((await asVisitor('/app/app.js')).status).not.toBe(403);
    });
  });
});
