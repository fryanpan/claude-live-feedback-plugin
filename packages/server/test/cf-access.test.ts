import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { CfAccessOptions } from '../src/middleware/cf-access.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const AUDIENCE = 'test-aud-tag';
const KID = 'test-kid';

describe('Cloudflare Access JWT verification', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let signValidJwt: (overrides?: {
    aud?: string;
    iss?: string;
    expSec?: number;
  }) => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const publicJwk = (await exportJWK(publicKey)) as JWK;
    publicJwk.kid = KID;
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    const jwks: JSONWebKeySet = { keys: [publicJwk] };

    signValidJwt = async (overrides = {}) => {
      const exp = overrides.expSec ?? Math.floor(Date.now() / 1000) + 600;
      return await new SignJWT({ email: 'alice@partner-org.example' })
        .setProtectedHeader({ alg: 'RS256', kid: KID })
        .setIssuer(overrides.iss ?? `https://${TEAM_DOMAIN}`)
        .setAudience(overrides.aud ?? AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(exp)
        .setSubject('cf-access-user-1')
        .sign(privateKey);
    };

    const cfAccess: CfAccessOptions = {
      teamDomain: TEAM_DOMAIN,
      audience: AUDIENCE,
      jwks,
    };

    dataDir = mkdtempSync(join(tmpdir(), 'cf-access-test-'));
    handle = createServer({ port: 0, dataDir, cfAccess });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('rejects requests without a JWT header or cookie', async () => {
    const r = await fetch(`${base}/api/docs`);
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('missing_jwt');
  });

  it('accepts a valid JWT in the Cf-Access-Jwt-Assertion header', async () => {
    const jwt = await signValidJwt();
    const r = await fetch(`${base}/api/docs`, {
      headers: { 'cf-access-jwt-assertion': jwt },
    });
    expect(r.status).toBe(200);
  });

  it('accepts a valid JWT in the CF_Authorization cookie', async () => {
    const jwt = await signValidJwt();
    const r = await fetch(`${base}/api/docs`, {
      headers: { cookie: `CF_Authorization=${jwt}; other=value` },
    });
    expect(r.status).toBe(200);
  });

  it('rejects a JWT signed for a different audience', async () => {
    const jwt = await signValidJwt({ aud: 'wrong-aud' });
    const r = await fetch(`${base}/api/docs`, {
      headers: { 'cf-access-jwt-assertion': jwt },
    });
    expect(r.status).toBe(401);
  });

  it('rejects a JWT with a different issuer', async () => {
    const jwt = await signValidJwt({ iss: 'https://attacker.cloudflareaccess.com' });
    const r = await fetch(`${base}/api/docs`, {
      headers: { 'cf-access-jwt-assertion': jwt },
    });
    expect(r.status).toBe(401);
  });

  it('rejects an expired JWT', async () => {
    const jwt = await signValidJwt({ expSec: Math.floor(Date.now() / 1000) - 60 });
    const r = await fetch(`${base}/api/docs`, {
      headers: { 'cf-access-jwt-assertion': jwt },
    });
    expect(r.status).toBe(401);
  });

  it('lets OPTIONS preflight through without a JWT', async () => {
    // The point of this test is the Access gate, not CORS: a preflight must
    // not require a JWT, because the browser sends it without credentials and
    // a 401 here would break every cross-origin call before it started.
    const r = await fetch(`${base}/api/docs`, { method: 'OPTIONS' });
    expect(r.status).toBe(204);
  });

  it('grants the preflight to an allowed origin, and nothing to a stranger', async () => {
    // CORS is no longer a blanket `*` — see middleware/browser-origin.ts.
    const ok = await fetch(`${base}/api/docs`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    const evil = await fetch(`${base}/api/docs`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('server with cfAccess unset (default)', () => {
  let handle: ServerHandle;
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cf-access-noop-'));
    handle = createServer({ port: 0, dataDir });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves requests without any auth check', async () => {
    const r = await fetch(`http://localhost:${handle.port}/api/docs`);
    expect(r.status).toBe(200);
  });
});
