/**
 * The sign-in, session and share-link REST block, in the order it is matched.
 *
 * These routes were written as one long if-chain inside `createServer` and
 * the sequence was kept exactly through the move, so the file stays auditable
 * against the pre-split closure. Order is behaviour in two places here, and
 * both are load-bearing:
 *
 *  - the browser-write refusal on `/api/share*` sits ABOVE every share route,
 *    so a mint added later is covered by construction rather than by a list;
 *  - `/share/<slug>` redemption sits above the retired `/s/<slug>` reply, and
 *    both sit above the mint routes, so a redemption can never be answered by
 *    a mint's argument validation.
 *
 * The guard against reordering is the per-route HTTP suite —
 * `auth-*.test.ts`, `share-*.test.ts`, `widget-token.test.ts` — each of which
 * fails if its path starts reaching a different handler.
 *
 * Dependencies arrive in an explicit context rather than captured from the
 * `createServer` closure, following `task-routes-context.ts`.
 */
import type { CodeSender } from '../auth/code-sender.ts';
import { CODE_TTL_MS, type EmailCodes } from '../auth/email-code.ts';
import type { SessionRevocations } from '../auth/session-revocations.ts';
import {
  SESSION_COOKIE,
  clearedSessionCookieHeader,
  sessionCookieHeader as emailSessionCookieHeader,
  mintSession,
  verifySession as verifyEmailSession,
} from '../auth/session.ts';
import { mintWidgetToken } from '../auth/widget-token.ts';
import type { Identities, IdentityRecord } from '../identities.ts';
import { userForIdentity } from '../identities.ts';
import { type OriginPolicy, isAllowedBrowserOrigin } from '../middleware/browser-origin.ts';
import { browserCannotOperateBody, isBrowserRequest } from '../middleware/write-gate.ts';
import type { Rooms } from '../rooms.ts';
import { readCookie } from '../share/link-session.ts';
import { type ShareLinks, shareMemberKey } from '../share/share-links.ts';
import { ACCESS_NOT_CONFIGURED, type Shares } from '../share/shares.ts';
import type { SharingGate } from '../share/sharing-gate.ts';
import { resolveTtl } from '../share/ttl.ts';
import { DEFAULT_LINK_TTL_SECONDS } from '../share/types.ts';
import type { SseHub } from '../sse.ts';
import type { TaskStore } from '../tasks.ts';
import { widgetAuthPage } from '../widget-auth-page.ts';

/**
 * The refusal a share route gives when handed a GROUPING id.
 *
 * A BOARD is the unit of sharing (Bryan, 2026-08-17: "Workspace only — a
 * review must be filed on a board before it can be shared"). A folder bind
 * and a diff review are reviews: they hold member docs, but they are not
 * boards, and until this they could each be shared on their own.
 *
 * 410 rather than 404 because the id is real and the caller is not wrong
 * about it — the capability is what went away. Older peers keep calling the
 * shared server with the payload THEIR bundle sends long after this one
 * stopped sending it, and a review id arrives in the same `workspaceId`
 * field a board id does, so a bare 404 would read as "your review vanished".
 * The hint has to name the replacement or the reply is just a wall.
 */
const GROUPING_SHARING_REMOVED = {
  error: 'grouping_sharing_removed',
  hint: 'A board is the unit of sharing. A folder bind or diff review cannot be shared on its own — file it on a board and share the board instead. Use the hubWorkspaceId that create_diff_review / bind_folder returns, or make a fresh board with create_workspace.',
} as const;

/**
 * The refusal a share route gives when handed the UNFILED board.
 *
 * Decided on the board: refuse. The Unfiled board is where every review
 * created WITHOUT naming a board lands — one shared catch-all for every
 * agent's strays. Sharing it would hand a visitor every stray review from
 * everyone, so the mint routes refuse it outright.
 *
 * 403 rather than 410: nothing was removed — the board exists and the route
 * works — this share is simply never allowed. The hint has to name the fix,
 * because the caller usually got here by binding without a hubWorkspaceId
 * and then sharing whatever id came back.
 */
const UNFILED_SHARING_REFUSED = {
  error: 'unfiled_board_not_shareable',
  hint: 'The Unfiled board collects every review bound without a board, from every agent — sharing it would share them all. So: file the review on a real board first, then share that board. Pass hubWorkspaceId when you bind (create_diff_review / bind_folder), or make a board with create_workspace and attach_doc the review to it.',
} as const;

/**
 * Every body key `POST /api/share/link` honours. A key outside this set is
 * refused by name (400 unsupported_argument) — `docId` and `entryDocId` are
 * checked before this set is consulted, each with its own reply.
 */
const SHARE_LINK_ARGS: ReadonlySet<string> = new Set([
  'workspaceId',
  'ttl',
  'ttlSeconds',
  'label',
  'allowDomains',
]);

/**
 * Shown when a share link doesn't resolve. Says nothing about WHY — unknown,
 * expired, and malformed all render the same page, so the endpoint can't be
 * used to probe which slugs exist.
 *
 * It lives beside these routes rather than in `shells.ts` because the three
 * link routes below are its only callers, and it renders with no bundle, no
 * session and no doc — the caller has no credential left.
 */
function renderLinkNotFound(): string {
  return `<!doctype html><meta charset="utf-8"><title>Link not available · Workspaces</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:12vh auto;padding:0 1.5rem;color:#222}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#555;margin:0}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}p{color:#aaa}}</style>
<h1>This link isn't available</h1>
<p>It may have expired or been revoked. Ask whoever shared it for a new one.</p>`;
}

