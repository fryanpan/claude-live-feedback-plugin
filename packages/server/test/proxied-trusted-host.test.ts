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
 *   A. With Access in front, does the OPERATOR reach the PRODUCT (not merely
 *      the share surface), and is everyone else at the door refused — no
 *      token, the wrong app, and above all a collaborator the SAME Access
 *      application admits? A token is admission, not identity; the verified
 *      email against the operator allowlist is what says who.
 *   B. Without Access — team domain unset, no static AUD — or without an
 *      operator allowlist, is the list IGNORED rather than honoured? These
 *      are the tests that must go red if a guard is removed: an "it works"
 *      test alone passes against a build with no gate at all.
 *   C. Does a `TRUSTED_HOSTS` entry stay refused through the proxy (the lists
 *      are separate), and does a host in BOTH opt-in lists stay collab?
 *   D. Is the browser-origin policy same-origin plus `ALLOWED_ORIGINS` and
 *      nothing else? Through the tunnel, the visitor's localhost is not ours.
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
import { seedBoardOnHandle } from './workspace-seed.ts';

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
/** The one identity the operator allowlist admits… */
const OPERATOR_EMAIL = 'Operator@Example.com';
/** …and a collaborator the SAME Access application also admits. */
const COLLABORATOR_EMAIL = 'collaborator@partner.example';
/** An ALLOWED_ORIGINS entry — the one cross-origin grant that survives. */
const ALLOWED_ORIGIN = 'https://studio.example.net';

let jwks: JSONWebKeySet;
/** A token for `aud`, carrying `email` — `null` for a token with NO email claim. */
let signJwt: (aud: string, email?: string | null) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  jwks = { keys: [publicJwk] };
  signJwt = (aud: string, email: string | null = OPERATOR_EMAIL) =>
    new SignJWT(email === null ? {} : { email })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(`https://${TEAM_DOMAIN}`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .setSubject('cf-access-operator-1')
      .sign(privateKey);
});

const dirs: string[] = [];
const boards = new WeakMap<ServerHandle, string>();
const handles: ServerHandle[] = [];
const spinUp = async (
  opts: Omit<Parameters<typeof createServer>[0], 'port' | 'dataDir'>,
): Promise<ServerHandle> => {
  const dataDir = mkdtempSync(join(tmpdir(), 'proxied-trusted-'));
  dirs.push(dataDir);
  const h = createServer({ port: 0, dataDir, ...opts });
  // Seeded THROUGH THE HANDLE, not over HTTP: half the servers here are the
  // auth-gated ones, and an unauthenticated POST /workspaces is exactly what
  // they exist to refuse. Kept per handle because each server is its own
  // store — one module-level board id is stale the moment a second server
  // boots, and this file boots eight.
  boards.set(h, seedBoardOnHandle(h));
  handles.push(h);
  return h;
};

