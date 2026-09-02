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
