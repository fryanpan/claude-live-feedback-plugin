/**
 * The Recall callback exemptions, over a REAL server — the route layer is the
 * part nothing type-checks, and the predicate alone cannot say whether it was
 * wired into the right branch.
 *
 * The setup is prod's: an operator hostname on `CW_PROXIED_TRUSTED_HOSTS`
 * with a Cloudflare Access application in front of it, reached through the
 * edge (`cf-ray`). That classifies `proxied-local`, which demands a verified
 * Access token before ANY route runs. Recall.ai's backend cannot present one,
 * so its two callbacks are exempted — each only while the credential it
 * carries is configured.
 *
 * Reading the assertions: the GATE's refusal is `401 {"error":"missing_jwt"}`
 * and it happens before routing. Anything else — `404 unknown endpoint`,
 * `401 bad signature` — is the SERVER'S OWN answer, which means the request
 * got past the gate. That difference is what every test here turns on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type JSONWebKeySet, type JWK, SignJWT, exportJWK, generateKeyPair } from 'jose';
import type { RecallClient } from '../src/recall.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const TEAM_DOMAIN = 'test.cloudflareaccess.com';
const KID = 'recall-gate-kid';
const OPERATOR_AUD = 'aud-for-the-operator-app';
/** The operator's public hostname — where Recall dials in. */
const PROXIED_HOST = 'ops.example.com';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const OPERATOR_EMAIL = 'operator@example.com';
/** A literal this test invents — no real credential appears here. */
const WEBHOOK_SECRET = 'whsec_thisisatestsigningsecretvalue';
/** Shaped exactly as `RecallMeetingRelay.mintToken` produces one. */
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/**
 * A client that is CONFIGURED and does nothing else. `configured()` is
 * `client !== null && client.config.publicWsBase !== null`, and no test here
 * invites a bot, so the methods exist only to satisfy the interface. A real
 * one would bill the vendor per meeting-hour.
 */
const configuredClient = (): RecallClient =>
  ({
    config: {
      region: 'us-east-1',
      publicWsBase: 'wss://ops.example.com',
      retentionHours: 24,
      separateStreams: true,
      botName: 'Meeting Assistant',
    },
    createBot: async () => {
      throw new Error('no bot is invited in this suite');
    },
    getBot: async () => {
      throw new Error('no bot is invited in this suite');
    },
    leaveCall: async () => {},
    requestRecordingPermission: async () => false,
  }) as unknown as RecallClient;

let jwks: JSONWebKeySet;
let operatorJwt: string;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = (await exportJWK(publicKey)) as JWK;
  publicJwk.kid = KID;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  jwks = { keys: [publicJwk] };
  operatorJwt = await new SignJWT({ email: OPERATOR_EMAIL })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(`https://${TEAM_DOMAIN}`)
    .setAudience(OPERATOR_AUD)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
    .setSubject('cf-access-operator-1')
    .sign(privateKey);
});

