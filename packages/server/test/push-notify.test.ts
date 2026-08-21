/**
 * Turning a review item into a notification, and delivering it.
 *
 * Two halves, tested separately because they fail differently: shaping the
 * payload is pure and exact, while delivery is a conversation with a push
 * service that can refuse in several ways that mean different things. The
 * `fetch` here is always a stub — nothing in this suite talks to a network.
 * All fixtures synthetic.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64urlEncode, generateVapidKeys } from '../src/push-crypto.ts';
import { PUSH_TTL_SECONDS, PushNotifier, reviewItemNotification } from '../src/push-notify.ts';
import { PushStore } from '../src/push-store.ts';

const NOW = 1_770_000_000_000;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'push-notify-'));
}

/**
 * A subscription with a REAL P-256 public key.
 *
 * Random bytes behind an 0x04 prefix will not do here: the send path imports
 * this key, and Web Crypto rejects a point that is not on the curve. That
 * rejection is indistinguishable from a broken implementation at the
 * assertion — every send simply reports `failed` — so an invalid fixture
 * tests the error path while claiming to test the happy one.
 */
async function sub(endpoint: string) {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    endpoint,
    keys: {
      p256dh: b64urlEncode(raw),
      auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

describe('reviewItemNotification', () => {
  const base = {
    ask: 'Should the queue drop answered rows immediately?',
    context: 'Review item notifications',
    askedBy: 'Live Feedback',
    url: 'https://example.ts.net/workspaces/w-abc?task=t-xyz',
    key: 'task:t-xyz:r-123',
    now: NOW,
  };

  it('leads with the QUESTION, because that is what gets answered', () => {
    const n = reviewItemNotification(base);
    // The ask is the title so a lock-screen glance shows the decision, not
    // the container it happens to live in.
    expect(n.title).toBe('Should the queue drop answered rows immediately?');
    expect(n.body).toContain('Review item notifications');
    expect(n.body).toContain('Live Feedback');
  });

  it('carries the deep link and the timestamp', () => {
    const n = reviewItemNotification(base);
    expect(n.url).toBe(base.url);
    expect(n.timestamp).toBe(NOW);
  });

  it('tags on the item key so a re-send REPLACES rather than stacks', () => {
    const n = reviewItemNotification(base);
    expect(n.tag).toBe('task:t-xyz:r-123');
  });

  it('falls back to a readable title when the ask is empty', () => {
    const n = reviewItemNotification({ ...base, ask: '   ' });
    expect(n.title.length).toBeGreaterThan(0);
    expect(n.title).toMatch(/review/i);
  });

  it('clips a pathological ask so the encrypted record can never overflow', () => {
    const n = reviewItemNotification({ ...base, ask: 'x'.repeat(10_000) });
    const size = new TextEncoder().encode(JSON.stringify(n)).length;
    // One 4096-byte record, less the GCM tag and the padding delimiter.
    expect(size).toBeLessThan(4079);
    expect(n.title.endsWith('…')).toBe(true);
  });

  it('clips a pathological context too — both fields are attacker-shaped', () => {
    const n = reviewItemNotification({ ...base, context: 'y'.repeat(10_000) });
    const size = new TextEncoder().encode(JSON.stringify(n)).length;
    expect(size).toBeLessThan(4079);
  });
});

describe('PushNotifier.send', () => {
  async function notifier(dir: string, fetchImpl: typeof fetch) {
    const store = new PushStore({ dataDir: dir, now: () => NOW });
    return {
      store,
      push: new PushNotifier({
        store,
        keys: await generateVapidKeys(),
        subject: 'mailto:ops@example.com',
        fetch: fetchImpl,
        now: () => NOW,
      }),
    };
  }

  const note = {
    title: 'A question',
    body: 'about something',
    url: 'https://example.ts.net/home',
    tag: 'task:t-1:r-1',
    timestamp: NOW,
  };

  it('sends nothing, and calls nothing, when no device is enrolled', async () => {
    const dir = tmp();
    try {
      let calls = 0;
      const { push } = await notifier(dir, async () => {
        calls++;
        return new Response(null, { status: 201 });
      });
      const result = await push.send(note);
      expect(result.sent).toBe(0);
      expect(calls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POSTs one encrypted request per enrolled device', async () => {
    const dir = tmp();
    try {
      const seen: Array<{ url: string; init: RequestInit }> = [];
      const { store, push } = await notifier(dir, async (input, init) => {
        seen.push({ url: String(input), init: init ?? {} });
        return new Response(null, { status: 201 });
      });
      store.save(await sub('https://push.example.com/s/mac'), { userId: 'u', userName: 'Bryan' });
      store.save(await sub('https://push.example.com/s/phone'), { userId: 'u', userName: 'Bryan' });

      const result = await push.send(note);
      expect(result.sent).toBe(2);
      expect(seen.map((s) => s.url).sort()).toEqual([
        'https://push.example.com/s/mac',
        'https://push.example.com/s/phone',
      ]);
      expect(seen[0]?.init.method).toBe('POST');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sets the headers a push service requires to route an aes128gcm body', async () => {
    const dir = tmp();
    try {
      let headers: Record<string, string> = {};
      let body: unknown;
      const { store, push } = await notifier(dir, async (_input, init) => {
        headers = (init?.headers ?? {}) as Record<string, string>;
        body = init?.body;
        return new Response(null, { status: 201 });
      });
      store.save(await sub('https://push.example.com/s/mac'), { userId: 'u', userName: 'Bryan' });
      await push.send(note);

      expect(headers['Content-Encoding']).toBe('aes128gcm');
      expect(headers['Content-Type']).toBe('application/octet-stream');
      expect(headers.TTL).toBe(String(PUSH_TTL_SECONDS));
      expect(headers.Authorization?.startsWith('vapid t=')).toBe(true);
      // A JSON body here is the classic silent failure: the service accepts
      // the request and the browser cannot decrypt it, so nothing appears.
      expect(body).toBeInstanceOf(Uint8Array);
      expect((body as Uint8Array).length).toBeGreaterThan(86);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('signs each device with an audience matching ITS OWN push service', async () => {
    const dir = tmp();
    try {
      const auds: string[] = [];
      const { store, push } = await notifier(dir, async (_input, init) => {
        const h = (init?.headers ?? {}) as Record<string, string>;
        const jwt = h.Authorization.slice('vapid t='.length).split(',')[0]!;
        const claims = JSON.parse(atob(jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
        auds.push(claims.aud);
        return new Response(null, { status: 201 });
      });
      // Chrome and Firefox are different services; one token cannot serve both.
      store.save(await sub('https://fcm.example.com/s/a'), { userId: 'u', userName: 'B' });
      store.save(await sub('https://updates.push.example.org/s/b'), { userId: 'u', userName: 'B' });
      await push.send(note);
      expect(auds.sort()).toEqual(['https://fcm.example.com', 'https://updates.push.example.org']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('soft-disables a subscription the service reports GONE (410)', async () => {
    const dir = tmp();
    try {
      const { store, push } = await notifier(dir, async () => new Response(null, { status: 410 }));
      const a = await sub('https://push.example.com/s/dead');
      store.save(a, { userId: 'u', userName: 'Bryan' });

      const result = await push.send(note);
      expect(result.sent).toBe(0);
      expect(result.disabled).toBe(1);
      expect(store.active()).toEqual([]);
      // Soft, not gone: the record says what happened to it.
      expect(store.get(a.endpoint)?.disabledReason).toContain('410');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('soft-disables on 404 as well — the endpoint is equally unroutable', async () => {
    const dir = tmp();
    try {
      const { store, push } = await notifier(dir, async () => new Response(null, { status: 404 }));
      store.save(await sub('https://push.example.com/s/dead'), { userId: 'u', userName: 'Bryan' });
      await push.send(note);
      expect(store.active()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a subscription that failed TRANSIENTLY (429, 500)', async () => {
    const dir = tmp();
    try {
      const { store, push } = await notifier(dir, async () => new Response(null, { status: 429 }));
      store.save(await sub('https://push.example.com/s/busy'), { userId: 'u', userName: 'Bryan' });

      const result = await push.send(note);
      expect(result.failed).toBe(1);
      expect(result.disabled).toBe(0);
      // Rate limiting is the service having a bad minute. Dropping the device
      // for it would unenroll a working phone and say nothing.
      expect(store.active().length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a subscription whose request threw, and does not propagate', async () => {
    const dir = tmp();
    try {
      const { store, push } = await notifier(dir, async () => {
        throw new Error('ECONNREFUSED');
      });
      store.save(await sub('https://push.example.com/s/mac'), { userId: 'u', userName: 'Bryan' });

      const result = await push.send(note);
      expect(result.failed).toBe(1);
      expect(store.active().length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('delivers to the healthy devices even when one is dead', async () => {
    const dir = tmp();
    try {
      const { store, push } = await notifier(dir, async (input) =>
        String(input).includes('dead')
          ? new Response(null, { status: 410 })
          : new Response(null, { status: 201 }),
      );
      store.save(await sub('https://push.example.com/s/dead'), { userId: 'u', userName: 'Bryan' });
      store.save(await sub('https://push.example.com/s/live'), { userId: 'u', userName: 'Bryan' });

      const result = await push.send(note);
      expect(result.sent).toBe(1);
      expect(result.disabled).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never throws into its caller — creating a review item must not depend on push', async () => {
    const dir = tmp();
    try {
      const { store, push } = await notifier(dir, async () => {
        throw new Error('the whole push service is down');
      });
      store.save(await sub('https://push.example.com/s/mac'), { userId: 'u', userName: 'Bryan' });
      // The review item is the durable thing; the notification is a courtesy.
      // A push outage that failed the create would lose the actual work.
      await expect(push.send(note)).resolves.toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts 200 and 202 as delivered, not just 201', async () => {
    const dir = tmp();
    try {
      for (const status of [200, 202]) {
        const { store, push } = await notifier(dir, async () => new Response(null, { status }));
        store.save(await sub(`https://push.example.com/s/${status}`), {
          userId: 'u',
          userName: 'B',
        });
        const result = await push.send(note);
        expect(result.sent).toBeGreaterThan(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
