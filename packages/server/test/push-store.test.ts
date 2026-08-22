/**
 * The push subscription store and the server's VAPID identity: persistence,
 * file modes, soft delete, and defensive load. All fixtures synthetic — the
 * endpoints are example.com URLs and the keys are generated per run.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { b64urlEncode } from '../src/push-crypto.ts';
import {
  PushStore,
  SUBSCRIPTIONS_FILENAME,
  VAPID_FILENAME,
  loadOrCreateVapidKeys,
} from '../src/push-store.ts';

const NOW = 1_770_000_000_000;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'push-store-'));
}

/** A syntactically valid subscription. The point values are never used to
 *  encrypt here — the crypto has its own suite. */
function sub(endpoint: string) {
  const p256dh = new Uint8Array(65);
  p256dh[0] = 0x04;
  crypto.getRandomValues(p256dh.subarray(1));
  return {
    endpoint,
    keys: {
      p256dh: b64urlEncode(p256dh),
      auth: b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

describe('loadOrCreateVapidKeys', () => {
  it('mints a pair on first call and persists it', async () => {
    const dir = tmp();
    try {
      const keys = await loadOrCreateVapidKeys(dir);
      expect(keys.publicKey.length).toBeGreaterThan(80);
      expect(existsSync(join(dir, VAPID_FILENAME))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the SAME pair on the next call', async () => {
    const dir = tmp();
    try {
      const first = await loadOrCreateVapidKeys(dir);
      const second = await loadOrCreateVapidKeys(dir);
      // A regenerated key silently invalidates every subscription already in
      // the field: the browser bound its subscription to the old public key
      // and the push service will reject sends signed by the new one.
      expect(second.publicKey).toBe(first.publicKey);
      expect(second.privateKey).toBe(first.privateKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the private key mode 600', async () => {
    const dir = tmp();
    try {
      await loadOrCreateVapidKeys(dir);
      const mode = statSync(join(dir, VAPID_FILENAME)).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to serve a corrupt key file rather than silently re-minting', async () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, VAPID_FILENAME), '{"publicKey":"nope","privateKey":"nope"}');
      await expect(loadOrCreateVapidKeys(dir)).rejects.toThrow();
      // Re-minting would look like a fix and would break every live
      // subscription; failing loudly leaves the operator a repairable state.
      expect(readFileSync(join(dir, VAPID_FILENAME), 'utf8')).toContain('nope');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('PushStore', () => {
  it('starts empty and persists nothing until a subscription arrives', () => {
    const dir = tmp();
    try {
      const store = new PushStore({ dataDir: dir, now: () => NOW });
      expect(store.active()).toEqual([]);
      expect(existsSync(join(dir, SUBSCRIPTIONS_FILENAME))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saves a subscription and reads it back from disk in a fresh store', () => {
    const dir = tmp();
    try {
      const a = sub('https://push.example.com/s/aaa');
      new PushStore({ dataDir: dir, now: () => NOW }).save(a, {
        userId: 'u-bryan',
        userName: 'Bryan',
      });

      const reopened = new PushStore({ dataDir: dir, now: () => NOW });
      const rows = reopened.active();
      expect(rows.length).toBe(1);
      expect(rows[0]?.endpoint).toBe(a.endpoint);
      expect(rows[0]?.keys.auth).toBe(a.keys.auth);
      expect(rows[0]?.userName).toBe('Bryan');
      expect(rows[0]?.createdAt).toBe(NOW);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the subscription file mode 600', () => {
    const dir = tmp();
    try {
      const store = new PushStore({ dataDir: dir, now: () => NOW });
      store.save(sub('https://push.example.com/s/aaa'), { userId: 'u', userName: 'U' });
      // An endpoint plus its auth secret is a capability to push anything to
      // the owner's lock screen. It is not less sensitive than the VAPID key.
      expect(statSync(join(dir, SUBSCRIPTIONS_FILENAME)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats the endpoint as identity — re-saving updates rather than duplicates', () => {
    const dir = tmp();
    try {
      const store = new PushStore({ dataDir: dir, now: () => NOW });
      const a = sub('https://push.example.com/s/aaa');
      store.save(a, { userId: 'u-bryan', userName: 'Bryan' });
      store.save(a, { userId: 'u-bryan', userName: 'Bryan on iPad' });
      expect(store.active().length).toBe(1);
      expect(store.active()[0]?.userName).toBe('Bryan on iPad');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps several devices for one person', () => {
    const dir = tmp();
    try {
      const store = new PushStore({ dataDir: dir, now: () => NOW });
      store.save(sub('https://push.example.com/s/mac'), { userId: 'u', userName: 'Bryan' });
      store.save(sub('https://push.example.com/s/phone'), { userId: 'u', userName: 'Bryan' });
      expect(store.active().length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('soft-deletes: a disabled row leaves the active set but stays on disk', () => {
    const dir = tmp();
    try {
      const store = new PushStore({ dataDir: dir, now: () => NOW });
      const a = sub('https://push.example.com/s/aaa');
      store.save(a, { userId: 'u', userName: 'Bryan' });
      store.disable(a.endpoint, 'unsubscribed');

      expect(store.active()).toEqual([]);
      const onDisk = JSON.parse(readFileSync(join(dir, SUBSCRIPTIONS_FILENAME), 'utf8'));
      const rows = Object.values(onDisk.subscriptions) as Array<Record<string, unknown>>;
      expect(rows.length).toBe(1);
      expect(rows[0]?.disabledAt).toBe(NOW);
      expect(rows[0]?.disabledReason).toBe('unsubscribed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('revives a disabled endpoint on re-subscribe, keeping its original createdAt', () => {
    const dir = tmp();
    try {
      let clock = NOW;
      const store = new PushStore({ dataDir: dir, now: () => clock });
      const a = sub('https://push.example.com/s/aaa');
      store.save(a, { userId: 'u', userName: 'Bryan' });
      store.disable(a.endpoint, 'gone');
      clock = NOW + 60_000;
      store.save(a, { userId: 'u', userName: 'Bryan' });

      const rows = store.active();
      expect(rows.length).toBe(1);
      expect(rows[0]?.createdAt).toBe(NOW);
      expect(rows[0]?.disabledAt).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disabling an endpoint it has never seen is a no-op, not a throw', () => {
    const dir = tmp();
    try {
      const store = new PushStore({ dataDir: dir, now: () => NOW });
      expect(() => store.disable('https://push.example.com/s/never', 'gone')).not.toThrow();
      expect(store.active()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a subscription whose endpoint is not https', () => {
    const dir = tmp();
    try {
      const store = new PushStore({ dataDir: dir, now: () => NOW });
      expect(() =>
        store.save(sub('http://push.example.com/s/aaa'), { userId: 'u', userName: 'U' }),
      ).toThrow(/https/i);
      expect(() => store.save(sub('file:///etc/passwd'), { userId: 'u', userName: 'U' })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a subscription missing its keys', () => {
    const dir = tmp();
    try {
      const store = new PushStore({ dataDir: dir, now: () => NOW });
      const bad = { endpoint: 'https://push.example.com/s/aaa', keys: { p256dh: '', auth: '' } };
      expect(() => store.save(bad, { userId: 'u', userName: 'U' })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('moves a corrupt file aside instead of overwriting it, and reports why', () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, SUBSCRIPTIONS_FILENAME), 'not json at all');
      const store = new PushStore({ dataDir: dir, now: () => NOW });
      expect(store.loadError).toBeTruthy();
      expect(store.active()).toEqual([]);
      // The only evidence of what went wrong must survive the next write.
      expect(existsSync(join(dir, `${SUBSCRIPTIONS_FILENAME}.corrupt-${NOW}`))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('drops individual malformed rows on load rather than failing the whole file', () => {
    const dir = tmp();
    try {
      const good = sub('https://push.example.com/s/good');
      writeFileSync(
        join(dir, SUBSCRIPTIONS_FILENAME),
        JSON.stringify({
          version: 1,
          subscriptions: {
            [good.endpoint]: {
              endpoint: good.endpoint,
              keys: good.keys,
              userId: 'u',
              userName: 'Bryan',
              createdAt: NOW,
              updatedAt: NOW,
            },
            'https://push.example.com/s/bad': { endpoint: null, keys: 'nope' },
          },
        }),
      );
      const store = new PushStore({ dataDir: dir, now: () => NOW });
      expect(store.loadError).toBeNull();
      expect(store.active().map((r) => r.endpoint)).toEqual([good.endpoint]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
