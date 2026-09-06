/**
 * Link mode is retired, and the records it left behind are kept.
 *
 * Until 2026-09-02 a share could be a signed URL: `/share/<id>?exp&sig`,
 * redeemed once for a `lf_share` cookie. Anyone holding the URL was inside,
 * which is exactly the hole the owner closed — *"every access including share
 * link or reading requires sign in"*. So the mint path is gone, both redeem
 * shapes are gone, and the session cookie is no longer a credential.
 *
 * What is NOT gone is the data. Removing a capability is not deleting user
 * content (CLAUDE.md, project-wide), so every link-mode record stays on disk,
 * stays listed, and stays revocable — it simply reports that it redeems
 * nowhere. This file is the whole retirement in one place: the refusals, the
 * records, and an Access share standing next to each of them so that no
 * assertion here can pass on a server that refuses everything.
 *
 * Fixtures are synthetic; the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE, loadCookieKey, signSession } from '../src/share/link-session.ts';
import type { ListedShare, Share } from '../src/share/types.ts';
import {
  ACCESS_BASE_HOSTNAME,
  type AccessHarness,
  type MintedShare,
  accessHarness,
  mintAccessShare,
} from './access-share.ts';

/** The hostname link mode served every share from. */
const RETIRED_HOST = 'feedback.example.test';
const SLUG = 'a'.repeat(32);

