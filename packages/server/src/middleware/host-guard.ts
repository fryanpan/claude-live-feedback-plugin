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
  /**
   * The doc the share URL OPENS — a landing address, not a grant.
   *
   * It used to be "always in scope", which is precisely what a per-doc share
   * was: one docId named on the target and waved through by `inScope`. That
   * base case is gone. The entry doc is reachable because it is a member of
   * `workspaceId`, and if it somehow is not a member it is not reachable —
   * which is the correct answer, not a regression.
   *
   * Still read by `repairStaleReviewUrl`, which repoints a bookmarked
   * `/review/<entry>` after the file behind it is renamed.
   */
  docId: string;
  /**
   * The workspace this share covers. Every member doc is in scope, along
   * with the navigation endpoints that make the set browsable.
   *
   * REQUIRED, and it is the ONLY source of scope: a workspace is the unit of
   * sharing. Typed optional so a caller that still constructs the old
   * doc-only shape is refused by the guard below rather than rejected by the
   * compiler and then shipped anyway — an absent workspaceId grants nothing.
   */
  workspaceId?: string;
}

export type HostDecision =
  | { kind: 'local' } // trusted local caller: no gate
  | { kind: 'share'; target: ShareTarget } // per-share Access host: JWT + scope
  | { kind: 'link' } // public link host: authorize from the session cookie
  | { kind: 'deny'; reason: 'unknown_host' }; // anything else: refuse

/**
 * Classify a request's Host.
 *
 * Order matters: our own names win, then a per-share Access hostname, then
 * the single public hostname that link shares live on. Anything else is
 * refused — the tunnel forwards every hostname under its ingress here, so
 * "unrecognised" must mean refuse, never "skip the gate".
 */
