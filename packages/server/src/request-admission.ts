/**
 * ── Request admission: may this request reach this server at all, and as whom ──
 *
 * The first thing that happens to every request and the last line of defence
 * in front of everything else: the default-deny host gate, the auth branch
 * its decision selects, the external-access master switch, and the scoping
 * that turns an admitted outsider into a `visitor`. Plus the origin policy
 * the CORS layer and the cross-origin write gate both read, because "may a
 * page at this origin talk to us" is the same question one layer out.
 *
 * ── Why the result is a discriminated union ──
 *
 * This family differs from `board-membership.ts`, `stall-wiring.ts` and
 * `home-pane.ts` by one property that governs its whole shape: it is
 * PER-REQUEST, not a set of long-lived closures. It cannot be a factory of
 * values, so it has to hand something back — and the obvious something, a
 * record of `{ response?, visitor, accessEmail }`, is the bug this shape
 * exists to prevent. A caller can read `visitor` off a record whose
 * `response` it forgot to check, on a path the gate meant to refuse. That is
 * exactly the hazard the exceptions row predicted when it named this seam.
 *
 * So: `{ admitted: false, response }` carries NO per-request values, and
 * `{ admitted: true, … }` carries every one of them. TypeScript will not let
 * `gate.visitor` be read until `gate.admitted` has been checked, so the
 * refused path cannot leak a value by omission rather than by decision.
 *
 * `admitted: false` means "the gate has answered this request", not "denied".
 * The share-link redeem route lives inside the gate — it is the one path on
 * that hostname a non-member may reach — and its 200 comes back the same way
 * a 403 does, because both end the request here.
 *
 * ── Why TWO factories ──
 *
 * `policyFor` is an INPUT to `createIdentitySetup`, and that setup's
 * `accessOnlyBrowserHosts` is an INPUT to the host gate. No single
 * composition point sits on both sides of that, so the origin policy is
 * built where it is needed first and passed into the admission factory
 * built after. One module because they are one subject; two calls because
 * the identity setup genuinely sits between them.
 */
import { normalizeEmail } from '@feedback/core';
import type { DocMeta } from '@feedback/core';
import { LOOPBACK_HOSTS, type OriginPolicy, corsHeadersFor } from './middleware/browser-origin.ts';
import type { CfAccessVerifier } from './middleware/cf-access.ts';
import {
  type ShareTarget,
  classifyHost,
  collabScope,
  isLoopbackAddress,
  isProxiedTrustedHost,
  isTrustedLocalHost,
  shareScopeAllows,
} from './middleware/host-guard.ts';
import { recallCallbackAllows } from './middleware/recall-callback-gate.ts';
import { localHostnames } from './public-host.ts';
import { redactMetaForVisitor, relativeReviewUrl } from './share/redact-meta.ts';
import { shareMemberKey } from './share/share-links.ts';
import type { Shares } from './share/shares.ts';
import type { SharingGate } from './share/sharing-gate.ts';
import type { Share } from './share/types.ts';

/** The two `ServerOptions` fields the origin policy reads. */
export interface OriginPolicyOptions {
  trustedHosts?: string[];
  allowedOrigins?: string[];
}

/** What the origin policy needs. Built before `createIdentitySetup`, which
 *  takes `policyFor` as one of its own inputs — see the note at the top. */
export interface OriginPolicyContext {
  opts: OriginPolicyOptions;
  /** The operator's own proxied hostnames, and the verifier that proves one
   *  is really Access-fronted. Both are what separate "our own surface" from
   *  "the operator's public door" for origin purposes. */
  proxiedTrustedHosts: string[];
  proxiedTrustedVerifier: CfAccessVerifier | null;
}

