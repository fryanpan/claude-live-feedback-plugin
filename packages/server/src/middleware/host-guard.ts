/**
 * Host-based access control for a server that is reachable over a public
 * tunnel.
 *
 * Three rules live here. The first two were learned from a security review
 * (2026-08-05); the third is the owner's 2026-09-02 call, below.
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
 * 3. **Access on every browser-facing hostname** (Bryan, 2026-09-02: *"Every
 *    access including share link or reading requires sign in via one time
 *    code or otherwise… Let's make everyone go through cloudflare access. No
 *    internal hole."*). `accessOnly` is that rule, and the server turns it on
 *    by default.
 *
 *    THE RULE: the only zone that reaches this server without a verified
 *    Cloudflare Access identity is a process on the box — a request whose
 *    Host is a loopback name AND whose socket peer is a loopback address.
 *    Every other hostname is browser-facing, so it must classify into a kind
 *    that verifies an Access token (`share`, `collab`, `proxied-local`) or be
 *    denied.
 *
 *    THE HOLE IT CLOSES, in two halves. The first is the tailnet and the LAN:
 *    `tailscaleHost`, `lanHosts` and `extraHosts` classified `local`, so any
 *    browser on the private network read every board, doc, attachment, file
 *    tree and diff, and opened any Yjs socket, with no identity at all. The
 *    second is that `local` was decided from the `Host` header, which the
 *    client writes: measured 2026-08-17, a LAN client and a tailnet client
 *    each sending `Host: localhost:1` were both classified local, so the
 *    first half could be walked around by typing. Requiring the peer address
 *    to be loopback is what makes "on the box" a fact the kernel reports
 *    rather than a claim the caller makes.
 *
 *    What it does NOT close: a process already running on the box. That is
 *    inside the trust boundary either way — it can read this server's memory.
 *
 * All three are pure predicates so they can be unit-tested without a server,
 * and are additionally exercised at the HTTP layer — the route layer is the part
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
   * The SHARE hostname(s) — `share.<domain>` — where a share link is opened
   * and where the people who redeemed one keep working.
   *
   * The FIFTH list, and the one whose Access application admits EVERYONE:
   * its policy is "any email, one-time PIN", so passing Cloudflare there
   * proves an address and grants nothing at all. What decides a share-host
   * visitor's reach is this server's own membership record — the emails that
   * have redeemed a live link for a workspace (`ShareLinks.isMember`).
   *
   * Separate from `proxiedAccessHosts` for exactly that reason, and the
   * separation is the security property. A collaboration hostname sits behind
   * an application whose policy names people the operator admitted; this one
   * sits behind an application that admits the world. Merging the lists would
   * make "the operator let this address through the door" and "anybody with
   * an email" the same fact, and every workspace reachable from the wider one
   * would inherit the narrower one's trust.
   *
   * Requires `shareLinkAccessFronted` — its own audience, not the owner's.
   */
  shareLinkHosts?: string[];
  /**
   * True when a Cloudflare Access verifier is configured for the SHARE
   * hostname specifically: team domain AND the share application's own
   * audience (`CF_ACCESS_SHARE_AUD`).
   *
   * A SECOND flag rather than a reuse of `accessFronted`, and this is the
   * audience cross-check made structural. The share application and the
   * owner's application are different applications with different AUD tags;
   * verifying a share-host request against the owner's audience would accept
   * the operator's own token on the everyone-policy hostname, and verifying
   * an owner-host request against the share audience would accept a token
   * anyone on the internet can mint by typing an email. One flag would have
   * let a deployment configure one and silently get the other.
   */
  shareLinkAccessFronted?: boolean;
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
  /**
   * ACCESS-ONLY mode: every browser-facing hostname is behind Cloudflare
   * Access, and the only unauthenticated zone is a process on the box.
   *
   * On, `isTrustedLocalHost` answers true for a loopback Host and a loopback
   * `loopbackPeer` and nothing else — `tailscaleHost`, `lanHosts` and
   * `extraHosts` stop granting anything, so a tailnet or LAN browser falls
   * through to `deny` unless its hostname is on one of the Access lists. See
   * rule 3 in this file's header for the hole that closes.
   *
   * Off restores the pre-2026-09-02 classification, which is what the tests
   * of the LAN-alias grant still exercise. The deployment switch is
   * `CW_ACCESS_ONLY_BROWSER_HOSTS` (server-config.ts), and it defaults ON;
   * this option defaults OFF so that a caller constructing opts by hand gets
   * the behaviour its other fields describe rather than a silent narrowing.
   */
  accessOnly?: boolean;
  /**
   * True when the request's SOCKET PEER is a loopback address — what
   * `isLoopbackAddress(server.requestIP(req)?.address)` answers.
   *
   * Read only under `accessOnly`, and it is the half the Host header cannot
   * fake. Absent answers false, so "I could not read the peer" is never "on
   * the box".
   *
   * Note what it does NOT distinguish: both of this deployment's reverse
   * proxies terminate on this machine and dial the server over loopback, so
   * a Cloudflare visitor and a `tailscale serve` visitor BOTH arrive with a
   * loopback peer (measured — see middleware/client-address.ts). Their Host
   * is the tunnel or MagicDNS name rather than a loopback name, which is
   * what separates them here, and the `viaProxy` veto separates the
   * Cloudflare one again.
   */
  loopbackPeer?: boolean;
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
  // Access-only: the box, and nothing else. BOTH halves are required — the
  // Host says which surface was asked for, the peer address says the caller
  // is really on this machine, and the header alone is client-controlled.
  if (opts.accessOnly) return LOOPBACK.has(h) && opts.loopbackPeer === true;
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
 * Is this Host the SHARE hostname arriving through the Cloudflare tunnel?
 *
 * The same three conditions every proxied list imposes — the request really
 * came through the edge, Access really is configured, exact membership — with
 * one difference that is the whole point: the Access condition it checks is
 * `shareLinkAccessFronted`, the SHARE application's own audience, not the
 * owner's. A deployment that configured `CF_ACCESS_AUD` and nothing else
 * classifies no share host at all, which is refusal rather than a hostname
 * verified against the wrong application.
 *
 * What a `true` means to the caller is narrower than it looks: the
 * application behind this hostname admits any email, so classifying here
 * grants only the chance to present a verified address. Everything after that
 * is the membership check.
 */
