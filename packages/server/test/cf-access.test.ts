import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElementAnchor, type User, emailIdentityId } from '@feedback/core';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { activityLogPath } from '../src/activity.ts';
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

/**
 * A verified Access email IS an identity.
 *
 * `cf-access.ts` was already extracting `payload.email` — and throwing it away
 * after authorizing, so a person stayed anonymous on the one surface that knew
 * exactly who they were. Composing here rather than building a second verifier
 * is the point: Access has verified a signed claim from an identity provider,
 * which is a stronger proof than a code we mailed, so it skips the code and
 * mints the same `user-<hash>`.
 */
describe('a verified Access email mints the same identity as a code', () => {
  const TEAM = 'access-identity.cloudflareaccess.com';
  const AUD = 'access-identity-aud';
  const KID2 = 'access-identity-kid';

  let dataDir: string;
  let handle: ServerHandle;
  let base: string;
  let sign: (claims: { email?: string }) => Promise<string>;

  const bryan: User = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };
  const fakeAnchor: ElementAnchor = {
    kind: 'element',
    fingerprint: {
      tag: 'BUTTON',
      stableAttrs: {},
      classes: [],
      text: 'Go',
      path: 'BUTTON[0] > BODY[0]',
      dataAttrs: {},
    },
    snippet: { text: 'Go' },
  };

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const publicJwk = (await exportJWK(publicKey)) as JWK;
    publicJwk.kid = KID2;
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    sign = async (claims) => {
      const jwt = new SignJWT(claims.email ? { email: claims.email } : {})
        .setProtectedHeader({ alg: 'RS256', kid: KID2 })
        .setIssuer(`https://${TEAM}`)
        .setAudience(AUD)
        .setIssuedAt()
        .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
        .setSubject('cf-access-identity-1');
      return await jwt.sign(privateKey);
    };
    dataDir = mkdtempSync(join(tmpdir(), 'cf-access-identity-'));
    handle = createServer({
      port: 0,
      dataDir,
      requireEmailAuth: true,
      cfAccess: { teamDomain: TEAM, audience: AUD, jwks: { keys: [publicJwk] } },
    });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function commentAs(jwt: string, docId: string): Promise<void> {
    const path = join(dataDir, `${docId}.md`);
    writeFileSync(path, `# ${docId}\n\nBody.\n`);
    const created = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': jwt },
      body: JSON.stringify({ docId, type: 'markdown', sourceUrl: path }),
    });
    expect(created.status).toBe(200);
    const res = await fetch(`${base}/api/docs/${docId}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': jwt },
      // Claiming to be the owner. The claim is what Access outranks.
      body: JSON.stringify({ author: bryan, text: 'a note', anchor: fakeAnchor }),
    });
    expect(res.status).toBe(200);
  }

  function actorIds(): string[] {
    return readFileSync(activityLogPath(dataDir), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { type: string; actorId: string })
      .filter((r) => r.type === 'comment')
      .map((r) => r.actorId);
  }

  it('attributes the write to the email identity, not the claimed body', async () => {
    await commentAs(await sign({ email: 'partner@example.com' }), 'access-doc');
    expect(actorIds()).toContain(emailIdentityId('partner@example.com'));
    expect(actorIds()).not.toContain('known-bryan');
  });

  it('is the SAME identity the code path would have minted', async () => {
    // No code involved on the Access side; the ids still have to agree, or
    // the same person is two people depending on which door they came in.
    const jwt = await sign({ email: 'both-doors@example.com' });
    await commentAs(jwt, 'both-doors-doc');
    const start = await fetch(`${base}/api/auth/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': jwt },
      body: JSON.stringify({ email: 'both-doors@example.com' }),
    });
    expect(start.status).toBe(200);
    expect(actorIds()).toContain(emailIdentityId('both-doors@example.com'));
  });

  it('falls back rather than inventing an identity when the claim is missing', async () => {
    // Access can be configured with a service token or a policy that emits no
    // email. That must not become an unattributed write, and it must not
    // become somebody: this is the legacy whole-server mode, where there is
    // no share visitor, so the body is the fallback — today's behaviour
    // exactly. (On a share or collab host the same absence leaves the visitor
    // a `guest-`; see collab-host.test.ts for that surface.)
    await commentAs(await sign({}), 'no-email-doc');
    expect(actorIds()).toContain('known-bryan');
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
