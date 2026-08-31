/**
 * The two requests Recall.ai's backend makes INTO this server, and the whole
 * of what its dedicated callback hostname serves.
 *
 * The shape of the problem (2026-08-31). Meeting bots need a public address
 * to dial back on, and this deployment reaches the internet through exactly
 * one thing: the Cloudflare Tunnel. The first answer was to let the two
 * callbacks skip the Access check on the OPERATOR's hostname — the address a
 * person opens the product on — because that was the only public name there
 * was. It worked, and it meant `workspaces.…` had two holes in it: every
 * argument for them was about a caller that is not a person, punched through
 * the door people use.
 *
 * Bryan's call is a DEDICATED FIRST-LEVEL HOSTNAME instead
 * (`CW_RECALL_CALLBACK_HOST`, e.g. `recall.<domain>`), pointed at the same
 * tunnel, with no Cloudflare Access application in front of it and this
 * allowlist behind it. The operator hostname goes back to zero exemptions.
 * What the vendor can reach and what a person can reach are now two names,
 * and the blast radius of the unauthenticated one is this file.
 *
 * So this predicate is no longer "may this request skip a gate": it is the
 * ENTIRE surface of a host class. Everything it answers false to is 404 on
 * that hostname — the doc list, the websocket for a real doc, the landing
 * page, the deploy verb. The two it admits are:
 *
 * 1. `GET /recall/<token>` — the websocket upgrade. The token is 128 CSPRNG
 *    bits minted per bot, handed to Recall alone, and forgotten when that
 *    bot's meeting ends (`RecallMeetingRelay.mintToken`). It IS the
 *    authentication. Admitted only when the relay is configured, because on
 *    a server that can never mint a token there is no credential behind the
 *    route — just an unauthenticated path.
 *
 * 2. `POST /recall/status` — the bot status webhook. The credential is
 *    Svix's signature over the body, verified by the route itself. Admitted
 *    only when `RECALL_WEBHOOK_SECRET` is set, and this condition is the
 *    load-bearing one: with the secret unset the route ACCEPTS UNSIGNED
 *    bodies (falling back to the bot id being unguessable, which is weaker).
 *    Admitting it unconditionally would put that unsigned-accept mode on the
 *    public internet with nothing in front of it at all.
 *
 * Both live under ONE `/recall/` prefix so the surface is greppable and so a
 * tunnel or WAF rule can be written against a path prefix rather than a list
 * that drifts. The status webhook used to be `/api/recall/status`; it moved
 * here with the hostname, and the old path is gone rather than shimmed
 * (nothing external calls it yet — Recall is not yet configured to, and
 * Bryan waived compatibility shims for prototype-phase surfaces, 2026-08-18).
 *
 * Every ambiguity fails CLOSED. In particular the path is matched against the
 * RAW pathname, so a percent-encoded spelling of a real token
 * (`/recall/%61b…`) is refused even though the route would decode and accept
 * it: Recall dials the literal URL we minted, so the encoded form is never a
 * real bot, and refusing it costs a caller that does not exist.
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
export const RECALL_STATUS_PATH = '/recall/status';

/**
 * Is this one of the two requests the callback hostname exists to serve?
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
export function recallCallbackAllows(
  pathname: string,
  method: string,
  creds: RecallCallbackCredentials,
): boolean {
  const verb = method.toUpperCase();
  // The websocket upgrade is a GET; Recall never sends anything else here,
  // and a POST to the same path is not the caller this hostname is for.
  if (creds.relayConfigured && verb === 'GET' && RECALL_WS_PATH.test(pathname)) {
    return true;
  }
  if (creds.webhookSecretSet && verb === 'POST' && pathname === RECALL_STATUS_PATH) {
    return true;
  }
  return false;
}
