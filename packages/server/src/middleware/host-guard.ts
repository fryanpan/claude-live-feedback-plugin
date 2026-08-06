/**
 * Host-based access control for a server that is reachable over a public
 * tunnel.
 *
 * Two rules live here, both learned from a security review (2026-08-05):
 *
 * 1. **Default-deny by host.** The cloudflared ingress forwards EVERY
 *    hostname under the share wildcard to this process. The old gate only
 *    challenged requests whose Host matched an ACTIVE share, so any other
 *    hostname — `anything.tunnel.example.com` — sailed past the Access check
 *    and reached the full API (list every doc, read/write any doc over the
 *    websocket, bind arbitrary folders). Trust is now an allowlist: local
 *    hostnames bypass, everything else must authenticate. A host we do not
 *    recognise is denied even when Access isn't configured at all — a
 *    misconfigured deployment must fail closed, not serve the API to the
 *    internet.
 *
 * 2. **Share scoping.** Passing Cloudflare Access proves the visitor's email
 *    domain is allow-listed for ONE shared doc; it says nothing about the
 *    rest of the server. Without scoping, an external reviewer could
 *    enumerate every bound doc (titles + absolute filesystem paths), open any
 *    doc's websocket, and mint or revoke shares. A share host may therefore
 *    reach only the app shell and the shared doc's own endpoints.
 *
 * Both are pure predicates so they can be unit-tested without a server, and
 * are additionally exercised at the HTTP layer — the route layer is the part
 * nothing type-checks (see docs/process/learnings.md).
 */

/** Strip the port and lowercase, so `Host: mac-mini.local:8787` compares. */
export function normalizeHost(host: string | null | undefined): string {
  if (!host) return '';
  const h = host.trim().toLowerCase();
  // IPv6 literal: [::1]:8787 → ::1
  if (h.startsWith('[')) {
    const close = h.indexOf(']');
    if (close > 0) return h.slice(1, close);
  }
  const colon = h.lastIndexOf(':');
  // Only strip a trailing :port (digits), never part of a bare IPv6 address.
  if (colon > 0 && /^\d+$/.test(h.slice(colon + 1))) return h.slice(0, colon);
  return h;
}

export interface TrustedHostOpts {
  /** Tailscale MagicDNS name, when the daemon is up. */
  tailscaleHost?: string | null;
  /** LAN hostnames / IPv4 addresses for this machine. */
  lanHosts?: string[];
  /** Extra hostnames an operator explicitly marks local. */
  extraHosts?: string[];
  /**
   * True when the request came through the Cloudflare edge (it carries a
   * `cf-ray`, which Cloudflare stamps on everything it proxies and
   * overwrites if a client sends its own). cloudflared forwards the
   * visitor's Host verbatim, so without this a tunnel visitor could send
   * `Host: localhost` and be classified local. A proxied request is never
   * local, whatever its Host claims.
   */
  viaProxy?: boolean;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * Is this Host header one of OUR local names (loopback / tailnet / LAN)?
 * Only these bypass authentication. Matching is exact — no suffix matching,
 * because `evil-mac-mini.attacker.com` must not match `mac-mini.local`.
 */
export function isTrustedLocalHost(
  host: string | null | undefined,
  opts: TrustedHostOpts,
): boolean {
  const h = normalizeHost(host);
  if (h === '') return false; // HTTP/1.1 requires Host; absent = not trusted
  if (opts.viaProxy) return false; // arrived via Cloudflare — not our LAN
  if (LOOPBACK.has(h)) return true;
  // NOTE: deliberately no "any private IPv4 is local" rule. Host is
  // client-controlled, so trusting 10/8, 192.168/16, 172.16/12 or CGNAT
  // wholesale would let a caller self-classify as local. This machine's
  // real addresses — including the tailnet utun address — are enumerated
  // into `lanHosts`, so exact matching costs nothing.
  const candidates = [
    opts.tailscaleHost ?? '',
    ...(opts.lanHosts ?? []),
    ...(opts.extraHosts ?? []),
  ]
    .map((c) => normalizeHost(c))
    .filter((c) => c !== '');
  return candidates.includes(h);
}

export type HostDecision =
  | { kind: 'local' } // trusted local caller: no gate
  | { kind: 'share'; docId: string } // active share host: gate + scope
  | { kind: 'deny'; reason: 'unknown_host' }; // anything else: refuse

/**
 * Classify a request's Host. `lookupShare` returns the shared docId for a
 * hostname, or null when no active share owns it.
 */
export function classifyHost(
  host: string | null | undefined,
  opts: TrustedHostOpts & { lookupShare: (host: string) => string | null },
): HostDecision {
  if (isTrustedLocalHost(host, opts)) return { kind: 'local' };
  const docId = opts.lookupShare(normalizeHost(host));
  if (docId) return { kind: 'share', docId };
  return { kind: 'deny', reason: 'unknown_host' };
}

/**
 * May a request on a SHARE host touch this path?
 *
 * Allowlist, not denylist: the app shell plus the shared doc's own surfaces.
 * Anything unlisted is refused, so a route added later is closed by default
 * rather than silently exposed to external reviewers.
 */
export function shareScopeAllows(pathname: string, method: string, sharedDocId: string): boolean {
  // Static app shell + assets (needed to render the review at all).
  if (pathname === '/app' || pathname.startsWith('/app/')) return true;
  if (pathname === '/widget.js' || pathname === '/widget.iife.js') return true;
  if (pathname === '/widget.esm.js' || pathname.startsWith('/widget/')) return true;
  if (pathname === '/favicon.ico') return true;

  const enc = encodeURIComponent(sharedDocId);
  const matchesDoc = (segment: string): boolean =>
    segment === sharedDocId || segment === enc || safeDecode(segment) === sharedDocId;

  // The review page for exactly this doc.
  if (pathname.startsWith('/review/')) return matchesDoc(pathname.slice('/review/'.length));

  // Yjs websocket + SSE for exactly this doc.
  if (pathname.startsWith('/y/')) return matchesDoc(pathname.slice('/y/'.length));
  if (pathname.startsWith('/events/')) return matchesDoc(pathname.slice('/events/'.length));

  // Doc REST surface: /api/docs/<id> and everything under it (threads,
  // comments, anchors…). NOT bare /api/docs, which lists every doc.
  if (pathname.startsWith('/api/docs/')) {
    const rest = pathname.slice('/api/docs/'.length);
    const first = rest.split('/', 1)[0] ?? '';
    return matchesDoc(first);
  }

  // Everything else — /api/share*, /api/docs (list), /api/workspaces,
  // /api/diffs, /demos, /mockup … — is out of scope for a share visitor.
  //
  // KNOWN LIMITATION, deliberate: a shared doc that belongs to a workspace
  // (folder bind / diff review) renders WITHOUT its file-tree sidebar,
  // because the app builds that from /api/workspaces/<id>/{tree,grouped,
  // files}. Allowing those would hand a visitor shared ONE file the whole
  // workspace listing — every sibling path on disk — which is exactly the
  // enumeration this scoping exists to prevent. `share_doc` shares one doc;
  // sharing a folder needs its own scope model (a workspace-level share),
  // not a hole punched in this one.
  void method;
  return false;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
