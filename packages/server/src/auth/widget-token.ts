/**
 * The widget's popup-handshake token — how a dev-server embed borrows the
 * identity a browser already proved to the workspace origin.
 *
 * The widget runs on another origin and can never carry `cw_session` (the
 * cookie is HttpOnly and SameSite=Lax, and CORS here never grants
 * credentials — see middleware/browser-origin.ts). Instead the widget opens a
 * popup ON the workspace origin, where the cookie flows; the popup exchanges
 * that session for one of these tokens and hands it back over postMessage.
 *
 * Deliberately NOT a copy of the cookie, and narrower than it in three ways:
 *
 * 1. **It names the session, it isn't one.** The token carries the session
 *    id and issue time of the cookie it was minted from, and every use is
 *    checked against the live session — the revocation denylist and the
 *    roster's `sessionsValidFrom` watermark — so logging out of the
 *    workspace kills every token that session ever minted, instantly.
 * 2. **It expires on its own** (`WIDGET_TOKEN_TTL_MS`), unlike the session.
 *    The liveness check above is the load-bearing revocation; the expiry
 *    bounds how long a leaked token is worth anything when nobody knows to
 *    revoke it. Re-minting is one tap (the popup completes silently while
 *    the workspace session lives).
 * 3. **It only attributes.** The request path feeds it to `authorFor` and
 *    the widget-session probe, nothing else: it never sets a cookie, never
 *    satisfies a share gate, and never makes `/api/auth/session` answer
 *    "signed in".
 *
 * Same construction as session.ts: HMAC over a dotted payload, key derived
 * from the shared cookie key under its own domain string so neither format
 * can ever verify as the other.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SessionClaims } from './session.ts';

/** Seven days. Short-lived relative to the session (which never expires) —
 *  the per-use liveness check is what actually ends a token early. */
export const WIDGET_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const VERSION = 'wt1';

export interface WidgetTokenClaims {
  identityId: string;
  /** The session this token borrows — revoking it (logout) kills the token. */
  sessionId: string;
  /** The session's own issue time, so the roster watermark applies. */
  sessionIssuedAt: number;
  /** ms epoch. Unlike the session, the token always expires. */
  expiresAt: number;
}

/** The widget-token key, derived from the shared cookie key. */
export function widgetTokenKey(cookieKey: string): string {
  return createHmac('sha256', cookieKey).update('cw-widget-token-v1').digest('hex');
}

/**
 * A token for the session a request proved, or null for a surviving
 * v1-format session — those carry no session id, so a token tied to one
 * could not die with a logout. (The daily sliding refresh upgrades them;
 * the popup answers "sign in again" until then.)
 */
export function mintWidgetToken(
  session: SessionClaims,
  key: string,
  now: number = Date.now(),
): string | null {
  if (session.sessionId === null) return null;
  const payload = [
    VERSION,
    session.identityId,
    session.sessionId,
    session.issuedAt,
    now + WIDGET_TOKEN_TTL_MS,
  ].join('.');
  return `${payload}.${mac(payload, key)}`;
}

/**
 * The claims a token attests to, or null. Pure crypto + expiry — the caller
 * still owes the liveness checks (`SessionRevocations`, roster status, the
 * `sessionsValidFrom` watermark), exactly as with `verifySession`.
 */
export function verifyWidgetToken(
  value: string | undefined | null,
  key: string,
  now: number = Date.now(),
): WidgetTokenClaims | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const provided = value.slice(dot + 1);
  const a = Buffer.from(provided);
  const b = Buffer.from(mac(payload, key));
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  const parts = payload.split('.');
  if (parts.length !== 5) return null;
  const [version, identityId, sessionId, issuedRaw, expiresRaw] = parts;
  if (version !== VERSION || !identityId || !sessionId) return null;
  const sessionIssuedAt = Number(issuedRaw);
  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(sessionIssuedAt) || !Number.isSafeInteger(expiresAt)) return null;
  if (expiresAt <= now) return null;
  return { identityId, sessionId, sessionIssuedAt, expiresAt };
}

function mac(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}
