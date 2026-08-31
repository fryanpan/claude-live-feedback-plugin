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
  /**
   * Hostnames an operator has opted in as COLLABORATION addresses — reachable
   * through the tunnel from outside the tailnet, gated by Cloudflare Access,
   * and scoped to the share surface (`collabScope` below).
   *
   * Deliberately a SECOND list rather than a widening of `extraHosts`, and
   * the difference is the security property. `extraHosts` means "another name
   * for this machine on a network I control", so its entries classify
   * `local` — the whole product, unauthenticated. Reusing it here would hand
   * tunnel visitors everything anyone ever added for a LAN reason.
   *
   * The `viaProxy` veto above is untouched: an entry here never classifies
   * local, and a request that did NOT arrive through the proxy never
   * classifies collab. The two lists cannot leak into each other.
   */
  proxiedAccessHosts?: string[];
  /**
   * Hostnames an operator has opted in as THEIR OWN public address — the
   * whole product, reached through the tunnel from outside the tailnet, gated
   * by Cloudflare Access over that hostname.
   *
   * The third list, and the widest grant, so its separation from the other
   * two is the security property. `extraHosts` classifies `local` with no
   * token at all and is refused through the proxy; `proxiedAccessHosts`
   * classifies `collab` (token, then the share surface only). An entry here
   * classifies `proxied-local`: a token, then everything loopback gets. None
   * of the three can leak into another — an entry on this list is still
   * refused by `isTrustedLocalHost` through the proxy, and an `extraHosts`
   * entry never satisfies `isProxiedTrustedHost`.
   *
   * Requires `accessFronted` exactly as the collaboration list does, and for
   * a stronger reason: honoured without Access in front, this would be the
   * full API — every doc, every workspace, share administration, the deploy
   * verb — to anyone who can reach the tunnel and type the hostname.
   */
  proxiedTrustedHosts?: string[];
  /**
   * True when a Cloudflare Access verifier really is configured for the
   * proxied hosts above — team domain AND a static audience.
   *
   * Without it the list is ignored entirely. That is the load-bearing half:
   * an opt-in host that classified collab with no Access application in front
   * would hand the share surface to anyone who can reach the tunnel and type
   * the hostname, which is precisely the hole the `viaProxy` veto closed
   * (security review 2026-08-05). Failure mode is refusal, never exposure.
   */
  accessFronted?: boolean;
  /**
   * The ONE hostname Recall.ai's backend dials this deployment on — a
   * dedicated first-level name pointed at the same tunnel, e.g.
   * `recall.<domain>` (`CW_RECALL_CALLBACK_HOST`).
   *
   * The FOURTH list, and by far the narrowest grant: not the product, not the
   * share surface, not the app shell — two routes, each of which carries its
   * own credential (a 128-bit per-bot token in the path; a Svix signature
   * over the webhook body). Everything else on it is 404. See
   * middleware/recall-callback-gate.ts for the allowlist and why each route
   * is armed only while its credential is configured.
   *
   * A SINGLE hostname rather than a list, deliberately: it is derived into
   * the callback URL handed to the vendor, and a list would have no answer to
   * "which one did we tell Recall to dial".
   *
   * Two conditions the other proxied lists impose are deliberately ABSENT
   * here, and both absences are reasoned rather than overlooked:
   *
   * - **No `accessFronted`.** Cloudflare Access is a browser flow. Recall's
   *   backend has no browser and no way to acquire a token, so an Access
   *   application in front of this hostname would refuse every real caller —
   *   which is the whole reason the exemptions this replaces existed. The
   *   credentials the two routes carry are what authenticates them.
   * - **No `viaProxy` requirement.** That veto exists so a tunnel visitor
   *   cannot claim `Host: localhost` and be served the product; there is no
   *   product here to serve. Requiring it would also break any deployment
   *   fronted by something that is not Cloudflare (no `cf-ray`), turning a
   *   working bot into one that joins, records, bills and delivers nothing.
   */
  recallCallbackHost?: string | null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * Is this PEER ADDRESS loopback — i.e. did the request come from a process on
 * this machine?
 *
 * Deliberately not a Host check, and the difference is the whole point.
 * Everything else in this file classifies the `Host` header, which is
 * client-controlled: measured 2026-08-17 against a real `Bun.serve`, a LAN
 * client (`192.168.x.x`) and a tailnet client (`100.x.x.x`) both connected
 * while sending `Host: localhost:1`, and both were classified local. A gate
 * built on the Host header is therefore spoofable by exactly the callers it
 * would exist to exclude. `server.requestIP(req)` reports the address the
 * kernel saw, which a client cannot choose.
 *
 * Two shapes that are easy to get wrong, both pinned by tests:
 *
 * - Bun reports an IPv4 loopback peer as **`::ffff:127.0.0.1`** (IPv4-mapped
 *   IPv6). An `=== '127.0.0.1'` comparison refuses the only caller this is
 *   meant to allow.
 * - Loopback is the whole of `127.0.0.0/8`, not just `127.0.0.1`.
 *
 * `null` answers false. `requestIP` returns null for a socket that has
 * already gone away, and "I could not read the peer" must never authorise a
 * privileged operation. `0.0.0.0` and `::` are bind wildcards rather than
 * peer addresses, so they answer false too — they appear in the Host-matching
 * set above for a different question.
 */
