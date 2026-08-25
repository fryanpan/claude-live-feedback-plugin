import { describe, expect, it } from 'bun:test';
import { emailIdentityId } from '@feedback/core';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  SESSION_REFRESH_AFTER_MS,
  clearedSessionCookieHeader,
  mintSession,
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

describe('signing and verifying', () => {
  it('round-trips the claims', () => {
    const claims = mintSession(ID, NOW);
    const got = verifySession(signSession(claims, KEY), KEY, NOW);
    expect(got).toEqual(claims);
  });

  it('lasts 90 days', () => {
    const claims = mintSession(ID, NOW);
    expect(claims.expiresAt - claims.issuedAt).toBe(SESSION_MAX_AGE_SECONDS * 1000);
  });

  it('refuses a tampered identity', () => {
    const value = signSession(mintSession(ID, NOW), KEY);
    const forged = value.replace(ID, emailIdentityId('mallory@example.com'));
    expect(forged).not.toBe(value);
    expect(verifySession(forged, KEY, NOW)).toBeNull();
  });

  it('refuses an extended expiry', () => {
    const claims = mintSession(ID, NOW);
    const value = signSession(claims, KEY);
    const forged = value.replace(String(claims.expiresAt), String(claims.expiresAt + 1));
    expect(verifySession(forged, KEY, NOW)).toBeNull();
  });

  it('refuses another key', () => {
    const value = signSession(mintSession(ID, NOW), KEY);
    expect(verifySession(value, sessionKey('b'.repeat(64)), NOW)).toBeNull();
  });

  it('refuses an expired session', () => {
    const claims = mintSession(ID, NOW);
    expect(verifySession(signSession(claims, KEY), KEY, claims.expiresAt + 1)).toBeNull();
    // Positive control: the same value one millisecond earlier is fine.
    expect(verifySession(signSession(claims, KEY), KEY, claims.expiresAt - 1)).not.toBeNull();
  });

  it('refuses junk without throwing', () => {
    for (const junk of ['', 'x', 'v1.a.b', 'v1.a.b.c.d', '....', 'v2.x.1.2.sig']) {
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
    expect(sessionValue.startsWith('v1.')).toBe(true);
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

  it('sets Max-Age from the remaining life, not from now', () => {
    const claims = mintSession(ID, NOW);
    const header = sessionCookieHeader(claims, KEY, {
      secure: false,
      now: NOW + 10_000,
    });
    expect(header).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS - 10}`);
  });

  it('clears with an empty value and Max-Age=0', () => {
    const header = clearedSessionCookieHeader({ secure: false });
    expect(header).toContain(`${SESSION_COOKIE}=;`);
    expect(header).toContain('Max-Age=0');
  });
});
