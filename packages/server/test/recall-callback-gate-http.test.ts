/**
 * The TWO HOSTNAMES, over a real server — the route layer is the part nothing
 * type-checks, and the predicate alone cannot say whether it was wired into
 * the right branch.
 *
 * The decision this pins (Bryan, 2026-08-31). Recall.ai's backend needs a
 * public address to dial back on. It used to get the OPERATOR's address —
 * `CW_PROXIED_TRUSTED_HOSTS`, the name a person opens the product on — with
 * its two callbacks exempted from Cloudflare Access, because that was the
 * only public name this deployment had. The bot surface now has a hostname of
 * its own (`CW_RECALL_CALLBACK_HOST`), and the operator hostname went back to
 * zero exemptions. So there are exactly two claims to prove, and each is
 * worthless without the other:
 *
 *   1. On the CALLBACK hostname, the two `/recall/*` routes reach the code
 *      that owns their credentials, and everything else — the API, the app,
 *      a real doc's websocket, the deploy verb — is 404.
 *   2. On the OPERATOR hostname, those same two requests are refused by the
 *      Access gate like any other. This is the regression that would
 *      otherwise be invisible: leaving the old exemption in place breaks
 *      nothing and shows up in no test that only checks the new host works.
 *
 * Reading the assertions: the Access gate's refusal is
 * `401 {"error":"missing_jwt"}` and it happens before routing; the callback
 * host's refusal is `404 {"error":"not_found"}` from the same place. Anything
 * else — `404 unknown endpoint`, `401 bad signature`, `200 ok` — is the
 * SERVER'S OWN answer, which means the request got past the host gate. That
 * difference is what every test here turns on.
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
/** Where a PERSON opens the product. Access-gated, and now hole-free. */
const PROXIED_HOST = 'ops.example.com';
/** Where RECALL dials in. No Access application in front of it. */
const CALLBACK_HOST = 'recall.example.com';
const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
const OPERATOR_EMAIL = 'operator@example.com';
/**
 * A literal this test invents — no real credential appears here. Base64 after
 * the `whsec_` prefix, because that is the format Svix's verifier decodes and
 * one test below actually signs a body with it.
 */
const WEBHOOK_SECRET = `whsec_${btoa('claude-workspaces-recall-gate-test')}`;

