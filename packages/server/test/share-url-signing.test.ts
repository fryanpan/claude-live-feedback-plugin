/**
 * Signed share URLs — the S3-presigned pattern applied to share links.
 *
 * The URL carries the share id, an expiry, and an HMAC-SHA256 signature over
 * `<id>.<exp>` under a server-held key. Whoever holds the key can mint; a
 * tampered id, a stretched expiry, or a guessed signature all verify false.
 *
 * The SAME signature must verify in two runtimes: this server (Bun) and the
 * Cloudflare Worker that gates `/share/*` at the edge. Both use Web Crypto
 * (`crypto.subtle`), and the cross-runtime suite at the bottom signs with the
 * server module and verifies with the Worker's own exported function — that
 * pairing, not either half alone, is what proves a link minted here passes
 * the edge gate.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import workerHandler, {
  verifySignedShare as workerVerify,
} from '../../../infra/share-link-worker/worker.js';
import {
  URL_KEY_FILENAME,
  loadUrlKey,
  signedSharePath,
  verifySignedShare,
} from '../src/share/url-signing.ts';

/** Obviously fake — a test key, never a real one. */
const KEY = 'test-key-'.padEnd(64, '0');
const OTHER_KEY = 'other-key-'.padEnd(64, '1');

const HOUR = 3_600_000;

/** Pull `exp` and `sig` back out of a signed path. */
const parse = (path: string) => {
  const u = new URL(`https://example.com${path}`);
  return {
    pathname: u.pathname,
    exp: u.searchParams.get('exp') ?? '',
    sig: u.searchParams.get('sig') ?? '',
  };
};

