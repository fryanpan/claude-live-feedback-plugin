/**
 * Link-mode sharing, driven through the real route table.
 *
 * The threat model is different from Access mode: the slug IS the
 * credential, so the tests below care about (a) the slug being exchanged
 * for a session exactly once, (b) everything else on the public host
 * requiring that session, (c) the session being scoped identically to an
 * Access visitor, and (d) revocation and expiry taking effect immediately
 * rather than when a browser cookie happens to lapse.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE, signSession } from '../src/share/link-session.ts';

const PUBLIC_HOST = 'feedback.example.com';

describe('link shares over HTTP', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;

  let docShare: { shareId: string; slug: string; url: string; expiresAt: number };
  let wsShare: { shareId: string; slug: string };
  let workspaceId: string;
  let entryDocId: string;

  const SOLO = 'solo-doc';
  const PRIVATE = 'private-doc';

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  /** A request to the public share host, optionally carrying a session. */
  const pub = (path: string, cookie?: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        host: PUBLIC_HOST,
        ...(cookie ? { cookie: `${SHARE_COOKIE}=${cookie}` } : {}),
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  /** Redeem a slug and return the session cookie value. */
  const redeem = async (slug: string): Promise<string> => {
    const r = await pub(`/s/${slug}`);
    expect(r.status).toBe(302);
    const setCookie = r.headers.get('set-cookie') ?? '';
    const m = setCookie.match(new RegExp(`${SHARE_COOKIE}=([^;]+)`));
    expect(m).not.toBeNull();
    return m?.[1] ?? '';
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'link-share-data-'));
    folder = mkdtempSync(join(tmpdir(), 'link-share-folder-'));
    mkdirSync(join(folder, 'sub'), { recursive: true });
    writeFileSync(join(folder, 'README.md'), '# Entry\n\nRead me.\n');
    writeFileSync(join(folder, 'design.md'), '# Design\n\nThe plan.\n');

    handle = createServer({
      port: 0,
      dataDir,
      // No cfAccess, no account id, no API token — link mode needs none.
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;

    for (const id of [SOLO, PRIVATE]) {
      const path = join(dataDir, `${id}.md`);
      writeFileSync(path, `# ${id}\n\nBody.\n`);
      const r = await local('/api/docs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: id, type: 'markdown', sourceUrl: path }),
      });
      expect(r.status).toBe(200);
    }

    const bind = await local('/api/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath: folder }),
    });
    const bound = (await bind.json()) as {
      workspaceId: string;
      files: Array<{ docId: string }>;
    };
    workspaceId = bound.workspaceId;
    entryDocId = bound.files[0]?.docId ?? '';

    const dr = await local('/api/share/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: SOLO, label: 'solo review' }),
    });
    expect(dr.status).toBe(200);
    docShare = ((await dr.json()) as { share: typeof docShare }).share;

    const wr = await local('/api/share/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId }),
    });
    expect(wr.status).toBe(200);
    wsShare = ((await wr.json()) as { share: typeof wsShare }).share;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  describe('minting', () => {
    it('needs no Cloudflare credentials and defaults to a one-week TTL', () => {
      const days = (docShare.expiresAt - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);
    });

    it('mints an unguessable slug', () => {
      expect(docShare.slug).toMatch(/^[0-9a-f]{32}$/); // 128 bits
      expect(wsShare.slug).not.toBe(docShare.slug);
    });

    it('points the URL at the public host', () => {
      expect(docShare.url).toBe(`https://${PUBLIC_HOST}/s/${docShare.slug}`);
    });

    it('honours a caller-supplied TTL', async () => {
      const r = await local('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: SOLO, ttlSeconds: 3600 }),
      });
      const { share } = (await r.json()) as { share: { expiresAt: number; shareId: string } };
      const hours = (share.expiresAt - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(0.9);
      expect(hours).toBeLessThan(1.1);
    });

    it('can extend or shorten a live share after the fact', async () => {
      const mk = await local('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: SOLO }),
      });
      const { share } = (await mk.json()) as { share: { shareId: string } };
      const r = await local(`/api/share/${share.shareId}/ttl`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ttlSeconds: 14 * 24 * 3600 }),
      });
      expect(r.status).toBe(200);
      const updated = (await r.json()) as { share: { expiresAt: number } };
      expect((updated.share.expiresAt - Date.now()) / 86_400_000).toBeGreaterThan(13.9);
      expect(
        (
          await local('/api/share/nope/ttl', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ttlSeconds: 60 }),
          })
        ).status,
      ).toBe(404);
    });

    it('refuses a doc or workspace that does not exist', async () => {
      const a = await local('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: 'ghost' }),
      });
      expect(a.status).toBe(404);
      const b = await local('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ghost-ws' }),
      });
      expect(b.status).toBe(404);
    });
  });

  describe('redemption', () => {
    it('exchanges the slug for a session and redirects to the doc', async () => {
      const r = await pub(`/s/${docShare.slug}`);
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe(`/review/${SOLO}`);
      const cookie = r.headers.get('set-cookie') ?? '';
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      // The slug must not ride out in a Referer to anything downstream.
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    });

    it('gives nothing away about which slugs exist', async () => {
      const unknown = await pub(`/s/${'0'.repeat(32)}`);
      const malformed = await pub('/s/not-a-slug');
      expect(unknown.status).toBe(404);
      expect(malformed.status).toBe(404);
      expect(await unknown.text()).toBe(await malformed.text());
    });
  });

  describe('the session is required', () => {
    it('refuses every other path on the public host without one', async () => {
      for (const p of [`/review/${SOLO}`, `/api/docs/${SOLO}`, '/api/docs', `/y/${SOLO}`]) {
        const r = await pub(p);
        expect(r.status, p).toBe(401);
      }
    });

    it('refuses a forged cookie', async () => {
      // Right shape, wrong key — the attacker doesn't have the HMAC secret.
      const forged = signSession(docShare.shareId, 'f'.repeat(64));
      expect((await pub(`/api/docs/${SOLO}`, forged)).status).toBe(401);
      expect((await pub(`/api/docs/${SOLO}`, `${docShare.shareId}.`)).status).toBe(401);
    });
  });

  describe('a redeemed session is scoped exactly like an Access visitor', () => {
    let cookie: string;
    beforeAll(async () => {
      cookie = await redeem(docShare.slug);
    });

    it('reaches its own doc', async () => {
      expect((await pub(`/api/docs/${SOLO}`, cookie)).status).toBe(200);
      expect((await pub(`/review/${SOLO}`, cookie)).status).not.toBe(403);
      expect((await pub(`/api/docs/${SOLO}/threads`, cookie)).status).toBe(200);
    });

    it('CANNOT reach another doc or enumerate', async () => {
      expect((await pub(`/api/docs/${PRIVATE}`, cookie)).status).toBe(403);
      expect((await pub(`/review/${PRIVATE}`, cookie)).status).toBe(403);
      expect((await pub('/api/docs', cookie)).status).toBe(403);
      expect((await pub('/api/workspaces', cookie)).status).toBe(403);
    });

    it('CANNOT mint itself a wider share', async () => {
      const r = await pub('/api/share/link', cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: PRIVATE }),
      });
      expect(r.status).toBe(403);
      expect((await pub('/api/share', cookie)).status).toBe(403);
    });

    it('CANNOT delete or wholesale-replace the doc it was given', async () => {
      expect((await pub(`/api/docs/${SOLO}`, cookie, { method: 'DELETE' })).status).toBe(403);
      const rewrite = await pub(`/api/docs/${SOLO}/content`, cookie, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ markdown: '# Wiped\n' }),
      });
      expect(rewrite.status).toBe(403);
    });
  });

  describe('a workspace link browses the whole set', () => {
    let cookie: string;
    beforeAll(async () => {
      cookie = await redeem(wsShare.slug);
    });

    it('opens the entry doc and lists the tree', async () => {
      expect((await pub(`/api/docs/${encodeURIComponent(entryDocId)}`, cookie)).status).toBe(200);
      expect(
        (await pub(`/api/workspaces/${encodeURIComponent(workspaceId)}/tree`, cookie)).status,
      ).toBe(200);
    });

    it('opens a sibling lazily and can then read it', async () => {
      const opened = await pub(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/editable-file`,
        cookie,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ relPath: 'design.md' }),
        },
      );
      expect(opened.status).toBe(200);
      const { docId } = (await opened.json()) as { docId: string };
      expect((await pub(`/api/docs/${encodeURIComponent(docId)}`, cookie)).status).toBe(200);
    });

    it('still cannot reach a doc outside the workspace', async () => {
      expect((await pub(`/api/docs/${PRIVATE}`, cookie)).status).toBe(403);
    });
  });

  describe('revocation and expiry are immediate', () => {
    it('a revoked share kills a session already in a browser', async () => {
      const mk = await local('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: SOLO }),
      });
      const { share } = (await mk.json()) as { share: { shareId: string; slug: string } };
      const cookie = await redeem(share.slug);
      expect((await pub(`/api/docs/${SOLO}`, cookie)).status).toBe(200);

      const del = await local(`/api/share/${share.shareId}`, { method: 'DELETE' });
      expect(del.status).toBe(200);

      // Same cookie, same browser — refused on the very next request.
      expect((await pub(`/api/docs/${SOLO}`, cookie)).status).toBe(401);
      // And the slug no longer redeems.
      expect((await pub(`/s/${share.slug}`)).status).toBe(404);
    });

    it('an expired share stops working without anyone touching the browser', async () => {
      const mk = await local('/api/share/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: SOLO, ttlSeconds: 60 }),
      });
      const { share } = (await mk.json()) as { share: { shareId: string; slug: string } };
      const cookie = await redeem(share.slug);
      expect((await pub(`/api/docs/${SOLO}`, cookie)).status).toBe(200);

      // Wind the expiry into the past via the TTL route's own validation
      // path — negative TTLs are refused, so expire it by re-issuing at 1s
      // and waiting is too slow; set it directly through the registry.
      const registry = handle.shares;
      expect(registry).not.toBeNull();
      const live = registry?.list().find((s) => s.shareId === share.shareId);
      expect(live).toBeDefined();
      if (live) live.expiresAt = Date.now() - 1000;

      expect((await pub(`/api/docs/${SOLO}`, cookie)).status).toBe(401);
      expect((await pub(`/s/${share.slug}`)).status).toBe(404);
    });
  });

  describe('the public host is still default-deny for everything else', () => {
    it('refuses an unrelated hostname', async () => {
      const r = await fetch(`${base}/api/docs`, { headers: { host: 'attacker.example.com' } });
      expect(r.status).toBe(403);
    });

    it('still serves the local agent unauthenticated', async () => {
      expect((await local('/api/docs')).status).toBe(200);
      expect((await local('/api/share')).status).toBe(200);
    });
  });
});
