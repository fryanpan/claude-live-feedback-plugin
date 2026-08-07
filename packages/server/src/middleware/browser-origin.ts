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
  /** The request's own Host header — the origin the app is served from. */
  requestHost: string;
  /** Extra origins the operator has explicitly allowed. Matched exactly. */
  allowedOrigins: string[];
}

/** Hostnames that can only ever be the machine itself. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

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
  if (origin === null) return true; // not a browser
  if (!origin || origin === 'null') return false;

  // Exact match against operator configuration first — cheapest and most
  // explicit. Compared as raw strings so it can't widen to a sibling host.
  if (policy.allowedOrigins.includes(origin)) return true;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // unparseable — refuse rather than guess
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  // Same origin as the app itself: the review UI, the mockup pages, the share
  // host. Compared on HOST (hostname + port), which is what `Origin` carries,
  // so `evil-<host>` and `<host>.evil.example.com` both fail.
  if (url.host === policy.requestHost) return true;

  // A loopback dev server — the widget's whole reason for being cross-origin.
  // An attacker's page cannot be served from loopback, so this is far narrower
  // than the wildcard it replaces. Any port, because dev servers pick their
  // own. `url.hostname` is already normalized, so no substring matching.
  if (LOOPBACK_HOSTS.has(url.hostname)) return true;

  return false;
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
  if (!isAllowedBrowserOrigin(origin, policy)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '600',
    // The response body differs by origin. Without this a shared cache could
    // hand one origin's allowed response to another.
    vary: 'Origin',
  };
}
