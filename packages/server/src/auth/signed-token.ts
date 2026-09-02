/**
 * One signed-token construction, shared by every cookie and bearer value this
 * server mints.
 *
 * Three protocols grew the same code independently — the share link-session
 * cookie, the email-identity session cookie and the widget's popup-handshake
 * token — and each one re-derived the same five decisions: HMAC-SHA256 over a
 * dot-joined payload, the MAC appended after a final dot, a split at the LAST
 * dot, a length check before `timingSafeEqual` (which throws on unequal
 * lengths), and a domain-separated key so no value can ever verify as another
 * protocol's. Three copies of that is three places for one of them to drift,
 * and the drift would be silent: a token that verifies is a token that
 * authorizes.
 *
 * So the construction lives here once, and each protocol contributes only
 * what is genuinely its own — a `TokenFormat` naming its key domain, its
 * version tags, how its claims become a payload and back, and when it
 * expires. The formats stay next to the claims they describe; nothing about
 * sessions, shares or origins is known here.
 *
 * WIRE FORMAT IS FROZEN. Cookies minted by the pre-refactor code are in
 * browsers right now and share links are in the wild, so `mintToken` must
 * keep producing byte-identical values. `test/signed-token-compat.test.ts`
 * mints with a copy of the old code and verifies with this module.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Why a value did not verify. Callers that authorize on a token collapse
 * every one of these to "no", and should: telling a client which failure it
 * hit hands it a decision tree. The reason is for the server's own logs and
 * for tests that need to prove WHICH check refused.
 */
export type TokenFailure =
  /** Nothing was presented — no cookie, no header. */
  | 'absent'
  /** Not shaped like one of ours: no MAC, or a payload we cannot parse. */
  | 'malformed'
  /** The MAC does not match under this key. Forged, tampered, or minted
   *  under a different key — indistinguishable, deliberately. */
  | 'bad_signature'
  /** A genuine token for a DIFFERENT protocol or version tag. */
  | 'wrong_purpose'
  /** Genuine, well-formed, and past the expiry it carries. */
  | 'expired';

export type VerifiedToken<Claims> =
  | { ok: true; claims: Claims }
  | { ok: false; reason: TokenFailure };

/**
 * Everything one protocol has to say about its own tokens.
 *
 * `encode` returns the whole payload rather than a field list, and that is on
 * purpose: the share cookie's payload IS its share id, which may contain
 * dots. Splitting is each format's business; the MAC is not.
 */
export interface TokenFormat<Claims> {
  /** Names this protocol in logs and tests. Not part of the wire format. */
  purpose: string;
  /**
   * The domain string mixed into the base key for this protocol, or null when
   * it signs with the base key itself. Null is a wire lock, never a default:
   * the share cookie predates domain separation and its live cookies are
   * signed with the key file's own bytes.
   */
  keyDomain: string | null;
  /**
   * Leading dot-field values this format answers to, checked before `decode`
   * so a genuine token for another protocol reads as `wrong_purpose` rather
   * than as junk. Null when the format carries no version tag.
   */
  tags: readonly string[] | null;
  /** Claims to the exact payload bytes the MAC covers. */
  encode(claims: Claims): string;
  /** Payload back to claims, or null when it does not parse. */
  decode(payload: string): Claims | null;
  /**
   * ms epoch after which the token is dead, or null for a value that never
   * expires by time. This is where a format's TTL is enforced; the TTL
   * constant itself lives with the format.
   */
  expiresAt(claims: Claims): number | null;
}

/**
 * This protocol's signing key, derived from the one key file on disk.
 *
 * One key, many protocols: a value minted for one can never verify under
 * another however neatly the two payload shapes happen to line up.
 */
export function tokenKey(baseKey: string, format: { keyDomain: string | null }): string {
  if (format.keyDomain === null) return baseKey;
  return createHmac('sha256', baseKey).update(format.keyDomain).digest('hex');
}

/** `<payload>.<mac>` — opaque to the client, unforgeable without the key. */
export function mintToken<Claims>(
  format: TokenFormat<Claims>,
  claims: Claims,
  key: string,
): string {
  const payload = format.encode(claims);
  return `${payload}.${mac(payload, key)}`;
}

/**
 * The claims a value attests to, or the reason it does not.
 *
 * Signature first, then purpose, then shape, then expiry — so nothing that
 * fails the MAC ever reaches a parser, and an attacker learns nothing about
 * our payload grammar from a value they could not sign.
 */
export function verifyToken<Claims>(
  format: TokenFormat<Claims>,
  value: string | undefined | null,
  key: string,
  now: number = Date.now(),
): VerifiedToken<Claims> {
  if (!value) return { ok: false, reason: 'absent' };
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return { ok: false, reason: 'malformed' };
  const payload = value.slice(0, dot);
  const provided = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(mac(payload, key));
  // timingSafeEqual throws on a length mismatch, so the guard is required —
  // and a length difference is not secret: it is visible in the value.
  if (provided.length !== expected.length) return { ok: false, reason: 'bad_signature' };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: 'bad_signature' };

  if (
    format.tags !== null &&
    !format.tags.some((t) => payload === t || payload.startsWith(`${t}.`))
  )
    return { ok: false, reason: 'wrong_purpose' };

  const claims = format.decode(payload);
  if (claims === null) return { ok: false, reason: 'malformed' };
  const expiresAt = format.expiresAt(claims);
  if (expiresAt !== null && expiresAt <= now) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

/** The claims, or null — for callers that authorize and must not branch on
 *  which check refused. */
export function tokenClaims<Claims>(
  format: TokenFormat<Claims>,
  value: string | undefined | null,
  key: string,
  now: number = Date.now(),
): Claims | null {
  const result = verifyToken(format, value, key, now);
  return result.ok ? result.claims : null;
}

function mac(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}
