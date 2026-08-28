/**
 * The email-identity session cookie.
 *
 * Shaped after `share/link-session.ts` — same HMAC, same key file, same
 * timing-safe compare — with three deliberate differences.
 *
 * 1. **It never expires by time; it ends by revocation.** (Bryan, 2026-08-28,
 *    on the design doc — replacing the original 90-day sliding expiry.) Each
 *    minted session carries a random session id, and logout writes that id
 *    into `SessionRevocations` server-side; a revoked cookie is dead however
 *    cleanly it validates. Two revocation layers, different reach: the
 *    per-session list ends ONE device's session (logout), and the roster's
 *    `Identities.sessionsValidFrom` watermark still ends EVERYTHING an
 *    identity minted before it. The v1 format — expiry baked into the value —
 *    is still verified so devices signed in before the change stay signed in;
 *    those cookies keep their own expiry and gain a session id at their next
 *    sliding refresh.
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
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'cw_session';

/**
 * What the BROWSER is asked to keep the cookie for — not a session lifetime.
 * The session has none; this is pinned to the cap browsers put on cookie
 * `Max-Age` (~400 days), and the daily sliding refresh keeps re-arming it,
 * so an active device stays signed in indefinitely.
 */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/**
 * How much of a session's life may elapse before a request re-issues the
 * cookie. A day, so an active reviewer's cookie never falls off the
 * browser's cap while a `Set-Cookie` on literally every response would be
 * noise.
 */
export const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

/** The revocable format. `v1` — expiry-carrying, no session id — is still
 *  accepted by `verifySession` for the cookies minted before the change. */
const VERSION = 'v2';

export interface SessionClaims {
  identityId: string;
  /** What logout revokes. Null only for a surviving v1 cookie, which has
   *  nothing to revoke individually — the roster watermark still covers it. */
  sessionId: string | null;
  /** ms epoch — checked against the roster's revocation watermark. */
  issuedAt: number;
  /** ms epoch, v1 cookies only. Null means "never" — the v2 model. */
  expiresAt: number | null;
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

/** `v2.<identityId>.<sessionId>.<issuedAt>.<mac>` — opaque to the client.
 *  Claims without a session id sign as the old `v1.<identityId>.<issuedAt>.
 *  <expiresAt>.<mac>`, which exists so tests can mint what old devices hold. */
export function signSession(claims: SessionClaims, key: string): string {
  const payload = payloadOf(claims);
  return `${payload}.${mac(payload, key)}`;
}

/**
 * The claims a cookie attests to, or null.
 *
 * Null for anything that is not ours, does not verify, or (v1 only) has
 * expired — the caller cannot tell those apart, and should not: every one of
 * them means "no session". Revocation is NOT checked here — this function
 * has no storage; the caller holds the `SessionRevocations` store and the
 * roster watermark.
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
  const [version, identityId, thirdRaw, fourthRaw] = parts;
  if (!identityId) return null;
  if (version === VERSION) {
    const sessionId = thirdRaw;
    const issuedAt = Number(fourthRaw);
    if (!sessionId || !Number.isSafeInteger(issuedAt)) return null;
    return { identityId, sessionId, issuedAt, expiresAt: null };
  }
  if (version === 'v1') {
    const issuedAt = Number(thirdRaw);
    const expiresAt = Number(fourthRaw);
    if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) return null;
    if (expiresAt <= now) return null;
    return { identityId, sessionId: null, issuedAt, expiresAt };
  }
  return null;
}

/** Whether a live session has used enough of its life to be re-issued. */
export function sessionNeedsRefresh(claims: SessionClaims, now: number = Date.now()): boolean {
  return now - claims.issuedAt >= SESSION_REFRESH_AFTER_MS;
}

/** Fresh claims for an identity at login. 128 bits of id: unguessable, and
 *  two logins can never collide into sharing a revocation. */
export function mintSession(identityId: string, now: number = Date.now()): SessionClaims {
  return {
    identityId,
    sessionId: randomBytes(16).toString('base64url'),
    issuedAt: now,
    expiresAt: null,
  };
}

/**
 * The sliding extension of a live session. KEEPS the session id — the
 * re-issued cookie is the same session, so a later logout on this device
 * still revokes it. A v1 cookie has no id, so its refresh is the upgrade
 * path: it gains one here and sheds its baked-in expiry.
 */
export function refreshedSession(claims: SessionClaims, now: number = Date.now()): SessionClaims {
  return {
    identityId: claims.identityId,
    sessionId: claims.sessionId ?? randomBytes(16).toString('base64url'),
    issuedAt: now,
    expiresAt: null,
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
  const maxAge =
    claims.expiresAt === null
      ? SESSION_COOKIE_MAX_AGE_SECONDS
      : Math.max(0, Math.floor((claims.expiresAt - now) / 1000));
  return cookie(signSession(claims, key), maxAge, opts.secure);
}

/** `Set-Cookie` that ends the session in this browser. The server-side half
 *  of logout — revoking the session id — is the route's job, not this one's. */
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
  if (claims.sessionId !== null) {
    return `${VERSION}.${claims.identityId}.${claims.sessionId}.${claims.issuedAt}`;
  }
  return `v1.${claims.identityId}.${claims.issuedAt}.${claims.expiresAt ?? 0}`;
}

function mac(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}