export function isShareLinkHost(host: string | null | undefined, opts: TrustedHostOpts): boolean {
  if (!opts.viaProxy) return false;
  if (!opts.shareLinkAccessFronted) return false;
  const h = normalizeHost(host);
  if (h === '') return false;
  return (opts.shareLinkHosts ?? [])
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
  | { kind: 'share-link' } // the share hostname: JWT (share aud) + membership
  | { kind: 'collab' } // Access-fronted collaboration host: JWT + collabScope
  | { kind: 'proxied-local' } // Access-fronted operator host: JWT, then local
  | { kind: 'recall-callback' } // the bot callback host: two routes, nothing else
  | { kind: 'deny'; reason: 'unknown_host' }; // anything else: refuse

/**
 * Classify a request's Host.
 *
 * Order matters: our own names win, then the bot callback hostname, then a
 * per-share Access hostname, then the share hostname, then the operator's
 * opt-in collaboration hosts, then the operator's own proxied address.
 * Anything else is refused — the tunnel forwards every hostname under its
 * ingress here, so "unrecognised" must mean refuse, never "skip the gate".
 *
 * There is no `link` kind any more. The single public hostname link-mode
 * shares were served from used to classify here and be authorized from a
 * signed COOKIE, which is precisely the browser-facing surface that reached
 * board content with no verified identity behind it. It is now an
 * unrecognised hostname like any other unless the operator also lists it as
 * a collaboration host, where it gets an Access token like everyone else.
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
  // Ahead of `collab` on purpose. The two surfaces are the same size, and a
  // hostname on both lists must resolve to the one whose Access application
  // admits the WORLD — served as a share host, every workspace decided by
  // this server's membership record. Resolving it as `collab` instead would
  // judge an everyone-policy visitor by the collaboration hostname's
  // membership rule (a live share's allow list), which was written for an
  // application that admits only people the operator named.
  if (isShareLinkHost(host, opts)) return { kind: 'share-link' };
  if (isAccessTunnelHost(host, opts)) return { kind: 'collab' };
  if (isProxiedTrustedHost(host, opts)) return { kind: 'proxied-local' };
  return { kind: 'deny', reason: 'unknown_host' };
}

/**
 * What a MEMBER of a shared board may do ON that board, by route name.
 *
 * A share used to admit a reader: comments, suggestions, the reading tracker,
 * and document text over the live-editing socket. Bryan's 2026-09-03 call
 * ("Let's allow everything for now") makes an admitted member a participant
 * instead, so the acts a board is worked with — filing a task, editing one,
 * moving its status, answering what is waiting on a person, organising the
 * goal bands — are named here.
 *
 * THREE TABLES, one shape: `<route sub-path>` to the methods allowed on it.
 * Named routes rather than a prefix wildcard, because a wildcard grants
 * routes that do not exist yet, and adding one then becomes an accidental
 * publication rather than a decision. Anything absent is refused.
 *
 * Every one of them is still asked the workspace question first. These tables
 * say WHICH ACT is a member's; `shareScopeAllows` says which board it may be
 * done on, and the ids in `/api/tasks/<id>` and `/api/goals/<id>` are resolved
 * through the same `workspacesOf` every other scope question uses — as
 * `task:<id>`, which is the id a board holds a task's body under.
 */
const BOARD_MEMBER_ROUTES: Readonly<Record<string, readonly string[]>> = {
  // Reads that predate membership — the workspace record, the presence strip,
  // and the review-item queue the strip's thread half arrives on.
  '': ['GET'],
  attachments: ['GET'],
  'review-items': ['GET'],
  // The board's rows. GET is the list the Tasks pane pages through; POST is
  // filing one. The board room syncs the same rows, so the GET is a
  // convenience rather than a new disclosure.
  tasks: ['GET', 'POST'],
  // The Home pane and its per-person "caught up" marker.
  home: ['GET'],
  'home/read': ['POST'],
  // The Home brief's own recipe — how this board's summary is written. Board
  // content in the owner's words, edited from the Home pane's own control.
  'home/instructions': ['PUT'],
  // The goal bands: naming one, renaming one, and ranking them. Reorder is
  // the same organising act as the other two and was the gap in it — a member
  // could add a band and rename it, and not say which came first.
  'goals/add': ['POST'],
  'goals/rename': ['POST'],
  'goals/reorder': ['POST'],
  // Filing a doc on this board. The route additionally requires the target to
  // be one the member can ALREADY open here (`workspace-content.ts`), because
  // attaching is what makes a doc readable on a board — so an unrestricted
  // attach would be a read of somebody else's doc wearing a write's clothes.
  // What is left is the verb's real subject: a file inside a folder bind or a
  // diff review already filed here, which has no row of its own.
  docs: ['POST'],
  // "Make a plan" and "Have a meeting". One call mints a board-tied doc and
  // files it here; the mic is the browser's own. The reply's doc metadata is
  // redacted for a visitor at the route — a huddle's `sourceUrl` is a path in
  // the owner's data directory.
  huddles: ['POST'],
  // The board's settings panel: the review-item criteria, the effort prompt
  // and the parallelism cap. `notesHome` is withheld from a member's read and
  // refused on a member's write — it is a checkout path on the owner's
  // machine, and validating one would answer "does this path exist" besides.
  settings: ['GET', 'PUT'],
  // The Activity tab. Rows are passed through the same visitor redaction the
  // board's live event stream uses, so actor ids do not arrive here by the
  // one door nothing was checking.
  events: ['GET'],
  // The board client's own boot report — one line per page load, written by
  // the page that just painted and read back on the same tab.
  'load-reports': ['GET', 'POST'],
};

/** The per-task verbs, under `/api/tasks/<taskId>/`. See BOARD_MEMBER_ROUTES. */
const TASK_MEMBER_ROUTES: Readonly<Record<string, readonly string[]>> = {
  transition: ['POST'],
  evidence: ['POST'],
  goal: ['POST'],
  after: ['POST'],
  title: ['POST'],
  body: ['POST'],
  assignee: ['POST'],
  due: ['POST'],
  park: ['POST'],
  archive: ['POST'],
  restore: ['POST'],
  answer: ['POST'],
  'answer/undo': ['POST'],
  'more-info': ['POST'],
  links: ['GET', 'POST', 'DELETE'],
  'review-items': ['POST'],
  // The item verbs, spelled with their id segment elided — see
  // `taskSubroutePattern`. Answering, asking back, releasing a hold,
  // revising the ask, and taking it back.
  'review-items/*/answer': ['POST'],
  'review-items/*/more-info': ['POST'],
  'review-items/*/release': ['POST'],
  'review-items/*/revise': ['POST'],
  'review-items/*/withdraw': ['POST'],
  'review-items/*/withdraw/undo': ['POST'],
};

/** The per-goal verbs, under `/api/goals/<goalId>/`. A goal row lives in the
 *  same `task:<id>` id space as a task body, so it resolves the same way. */
const GOAL_MEMBER_ROUTES: Readonly<Record<string, readonly string[]>> = {
  cascade: ['GET'],
  archive: ['POST'],
  restore: ['POST'],
};

/**
 * One table lookup, and the reason it is a function rather than `table[sub]`.
 *
 * `sub` is a path segment the CALLER typed. On a plain object literal
 * `toString`, `constructor`, `valueOf` and `__proto__` all resolve up
 * Object.prototype to something truthy that is not an array, `?.includes(...)`
 * on it throws, the exception escapes the guard, and the connection closes
 * with no response at all — which is neither an allow nor a deny, chosen by
 * whoever sent the request. `Object.hasOwn` asks the table and nothing above
 * it, so an unlisted segment is an ordinary refusal like every other one.
 */
function memberRouteAllows(
  table: Readonly<Record<string, readonly string[]>>,
  sub: string,
  method: string,
): boolean {
  if (!Object.hasOwn(table, sub)) return false;
  return table[sub]?.includes(method.toUpperCase()) === true;
}

/**
 * `review-items/r-7/answer` to `review-items/*\/answer`, so one table entry
 * covers every item id.
 *
 * Only the segment after `review-items` is elided, and only when there is
 * exactly one. Eliding by position rather than by pattern is what keeps
 * `review-items/<id>/withdraw/undo` a DIFFERENT key from
 * `review-items/<id>/withdraw`: the table decides, not the parser.
 */
function taskSubroutePattern(sub: string): string {
  const parts = sub.split('/');
  if (parts[0] !== 'review-items' || parts.length < 3) return sub;
  return ['review-items', '*', ...parts.slice(2)].join('/');
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
   * board that review is filed on. Membership is therefore a SET, not
   * a single answer — an exact `=== workspaceOf(id)` was what refused a board
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
   * Who am I, and may I write? — `GET /api/auth/session`.
   *
   * The board's bundle asks this before it paints anything. Refused, it fell
   * back to "nobody is signed in" and opened the "Who's reviewing?" name
   * prompt, which `main()` awaits — so a member landing on their board saw a
   * modal asking them to type a name and NO BOARD BEHIND IT until they
   * dismissed it. Measured in headless Chromium on 2026-09-03.
   *
   * It carries the caller's own identity and nothing else: the email
   * Cloudflare Access already proved to reach this hostname, the display name
   * derived from it, and whether this deployment demands a sign-in to write.
   * Telling somebody who they are cannot tell them anything they did not
   * bring. `GET` only, and the sign-in flow's other routes stay out — there
   * is no second sign-in behind Access to start or finish.
   */
  if (pathname === '/api/auth/session' && method.toUpperCase() === 'GET') return true;
  /**
   * Which transcription engines this server can run — `GET /api/meeting-engines`.
   *
   * Names no workspace, so it sits with the shell allowances rather than
   * behind the board check. The meeting chooser reads it before a meeting
   * starts, and refused it offered engines that answer `unavailable`.
   *
   * What it carries is a list of engine names and which is the default.
   * Nothing about a key beyond the fact that one is set, which the button it
   * draws would announce anyway the first time somebody pressed it.
   */
  if (pathname === '/api/meeting-engines' && method.toUpperCase() === 'GET') return true;

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

  // Workspace-board surfaces (§3.12 commit 8) — three explicit allowances,
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
    // The board's own REST surface, `<sub>` by `<sub>` and method by method:
    // BOARD_MEMBER_ROUTES. Everything not in that table is refused here, so a
    // route added to the workspace prefix later is closed until someone puts
    // it in the table on purpose.
    //
    // It used to be three GETs — the workspace record, the presence strip and
    // the review-item queue — because a visitor was a reader. A member of a
    // shared board is a PARTICIPANT (Bryan, 2026-09-03: "Let's allow
    // everything for now"), so the table now also carries the writes that
    // filing and organising work on this board are made of. What did NOT move
    // is where the answer comes from: the segment must still be the shared
    // workspace, and every id nested under it still goes through
    // `insideSharedWorkspace`.
    //
    // Four of those entries used to be reasons NOT to admit a route, and each
    // named a leak rather than a permission. Bryan's 2026-09-03 call is that a
    // share link means full access to the board, so each leak was closed where
    // it lives and the route admitted:
    //   `docs`          the route refuses a target another board holds, so
    //                   attaching cannot be a read of somebody else's board.
    //   `settings`      `notesHome` — a checkout path on the owner's machine —
    //                   is withheld from a member's read and refused on a
    //                   member's write, at the route.
    //   `events`        every row is passed through the same redaction the
    //                   board's live stream uses, so the audit log cannot say
    //                   more about an actor than the stream already does.
    // `import-tasks` is the one that STAYS refused, and it was reconsidered
    // rather than carried over: it reads a file off the owner's disk by the
    // path in the request body and answers with what it parsed, so admitting
    // it would be an arbitrary file read on the owner's machine for anyone
    // holding a share link. The browser gate in front of it is not the answer
    // either — it refuses pages, and a member's non-browser client is not a
    // page. Nothing names a host path on a member's behalf.
    // What stays off the table is the agent roster's own verbs — `attachments`
    // POST, `agent-heartbeat`, `dispatches`, `agent-notes`: a seat on the
    // board, not work on it. `voice` stays off too — it routes an utterance to
    // the owner's agents, which is spending the owner's machine rather than
    // working the board. Board lifecycle (`DELETE`, `rename`, `retired`,
    // `lead`) stays closed: a member was given a board to work on, not to
    // retire.
    if (pathname.startsWith('/api/workspaces/')) {
      const rest = pathname.slice('/api/workspaces/'.length);
      const slash = rest.indexOf('/');
      const seg = slash < 0 ? rest : rest.slice(0, slash);
      if (safeDecode(seg) === wsId) {
        const sub = slash < 0 ? '' : rest.slice(slash + 1);
        if (memberRouteAllows(BOARD_MEMBER_ROUTES, sub, method)) return true;
      }
    }
  }

  /**
   * A meeting's live audio socket, for a doc inside the shared board.
   *
   * The other half of "have a meeting": the button mints the doc, this is
   * where the microphone goes. Scoped by exactly the same `inScope` the
   * doc's own text socket is, so a member can hold a meeting on their board
   * and on no other.
   *
   * It spends money while it is open — a transcription engine session per
   * meeting — which is the honest cost of the grant and not a reason to
   * withhold it: a member can already spend the same engine by being in the
   * room while the owner records. Two things the socket still checks for
   * itself, unchanged by this line: the browser's Origin, and the sign-in
   * (a websocket upgrade is a GET, so the write gate cannot see it).
   */
  if (pathname.startsWith('/audio/')) return inScope(pathname.slice('/audio/'.length));

  // Review page / Yjs websocket / SSE for an in-scope doc.
  if (pathname.startsWith('/review/')) return inScope(pathname.slice('/review/'.length));
  if (pathname.startsWith('/y/')) return inScope(pathname.slice('/y/'.length));
  // The agent-multiplexed feed is never a share surface: one stream carries
  // every channel that agent watches, which is by construction wider than any
  // board a share covers. Refused by name rather than left to `inScope`
  // failing on the slash — a doc id has none today, and this must not become
  // reachable if that ever changes.
  if (pathname.startsWith('/events/agent/')) return false;
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

  // Task and goal rows: `/api/tasks/<taskId>/<verb>` and
  // `/api/goals/<goalId>/<verb>`. Neither path spells a workspace out, so the
  // row's own id is resolved through `insideSharedWorkspace` — as
  // `task:<rowId>`, the id a board holds a task body or a goal body under.
  // That is the SAME resolver every other scope question here reads, which is
  // what stops a second membership rule existing to drift open later.
  //
  // A row on another board answers false at that step, so `POST
  // /api/tasks/<someone-elses>/transition` is refused by the same line that
  // refuses reading their doc.
  //
  // Bare `/api/tasks/<id>` is not in the table and therefore refused: the row
  // itself arrives over the board room, and a bare-path read would be a
  // second, unredacted spelling of it.
  const rowPrefix = ['/api/tasks/', '/api/goals/'].find((p) => pathname.startsWith(p));
  if (rowPrefix) {
    const rest = pathname.slice(rowPrefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return false;
    const rowId = safeDecode(rest.slice(0, slash));
    if (!insideSharedWorkspace(`task:${rowId}`)) return false;
    const table = rowPrefix === '/api/tasks/' ? TASK_MEMBER_ROUTES : GOAL_MEMBER_ROUTES;
    const sub =
      rowPrefix === '/api/tasks/'
        ? taskSubroutePattern(rest.slice(slash + 1))
        : rest.slice(slash + 1);
    return memberRouteAllows(table, sub, method);
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
  // They are bounded by the workspace root — docStore.openContextFile /
  // openEditableFile reject any relPath that escapes it ('bad-path').
  //
  // Two things stay closed: a workspace this share does not cover, and
  // DELETE (bare /api/workspaces/<id>), which would let a visitor destroy
  // the review.
  //
  // "Covers" is `inScope`, not string equality, and that is the whole of the
  // fix for a shared BOARD: a group bind is filed on a board workspace, so the
  // review row a visitor can see on the board is reached through the
  // GROUPING's id while the share is scoped to the BOARD's. An exact `!==`
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
  // "Any of them" means any file the TREE shows. Both open verbs are bound
  // by `git ls-files --cached --others --exclude-standard` in
  // docStore.openContextFile / openEditableFile — an ignored `.env` under the
  // root, or anything under `.git/`, answers 404 by path however the caller
  // spells it (Urgent-fixes ticket, 2026-09-02). This allowlist admits the
  // route; the listing decides the file.
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
 * What `collabScope` needs to answer, beyond the path itself.
 *
 * `isMember` is REQUIRED, and the options object exists so that it is. It
 * used to be a third positional parameter list ending in an optional
 * `workspacesOf`, and appending an optional membership check to that would
 * have made "forgot to pass it" mean "admitted everybody" — the exact
 * failure this predicate was added to remove.
 */
export interface CollabScopeOpts {
  /** See the same parameter on `shareScopeAllows`. */
  workspacesOf?: (id: string) => string[];
  /**
   * Is the request's Access-verified email a member of this workspace?
   *
   * The server owns the answer, because membership is recorded outside this
   * module: the allow lists of the workspace's LIVE shares, plus the owner
   * allowlist. This module owns only WHICH workspace is asked about, which is
   * the half that has to agree with the scope verdict.
   */
  isMember: (workspaceId: string) => boolean;
}

/**
 * May a request on a COLLABORATION host touch this path?
 *
 * The surface is the share surface — read the docs, open the board, comment —
 * for whichever workspace the path names, rather than for one workspace fixed
 * at mint time. That is the whole difference between this and a share host:
 * a share hostname carries its scope, and a collaboration hostname is one
 * stable address whose scope is decided per request.
 *
 * TWO conditions, both required. The path must be in scope for the workspace
 * it names, AND the visitor must be a member of that workspace. Passing
 * Cloudflare Access proves only that the operator admitted this email to the
 * HOSTNAME; it says nothing about which boards behind it that person was
 * given, so without the second condition every admitted email reached every
 * workspace on the server by id. `isMember` is that condition, and it is
 * asked about the same workspace the scope verdict was made about — one
 * derivation, so the two halves cannot answer about different boards.
 *
 * A path can name MORE THAN ONE workspace, and both conditions are asked of
 * each in turn. A doc filed on two boards belongs to both; taking only the
 * first — whichever the store happened to iterate first — asked membership
 * about a board the visitor was never given and refused them a doc their own
 * board shows them. So the candidates are walked in order and the answer is
 * the first that satisfies BOTH, which is also the workspace the request is
 * then served as: redaction and scoping run against a board this visitor
 * really holds, never against one they merely reached through.
 *
 * A path that names NO workspace — the app shell, the widget bundle, the
 * favicon — is not membership-checked, because there is nothing to be a
 * member of. That is the whole of what an admitted non-member reaches.
 *
 * It is ONE rule, not two. Everything else is answered by `shareScopeAllows`
 * with the path's own workspace as the target, so the operator verbs a share
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
  opts: CollabScopeOpts,
): { allowed: false } | { allowed: true; target: ShareTarget } {
  const { workspacesOf, isMember } = opts;
  const candidates = pathWorkspaces(pathname, workspacesOf);
  // A shell path names no workspace, so there is nothing to be a member of.
  // It is judged against the sentinel — leaving exactly the static
  // allowances — and the visitor it creates is scoped to no workspace: `{}`
  // rather than the sentinel, which must never escape this file.
  if (candidates.length === 0) {
    const shell = shareScopeAllows(pathname, method, { workspaceId: NO_WORKSPACE }, workspacesOf);
    return shell ? { allowed: true, target: {} } : { allowed: false };
  }
  for (const workspaceId of candidates) {
    if (!isMember(workspaceId)) continue;
    if (!shareScopeAllows(pathname, method, { workspaceId }, workspacesOf)) continue;
    return { allowed: true, target: { workspaceId } };
  }
  return { allowed: false };
}

/**
 * Which workspaces does this path address — directly, or through the doc it
 * names? Empty when it names none, which is every static asset and every
 * enumerate-the-server route.
 *
 * A LIST rather than one answer, because a doc belongs to more than one
 * workspace at once: its review, and every board that review or doc is
 * filed on. Answering with the first of them asked the membership question
 * about whichever board the store iterated first, so a doc filed on two
 * boards was refused to a visitor who holds the second — while that board's
 * own share hostname served them the same doc. Membership is a set on the
 * share side; it has to be a set here too.
 *
 * Deliberately permissive: it only proposes candidates, and
 * `shareScopeAllows` then decides whether the path is reachable AT ALL and
 * whether the id really belongs to that workspace. Proposing the wrong
 * workspace cannot open anything — the scope check and the membership check
 * both still run against it — so the failure mode of a parsing mistake here
 * is a 403, not a leak.
 */
function pathWorkspaces(pathname: string, workspacesOf?: (id: string) => string[]): string[] {
  /** The first path segment after `prefix`, or null when it doesn't match. */
  const seg = (prefix: string): string | null => {
    if (!pathname.startsWith(prefix)) return null;
    const rest = pathname.slice(prefix.length);
    const slash = rest.indexOf('/');
    const s = slash < 0 ? rest : rest.slice(0, slash);
    return s === '' ? null : safeDecode(s);
  };

  // Paths whose segment IS a workspace (or a review filed on one — the guard
  // accepts either through `inWorkspaceScope`). One candidate: the path spells
  // the workspace out, so there is nothing to resolve.
  const named = seg('/events/workspace/') ?? seg('/workspaces/') ?? seg('/api/reviews/');
  if (named) return [named];
  // `/api/workspaces/` splits: `<id>/tree` names a workspace, and so does the
  // bare `<id>`; the LIST route has no segment and falls through to none.
  const wsApi = seg('/api/workspaces/');
  if (wsApi) return [wsApi];
  // A task or goal row names its board through the id a board holds its BODY
  // under, `task:<rowId>` — the same spelling `shareScopeAllows` resolves, so
  // the workspace membership is asked about and the workspace the scope
  // verdict is made about cannot be two different boards.
  const rowId = seg('/api/tasks/') ?? seg('/api/goals/');
  if (rowId) {
    const rowOwners = workspacesOf?.(`task:${rowId}`);
    return Array.isArray(rowOwners) ? rowOwners : [];
  }
  // The board room socket is `/y/ws:<id>`; every other `/y/<id>` is a doc.
  const room = seg('/y/');
  if (room?.startsWith('ws:')) return [room.slice('ws:'.length)];

  // Paths that name a DOC — every workspace it belongs to, most specific
  // first, which is the order `collabScope` then prefers between them.
  //
  // `/audio/` sits here beside `/y/` because it is the same doc by another
  // transport: the meeting's microphone socket for the doc the text socket
  // syncs. `shareScopeAllows` has admitted it since the member-rights
  // change, but on the collaboration hostname this function runs FIRST — and
  // while it named no candidate for `/audio/`, `collabScope` had nothing to
  // ask membership about and judged the path against the shell allowances,
  // which refuse it. So a member could open every tab of their board and not
  // the meeting they had just started on it.
  const doc = seg('/review/') ?? room ?? seg('/audio/') ?? seg('/events/') ?? seg('/api/docs/');
  if (!doc) return [];
  const owners = workspacesOf?.(doc);
  // `Array.isArray` for the reason `shareScopeAllows` gives at its own use of
  // this parameter: a caller still handing back a bare string would otherwise
  // be spread into one candidate per CHARACTER.
  return Array.isArray(owners) ? owners : [];
}

/**
 * Which `/api/docs/<id>/<sub>` calls may a share visitor make?
 *
 * A visitor is a reviewer, not an operator. They co-edit through the Yjs
 * websocket (that's the point of a live review) and comment through the
 * thread routes — but the doc's OPERATOR verbs stay local-only:
 *
 *   DELETE <doc>        destroys the attachment
 *   POST content        replaces the whole document in one call
 *   POST reparse_from_disk  discards live state, including others' edits
 *   POST threads/<id>/{rewrite_region,insert_after,insert_blocks_after}
 *                       agent-side document surgery, not a review action
 * `threads/<id>/promote` used to be in that list, with the reason "visitors
 * are read-only on the board gate, comments are their only write". That reason
 * is the thing Bryan's 2026-09-03 call removed: a member files tasks on the
 * board this doc is filed on, so turning a comment into one is the same act
 * by a shorter route. It is allowed now.
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
  // Who is holding this doc open — the banner every reader of it sees.
  if (sub === 'lead-presence') return method === 'GET';
  /**
   * The meeting the doc carries, and what was said in it. Reads only: the
   * transcript is the least reconstructible thing this server holds, because
   * the audio is already gone.
   *
   * `meetings/<id>/speakers` is NOT admitted by this line — it is a POST, and
   * the route refuses a visitor on its own besides. Naming a voice after the
   * fact rewrites notes already written, and only the session that wrote them
   * can keep its own memory of them straight.
   */
  if (sub === 'meetings' || /^meetings\/[^/]+$/.test(sub)) return method === 'GET';
  /**
   * Is a meeting bot even set up on this server? A read of two booleans and
   * whatever bot is already on this doc, which is what lets the meeting panel
   * say "bots are not configured here" instead of offering a button that
   * always fails.
   *
   * POST and DELETE stay refused, and this is the one place a member is
   * deliberately narrower than the board. Inviting a bot spends the owner's
   * money at a vendor the moment it is created and sends a participant into a
   * call outside this server; leaving it dials that bot back out again.
   * Neither is a way to work THIS board, which is what the grant is for.
   */
  if (sub === 'meeting-bot') return method === 'GET';
  /**
   * Thread verbs, INCLUDING the three region-edit ones this used to exclude.
   *
   * The exclusion protected nothing it was written for: a member already has
   * the doc's live-editing socket (`/y/<id>` below), which is unrestricted
   * text editing on the same document. Refusing the REST spelling of an edit
   * a member can make by typing left an inconsistency, not a boundary. What
   * still bounds all of them is the same line as ever — the doc has to be
   * inside the shared board.
   */
  if (sub === 'threads' || sub.startsWith('threads/')) return true;
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