const dirs: string[] = [];
const handles: ServerHandle[] = [];
/** A server on the operator hostname, varying only in Recall's two credentials. */
const spinUp = (recall: { relay: boolean; secret: boolean }): ServerHandle => {
  const dataDir = mkdtempSync(join(tmpdir(), 'recall-gate-'));
  dirs.push(dataDir);
  const h = createServer({
    port: 0,
    dataDir,
    cfAccess: { teamDomain: TEAM_DOMAIN, audience: OPERATOR_AUD, jwks },
    proxiedTrustedHosts: [PROXIED_HOST],
    proxiedTrustedEmails: [OPERATOR_EMAIL],
    ...(recall.relay ? { meetingBot: configuredClient() } : {}),
    ...(recall.secret ? { meetingBotWebhookSecret: WEBHOOK_SECRET } : {}),
  });
  handles.push(h);
  return h;
};
afterAll(async () => {
  for (const h of handles) await h.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Through the edge, on the operator hostname, with no Access token. */
const untokened = (h: ServerHandle, path: string, method = 'GET', body?: string) =>
  fetch(`http://localhost:${h.port}${path}`, {
    method,
    headers: {
      host: PROXIED_HOST,
      ...CF_RAY,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body } : {}),
  });

/**
 * The same request, written onto the socket by hand.
 *
 * `fetch` COLLAPSES a doubled leading slash before it ever leaves the client
 * (measured: `fetch('http://h//recall/x')` arrives as `/recall/x`), so it
 * cannot express the request this exists to test. A real caller can send
 * `GET //api/recall/status` verbatim, and Bun hands that path through
 * unchanged — which is exactly the shape a prefix-ish match would wave past.
 *
 * Returns the status line's code and the body, parsed the same way the other
 * assertions read them.
 */
const rawRequest = (
  h: ServerHandle,
  path: string,
  method: string,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    let buf = '';
    Bun.connect({
      hostname: '127.0.0.1',
      port: h.port,
      socket: {
        open(sock) {
          sock.write(
            `${method} ${path} HTTP/1.1\r\nHost: ${PROXIED_HOST}\r\n` +
              `cf-ray: ${CF_RAY['cf-ray']}\r\nContent-Length: 0\r\n` +
              'Connection: close\r\n\r\n',
          );
        },
        data(_sock, chunk) {
          buf += new TextDecoder().decode(chunk);
        },
        close() {
          const status = Number(buf.split(' ')[1] ?? 0);
          resolve({ status, body: buf.split('\r\n\r\n').slice(1).join('\r\n\r\n') });
        },
        error: reject,
      },
    }).catch(reject);
  });

describe('both credentials configured — Recall gets in, and only Recall', () => {
  let h: ServerHandle;
  beforeAll(() => {
    h = spinUp({ relay: true, secret: true });
  });

  it('lets the websocket upgrade past the gate to the route that owns the token', async () => {
    // 404 `unknown endpoint` is the ROUTE's answer to a token no bot minted —
    // reaching it is the whole point. The gate would have said 401
    // missing_jwt and the route would never have run.
    const r = await untokened(h, `/recall/${TOKEN}`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'unknown endpoint' });
  });

  it('lets the status webhook past the gate to the signature check', async () => {
    // 401 `bad signature` is the ROUTE's answer to an unsigned body — the
    // credential doing the work, one layer in from the gate.
    const r = await untokened(
      h,
      '/api/recall/status',
      'POST',
      JSON.stringify({ event: 'bot.done' }),
    );
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'bad signature' });
  });

  it('POSITIVE CONTROL: an unrelated route on the same host is still refused', async () => {
    // If this ever answers anything but the gate's 401, the exemption has
    // stopped being an exemption and every test above means nothing.
    for (const path of ['/api/docs', '/api/share', '/']) {
      const r = await untokened(h, path);
      expect(r.status, path).toBe(401);
      expect(await r.json(), path).toEqual({ error: 'missing_jwt' });
    }
    const deploy = await untokened(h, '/api/deploy', 'POST');
    expect(deploy.status).toBe(401);
  });

  it('POSITIVE CONTROL: the operator with a token still reaches the product', async () => {
    const r = await fetch(`http://localhost:${h.port}/api/docs`, {
      headers: { host: PROXIED_HOST, ...CF_RAY, 'cf-access-jwt-assertion': operatorJwt },
    });
    expect(r.status).toBe(200);
  });

  it('refuses every near-miss of the two exempt requests', async () => {
    const cases: Array<[string, string]> = [
      // A token of the wrong shape, or anything around it.
      ['/recall/abc', 'GET'],
      [`/recall/${TOKEN}/x`, 'GET'],
      [`/recall/${TOKEN}/`, 'GET'],
      ['/recall/', 'GET'],
      // The route DECODES before looking a token up; the gate does not.
      [`/recall/%61${TOKEN.slice(1)}`, 'GET'],
      // Method mismatch on both paths.
      [`/recall/${TOKEN}`, 'POST'],
      ['/api/recall/status', 'GET'],
      // Near-misses of the status path.
      ['/api/recall/status/', 'POST'],
      ['/api/recall/statuses', 'POST'],
    ];
    for (const [path, method] of cases) {
      const r = await untokened(h, path, method, method === 'POST' ? '{}' : undefined);
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(await r.json(), `${method} ${path}`).toEqual({ error: 'missing_jwt' });
    }
  });

  it('refuses a doubled leading slash, which only a raw request can send', async () => {
    // `fetch` normalises this away; a real caller need not. Both spellings
    // must meet the gate exactly as any other unexempt path does.
    for (const [path, method] of [
      [`//recall/${TOKEN}`, 'GET'],
      ['//api/recall/status', 'POST'],
    ] as Array<[string, string]>) {
      const r = await rawRequest(h, path, method);
      expect(r.status, `${method} ${path}`).toBe(401);
      expect(r.body, `${method} ${path}`).toContain('missing_jwt');
    }
  });

  it('POSITIVE CONTROL: the raw-socket helper can reach an exempt path', async () => {
    // Without this, the test above passes just as well against a helper that
    // sends a malformed request every server would refuse. The single-slash
    // spelling of the same path must get past the gate to the route's 404.
    const r = await rawRequest(h, `/recall/${TOKEN}`, 'GET');
    expect(r.status).toBe(404);
    expect(r.body).toContain('unknown endpoint');
  });

  it('refuses the callbacks from a host that is not the operator hostname', async () => {
    // The exemption lives inside the `proxied-local` branch. An unlisted
    // proxied host never gets that far — it is denied by hostname.
    for (const path of [`/recall/${TOKEN}`, '/api/recall/status']) {
      const r = await fetch(`http://localhost:${h.port}${path}`, {
        method: path.endsWith('status') ? 'POST' : 'GET',
        headers: { host: 'unlisted.example.com', ...CF_RAY },
      });
      expect(r.status, path).toBe(403);
      expect(await r.json(), path).toEqual({ error: 'unknown_host' });
    }
  });
});

