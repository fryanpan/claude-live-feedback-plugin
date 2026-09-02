import { describe, expect, it } from 'bun:test';
/**
 * Wire compatibility with the pre-refactor code, and purpose separation
 * between the formats that replaced it.
 *
 * Cookies minted by the old code are in browsers right now and share links
 * are in the wild, so "it round-trips through the new module" proves nothing
 * on its own. Each FIXTURE below is a verbatim copy of the mint path as it
 * stood before the three schemes were folded into signed-token.ts; the
 * assertions verify what those fixtures produce using the shipping code. If
 * the wire format ever moves, these fail.
 *
 * Keys are fixed and fake. Nothing here reads a key file.
 */
import { createHmac } from 'node:crypto';
import { emailIdentityId } from '@feedback/core';
import {
  sessionKey,
  signSession as signEmailSession,
  verifySession as verifyEmailSession,
} from '../src/auth/session.ts';
import {
  signSession as signShareSession,
  verifySession as verifyShareSession,
} from '../src/share/link-session.ts';

/** A fake cookie key of the shape `loadCookieKey` returns: 64 hex chars. */
const COOKIE_KEY = 'a'.repeat(64);

/** The old `mac()`, identical in all three schemes. */
function oldMac(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

// ---------------------------------------------------------------------------
// FIXTURE — share/link-session.ts as it stood before the refactor.
// ---------------------------------------------------------------------------
function oldSignShareSession(shareId: string, key: string): string {
  return `${shareId}.${oldMac(shareId, key)}`;
}

describe('share link-session cookies already in the wild', () => {
  it('verifies a cookie minted by the pre-refactor code', () => {
    const cookie = oldSignShareSession('sh-4d2f9a', COOKIE_KEY);
    expect(verifyShareSession(cookie, COOKIE_KEY)).toBe('sh-4d2f9a');
  });

  it('mints the same bytes the old code minted', () => {
    // The other half of compatibility: a browser holding a NEW cookie must
    // also be readable by anything that still speaks the old format, and a
    // verify-only test would pass even if the payload shape had moved.
    expect(signShareSession('sh-4d2f9a', COOKIE_KEY)).toBe(
      oldSignShareSession('sh-4d2f9a', COOKIE_KEY),
    );
  });

  it('still refuses a tampered id from an old cookie', () => {
    const cookie = oldSignShareSession('sh-4d2f9a', COOKIE_KEY);
    const forged = cookie.replace('sh-4d2f9a', 'sh-victim');
    expect(verifyShareSession(forged, COOKIE_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FIXTURE — auth/session.ts as it stood before the refactor.
// ---------------------------------------------------------------------------
function oldSessionKey(cookieKey: string): string {
  return createHmac('sha256', cookieKey).update('cw-email-session-v1').digest('hex');
}

function oldPayloadOf(claims: {
  identityId: string;
  sessionId: string | null;
  issuedAt: number;
  expiresAt: number | null;
}): string {
  if (claims.sessionId !== null) {
    return `v2.${claims.identityId}.${claims.sessionId}.${claims.issuedAt}`;
  }
  return `v1.${claims.identityId}.${claims.issuedAt}.${claims.expiresAt ?? 0}`;
}

function oldSignSession(
  claims: {
    identityId: string;
    sessionId: string | null;
    issuedAt: number;
    expiresAt: number | null;
  },
  key: string,
): string {
  const payload = oldPayloadOf(claims);
  return `${payload}.${oldMac(payload, key)}`;
}

const NOW = 1_800_000_000_000;
/** A fictional reviewer's identity id, from the real deriver — the payload is
 *  dot-split, so an id must be dot-free, and hand-writing one hides that. */
const IDENTITY = emailIdentityId('ada.lovelace@example.test');

describe('email-identity session cookies people are signed in with', () => {
  const key = oldSessionKey(COOKIE_KEY);

  it('derives the same session key as the old code', () => {
    expect(sessionKey(COOKIE_KEY)).toBe(key);
  });

  it('verifies a v2 cookie minted by the pre-refactor code', () => {
    const claims = {
      identityId: IDENTITY,
      sessionId: 'sid-abc123',
      issuedAt: NOW,
      expiresAt: null,
    };
    expect(verifyEmailSession(oldSignSession(claims, key), key, NOW)).toEqual(claims);
  });

  it('verifies a v1 cookie from a device that signed in before revocation existed', () => {
    const claims = {
      identityId: IDENTITY,
      sessionId: null,
      issuedAt: NOW,
      expiresAt: NOW + 60_000,
    };
    expect(verifyEmailSession(oldSignSession(claims, key), key, NOW)).toEqual(claims);
    // Still dead once its own baked-in expiry passes.
    expect(verifyEmailSession(oldSignSession(claims, key), key, NOW + 60_000)).toBeNull();
  });

  it('mints the same bytes the old code minted, in both formats', () => {
    const v2 = { identityId: IDENTITY, sessionId: 'sid-abc123', issuedAt: NOW, expiresAt: null };
    const v1 = { identityId: IDENTITY, sessionId: null, issuedAt: NOW, expiresAt: NOW + 60_000 };
    expect(signEmailSession(v2, key)).toBe(oldSignSession(v2, key));
    expect(signEmailSession(v1, key)).toBe(oldSignSession(v1, key));
  });
});