export function isLoopbackAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const a = addr.trim().toLowerCase();
  if (a === '::1') return true;
  // Unwrap IPv4-mapped IPv6 (`::ffff:127.0.0.1`) before matching v4.
  const v4 = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a;
  // Anchored and fully numeric: `127.0.0.1.evil.example` must not match.
  const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return false;
  return octets[0] === 127;
}

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

/**
 * Is this Host an operator-declared COLLABORATION address arriving through
 * the Cloudflare tunnel?
 *
 * Three conditions, all required, and each one closes a different door:
 *
 *   - `viaProxy` — the request really came through the edge. A host in the
 *     list reached any other way (a LAN client sending the name directly)
 *     has no Access token in front of it, so it is denied rather than
 *     collab. Note this is the OPPOSITE test to `isTrustedLocalHost`, on
 *     purpose: that one refuses proxied requests, this one requires them, and
 *     no request can satisfy both.
 *   - `accessFronted` — Cloudflare Access is configured. See the field.
 *   - exact membership — no suffix matching, same rule as the local list:
 *     `workspaces.example.com.attacker.com` must not match.
 */
export function isAccessTunnelHost(
  host: string | null | undefined,
  opts: TrustedHostOpts,
): boolean {
  if (!opts.viaProxy) return false;
  if (!opts.accessFronted) return false;
  const h = normalizeHost(host);
  if (h === '') return false;
  return (opts.proxiedAccessHosts ?? [])
    .map((c) => normalizeHost(c))
    .filter((c) => c !== '')
    .includes(h);
}

/**
 * Is this Host the OPERATOR'S own public address arriving through the
 * Cloudflare tunnel?
 *
 * The same three conditions as `isAccessTunnelHost` — the request really came
 * through the edge, Access really is configured, exact membership — against
 * the `proxiedTrustedHosts` list instead. What differs is what the caller
 * does with a `true`: verify the Access token and then serve the product as
 * if the request were on loopback, rather than the share surface.
 *
 * Deliberately NOT a widening of `isTrustedLocalHost`. That predicate's
 * `viaProxy` veto is the fix from the 2026-08-05 review and stays absolute;
 * this one is a separate door with a separate key.
 */