describe('signedSharePath', () => {
  it('produces /share/<id>?exp=<unix-seconds>&sig=<hex> with the expiry embedded', async () => {
    const expiresAt = Date.now() + HOUR;
    const path = await signedSharePath('abcd1234', expiresAt, KEY);
    const { pathname, exp, sig } = parse(path);
    expect(pathname).toBe('/share/abcd1234');
    expect(Number(exp)).toBe(Math.floor(expiresAt / 1000));
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('round-trips through verifySignedShare', async () => {
    const { exp, sig } = parse(await signedSharePath('abcd1234', Date.now() + HOUR, KEY));
    expect(await verifySignedShare('abcd1234', exp, sig, KEY)).toBe(true);
  });
});

describe('verifySignedShare refuses', () => {
  const signed = async (id = 'abcd1234', expiresAt = Date.now() + HOUR, key = KEY) =>
    parse(await signedSharePath(id, expiresAt, key));

  it('a signature made for a DIFFERENT share id', async () => {
    const { exp, sig } = await signed('abcd1234');
    expect(await verifySignedShare('ffff9999', exp, sig, KEY)).toBe(false);
  });

  it('a stretched expiry — exp is covered by the signature', async () => {
    const { exp, sig } = await signed();
    const stretched = String(Number(exp) + 86_400);
    expect(await verifySignedShare('abcd1234', stretched, sig, KEY)).toBe(false);
  });

  it('an expired link, even with a valid signature', async () => {
    const past = Date.now() - HOUR;
    const { exp, sig } = await signed('abcd1234', past);
    // Positive control: the signature itself is genuine — the same tuple
    // verified BEFORE the expiry passes.
    expect(await verifySignedShare('abcd1234', exp, sig, KEY, past - HOUR)).toBe(true);
    expect(await verifySignedShare('abcd1234', exp, sig, KEY)).toBe(false);
  });

  it('a signature under the wrong key', async () => {
    const { exp, sig } = await signed('abcd1234', Date.now() + HOUR, OTHER_KEY);
    expect(await verifySignedShare('abcd1234', exp, sig, KEY)).toBe(false);
  });

  it('malformed exp and sig without throwing', async () => {
    const { exp, sig } = await signed();
    for (const [e, s] of [
      ['', sig],
      ['not-a-number', sig],
      ['-1', sig],
      [`${exp}.5`, sig],
      [exp, ''],
      [exp, 'nothex'],
      [exp, sig.slice(0, 63)], // truncated
      [exp, `${sig}ff`], // padded
    ] as const) {
      expect(await verifySignedShare('abcd1234', e, s, KEY), `exp=${e} sig=${s}`).toBe(false);
    }
    // Positive control: the untampered tuple still verifies.
    expect(await verifySignedShare('abcd1234', exp, sig, KEY)).toBe(true);
  });
});

describe('loadUrlKey', () => {
  it('generates on first use, mode 600, and returns the same key thereafter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'url-key-'));
    try {
      const key = loadUrlKey(dir);
      expect(key).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex
      const path = join(dir, URL_KEY_FILENAME);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(loadUrlKey(dir)).toBe(key);
      expect(readFileSync(path, 'utf8').trim()).toBe(key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is its own key — NOT the session-cookie key', () => {
    // The Worker gets this key as a deploy secret. If it were the cookie key,
    // handing it to the edge would hand the edge the power to mint session
    // cookies for any share.
    const dir = mkdtempSync(join(tmpdir(), 'url-key-sep-'));
    try {
      expect(URL_KEY_FILENAME).not.toBe('share-cookie.key');
      loadUrlKey(dir);
      expect(existsSync(join(dir, 'share-cookie.key'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the Cloudflare Worker verifies what the server signs', () => {
  it('accepts a server-signed tuple and refuses the same tamperings', async () => {
    const { exp, sig } = parse(await signedSharePath('abcd1234', Date.now() + HOUR, KEY));
    expect(await workerVerify('abcd1234', exp, sig, KEY)).toBe(true);
    expect(await workerVerify('ffff9999', exp, sig, KEY)).toBe(false);
    expect(await workerVerify('abcd1234', String(Number(exp) + 86_400), sig, KEY)).toBe(false);
    expect(await workerVerify('abcd1234', exp, sig, OTHER_KEY)).toBe(false);
  });

  it('refuses an expired server-signed link', async () => {
    const { exp, sig } = parse(await signedSharePath('abcd1234', Date.now() - HOUR, KEY));
    expect(await workerVerify('abcd1234', exp, sig, KEY)).toBe(false);
  });

  describe('the fetch handler', () => {
    const env = { SHARE_LINK_KEY: KEY };
    /** Run the handler with origin `fetch` stubbed to a recognisable reply. */
    const run = async (path: string, e: Record<string, string>) => {
      const realFetch = globalThis.fetch;
      let proxied = false;
      // @ts-expect-error stubbing the Workers runtime's origin fetch
      globalThis.fetch = async () => {
        proxied = true;
        return new Response('origin', { status: 200 });
      };
      try {
        const res = await workerHandler.fetch(
          new Request(`https://feedback.example.com${path}`),
          e,
        );
        return { res, proxied };
      } finally {
        globalThis.fetch = realFetch;
      }
    };

    it('proxies a validly signed /share/ URL to origin', async () => {
      const path = await signedSharePath('abcd1234', Date.now() + HOUR, KEY);
      const { res, proxied } = await run(path, env);
      expect(proxied).toBe(true);
      expect(await res.text()).toBe('origin');
    });

    it('404s a tampered, expired, or unsigned /share/ URL without touching origin', async () => {
      const good = await signedSharePath('abcd1234', Date.now() + HOUR, KEY);
      const expired = await signedSharePath('abcd1234', Date.now() - HOUR, KEY);
      for (const path of [
        good.replace(/sig=[0-9a-f]{8}/, 'sig=00000000'), // tampered
        expired,
        '/share/abcd1234', // no exp, no sig
        '/share/abcd1234/extra', // not the redeem shape
      ]) {
        const { res, proxied } = await run(path, env);
        expect(res.status, path).toBe(404);
        expect(proxied, path).toBe(false);
      }
    });

    it('fails CLOSED when the key secret is not configured', async () => {
      const path = await signedSharePath('abcd1234', Date.now() + HOUR, KEY);
      const { res, proxied } = await run(path, {});
      expect(res.status).toBe(404);
      expect(proxied).toBe(false);
    });

    it('leaves non-/share/ paths alone — the app authorizes those itself', async () => {
      const { res, proxied } = await run('/workspaces/w1', {});
      expect(proxied).toBe(true);
      expect(res.status).toBe(200);
    });
  });
});
