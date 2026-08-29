/**
 * `POST /api/share/link` honours every argument it accepts and refuses every
 * one it does not — it never accepts-and-widens.
 *
 * The field report: `share_link(workspaceId, docId, ttl: "15m")` answered
 * 200 with `surface: "workspace"` and an expiry two weeks out. The caller
 * asked for one doc for fifteen minutes and got the whole board for
 * fourteen days, with no error. Both narrowing arguments were dropped on
 * the client (see packages/mcp/test/share-link-args.test.ts); this file is
 * the server half — whatever a bundle forwards, the route either honours
 * it or names it in a 4xx.
 *
 * Link mode only: no Cloudflare credentials, no network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Share, ShareConfig } from '../src/share/types.ts';

const PUBLIC_HOST = 'feedback.example.test';
const TWO_WEEKS = 14 * 24 * 3600;

describe('share_link arguments are honoured or refused, never dropped', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let boardId: string;

  const local = (path: string, body: unknown, method = 'POST') =>
    fetch(`${base}${path}`, {
      method,
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const listShares = async (): Promise<Share[]> => {
    const r = await fetch(`${base}/api/share`, { headers: { host: `localhost:${handle.port}` } });
    expect(r.status).toBe(200);
    return ((await r.json()) as { shares: Share[] }).shares;
  };

  const start = async (config: Partial<ShareConfig> = {}) => {
    dataDir = mkdtempSync(join(tmpdir(), 'share-link-args-'));
    handle = createServer({
      port: 0,
      dataDir,
      share: { config: { publicHostname: PUBLIC_HOST, ...config } },
    });
    base = `http://localhost:${handle.port}`;
    const board = await local('/api/workspaces', { name: 'Args board' });
    expect(board.status).toBe(200);
    boardId = ((await board.json()) as { workspace: { id: string } }).workspace.id;
    expect(boardId).toBeTruthy();
  };

  /** Seconds from now until the share expires, rounded. */
  const ttlOf = (share: Share): number => Math.round((share.expiresAt - Date.now()) / 1000);

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('with no max TTL configured', () => {
    beforeEach(() => start());

    it('a no-args call still mints a two-week board share (the pre-fix behaviour)', async () => {
      const r = await local('/api/share/link', { workspaceId: boardId });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { share: Share; ttlClamped?: unknown };
      expect(body.share.surface).toBe('workspace');
      expect(ttlOf(body.share)).toBeGreaterThan(TWO_WEEKS - 5);
      expect(ttlOf(body.share)).toBeLessThanOrEqual(TWO_WEEKS);
      expect(body.ttlClamped).toBeUndefined();
    });

    it('honours ttl as a duration string', async () => {
      for (const [ttl, seconds] of [
        ['15m', 15 * 60],
        ['2h', 2 * 3600],
        ['3d', 3 * 86400],
        ['1w', 7 * 86400],
        ['90s', 90],
      ] as const) {
        const r = await local('/api/share/link', { workspaceId: boardId, ttl });
        expect(r.status, ttl).toBe(200);
        const body = (await r.json()) as { share: Share; ttlClamped?: unknown };
        expect(ttlOf(body.share), ttl).toBeGreaterThan(seconds - 5);
        expect(ttlOf(body.share), ttl).toBeLessThanOrEqual(seconds);
        expect(body.ttlClamped, ttl).toBeUndefined();
      }
    });

    it('still honours ttlSeconds', async () => {
      const r = await local('/api/share/link', { workspaceId: boardId, ttlSeconds: 900 });
      expect(r.status).toBe(200);
      const { share } = (await r.json()) as { share: Share };
      expect(ttlOf(share)).toBeGreaterThan(895);
      expect(ttlOf(share)).toBeLessThanOrEqual(900);
    });

    it('refuses an unparsable ttl by value, and mints nothing', async () => {
      for (const ttl of ['fortnight', '15 minutes', '', '1.5h', '-15m', '15M']) {
        const r = await local('/api/share/link', { workspaceId: boardId, ttl });
        expect(r.status, JSON.stringify(ttl)).toBe(400);
        const body = (await r.json()) as { error: string; hint?: string };
        expect(body.error, JSON.stringify(ttl)).toBe('bad_ttl');
        expect(body.hint ?? '', JSON.stringify(ttl)).toContain('15m');
      }
      expect(await listShares()).toEqual([]);
    });

    it('refuses a zero ttl in either spelling — below the minimum is not a share', async () => {
      expect((await local('/api/share/link', { workspaceId: boardId, ttl: '0m' })).status).toBe(
        400,
      );
      expect((await local('/api/share/link', { workspaceId: boardId, ttlSeconds: 0 })).status).toBe(
        400,
      );
      expect(
        (await local('/api/share/link', { workspaceId: boardId, ttlSeconds: -1 })).status,
      ).toBe(400);
      expect(await listShares()).toEqual([]);
    });

    it('refuses a ttlSeconds that is not a number instead of falling back to the default', async () => {
      const r = await local('/api/share/link', { workspaceId: boardId, ttlSeconds: '900' });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('bad_ttl');
      expect(await listShares()).toEqual([]);
    });

    it('refuses ttl and ttlSeconds together rather than picking one', async () => {
      const r = await local('/api/share/link', {
        workspaceId: boardId,
        ttl: '15m',
        ttlSeconds: 3600,
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('bad_ttl');
      expect(await listShares()).toEqual([]);
    });

    it('refuses docId by name (a doc-scoped share is not a board share), and mints nothing', async () => {
      const r = await local('/api/share/link', {
        workspaceId: boardId,
        docId: 'security-review',
        ttl: '15m',
      });
      expect(r.status).toBe(410);
      expect(((await r.json()) as { error: string }).error).toBe('per_doc_sharing_removed');
      expect(await listShares()).toEqual([]);
    });

    it('refuses any argument it does not know, naming it', async () => {
      const r = await local('/api/share/link', { workspaceId: boardId, expiresIn: '15m' });
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: string; argument: string; hint: string };
      expect(body.error).toBe('unsupported_argument');
      expect(body.argument).toBe('expiresIn');
      expect(body.hint).toContain('ttl');
      expect(await listShares()).toEqual([]);

      // Positive control: the same call without the stray key mints.
      expect((await local('/api/share/link', { workspaceId: boardId })).status).toBe(200);
      expect((await listShares()).length).toBe(1);
    });
  });

  describe('with a max TTL of one hour configured', () => {
    beforeEach(() => start({ maxTtlSeconds: 3600 }));

    it('clamps a longer ttl to the max and says so in the response', async () => {
      const r = await local('/api/share/link', { workspaceId: boardId, ttl: '3d' });
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        share: Share;
        ttlClamped?: { requestedSeconds: number; appliedSeconds: number; maxSeconds: number };
      };
      expect(ttlOf(body.share)).toBeGreaterThan(3595);
      expect(ttlOf(body.share)).toBeLessThanOrEqual(3600);
      expect(body.ttlClamped).toEqual({
        requestedSeconds: 3 * 86400,
        appliedSeconds: 3600,
        maxSeconds: 3600,
      });
    });

    it('clamps the default too — a no-args call cannot exceed the max', async () => {
      const r = await local('/api/share/link', { workspaceId: boardId });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { share: Share; ttlClamped?: { requestedSeconds: number } };
      expect(ttlOf(body.share)).toBeLessThanOrEqual(3600);
      expect(body.ttlClamped?.requestedSeconds).toBe(TWO_WEEKS);
    });

    it('a ttl within the max is applied as asked, with no clamp note', async () => {
      const r = await local('/api/share/link', { workspaceId: boardId, ttl: '15m' });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { share: Share; ttlClamped?: unknown };
      expect(ttlOf(body.share)).toBeLessThanOrEqual(900);
      expect(ttlOf(body.share)).toBeGreaterThan(895);
      expect(body.ttlClamped).toBeUndefined();
    });

    it('set_share_ttl cannot extend a live share past the max either', async () => {
      const minted = await local('/api/share/link', { workspaceId: boardId, ttl: '15m' });
      const { share } = (await minted.json()) as { share: Share };
      const r = await local(`/api/share/${share.shareId}/ttl`, { ttlSeconds: 3 * 86400 });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { share: Share; ttlClamped?: { maxSeconds: number } };
      expect(ttlOf(body.share)).toBeLessThanOrEqual(3600);
      expect(ttlOf(body.share)).toBeGreaterThan(3595);
      expect(body.ttlClamped?.maxSeconds).toBe(3600);
    });
  });
});
