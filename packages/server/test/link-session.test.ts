import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SHARE_COOKIE,
  loadCookieKey,
  readCookie,
  sessionCookieHeader,
  signSession,
  verifySession,
} from '../src/share/link-session.ts';

const KEY = 'a'.repeat(64);

describe('session signing', () => {
  it('round-trips a shareId', () => {
    const v = signSession('abc123', KEY);
    expect(verifySession(v, KEY)).toBe('abc123');
  });

  it('rejects a forged or tampered value', () => {
    const v = signSession('abc123', KEY);
    // Swap the shareId, keep the MAC — the classic forgery attempt.
    const forged = `victim.${v.slice(v.lastIndexOf('.') + 1)}`;
    expect(verifySession(forged, KEY)).toBeNull();
    expect(verifySession(`${v}x`, KEY)).toBeNull();
    expect(verifySession('abc123.', KEY)).toBeNull();
    expect(verifySession('nodots', KEY)).toBeNull();
    expect(verifySession('', KEY)).toBeNull();
    expect(verifySession(undefined, KEY)).toBeNull();
  });

  it('rejects a value signed with a different key', () => {
    expect(verifySession(signSession('abc123', KEY), 'b'.repeat(64))).toBeNull();
  });

  it('keeps shareIds distinct — one MAC does not open another share', () => {
    const a = signSession('share-a', KEY);
    expect(verifySession(a.replace('share-a', 'share-b'), KEY)).toBeNull();
  });
});

describe('cookie plumbing', () => {
  it('parses one cookie out of a crowded header', () => {
    const header = `other=1; ${SHARE_COOKIE}=xyz.mac; last=2`;
    expect(readCookie(header, SHARE_COOKIE)).toBe('xyz.mac');
    expect(readCookie(header, 'missing')).toBeUndefined();
    expect(readCookie(null, SHARE_COOKIE)).toBeUndefined();
  });

  it('sets the flags that keep a bearer session from leaking', () => {
    const h = sessionCookieHeader('abc123', KEY, 3600);
    expect(h).toContain('HttpOnly'); // no script can read it
    expect(h).toContain('Secure'); // HTTPS only
    expect(h).toContain('SameSite=Lax'); // survives a top-level click-through
    expect(h).toContain('Path=/');
    expect(h).toContain('Max-Age=3600');
  });

  it('clamps a negative Max-Age (already-expired share)', () => {
    expect(sessionCookieHeader('abc123', KEY, -50)).toContain('Max-Age=0');
  });
});

describe('key file', () => {
  it('generates once, is stable, and is mode 600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lf-cookie-key-'));
    try {
      const first = loadCookieKey(dir);
      expect(first.length).toBeGreaterThanOrEqual(32);
      expect(loadCookieKey(dir)).toBe(first); // reused, not regenerated
      const mode = statSync(join(dir, 'share-cookie.key')).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('differs per data dir', () => {
    const a = mkdtempSync(join(tmpdir(), 'lf-key-a-'));
    const b = mkdtempSync(join(tmpdir(), 'lf-key-b-'));
    try {
      expect(loadCookieKey(a)).not.toBe(loadCookieKey(b));
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