/** The seeded board of a given server, as the path prefix its docs live under. */
const docsOf = (h: ServerHandle) => `/workspaces/${boards.get(h) ?? ''}/docs`;
afterAll(async () => {
  for (const h of handles) await h.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const get = (h: ServerHandle, path: string, headers: Record<string, string>) =>
  fetch(`http://localhost:${h.port}${path}`, { headers });

/** The board this file's docs, tasks and reviews are filed under. */

describe('a proxied trusted host, with Access in front of it', () => {
  let h: ServerHandle;
  let jwt: string;

  beforeAll(async () => {
    h = await spinUp({
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OPERATOR_AUD, jwks },
      // Link sharing wired TOO, on purpose: with `shares` present the main
      // verifier resolves its AUD per share hostname and answers null for any
      // other host, and the legacy "whole server behind Access" branch stops
      // running. The operator host must not depend on either — it gets its
      // own verifier built from the static AUD.
      share: { config: { publicHostname: LINK_HOST } },
      trustedHosts: [LAN_ALIAS],
      // A collaboration host on the SAME server, sharing the SAME static
      // AUD: the two opt-in lists reuse one verifier, so the thing under
      // test in suite C is that the grant still differs by list.
      accessTunnelHosts: [COLLAB_HOST],
      proxiedTrustedHosts: [PROXIED_HOST],
      // Lower-cased here, mixed-case in the token: the allowlist folds the
      // way the roster folds, or the operator locks themself out over a
      // capital letter.
      proxiedTrustedEmails: [OPERATOR_EMAIL.toLowerCase()],
      allowedOrigins: [ALLOWED_ORIGIN],
    });
    jwt = await signJwt(OPERATOR_AUD);
  });

  describe('A. what a token holder reaches, and what the door refuses', () => {
    it('reaches the PRODUCT — the doc list a collaborator is refused', async () => {
      const r = await get(h, docsOf(h), {
        host: PROXIED_HOST,
        ...CF_RAY,
        'cf-access-jwt-assertion': jwt,
      });
      expect(r.status).toBe(200);
    });

    it('may do operator work — create a workspace, read the share admin surface', async () => {
      const created = await fetch(`http://localhost:${h.port}/workspaces`, {
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
      const r = await get(h, docsOf(h), { host: PROXIED_HOST, ...CF_RAY });
      expect(r.status).toBe(401);
      expect(await r.json()).toEqual({ error: 'missing_jwt' });
    });

    it('rejects a token minted for a different Access application', async () => {
      const wrong = await signJwt('aud-for-some-other-app');
      const r = await get(h, docsOf(h), {
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
      const r = await get(h, docsOf(h), {
        host: PROXIED_HOST,
        'cf-access-jwt-assertion': jwt,
      });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'unknown_host' });
    });

    it('a token is admission, not identity — a collaborator the SAME app admits is refused', async () => {
      // One Access application (one AUD) may cover both hostnames, so a
      // collaborator's perfectly valid token reaches this door too. What
      // makes it the operator's door is the email allowlist: the verified
      // claim must name an operator, or every operator verb is refused with
      // a body that does not echo who was refused.
      const asCollaborator = {
        host: PROXIED_HOST,
        ...CF_RAY,
        'cf-access-jwt-assertion': await signJwt(OPERATOR_AUD, COLLABORATOR_EMAIL),
      };
      const list = await get(h, docsOf(h), asCollaborator);
      expect(list.status).toBe(403);
      expect(await list.json()).toEqual({ error: 'forbidden' });
      const create = await fetch(`http://localhost:${h.port}/workspaces`, {
        method: 'POST',
        headers: { ...asCollaborator, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Should not exist' }),
      });
      expect(create.status).toBe(403);
      expect(await create.json()).toEqual({ error: 'forbidden' });
      const deploy = await fetch(`http://localhost:${h.port}/api/deploy`, {
        method: 'POST',
        headers: asCollaborator,
      });
      expect(deploy.status).toBe(403);
      expect(await deploy.json()).toEqual({ error: 'forbidden' });
    });

    it('a token with NO email claim names nobody, and nobody is not the operator', async () => {
      const r = await get(h, docsOf(h), {
        host: PROXIED_HOST,
        ...CF_RAY,
        'cf-access-jwt-assertion': await signJwt(OPERATOR_AUD, null),
      });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'forbidden' });
    });

    it('the operator reaches the deploy verb itself — the gate, not the deployer, is under test', async () => {
      // 501 is "no deployer on this server", which sits BEHIND the host gate
      // and the identity check: reaching it is the positive control for the
      // collaborator's 403 above.
      const r = await fetch(`http://localhost:${h.port}/api/deploy`, {
        method: 'POST',
        headers: { host: PROXIED_HOST, ...CF_RAY, 'cf-access-jwt-assertion': jwt },
      });
      expect(r.status).toBe(501);
    });

    it('still refuses a proxied host that is NOT on the list — token or no token', async () => {
      for (const host of ['unlisted.example.com', `attacker.${PROXIED_HOST}`, 'localhost']) {
        const r = await get(h, docsOf(h), {
          host,
          ...CF_RAY,
          'cf-access-jwt-assertion': jwt,
        });
        expect(r.status, host).toBe(403);
        expect(await r.json(), host).toEqual({ error: 'unknown_host' });
      }
    });
  });

  describe('C. the lists stay separate', () => {
    it('a TRUSTED_HOSTS entry does NOT gain proxied access', async () => {
      // The negative control for "a second list, not a widening". A LAN alias
      // reached through the tunnel is refused whatever token it carries…
      const viaProxy = await get(h, docsOf(h), {
        host: LAN_ALIAS,
        ...CF_RAY,
        'cf-access-jwt-assertion': jwt,
      });
      expect(viaProxy.status).toBe(403);
      expect(await viaProxy.json()).toEqual({ error: 'unknown_host' });
      // …and reached DIRECTLY it is refused too, because access-only closed
      // the LAN grant: a trusted-host declaration no longer stands in for a
      // sign-in.
      expect((await get(h, docsOf(h), { host: LAN_ALIAS })).status).toBe(403);

      // POSITIVE CONTROL, on a server with the rule turned off: the same
      // alias is still a declared trusted host, so the refusals above are
      // the access-only rule rather than a declaration that stopped working.
      const legacy = await spinUp({ trustedHosts: [LAN_ALIAS], accessOnlyBrowserHosts: false });
      expect((await get(legacy, docsOf(legacy), { host: LAN_ALIAS })).status).toBe(200);
    });

    it('a collab-listed host still CANNOT reach an operator verb — same token, same server', async () => {
      // The same valid token — one static AUD serves both lists — reaches the
      // product on the operator host (suite A) and is refused the operator
      // verbs on the collaboration host. The list, not the token, is the
      // grant.
      const collab = { host: COLLAB_HOST, ...CF_RAY, 'cf-access-jwt-assertion': jwt };
      const list = await get(h, docsOf(h), collab);
      expect(list.status).toBe(403);
      expect(await list.json()).toEqual({ error: 'out_of_share_scope' });
      const create = await fetch(`http://localhost:${h.port}/workspaces`, {
        method: 'POST',
        headers: { ...collab, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Should not exist' }),
      });
      expect(create.status).toBe(403);
      expect(await create.json()).toEqual({ error: 'out_of_share_scope' });
      // POSITIVE CONTROL: the collab host is live and serving its own
      // surface, so the 403s above are scope, not a dead hostname.
      expect((await get(h, '/app', collab)).status).not.toBe(403);
    });

    it('leaves loopback alone, and the retired link hostname reaches nothing', async () => {
      expect((await get(h, docsOf(h), { host: `localhost:${h.port}` })).status).toBe(200);
      // The link hostname used to answer 401 no_share_session — an invitation
      // to redeem. Link mode is retired, so the name resolves to no share at
      // all and is indistinguishable from one this server never served.
      const link = await get(h, docsOf(h), { host: LINK_HOST, ...CF_RAY });
      expect(link.status).toBe(403);
      expect(await link.json()).toEqual({ error: 'unknown_host' });
    });
  });

  describe('D. the browser-origin policy: same-origin and ALLOWED_ORIGINS, nothing else', () => {
    // Through the tunnel, "localhost" in the visitor's browser is the
    // VISITOR'S machine, not this one — so the loopback / LAN / dev-server
    // allowances that make sense for a TRUSTED_HOSTS name are exactly wrong
    // here. A page at http://localhost:3000 on the operator's laptop is not
    // ours to trust.
    const auth = () => ({ host: PROXIED_HOST, ...CF_RAY, 'cf-access-jwt-assertion': jwt });

    it('reflects its own origin and a configured one', async () => {
      // No x-forwarded-proto in the fixture, so the request origin is plain
      // http on the host — the browser's Origin for a same-origin page.
      const own = await get(h, docsOf(h), {
        ...auth(),
        origin: `http://${PROXIED_HOST}`,
      });
      expect(own.status).toBe(200);
      expect(own.headers.get('access-control-allow-origin')).toBe(`http://${PROXIED_HOST}`);
      const configured = await get(h, docsOf(h), {
        ...auth(),
        origin: ALLOWED_ORIGIN,
      });
      expect(configured.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    });

    it('does NOT reflect loopback, a LAN name, a dev port on its own name, or a stranger', async () => {
      for (const origin of [
        'http://localhost:3000',
        'http://127.0.0.1:5173',
        `http://${LAN_ALIAS}:3000`,
        `http://${PROXIED_HOST}:5173`,
        'http://evil.example.com',
      ]) {
        const r = await get(h, docsOf(h), { ...auth(), origin });
        expect(r.headers.get('access-control-allow-origin'), origin).toBeNull();
      }
    });

    it('refuses a cross-origin write from the visitor’s localhost — the CSRF half', async () => {
      const r = await fetch(`http://localhost:${h.port}/workspaces`, {
        method: 'POST',
        headers: { ...auth(), origin: 'http://localhost:3000', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'CSRF' }),
      });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'origin_not_allowed' });
      // POSITIVE CONTROL: the same write from the page's own origin lands.
      const own = await fetch(`http://localhost:${h.port}/workspaces`, {
        method: 'POST',
        headers: {
          ...auth(),
          origin: `http://${PROXIED_HOST}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'Same origin' }),
      });
      expect(own.status).toBe(200);
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
    const h = await spinUp({ proxiedTrustedHosts: [PROXIED_HOST] });
    const jwt = await signJwt(OPERATOR_AUD);
    const extras: Record<string, string>[] = [{}, { 'cf-access-jwt-assertion': jwt }];
    for (const extra of extras) {
      const r = await get(h, docsOf(h), { host: PROXIED_HOST, ...CF_RAY, ...extra });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'unknown_host' });
    }
    // POSITIVE CONTROL: that server is alive and serving its local caller, so
    // the 403 is the gate rather than a server that answers nothing.
    expect((await get(h, docsOf(h), { host: `localhost:${h.port}` })).status).toBe(200);
  });

  it('with a team domain but NO static AUD, the list is still ignored', async () => {
    // A per-share resolver is what `cfAccess.audience` becomes when Access
    // sharing is wired. It cannot answer for the operator hostname (it is not
    // a share), so there is nothing to verify a token against — refuse.
    const h = await spinUp({
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: () => OPERATOR_AUD, jwks },
      proxiedTrustedHosts: [PROXIED_HOST],
    });
    const jwt = await signJwt(OPERATOR_AUD);
    const r = await get(h, docsOf(h), {
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
        await get(h, docsOf(h), {
          host: `localhost:${h.port}`,
          'cf-access-jwt-assertion': jwt,
        })
      ).status,
    ).toBe(200);
  });

  it('with NO operator allowlist, the list is ignored — a token is not an identity', async () => {
    // Access proves admission by a policy the server cannot see. With nobody
    // named as the operator there is no way to tell the operator from anyone
    // else that policy admits, so the door does not open at all: 403
    // unknown_host, exactly as if the host had never been listed.
    const h = await spinUp({
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OPERATOR_AUD, jwks },
      share: { config: { publicHostname: LINK_HOST } },
      proxiedTrustedHosts: [PROXIED_HOST],
    });
    const r = await get(h, docsOf(h), {
      host: PROXIED_HOST,
      ...CF_RAY,
      'cf-access-jwt-assertion': await signJwt(OPERATOR_AUD),
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'unknown_host' });
    expect((await get(h, docsOf(h), { host: `localhost:${h.port}` })).status).toBe(200);
  });

  it('with a team domain but NO audience at all, the list is ignored', async () => {
    // What bin.ts hands over when CF_ACCESS_TEAM_DOMAIN is set and
    // CF_ACCESS_AUD is not. It used to be a placeholder STRING, which made
    // the static verifier look configured; the refusal must not depend on
    // bin.ts remembering to empty the host lists.
    const h = await spinUp({
      cfAccess: { teamDomain: TEAM_DOMAIN, jwks },
      proxiedTrustedHosts: [PROXIED_HOST],
      proxiedTrustedEmails: [OPERATOR_EMAIL],
      accessTunnelHosts: [COLLAB_HOST],
    });
    const token = await signJwt(OPERATOR_AUD);
    for (const host of [PROXIED_HOST, COLLAB_HOST]) {
      const r = await get(h, docsOf(h), {
        host,
        ...CF_RAY,
        'cf-access-jwt-assertion': token,
      });
      expect(r.status, host).toBe(403);
      expect(await r.json(), host).toEqual({ error: 'unknown_host' });
    }
  });

  it('WITHOUT the opt-in, the hostname answers exactly what it always did', async () => {
    const h = await spinUp({ cfAccess: { teamDomain: TEAM_DOMAIN, audience: OPERATOR_AUD, jwks } });
    const jwt = await signJwt(OPERATOR_AUD);
    const r = await get(h, docsOf(h), {
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
    const h = await spinUp({
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OPERATOR_AUD, jwks },
      accessTunnelHosts: [COLLAB_HOST],
      proxiedTrustedHosts: [COLLAB_HOST],
      proxiedTrustedEmails: [OPERATOR_EMAIL],
    });
    const jwt = await signJwt(OPERATOR_AUD);
    const r = await get(h, docsOf(h), {
      host: COLLAB_HOST,
      ...CF_RAY,
      'cf-access-jwt-assertion': jwt,
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'out_of_share_scope' });
  });
});

/**
 * E. The sharing master switch covers this host too.
 *
 * `SharingGate` is the one thing an operator looks at to answer "is anything
 * reachable from outside right now?", and its condition used to name three
 * host kinds — share, link and collab. `proxied-local` is the fourth and the
 * WIDEST: the operator's own public hostname through the tunnel, with the
 * whole product behind it. Left out, an operator who flipped the switch
 * during a security review, believing the one sentence that describes it, had
 * not closed the widest external door.
 *
 * The refusal has to land ahead of authentication, the way it does for the
 * other three: a valid Access token must get no further than none at all.
 * Both halves are asserted, and the control is the same request while sharing
 * is on.
 */
describe('E. sharing off closes the operator hostname too', () => {
  let h: ServerHandle;
  let jwt: string;

  const setSharing = (enabled: boolean) =>
    fetch(`http://localhost:${h.port}/api/share/enabled`, {
      method: 'POST',
      headers: { host: `localhost:${h.port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });

  beforeAll(async () => {
    h = await spinUp({
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OPERATOR_AUD, jwks },
      share: { config: { publicHostname: LINK_HOST } },
      proxiedTrustedHosts: [PROXIED_HOST],
      proxiedTrustedEmails: [OPERATOR_EMAIL.toLowerCase()],
    });
    jwt = await signJwt(OPERATOR_AUD);
  });

  it('CONTROL: the operator reaches the product while sharing is on', async () => {
    const r = await get(h, docsOf(h), {
      host: PROXIED_HOST,
      ...CF_RAY,
      'cf-access-jwt-assertion': jwt,
    });
    expect(r.status).toBe(200);
  });

  it('refuses the same token once sharing is off', async () => {
    expect((await setSharing(false)).status).toBe(200);
    const r = await get(h, docsOf(h), {
      host: PROXIED_HOST,
      ...CF_RAY,
      'cf-access-jwt-assertion': jwt,
    });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'sharing_disabled' });
  });

  it('gates BEFORE auth — no token looks the same as a good one', async () => {
    // Otherwise the shape of the refusal tells an outsider whether this
    // hostname is a real Access application.
    const r = await get(h, docsOf(h), { host: PROXIED_HOST, ...CF_RAY });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'sharing_disabled' });
  });

  it('leaves the LOCAL surface working, so the switch can be flipped back', async () => {
    // The way out is the way in: local, tailnet and LAN are untouched, which
    // is what stops this from being a lockout.
    const local = await fetch(`http://localhost:${h.port}${docsOf(h)}`, {
      headers: { host: `localhost:${h.port}` },
    });
    expect(local.status).toBe(200);
    expect((await setSharing(true)).status).toBe(200);
    const back = await get(h, docsOf(h), {
      host: PROXIED_HOST,
      ...CF_RAY,
      'cf-access-jwt-assertion': jwt,
    });
    expect(back.status).toBe(200);
  });
});
