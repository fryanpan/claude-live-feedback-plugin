import { describe, expect, it } from 'bun:test';
import { emailIdentityId } from '@feedback/core';
import {
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_REFRESH_AFTER_MS,
  clearedSessionCookieHeader,
  mintSession,
  refreshedSession,
  sessionCookieHeader,
  sessionKey,
  sessionNeedsRefresh,
  signSession,
  verifySession,
} from '../src/auth/session.ts';
import { signSession as signShareSession } from '../src/share/link-session.ts';

const KEY = sessionKey('a'.repeat(64));
const NOW = 1_800_000_000_000;
const ID = emailIdentityId('alice@example.com');

/** The pre-revocation format: 90 days of life baked into the value itself.
 *  Cookies like this are still out in the world on Bryan's devices, and the
 *  migration constraint is exactly this: they keep working until they expire
 *  or the browser drops them, with no machinery beyond continued acceptance. */
function v1Claims(issuedAt: number, expiresAt: number) {
  return { identityId: ID, sessionId: null, issuedAt, expiresAt };
}

describe('signing and verifying', () => {
  it('round-trips the claims', () => {
    const claims = mintSession(ID, NOW);
    const got = verifySession(signSession(claims, KEY), KEY, NOW);
    expect(got).toEqual(claims);
  });

  it('never expires by time — only revocation ends it', () => {
    const claims = mintSession(ID, NOW);
    const tenYearsOn = NOW + 10 * 365 * 24 * 60 * 60 * 1000;
    expect(verifySession(signSession(claims, KEY), KEY, tenYearsOn)).toEqual(claims);
  });

  it('gives every mint its own session id, so one logout cannot end another device', () => {
    const a = mintSession(ID, NOW);
    const b = mintSession(ID, NOW);
    expect(a.sessionId).toBeTruthy();
    expect(b.sessionId).toBeTruthy();
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it('refuses a tampered identity', () => {
    const value = signSession(mintSession(ID, NOW), KEY);
    const forged = value.replace(ID, emailIdentityId('mallory@example.com'));
    expect(forged).not.toBe(value);
    expect(verifySession(forged, KEY, NOW)).toBeNull();
  });

  it('refuses a tampered session id — a revoked id cannot be renamed back to life', () => {
    const claims = mintSession(ID, NOW);
    const value = signSession(claims, KEY);
    const forged = value.replace(String(claims.sessionId), 'x'.repeat(22));
    expect(forged).not.toBe(value);
    expect(verifySession(forged, KEY, NOW)).toBeNull();
  });

  it('refuses another key', () => {
    const value = signSession(mintSession(ID, NOW), KEY);
    expect(verifySession(value, sessionKey('b'.repeat(64)), NOW)).toBeNull();
  });

  it('refuses junk without throwing', () => {
    for (const junk of ['', 'x', 'v1.a.b', 'v1.a.b.c.d', '....', 'v3.x.1.2.sig']) {
      expect(verifySession(junk, KEY, NOW)).toBeNull();
    }
    expect(verifySession(undefined, KEY, NOW)).toBeNull();
    expect(verifySession(null, KEY, NOW)).toBeNull();
  });

  it('cannot be verified with a share cookie value, or vice versa', () => {
    // Same key FILE, domain-separated keys. A value minted for one protocol
    // must never verify under the other however the formats line up.
    const shared = 'a'.repeat(64);
    const shareValue = signShareSession('share-123', shared);
    expect(verifySession(shareValue, sessionKey(shared), NOW)).toBeNull();
    const sessionValue = signSession(mintSession(ID, NOW), sessionKey(shared));
    // The share verifier would have to accept our whole payload as a shareId.
    expect(sessionValue.startsWith('v2.')).toBe(true);
  });
});

describe('the old 90-day format, still out in the world', () => {
  it('accepts a v1 cookie that has life left, with no session id to revoke', () => {
    const claims = v1Claims(NOW, NOW + 1000);
    const got = verifySession(signSession(claims, KEY), KEY, NOW);
    expect(got).toEqual(claims);
  });

  it('still refuses a v1 cookie past its own expiry', () => {
    const claims = v1Claims(NOW - 2000, NOW - 1000);
    expect(verifySession(signSession(claims, KEY), KEY, NOW)).toBeNull();
    // Positive control: the same value before the expiry is fine.
    expect(verifySession(signSession(claims, KEY), KEY, NOW - 1500)).not.toBeNull();
  });

  it('refuses a v1 cookie whose expiry was extended', () => {
    const claims = v1Claims(NOW, NOW + 1000);
    const value = signSession(claims, KEY);
    const forged = value.replace(String(claims.expiresAt), String(claims.expiresAt + 1));
    expect(verifySession(forged, KEY, NOW)).toBeNull();
  });
});

describe('sliding refresh', () => {
  it('does not re-issue a cookie on every request', () => {
    const claims = mintSession(ID, NOW);
    expect(sessionNeedsRefresh(claims, NOW + 1000)).toBe(false);
  });

  it('re-issues once a day of the session is used', () => {
    const claims = mintSession(ID, NOW);
    expect(sessionNeedsRefresh(claims, NOW + SESSION_REFRESH_AFTER_MS)).toBe(true);
  });

  it('keeps the same session id across a refresh, so logout still ends this device', () => {
    const claims = mintSession(ID, NOW);
    const later = refreshedSession(claims, NOW + SESSION_REFRESH_AFTER_MS);
    expect(later.sessionId).toBe(claims.sessionId);
    expect(later.issuedAt).toBe(NOW + SESSION_REFRESH_AFTER_MS);
    expect(later.expiresAt).toBeNull();
  });

  it('upgrades a v1 cookie on refresh: it gains a session id and loses its expiry', () => {
    const old = v1Claims(NOW, NOW + 1000);
    const later = refreshedSession(old, NOW + 500);
    expect(later.sessionId).toBeTruthy();
    expect(later.expiresAt).toBeNull();
    expect(later.identityId).toBe(ID);
  });
});

describe('the Set-Cookie header', () => {
  it('carries Secure only when the request really arrived over https', () => {
    const claims = mintSession(ID, NOW);
    const https = sessionCookieHeader(claims, KEY, { secure: true, now: NOW });
    const http = sessionCookieHeader(claims, KEY, { secure: false, now: NOW });
    expect(https).toContain('; Secure');
    // Hardcode it and the plain-http tailnet and LAN sessions vanish silently.
    expect(http).not.toContain('Secure');
  });

  it('is HttpOnly, path-wide, and SameSite=Lax', () => {
    const header = sessionCookieHeader(mintSession(ID, NOW), KEY, { secure: true, now: NOW });
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Path=/');
    expect(header).toContain('SameSite=Lax');
    expect(header.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  });

  it('asks the browser to keep a revocable session as long as browsers allow', () => {
    // The SESSION has no expiry; the browser caps cookie lifetime (~400
    // days), and the daily sliding refresh keeps re-arming that cap.
    const header = sessionCookieHeader(mintSession(ID, NOW), KEY, { secure: false, now: NOW });
    expect(header).toContain(`Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`);
  });

  it('still sets Max-Age from the remaining life for an old-format cookie', () => {
    const claims = v1Claims(NOW, NOW + 60_000);
    const header = sessionCookieHeader(claims, KEY, { secure: false, now: NOW + 10_000 });
    expect(header).toContain('Max-Age=50');
  });

  it('clears with an empty value and Max-Age=0', () => {
    const header = clearedSessionCookieHeader({ secure: false });
    expect(header).toContain(`${SESSION_COOKIE}=;`);
    expect(header).toContain('Max-Age=0');
  });
});