export function isProxiedTrustedHost(
  host: string | null | undefined,
  opts: TrustedHostOpts,
): boolean {
  if (!opts.viaProxy) return false;
  if (!opts.accessFronted) return false;
  const h = normalizeHost(host);
  if (h === '') return false;
  return (opts.proxiedTrustedHosts ?? [])
    .map((c) => normalizeHost(c))
    .filter((c) => c !== '')
    .includes(h);
}

/**
 * Is this Host the dedicated hostname Recall.ai dials back on?
 *
 * Exact match against the single configured name, same rule as every other
 * list here: no suffix matching, so `recall.example.com.attacker.com` is not
 * it. Unconfigured (the ordinary state — no meeting bots, or bots reached
 * some other way) answers false for every Host, which leaves the hostname
 * unknown and therefore denied.
 *
 * Deliberately NOT a widening of any existing list. `extraHosts` classifies
 * `local` — the whole product, no token; `proxiedAccessHosts` classifies
 * `collab`; `proxiedTrustedHosts` classifies `proxied-local`. All three are
 * grants to PEOPLE, gated by something a person can present. This one is a
 * grant to a VENDOR'S BACKEND, gated by credentials only that backend holds,
 * and it reaches two routes. Keeping it a fourth door is what stops the
 * unauthenticated one from ever being the door people use.
 */
export function isRecallCallbackHost(
  host: string | null | undefined,
  opts: TrustedHostOpts,
): boolean {
  const configured = normalizeHost(opts.recallCallbackHost ?? '');
  if (configured === '') return false;
  const h = normalizeHost(host);
  if (h === '') return false;
  return h === configured;
}

/**
 * What a share hostname grants access to.
 *
 * One field, and that is the whole point. A target used to carry a `docId`
 * as well — the doc the share URL opened — and while it was documented as a
 * landing address rather than a grant, "always in scope" is precisely what a
 * per-doc share WAS. That base case went with the per-doc removal, and the
 * field went with the board-only removal after it: a board share opens the
 * board, so there is no entry doc left for anything to read.
 */
export interface ShareTarget {
  /**
   * The BOARD this share covers. Every doc filed on it is in scope, along
   * with the navigation endpoints that make the set browsable.
   *
   * REQUIRED, and it is the ONLY source of scope. Typed optional so a caller
   * that still constructs the old doc-only shape is refused by the guard
   * below rather than rejected by the compiler and then shipped anyway — an
   * absent workspaceId grants nothing.
   */
  workspaceId?: string;
}

export type HostDecision =
  | { kind: 'local' } // trusted local caller: no gate
  | { kind: 'share'; target: ShareTarget } // per-share Access host: JWT + scope
  | { kind: 'link' } // public link host: authorize from the session cookie
  | { kind: 'collab' } // Access-fronted collaboration host: JWT + collabScope
  | { kind: 'proxied-local' } // Access-fronted operator host: JWT, then local
  | { kind: 'recall-callback' } // the bot callback host: two routes, nothing else
  | { kind: 'deny'; reason: 'unknown_host' }; // anything else: refuse

