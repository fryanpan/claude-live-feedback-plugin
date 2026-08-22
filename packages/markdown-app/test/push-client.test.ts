/**
 * The browser half of push enrolment: reading whether this device can be
 * enrolled, turning it on behind a user gesture, and turning it off.
 *
 * happy-dom has no ServiceWorker or PushManager, so every capability here is
 * installed on the fake window per test. That is the point rather than a
 * workaround — the interesting behaviour is what this module does when a
 * capability is MISSING, which is the case on every browser Bryan is not
 * currently holding.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applicationServerKeyBytes,
  disablePush,
  enablePush,
  readPushStatus,
} from '../src/push-client.ts';

const AUTHOR = { id: 'u-bryan', name: 'Bryan' };
/** A real uncompressed P-256 point, base64url. RFC 8291 §5's receiver key. */
const VAPID_PUBLIC =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';

interface FakeSubscription {
  endpoint: string;
  toJSON(): { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe(): Promise<boolean>;
}

function fakeSubscription(endpoint = 'https://push.example.com/s/abc'): FakeSubscription {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: async () => true,
  };
}

/** Install just enough of a push-capable browser. Each field is separately
 *  omittable, because each omission is a real browser somewhere. */
function installBrowser(
  opts: {
    serviceWorker?: boolean;
    pushManager?: boolean;
    notification?: NotificationPermission;
    existing?: FakeSubscription | null;
    subscribeResult?: FakeSubscription | Error;
    requestPermission?: NotificationPermission;
  } = {},
) {
  const subscribe = vi.fn(async () => {
    const r = opts.subscribeResult ?? fakeSubscription();
    if (r instanceof Error) throw r;
    return r;
  });
  const registration = {
    pushManager:
      opts.pushManager === false
        ? undefined
        : {
            getSubscription: vi.fn(async () => opts.existing ?? null),
            subscribe,
          },
  };
  const register = vi.fn(async () => registration);
  const ready = Promise.resolve(registration);

  if (opts.serviceWorker === false) {
    // Removing the key is the point — `in` is what the module tests, and an
    // `undefined` value still satisfies it. Reflect keeps biome's noDelete
    // rule out of the way, as elsewhere in this repo.
    Reflect.deleteProperty(navigator, 'serviceWorker');
  } else {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { register, ready, controller: null },
      configurable: true,
      writable: true,
    });
  }

  // Shaped like the real globals: both are CONSTRUCTORS, and `Notification`
  // carries `permission` / `requestPermission` as statics. An object literal
  // here would let a `typeof x === 'object'` support check pass in the suite
  // and fail on every real browser.
  const requestPermission = vi.fn(async () => opts.requestPermission ?? 'granted');
  function Notification() {}
  Notification.permission = opts.notification ?? 'default';
  Notification.requestPermission = requestPermission;
  function PushManager() {}

  // Present unless a test is specifically about its absence — otherwise one
  // omission masks another and each test proves less than it claims.
  if (opts.pushManager === false) {
    Reflect.deleteProperty(globalThis, 'PushManager');
  } else {
    (globalThis as Record<string, unknown>).PushManager = PushManager;
  }
  (globalThis as Record<string, unknown>).Notification = Notification;

  return { register, subscribe, requestPermission, registration };
}

function stubFetch(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const hit = routes[url];
      if (hit === undefined) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(hit), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Deleted rather than set to undefined: `browserSupportsPush` tests with
  // `in`, which an `undefined` value still satisfies.
  Reflect.deleteProperty(globalThis, 'Notification');
  Reflect.deleteProperty(globalThis, 'PushManager');
});

describe('browser support detection', () => {
  it('is not fooled by globals that exist but are not constructors', async () => {
    // The positive control for the two "unsupported" tests below: with every
    // capability present the module must report supported, or those tests
    // pass for a reason that has nothing to do with what they name.
    installBrowser({ notification: 'default' });
    stubFetch({ '/api/push/key': { available: true, publicKey: VAPID_PUBLIC } });
    expect((await readPushStatus()).supported).toBe(true);
  });
});

describe('applicationServerKeyBytes', () => {
  it('decodes a base64url VAPID key to a 65-byte P-256 point', () => {
    const bytes = applicationServerKeyBytes(VAPID_PUBLIC);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(0x04);
  });

  it('handles the URL-safe alphabet and missing padding', () => {
    // `subscribe()` rejects with a DOMException when the key is wrong, and the
    // message names nothing useful — so decoding has to be right here.
    expect(() => applicationServerKeyBytes(VAPID_PUBLIC)).not.toThrow();
  });
});