/** Svix headers for a body, signed the way Recall's backend signs one. */
const signBody = async (body: string): Promise<Record<string, string>> => {
  const id = 'msg_test_0001';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const raw = WEBHOOK_SECRET.slice('whsec_'.length);
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)) as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  );
  return {
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${btoa(String.fromCharCode(...mac))}`,
  };
};
/** Shaped exactly as `RecallMeetingRelay.mintToken` produces one. */
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/**
 * A client that is CONFIGURED and does nothing else. `configured()` is
 * `client !== null && client.config.publicWsBase !== null`, and no test here
 * invites a bot, so the methods exist only to satisfy the interface. A real
 * one would bill the vendor per meeting-hour.
 */
const configuredClient = (wsBase = `wss://${CALLBACK_HOST}`): RecallClient =>
  ({
    config: {
      region: 'us-east-1',
      publicWsBase: wsBase,
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
/**
 * Prod's shape: BOTH hostnames on one process — the operator's, Access-gated,
 * and the callback host beside it — varying only in Recall's two credentials.
 */
const spinUp = (recall: { relay: boolean; secret: boolean }): ServerHandle => {
  const dataDir = mkdtempSync(join(tmpdir(), 'recall-gate-'));
  dirs.push(dataDir);
  const h = createServer({
    port: 0,
    dataDir,
    cfAccess: { teamDomain: TEAM_DOMAIN, audience: OPERATOR_AUD, jwks },
    proxiedTrustedHosts: [PROXIED_HOST],
    proxiedTrustedEmails: [OPERATOR_EMAIL],
    recallCallbackHost: CALLBACK_HOST,
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

/** A request on a given hostname, through the edge, with no Access token. */
const on = (h: ServerHandle, host: string, path: string, method = 'GET', body?: string) =>
  fetch(`http://localhost:${h.port}${path}`, {
    method,
    headers: {
      host,
      ...CF_RAY,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body } : {}),
  });

/** …on the callback hostname, which is where Recall's requests arrive. */
const callback = (h: ServerHandle, path: string, method = 'GET', body?: string) =>
  on(h, CALLBACK_HOST, path, method, body);

/**
 * The same request, written onto the socket by hand.
 *
 * `fetch` COLLAPSES a doubled leading slash before it ever leaves the client
 * (measured: `fetch('http://h//recall/x')` arrives as `/recall/x`), so it
 * cannot express the request this exists to test. A real caller can send
 * `POST //recall/status` verbatim, and Bun hands that path through unchanged
 * — which is exactly the shape a prefix-ish match would wave past.
 *
 * Returns the status line's code and the body, parsed the same way the other
 * assertions read them.
 */
const rawRequest = (
  h: ServerHandle,
  host: string,
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
            `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\n` +
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

describe('the callback hostname serves Recall, and only Recall', () => {
  let h: ServerHandle;
  beforeAll(() => {
    h = spinUp({ relay: true, secret: true });
  });

  it('lets the websocket upgrade through to the route that owns the token', async () => {
    // 404 `unknown endpoint` is the ROUTE's answer to a token no bot minted —
    // reaching it is the whole point. The host gate would have said 404
    // `not_found` and the route would never have run.
    const r = await callback(h, `/recall/${TOKEN}`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'unknown endpoint' });
  });

  it('lets the status webhook through to the signature check', async () => {
    // 401 `bad signature` is the ROUTE's answer to an unsigned body — the
    // credential doing the work, one layer in from the host gate.
    const r = await callback(h, '/recall/status', 'POST', JSON.stringify({ event: 'bot.done' }));
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'bad signature' });
  });

  it('END TO END: a correctly signed webhook is accepted at the new path', async () => {
    // The only test in this file where the whole chain answers YES — host
    // class, allowlist, route, signature. Without it every other "got past
    // the gate" assertion lands on a refusal, and a server that refused this
    // request for some fourth reason would look identical.
    const body = JSON.stringify({
      event: 'bot.done',
      data: { bot: { id: 'bot_test_1' }, data: { code: 'done' } },
    });
    const r = await fetch(`http://localhost:${h.port}/recall/status`, {
      method: 'POST',
      headers: {
        host: CALLBACK_HOST,
        ...CF_RAY,
        'content-type': 'application/json',
        ...(await signBody(body)),
      },
      body,
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('the same signed webhook is NOT accepted at the path it moved from', async () => {
    // The move is real, not additive: `/api/recall/status` is gone, and a
    // second unauthenticated spelling of the webhook is what consolidating
    // under one prefix exists to prevent.
    const body = JSON.stringify({
      event: 'bot.done',
      data: { bot: { id: 'bot_test_1' }, data: { code: 'done' } },
    });
    const r = await fetch(`http://localhost:${h.port}/api/recall/status`, {
      method: 'POST',
      headers: {
        host: CALLBACK_HOST,
        ...CF_RAY,
        'content-type': 'application/json',
        ...(await signBody(body)),
      },
      body,
    });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not_found' });
  });

  it('POSITIVE CONTROL: the whole product is 404 on this hostname', async () => {
    // If any of these ever answers something else, the callback host has
    // stopped being two routes and every test above means nothing.
    for (const path of ['/api/docs', '/api/share', '/', '/app', '/y/some-doc', '/widget.js']) {
      const r = await callback(h, path);
      expect(r.status, path).toBe(404);
      expect(await r.json(), path).toEqual({ error: 'not_found' });
    }
    const deploy = await callback(h, '/api/deploy', 'POST');
    expect(deploy.status).toBe(404);
    expect(await deploy.json()).toEqual({ error: 'not_found' });
  });

  it('is 404 even for a caller holding a valid operator Access token', async () => {
    // The token is not what this hostname refuses on. A person who really is
    // the operator still cannot reach the product here — the surface is a
    // property of the NAME, not of who is asking.
    const r = await fetch(`http://localhost:${h.port}/api/docs`, {
      headers: { host: CALLBACK_HOST, ...CF_RAY, 'cf-access-jwt-assertion': operatorJwt },
    });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not_found' });
  });

  it('serves the callbacks with no cf-ray at all', async () => {
    // Unlike every other external host class, this one does NOT require the
    // request to have come through Cloudflare: Recall authenticates with the
    // credentials the routes check, and a `viaProxy` requirement would break
    // any deployment fronted by something that is not Cloudflare.
    const r = await fetch(`http://localhost:${h.port}/recall/${TOKEN}`, {
      headers: { host: CALLBACK_HOST },
    });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'unknown endpoint' });
  });

  it('refuses every near-miss of the two routes', async () => {
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
      ['/recall/status', 'GET'],
      // Near-misses of the status path, including the path it MOVED FROM.
      ['/api/recall/status', 'POST'],
      ['/recall/status/', 'POST'],
      ['/recall/statuses', 'POST'],
    ];
    for (const [path, method] of cases) {
      const r = await callback(h, path, method, method === 'POST' ? '{}' : undefined);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(await r.json(), `${method} ${path}`).toEqual({ error: 'not_found' });
    }
  });

  it('refuses a doubled leading slash, which only a raw request can send', async () => {
    // `fetch` normalises this away; a real caller need not. Both spellings
    // must meet the host gate exactly as any other unlisted path does.
    for (const [path, method] of [
      [`//recall/${TOKEN}`, 'GET'],
      ['//recall/status', 'POST'],
    ] as Array<[string, string]>) {
      const r = await rawRequest(h, CALLBACK_HOST, path, method);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.body, `${method} ${path}`).toContain('not_found');
    }
  });

  it('POSITIVE CONTROL: the raw-socket helper can reach an admitted path', async () => {
    // Without this, the test above passes just as well against a helper that
    // sends a malformed request every server would refuse. The single-slash
    // spelling of the same path must reach the route's own 404.
    const r = await rawRequest(h, CALLBACK_HOST, `/recall/${TOKEN}`, 'GET');
    expect(r.status).toBe(404);
    expect(r.body).toContain('unknown endpoint');
  });

  it('a hostname that is neither the callback host nor the operator is denied', async () => {
    // Default-deny is unchanged: the new class admits ONE configured name,
    // and no suffix of it.
    for (const host of ['unlisted.example.com', `${CALLBACK_HOST}.attacker.com`]) {
      const r = await on(h, host, `/recall/${TOKEN}`);
      expect(r.status, host).toBe(403);
      expect(await r.json(), host).toEqual({ error: 'unknown_host' });
    }
  });
});

describe('the operator hostname has NO exemptions left', () => {
  let h: ServerHandle;
  beforeAll(() => {
    h = spinUp({ relay: true, secret: true });
  });

  it('gates both bot callbacks behind Access, exactly like every other path', async () => {
    // THE REGRESSION TEST for the removal. Both credentials are configured —
    // the condition the old exemption ran on — so if the `recallCallbackExempt`
    // wiring is ever restored in the `proxied-local` branch, these two answer
    // the route (404 unknown endpoint / 401 bad signature) instead of the gate.
    const ws = await on(h, PROXIED_HOST, `/recall/${TOKEN}`);
    expect(ws.status).toBe(401);
    expect(await ws.json()).toEqual({ error: 'missing_jwt' });

    const hook = await on(h, PROXIED_HOST, '/recall/status', 'POST', '{}');
    expect(hook.status).toBe(401);
    expect(await hook.json()).toEqual({ error: 'missing_jwt' });

    // …and the path the webhook used to live on, in case anything kept it.
    const old = await on(h, PROXIED_HOST, '/api/recall/status', 'POST', '{}');
    expect(old.status).toBe(401);
    expect(await old.json()).toEqual({ error: 'missing_jwt' });
  });

  it('POSITIVE CONTROL: the operator with a token still reaches the product', async () => {
    // Without this, the assertions above are satisfied by a server that
    // refuses everything on this hostname for some unrelated reason.
    const r = await fetch(`http://localhost:${h.port}/api/docs`, {
      headers: { host: PROXIED_HOST, ...CF_RAY, 'cf-access-jwt-assertion': operatorJwt },
    });
    expect(r.status).toBe(200);
  });

  it('POSITIVE CONTROL: an untokened ordinary path is refused the same way', async () => {
    // Proves `missing_jwt` above is the gate's ordinary refusal and not
    // something specific to the recall paths.
    const r = await on(h, PROXIED_HOST, '/api/docs');
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'missing_jwt' });
  });
});

describe('the credential conditions, over HTTP', () => {
  it('closes the websocket route when the relay is NOT configured', async () => {
    // No key and no public wss base: nothing on this server can have minted a
    // token, so there is no credential behind the route.
    const h = spinUp({ relay: false, secret: true });
    const r = await callback(h, `/recall/${TOKEN}`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not_found' });
    // …while the webhook, whose own credential IS configured, still passes.
    const hook = await callback(h, '/recall/status', 'POST', '{}');
    expect(hook.status).toBe(401);
    expect(await hook.json()).toEqual({ error: 'bad signature' });
  });

  it('closes the status webhook when no signing secret is set', async () => {
    // Unset, the route accepts UNSIGNED bodies. Leaving it open here would
    // put that mode on the public internet with nothing in front of it.
    const h = spinUp({ relay: true, secret: false });
    const r = await callback(h, '/recall/status', 'POST', JSON.stringify({ event: 'bot.done' }));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not_found' });
    // …while the websocket, whose own credential IS configured, still passes.
    const ws = await callback(h, `/recall/${TOKEN}`);
    expect(ws.status).toBe(404);
    expect(await ws.json()).toEqual({ error: 'unknown endpoint' });
  });

  it('closes both when neither credential is configured', async () => {
    const h = spinUp({ relay: false, secret: false });
    const ws = await callback(h, `/recall/${TOKEN}`);
    expect(ws.status).toBe(404);
    expect(await ws.json()).toEqual({ error: 'not_found' });
    const hook = await callback(h, '/recall/status', 'POST', '{}');
    expect(hook.status).toBe(404);
    expect(await hook.json()).toEqual({ error: 'not_found' });
  });
});

describe('with no callback hostname configured, the class does not exist', () => {
  it('denies the hostname outright — it is not a fallback to anything', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'recall-gate-'));
    dirs.push(dataDir);
    const h = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OPERATOR_AUD, jwks },
      proxiedTrustedHosts: [PROXIED_HOST],
      proxiedTrustedEmails: [OPERATOR_EMAIL],
      meetingBot: configuredClient(),
      meetingBotWebhookSecret: WEBHOOK_SECRET,
    });
    handles.push(h);
    const r = await on(h, CALLBACK_HOST, `/recall/${TOKEN}`);
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'unknown_host' });
  });
});