export function classifyHost(
  host: string | null | undefined,
  opts: TrustedHostOpts & {
    lookupShare: (host: string) => ShareTarget | null;
    /** The one hostname link-mode shares are served from, if configured. */
    linkHost?: string | null;
  },
): HostDecision {
  if (isTrustedLocalHost(host, opts)) return { kind: 'local' };
  const h = normalizeHost(host);
  const target = opts.lookupShare(h);
  if (target) return { kind: 'share', target };
  const linkHost = normalizeHost(opts.linkHost ?? '');
  if (linkHost !== '' && h === linkHost) return { kind: 'link' };
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
   * Every workspace an id belongs to, most specific first — empty when it
   * belongs to none. ONE rule, consulted at BOTH places a scope question is
   * asked below (a member doc, and a `/api/workspaces/<id>/…` path segment),
   * because two rules that agree today drift apart later and the one that
   * drifts open is a breach.
   *
   * The id may be a doc OR a grouping (folder bind / diff review), and a
   * doc belongs to more than one workspace at once: its grouping, and the
   * hub board that grouping is filed on. Membership is therefore a SET, not
   * a single answer — an exact `=== workspaceOf(id)` was what refused a hub
   * visitor every review row on their own board.
   *
   * Every share is a workspace share, so this is consulted for every scope
   * question there is. A target with no workspace never reaches it: the guard
   * refuses before this parameter is read.
   */
  workspacesOf?: (id: string) => string[],
): boolean {
  // A workspace is the unit of sharing, so a target that names none grants
  // NOTHING — not even the app shell. This is the structural half of removing
  // per-doc sharing: the mint paths are gone, and a target that somehow
  // arrives without a workspace (a legacy registry record, a caller still
  // building the old shape) is refused here rather than falling through to
  // the doc rules below and being served its one doc.
  if (!target.workspaceId) return false;

  // Static app shell + assets (needed to render the review at all).
  if (pathname === '/app' || pathname.startsWith('/app/')) return true;
  if (pathname === '/widget.js' || pathname === '/widget.iife.js') return true;
  if (pathname === '/widget.esm.js' || pathname.startsWith('/widget/')) return true;
  if (pathname === '/favicon.ico') return true;

  /**
   * Is this id INSIDE the shared workspace? The one rule, and the only place
   * `workspacesOf` is read — every predicate below is it, so there is nothing
   * here for a second rule to drift away from. It used to sit beside a
   * `id === target.docId` base case; that base case WAS the per-doc grant.
   */
  const insideSharedWorkspace = (id: string): boolean => {
    const wsId = target.workspaceId;
    if (!wsId) return false;
    const owners = workspacesOf?.(id);
    // `Array.isArray` is not ceremony: this parameter used to return a bare
    // `string | null`, and a STRING also answers `.includes` — so a caller
    // still handing the old shape would silently grant on any SUBSTRING
    // match. Refusing a non-array can only close, never open.
    return Array.isArray(owners) && owners.includes(wsId);
  };

  /** Does this path segment name a DOC the share covers? */
  const inScope = (segment: string): boolean => insideSharedWorkspace(safeDecode(segment));

  /**
   * Does this `/api/workspaces/<seg>/…` segment name a workspace the share
   * covers — the shared workspace itself, or a grouping filed on it?
   *
   * Deliberately NOT `inScope`: a workspace id and a doc id come from the
   * same string space, and letting the entry DOC of a workspace share match
   * here would answer a workspace question with a doc's identity.
   */
  const inWorkspaceScope = (segment: string): boolean => {
    const id = safeDecode(segment);
    return id === target.workspaceId || insideSharedWorkspace(id);
  };

  // Workspace-hub surfaces (§3.12 commit 8) — three explicit allowances,
  // ONLY for a workspace-scope share. A doc-scoped share never reaches the
  // board: the ws:<id> room syncs every task in the workspace (§3.3 rule 2),
  // so task chips inside a shared doc resolve through the REST endpoint
  // below instead. The board room is deliberately NOT resolved through
  // `workspacesOf` (it is not a member doc) — its allowance is spelled out
  // here so granting it stays a decision, not a resolver side effect.
  if (target.workspaceId) {
    const wsId = target.workspaceId;
    // The hub page itself: GET /workspaces/<id>, nothing nested.
    if (method === 'GET' && pathname.startsWith('/workspaces/')) {
      const seg = pathname.slice('/workspaces/'.length);
      if (!seg.includes('/') && safeDecode(seg) === wsId) return true;
    }
    // The server-owned board room socket (/y/ws:<id>). Reads are the §3.3
    // visitor-contract projection; foreign writes are reverted server-side.
    if (pathname.startsWith('/y/') && safeDecode(pathname.slice('/y/'.length)) === `ws:${wsId}`) {
      return true;
    }
    // The workspace SSE feed. Task events on it are redacted for visitors
    // (actor display names only) before they reach the stream.
    if (pathname.startsWith('/events/workspace/')) {
      const seg = pathname.slice('/events/workspace/'.length);
      if (!seg.includes('/') && safeDecode(seg) === wsId) return true;
    }
    // The two REST reads the hub page makes on load. Both were closed while
    // the SAME facts rode the SSE feed above, so a visitor's page titled
    // itself with the raw workspace id and its §2.7 presence strip showed no
    // agents — with the visitor-redaction branch built for `attachments`
    // (endpoint stripped) unreachable. The transport and the surface have to
    // agree; the client swallows a non-ok, so they disagreed silently.
    //   GET <ws>              workspace name + goal text (§3.3 in-contract)
    //   GET <ws>/attachments  agent presence, redacted to PublicAttachment
    //   GET <ws>/review-items what is waiting on a person
    // Bare DELETE and every mutation stay closed (method-checked here, and
    // refused again at the route).
    //
    // `review-items` is here for the same reason the first two are: the strip's
    // decision half arrives over the board room and its thread half over REST,
    // so blocking one leaves a visitor a strip that quietly drops every doc and
    // task question. It carries workspace content only — thread asks, which a
    // workspace share already reaches through `<ws>/threads`, and a doc label
    // that is a title or a BASENAME, never a path. Note `<ws>/tasks` GET stays
    // closed and is not the precedent: tasks are closed there because the board
    // room already syncs them, not because they are withheld.
    if (method === 'GET' && pathname.startsWith('/api/workspaces/')) {
      const rest = pathname.slice('/api/workspaces/'.length);
      const slash = rest.indexOf('/');
      const seg = slash < 0 ? rest : rest.slice(0, slash);
      if (safeDecode(seg) === wsId) {
        const sub = slash < 0 ? '' : rest.slice(slash + 1);
        if (sub === '' || sub === 'attachments' || sub === 'review-items') return true;
      }
    }
  }

  // Review page / Yjs websocket / SSE for an in-scope doc.
  if (pathname.startsWith('/review/')) return inScope(pathname.slice('/review/'.length));
  if (pathname.startsWith('/y/')) return inScope(pathname.slice('/y/'.length));
  if (pathname.startsWith('/events/')) return inScope(pathname.slice('/events/'.length));

  // Doc REST surface: /api/docs/<id> and the subroutes the review UI uses.
  // NOT bare /api/docs, which lists every doc.
  if (pathname.startsWith('/api/docs/')) {
    const rest = pathname.slice('/api/docs/'.length);
    const slash = rest.indexOf('/');
    const docSeg = slash < 0 ? rest : rest.slice(0, slash);
    if (!inScope(docSeg)) return false;
    return docSubrouteAllowed(slash < 0 ? '' : rest.slice(slash + 1), method);
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
  // Two things stay closed: a workspace this share does not cover, and
  // DELETE (bare /api/workspaces/<id>), which would let a visitor destroy
  // the review.
  //
  // "Covers" is `inScope`, not string equality, and that is the whole of the
  // fix for a shared BOARD: a group bind is filed on a hub workspace, so the
  // review row a visitor can see on the board is reached through the
  // GROUPING's id while the share is scoped to the HUB's. An exact `!==`
  // refused every one of them. A grouping filed on a different board is not
  // in the set `workspacesOf` returns, so it stays refused — that half is
  // the one under test, because widening is the direction that costs.
  //
  // What this inherits, stated rather than discovered later: a diff review's
  // workspace root is the whole repo, so a board visitor who can reach the
  // review can `files`/`context-file` the repo the same way a visitor
  // invited to that review directly always could. Sharing the board is
  // sharing what is filed on it.
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
    if (!inWorkspaceScope(rest.slice(0, slash))) return false;
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

/**
 * Which `/api/docs/<id>/<sub>` calls may a share visitor make?
 *
 * A visitor is a reviewer, not an operator. They co-edit through the Yjs
 * websocket (that's the point of a live review) and comment through the
 * thread routes — but the doc's OPERATOR verbs stay local-only:
 *
 *   DELETE <doc>        destroys the review doc
 *   POST content        replaces the whole document in one call
 *   POST reparse_from_disk  discards live state, including others' edits
 *   POST threads/<id>/{rewrite_region,insert_after,insert_blocks_after}
 *                       agent-side document surgery, not a review action
 *   POST threads/<id>/promote  creates a TASK — visitors are read-only on
 *                       the hub gate, comments are their only write
 *
 * `tasks` (GET) is the §3.3 rule-2 chip endpoint: how a task chip inside a
 * shared doc resolves (id, title, status, assignee) without the visitor
 * ever syncing the workspace board room.
 *
 * Anything not named here is refused, so a subroute added later is closed
 * until someone decides a visitor should have it.
 */
function docSubrouteAllowed(sub: string, method: string): boolean {
  if (sub === '') return method === 'GET'; // meta; DELETE refused
  if (sub === 'diff' || sub === 'content') return method === 'GET';
  if (sub === 'tasks') return method === 'GET'; // task chips, visitor-safe shape
  if (sub === 'activity') return method === 'POST'; // reading tracker
  if (sub === 'threads' || sub.startsWith('threads/')) {
    return !/\/(rewrite_region|insert_after|insert_blocks_after|promote)$/.test(sub);
  }
  if (sub === 'suggestions' || sub.startsWith('suggestions/')) return true;
  return false;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
