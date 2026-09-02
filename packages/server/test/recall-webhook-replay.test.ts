/**
 * A captured Recall webhook cannot be played back.
 *
 * The Svix signature covers `${id}.${timestamp}.${body}` and the verifier
 * refuses a timestamp more than five minutes off — so a captured request was
 * replayable for up to ten minutes, and every replay re-ran the status
 * handler (Urgent-fixes ticket, 2026-09-02). The `webhook-id` is unique per
 * delivery, so a second arrival of the same id inside the tolerance window
 * is by definition not a delivery: the route now drops it.
 *
 * Two layers, tested separately: the seen-set itself (TTL, bound, and that a
 * bound is a bound), and the route, where the same signed payload is sent
 * twice through the callback hostname and only the first is accepted.
 *
 * The signing secret here is invented — base64 of a fixture string — and
 * signs a fixture body. No real credential appears.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebhookReplayGuard } from '../src/recall-webhook-auth.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

describe('WebhookReplayGuard', () => {
  it('admits an id once, then refuses it for the window', () => {
    const g = new WebhookReplayGuard({ ttlSec: 600, maxEntries: 100 });
    expect(g.admit('msg_a', 1_000)).toBe(true);
    expect(g.admit('msg_a', 1_001)).toBe(false);
    expect(g.admit('msg_a', 1_599)).toBe(false);
    // A different id is a different delivery.
    expect(g.admit('msg_b', 1_001)).toBe(true);
  });

  it('forgets an id once the window has passed', () => {
    // Past the window the signature check refuses the timestamp anyway, so
    // remembering longer buys nothing and costs memory.
    const g = new WebhookReplayGuard({ ttlSec: 600, maxEntries: 100 });
    expect(g.admit('msg_a', 1_000)).toBe(true);
    expect(g.admit('msg_a', 1_601)).toBe(true);
  });

  it('is bounded: the oldest entry is evicted, never the newest', () => {
    const g = new WebhookReplayGuard({ ttlSec: 600, maxEntries: 3 });
    expect(g.admit('one', 1_000)).toBe(true);
    expect(g.admit('two', 1_001)).toBe(true);
    expect(g.admit('three', 1_002)).toBe(true);
    expect(g.admit('four', 1_003)).toBe(true); // evicts `one`
    expect(g.size).toBe(3);
    expect(g.admit('four', 1_004)).toBe(false); // still remembered
    expect(g.admit('two', 1_004)).toBe(false); // still remembered
    expect(g.admit('one', 1_004)).toBe(true); // forgotten — the bound is a bound
  });
});

describe('POST /recall/status replay', () => {
  const TEAM_DOMAIN = 'test.cloudflareaccess.com';
  const OPERATOR_AUD = 'aud-for-the-operator-app';
  const PROXIED_HOST = 'ops.example.com';
  const CALLBACK_HOST = 'recall.example.com';
  const CF_RAY = { 'cf-ray': '8a1b2c3d4e5f-SJC' };
  const WEBHOOK_SECRET = `whsec_${btoa('claude-workspaces-replay-test')}`;

  let h: ServerHandle;
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'recall-replay-'));
    h = createServer({
      port: 0,
      dataDir,
      // An Access config is required for the callback host to be honoured
      // (the callback gate refuses on a server that is not Access-fronted);
      // the jwks is never consulted because no request here carries a token.
      cfAccess: { teamDomain: TEAM_DOMAIN, audience: OPERATOR_AUD, jwks: { keys: [] } },
      proxiedTrustedHosts: [PROXIED_HOST],
      proxiedTrustedEmails: ['operator@example.com'],
      recallCallbackHost: CALLBACK_HOST,
      meetingBotWebhookSecret: WEBHOOK_SECRET,
    });
  });

  afterAll(async () => {
    await h.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Svix headers for a body, signed the way Recall's backend signs one. */
  const signBody = async (body: string, id: string): Promise<Record<string, string>> => {
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
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${btoa(String.fromCharCode(...mac))}`,
    };
  };

  const deliver = (body: string, headers: Record<string, string>) =>
    fetch(`http://localhost:${h.port}/recall/status`, {
      method: 'POST',
      headers: { host: CALLBACK_HOST, ...CF_RAY, 'content-type': 'application/json', ...headers },
      body,
    });

  const BODY = JSON.stringify({
    event: 'bot.done',
    data: { bot: { id: 'bot_fixture_1' }, data: { code: 'done' } },
  });

  it('accepts a signed delivery once and rejects the identical replay', async () => {
    const headers = await signBody(BODY, 'msg_replay_0001');
    const first = await deliver(BODY, headers);
    expect(first.status).toBe(200);
    // Byte-for-byte the same request: same id, same timestamp, same
    // signature — exactly what a captured request looks like when replayed
    // inside the tolerance window.
    const second = await deliver(BODY, headers);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toMatch(/replay/i);
  });

  it('positive control: a fresh id for the same body is a new delivery', async () => {
    const r = await deliver(BODY, await signBody(BODY, 'msg_replay_0002'));
    expect(r.status).toBe(200);
  });

  it('an unsigned repeat is still refused as unsigned, not as a replay', async () => {
    // The replay check sits BEHIND the signature: an attacker who cannot
    // sign must not be able to learn which ids the server has seen.
    const headers = await signBody(BODY, 'msg_replay_0003');
    expect((await deliver(BODY, headers)).status).toBe(200);
    const forged = { ...headers, 'webhook-signature': 'v1,bm90LWEtcmVhbC1zaWduYXR1cmU=' };
    const r = await deliver(BODY, forged);
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: string }).error).toBe('bad signature');
  });
});
