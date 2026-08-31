/**
 * Bot status codes → the state a person reads, and the signature that proves
 * a webhook is really Recall's.
 *
 * Payloads shaped as docs.recall.ai/docs/bot-status-change-events and
 * /docs/authenticating-requests-from-recallai document them. The signing
 * secret here is a literal this test invents; no real credential appears.
 */
import { describe, expect, it } from 'bun:test';
import { botStateFromCode, latestBotState, parseBotStatusWebhook } from '../src/recall-status.ts';
import { svixHeadersFrom, verifySvixSignature } from '../src/recall-webhook-auth.ts';

const statusBody = (code: string, subCode?: string): unknown => ({
  event: `bot.${code}`,
  data: {
    data: { code, sub_code: subCode ?? null, updated_at: '2026-08-30T12:00:00Z' },
    bot: { id: 'bot_abc', metadata: {} },
  },
});

describe('status codes', () => {
  it('reads both vocabularies as the same fact', () => {
    // The webhook says `bot.in_call_recording`; GET /bot says
    // `in_call_recording`. A mapping that knew only one would drift the
    // moment the other door is used.
    expect(botStateFromCode('bot.in_call_recording')).toBe('recording');
    expect(botStateFromCode('in_call_recording')).toBe('recording');
  });

  it('maps the states a person can act on', () => {
    expect(botStateFromCode('joining_call')).toBe('joining');
    expect(botStateFromCode('in_waiting_room')).toBe('waiting_room');
    expect(botStateFromCode('in_call_not_recording')).toBe('in_call');
    expect(botStateFromCode('recording_permission_denied')).toBe('permission_denied');
    expect(botStateFromCode('call_ended')).toBe('left');
    expect(botStateFromCode('done')).toBe('left');
    expect(botStateFromCode('fatal')).toBe('failed');
  });

  it('returns null for a code it does not model', () => {
    // A vendor adding a code must not be able to move a bot into a state this
    // product does not have — and must not end a meeting that is running.
    expect(botStateFromCode('bot.some_future_thing')).toBeNull();
  });

  it('parses a status webhook, preferring the inner code that carries sub_code', () => {
    expect(
      parseBotStatusWebhook(statusBody('recording_permission_denied', 'denied_by_host')),
    ).toEqual({
      botId: 'bot_abc',
      state: 'permission_denied',
      detail: 'denied_by_host',
      at: Date.parse('2026-08-30T12:00:00Z'),
    });
  });

  it('carries the vendor timestamp, and omits it when there is none to read', () => {
    // The only ordering the two ends agree on: webhook delivery is retried
    // and unordered, so the relay drops a status change older than the one it
    // has already applied. An unreadable timestamp must be ABSENT rather than
    // NaN or zero — zero would make every later event look newer, which is
    // the bug the field exists to prevent, in reverse.
    const noStamp = {
      event: 'bot.done',
      data: { data: { code: 'done', updated_at: 'yesterday-ish' }, bot: { id: 'bot_abc' } },
    };
    expect(parseBotStatusWebhook(noStamp)).toEqual({ botId: 'bot_abc', state: 'left' });
  });

  it('refuses a webhook with no bot id', () => {
    expect(
      parseBotStatusWebhook({ event: 'bot.done', data: { data: { code: 'done' } } }),
    ).toBeNull();
    expect(parseBotStatusWebhook(null)).toBeNull();
    expect(parseBotStatusWebhook('done')).toBeNull();
  });

  it('takes the last RECOGNISED status change, not simply the last', () => {
    const state = latestBotState([
      { code: 'joining_call' },
      { code: 'in_call_recording' },
      { code: 'some_future_thing' },
    ]);
    expect(state).toEqual({ state: 'recording' });
  });
});

describe('webhook signatures', () => {
  // A base64 secret this test invents, in the `whsec_` shape Recall uses.
  const secret = `whsec_${btoa('a-test-signing-secret-not-a-real-one')}`;
  const body = JSON.stringify(statusBody('in_call_recording'));
  const id = 'msg_test_1';

  async function sign(payload: string, timestamp: string): Promise<string> {
    const raw = secret.slice('whsec_'.length);
    const keyBytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      'raw',
      keyBytes as unknown as ArrayBuffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`${id}.${timestamp}.${payload}`),
      ),
    );
    return `v1,${btoa(String.fromCharCode(...mac))}`;
  }

  it('accepts a correctly signed body', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = await sign(body, ts);
    expect(
      await verifySvixSignature({ secret, body, headers: { id, timestamp: ts, signature } }),
    ).toBe(true);
  });

  it('accepts a signature list, so a rotating secret does not lock us out', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = `v1,${btoa('a-signature-from-the-other-key')} ${await sign(body, ts)}`;
    expect(
      await verifySvixSignature({ secret, body, headers: { id, timestamp: ts, signature } }),
    ).toBe(true);
  });

  it('refuses a body that was changed after signing', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = await sign(body, ts);
    expect(
      await verifySvixSignature({
        secret,
        body: body.replace('in_call_recording', 'fatal'),
        headers: { id, timestamp: ts, signature },
      }),
    ).toBe(false);
  });

  it('refuses a signature that is too old to be live', async () => {
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    const signature = await sign(body, old);
    expect(
      await verifySvixSignature({ secret, body, headers: { id, timestamp: old, signature } }),
    ).toBe(false);
  });

  it('refuses when a header is missing entirely', async () => {
    expect(
      await verifySvixSignature({
        secret,
        body,
        headers: { id: null, timestamp: null, signature: null },
      }),
    ).toBe(false);
  });

  it('reads the headers under either spelling', () => {
    const svix = new Headers({ 'svix-id': 'a', 'svix-timestamp': 'b', 'svix-signature': 'c' });
    expect(svixHeadersFrom(svix)).toEqual({ id: 'a', timestamp: 'b', signature: 'c' });
    const webhook = new Headers({
      'webhook-id': 'x',
      'webhook-timestamp': 'y',
      'webhook-signature': 'z',
    });
    expect(svixHeadersFrom(webhook)).toEqual({ id: 'x', timestamp: 'y', signature: 'z' });
  });
});
