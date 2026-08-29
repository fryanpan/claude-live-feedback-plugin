/**
 * HTTP-level coverage for a PROXIED TRUSTED host — the operator's own product
 * at a public hostname, reached through the Cloudflare tunnel and gated by a
 * Cloudflare Access application over that hostname.
 *
 * This is the third opt-in list, and the widest. `TRUSTED_HOSTS` is "another
 * name for this machine on a network I control" (classifies `local`, refused
 * the moment `cf-ray` says the request came through the edge).
 * `CF_ACCESS_TUNNEL_HOSTS` is a public address for COLLABORATORS (classifies
 * `collab`: Access token required, share-scoped, every operator verb refused).
 * An entry here is a public address for the OPERATOR: Access token required,
 * and then the whole product — the doc list, workspace creation, share
 * administration — exactly as loopback gets it.
 *
 * Three lists, and none of them may leak into another. So the suites are:
 *
 *   A. With Access in front, does a token holder reach the PRODUCT (not merely
 *      the share surface), and is everything else at the door still refused?
 *   B. Without Access — team domain unset, or no static AUD — is the list
 *      IGNORED rather than honoured? This is the test that must go red if the
 *      guard is removed: an "it works" test alone passes against a build with
 *      no gate at all.
 *   C. Does a `TRUSTED_HOSTS` entry stay refused through the proxy (the lists
 *      are separate), and does a host in BOTH opt-in lists stay collab?
 *   D. Is the browser-origin policy wired the way it is for `TRUSTED_HOSTS`?
 *
 * The predicates are unit-tested in host-guard.test.ts. These drive the real
 * route table, because the route layer is the part nothing type-checks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { type ServerHandle, createServer } from '../src/server.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'proxied-trusted-kid';
/** The Access application over the operator hostname has its own AUD. */
const OPERATOR_AUD = 'aud-for-the-operator-app';
/** The operator's public hostname — the list under test. */
const PROXIED_HOST = 'operator.example.com';
/** A `TRUSTED_HOSTS` entry — a LAN alias, never a tunnel address. */
const LAN_ALIAS = 'mac-mini-alias.example.com';
/** A collaboration hostname, for the both-lists case. */
const COLLAB_HOST = 'collab.example.com';
/** Link-mode sharing configured alongside, because prod has it. */
const LINK_HOST = 'links.example.com';
/** Cloudflare stamps this on everything it proxies; its presence IS the hop. */
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };

let jwks: JSONWebKeySet;
let signJwt: (aud: string) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  jwks = { keys: [publicJwk] };
  signJwt = (aud: string) =>
    new SignJWT({ email: 'operator@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-operator-1')
      .sign(privateKey);
});

const dirs: string[] = [];
const handles: ServerHandle[] = [];
const spinUp = (
  opts: Omit<Parameters<typeof createServer>[0], 'port' | 'dataDir'>,
): ServerHandle => {
  const dataDir = mkdtempSync(join(tmpdir(), 'proxied-trusted-'));
  dirs.push(dataDir);
  const h = createServer({ port: 0, dataDir, ...opts });
  handles.push(h);
  return h;
};
afterAll(async () => {
  for (const h of handles) await h.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const get = (h: ServerHandle, path: string, headers: Record<string, string>) =>
  fetch(`http://localhost:${h.port}${path}`, { headers });

describe('a proxied trusted host, with Access in front of it', () => {
  let h: ServerHandle;
  let jwt: string;

  beforeAll(async () => {
    h = spinUp({
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OPERATOR_AUD, jwks },
      // Link sharing wired TOO, on purpose: with `shares` present the main
      // verifier resolves its AUD per share hostname and answers null for any
      // other host, and the legacy "whole server behind Access" branch stops
      // running. The operator host must not depend on either — it gets its
      // own verifier built from the static AUD.
      share: { config: { publicHostname: LINK_HOST } },
      trustedHosts: [LAN_ALIAS],
      proxiedTrustedHosts: [PROXIED_HOST],
    });
    jwt = await signJwt(OPERATOR_AUD);
  });

  describe('A. what a token holder reaches, and what the door refuses', () => {
    it('reaches the PRODUCT — the doc list a collaborator is refused', async () => {
      const r = await get(h, '/api/docs', {
        host: PROXIED_HOST,
        ...CF_RAY,
        'cf-access-jwt-assertion': jwt,
      });
      expect(r.status).toBe(200);
    });

    it('may do operator work — create a workspace, read the share admin surface', async () => {
      const created = await fetch(`http://localhost:${h.port}/api/workspaces`, {
        method: 'POST',
        headers: {
          host: PROXIED_HOST,
          ...CF_RAY,
          'cf-access-jwt-assertion': jwt,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'From outside' }),
      });
      expect(created.status).toBe(200);
      const shares = await get(h, '/api/share', {
        host: PROXIED_HOST,
        ...CF_RAY,
        'cf-access-jwt-assertion': jwt,
      });
      expect(shares.status).toBe(200);
    });

    it('demands a token — reaching the hostname is not reaching the product', async () => {
      const r = await get(h, '/api/docs', { host: PROXIED_HOST, ...CF_RAY });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'missing_jwt' });
    });

    it('rejects a token minted for a different Access application', async () => {
      const wrong = await signJwt('aud-for-some-other-app');
      const r = await get(h, '/api/docs', {
        host: PROXIED_HOST,
        ...CF_RAY,
        'cf-access-jwt-assertion': wrong,
      });
      expect(r.status).toBe(401);
    });

    it('refuses the hostname when the request did NOT come through the edge', async () => {
      // A LAN client can send any Host it likes. Without the proxy hop there
      // is no Access application in front of the request, so the list must
      // not recognise it — even holding a valid token.
      const r = await get(h, '/api/docs', { host: PROXIED_HOST, 'cf-access-jwt-assertion': jwt });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'unknown_host' });
    });

    it('still refuses a proxied host that is NOT on the list — token or no token', async () => {
      for (const host of ['unlisted.example.com', `attacker.${PROXIED_HOST}`, 'localhost']) {
        const r = await get(h, '/api/docs', { host, ...CF_RAY, 'cf-access-jwt-assertion': jwt });
        expect(r.status, host).toBe(403);
        expect(await r.json(), host).toEqual({ error: 'unknown_host' });
      }
    });
  });

  describe('C. the lists stay separate', () => {
    it('a TRUSTED_HOSTS entry does NOT gain proxied access', async () => {
      // The negative control for "a second list, not a widening". A LAN alias
      // reached through the tunnel is refused whatever token it carries…
      const viaProxy = await get(h, '/api/docs', {
        host: LAN_ALIAS,
        ...CF_RAY,
        'cf-access-jwt-assertion': jwt,
      });
      expect(viaProxy.status).toBe(403);
      expect(await viaProxy.json()).toEqual({ error: 'unknown_host' });
      // …and the POSITIVE CONTROL: the same alias reached directly is what it
      // always was — local, no token needed.
      const direct = await get(h, '/api/docs', { host: LAN_ALIAS });
      expect(direct.status).toBe(200);
    });

    it('leaves loopback and the link hostname exactly as they were', async () => {
      expect((await get(h, '/api/docs', { host: `localhost:${h.port}` })).status).toBe(200);
      const link = await get(h, '/api/docs', { host: LINK_HOST, ...CF_RAY });
      expect(link.status).toBe(401);
      expect(await link.json()).toEqual({ error: 'no_share_session' });
    });
  });

  describe('D. the browser-origin policy, wired like TRUSTED_HOSTS', () => {
    it('treats a dev server on the proxied host name as local, and refuses a stranger', async () => {
      const auth = { host: PROXIED_HOST, ...CF_RAY, 'cf-access-jwt-assertion': jwt };
      const own = await get(h, '/api/docs', { ...auth, origin: `http://${PROXIED_HOST}:5173` });
      expect(own.status).toBe(200);
      expect(own.headers.get('access-control-allow-origin')).toBe(`http://${PROXIED_HOST}:5173`);
      const evil = await get(h, '/api/docs', { ...auth, origin: 'http://evil.example.com' });
      expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    });
  });
});