export function createOriginPolicy(ctx: OriginPolicyContext): {
  policyFor: (req: Request) => OriginPolicy;
  applyCors: (req: Request, res: Response) => Response;
} {
  const { opts, proxiedTrustedHosts, proxiedTrustedVerifier } = ctx;

  /**
   * CORS is decided once, here, for every response the handler produces,
   * rather than by `j()` — which has no request context and used to stamp
   * `Access-Control-Allow-Origin: *` on everything. See
   * middleware/browser-origin.ts for why that wildcard was a hole.
   */
  /**
   * The origin policy for a request. `localHostnames` mirrors the host gate's
   * own notion of "this machine", so a dev server reached over the tailnet or
   * the LAN — not just loopback — can still embed the widget.
   */
  const policyFor = (req: Request) => {
    // Scheme matters (http://x and https://x are different browser origins),
    // and behind cloudflared the socket is plain http while the browser is on
    // https — so trust the forwarded scheme when the proxy sets one.
    // ALLOWLISTED, not interpolated. This value is concatenated into a URL
    // string, so an unvalidated one rewrites the origin we compare against:
    // `x-forwarded-proto: https://evil.example.com#` makes
    // `new URL('https://evil.example.com#://feedback.example.com').origin`
    // the ATTACKER's origin, originMatch returns 'same-origin', and on the
    // share host — where same-origin is the only rule left — that is the
    // whole boundary gone. A proxy appending to an existing header
    // (`https://evil.example.com#, https`) does it too.
    //
    // Note the asymmetry this fixes: host-guard requires `cf-ray` before it
    // believes a proxy claim, while this trusted a bare header.
    const forwarded = req.headers.get('x-forwarded-proto');
    const scheme =
      forwarded === 'http' || forwarded === 'https'
        ? forwarded
        : new URL(req.url).protocol.replace(':', '');
    const host = req.headers.get('host') ?? '';
    // The dev-server allowances belong to the LOCAL surface, where nothing is
    // cookie-authenticated. A share host is not that: the visitor carries a
    // SameSite=Lax session cookie, and websockets ignore CORS entirely — so an
    // allowed origin that happened to be same-SITE with the share host would
    // carry that cookie into /y/<docId> and act as a logged-in visitor. A
    // share visitor loads the app FROM the share host, so same-origin is all
    // they ever need, and it's all they get.
    // Cached (60s TTL) — tailscaleHost() shells out, and this runs on every
    // write and every websocket handshake.
    const ourNames = localHostnames();
    const viaProxy = req.headers.has('cf-ray');
    const isLocalSurface = isTrustedLocalHost(host, {
      lanHosts: ourNames,
      extraHosts: opts.trustedHosts ?? [],
      viaProxy,
    });
    // The operator's own proxied hostname serves the same product, but it is
    // NOT the local surface for origin purposes. Through the tunnel the
    // browser's `localhost` is the VISITOR'S machine, and a LAN name resolves
    // on the visitor's network, so every allowance that makes sense for a
    // TRUSTED_HOSTS name — loopback, LAN names, any port on our own names —
    // would here trust a page the operator merely has open. Same-origin plus
    // the origins the operator configured by name, nothing else. (The
    // configured ones are the one deliberate cross-origin grant, and they
    // are the operator's own call.)
    const isProxiedLocal = isProxiedTrustedHost(host, {
      viaProxy,
      proxiedTrustedHosts,
      accessFronted: proxiedTrustedVerifier !== null,
    });
    return {
      // Canonicalized, not concatenated. A proxy may forward Host with an
      // explicit default port (`feedback.example.com:443`) while the browser
      // sends `Origin: https://feedback.example.com` — a raw string compare
      // would then treat every legitimate request on the share host as
      // foreign and 403 its websocket. URL.origin drops the default port.
      requestOrigin: canonicalOrigin(scheme, host),
      localHostnames: isLocalSurface
        ? [...LOOPBACK_HOSTS, ...ourNames, ...(opts.trustedHosts ?? [])].filter((h) => h !== '')
        : [],
      allowedOrigins: isLocalSurface || isProxiedLocal ? (opts.allowedOrigins ?? []) : [],
    };
  };
  const applyCors = (req: Request, res: Response): Response => {
    const headers = corsHeadersFor(req.headers.get('origin'), policyFor(req));
    if (!headers) return res;
    const merged = new Headers(res.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: merged,
    });
  };

  return { policyFor, applyCors };
}

/** The `ServerOptions` fields the gate itself reads. */
export interface RequestAdmissionOptions {
  trustedHosts?: string[];
  meetingBotWebhookSecret?: string;
}

/** What the gate reads. Everything here is long-lived; the request and the
 *  path it addresses arrive per call. */
