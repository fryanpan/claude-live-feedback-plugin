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

/** What a share hostname grants access to. */
export interface ShareTarget {
  /** The doc the share URL opens. Always in scope. */
  docId: string;
  /**
   * Set when the share covers a whole workspace (folder bind / diff
   * review) rather than a single doc. Every member doc is then in scope,
   * along with the navigation endpoints that make the set browsable.
   */
  workspaceId?: string;
}

export type HostDecision =
  | { kind: 'local' } // trusted local caller: no gate
  | { kind: 'share'; target: ShareTarget } // active share host: gate + scope
  | { kind: 'deny'; reason: 'unknown_host' }; // anything else: refuse

/**
 * Classify a request's Host. `lookupShare` returns what the hostname's
 * active share grants, or null when no active share owns it.
 */
export function classifyHost(
  host: string | null | undefined,
  opts: TrustedHostOpts & { lookupShare: (host: string) => ShareTarget | null },
): HostDecision {
  if (isTrustedLocalHost(host, opts)) return { kind: 'local' };
  const target = opts.lookupShare(normalizeHost(host));
  if (target) return { kind: 'share', target };
  return { kind: 'deny', reason: 'unknown_host' };
}

/**
 * May a request on a SHARE host touch this path?
 *
 * Allowlist, not denylist: the app shell plus the shared doc's own surfaces.
 * Anything unlisted is refused, so a route added later is closed by default
 * rather than silently exposed to external reviewers.
 */
export function shareScopeAllows(
  pathname: string,
  method: string,
  target: ShareTarget,
  /**
   * Resolves a docId to the workspace it belongs to (null when it belongs
   * to none). Only consulted for workspace shares — a doc share never
   * widens past its one doc, whatever this returns.
   */
  workspaceOf?: (docId: string) => string | null,
): boolean {
  // Static app shell + assets (needed to render the review at all).
  if (pathname === '/app' || pathname.startsWith('/app/')) return true;
  if (pathname === '/widget.js' || pathname === '/widget.iife.js') return true;
  if (pathname === '/widget.esm.js' || pathname.startsWith('/widget/')) return true;
  if (pathname === '/favicon.ico') return true;

  /** Is this path segment a doc the share covers? */
  const inScope = (segment: string): boolean => {
    const id = safeDecode(segment);
    if (id === target.docId || segment === target.docId) return true;
    if (!target.workspaceId) return false;
    return workspaceOf?.(id) === target.workspaceId;
  };

  // Review page / Yjs websocket / SSE for an in-scope doc.
  if (pathname.startsWith('/review/')) return inScope(pathname.slice('/review/'.length));
  if (pathname.startsWith('/y/')) return inScope(pathname.slice('/y/'.length));
  if (pathname.startsWith('/events/')) return inScope(pathname.slice('/events/'.length));

  // Doc REST surface: /api/docs/<id> and everything under it (threads,
  // comments, anchors…). NOT bare /api/docs, which lists every doc.
  if (pathname.startsWith('/api/docs/')) {
    const rest = pathname.slice('/api/docs/'.length);
    return inScope(rest.split('/', 1)[0] ?? '');
  }

  // Workspace navigation — ONLY for a workspace share, and only its own
  // workspace. The shared unit is the workspace, so the visitor gets the
  // endpoints that make it browsable:
  //   tree / grouped   — the sidebar (bound folder, or diff file groups)
  //   threads          — every thread in the set, for the comments panel
  //   files            — the workspace's file list
  //   context-file     — open a member lazily, read-only
  //   editable-file    — open a member lazily, editable
  //
  // The last three matter because members bind LAZILY: `bind_folder` binds
  // only the entry doc, and everything else in the tree comes into being
  // through these calls. Block them and a shared folder shows one file.
  // They are bounded by the workspace root — rooms.openContextFile /
  // openEditableFile reject any relPath that escapes it ('bad-path').
  //
  // Two things stay closed: a different workspace, and DELETE (bare
  // /api/workspaces/<id>), which would let a visitor destroy the review.
  //
  // Worth knowing when you share a DIFF review rather than a folder: the
  // workspace root is the whole repo, so `files` lists every repo file and
  // `context-file` can open any of them for context — the same "Show All
  // Files" surface you see locally. Share a folder bind when you want the
  // visitor confined to a directory.
  if (pathname.startsWith('/api/workspaces/')) {
    if (!target.workspaceId) return false;
    const rest = pathname.slice('/api/workspaces/'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return false; // bare /api/workspaces/<id> is DELETE-only
    if (safeDecode(rest.slice(0, slash)) !== target.workspaceId) return false;
    const sub = rest.slice(slash + 1);
    if (method === 'GET')
      return sub === 'tree' || sub === 'grouped' || sub === 'threads' || sub === 'files';
    if (method === 'POST') return sub === 'context-file' || sub === 'editable-file';
    return false;
  }

  // Everything else — /api/share*, /api/docs (list), /api/workspaces (list
  // + create), /api/diffs, /demos, /mockup … — is out of scope.
  return false;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