/** The long-lived collaborators these routes need, built once per server. */
export interface AuthShareRoutesContext {
  /** Doc rooms — read to refuse sharing a board that holds a bound review,
   *  and told to drop a revoked share's sockets. */
  rooms: Rooms;
  /** The SSE hub, told to drop a revoked share's streams. */
  sse: SseHub;
  /** The hub task store — the only thing that knows what a board is. */
  taskStore: TaskStore;
  /** The share registry, or null when sharing was never configured. */
  shares: Shares | null;
  /**
   * Share LINKS and the workspace membership redeeming one creates — the
   * 2026-09-03 flow. Never null: it needs no Cloudflare wiring, so it exists
   * wherever the server does, and a null would have to be read as "nobody is
   * a member" at the place that decides who gets in.
   */
  shareLinks: ShareLinks;
  /**
   * The hostname share URLs are built from (the first `CW_SHARE_LINK_HOSTS`
   * entry), or `''` when this deployment configured none. Empty refuses the
   * mint: a link whose URL names no hostname is a link nobody can open.
   */
  shareLinkBaseHost: string;
  /** The master switch for external access. */
  sharingGate: SharingGate;
  /** The email-keyed roster. */
  identities: Identities;
  /** The sign-in challenge store. */
  emailCodes: EmailCodes;
  /** Which sessions have been logged out or revoked. */
  sessionRevocations: SessionRevocations;
  /** Where a login code is delivered. */
  codeSender: CodeSender;
  /** Whether a session means "a known person" or merely "a browser". */
  requireEmailAuth: boolean;
  /** Whether an unsigned browser write is refused. */
  requireSignInToWrite: boolean;
  /**
   * Whether this server offers its own emailed-code sign-in.
   *
   * Off under access-only, where Cloudflare Access proved an address before
   * the request arrived. Only the two CHALLENGE routes close with it —
   * `session`, `profile` and `logout` stay open, because a session minted
   * before the flag moved still has to be readable and endable.
   */
  emailCodeSignIn: boolean;
  /** The name of the catch-all board, which may not be shared. */
  defaultHubWorkspaceName: string;
  /**
   * Who a share admits when the caller names nobody — the operator allowlist
   * (`CW_PROXIED_TRUSTED_EMAILS`, defaulting to `CW_OWNER_EMAIL`).
   *
   * It exists because `share_link` used to need no audience at all: the URL
   * was the credential. Every older bundle still calls it that way, so the
   * server has to answer the question the caller did not ask, and the only
   * safe answer is the narrowest one it already knows. Empty means the mint
   * is refused rather than guessed at.
   */
  defaultShareAudience: string[];

  /** JSON response helper — status plus body, no CORS (the per-request
   *  wrapper in createServer adds that, because it knows the Origin). */
  j: (status: number, body: unknown) => Response;
  /** Parse a request body, answering null rather than throwing. */
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;

  /** The rate-limit key for a caller, from the socket and the proxy header. */
  clientKeyFor: (req: Request) => string;
  /** The HMAC key behind email-session cookies. */
  emailSessionKey: () => string;
  /** The HMAC key behind widget popup tokens. */
  widgetTokenKey: () => string;
  /** Whether the request really reached us over https. */
  isSecureRequest: (req: Request) => boolean;
  /** The origin policy for a request. */
  policyFor: (req: Request) => OriginPolicy;
  /** The identity a request's session cookie attests to, or null. */
  sessionIdentityFor: (req: Request) => IdentityRecord | null;
}

/** What only this request knows. */
export interface AuthShareRouteRequest {
  req: Request;
  url: URL;
  pathname: string;
  /** The identity a valid widget popup token named, or null. */
  widgetIdentity: IdentityRecord | null;
  /** Whether this is a browser that proved nobody at all. */
  browserProvedNobody: () => boolean;
  /** The identity this request actually proved — Cloudflare Access first,
   *  then the session cookie. The same resolution the write gate uses, so
   *  the me-menu and the gate cannot disagree about who is signed in. */
  provenIdentityFor: () => IdentityRecord | null;
}

/**
 * The sign-in, session and share routes, tried in source order. `undefined`
 * means none of them matched and the caller's chain continues.
 */
