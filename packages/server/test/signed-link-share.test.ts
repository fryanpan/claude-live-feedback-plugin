/**
 * Signed share links, driven through the real route table.
 *
 * The URL — `/share/<id>?exp=<unix-seconds>&sig=<hex>` — is the credential:
 * nothing in it is secret, and the HMAC signature (share/url-signing.ts) is
 * what makes possession mean anything. What this file cares about:
 *
 * (a) minting hands out that shape, with the expiry embedded at issue time;
 * (b) the server validates signature + expiry on every /share/* request —
 *     defense-in-depth behind the edge Worker, never trusting that it ran;
 * (c) the registry is STILL re-checked after the signature, so revocation
 *     and record expiry beat a validly signed URL (early revocation stays
 *     app-layer);
 * (d) the old unsigned form (`/s/<slug>`) stops being accepted, while the
 *     records that carry one keep working through freshly computed signed
 *     URLs — migrated on demand, no data deleted.
 *
 * Session scope after redemption is link-share.test.ts's job; this file owns
 * the URL itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';
import type { Share } from '../src/share/types.ts';
import { URL_KEY_FILENAME } from '../src/share/url-signing.ts';

const PUBLIC_HOST = 'feedback.example.com';

describe('signed share links over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId: string;
  let share: Share;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const pub = (pathAndQuery: string, init: RequestInit = {}) =>
    fetch(`${base}${pathAndQuery}`, {
      redirect: 'manual',
      ...init,
      headers: { host: PUBLIC_HOST, ...((init.headers as Record<string, string>) ?? {}) },
    });

  /** The path+query of a share's signed URL, as a visitor's browser sends it. */
  const signedPath = (u: string): string => {
    const parsed = new URL(u);
    return `${parsed.pathname}${parsed.search}`;
  };

  const mint = async (extra: Record<string, unknown> = {}): Promise<Share> => {
    const r = await local('/api/share/link', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: boardId, ...extra }),
    });
    expect(r.status).toBe(200);
    return ((await r.json()) as { share: Share }).share;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'signed-link-'));
    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;

    const r = await local('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Signed links board' }),
    });
    expect(r.status).toBe(200);
    boardId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
    share = await mint({ label: 'primary fixture' });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('minting', () => {
    it('hands out /share/<id>?exp=<unix-seconds>&sig=<hex> with the expiry embedded', () => {
      const u = new URL(share.url);
      expect(u.hostname).toBe(PUBLIC_HOST);
      expect(u.pathname).toBe(`/share/${share.shareId}`);
      expect(Number(u.searchParams.get('exp'))).toBe(Math.floor(share.expiresAt / 1000));
      expect(u.searchParams.get('sig')).toMatch(/^[0-9a-f]{64}$/);
      // No slug: the signature is the credential now.
      expect(share.slug).toBeUndefined();
    });

    it('defaults to a two-week TTL — share links are temporary-use', () => {
      const days = (share.expiresAt - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThan(14.1);
    });

    it('keeps the signing key out of the repo-visible world: data dir, mode 600', () => {
      const keyPath = join(dataDir, URL_KEY_FILENAME);
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    });
  });

  describe('redemption validates the signature on every request', () => {
    it('exchanges a validly signed URL for a session and lands ON THE BOARD', async () => {
      const r = await pub(signedPath(share.url));
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(`/workspaces/${encodeURIComponent(boardId)}`);
      const cookie = r.headers.get('set-cookie') ?? '';
      expect(cookie).toContain(`${SHARE_COOKIE}=`);
      expect(cookie).toContain('HttpOnly');
      // The signed URL must not ride out in a Referer to anything downstream.
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    });

    it('refuses a tampered signature, id, or expiry — and gives nothing away', async () => {
      const u = new URL(share.url);
      const exp = u.searchParams.get('exp') ?? '';
      const sig = u.searchParams.get('sig') ?? '';
      const tampered = [
        // Signature flipped: right shape, wrong value.
        `/share/${share.shareId}?exp=${exp}&sig=${sig.replace(/^../, sig.startsWith('00') ? '11' : '00')}`,
        // Someone else's id under this signature.
        `/share/ffffffffffffffff?exp=${exp}&sig=${sig}`,
        // Expiry stretched a day past what was signed.
        `/share/${share.shareId}?exp=${Number(exp) + 86_400}&sig=${sig}`,
        // Unsigned entirely.
        `/share/${share.shareId}`,
        `/share/${share.shareId}?exp=${exp}`,
      ];
      const bodies = new Set<string>();
      for (const path of tampered) {
        const r = await pub(path);
        expect(r.status, path).toBe(404);
        bodies.add(await r.text());
      }
      // Every failure reads identically — tampered, unsigned, never-existed.
      expect(bodies.size).toBe(1);
      // Positive control: the untampered URL still redeems.
      expect((await pub(signedPath(share.url))).status).toBe(302);
    });

    it('refuses a signed URL whose share has EXPIRED in the registry', async () => {
      // The URL's own exp is still in the future — the registry is the
      // tighter bound, and it is re-checked after the signature. This is the
      // half the edge Worker cannot do, which is why the app never skips it.
      const s = await mint({ ttlSeconds: 3600 });
      const rec = handle.shares?.list().find((x) => x.shareId === s.shareId);
      expect(rec).toBeDefined();
      if (rec) rec.expiresAt = Date.now() - 1000;
      expect((await pub(signedPath(s.url))).status).toBe(404);
    });

    it('refuses a REVOKED share even with a valid signature — revocation stays app-layer', async () => {
      const s = await mint({ label: 'to be revoked' });
      // Positive control first: it redeems while live.
      expect((await pub(signedPath(s.url))).status).toBe(302);
      expect((await local(`/api/share/${s.shareId}`, { method: 'DELETE' })).status).toBe(200);
      // Same URL, signature still cryptographically valid — refused.
      expect((await pub(signedPath(s.url))).status).toBe(404);
    });

    it('a sub-path under /share/ is not the redeem shape and needs a session', async () => {
      expect((await pub(`${signedPath(share.url).replace('?', '/extra?')}`)).status).toBe(401);
    });
  });

  describe('TTL changes re-issue the URL', () => {
    it('setTtl hands back a fresh signed URL that redeems, with the new expiry embedded', async () => {
      const s = await mint({ ttlSeconds: 3600 });
      const r = await local(`/api/share/${s.shareId}/ttl`, {
        method: 'POST',
        body: JSON.stringify({ ttlSeconds: 7 * 24 * 3600 }),
      });
      expect(r.status).toBe(200);
      const updated = ((await r.json()) as { share: Share }).share;
      expect(updated.url).not.toBe(s.url);
      expect(Number(new URL(updated.url).searchParams.get('exp'))).toBe(
        Math.floor(updated.expiresAt / 1000),
      );
      expect((await pub(signedPath(updated.url))).status).toBe(302);
    });
  });

  describe('the old unsigned form is migrated, not honoured', () => {
    /** Make an existing record look like one minted before signing. */
    const legacify = (s: Share, slug: string): void => {
      const rec = handle.shares?.list().find((x) => x.shareId === s.shareId);
      expect(rec).toBeDefined();
      if (rec) {
        rec.slug = slug;
        rec.url = `https://${PUBLIC_HOST}/s/${slug}`;
      }
    };

    it('/s/<slug> no longer redeems — even for a record that still carries the slug', async () => {
      const s = await mint({ label: 'legacy shaped' });
      legacify(s, 'a'.repeat(32));
      const r = await pub(`/s/${'a'.repeat(32)}`);
      expect(r.status).toBe(404);
      // Indistinguishable from a slug that never existed.
      expect(await r.text()).toBe(await (await pub(`/s/${'f'.repeat(32)}`)).text());
    });

    it('listing serves that record a signed URL computed on demand, and it redeems', async () => {
      const s = await mint({ label: 'legacy migrates' });
      legacify(s, 'b'.repeat(32));
      const { shares: listed } = (await (await local('/api/share')).json()) as {
        shares: Share[];
      };
      const migrated = listed.find((x) => x.shareId === s.shareId);
      expect(migrated).toBeDefined();
      // The stored /s/ url is never served…
      expect(migrated?.url).toContain(`/share/${s.shareId}?exp=`);
      // …the record itself survives (soft behavior — nothing deleted)…
      expect(migrated?.workspaceId).toBe(boardId);
      // …and what it serves actually works.
      if (migrated) expect((await pub(signedPath(migrated.url))).status).toBe(302);
    });
  });
});
