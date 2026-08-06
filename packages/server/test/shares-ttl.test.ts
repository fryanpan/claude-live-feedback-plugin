import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Shares } from '../src/share/shares.ts';

function makeShares() {
  const dataDir = mkdtempSync(join(tmpdir(), 'shares-ttl-'));
  const shares = new Shares({
    dataDir,
    config: { publicHostname: 'feedback.example.com' },
  });
  return { shares, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

describe('TTL validation at the registry', () => {
  it('refuses values a link could never survive', () => {
    const { shares, cleanup } = makeShares();
    try {
      // These can't arrive over JSON (NaN/Infinity serialize to null), but
      // an in-process caller can pass them.
      for (const ttlSeconds of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          () => shares.createShareLink({ docId: 'd1', ttlSeconds }),
          String(ttlSeconds),
        ).toThrow(/positive, finite/);
      }
    } finally {
      cleanup();
    }
  });

  it('refuses to extend an expired share, so a leaked URL stays dead', () => {
    const { shares, cleanup } = makeShares();
    try {
      const share = shares.createShareLink({ docId: 'd1', ttlSeconds: 60 });
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
      const share = shares.createShareLink({ docId: 'd1', ttlSeconds: 60 });
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
      expect(() => shares.createShareLink({ docId: 'd1' })).toThrow(/publicHostname/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
