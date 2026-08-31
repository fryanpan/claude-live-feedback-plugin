/**
 * The two requests Recall.ai's backend makes INTO this server, and why they
 * are the only things on the operator's public hostname that may skip the
 * Cloudflare Access token.
 *
 * The shape of the problem (2026-08-31). Meeting bots need a public address
 * to dial back on, and this deployment has exactly one: the Cloudflare
 * Tunnel. `CW_PUBLIC_BASE_URL` names it, and it is the operator's own
 * hostname — which `classifyHost` classifies `proxied-local`, the widest
 * grant there is: an Access token, an allow-listed email, and then everything
 * loopback gets. Recall's backend has no browser, no Access session and no
 * way to acquire either, so both of its callbacks are answered 401 before any
 * route runs. The bot joins the call, records, bills, and delivers nothing.
 *
 * Widening the host classification would have been the wrong fix — it would
 * hand the whole product to anyone who can reach the tunnel and type the
 * hostname, which is the hole the host guard exists to close. So the
 * exemption is per REQUEST, and only where the request already carries its
 * own credential:
 *
 * 1. `GET /recall/<token>` — the websocket upgrade. The token is 128 CSPRNG
 *    bits minted per bot, handed to Recall alone, and forgotten when that
 *    bot's meeting ends (`RecallMeetingRelay.mintToken`). It IS the
 *    authentication; the Access token would be a second one. Exempt only
 *    when the relay is configured, because on a server that can never mint a
 *    token there is no credential behind the exemption — just an unauthed
 *    path through the gate.
 *
 * 2. `POST /api/recall/status` — the bot status webhook. The credential is
 *    Svix's signature over the body, verified by the route itself. Exempt
 *    only when `RECALL_WEBHOOK_SECRET` is set, and this condition is the
 *    load-bearing one: with the secret unset the route ACCEPTS UNSIGNED
 *    bodies (falling back to the bot id being unguessable, which is weaker).
 *    Exempting it unconditionally would put that unsigned-accept mode on the
 *    public internet with nothing in front of it at all.
 *
 * Everything else on that hostname is unchanged, and every ambiguity fails
 * CLOSED — an unexempt request simply meets the gate it met before. In
 * particular the path is matched against the RAW pathname, so a
 * percent-encoded spelling of a real token (`/recall/%61b…`) is not exempt
 * even though the route would decode and accept it: Recall dials the literal
 * URL we minted, so the encoded form is never a real bot, and refusing it
 * costs a caller that does not exist.
 *
 * A pure predicate so it can be unit-tested without a server, and
 * additionally exercised at the HTTP layer — the route layer is the part
 * nothing type-checks (see docs/process/learnings.md).
 */

/**
 * Which of Recall's own credentials this server is actually holding. Both
 * default to false at the call site's discretion; neither may be inferred
 * from the request.
 */
export interface RecallCallbackCredentials {
  /** `RecallMeetingRelay.configured()` — a key AND a public wss base. */
  relayConfigured: boolean;
  /** `RECALL_WEBHOOK_SECRET` is set, so the route verifies the signature. */
  webhookSecretSet: boolean;
}

/** The websocket token exactly as `mintToken` produces it: 128 bits of hex. */
const RECALL_WS_PATH = /^\/recall\/[0-9a-f]{32}$/;

/** The status webhook, matched whole — never by prefix. */
const RECALL_STATUS_PATH = '/api/recall/status';

/**
 * May this request skip the Cloudflare Access requirement on the operator's
 * own proxied hostname?
 *
 * True for exactly the two Recall callbacks above, and only while the
 * credential each of them carries is configured. False for everything else,
 * including near-misses: a short or non-hex token, a trailing slash, anything
 * under the token, a doubled leading slash, and the wrong method on either
 * path.
 *
 * @param pathname the RAW `URL.pathname` — not decoded, not trimmed.
 * @param method the request method (compared case-insensitively).
 */
export function recallCallbackExempt(
  pathname: string,
  method: string,
  creds: RecallCallbackCredentials,
): boolean {
  const verb = method.toUpperCase();
  // The websocket upgrade is a GET; Recall never sends anything else here,
  // and a POST to the same path is not the caller this exemption is for.
  if (creds.relayConfigured && verb === 'GET' && RECALL_WS_PATH.test(pathname)) {
    return true;
  }
  if (creds.webhookSecretSet && verb === 'POST' && pathname === RECALL_STATUS_PATH) {
    return true;
  }
  return false;
}
