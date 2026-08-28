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
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** `<shareId>.<hmac>` — opaque to the client, unforgeable without the key. */
export function signSession(shareId: string, key: string): string {
  return `${shareId}.${mac(shareId, key)}`;
}

/**
 * Verify a cookie value and return the shareId it attests to, or null.
 * Comparison is timing-safe so a caller can't grind out a valid MAC.
 */
export function verifySession(value: string | undefined | null, key: string): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const shareId = value.slice(0, dot);
  const provided = value.slice(dot + 1);
  const expected = mac(shareId, key);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? shareId : null;
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

function mac(shareId: string, key: string): string {
  return createHmac('sha256', key).update(shareId).digest('base64url');
}
