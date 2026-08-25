/**
 * The email-identity session cookie.
 *
 * Shaped after `share/link-session.ts` — same HMAC, same key file, same
 * timing-safe compare — with three deliberate differences.
 *
 * 1. **It carries an expiry, and the share cookie does not.** A share is
 *    re-checked against its own `expiresAt` on every request, so its cookie
 *    can be open-ended. A person's session has no such record behind it; the
 *    lifetime is the cookie's, and it is 90 days, extended on use.
 *
 * 2. **`Secure` is derived, never hardcoded.** The server's own socket is
 *    always plain http, so `new URL(req.url).protocol` never tells you the
 *    client's scheme — and both origins stay reachable: https through
 *    `tailscale serve`, plain http on `http://<host>:8787` and the LAN.
 *    Hardcode the flag and the http sessions vanish silently; omit it and the
 *    https ones lose it. So the caller passes `secure`, computed from the
 *    same validated forwarded scheme `policyFor` already derives (including
 *    the allowlist that stops `x-forwarded-proto` injection).
 *
 * 3. **The key is domain-separated from the share cookie's.** Same key file
 *    (`loadCookieKey`), different derived key, so a value minted for one
 *    protocol can never verify under the other however the two formats
 *    happen to line up.
 *
 * Revocation lives in the roster, not here: a session names an identity and
 * an issue time, and `Identities.sessionsValidFrom` is the watermark that
 * refuses everything minted before it. That is what makes a 90-day cookie
 * safe to hand out — it can be ended from the server without waiting for it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'cw_session';

/** 90 days, Bryan's pick. Sliding: see `sessionNeedsRefresh`. */
export const SESSION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

/**
 * How much of a session's life may elapse before a request re-issues the
 * cookie. A day, so an active reviewer's session never lapses while a
 * `Set-Cookie` on literally every response would be noise.
 */
export const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

const VERSION = 'v1';

export interface SessionClaims {
  identityId: string;
  /** ms epoch — checked against the roster's revocation watermark. */
  issuedAt: number;
  /** ms epoch. */
  expiresAt: number;
}

/**
 * The session key, derived from the shared cookie key.
 *
 * One key file on disk (mode 600, `loadCookieKey`), two protocols that must
 * never verify each other's values.
 */
export function sessionKey(cookieKey: string): string {
  return createHmac('sha256', cookieKey).update('cw-email-session-v1').digest('hex');
}

/** `v1.<identityId>.<issuedAt>.<expiresAt>.<mac>` — opaque to the client. */
export function signSession(claims: SessionClaims, key: string): string {
  const payload = payloadOf(claims);
  return `${payload}.${mac(payload, key)}`;
}

/**
 * The claims a cookie attests to, or null.
 *
 * Null for anything that is not ours, does not verify, or has expired — the
 * caller cannot tell those apart, and should not: every one of them means
 * "no session".
 */
export function verifySession(
  value: string | undefined | null,
  key: string,
  now: number = Date.now(),
): SessionClaims | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const provided = value.slice(dot + 1);
  const expected = mac(payload, key);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  const parts = payload.split('.');
  if (parts.length !== 4) return null;
  const [version, identityId, issuedRaw, expiresRaw] = parts;
  if (version !== VERSION || !identityId) return null;
  const issuedAt = Number(issuedRaw);
  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return null;
  if (expiresAt <= now) return null;
  return { identityId, issuedAt, expiresAt };
}

/** Whether a live session has used enough of its life to be re-issued. */
export function sessionNeedsRefresh(claims: SessionClaims, now: number = Date.now()): boolean {
  return now - claims.issuedAt >= SESSION_REFRESH_AFTER_MS;
}

/** Fresh claims for an identity — a login, or the sliding extension. */
export function mintSession(identityId: string, now: number = Date.now()): SessionClaims {
  return {
    identityId,
    issuedAt: now,
    expiresAt: now + SESSION_MAX_AGE_SECONDS * 1000,
  };
}

/**
 * `Set-Cookie` for a session. HttpOnly (no script reads it, and the widget
 * deliberately cannot — see the bearer-token note in the design), SameSite=Lax
 * so a top-level navigation from a mail client still carries it, and `Secure`
 * only when the request really arrived over https.
 */
export function sessionCookieHeader(
  claims: SessionClaims,
  key: string,
  opts: { secure: boolean; now?: number },
): string {
  const now = opts.now ?? Date.now();
  const maxAge = Math.max(0, Math.floor((claims.expiresAt - now) / 1000));
  return cookie(signSession(claims, key), maxAge, opts.secure);
}

/** `Set-Cookie` that ends the session in this browser. */
export function clearedSessionCookieHeader(opts: { secure: boolean }): string {
  return cookie('', 0, opts.secure);
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ].join('; ');
}

function payloadOf(claims: SessionClaims): string {
  return `${VERSION}.${claims.identityId}.${claims.issuedAt}.${claims.expiresAt}`;
}

function mac(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}