/**
 * Classify a request's Host.
 *
 * Order matters: our own names win, then the bot callback hostname, then a
 * per-share Access hostname, then the single public hostname that link shares
 * live on, then the operator's opt-in collaboration hosts, then the
 * operator's own proxied address.
 * Anything else is refused — the tunnel forwards every hostname under its
 * ingress here, so "unrecognised" must mean refuse, never "skip the gate".
 *
 * The external kinds are checked narrowest-first on purpose, and the widest
 * — `proxied-local`, the whole product — LAST. Putting a name in an opt-in
 * list must never quietly take a hostname AWAY from the narrower rule that
 * already claimed it: a host listed as both collab and proxied-trusted stays
 * collab. With both lists empty — every deployment that has not opted in —
 * this function behaves exactly as it did before either branch existed.
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
  // The narrowest external kind, so it is checked FIRST among them: a name
  // configured as the bot callback host can only ever lose surface by being
  // matched here, never gain any.
  if (isRecallCallbackHost(host, opts)) return { kind: 'recall-callback' };
  const h = normalizeHost(host);
  const target = opts.lookupShare(h);
  if (target) return { kind: 'share', target };
  const linkHost = normalizeHost(opts.linkHost ?? '');
  if (linkHost !== '' && h === linkHost) return { kind: 'link' };
  if (isAccessTunnelHost(host, opts)) return { kind: 'collab' };
  if (isProxiedTrustedHost(host, opts)) return { kind: 'proxied-local' };
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
   * The id may be a doc OR a review (folder bind / diff review), and a
   * doc belongs to more than one workspace at once: its review, and the
   * hub board that review is filed on. Membership is therefore a SET, not
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
   * covers — the shared workspace itself, or a review filed on it?
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
    /**
     * The workspace's pages: `/workspaces/<id>` and the resources under it.
     *
     * This used to be `/workspaces/<id>` and NOTHING nested — the allowance
     * read `if (!seg.includes('/'))`. That was correct while the workspace
     * page was the only thing at this prefix, and it silently became a bug the
     * moment the page grew tabs: a visitor landed on the share link, clicked
     * Tasks, and was refused by the guard. Now that every doc, review and
     * mockup also lives under this prefix, "one segment only" would refuse
     * the entire product.
     *
     * Each nested shape is spelled out rather than admitted by depth. A rule
     * like "anything under the shared workspace" grants routes that do not
     * exist yet, which makes adding one an accidental publication rather than
     * a decision.
     *
     * Two independent checks on the nested forms, and both are load-bearing:
     * the WORKSPACE segment must be the shared one, and the resource must be
     * in that workspace's scope. Dropping the second would let a visitor read
     * any doc on the server by spelling their own workspace id in front of it.
     */
    if (method === 'GET' && pathname.startsWith('/workspaces/')) {
      const rest = pathname.slice('/workspaces/'.length);
      const slash = rest.indexOf('/');
      const wsSeg = slash === -1 ? rest : rest.slice(0, slash);
      if (safeDecode(wsSeg) === wsId) {
        const sub = slash === -1 ? '' : rest.slice(slash + 1);
        // The workspace page itself and its nav tabs. A named list — a tab
        // added later has to be added here too, on purpose.
        if (sub === '' || ['home', 'tasks', 'mine', 'activity'].includes(sub)) return true;
        // `<kind>/<id>` and nothing deeper. An id never contains a slash, so
        // a third segment is a typo or a probe either way.
        const cut = sub.indexOf('/');
        if (cut !== -1) {
          const kind = sub.slice(0, cut);
          const id = sub.slice(cut + 1);
          if (!id.includes('/') && ['docs', 'reviews', 'mockups'].includes(kind)) {
            return insideSharedWorkspace(safeDecode(id));
          }
        }
      }
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
  // refused every one of them. A review filed on a different board is not
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
  //
  // TWO PREFIXES, ONE RULE. `/api/reviews/<setId>/…` is what these endpoints
  // are called now — a review is not a workspace, and the old name is the
  // vocabulary this change exists to remove. `/api/workspaces/<id>/…` still
  // answers because the callers are plugin bundles in sessions nobody can
  // restart. Both spellings are judged here, by the same lines: a second rule
  // for the alias would agree today and drift later, and the one that drifts
  // open is a breach.
  const navPrefix = ['/api/reviews/', '/api/workspaces/'].find((p) => pathname.startsWith(p));
  if (navPrefix) {
    if (!target.workspaceId) return false;
    const rest = pathname.slice(navPrefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return false; // bare /api/<prefix>/<id> is DELETE-only
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
 * A workspace id no store can mint, used as the target when a path names no
 * workspace at all. Every workspace-dependent rule in `shareScopeAllows`
 * compares against `target.workspaceId` or looks it up in `workspacesOf`, so
 * a value containing a NUL byte answers false everywhere — leaving exactly
 * the static app-shell allowances, which is what a shell path should get.
 *
 * A sentinel rather than an `undefined` workspace because an absent
 * `workspaceId` is refused outright by the guard, shell and all.
 */
const NO_WORKSPACE = '\u0000collab-no-workspace';

/**
 * May a request on a COLLABORATION host touch this path?
 *
 * The surface is the share surface — read the docs, open the board, comment —
 * for whichever workspace the path names, rather than for one workspace fixed
 * at mint time. That is the whole difference between this and a share host:
 * a share hostname carries its scope, and a collaboration hostname is one
 * stable address whose scope is decided per request.
 *
 * It is ONE rule, not two. Everything is answered by `shareScopeAllows` with
 * the path's own workspace as the target, so the operator verbs a share
 * visitor is refused — the doc list, share administration, folder binds, diff
 * creation, DELETE, `content`, `reparse_from_disk`, the landing page — are
 * refused here by the same lines, and a route added to one is added to both.
 * A second allowlist would agree today and drift later, and the one that
 * drifts open is the breach.
 *
 * Returns the target as well as the verdict because the caller needs it: the
 * request is served as an untrusted visitor scoped to that workspace, exactly
 * as a share visitor is.
 */
export function collabScope(
  pathname: string,
  method: string,
  workspacesOf?: (id: string) => string[],
): { allowed: false } | { allowed: true; target: ShareTarget } {
  const workspaceId = pathWorkspace(pathname, workspacesOf);
  const allowed = shareScopeAllows(
    pathname,
    method,
    { workspaceId: workspaceId ?? NO_WORKSPACE },
    workspacesOf,
  );
  if (!allowed) return { allowed: false };
  // A shell path names no workspace, so the visitor it creates is scoped to
  // none — `{}` rather than the sentinel, which must never escape this file.
  return { allowed: true, target: workspaceId ? { workspaceId } : {} };
}

/**
 * Which workspace does this path address — directly, or through the doc it
 * names? Null when it names neither, which is every static asset and every
 * enumerate-the-server route.
 *
 * Deliberately permissive: it only proposes a candidate, and
 * `shareScopeAllows` then decides whether the path is reachable AT ALL and
 * whether the id really belongs to that workspace. Proposing the wrong
 * workspace cannot open anything — the membership check refuses it — so the
 * failure mode of a parsing mistake here is a 403, not a leak.
 */
function pathWorkspace(pathname: string, workspacesOf?: (id: string) => string[]): string | null {
  /** The first path segment after `prefix`, or null when it doesn't match. */
  const seg = (prefix: string): string | null => {
    if (!pathname.startsWith(prefix)) return null;
    const rest = pathname.slice(prefix.length);
    const slash = rest.indexOf('/');
    const s = slash < 0 ? rest : rest.slice(0, slash);
    return s === '' ? null : safeDecode(s);
  };

  // Paths whose segment IS a workspace (or a review filed on one — the guard
  // accepts either through `inWorkspaceScope`).
  const named = seg('/events/workspace/') ?? seg('/workspaces/') ?? seg('/api/reviews/');
  if (named) return named;
  // `/api/workspaces/` splits: `<id>/tree` names a workspace, and so does the
  // bare `<id>`; the LIST route has no segment and falls through to null.
  const wsApi = seg('/api/workspaces/');
  if (wsApi) return wsApi;
  // The board room socket is `/y/ws:<id>`; every other `/y/<id>` is a doc.
  const room = seg('/y/');
  if (room?.startsWith('ws:')) return room.slice('ws:'.length);

  // Paths that name a DOC — its own workspace, most specific first.
  const doc = seg('/review/') ?? room ?? seg('/events/') ?? seg('/api/docs/');
  if (!doc) return null;
  return workspacesOf?.(doc)?.[0] ?? null;
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
  if (sub === 'diff' || sub === 'content' || sub === 'status') return method === 'GET';
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