describe('link mode is retired', () => {
  let handle: ServerHandle;
  let access: AccessHarness;
  let dataDir: string;
  let base: string;
  let boardId: string;
  let docId: string;
  let live: MintedShare;

  /** The legacy record, written by hand — minting one is what no longer
   *  exists. Everything about it resolves except the mode. */
  const legacyRecord = (): Share => ({
    shareId: 'legacy-link-01',
    surface: 'workspace',
    mode: 'link',
    docId,
    workspaceId: boardId,
    slug: SLUG,
    hostname: RETIRED_HOST,
    url: `https://${RETIRED_HOST}/share/legacy-link-01?exp=99999999999&sig=${'0'.repeat(64)}`,
    label: 'a share from before the change',
    createdAt: Date.now(),
    expiresAt: Date.now() + 86_400_000,
  });

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        'content-type': 'application/json',
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const listShares = async (): Promise<ListedShare[]> =>
    ((await (await local('/api/share')).json()) as { shares: ListedShare[] }).shares;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'link-retired-'));
    const docPath = join(dataDir, 'note.md');
    writeFileSync(docPath, '# Note\n\nBody.\n');

    access = await accessHarness();
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://localhost:${handle.port}`;

    const board = await local('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'Retirement board' }),
    });
    expect(board.status).toBe(200);
    boardId = ((await board.json()) as { workspace: { id: string } }).workspace.id;

    docId = 'note';
    const doc = await local('/api/docs', {
      method: 'POST',
      body: JSON.stringify({ docId, type: 'markdown', sourceUrl: docPath }),
    });
    expect(doc.status).toBe(200);
    expect(
      (
        await local(`/workspaces/${boardId}/docs`, {
          method: 'POST',
          body: JSON.stringify({ docId }),
        })
      ).status,
    ).toBe(200);

    // Put the legacy record on disk, then restart onto it — the state an
    // upgraded server actually boots into.
    const existing = await listShares();
    await handle.stop();
    writeFileSync(
      join(dataDir, 'shares.json'),
      JSON.stringify([legacyRecord(), ...existing], null, 2),
    );
    handle = createServer({ port: 0, dataDir, ...access.serverOptions });
    base = `http://localhost:${handle.port}`;

    live = await mintAccessShare(base, access, boardId, { label: 'the replacement' });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('share_link now mints an Access share', () => {
    it('answers with a hostname and an audience, and no secret in the URL', async () => {
      const r = await local('/api/share/link', {
        method: 'POST',
        body: JSON.stringify({ workspaceId: boardId, allowDomains: ['@partner.example'] }),
      });
      expect(r.status).toBe(200);
      const { share } = (await r.json()) as {
        share: { mode?: string; hostname: string; audience: string; url: string; slug?: string };
      };
      expect(share.mode).not.toBe('link');
      expect(share.hostname.endsWith(`.${ACCESS_BASE_HOSTNAME}`)).toBe(true);
      expect(share.audience).toBeTruthy();
      expect(share.slug).toBeUndefined();
      const u = new URL(share.url);
      expect(u.hostname).toBe(share.hostname);
      expect(u.search).toBe(''); // nothing to leak in a Referer or a paste
    });
  });

  describe('the retired redeem shapes are gone', () => {
    const asVisitor = (path: string) =>
      fetch(`${base}${path}`, { headers: live.headers, redirect: 'manual' });

    it('refuses the redeem URL at Access, before the route is even reached', async () => {
      // The strongest version of the retirement: a stranger holding the
      // leaked URL and nothing else never gets an answer from the app at all.
      const stranger = await fetch(
        `${base}/share/legacy-link-01?exp=99999999999&sig=${'0'.repeat(64)}`,
        { headers: { host: live.host }, redirect: 'manual' },
      );
      expect(stranger.status).toBe(401);
    });

    it('refuses the redeem URL to a signed-in visitor too — it is out of scope', async () => {
      // Even the person the share was for cannot redeem it: a share visitor
      // is scoped to their board, and `/share/…` is not on it.
      expect(
        (await asVisitor(`/share/legacy-link-01?exp=99999999999&sig=${'0'.repeat(64)}`)).status,
      ).toBe(403);
      expect((await asVisitor(`/s/${SLUG}`)).status).toBe(403);
    });

    it('404s for the local caller, and tells a leaked id apart from no id at all', async () => {
      // Loopback is the one caller that reaches the route, so it is where the
      // shape of the answer can be read. A named 410 would tell whoever holds
      // a leaked URL that it was once real, so both are a plain 404 with the
      // same body.
      const real = await local(`/share/legacy-link-01?exp=99999999999&sig=${'0'.repeat(64)}`, {
        redirect: 'manual',
      });
      expect(real.status).toBe(404);
      expect(real.headers.get('referrer-policy')).toBe('no-referrer');

      const never = await local('/share/never-existed-at-all', { redirect: 'manual' });
      expect(never.status).toBe(404);
      expect(await real.text()).toBe(await never.text());

      const unsigned = await local(`/s/${SLUG}`, { redirect: 'manual' });
      expect(unsigned.status).toBe(404);
      expect(unsigned.headers.get('referrer-policy')).toBe('no-referrer');
    });

    it('POSITIVE CONTROL: the same host serves the board to the same visitor', async () => {
      // Without this, every 404 above would also pass on a server that had
      // stopped serving this hostname entirely.
      const ok = await fetch(`${base}/workspaces/${boardId}?format=json`, {
        headers: live.headers,
      });
      expect(ok.status).toBe(200);
    });
  });

  describe('a session cookie is no longer a credential', () => {
    it('refuses a validly signed cookie for the legacy share and for a live one', async () => {
      const key = loadCookieKey(dataDir);
      for (const shareId of ['legacy-link-01', live.shareId]) {
        const r = await fetch(`${base}/api/docs/${docId}`, {
          headers: { host: live.host, cookie: `${SHARE_COOKIE}=${signSession(shareId, key)}` },
        });
        // 401: Access sees no token at all. The cookie is never consulted.
        expect(r.status, shareId).toBe(401);
      }
      // POSITIVE CONTROL: the Access token on the same host reads that doc.
      expect((await fetch(`${base}/api/docs/${docId}`, { headers: live.headers })).status).toBe(
        200,
      );
    });
  });

  describe('the records are kept, and say they are retired', () => {
    it('lists the legacy share as not redeemable, beside a live one that is', async () => {
      const shares = await listShares();
      const legacy = shares.find((s) => s.shareId === 'legacy-link-01');
      expect(legacy).toBeDefined();
      expect(legacy?.redeemable).toBe(false);
      expect(legacy?.retired).toBe('link_mode');
      // The record itself is intact — an operator can still see what it was
      // and who it was for.
      expect(legacy?.workspaceId).toBe(boardId);
      expect(legacy?.label).toBe('a share from before the change');

      const alive = shares.find((s) => s.shareId === live.shareId);
      expect(alive?.redeemable).toBe(true);
      expect(alive?.retired).toBeUndefined();
    });

    it('no listed share is a redeemable link-mode share', async () => {
      const shares = await listShares();
      expect(shares.length).toBeGreaterThan(1); // control: we can see shares
      for (const s of shares) {
        if (s.mode === 'link') expect(s.redeemable).toBe(false);
      }
    });

    it('the legacy record is still revocable — retired is not unmanageable', async () => {
      const del = await local('/api/share/legacy-link-01', { method: 'DELETE' });
      expect(del.status).toBe(200);
      expect((await listShares()).find((s) => s.shareId === 'legacy-link-01')).toBeUndefined();
    });
  });
});