describe('B. the opt-in fails closed', () => {
  it('with NO Access configured, the list is IGNORED — every request refused', async () => {
    // The refusal the whole design turns on. Honouring the list here would
    // hand the ENTIRE product to anyone who can reach the tunnel and type the
    // hostname — the exact hole the cf-ray veto was added to close. Asserted
    // with and without a token: with no team domain there is nothing to
    // verify one against, so a token must count for nothing.
    const h = spinUp({ proxiedTrustedHosts: [PROXIED_HOST] });
    const jwt = await signJwt(OPERATOR_AUD);
    const extras: Record<string, string>[] = [{}, { 'cf-access-jwt-assertion': jwt }];
    for (const extra of extras) {
      const r = await get(h, '/api/docs', { host: PROXIED_HOST, ...CF_RAY, ...extra });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'unknown_host' });
    }
    // POSITIVE CONTROL: that server is alive and serving its local caller, so
    // the 403 is the gate rather than a server that answers nothing.
    expect((await get(h, '/api/docs', { host: `localhost:${h.port}` })).status).toBe(200);
  });

  it('with a team domain but NO static AUD, the list is still ignored', async () => {
    // A per-share resolver is what `cfAccess.audience` becomes when Access
    // sharing is wired. It cannot answer for the operator hostname (it is not
    // a share), so there is nothing to verify a token against — refuse.
    const h = spinUp({
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: () => OPERATOR_AUD, jwks },
      proxiedTrustedHosts: [PROXIED_HOST],
    });
    const jwt = await signJwt(OPERATOR_AUD);
    const r = await get(h, '/api/docs', {
      host: PROXIED_HOST,
      ...CF_RAY,
      'cf-access-jwt-assertion': jwt,
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'unknown_host' });
    // POSITIVE CONTROL. With Access configured and no shares, this server is
    // in legacy whole-server mode — loopback needs the token too — so the
    // control carries one. It proves the server answers, not that the gate
    // was skipped.
    expect(
      (
        await get(h, '/api/docs', {
          host: `localhost:${h.port}`,
          'cf-access-jwt-assertion': jwt,
        })
      ).status,
    ).toBe(200);
  });

  it('WITHOUT the opt-in, the hostname answers exactly what it always did', async () => {
    const h = spinUp({ cfAccess: { teamDomain: TEAM_DOMAIN, audience: OPERATOR_AUD, jwks } });
    const jwt = await signJwt(OPERATOR_AUD);
    const r = await get(h, '/api/docs', {
      host: PROXIED_HOST,
      ...CF_RAY,
      'cf-access-jwt-assertion': jwt,
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'unknown_host' });
  });

  it('a host in BOTH opt-in lists stays collab — the narrower grant wins', async () => {
    // Listing a hostname as a collaboration address AND as the operator's
    // address is a contradiction; resolved toward the grant that reaches
    // less. The doc list is the tell: a collaborator is refused it.
    const h = spinUp({
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OPERATOR_AUD, jwks },
      accessTunnelHosts: [COLLAB_HOST],
      proxiedTrustedHosts: [COLLAB_HOST],
    });
    const jwt = await signJwt(OPERATOR_AUD);
    const r = await get(h, '/api/docs', {
      host: COLLAB_HOST,
      ...CF_RAY,
      'cf-access-jwt-assertion': jwt,
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'out_of_share_scope' });
  });
});
