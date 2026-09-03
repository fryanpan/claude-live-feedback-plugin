/**
 * The share registry itself — TTL arithmetic, and the scope a record must
 * carry to exist at all.
 *
 * Every fixture below names a workspace, because a workspace is the unit of
 * sharing (2026-08-17), and every fixture mints an ACCESS share, because that
 * is the only kind there is (link mode retired 2026-09-02). The assertions
 * are the ones this file always made — a TTL a share could not survive, an
 * expired share that must not come back, a record with no workspace — asked
 * of the mint that still exists. What a legacy record ALREADY on disk does is
 * the other half of that removal and lives in per-doc-share-removed.test.ts.
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCESS_NOT_CONFIGURED, Shares, audienceEntryAdmits } from '../src/share/shares.ts';
import { ACCESS_SHARE_CONFIG, mockCfApi } from './access-share.ts';

function makeShares() {
  const dataDir = mkdtempSync(join(tmpdir(), 'shares-ttl-'));
  const shares = new Shares({ dataDir, cfApi: mockCfApi(), config: ACCESS_SHARE_CONFIG });
  return { shares, dataDir, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

/** The narrowest share the registry mints: one board, one audience. */
const LINK = { workspaceId: 'ws1', allowDomains: ['@partner.example'] };

describe('TTL validation at the registry', () => {
  it('refuses values a link could never survive', async () => {
    const { shares, cleanup } = makeShares();
    try {
      // These can't arrive over JSON (NaN/Infinity serialize to null), but
      // an in-process caller can pass them.
      for (const ttlSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          shares.createShareWorkspace({ ...LINK, ttlSeconds }),
          String(ttlSeconds),
        ).rejects.toThrow(/positive, finite/);
      }
      // Positive control: the same call with a sane TTL mints, so the throws
      // above are the TTL check rather than the fixture being unmintable.
      expect(
        (await shares.createShareWorkspace({ ...LINK, ttlSeconds: 60 })).audience,
      ).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  it('refuses to extend an expired share, so a leaked URL stays dead', async () => {
    const { shares, cleanup } = makeShares();
    try {
      const share = await shares.createShareWorkspace({ ...LINK, ttlSeconds: 60 });
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

  it('extends a live share, measured from now — and leaves the URL alone', async () => {
    const { shares, cleanup } = makeShares();
    try {
      const share = await shares.createShareWorkspace({ ...LINK, ttlSeconds: 60 });
      const urlBefore = share.url;
      const extended = await shares.setTtl(share.shareId, 7200);
      expect(extended).not.toBeNull();
      const hours = ((extended?.expiresAt ?? 0) - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(1.9);
      expect(hours).toBeLessThan(2.1);
      // An Access share's URL is its hostname and the board it opens, so it
      // carries no expiry to re-sign. This used to re-issue a signed link URL;
      // that was the whole of what link mode was.
      expect(extended?.url).toBe(urlBefore);
    } finally {
      cleanup();
    }
  });

  it('defaults a share to a week', async () => {
    const { shares, cleanup } = makeShares();
    try {
      const share = await shares.createShareWorkspace(LINK);
      const days = (share.expiresAt - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);
    } finally {
      cleanup();
    }
  });

  it('needs Cloudflare Access wiring before it can mint anything', async () => {
    // Link mode was the fallback a deployment without a Cloudflare account
    // used to have. It is retired, so an unconfigured registry mints nothing
    // at all — and says which thing is missing rather than failing generically.
    const dataDir = mkdtempSync(join(tmpdir(), 'shares-nocf-'));
    try {
      const shares = new Shares({ dataDir, config: {} });
      expect(shares.createShareWorkspace(LINK)).rejects.toThrow(ACCESS_NOT_CONFIGURED);
      // Positive control: the identical call against a configured registry
      // mints, so the throw is the missing wiring and not the payload.
      const ok = makeShares();
      try {
        expect((await ok.shares.createShareWorkspace(LINK)).audience).toBeTruthy();
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
      expect(
        shares.createShareWorkspace({ allowDomains: ['@partner.example'] } as never),
      ).rejects.toThrow(/workspaceId is required/);
      // Validation precedes signing and saving, so the refusal left no grant.
      expect(shares.list()).toHaveLength(0);
      // Positive control: add the workspace and the same doc mints.
      expect((await shares.createShareWorkspace(LINK)).workspaceId).toBe('ws1');
    } finally {
      cleanup();
    }
  });

  it('mints a board share with no entry doc — a share opens the board', async () => {
    // There is no longer an entry-doc form to refuse. A board is the unit of
    // sharing, the share URL lands on `/workspaces/<id>`, and `docId` is a
    // landing address that no share written today fills in.
    const { shares, cleanup } = makeShares();
    try {
      const share = await shares.createShareWorkspace(LINK);
      expect(share.docId).toBe('');
      expect(share.workspaceId).toBe('ws1');
      expect(share.surface).toBe('workspace');
      expect(share.mode).toBeUndefined(); // access is the absent-mode default
      expect(share.url).toContain('/workspaces/ws1');
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

/**
 * The membership record the collaboration hostname reads.
 *
 * A share is the only place an email is written down against a workspace, so
 * these two functions are what "was this person given this board?" resolves
 * to. `audienceEntryAdmits` is the reading half of `accessPolicyRule` — one
 * tells Cloudflare who may reach a share hostname, the other tells our own
 * gate who may reach the same board over the collaboration hostname — so a
 * disagreement between them opens one door and not the other.
 */
describe('workspace membership', () => {
  it('lists only LIVE shares of exactly that workspace', async () => {
    const { shares, cleanup } = makeShares();
    try {
      const mine = await shares.createShareWorkspace({ ...LINK, ttlSeconds: 60 });
      await shares.createShareWorkspace({
        workspaceId: 'ws2',
        allowDomains: ['@other.example'],
        ttlSeconds: 60,
      });
      expect(shares.liveForWorkspace('ws1').map((s) => s.shareId)).toEqual([mine.shareId]);
      // Another board's share is not this board's membership.
      expect(shares.liveForWorkspace('ws2')).toHaveLength(1);
      expect(shares.liveForWorkspace('')).toHaveLength(0);

      // An expired share revokes the board it was minted for. A share's TTL
      // has to mean the same thing on both hostnames — otherwise expiry shuts
      // the share address and leaves the collaboration address open.
      mine.expiresAt = Date.now() - 1;
      expect(shares.liveForWorkspace('ws1')).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('matches a domain entry by domain and an address entry by address', () => {
    // A domain entry admits everyone at it…
    expect(audienceEntryAdmits('@partner.example', 'anyone@partner.example')).toBe(true);
    expect(audienceEntryAdmits('partner.example', 'ANYONE@Partner.Example')).toBe(true);
    expect(audienceEntryAdmits('@partner.example', 'anyone@other.example')).toBe(false);
    // …and never by suffix: a domain that merely ends with the entry is a
    // different domain, and reading it as a match hands the board to whoever
    // registers it.
    expect(audienceEntryAdmits('@partner.example', 'anyone@evil-partner.example')).toBe(false);
    expect(audienceEntryAdmits('@partner.example', 'anyone@sub.partner.example')).toBe(false);

    // An address entry admits that address only — never its neighbours.
    expect(audienceEntryAdmits('named@partner.example', 'named@partner.example')).toBe(true);
    expect(audienceEntryAdmits('Named@Partner.Example', 'named@partner.example')).toBe(true);
    expect(audienceEntryAdmits('named@partner.example', 'other@partner.example')).toBe(false);
  });

  it('admits nobody on an entry or an email that names nobody', () => {
    // The failure mode of a permissive parse here is a board open to every
    // admitted email on the deployment, so each of these answers false.
    for (const entry of ['', ' ', '@', 'named@partner.example']) {
      expect(audienceEntryAdmits(entry, ''), entry).toBe(false);
      expect(audienceEntryAdmits(entry, 'not-an-email'), entry).toBe(false);
      expect(audienceEntryAdmits(entry, '@partner.example'), entry).toBe(false);
    }
    expect(audienceEntryAdmits('', 'anyone@partner.example')).toBe(false);
    expect(audienceEntryAdmits('@', 'anyone@partner.example')).toBe(false);
    // Positive control: the same shape, with an entry and an email that do
    // name somebody.
    expect(audienceEntryAdmits('@partner.example', 'anyone@partner.example')).toBe(true);
  });
});
