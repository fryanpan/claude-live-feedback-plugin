/**
 * Link-mode sessions.
 *
 * A signed capability URL (`/share/<id>?exp=…&sig=…`) is redeemed ONCE for a
 * signed cookie; every later request — including the Yjs websocket upgrade —
 * is authorized from that cookie. This is the same shape Cloudflare Access
 * uses, and it exists for the same reason: the review app fetches
 * `/api/docs/<id>` and `/y/<id>` at the ROOT, so the signed URL would be gone
 * by the second request. Carrying the session in a cookie means zero client
 * changes.
 *
 * The cookie holds only the shareId plus an HMAC over it. It deliberately
 * does NOT carry an expiry: the share's own `expiresAt` is re-checked on
 * every request, so revoking or expiring a share takes effect immediately
 * rather than whenever a browser's cookie happens to lapse.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TokenFormat, mintToken, tokenClaims } from '../auth/signed-token.ts';

export const SHARE_COOKIE = 'lf_share';
const KEY_FILENAME = 'share-cookie.key';

/**
 * Load the HMAC key, generating it on first use. Mode 600 — anyone who can
 * read it can mint a session for any share.
 */
export function loadCookieKey(dataDir: string): string {
  const path = join(dataDir, KEY_FILENAME);
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const key = randomBytes(32).toString('hex');
  writeFileSync(path, key, { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // pre-existing file keeps its old mode otherwise
  } catch {}
  return key;
}

/**
 * `<shareId>.<hmac>` — the whole payload is the share id.
 *
 * Three things this format does NOT have, each on purpose. No version tag:
 * the payload is data, so a share id containing dots stays whole (which is
 * why the shared module signs a payload string rather than a field list). No
 * expiry in the value: the share's own `expiresAt` is re-checked per request,
 * so revocation is immediate. And no derived key — this cookie predates
 * domain separation and the ones already in browsers are signed with the key
 * file's own bytes, so `keyDomain` is a wire lock rather than an omission.
 */
export const shareSessionToken: TokenFormat<string> = {
  keyDomain: null,
  tags: null,
  encode: (shareId) => shareId,
  decode: (payload) => payload,
  expiresAt: () => null,
};

/** Opaque to the client, unforgeable without the key. */
export function signSession(shareId: string, key: string): string {
  return mintToken(shareSessionToken, shareId, key);
}

/**
 * Verify a cookie value and return the shareId it attests to, or null.
 * Comparison is timing-safe so a caller can't grind out a valid MAC.
 */
export function verifySession(value: string | undefined | null, key: string): string | null {
  return tokenClaims(shareSessionToken, value, key);
}

/** Pull one cookie out of a Cookie header. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Set-Cookie for a redeemed link. HttpOnly (no script can read it), Secure
 * (the share host is HTTPS-only through the tunnel), SameSite=Lax so the
 * top-level navigation from a chat message or mail client still carries it.
 */
export function sessionCookieHeader(shareId: string, key: string, maxAgeSeconds: number): string {
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  return [
    `${SHARE_COOKIE}=${signSession(shareId, key)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; ');
}