export interface RequestAdmissionContext {
  opts: RequestAdmissionOptions;
  /** The JSON responder, so a refusal here is spelled exactly as a route's. */
  j: (status: number, body: unknown) => Response;
  /** The sharing registry and the master switch in front of it. */
  shares: Shares | null;
  sharingGate: SharingGate;
  /** A share's target, or null when its workspace is not a board. */
  boardShareTarget: (share: Share | null | undefined) => ShareTarget | null;
  /** The four Access verifiers, one per door. Null means "not configured",
   *  which every branch below re-checks — "I could not verify" must never
   *  mean "serve it". */
  cfAccessVerifier: CfAccessVerifier | null;
  staticAccessVerifier: CfAccessVerifier | null;
  collabAccessVerifier: CfAccessVerifier | null;
  shareLinkVerifier: CfAccessVerifier | null;
  proxiedTrustedVerifier: CfAccessVerifier | null;
  /** The hostnames each door answers on. */
  accessTunnelHosts: string[];
  proxiedTrustedHosts: string[];
  shareLinkHosts: string[];
  recallCallbackHost: string | null;
  /** Whether Access fronts every browser-facing hostname (rule 3 in
   *  host-guard). From the identity setup — the reason this factory is
   *  built after it rather than beside the origin policy. */
  accessOnlyBrowserHosts: boolean;
  /** WHO may come through the operator's own proxied hostname. */
  proxiedTrustedEmails: Set<string>;
  /** Membership, scoping and redemption, from `board-membership.ts`. */
  shareWorkspacesOf: (rawId: string) => string[];
  collabMemberOf: (workspaceId: string, email: string | null) => boolean;
  shareLinkMemberOf: (workspaceId: string, email: string | null) => boolean;
  redeemShareLink: (linkId: string, email: string | null) => Response;
  /** One path segment, decoded without throwing on a bad escape. */
  safeDecodeSegment: (s: string) => string;
  /** Doc metadata decorated with its review URL, before redaction. */
  withReviewUrl: <T extends DocMeta>(meta: T) => T & { reviewUrl?: string };
  /** Whether the meeting relay is wired, for the recall callback allowlist. */
  recallRelay: { configured: () => boolean };
  /** The peer address of a request. A forward reference on purpose: the Bun
   *  server is bound below this factory and is only ever asked per request. */
  requestAddress: (req: Request) => string | undefined;
}

/** Doc metadata as one caller may see it — the full record on the tailnet,
 *  an allowlisted subset for a share visitor. */
export type MetaForVisitor = <T extends DocMeta>(meta: T) => Record<string, unknown>;

/**
 * What the gate decided. `admitted: false` means it ANSWERED the request —
 * a refusal, or the share-link redeem page — and carries no per-request
 * value with it, so nothing below can read a visitor off a request that
 * never got in.
 */
export type Admission =
  | { admitted: false; response: Response }
  | {
      admitted: true;
      /** Non-null when this request came from a SHARE visitor (either mode).
       *  Everything downstream treats it as "untrusted outsider". */
      visitor: ShareTarget | null;
      /** The share that authorized this request, stamped onto any websocket
       *  it upgrades so revocation can find and close it later. */
      visitorShareId: string | null;
      /** The MEMBERSHIP that authorized it, on the share hostname. */
      visitorMemberKey: string | null;
      /** The email Cloudflare Access verified for this request, if any. */
      accessEmail: string | null;
      /** Doc metadata as this caller may see it. */
      metaFor: MetaForVisitor;
    };

export interface RequestAdmission {
  admit: (req: Request, addressed: { pathname: string }) => Promise<Admission>;
}