describe('the credential conditions, over HTTP', () => {
  it('gates the websocket when the relay is NOT configured', async () => {
    // No key and no public wss base: nothing on this server can have minted
    // a token, so there is no credential behind an exemption.
    const h = spinUp({ relay: false, secret: true });
    const r = await untokened(h, `/recall/${TOKEN}`);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'missing_jwt' });
    // …while the webhook, whose own credential IS configured, still passes.
    const hook = await untokened(h, '/api/recall/status', 'POST', '{}');
    expect(hook.status).toBe(401);
    expect(await hook.json()).toEqual({ error: 'bad signature' });
  });

  it('gates the status webhook when no signing secret is set', async () => {
    // Unset, the route accepts UNSIGNED bodies. Exempting it here would put
    // that mode on the public internet with nothing in front of it.
    const h = spinUp({ relay: true, secret: false });
    const r = await untokened(
      h,
      '/api/recall/status',
      'POST',
      JSON.stringify({ event: 'bot.done' }),
    );
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'missing_jwt' });
    // …while the websocket, whose own credential IS configured, still passes.
    const ws = await untokened(h, `/recall/${TOKEN}`);
    expect(ws.status).toBe(404);
    expect(await ws.json()).toEqual({ error: 'unknown endpoint' });
  });

  it('gates both when neither credential is configured', async () => {
    const h = spinUp({ relay: false, secret: false });
    const ws = await untokened(h, `/recall/${TOKEN}`);
    expect(ws.status).toBe(401);
    expect(await ws.json()).toEqual({ error: 'missing_jwt' });
    const hook = await untokened(h, '/api/recall/status', 'POST', '{}');
    expect(hook.status).toBe(401);
    expect(await hook.json()).toEqual({ error: 'missing_jwt' });
  });
});
