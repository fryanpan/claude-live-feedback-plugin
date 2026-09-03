/**
 * Building an ACCESS-mode share visitor in a test, in four lines.
 *
 * Link mode is retired (2026-09-02), and it used to be the cheap way to make
 * a visitor: mint `/api/share/link`, follow the redirect, keep the cookie.
 * Every suite that needed "somebody who is not the owner" did that, so the
 * retirement touched two dozen files that were not about sharing at all.
 * This is the replacement, in one place, so the next change to how a visitor
 * is authorized is one file rather than twenty-eight.
 *
 * What it gives you is the real thing rather than a stub: a genuine RS256
 * JWKS, a genuine signed Cloudflare Access token, and the server's own share
 * registry minting a per-share hostname with its own AUD. Only the Cloudflare
 * REST API is faked, because that is the one part that would otherwise leave
 * the machine.
 */
import { expect } from 'bun:test';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { CfApi } from '../src/share/cf-api.ts';
import type { CfAccessApp, CfAccessPolicy } from '../src/share/cf-api.ts';

export const ACCESS_TEAM_DOMAIN = 'test.cloudflareaccess.com';
export const ACCESS_BASE_HOSTNAME = 'tunnel.example.com';
/** The audience a share's own Access application never has — passed as the
 *  static one so a bug that reads it instead of the per-share AUD fails. */
const UNUSED_STATIC_AUD = 'static-aud-never-matches-a-share';

export const ACCESS_SHARE_CONFIG = {
  cfAccountId: 'test-account',
  cfTeamDomain: ACCESS_TEAM_DOMAIN,
  baseHostname: ACCESS_BASE_HOSTNAME,
};

/**
 * A Cloudflare Access REST client whose fetch never leaves the process.
 *
 * It assigns each app a distinct `aud-<n>`, which is what makes "a token for
 * one share is refused at another" testable at all.
 */
export function mockCfApi(
  state: { apps: CfAccessApp[]; policies: CfAccessPolicy[] } = {
    apps: [],
    policies: [],
  },
) {
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
    if (method === 'DELETE' && /access\/apps\/[^/]+$/.test(url)) {
      const id = url.slice(url.lastIndexOf('/') + 1);
      const i = state.apps.findIndex((a) => a.id === id);
      if (i >= 0) state.apps.splice(i, 1);
      return new Response(JSON.stringify({ success: true, result: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unhandled' }), { status: 404 });
  };
  return new CfApi({ accountId: 'test-account', token: 'test-token', fetchImpl });
}

export interface AccessHarness {
  /** Spread into `createServer` — the verifier and the share registry. */
  serverOptions: {
    cfAccess: { teamDomain: string; audience: string; jwks: JSONWebKeySet };
    share: { config: typeof ACCESS_SHARE_CONFIG; cfApi: CfApi };
  };
  /** Sign a token for one share's AUD, as the given email. */
  signJwt: (aud: string, email?: string) => Promise<string>;
}

/** The keys and the `createServer` options an Access share needs. */
export async function accessHarness(
  defaultEmail = 'reviewer@partner.example',
): Promise<AccessHarness> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = 'access-share-kid';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const jwks: JSONWebKeySet = { keys: [publicJwk] };
  return {
    serverOptions: {
      cfAccess: { teamDomain: ACCESS_TEAM_DOMAIN, audience: UNUSED_STATIC_AUD, jwks },
      share: { config: ACCESS_SHARE_CONFIG, cfApi: mockCfApi() },
    },
    signJwt: (aud, email = defaultEmail) =>
      new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256', kid: 'access-share-kid' })
        .setIssuer(`https://${ACCESS_TEAM_DOMAIN}`)
        .setAudience(aud)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .setSubject('cf-access-test-visitor')
        .sign(privateKey),
  };
}

export interface MintedShare {
  shareId: string;
  /** `share-<slug>.tunnel.example.com` — the visitor's Host header. */
  host: string;
  /** The Access token that hostname's application accepts. */
  jwt: string;
  /** Headers to put on every visitor request. */
  headers: Record<string, string>;
  /** Where the share URL lands. */
  url: string;
  expiresAt: number;
}

/**
 * Mint a board share over the real route and hand back everything a visitor
 * request needs. `/api/share/link` is deliberately the route used, because
 * that is the one every migrated caller was already calling and it now mints
 * an Access share like its sibling.
 */
export async function mintAccessShare(
  base: string,
  harness: AccessHarness,
  workspaceId: string,
  opts: { label?: string; ttlSeconds?: number; allowDomains?: string[] } = {},
): Promise<MintedShare> {
  const res = await fetch(`${base}/api/share/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId,
      allowDomains: opts.allowDomains ?? ['@partner.example'],
      ...(opts.label ? { label: opts.label } : {}),
      ...(opts.ttlSeconds ? { ttlSeconds: opts.ttlSeconds } : {}),
    }),
  });
  expect(res.status).toBe(200);
  const { share } = (await res.json()) as {
    share: { shareId: string; hostname: string; audience: string; url: string; expiresAt: number };
  };
  const jwt = await harness.signJwt(share.audience);
  return {
    shareId: share.shareId,
    host: share.hostname,
    jwt,
    headers: { host: share.hostname, 'cf-access-jwt-assertion': jwt },
    url: share.url,
    expiresAt: share.expiresAt,
  };
}