export function createRequestAdmission(ctx: RequestAdmissionContext): RequestAdmission {
  const {
    opts,
    j,
    shares,
    sharingGate,
    boardShareTarget,
    cfAccessVerifier,
    staticAccessVerifier,
    collabAccessVerifier,
    shareLinkVerifier,
    proxiedTrustedVerifier,
    accessTunnelHosts,
    proxiedTrustedHosts,
    shareLinkHosts,
    recallCallbackHost,
    accessOnlyBrowserHosts,
    proxiedTrustedEmails,
    shareWorkspacesOf,
    collabMemberOf,
    shareLinkMemberOf,
    redeemShareLink,
    safeDecodeSegment,
    withReviewUrl,
    recallRelay,
    requestAddress,
  } = ctx;

  const admit = async (req: Request, addressed: { pathname: string }): Promise<Admission> => {
    const { pathname } = addressed;
    // Set when this request comes from a SHARE visitor (either mode).
    // Everything below treats a non-null value as "untrusted outsider":
    // their claimed identity is rewritten and doc metadata is redacted.
    let visitor: ShareTarget | null = null;
    /** The share that authorized this request, stamped onto any websocket
     *  it upgrades so revocation can find and close it later. */
    let visitorShareId: string | null = null;
    /** The MEMBERSHIP that authorized this request, when it came in on the
     *  share hostname. The same job as `visitorShareId` for the door that
     *  has no Cloudflare share behind it: without it, ejecting a member or
     *  shutting external access off left their open socket and stream
     *  running, because both are authorized once and never re-checked. */
    let visitorMemberKey: string | null = null;
    /**
     * The email Cloudflare Access verified for this request, if any.
     *
     * Every branch below that runs a verifier fills this in, and nothing
     * reads it unless `CW_REQUIRE_EMAIL_AUTH` is on. A verified claim is
     * an identity; ABSENT it, the visitor stays a `guest-` exactly as
     * before — never unattributed, and never a fallback to whatever the
     * body claimed, because a share visitor's body is the thing the guest
     * namespace exists to distrust.
     */
    let accessEmail: string | null = null;

    // --- Cloudflare Access gate ---
    // When cfAccess is configured (server is reachable via a public
    // tunnel), gate the request. Two modes:
    //   - With shares wired: gate ONLY requests whose Host matches an
    //     active share. Tailscale/LAN traffic to the canonical hostname
    //     stays unauthenticated, so the agent's MCP tools can still
    //     hit /api/share over loopback.
    //   - Without shares: gate everything (legacy/test mode).
    // DEFAULT-DENY BY HOST. The tunnel forwards every hostname under the
    // share wildcard here, so "not a known share host" must mean REFUSE,
    // never "skip the gate" (which is what it used to mean — an unknown
    // tunnel hostname reached the whole API unauthenticated). Only our own
    // local names bypass; a share host is gated AND scoped; anything else
    // is denied even when Access isn't configured, so a half-configured
    // deployment fails closed instead of publishing the API.
    /**
     * Every refusal inside runs `return j(...)`, exactly as it did when this
     * was a bare block inside `route()`. Wrapping it in one function rather
     * than rewriting each `return` into a union literal is deliberate: the
     * decision moved without a single line of it being retyped, and there is
     * exactly ONE place where an answer becomes `admitted: false`, so no
     * branch can be added later that refuses and forgets to say so.
     *
     * Falling off the end means admitted.
     */
    const answered = await (async (): Promise<Response | null> => {
      const decision = classifyHost(req.headers.get('host'), {
        // Cached (60s TTL) — this used to spawn `tailscale status` on
        // every single request.
        lanHosts: localHostnames(),
        extraHosts: opts.trustedHosts ?? [],
        // cloudflared forwards the visitor's Host verbatim, so a tunnel
        // visitor could otherwise claim `Host: localhost`. Cloudflare
        // stamps cf-ray on everything it proxies (overwriting any the
        // client sent), so its presence means "not from our LAN".
        viaProxy: req.headers.has('cf-ray'),
        // The opt-in collaboration hostnames, and the fact that Access
        // really is configured for them. Both are required before a
        // proxied host can classify anything but `deny` — see
        // `isAccessTunnelHost`.
        proxiedAccessHosts: accessTunnelHosts,
        // The operator's own proxied address — listed, and honoured only
        // with the same static-audience verifier behind it.
        proxiedTrustedHosts,
        accessFronted: staticAccessVerifier !== null,
        // The share hostname, and the fact that its OWN Access
        // application is configured. `shareLinkAccessFronted` is a
        // separate flag from `accessFronted` because the two hostnames
        // sit behind two applications with two audiences — see the field.
        shareLinkHosts,
        shareLinkAccessFronted: shareLinkVerifier !== null,
        // Recall's own hostname. Neither `viaProxy` nor `accessFronted`
        // applies to it — see the field on TrustedHostOpts for why both
        // absences are deliberate.
        recallCallbackHost,
        // Access on every browser-facing hostname (rule 3 in host-guard).
        // `loopbackPeer` is the half the Host header cannot fake: both of
        // this deployment's proxies dial us over loopback, so it does not
        // separate a tunnel visitor from the box on its own — the Host
        // and the `cf-ray` veto do that — but it does stop a LAN or
        // tailnet client typing `Host: localhost` and being served the
        // product with no identity at all.
        accessOnly: accessOnlyBrowserHosts,
        loopbackPeer: isLoopbackAddress(requestAddress(req)),
        lookupShare: (h) => {
          // LIVE, not merely known: an expired share's hostname must stop
          // being a share hostname, or expiry never takes effect for
          // Access mode (see Shares.findLiveByHostname).
          return boardShareTarget(shares?.findLiveByHostname(h));
        },
      });
      if (decision.kind === 'deny') {
        return j(403, { error: 'unknown_host' });
      }
      // --- External-access master switch ---
      // AHEAD of both auth paths on purpose: while sharing is off, a live
      // Access JWT, an unexpired session cookie and no credential at all
      // must be indistinguishable. Gating after auth would leak which
      // share links are real to anyone still holding one.
      //
      // Only external hosts pass through here — `local` returned above
      // this point untouched, so the agent's MCP calls over loopback and
      // Bryan's own browser keep working while the outside door is shut.
      //
      // `collab` is in here with the other two: it is external reach by
      // the same definition, so the one switch that answers "is anything
      // reachable from outside right now?" has to cover it. One honest
      // limit — a collab request carries no shareId, so the hang-up sweep
      // that runs when the switch is flipped off (`closeSocketsForShare`)
      // cannot find its live sockets. Flipping the switch closes the door
      // to new requests immediately; an already-open collab websocket
      // survives until the process restarts.
      //
      // `proxied-local` is in here too, and it is the WIDEST of the four:
      // the operator's own public hostname through the tunnel, with the
      // whole product behind it. It arrives from outside the machine by
      // exactly the definition the other three do, and leaving it out
      // meant an operator who flipped this switch during a security
      // review — believing the one sentence that describes it — had not
      // closed the widest external door. Being the operator's own door is
      // not an argument for exempting it; it is the argument for the
      // Access token and the email allowlist below, which stay.
      //
      // Nothing local is affected, so the way back is the way in: flip it
      // from the box or the tailnet (`POST /api/share/enabled`, or the
      // `set_sharing_enabled` MCP tool). `CW_SHARING_DISABLED=1` is off
      // AND LOCKED, and it now locks remote operator access with it —
      // which is what "the outside door is shut" was always supposed to
      // mean.
      if (
        (decision.kind === 'share' ||
          decision.kind === 'share-link' ||
          decision.kind === 'collab' ||
          decision.kind === 'proxied-local') &&
        !sharingGate.isEnabled()
      ) {
        return j(403, { error: 'sharing_disabled' });
      }
      if (decision.kind === 'share') {
        if (!cfAccessVerifier) {
          // A share exists but we cannot verify Access tokens — refuse
          // rather than serve the doc to an unauthenticated visitor.
          return j(503, { error: 'access_not_configured' });
        }
        const result = await cfAccessVerifier(req);
        if (!result.ok) return j(result.status, { error: result.error });
        accessEmail = result.email ?? null;
        // Authenticated for THIS share — but Access only proves the
        // visitor's email domain, not what they may touch. Scope them to
        // the shared board: no doc enumeration, no workspace/diff
        // creation, no share administration.
        if (!shareScopeAllows(pathname, req.method, decision.target, shareWorkspacesOf)) {
          return j(403, { error: 'out_of_share_scope' });
        }
        visitor = decision.target;
        visitorShareId = shares?.findLiveByHostname(req.headers.get('host') ?? '')?.shareId ?? null;
      } else if (decision.kind === 'share-link') {
        // THE SHARE HOSTNAME. One Cloudflare Access application covers
        // the whole host with an "everyone" policy and a one-time PIN
        // login, so what arrives here is a verified email address and
        // nothing else — Cloudflare has said WHO, and said nothing about
        // what they may open. Everything below is this server answering
        // the second question.
        //
        // Non-null by construction (the host could not have classified
        // share-link without it), re-checked because "I could not verify"
        // must never mean "serve it".
        if (!shareLinkVerifier) {
          return j(503, { error: 'access_not_configured' });
        }
        const result = await shareLinkVerifier(req);
        if (!result.ok) return j(result.status, { error: result.error });
        accessEmail = result.email ?? null;

        // The redeem route, ABOVE the scope check on purpose: `/s/<id>`
        // names no workspace, so `collabScope` would refuse it as an
        // out-of-scope path and nobody could ever become a member. It is
        // the one path on this hostname a non-member may reach, and all
        // it can do is write the caller's own verified address down
        // against the workspace the link already names.
        const redeemMatch = pathname.match(/^\/s\/([^/]+)$/);
        if (redeemMatch && req.method === 'GET') {
          return redeemShareLink(safeDecodeSegment(redeemMatch[1] ?? ''), accessEmail);
        }

        // Every other request on this hostname is judged on MEMBERSHIP,
        // not on the link. `collabScope` is `shareScopeAllows` with the
        // path's own workspace as the target, so every operator verb a
        // share visitor is refused — the doc list, share administration,
        // folder binds, diff creation, DELETE, wholesale rewrite — is
        // refused here by the same lines, and a route added to one is
        // added to both.
        //
        // A path that names no workspace (root, `/api/docs`, anything
        // this deployment serves that is not a board's content) reaches
        // only the static app shell, which is what makes "root answers
        // nothing useful" true rather than asserted.
        //
        // The refusal is spelled exactly like the collaboration
        // hostname's, on purpose: two different bodies would tell a
        // signed-in stranger which guessed workspace ids are real.
        const scope = collabScope(pathname, req.method, {
          workspacesOf: shareWorkspacesOf,
          isMember: (wsId) => shareLinkMemberOf(wsId, accessEmail),
        });
        if (!scope.allowed) return j(403, { error: 'out_of_share_scope' });
        // An outsider like any other: identity rewritten to a guest, doc
        // metadata redacted, `visitor`-gated routes closed. No
        // `visitorShareId` — there is no Cloudflare share behind this.
        visitor = scope.target;
        // What there IS instead: the membership. Stamped on whatever this
        // request upgrades so that removing the member, or throwing the
        // master switch, can hang it up.
        visitorMemberKey =
          accessEmail && scope.target?.workspaceId
            ? shareMemberKey(scope.target.workspaceId, accessEmail)
            : null;
      } else if (decision.kind === 'collab') {
        // The collaboration hostname: one stable public address, an
        // Access application in front of it, and the SHARE surface behind
        // it — scoped per request to whichever workspace the path names.
        //
        // Non-null by construction (the host could not have classified
        // collab otherwise), re-checked because "I could not verify"
        // must never mean "serve it".
        if (!collabAccessVerifier) {
          return j(503, { error: 'access_not_configured' });
        }
        const result = await collabAccessVerifier(req);
        if (!result.ok) return j(result.status, { error: result.error });
        accessEmail = result.email ?? null;
        // Access proves an identity Bryan admitted, not what they may
        // touch. `collabScope` is `shareScopeAllows` with the path's own
        // workspace as the target, so every operator verb a share visitor
        // is refused — the doc list, share administration, folder binds,
        // diff creation, delete, wholesale rewrite, the landing page — is
        // refused here by the same lines.
        // …and Access proves the visitor was admitted to the HOSTNAME,
        // not to a board behind it. `isMember` is the second condition:
        // the workspace the path names must list this email, through a
        // live share's allow list or the owner allowlist.
        //
        // The refusal is spelled exactly like the out-of-scope one, on
        // purpose. Two different bodies would tell an admitted
        // collaborator which guessed workspace ids are real, which is an
        // enumeration oracle over precisely the ids this check exists to
        // stop them opening.
        const scope = collabScope(pathname, req.method, {
          workspacesOf: shareWorkspacesOf,
          isMember: (wsId) => collabMemberOf(wsId, accessEmail),
        });
        if (!scope.allowed) return j(403, { error: 'out_of_share_scope' });
        // An outsider like any other: identity rewritten to a guest, doc
        // metadata redacted, `visitor`-gated routes closed. What it does
        // NOT get is a `visitorShareId` — there is no share behind it.
        visitor = scope.target;
      } else if (decision.kind === 'recall-callback') {
        // Recall's dedicated hostname. No Access token is demanded and
        // none could be presented: this caller is a vendor's backend.
        // What stands in for it is that the hostname serves TWO routes
        // and each one carries its own credential — a 128-bit per-bot
        // token in the websocket path, a Svix signature over the webhook
        // body — verified by the routes themselves one layer in. So the
        // gate's whole job here is to refuse everything else, and it is
        // an allowlist rather than a denylist: a route added to this
        // server tomorrow is closed on this hostname by default.
        //
        // 404 rather than 403, and rather than the 401 the operator
        // hostname answers: this name is not an address the product is
        // served on, so "there is nothing here" is both true and the
        // least it can say about what this deployment runs.
        //
        // Deliberately NOT under the external-access master switch above.
        // That switch answers "is anything reachable from outside right
        // now?" about workspace CONTENT reached by people; these two
        // routes read no doc and are reachable only by whoever holds a
        // token this server minted for one bot. Turning sharing off in
        // the middle of a meeting must not silently strand its bot.
        if (
          !recallCallbackAllows(pathname, req.method, {
            relayConfigured: recallRelay.configured(),
            webhookSecretSet: Boolean(opts.meetingBotWebhookSecret),
          })
        ) {
          return j(404, { error: 'not_found' });
        }
        // Nothing else: no `visitor`, no scope, no accessEmail. The two
        // routes below authenticate themselves.
      } else if (decision.kind === 'proxied-local') {
        // The operator's own hostname through the tunnel: an Access
        // application in front of it, and the WHOLE product behind it.
        // The token is the only thing between the tunnel and loopback
        // privileges, so it is demanded here REGARDLESS of whether shares
        // are wired — the legacy whole-server branch below stops running
        // the moment link sharing is configured, and prod has it.
        //
        // Non-null by construction (the host could not have classified
        // proxied-local otherwise), re-checked because "I could not
        // verify" must never mean "serve it".
        //
        // NOTHING SKIPS THE TOKEN HERE. Two requests used to — Recall's
        // bot callbacks, because the operator hostname was the only
        // public address this deployment had. They now arrive on a
        // hostname of their own (`recallCallbackHost`, handled above),
        // which is a strictly better trade: what a vendor's backend can
        // reach and what a person can reach are two names, and this one
        // is back to having no holes in it at all.
        if (!proxiedTrustedVerifier) {
          return j(503, { error: 'access_not_configured' });
        }
        const result = await proxiedTrustedVerifier(req);
        if (!result.ok) return j(result.status, { error: result.error });
        // A token is admission, not identity. The Access policy this
        // server cannot read may admit collaborators through the same
        // application, and their tokens verify exactly as the operator's
        // does. The verified email is the only thing that says WHO, so it
        // must be on the allowlist — folded the way the roster folds — or
        // the door stays shut. The body names nothing: not the email, not
        // that an allowlist exists.
        const who = result.email ? normalizeEmail(result.email) : '';
        if (who === '' || !proxiedTrustedEmails.has(who)) {
          return j(403, { error: 'forbidden' });
        }
        accessEmail = result.email ?? null;
        // Nothing else: no `visitor`, no scope. From here on the request
        // is what a loopback request is.
      } else if (cfAccessVerifier && !shares && !shareLinkVerifier) {
        // Legacy whole-server mode: cfAccess configured WITHOUT any
        // sharing surface means the entire deployment sits behind Access,
        // so even a local-looking Host must present a token. (With
        // sharing wired, local traffic is the agent's own MCP calls over
        // loopback and stays unauthenticated.)
        //
        // A share-link hostname counts as a sharing surface, and it has
        // to. The per-share mode it replaces is retired: an operator who
        // finishes draining those records and removes the old settings
        // would otherwise fall into this branch by deletion, and every
        // agent on the box would start being asked for an Access token it
        // has no way to hold.
        const result = await cfAccessVerifier(req);
        if (!result.ok) return j(result.status, { error: result.error });
        accessEmail = result.email ?? null;
      }
      return null;
    })();
    if (answered) return { admitted: false, response: answered };

    /**
     * Doc metadata as this caller may see it. On the tailnet that's all of
     * it; a share visitor gets an allowlisted subset — the full DocMeta
     * carries absolute paths on Bryan's machine and a tailnet hostname,
     * none of which is needed to render a review.
     */
    const metaFor = <T extends DocMeta>(meta: T): Record<string, unknown> => {
      const decorated = withReviewUrl(meta);
      if (!visitor) return decorated as unknown as Record<string, unknown>;
      return {
        ...redactMetaForVisitor(decorated, {
          workspaceScoped: Boolean(visitor.workspaceId),
        }),
        // Same path, no host, and under the workspace THIS visitor was
        // shared rather than whichever one holds the doc first.
        ...(relativeReviewUrl(decorated.reviewUrl, visitor.workspaceId) !== undefined
          ? { reviewUrl: relativeReviewUrl(decorated.reviewUrl, visitor.workspaceId) }
          : {}),
      };
    };

    return { admitted: true, visitor, visitorShareId, visitorMemberKey, accessEmail, metaFor };
  };

  return { admit };
}
function canonicalOrigin(scheme: string, host: string): string {
  try {
    return new URL(`${scheme}://${host}`).origin;
  } catch {
    return `${scheme}://${host}`;
  }
}
