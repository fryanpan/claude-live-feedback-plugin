/**
 * Which browser origins may talk to this server.
 *
 * The server used to answer every request with
 * `Access-Control-Allow-Origin: *`, and to accept any websocket upgrade
 * without looking at Origin at all. Neither the tailnet hostname nor loopback
 * requires credentials — that's deliberate, it's how the user's own agents
 * call the API — so "any origin may read the response" meant any web page the
 * user happened to have open could:
 *
 *   - read `/api/docs` and every document's contents,
 *   - post comments and edit docs,
 *   - and, via `POST /api/docs` with an arbitrary `sourceUrl`, bind and read
 *     any file on the machine.
 *
 * All three were reproduced against the running server before this existed.
 *
 * CORS is enforced by the browser, not by us — the only thing we control is
 * whether we volunteer permission. So: reflect one specific origin when it's
 * one we know, and otherwise send no CORS headers at all.
 */

export interface OriginPolicy {
  /**
   * The origin this request was served on, SCHEME INCLUDED
   * (`https://share.example.com`). Scheme matters: `http://x` and `https://x`
   * are different browser origins, and a share host reached over https must
   * not trust a plain-http page on the same name.
   */
  requestOrigin: string;
  /**
   * This machine's own hostnames — the same set the host gate trusts
   * (tailnet name, LAN names, operator-configured extras). A dev server on
   * one of these, on any port, is running on this machine, so a remote
   * attacker's page cannot be served from it. Matched EXACTLY: `Origin` is
   * attacker-controlled text, and suffix matching would let
   * `mac-mini.local.evil.example.com` through.
   */
  localHostnames: string[];
  /** Extra origins the operator has explicitly allowed. Matched exactly. */
  allowedOrigins: string[];
}

/**
 * Hostnames that can only ever be the machine itself. Exported so the caller
 * can fold them into `localHostnames` for the LOCAL surface — the predicate
 * itself grants no implicit trust, because the share surface must be able to
 * say "same origin, nothing else" and mean it.
 *
 * Kept in step with host-guard.ts's LOOPBACK, including `0.0.0.0`: Vite and
 * Bun both print that address when a dev server binds all interfaces, and a
 * developer who opens it would otherwise be refused by a policy that is
 * supposed to mirror what the host gate already trusts.
 */
export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'];

/**
 * `true` when a browser at `origin` may read our responses.
 *
 * A NULL origin means the request carried no `Origin` header, which no browser
 * does for a cross-origin fetch or a websocket handshake — that's curl, the
 * MCP child, or an agent. Those are allowed (there is no browser to protect),
 * and a page cannot suppress its own Origin header to get here.
 *
 * The literal string `'null'` is a different thing entirely: it's what a
 * `file://` page or a sandboxed iframe sends, and it is refused.
 */
export function isAllowedBrowserOrigin(origin: string | null, policy: OriginPolicy): boolean {
  return originMatch(origin, policy) !== null;
}

/** Why an origin was allowed — `null` when it wasn't. The distinction matters
 *  for Private Network Access (see corsHeadersFor). */
type MatchKind = 'not-a-browser' | 'configured' | 'same-origin' | 'local';

function originMatch(origin: string | null, policy: OriginPolicy): MatchKind | null {
  if (origin === null) return 'not-a-browser';
  if (!origin || origin === 'null') return null;

  // Exact match against operator configuration first — cheapest and most
  // explicit. Compared as raw strings so it can't widen to a sibling host.
  if (policy.allowedOrigins.includes(origin)) return 'configured';

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null; // unparseable — refuse rather than guess
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  // Same origin as the app itself: the review UI, the mockup pages, the share
  // host. Full origin comparison — scheme, hostname and port — so neither
  // `evil-<host>`, `<host>.evil.example.com`, nor a plain-http page on an
  // https host slips through.
  if (url.origin === policy.requestOrigin) return 'same-origin';

  // A dev server running on THIS machine — the widget's whole reason for
  // being cross-origin. It may be on loopback, or reached over the tailnet or
  // the LAN and pointed back at this server, so the caller passes every name
  // the host gate treats as ours. Any port (dev servers pick their own) and
  // either scheme (a local dev server is usually plain http).
  //
  // Exact hostname match only. Deliberately NO "any private IP is local"
  // rule: `Origin` is attacker-controlled, so trusting 192.168/16 wholesale
  // would let any page self-classify onto the LAN — the same reasoning as
  // isTrustedLocalHost in host-guard.ts.
  //
  // On the SHARE surface the caller passes none of this, leaving same-origin
  // as the only way through. That matters because a share visitor holds a
  // SameSite=Lax session cookie and websockets ignore CORS entirely: an
  // allowed origin that happened to be same-SITE with the share host would
  // otherwise carry that cookie into /y/<docId> and read and write the doc.
  const host = url.hostname.toLowerCase();
  if (policy.localHostnames.some((n) => n.toLowerCase() === host)) return 'local';

  return null;
}

/**
 * CORS headers for a request, or null when none should be sent.
 *
 * Never a wildcard, and never `Access-Control-Allow-Credentials`: the share
 * session is a cookie, and the review app is served from the very origin it
 * calls, so a credentialed cross-origin request is never needed. Granting it
 * would let every allowed origin act as a logged-in share visitor.
 */
export function corsHeadersFor(
  origin: string | null,
  policy: OriginPolicy,
): Record<string, string> | null {
  // No Origin means no browser is applying CORS to this response; headers
  // would be inert. Send none rather than echo something meaningless.
  if (!origin) return null;
  const match = originMatch(origin, policy);
  if (match === null) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '600',
    // The response body differs by origin. Without this a shared cache could
    // hand one origin's allowed response to another.
    vary: 'Origin',
    // Chromium's Private Network Access: a page on a PUBLIC origin reaching a
    // private/loopback address gets an extra preflight carrying
    // `Access-Control-Request-Private-Network`, and the request fails unless
    // we answer with this. It applies only to the cross-machine
    // ALLOWED_ORIGINS flow — the automatic allowances are private-to-private,
    // which needs no such grant.
    //
    // Scoped to `configured` on purpose. This header tells a browser that a
    // public website may reach into the private network, which is precisely
    // the thing PNA exists to prevent; it's defensible only because the
    // operator named that exact origin themselves.
    ...(match === 'configured' ? { 'access-control-allow-private-network': 'true' } : {}),
  };
}
