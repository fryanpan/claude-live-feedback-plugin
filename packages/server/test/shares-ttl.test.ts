/**
 * The share registry itself — TTL arithmetic, and the scope a record must
 * carry to exist at all.
 *
 * Every fixture below names a workspace, because a workspace is the unit of
 * sharing (2026-08-17). The calls that used to pass a bare `{docId}` are
 * rewritten as workspace links with an entry doc, and the removal gets its
 * own assertions: `createShareLink` refuses a workspace-less request, and
 * `load()` drops a legacy doc-scoped record rather than keep honouring a
 * grant nothing can mint.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Shares } from '../src/share/shares.ts';

function makeShares() {
  const dataDir = mkdtempSync(join(tmpdir(), 'shares-ttl-'));
  const shares = new Shares({
    dataDir,
    config: { publicHostname: 'feedback.example.com' },
  });
  return { shares, dataDir, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

/** The narrowest link the registry still mints: a workspace, opening on one
 *  of its docs. */
const LINK = { workspaceId: 'ws1', entryDocId: 'd1' };

describe('TTL validation at the registry', () => {
  it('refuses values a link could never survive', () => {
    const { shares, cleanup } = makeShares();
    try {
      // These can't arrive over JSON (NaN/Infinity serialize to null), but
      // an in-process caller can pass them.
      for (const ttlSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => shares.createShareLink({ ...LINK, ttlSeconds }), String(ttlSeconds)).toThrow(
          /positive, finite/,
        );
      }
      // Positive control: the same call with a sane TTL mints, so the throws
      // above are the TTL check rather than the fixture being unmintable.
      expect(shares.createShareLink({ ...LINK, ttlSeconds: 60 }).slug).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('refuses to extend an expired share, so a leaked URL stays dead', () => {
    const { shares, cleanup } = makeShares();
    try {
      const share = shares.createShareLink({ ...LINK, ttlSeconds: 60 });
      expect(shares.findBySlug(share.slug ?? '')).not.toBeNull();

      share.expiresAt = Date.now() - 1;
      expect(shares.findBySlug(share.slug ?? '')).toBeNull();
      expect(shares.setTtl(share.shareId, 3600)).toBeNull();
      // Still dead after the refused extension.
      expect(shares.findBySlug(share.slug ?? '')).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('extends a live share, measured from now', () => {
    const { shares, cleanup } = makeShares();
    try {
      const share = shares.createShareLink({ ...LINK, ttlSeconds: 60 });
      const extended = shares.setTtl(share.shareId, 7200);
      expect(extended).not.toBeNull();
      const hours = ((extended?.expiresAt ?? 0) - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(1.9);
      expect(hours).toBeLessThan(2.1);
    } finally {
      cleanup();
    }
  });

  it('needs a public hostname before it can mint anything', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shares-nohost-'));
    try {
      const shares = new Shares({ dataDir, config: {} });
      expect(() => shares.createShareLink(LINK)).toThrow(/publicHostname/);
      // Positive control: the identical call against a configured registry
      // mints, so the throw is the missing hostname and not the payload.
      const ok = makeShares();
      try {
        expect(ok.shares.createShareLink(LINK).slug).toBeTruthy();
      } finally {
        ok.cleanup();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

/**
 * A workspace is the unit of sharing, so a record without one names a grant
 * nothing can mint. Two halves, and shipping either alone would be wrong:
 * the mint path refuses new ones, and `load()` drops the ones already on
 * disk — because the gate reads the registry rather than the code that wrote
 * it, so leaving those standing would retire the feature everywhere except
 * where it is actually exercised.
 */
describe('a share must name a workspace', () => {
  it('refuses to mint a link with no workspace', () => {
    const { shares, cleanup } = makeShares();
    try {
      expect(() => shares.createShareLink({ entryDocId: 'd1' } as never)).toThrow(
        /workspaceId is required/,
      );
      // Positive control: add the workspace and the same doc mints.
      expect(shares.createShareLink(LINK).workspaceId).toBe('ws1');
    } finally {
      cleanup();
    }
  });

  it('refuses a workspace link with nowhere to land, unless it is a hub share', () => {
    const { shares, cleanup } = makeShares();
    try {
      expect(() => shares.createShareLink({ workspaceId: 'ws1' })).toThrow(
        /entryDocId is required/,
      );
      // A hub share deliberately has no entry doc — it opens the board.
      const hub = shares.createShareLink({ workspaceId: 'ws1', hub: true });
      expect(hub.docId).toBe('');
      expect(hub.workspaceId).toBe('ws1');
    } finally {
      cleanup();
    }
  });

  it('drops a legacy doc-scoped record on load, and keeps the workspace one', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shares-legacy-'));
    try {
      const now = Date.now();
      writeFileSync(
        join(dataDir, 'shares.json'),
        JSON.stringify([
          // Written before workspaces were the unit of sharing: scope was
          // the docId alone, and there is no workspaceId at all.
          {
            shareId: 'legacy01',
            surface: 'doc',
            mode: 'link',
            docId: 'd1',
            slug: 'a'.repeat(32),
            hostname: 'feedback.example.com',
            url: `https://feedback.example.com/s/${'a'.repeat(32)}`,
            createdAt: now,
            expiresAt: now + 86_400_000,
          },
          {
            shareId: 'current1',
            surface: 'workspace',
            mode: 'link',
            docId: 'd2',
            workspaceId: 'ws1',
            slug: 'b'.repeat(32),
            hostname: 'feedback.example.com',
            url: `https://feedback.example.com/s/${'b'.repeat(32)}`,
            createdAt: now,
            expiresAt: now + 86_400_000,
          },
        ]),
      );
      const shares = new Shares({
        dataDir,
        config: { publicHostname: 'feedback.example.com' },
      });
      // Positive control FIRST: the loader can see this file at all — the
      // workspace record came through, live and redeemable.
      expect(shares.list().map((s) => s.shareId)).toEqual(['current1']);
      expect(shares.findBySlug('b'.repeat(32))?.shareId).toBe('current1');
      // …and the doc-scoped one is revoked, on every lookup the gate uses.
      expect(shares.findBySlug('a'.repeat(32))).toBeNull();
      expect(shares.findLive('legacy01')).toBeNull();

      // The drop is written back, so a later process does not re-read it.
      const onDisk = JSON.parse(readFileSync(join(dataDir, 'shares.json'), 'utf8')) as Array<{
        shareId: string;
      }>;
      expect(onDisk.map((s) => s.shareId)).toEqual(['current1']);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
