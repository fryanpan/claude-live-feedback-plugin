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
  mintSession,
  sessionKey,
  signSession as signEmailSession,
  verifySession as verifyEmailSession,
} from '../src/auth/session.ts';
import { verifyToken } from '../src/auth/signed-token.ts';
import {
  WIDGET_TOKEN_TTL_MS,
  mintWidgetToken,
  verifyWidgetToken,
  widgetToken,
  widgetTokenKey,
} from '../src/auth/widget-token.ts';
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

// ---------------------------------------------------------------------------
// FIXTURE — auth/widget-token.ts as it stood before the refactor.
// ---------------------------------------------------------------------------
function oldWidgetTokenKey(cookieKey: string): string {
  return createHmac('sha256', cookieKey).update('cw-widget-token-v1').digest('hex');
}

function oldMintWidgetToken(
  session: { identityId: string; sessionId: string | null; issuedAt: number },
  origin: string,
  key: string,
  now: number,
): string | null {
  if (session.sessionId === null) return null;
  const payload = [
    'wt1',
    session.identityId,
    session.sessionId,
    session.issuedAt,
    now + WIDGET_TOKEN_TTL_MS,
    Buffer.from(origin).toString('base64url'),
  ].join('.');
  return `${payload}.${oldMac(payload, key)}`;
}

/** The dev-server origin a token is bound to — the only page that may use it. */
const ORIGIN = 'http://127.0.0.1:5173';

describe('widget tokens minted before the refactor', () => {
  const key = oldWidgetTokenKey(COOKIE_KEY);
  const session = { identityId: IDENTITY, sessionId: 'sid-abc123', issuedAt: NOW, expiresAt: null };

  it('derives the same widget-token key as the old code', () => {
    expect(widgetTokenKey(COOKIE_KEY)).toBe(key);
  });

  it('verifies a token minted by the pre-refactor code, origin binding intact', () => {
    const token = oldMintWidgetToken(session, ORIGIN, key, NOW);
    expect(verifyWidgetToken(token, key, NOW)).toEqual({
      identityId: IDENTITY,
      sessionId: 'sid-abc123',
      sessionIssuedAt: NOW,
      expiresAt: NOW + WIDGET_TOKEN_TTL_MS,
      origin: ORIGIN,
    });
  });

  it('still expires an old token on the same seven-day clock', () => {
    const token = oldMintWidgetToken(session, ORIGIN, key, NOW);
    expect(verifyWidgetToken(token, key, NOW + WIDGET_TOKEN_TTL_MS)).toBeNull();
    // Positive control: one millisecond earlier it is still good.
    expect(verifyWidgetToken(token, key, NOW + WIDGET_TOKEN_TTL_MS - 1)).not.toBeNull();
  });

  it('mints the same bytes the old code minted', () => {
    expect(mintWidgetToken(session, ORIGIN, key, NOW)).toBe(
      oldMintWidgetToken(session, ORIGIN, key, NOW),
    );
    // A second origin whose length is not a multiple of three, so plain
    // base64 would pad it and base64url does not. The loopback origin above
    // encodes identically under both, and on its own would let the encoding
    // change without a test noticing.
    const padded = 'https://app.example.test:5173';
    expect(Buffer.from(padded).toString('base64')).not.toBe(
      Buffer.from(padded).toString('base64url'),
    );
    expect(mintWidgetToken(session, padded, key, NOW)).toBe(
      oldMintWidgetToken(session, padded, key, NOW),
    );
  });
});

describe('purpose separation', () => {
  // One key file on disk. What keeps the three protocols apart is the derived
  // key plus the version tag, and a value that crossed over would be an
  // authorization bug rather than a parse error.
  const shareKey = COOKIE_KEY;
  const emailKey = sessionKey(COOKIE_KEY);
  const widgetKey = widgetTokenKey(COOKIE_KEY);
  const session = mintSession(IDENTITY, NOW);

  it('gives each purpose a different key', () => {
    expect(new Set([shareKey, emailKey, widgetKey]).size).toBe(3);
  });

  it('refuses a session cookie presented as a share cookie, and the reverse', () => {
    const sessionCookie = signEmailSession(session, emailKey);
    const shareCookie = signShareSession('sh-4d2f9a', shareKey);
    expect(verifyShareSession(sessionCookie, shareKey)).toBeNull();
    expect(verifyEmailSession(shareCookie, emailKey, NOW)).toBeNull();
    // Positive control: each verifies under its own purpose.
    expect(verifyShareSession(shareCookie, shareKey)).toBe('sh-4d2f9a');
    expect(verifyEmailSession(sessionCookie, emailKey, NOW)).not.toBeNull();
  });

  it('refuses a widget token presented as a session cookie, and the reverse', () => {
    const token = mintWidgetToken(session, ORIGIN, widgetKey, NOW) as string;
    const sessionCookie = signEmailSession(session, emailKey);
    expect(verifyEmailSession(token, emailKey, NOW)).toBeNull();
    expect(verifyWidgetToken(sessionCookie, widgetKey, NOW)).toBeNull();
    expect(verifyWidgetToken(token, widgetKey, NOW)).not.toBeNull();
  });

  it('refuses a widget token presented as a share cookie, and the reverse', () => {
    const token = mintWidgetToken(session, ORIGIN, widgetKey, NOW) as string;
    const shareCookie = signShareSession('sh-4d2f9a', shareKey);
    expect(verifyShareSession(token, shareKey)).toBeNull();
    expect(verifyWidgetToken(shareCookie, widgetKey, NOW)).toBeNull();
  });

  it('refuses a value whose payload was re-signed under another purpose key', () => {
    // The sharper test: not a stray value, but an attacker who holds one
    // protocol's key and re-signs their payload for another. Only the tag
    // stands between the two once the MAC checks out.
    const emailPayload = signEmailSession(session, emailKey);
    const payload = emailPayload.slice(0, emailPayload.lastIndexOf('.'));
    const resigned = `${payload}.${createHmac('sha256', widgetKey).update(payload).digest('base64url')}`;
    expect(verifyWidgetToken(resigned, widgetKey, NOW)).toBeNull();
    // And it is the version tag that refused it, not an accidental field
    // count: a null answer alone would not say which check did the work.
    expect(verifyToken(widgetToken, resigned, widgetKey, NOW)).toEqual({
      ok: false,
      reason: 'wrong_purpose',
    });
  });
});
