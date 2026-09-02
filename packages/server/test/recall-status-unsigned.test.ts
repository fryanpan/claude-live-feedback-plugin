/**
 * `POST /recall/status` is armed only while its credential is configured —
 * on EVERY host, not just the dedicated callback one.
 *
 * `recallCallbackAllows` already closed this path on the callback hostname
 * when `RECALL_WEBHOOK_SECRET` is unset, and its header says why: unset used
 * to mean "accept unsigned bodies". But the route is reachable on every other
 * admitting host class too, and there the whole signature-and-replay block
 * sat inside `if (secret)`. So on a server with no secret — which is the
 * DEFAULT; the boot warns rather than refuses — an unauthenticated non-browser
 * caller on the LAN or the tailnet could inject arbitrary bot-status and
 * calendar-sync events, unsigned and unbounded by the replay guard.
 *
 * The positive control is the same body against a server that HAS a secret:
 * signed it is accepted, unsigned it is a `bad signature`. Without that pair,
 * the 404 below could be a route that does not exist at all.
 *
 * Every credential here is a literal this suite invents. Fixtures are
 * synthetic; the repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';

const WEBHOOK_SECRET = `whsec_${btoa('claude-workspaces-armed-test')}`;

const BODY = JSON.stringify({
  event: 'bot.status_change',
  data: { bot_id: 'bot-fixture-1', status: { code: 'done' } },
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function boot(secret: string | undefined): ServerHandle {
  const dataDir = mkdtempSync(join(tmpdir(), 'recall-armed-'));
  const handle = createServer({
    port: 0,
    dataDir,
    ...(secret === undefined ? {} : { meetingBotWebhookSecret: secret }),
  });
  cleanups.push(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return handle;
}

/** Svix headers for a body, signed the way Recall's backend signs one. */
async function signBody(body: string, id: string): Promise<Record<string, string>> {
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
}

/** Deliver on the LOCAL surface — the host class the callback gate never
 *  sees, and the one this refusal is about. */
const deliver = (handle: ServerHandle, headers: Record<string, string> = {}) =>
  fetch(`http://localhost:${handle.port}/recall/status`, {
    method: 'POST',
    headers: {
      host: `localhost:${handle.port}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: BODY,
  });

describe('the Recall status webhook is armed only with its secret', () => {
  it('refuses an unsigned body on the local surface when no secret is set', async () => {
    const handle = boot(undefined);
    const r = await deliver(handle);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not_found' });
  });

  it('…and refuses a body carrying Svix headers just the same', async () => {
    // There is no secret to check them against, so a caller who guessed the
    // header names must not get a different answer from one who did not.
    const handle = boot(undefined);
    const r = await deliver(handle, await signBody(BODY, 'msg_armed_guess'));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not_found' });
  });

  it('positive control: with a secret set, a SIGNED delivery is accepted', async () => {
    const handle = boot(WEBHOOK_SECRET);
    const r = await deliver(handle, await signBody(BODY, 'msg_armed_ok'));
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('positive control: with a secret set, an UNSIGNED delivery is a bad signature', async () => {
    // The route exists and checks a credential — which is what makes the 404
    // above a statement about arming rather than about routing.
    const handle = boot(WEBHOOK_SECRET);
    const r = await deliver(handle);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: 'bad signature' });
  });
});