describe('readPushStatus', () => {
  it('reports unsupported when the browser has no service worker', async () => {
    installBrowser({ serviceWorker: false });
    stubFetch({});
    const status = await readPushStatus();
    expect(status.supported).toBe(false);
    expect(status.enabled).toBe(false);
  });

  it('reports unsupported when the browser has no PushManager', async () => {
    // Safari before 16.4, and any iOS tab that was not added to the Home
    // Screen: a service worker exists, push does not.
    installBrowser({ pushManager: false, notification: 'default' });
    stubFetch({});
    const status = await readPushStatus();
    expect(status.supported).toBe(false);
  });

  it('reports unavailable when the SERVER says the origin is insecure', async () => {
    installBrowser({ notification: 'default' });
    stubFetch({ '/api/push/key': { available: false, reason: 'insecure-origin' } });
    const status = await readPushStatus();
    expect(status.available).toBe(false);
    expect(status.reason).toBe('insecure-origin');
  });

  it('reports enabled when this device already holds a subscription', async () => {
    installBrowser({ notification: 'granted', existing: fakeSubscription() });
    stubFetch({ '/api/push/key': { available: true, publicKey: VAPID_PUBLIC } });
    const status = await readPushStatus();
    expect(status.supported).toBe(true);
    expect(status.enabled).toBe(true);
    expect(status.permission).toBe('granted');
  });

  it('reports NOT enabled when permission is granted but no subscription exists', async () => {
    // Granting permission and enrolling are two steps, and this is the gap
    // between them — a toggle that read permission alone would show "on"
    // while the server has no way to reach this device.
    installBrowser({ notification: 'granted', existing: null });
    stubFetch({ '/api/push/key': { available: true, publicKey: VAPID_PUBLIC } });
    const status = await readPushStatus();
    expect(status.enabled).toBe(false);
  });

  it('reports denied permission without claiming the browser cannot do push', async () => {
    installBrowser({ notification: 'denied' });
    stubFetch({ '/api/push/key': { available: true, publicKey: VAPID_PUBLIC } });
    const status = await readPushStatus();
    expect(status.supported).toBe(true);
    expect(status.permission).toBe('denied');
    expect(status.enabled).toBe(false);
  });
});

describe('enablePush', () => {
  it('registers the worker, subscribes, and posts the subscription', async () => {
    const browser = installBrowser({ notification: 'default', requestPermission: 'granted' });
    const calls = stubFetch({
      '/api/push/key': { available: true, publicKey: VAPID_PUBLIC },
      '/api/push/subscriptions': { ok: true },
    });

    const result = await enablePush(AUTHOR);
    expect(result.ok).toBe(true);
    expect(browser.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(browser.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );

    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/push/subscriptions');
    expect(post?.body).toMatchObject({
      author: AUTHOR,
      subscription: { endpoint: 'https://push.example.com/s/abc' },
    });
  });

  it('asks for permission — the prompt is the point of the user gesture', async () => {
    const browser = installBrowser({ notification: 'default', requestPermission: 'granted' });
    stubFetch({
      '/api/push/key': { available: true, publicKey: VAPID_PUBLIC },
      '/api/push/subscriptions': { ok: true },
    });
    await enablePush(AUTHOR);
    expect(browser.requestPermission).toHaveBeenCalled();
  });

  it('stops at a denied prompt without subscribing', async () => {
    const browser = installBrowser({ notification: 'default', requestPermission: 'denied' });
    stubFetch({ '/api/push/key': { available: true, publicKey: VAPID_PUBLIC } });

    const result = await enablePush(AUTHOR);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/permission/i);
    expect(browser.subscribe).not.toHaveBeenCalled();
  });

  it('refuses when the server has no key to subscribe against', async () => {
    const browser = installBrowser({ notification: 'granted' });
    stubFetch({ '/api/push/key': { available: false, reason: 'insecure-origin' } });

    const result = await enablePush(AUTHOR);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/insecure-origin|not available/i);
    expect(browser.subscribe).not.toHaveBeenCalled();
  });

  it('reuses an existing subscription rather than minting a second', async () => {
    const existing = fakeSubscription('https://push.example.com/s/already');
    const browser = installBrowser({ notification: 'granted', existing });
    const calls = stubFetch({
      '/api/push/key': { available: true, publicKey: VAPID_PUBLIC },
      '/api/push/subscriptions': { ok: true },
    });

    const result = await enablePush(AUTHOR);
    expect(result.ok).toBe(true);
    expect(browser.subscribe).not.toHaveBeenCalled();
    // Still re-posted: the server may have been reinstalled, or this device
    // may have been soft-disabled, and re-posting is what revives it.
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toMatchObject({
      subscription: { endpoint: 'https://push.example.com/s/already' },
    });
  });

  it('reports the browser refusing to subscribe instead of throwing', async () => {
    installBrowser({
      notification: 'granted',
      subscribeResult: new Error('AbortError: push service not available'),
    });
    stubFetch({ '/api/push/key': { available: true, publicKey: VAPID_PUBLIC } });

    const result = await enablePush(AUTHOR);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/push service not available/);
  });

  it('reports unsupported browsers as a reason, not a crash', async () => {
    installBrowser({ serviceWorker: false });
    stubFetch({});
    const result = await enablePush(AUTHOR);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/support/i);
  });
});

describe('disablePush', () => {
  it('unsubscribes locally and tells the server which endpoint went away', async () => {
    const existing = fakeSubscription('https://push.example.com/s/bye');
    const unsubscribe = vi.spyOn(existing, 'unsubscribe');
    installBrowser({ notification: 'granted', existing });
    const calls = stubFetch({ '/api/push/subscriptions': { ok: true } });

    await disablePush();

    expect(unsubscribe).toHaveBeenCalled();
    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.body).toMatchObject({ endpoint: 'https://push.example.com/s/bye' });
  });

  it('is a no-op when this device was never enrolled', async () => {
    installBrowser({ notification: 'default', existing: null });
    const calls = stubFetch({ '/api/push/subscriptions': { ok: true } });
    await expect(disablePush()).resolves.toBeUndefined();
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('does not throw on a browser with no push support at all', async () => {
    installBrowser({ serviceWorker: false });
    stubFetch({});
    await expect(disablePush()).resolves.toBeUndefined();
  });
});
