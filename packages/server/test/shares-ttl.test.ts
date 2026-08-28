/**
 * The share registry itself — TTL arithmetic, and the scope a record must
 * carry to exist at all.
 *
 * Every fixture below names a workspace, because a workspace is the unit of
 * sharing (2026-08-17). The calls that used to pass a bare `{docId}` are
 * rewritten as workspace links with an entry doc, and the removal gets its
 * own assertions at the bottom: `createShareLink` refuses a request that
 * names no workspace. What a legacy record ALREADY on disk does is the other
 * half of that removal and lives in per-doc-share-removed.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  it('refuses values a link could never survive', async () => {
    const { shares, cleanup } = makeShares();
    try {
      // These can't arrive over JSON (NaN/Infinity serialize to null), but
      // an in-process caller can pass them.
      for (const ttlSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(shares.createShareLink({ ...LINK, ttlSeconds }), String(ttlSeconds)).rejects.toThrow(
          /positive, finite/,
        );
      }
      // Positive control: the same call with a sane TTL mints, so the throws
      // above are the TTL check rather than the fixture being unmintable.
      expect((await shares.createShareLink({ ...LINK, ttlSeconds: 60 })).url).toContain('sig=');
    } finally {
      cleanup();
    }
  });

  it('refuses to extend an expired share, so a leaked URL stays dead', async () => {
    const { shares, cleanup } = makeShares();
    try {
      const share = await shares.createShareLink({ ...LINK, ttlSeconds: 60 });
      expect(shares.findLive(share.shareId)).not.toBeNull();

      share.expiresAt = Date.now() - 1;
      expect(shares.findLive(share.shareId)).toBeNull();
      expect(await shares.setTtl(share.shareId, 3600)).toBeNull();
      // Still dead after the refused extension.
      expect(shares.findLive(share.shareId)).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('extends a live share, measured from now — and re-issues the signed URL', async () => {
    const { shares, cleanup } = makeShares();
    try {
      const share = await shares.createShareLink({ ...LINK, ttlSeconds: 60 });
      const urlBefore = share.url;
      const extended = await shares.setTtl(share.shareId, 7200);
      expect(extended).not.toBeNull();
      const hours = ((extended?.expiresAt ?? 0) - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(1.9);
      expect(hours).toBeLessThan(2.1);
      // The expiry is embedded in the URL, so moving it re-signs the URL.
      expect(extended?.url).not.toBe(urlBefore);
      expect(extended?.url).toContain(`/share/${share.shareId}?exp=`);
    } finally {
      cleanup();
    }
  });

  it('defaults a link to two weeks (temporary-use links)', async () => {
    const { shares, cleanup } = makeShares();
    try {
      const share = await shares.createShareLink(LINK);
      const days = (share.expiresAt - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(13.9);
      expect(days).toBeLessThan(14.1);
    } finally {
      cleanup();
    }
  });

  it('needs a public hostname before it can mint anything', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shares-nohost-'));
    try {
      const shares = new Shares({ dataDir, config: {} });
      expect(shares.createShareLink(LINK)).rejects.toThrow(/publicHostname/);
      // Positive control: the identical call against a configured registry
      // mints, so the throw is the missing hostname and not the payload.
      const ok = makeShares();
      try {
        expect((await ok.shares.createShareLink(LINK)).url).toContain('sig=');
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
 * nothing can mint. This block is the MINT half, at the registry layer where
 * `createShareLink` validates its argument — the other half (a legacy record
 * already on disk being dropped at `load()`) lives in
 * per-doc-share-removed.test.ts, which owns the removal end to end. Both
 * halves matter: the gate reads the registry rather than the code that wrote
 * it, so removing only the mint path would retire the feature everywhere
 * except where it is actually exercised.
 */
describe('a share must name a workspace', () => {
  it('refuses to mint a link with no workspace — and mints NOTHING on the way', async () => {
    const { shares, cleanup } = makeShares();
    try {
      expect(shares.createShareLink({ entryDocId: 'd1' } as never)).rejects.toThrow(
        /workspaceId is required/,
      );
      // Validation precedes signing and saving, so the refusal left no grant.
      expect(shares.list()).toHaveLength(0);
      // Positive control: add the workspace and the same doc mints.
      expect((await shares.createShareLink(LINK)).workspaceId).toBe('ws1');
    } finally {
      cleanup();
    }
  });

  it('mints a board link with no entry doc — a share opens the board', async () => {
    // There is no longer an entry-doc form to refuse. A board is the unit of
    // sharing, redemption lands on `/workspaces/<id>`, and `docId` is a
    // landing address that no share written today fills in.
    const { shares, cleanup } = makeShares();
    try {
      const share = await shares.createShareLink({ workspaceId: 'ws1' });
      expect(share.docId).toBe('');
      expect(share.workspaceId).toBe('ws1');
      expect(share.surface).toBe('workspace');
      // And no slug: the signed URL is the credential now.
      expect(share.slug).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

/**
 * The cf-access middleware asks the registry which Access audience a
 * hostname must satisfy. That answer must be TTL-aware on its own: it runs
 * before anything else has classified the host, so if it resolved an
 * expired share, a stale-but-valid Access JWT would keep matching a grant
 * that has lapsed. (host-scope.test.ts "an expired share host stops being a
 * share host" holds the request-level version of this property.)
 */
describe('audienceResolver ignores expired shares', () => {
  // The registry file is a bare array of records (see Shares.load).
  const accessRecord = (expiresAt: number) => [
    {
      shareId: 'aud-fixture',
      surface: 'workspace',
      docId: '',
      workspaceId: 'ws1',
      hostname: 'aud.example.test',
      url: 'https://aud.example.test/',
      audience: 'aud-tag-fixture',
      appId: 'app-fixture',
      createdAt: 1,
      expiresAt,
    },
  ];

  it('an expired access share resolves to no audience', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shares-aud-'));
    try {
      writeFileSync(join(dataDir, 'shares.json'), JSON.stringify(accessRecord(Date.now() - 1_000)));
      const shares = new Shares({ dataDir, config: {} });
      // The record loaded — expiry is a serve-time refusal, not a drop.
      expect(shares.list()).toHaveLength(1);
      expect(shares.audienceResolver('aud.example.test')).toBeNull();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('positive control: the same record, still live, resolves its audience', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'shares-aud-'));
    try {
      writeFileSync(
        join(dataDir, 'shares.json'),
        JSON.stringify(accessRecord(Date.now() + 60_000)),
      );
      const shares = new Shares({ dataDir, config: {} });
      expect(shares.audienceResolver('aud.example.test')).toBe('aud-tag-fixture');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