describe('a bot that could not call back is not offered at all', () => {
  /**
   * The other half of removing the exemptions, and the one that costs money
   * if it is missed. A deployment with a Recall key and a `CW_PUBLIC_BASE_URL`
   * naming its Access-gated operator hostname still looks configured: the
   * invite renders, a bot is created, it joins the call and bills per
   * meeting-hour — and every callback it makes is refused before any route
   * runs. `configured` is what the doc's strip reads to decide whether to
   * offer the button, so it has to be the thing that goes false.
   */
  const meetingBotState = async (h: ServerHandle) => {
    // Asked as the OPERATOR, with a token, on the operator's hostname: this
    // is the product's own UI reading the doc strip, not a callback. (Not
    // over loopback — with `cfAccess` configured and no shares wired, this
    // server is in legacy whole-server mode, where even localhost presents a
    // token.)
    const r = await fetch(`http://localhost:${h.port}/api/docs/any-doc/meeting-bot`, {
      headers: { host: PROXIED_HOST, ...CF_RAY, 'cf-access-jwt-assertion': operatorJwt },
    });
    expect(r.status).toBe(200);
    return (await r.json()) as { configured: boolean };
  };

  const spinUpDialing = (wsBase: string, callbackHost: string | null): ServerHandle => {
    const dataDir = mkdtempSync(join(tmpdir(), 'recall-reach-'));
    dirs.push(dataDir);
    const h = createServer({
      port: 0,
      dataDir,
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OPERATOR_AUD, jwks },
      proxiedTrustedHosts: [PROXIED_HOST],
      proxiedTrustedEmails: [OPERATOR_EMAIL],
      ...(callbackHost ? { recallCallbackHost: callbackHost } : {}),
      meetingBot: configuredClient(wsBase),
      meetingBotWebhookSecret: WEBHOOK_SECRET,
    });
    handles.push(h);
    return h;
  };

  it('reports NOT configured when the callback URL is the Access-gated host', async () => {
    const h = spinUpDialing(`wss://${PROXIED_HOST}`, null);
    expect((await meetingBotState(h)).configured).toBe(false);
  });

  it('POSITIVE CONTROL: the same server with a callback host is configured', async () => {
    // Without this, the assertion above is satisfied by a server that reports
    // `configured: false` for some entirely unrelated reason.
    const h = spinUpDialing(`wss://${CALLBACK_HOST}`, CALLBACK_HOST);
    expect((await meetingBotState(h)).configured).toBe(true);
  });

  it('POSITIVE CONTROL: a public hostname this server does not gate still works', async () => {
    // The fallback the change had to preserve: no dedicated callback host,
    // and a public base URL that is not Access-fronted, behaves as before.
    const h = spinUpDialing('wss://open.example.com', null);
    expect((await meetingBotState(h)).configured).toBe(true);
  });

  it('the websocket route stays armed by the SAME answer, not a second one', async () => {
    // `configured()` is what arms `/recall/<token>`, and it is the flag this
    // reason disarms — so "the invite is not offered" and "the socket is
    // closed" cannot drift apart. Asserted on the reachable server, because
    // an unreachable one has no callback hostname configured (the two states
    // that would produce it are contradictory: the ws origin is DERIVED from
    // the callback host) and its hostname is refused a step earlier.
    const h = spinUpDialing(`wss://${CALLBACK_HOST}`, CALLBACK_HOST);
    const r = await on(h, CALLBACK_HOST, `/recall/${TOKEN}`);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'unknown endpoint' });
  });
});