export async function handleAuthShareRoutes(
  ctx: AuthShareRoutesContext,
  rq: AuthShareRouteRequest,
): Promise<Response | undefined> {
  const {
    rooms,
    sse,
    taskStore,
    shares,
    shareLinks,
    shareLinkBaseHost,
    sharingGate,
    identities,
    emailCodes,
    sessionRevocations,
    codeSender,
    requireEmailAuth,
    requireSignInToWrite,
    emailCodeSignIn,
    defaultHubWorkspaceName: DEFAULT_HUB_WORKSPACE_NAME,
    defaultShareAudience,
    j,
    safeJson,
    clientKeyFor,
    emailSessionKey,
    widgetTokenKey,
    isSecureRequest,
    policyFor,
    sessionIdentityFor,
  } = ctx;
  const { req, pathname, widgetIdentity, browserProvedNobody, provenIdentityFor } = rq;

  // --- The widget popup-token handshake ---
  // The popup page itself. The handshake is popup-only: framed, it
  // would mint with nothing visible on screen, so DENY.
  if (pathname === '/widget-auth' && req.method === 'GET') {
    return new Response(widgetAuthPage(), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'x-frame-options': 'DENY',
        'cache-control': 'no-store',
      },
    });
  }

  // Exchange the session cookie for a widget token. Same-origin only:
  // this is the popup page's route, and the cookie could not arrive
  // cross-site anyway (SameSite=Lax, and CORS here never grants
  // credentials) — the Origin check is the second, independent wall.
  if (pathname === '/api/auth/widget-token' && req.method === 'POST') {
    const callerOrigin = req.headers.get('origin');
    if (callerOrigin !== null && callerOrigin !== policyFor(req).requestOrigin) {
      return j(403, { error: 'same_origin_only' });
    }
    const rec = sessionIdentityFor(req);
    if (!rec) return j(401, { error: 'not_signed_in' });
    const body = await safeJson(req);
    const target = typeof body?.origin === 'string' ? body.origin : '';
    // The origin the popup will postMessage the token TO. Validated
    // against the same policy that governs which pages may write —
    // an origin that could not post a comment cannot receive a token
    // — and refusing `null`/absent keeps the popup from ever being
    // told to broadcast.
    if (target === '' || !isAllowedBrowserOrigin(target, policyFor(req))) {
      return j(403, { error: 'origin_not_allowed' });
    }
    const claims = verifyEmailSession(
      readCookie(req.headers.get('cookie'), SESSION_COOKIE),
      emailSessionKey(),
    );
    // Signed into the token: the gate will accept it from `target` alone.
    const token = claims ? mintWidgetToken(claims, target, widgetTokenKey()) : null;
    if (token === null) {
      // A surviving v1 cookie: no session id, so a token tied to it
      // could not die with a logout. The daily sliding refresh
      // upgrades it; until then the popup says to sign in again.
      return j(401, { error: 'session_needs_refresh' });
    }
    return j(200, { ok: true, token, user: userForIdentity(rec), origin: target });
  }

  // What the widget calls on load to learn whether its stored token
  // still stands. An invalid token never reaches here — the gate
  // above 401s it — so this only distinguishes "no token" from live.
  if (pathname === '/api/auth/widget-session' && req.method === 'GET') {
    return j(200, {
      authenticated: widgetIdentity !== null,
      ...(widgetIdentity ? { user: userForIdentity(widgetIdentity) } : {}),
    });
  }

  if (pathname === '/api/auth/start' && req.method === 'POST') {
    // 404, not 403: with the emailed code turned off this route does not
    // exist on this deployment, and saying so any more precisely would tell a
    // stranger what it could be if they came back later.
    if (!emailCodeSignIn) return j(404, { error: 'not_found' });
    const body = await safeJson(req);
    const email = typeof body?.email === 'string' ? body.email : '';
    const peer = clientKeyFor(req);
    const started = emailCodes.start(email, peer);
    if (!started.ok) {
      if (started.error === 'ceiling') {
        // An abuse ceiling. On the wire this is EXACTLY a success —
        // same status, same shape — because a 429 would hand a
        // mail-bomber a progress meter and tell any client the
        // server-wide traffic state. The refusal is loud here instead,
        // which is where the person who can raise the ceiling reads.
        console.error(
          `[auth] login-start ceiling tripped (${started.scope}) — no code mailed to ` +
            `${started.email} for peer ${peer}. Raise CW_AUTH_GLOBAL_STARTS_PER_HOUR / ` +
            'CW_AUTH_PEER_STARTS_PER_HOUR if this is honest traffic.',
        );
        return j(200, {
          ok: true,
          email: started.email,
          expiresInSeconds: Math.max(0, Math.floor((started.expiresAt - Date.now()) / 1000)),
        });
      }
      if (started.error === 'rate_limited') {
        return new Response(
          JSON.stringify({
            error: 'rate_limited',
            retryAfterSeconds: started.retryAfterSeconds,
          }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'retry-after': String(started.retryAfterSeconds),
            },
          },
        );
      }
      return j(400, { error: 'invalid_email' });
    }
    try {
      await codeSender.send({
        to: started.email,
        code: started.code,
        expiresInMinutes: Math.round(CODE_TTL_MS / 60_000),
      });
    } catch (err) {
      // 502 and NOT a silent 200. Answering ok here would put the
      // reviewer in front of a code box for a code that does not exist,
      // and the only evidence anywhere would be a log line nobody
      // reads. The challenge stays live — a retry re-sends rather than
      // stranding them — and the rate limit still counted this attempt,
      // which is what stops a broken provider becoming a retry loop.
      console.error(
        `[auth] could not send a login code via "${codeSender.name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return j(502, { error: 'code_send_failed' });
    }
    // NEVER the code. The response is read by whoever made the request,
    // and the whole point of mailing a code is that those are different
    // people until one proves otherwise.
    return j(200, {
      ok: true,
      email: started.email,
      expiresInSeconds: Math.max(0, Math.floor((started.expiresAt - Date.now()) / 1000)),
    });
  }

  if (pathname === '/api/auth/verify' && req.method === 'POST') {
    if (!emailCodeSignIn) return j(404, { error: 'not_found' });
    const body = await safeJson(req);
    const email = typeof body?.email === 'string' ? body.email : '';
    const code = typeof body?.code === 'string' ? body.code : '';
    const peer = clientKeyFor(req);
    const result = emailCodes.verify(email, code, peer);
    if (!result.ok) {
      if (result.error === 'rate_limited') {
        return j(429, {
          error: 'rate_limited',
          retryAfterSeconds: result.retryAfterSeconds,
        });
      }
      if (result.error === 'too_many_attempts') {
        return j(429, { error: 'too_many_attempts' });
      }
      if (result.error === 'invalid_email') return j(400, { error: 'invalid_email' });
      return j(401, { error: result.error });
    }
    // Read BEFORE the upsert creates the row: `firstSignIn` is what
    // sends the client to the display-name screen, and a returning
    // person who already chose a name must never be asked again.
    const firstSignIn = identities.byEmail(result.email) === null;
    const rec = identities.upsertByEmail(result.email);
    if (rec.status !== 'active') {
      // An archived identity proved control of its mailbox and still
      // may not sign in. Un-archiving is somebody's decision.
      return j(403, { error: 'identity_archived' });
    }
    return new Response(JSON.stringify({ ok: true, user: userForIdentity(rec), firstSignIn }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': emailSessionCookieHeader(mintSession(rec.id), emailSessionKey(), {
          secure: isSecureRequest(req),
        }),
      },
    });
  }

  if (pathname === '/api/auth/session' && req.method === 'GET') {
    // The same three proofs the write gate resolves — Cloudflare Access
    // first, then the cookie — or the me-menu tells a person whose Access
    // login just succeeded that they are "not signed in" while every comment
    // they post lands under their verified name.
    const rec = provenIdentityFor();
    return j(200, {
      // Whether email identity is IN EFFECT, so a client can tell "not
      // signed in" from "signing in does not matter here yet".
      required: requireEmailAuth,
      authenticated: rec !== null,
      /**
       * Whether this deployment refuses unsigned browser writes, and
       * whether THIS browser may make one.
       *
       * The client needs both BEFORE it offers a surface, not only
       * after a write is refused. A reader who is allowed to type into
       * a doc whose every keystroke the server will drop has been told
       * nothing — the text appears, syncs to nobody, and is gone on
       * reload. So the review app asks here first and stays in view
       * mode with a sign-in bar when the answer is no; the 401 below
       * remains the backstop for a session that ends mid-visit.
       *
       * `canWrite` resolves the same three proofs the gate does, so a
       * Cloudflare Access visitor and a widget token both read true
       * even though neither is the session cookie `authenticated`
       * reports on.
       */
      signInToWrite: requireSignInToWrite,
      canWrite: !requireSignInToWrite || !browserProvedNobody(),
      /**
       * Whether the `/signin` page exists on this deployment.
       *
       * The client needs it to decide whether "not signed in" has an ACTION
       * attached. Under access-only there is no second sign-in to offer, and
       * a link to a 404 is worse than no link — so the me-menu and the write
       * gate both read this before painting one.
       */
      emailCodeSignIn,
      ...(rec ? { user: userForIdentity(rec) } : {}),
    });
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    // THIS session only — ending a person's sessions everywhere is a
    // roster operation (`revokeSessions`). Clearing the cookie is the
    // browser half; revoking the session id is what kills any captured
    // copy of the value, which otherwise validates forever. Only an id
    // off a VERIFIED cookie reaches the store, so an attacker cannot
    // grow the file with junk.
    const claims = verifyEmailSession(
      readCookie(req.headers.get('cookie'), SESSION_COOKIE),
      emailSessionKey(),
    );
    if (claims?.sessionId) sessionRevocations.revoke(claims.sessionId);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': clearedSessionCookieHeader({ secure: isSecureRequest(req) }),
      },
    });
  }

  if (pathname === '/api/auth/profile' && req.method === 'POST') {
    // The one write the sign-in flow makes about a person: their chosen
    // display name. Session-gated, and ONLY the session decides whose —
    // the body names no identity, so nobody can rename somebody else by
    // claiming to be them.
    const rec = sessionIdentityFor(req);
    if (!rec) return j(401, { error: 'not_signed_in' });
    const body = await safeJson(req);
    const displayName = typeof body?.displayName === 'string' ? body.displayName.trim() : '';
    if (!displayName) return j(400, { error: 'invalid_display_name' });
    const updated = identities.setDisplayName(rec.id, displayName);
    if (!updated) return j(401, { error: 'not_signed_in' });
    return j(200, { ok: true, user: userForIdentity(updated) });
  }

  // --- REST: shares ---
  // Every share MUTATION is an operator action, refused to browsers on
  // the same terms as /api/deploy — see browserCannotOperateBody.
  // Minting publishes a board to the internet and `enabled` can re-open
  // external access after the operator closed it; the routes' own
  // "local-only" comments are about the HOST class, which does not tell
  // a page on a local dev origin from the agent that is the only real
  // caller.
  //
  // The READ is refused too, and used not to be. That exemption was written
  // for "the board's own settings pane", which does not exist: nothing under
  // `packages/workspaces-app/src` or `packages/widget/src` fetches this route,
  // and every real caller is the MCP tool layer or a script from the box.
  // What the open read handed a page on another local port was every
  // `linkId` — the whole secret of a share URL, redeemable by anyone who can
  // pass an everyone-policy sign-in — and every member's email address. The
  // machine-local origin class gets readable CORS, so such a page could read
  // the reply, not merely send the request.
  //
  // So the guard is keyed on the ROUTE now, not the method: everything under
  // `/api/share` is an operator surface. A share read added later is covered
  // by construction, the same way a mutation already was.
  if (
    (pathname === '/api/share' || pathname.startsWith('/api/share/')) &&
    isBrowserRequest(req.headers)
  ) {
    return j(403, browserCannotOperateBody());
  }
  if (pathname === '/api/share' && req.method === 'GET') {
    // Enabled when EITHER kind of sharing is wired. `shares` alone used to be
    // the test, and a deployment on the 2026-09-03 flow has no Cloudflare
    // client at all — reading the list would have answered "sharing not
    // enabled" on the server that is doing the sharing.
    if (!shares && !shareLinkBaseHost) return j(404, { error: 'sharing not enabled' });
    // Two lists, because there are two kinds of record and neither can be
    // written as the other. `shares` are Cloudflare Access applications minted
    // under the retired per-share mode; `links` are the share links, each with
    // the redemptions that came through it — who signed in, and when.
    //
    // `listForApi` stamps `redeemable` on every share row. A retired link-mode
    // record reads `redeemable: false, retired: 'link_mode'` — it is still
    // listed, still labelled and still revocable, and it no longer hands back
    // a freshly signed URL for a door that does not open.
    // `members` is its own list rather than a field on a link, because the two
    // can disagree and the difference is the point: a redemption says somebody
    // came through this link, and a membership says they can still get in. Eject
    // someone and the redemption stays on the record while the membership goes.
    return j(200, {
      shares: shares ? shares.listForApi() : [],
      links: shareLinks.listForApi(),
      members: shareLinks.allMembers(),
      sharing: sharingGate.status(),
    });
  }
  // Flip the master switch. Local-only, like the rest of /api/share*.
  // Turning it OFF also hangs up what is already connected: a websocket
  // and an SSE stream are authorized ONCE at open, so a visitor mid-review
  // would otherwise keep syncing and keep receiving comments on a doc
  // that is no longer reachable. Same lesson as share revocation.
  if (pathname === '/api/share/enabled' && req.method === 'POST') {
    // EITHER kind of sharing, for the same reason the GET above takes both.
    // The gate refuses `share`, `share-link`, `collab` and `proxied-local`
    // alike, so a deployment on the 2026-09-03 flow is one this switch still
    // governs — and keyed on the retired registry alone, the only way to shut
    // the outside door there was `CW_SHARING_DISABLED` plus a restart. That
    // one is deliberately one-way, so the way back was a restart as well.
    if (!shares && !shareLinkBaseHost) return j(404, { error: 'sharing not enabled' });
    const body = await safeJson(req);
    const enabled = body?.enabled;
    if (typeof enabled !== 'boolean') {
      return j(400, { error: 'enabled must be a boolean' });
    }
    const res = sharingGate.setEnabled(enabled);
    if (!res.ok) {
      return j(409, {
        error: res.error,
        hint: 'CW_SHARING_DISABLED is set in the environment. Remove it from the service definition and restart to allow runtime control.',
      });
    }
    let closedSockets = 0;
    let closedStreams = 0;
    if (!enabled) {
      for (const share of shares?.list() ?? []) {
        closedSockets += rooms.closeSocketsForShare(share.shareId);
        closedStreams += sse.closeForShare(share.shareId);
      }
      // And every share-link visitor, who carries no Cloudflare shareId for
      // the sweep above to match. Without this the switch closed the door to
      // new requests while an already-open `/y/<doc>` kept reading AND
      // writing, and an `/events/` stream kept delivering.
      closedSockets += rooms.closeSocketsForShareMembers(() => true);
      closedStreams += sse.closeForShareMembers(() => true);
    }
    return j(200, {
      ok: true,
      sharing: sharingGate.status(),
      ...(closedSockets ? { closedSockets } : {}),
      ...(closedStreams ? { closedStreams } : {}),
    });
  }
  // `POST /api/share/doc` is GONE — a workspace is the unit of sharing.
  // It is answered explicitly rather than left to the 404 fall-through
  // because an older plugin bundle's `share_doc` still POSTs here with
  // its own payload, and the useful reply names the replacement instead
  // of reading as "your server is broken".
  if (pathname === '/api/share/doc' && req.method === 'POST') {
    return j(410, {
      error: 'per_doc_sharing_removed',
      hint: 'A workspace is the unit of sharing. File the doc on a workspace (attach_doc / bind_folder / create_diff_review) and call share_workspace or share_link with workspaceId.',
    });
  }
  // --- The RETIRED link-share redemption ---
  // Both spellings, one answer: the not-found page.
  //
  // `/share/<id>?exp=…&sig=…` was a signed capability URL exchanged once for
  // a session cookie, and `/s/<slug>` was the unsigned form before it. Link
  // mode is retired (Bryan, 2026-09-02: *"Every access including share link
  // or reading requires sign in."*), so neither redeems anything: the
  // registry is not consulted, no cookie is minted, and a record that still
  // carries a signature or a slug opens nothing.
  //
  // Answered here rather than left to fall through, for the same reason the
  // unsigned form always was: the route has to exist to say nothing. It
  // gives nothing away — retired, tampered, expired, revoked and
  // never-existed all render the same page — and the `no-referrer` header
  // keeps a nearly-valid signed URL out of any downstream Referer.
  //
  // Note the hostname these used to arrive on is refused a layer above this
  // now (there is no `link` kind in classifyHost any more), so on a live
  // deployment this branch is reached only if the operator also listed that
  // hostname as an Access host. It is defence in depth, not the gate.
  if (req.method === 'GET' && /^\/(?:share|s)\/[^/]+$/.test(pathname)) {
    return new Response(renderLinkNotFound(), {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'referrer-policy': 'no-referrer',
      },
    });
  }

  // Mint a share. Local-only: /api/share* is out of scope for a visitor, so
  // this can only be called from the machine.
  //
  // THE ROUTE NAME IS THE ONLY THING LEFT OF LINK MODE. `share_link` used to
  // mint a signed capability URL that anyone holding it could open with no
  // identity at all; it now mints an ACCESS share, exactly as
  // `/api/share/workspace` does, and the two differ only in how the audience
  // is named. The path and the payload are kept because peers keep calling
  // the shared server with the payload THEIR bundle sends, long after this
  // one stopped sending it (CLAUDE.md) — the ask "publish this board" did not
  // change, only what publishing means.
  if (pathname === '/api/share/link' && req.method === 'POST') {
    if (!shares) return j(404, { error: 'sharing not enabled' });
    const body = await safeJson(req);
    const workspaceId = body?.workspaceId as string | undefined;
    // A `docId` in the body is an OLDER BUNDLE's share_link asking for a
    // single-doc share. That grant is gone, and the dangerous reading of
    // this payload is "ignore the field you don't know and mint
    // something" — so it is refused by name, before anything is created.
    // Every peer keeps calling the shared server with the payload ITS
    // bundle sends, long after this one stopped sending it.
    if (body?.docId !== undefined) {
      return j(410, {
        error: 'per_doc_sharing_removed',
        hint: 'A workspace is the unit of sharing. Pass workspaceId (the doc must be filed on a workspace) — docId is no longer accepted.',
      });
    }
    if (!workspaceId) return j(400, { error: 'workspaceId required' });

    // Only a BOARD may be shared. A board is what `taskStore` answers
    // for; a review is what only `rooms` knows about. They arrive in
    // the SAME field — unlike the per-doc removal above, no shape of
    // the payload separates them — so the lookup IS the discriminator.
    const linkBoard = taskStore.getWorkspace(workspaceId);
    if (!linkBoard) {
      if (rooms.list().some((m) => m.workspaceId === workspaceId)) {
        return j(410, GROUPING_SHARING_REMOVED);
      }
      // Neither. Kept distinct from the 410 so that reply keeps meaning
      // "this exists and is no longer shareable" rather than becoming
      // the answer to every unrecognised id.
      return j(404, { error: 'workspace not found', workspaceId });
    }
    // And never the UNFILED board. Matched by NAME, because that is
    // how `defaultHubWorkspaceId()` itself finds it on every call —
    // the id is never cached, and any board answering that lookup can
    // receive other agents' stray reviews.
    if (linkBoard.name === DEFAULT_HUB_WORKSPACE_NAME) {
      return j(403, UNFILED_SHARING_REFUSED);
    }
    // A board share opens the board. There is no entry doc to choose,
    // and an older bundle sharing a board sends this key undefined,
    // which JSON.stringify drops.
    if (body?.entryDocId) {
      return j(400, {
        error: 'a board share opens the board — entryDocId is not supported',
      });
    }
    // Everything else in the body is either honoured below or refused
    // here BY NAME. The rule is accept-and-honour or refuse, never
    // accept-and-widen: `share_link(docId, ttl: '15m')` once answered
    // 200 with the whole board for two weeks because both fields fell
    // through — the MCP handler forwards the call as sent now, so this
    // is where a stray key is caught, and the reply says which.
    for (const key of Object.keys(body ?? {})) {
      if (!SHARE_LINK_ARGS.has(key)) {
        return j(400, {
          error: 'unsupported_argument',
          argument: key,
          hint: `share_link takes workspaceId, ttl (e.g. '15m'), ttlSeconds and label — ${JSON.stringify(key)} is not one of them and was not silently dropped.`,
        });
      }
    }
    if (body?.label !== undefined && typeof body.label !== 'string') {
      return j(400, { error: 'bad_label', hint: 'label must be a string' });
    }
    // WHO the Access application admits. A caller that names an audience gets
    // it; one that does not — every older bundle, whose `share_link` had no
    // such argument because a link admitted the world — falls back to the
    // OPERATOR ALLOWLIST. That fallback can only narrow: the old behaviour
    // was "anyone with the URL", and the new one is "the addresses this
    // deployment already trusts with the operator hostname". Refused only
    // when there is no allowlist either, because an Access app with no allow
    // policy admits nobody and would be a share that silently does nothing.
    const rawAudience = body?.allowDomains;
    if (rawAudience !== undefined) {
      if (
        !Array.isArray(rawAudience) ||
        rawAudience.length === 0 ||
        rawAudience.some((d) => typeof d !== 'string' || d.trim() === '')
      ) {
        return j(400, {
          error: 'bad_allow_domains',
          hint: 'allowDomains must be a non-empty array of addresses ("someone@partner.example") or domains ("@partner.example").',
        });
      }
    }
    const audience = (Array.isArray(rawAudience) ? (rawAudience as string[]) : defaultShareAudience)
      .map((d: string) => d.trim())
      .filter((d: string) => d !== '');
    if (audience.length === 0) {
      return j(400, {
        error: 'no_share_audience',
        hint: 'Every share is a Cloudflare Access share now, so it needs an audience. Pass allowDomains (["someone@partner.example"] or ["@partner.example"]), or set CW_PROXIED_TRUSTED_EMAILS / CW_OWNER_EMAIL so the server has a default.',
      });
    }
    const linkTtl = resolveTtl({
      ttl: body?.ttl,
      ttlSeconds: body?.ttlSeconds,
      defaultSeconds: shares.defaultLinkTtlSeconds,
      maxSeconds: shares.maxTtlSeconds,
    });
    if (!linkTtl.ok) return j(400, { error: linkTtl.error, hint: linkTtl.hint });
    try {
      const share = await shares.createShareWorkspace({
        workspaceId,
        allowDomains: audience,
        ttlSeconds: linkTtl.seconds,
        label: typeof body?.label === 'string' ? body.label : undefined,
      });
      return j(200, {
        share,
        // Said on every reply, not only when it was defaulted: the caller has
        // to tell a person who can open this, and the answer is no longer
        // "whoever you send the URL to".
        allowDomains: audience,
        ...(Array.isArray(rawAudience) ? {} : { audienceDefaulted: true }),
        ...(linkTtl.clamped ? { ttlClamped: linkTtl.clamped } : {}),
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'create_share_failed';
      if (error === ACCESS_NOT_CONFIGURED) {
        return j(503, {
          error,
          hint: 'Link shares are retired, so every share needs Cloudflare Access: set CF_ACCOUNT_ID, CF_SHARE_BASE_HOSTNAME and CF_ACCESS_TEAM_DOMAIN, and put a Cloudflare API token in the Keychain (service cloudflare-api-token).',
        });
      }
      return j(400, { error });
    }
  }

  // Extend or shorten a live share. Local-only, same as creation.
  const ttlMatch = pathname.match(/^\/api\/share\/([^/]+)\/ttl$/);
  if (ttlMatch && req.method === 'POST') {
    if (!shares) return j(404, { error: 'sharing not enabled' });
    const shareId = decodeURIComponent(ttlMatch[1] ?? '');
    const body = await safeJson(req);
    if (body?.ttlSeconds === undefined && body?.ttl === undefined) {
      return j(400, { error: 'ttlSeconds required' });
    }
    // Same resolver as the mint, so the ceiling holds on extension too.
    const newTtl = resolveTtl({
      ttl: body?.ttl,
      ttlSeconds: body?.ttlSeconds,
      defaultSeconds: shares.defaultLinkTtlSeconds,
      maxSeconds: shares.maxTtlSeconds,
    });
    if (!newTtl.ok) return j(400, { error: newTtl.error, hint: newTtl.hint });
    try {
      const share = await shares.setTtl(shareId, newTtl.seconds);
      return share
        ? j(200, { share, ...(newTtl.clamped ? { ttlClamped: newTtl.clamped } : {}) })
        : j(404, { error: 'share not found' });
    } catch (err) {
      return j(400, { error: err instanceof Error ? err.message : 'bad ttl' });
    }
  }

  // --- Mint a SHARE LINK (`share_workspace`) ---
  //
  // The 2026-09-03 flow, and the whole of what this route now does: write a
  // row, hand back `https://share.<domain>/s/<id>`. No Cloudflare API call, no
  // Access application, no DNS record, no policy, no API token on the box. One
  // Access application the operator made by hand covers the share hostname
  // with an "everyone" policy, so proving an email is Cloudflare's job and
  // deciding who may open which workspace is this server's — which is the
  // layering the security model already described everywhere else.
  //
  // THE OLD PAYLOAD IS STILL ACCEPTED. `allowDomains` and `name` were the two
  // arguments the per-share-application mint needed — who the policy admits,
  // and what to call the subdomain — and neither exists any more. Peers keep
  // calling the shared server with the payload THEIR bundle sends long after
  // this one stopped sending it (CLAUDE.md), so they are accepted and ignored
  // rather than refused: the ask "publish this board" did not change. The
  // reply says `allowDomainsIgnored` so a caller that named an audience is
  // told its request no longer means anything, instead of believing the link
  // is narrower than it is.
  //
  // The RESPONSE shape is new (no hostname, no audience, no appId) and there
  // is no shim for the old one — Bryan waived compatibility shims for
  // prototype-phase surfaces (2026-08-18).
  if (pathname === '/api/share/workspace' && req.method === 'POST') {
    const body = await safeJson(req);
    const workspaceId = (body?.workspaceId as string) ?? '';
    if (!workspaceId) return j(400, { error: 'workspaceId required' });
    // A `docId` in the body is an OLDER BUNDLE asking for a single-doc share.
    // Refused by name rather than widened to the board, exactly as the sibling
    // route refuses it: the dangerous reading of a payload is "ignore the
    // field you do not know and mint something".
    if (body?.docId !== undefined) {
      return j(410, {
        error: 'per_doc_sharing_removed',
        hint: 'A workspace is the unit of sharing. Pass workspaceId (the doc must be filed on a workspace) — docId is no longer accepted.',
      });
    }
    // Only a BOARD may be shared, and the same two refusals as every other
    // mint. A board is what `taskStore` answers for; a review is what only
    // `rooms` knows about, and they arrive in the same field, so the lookup IS
    // the discriminator.
    const board = taskStore.getWorkspace(workspaceId);
    if (!board) {
      if (rooms.list().some((m) => m.workspaceId === workspaceId)) {
        return j(410, GROUPING_SHARING_REMOVED);
      }
      return j(404, { error: 'workspace not found', workspaceId });
    }
    // And never the UNFILED board — matched by NAME, the way
    // `defaultHubWorkspaceId()` finds it, because the id is never cached and
    // any board answering that lookup receives other agents' stray reviews.
    if (board.name === DEFAULT_HUB_WORKSPACE_NAME) {
      return j(403, UNFILED_SHARING_REFUSED);
    }
    // BELOW the board lookup, in the order the retired mint used: an older
    // bundle sends `entryDocId: undefined` on every board share, and a
    // grouping id with a member doc must still answer "a grouping cannot be
    // shared" rather than "that argument is unsupported".
    if (body?.entryDocId) {
      return j(400, {
        error: 'a board share opens the board — entryDocId is not supported',
      });
    }
    if (body?.label !== undefined && typeof body.label !== 'string') {
      return j(400, { error: 'bad_label', hint: 'label must be a string' });
    }
    // NO EXPIRY BY DEFAULT (Bryan, 2026-09-03: links are long-living). An
    // optional one stays on the record for the cases that want it, and the
    // same resolver as every other share route reads it, so a configured
    // ceiling still clamps a caller who asks for more.
    let ttlSeconds: number | undefined;
    if (body?.ttl !== undefined || body?.ttlSeconds !== undefined) {
      const ttl = resolveTtl({
        ttl: body?.ttl,
        ttlSeconds: body?.ttlSeconds,
        // Unreachable — this branch only runs when the caller named one —
        // and required by the resolver's shape. A caller who names neither
        // gets no expiry at all, which is the line above, not a default here.
        defaultSeconds: shares?.defaultLinkTtlSeconds ?? DEFAULT_LINK_TTL_SECONDS,
        ...(shares?.maxTtlSeconds ? { maxSeconds: shares.maxTtlSeconds } : {}),
      });
      if (!ttl.ok) return j(400, { error: ttl.error, hint: ttl.hint });
      ttlSeconds = ttl.seconds;
    }
    // The configuration refusal is LAST, below every argument and board
    // check, so a caller sharing something that could never be shared hears
    // which — a 503 in front of the 410 would tell a peer whose diff review
    // stopped being shareable that the server is misconfigured instead.
    if (!shareLinkBaseHost) {
      return j(503, {
        error: 'share_hostname_not_configured',
        hint: "Set CW_SHARE_LINK_HOSTS to the share hostname and CF_ACCESS_SHARE_AUD to the audience of the Cloudflare Access application in front of it (its own application, not the owner hostname's), alongside CF_ACCESS_TEAM_DOMAIN.",
      });
    }
    try {
      const link = shareLinks.create({
        workspaceId,
        createdBy: typeof body?.createdBy === 'string' && body.createdBy ? body.createdBy : 'agent',
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
        ...(typeof body?.label === 'string' ? { label: body.label } : {}),
      });
      const url = `https://${shareLinkBaseHost}/s/${link.linkId}`;
      return j(200, {
        link,
        url,
        // Said whenever a caller named one, because the field no longer does
        // anything: the link admits whoever opens it and signs in, and the
        // reply must not let a caller believe otherwise.
        ...(body?.allowDomains !== undefined ? { allowDomainsIgnored: true } : {}),
      });
    } catch (err) {
      return j(400, { error: err instanceof Error ? err.message : 'create_share_link_failed' });
    }
  }

  // --- Take a member's access away ---
  //
  // The other half of `unshare`, and deliberately a separate verb. Revoking a
  // link stops new arrivals; this ends the access of someone who already came
  // through one. Collapsing the two would mean revoking a link ejected
  // everybody it ever admitted, which is the behaviour the "redeeming makes a
  // lasting member" decision exists to avoid.
  //
  // Effective on the NEXT REQUEST for HTTP, and immediately for what is
  // already open. A websocket and an SSE stream are authorized once, at their
  // upgrade, and never re-checked — so this used to answer `sockets:
  // 'unchanged'` and mean it: a removed member with the board already open
  // kept reading AND writing over `/y/<doc>` until the connection dropped.
  // The membership is now stamped on both, so both can be found and hung up,
  // and the reply says how many were.
  if (pathname === '/api/share/member/remove' && req.method === 'POST') {
    const body = await safeJson(req);
    const workspaceId = (body?.workspaceId as string) ?? '';
    const email = (body?.email as string) ?? '';
    if (!workspaceId || typeof workspaceId !== 'string') {
      return j(400, { error: 'workspaceId required' });
    }
    if (!email || typeof email !== 'string') return j(400, { error: 'email required' });
    const removed = shareLinks.removeMember(workspaceId, email);
    if (!removed) return j(404, { error: 'not a member', workspaceId });
    // Exactly this membership. Someone ejected from one board may still hold
    // another, and their connections to that one must survive.
    const key = shareMemberKey(workspaceId, email);
    const closedSockets = rooms.closeSocketsForShareMembers((k) => k === key);
    const closedStreams = sse.closeForShareMembers((k) => k === key);
    return j(200, { ok: true, closedSockets, closedStreams });
  }

  const shareIdMatch = pathname.match(/^\/api\/share\/([^/]+)$/);
  if (shareIdMatch && req.method === 'DELETE') {
    if (!shares && !shareLinkBaseHost) return j(404, { error: 'sharing not enabled' });
    const shareId = decodeURIComponent(shareIdMatch[1] ?? '');
    // ONE verb for both kinds of record, because `unshare(id)` is one ask and
    // the caller does not know which registry an id came out of. The old
    // registry is tried first — it is the one whose teardown makes a network
    // call, so a miss there is cheap and a hit must not be shadowed.
    //
    // What revoking a LINK does NOT do is eject the people who already came
    // through it. That is the "redeeming makes a lasting member" decision
    // (Bryan, 2026-09-03): the link stops admitting anybody new, and ending
    // one person's access is `POST /api/share/member/remove`. So there are no
    // sockets to hang up here and none are closed — the members are still
    // members, and their next request will say so.
    if (shareLinks.revoke(shareId)) {
      return j(200, { ok: true, revoked: 'link', members: 'unchanged' });
    }
    if (!shares) return j(404, { error: 'share not found' });
    try {
      const result = await shares.deleteShare(shareId);
      // Authorization is checked per HTTP request, but a websocket is
      // authorized once at its upgrade — so without this, a visitor who
      // already had the doc open kept reading and writing it after the
      // share was revoked.
      const closed = result.ok ? rooms.closeSocketsForShare(shareId) : 0;
      // The SSE stream has the same "authorized once, then long-lived"
      // shape: a visitor with the review page still open would otherwise
      // keep receiving every new comment on a doc they can no longer load.
      const closedStreams = result.ok ? sse.closeForShare(shareId) : 0;
      return result.ok
        ? j(200, {
            ok: true,
            ...(closed ? { closedSockets: closed } : {}),
            ...(closedStreams ? { closedStreams } : {}),
          })
        : j(404, { error: 'share not found' });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'delete_share_failed';
      return j(502, { error });
    }
  }

  return undefined;
}
