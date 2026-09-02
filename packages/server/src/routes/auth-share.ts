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
import type { ShareTarget } from '../middleware/host-guard.ts';
import { browserCannotOperateBody, isBrowserRequest } from '../middleware/write-gate.ts';
import type { Rooms } from '../rooms.ts';
import { readCookie, sessionCookieHeader } from '../share/link-session.ts';
import type { Shares } from '../share/shares.ts';
import type { SharingGate } from '../share/sharing-gate.ts';
import { resolveTtl } from '../share/ttl.ts';
import type { Share } from '../share/types.ts';
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
const SHARE_LINK_ARGS: ReadonlySet<string> = new Set(['workspaceId', 'ttl', 'ttlSeconds', 'label']);

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
  /** The name of the catch-all board, which may not be shared. */
  defaultHubWorkspaceName: string;

  /** JSON response helper — status plus body, no CORS (the per-request
   *  wrapper in createServer adds that, because it knows the Origin). */
  j: (status: number, body: unknown) => Response;
  /** Parse a request body, answering null rather than throwing. */
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;

  /** What a share may reach, or null when it may reach nothing. */
  boardShareTarget: (share: Share | null | undefined) => ShareTarget | null;
  /** The rate-limit key for a caller, from the socket and the proxy header. */
  clientKeyFor: (req: Request) => string;
  /** The HMAC key behind link-mode session cookies. */
  cookieKey: () => string;
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
    sharingGate,
    identities,
    emailCodes,
    sessionRevocations,
    codeSender,
    requireEmailAuth,
    requireSignInToWrite,
    defaultHubWorkspaceName: DEFAULT_HUB_WORKSPACE_NAME,
    j,
    safeJson,
    boardShareTarget,
    clientKeyFor,
    cookieKey,
    emailSessionKey,
    widgetTokenKey,
    isSecureRequest,
    policyFor,
    sessionIdentityFor,
  } = ctx;
  const { req, url, pathname, widgetIdentity, browserProvedNobody, provenIdentityFor } = rq;

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
  // caller. Keyed on METHOD rather than a route list, the same way
  // `isGatedWrite` is: a share mutation added later is covered by
  // construction, and the GET stays open because reading the share list
  // is what the board's own settings pane does.
  if (
    (pathname === '/api/share' || pathname.startsWith('/api/share/')) &&
    req.method !== 'GET' &&
    isBrowserRequest(req.headers)
  ) {
    return j(403, browserCannotOperateBody());
  }
  if (pathname === '/api/share' && req.method === 'GET') {
    if (!shares) return j(404, { error: 'sharing not enabled' });
    // `listWithUrls` recomputes every link share's signed URL, which is
    // how a record minted before signing serves a usable URL at all.
    return j(200, { shares: await shares.listWithUrls(), sharing: sharingGate.status() });
  }
  // Flip the master switch. Local-only, like the rest of /api/share*.
  // Turning it OFF also hangs up what is already connected: a websocket
  // and an SSE stream are authorized ONCE at open, so a visitor mid-review
  // would otherwise keep syncing and keep receiving comments on a doc
  // that is no longer reachable. Same lesson as share revocation.
  if (pathname === '/api/share/enabled' && req.method === 'POST') {
    if (!shares) return j(404, { error: 'sharing not enabled' });
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
      for (const share of shares.list()) {
        closedSockets += rooms.closeSocketsForShare(share.shareId);
        closedStreams += sse.closeForShare(share.shareId);
      }
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
  // --- Redeem a share link ---
  // A SIGNED capability URL: `/share/<id>?exp=<unix-seconds>&sig=<hex>`,
  // HMAC over `<id>.<exp>` (share/url-signing.ts). Exchange it for a
  // signed session cookie, then redirect to the board. Validated here
  // on every request as defense-in-depth — the edge Worker
  // (infra/share-link-worker/) is the first gate, and the app never
  // trusts that it ran. Deliberately gives nothing away on failure —
  // tampered, expired, revoked, and never-existed all look alike.
  const redeemMatch = pathname.match(/^\/share\/([^/]+)$/);
  if (redeemMatch && req.method === 'GET') {
    const shareId = decodeURIComponent(redeemMatch[1] ?? '');
    const share = shares
      ? await shares.verifySignedLink(
          shareId,
          url.searchParams.get('exp') ?? '',
          url.searchParams.get('sig') ?? '',
        )
      : null;
    if (!share) {
      return new Response(renderLinkNotFound(), {
        status: 404,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // Even the failure page must not leak the (possibly almost-
          // valid) signed URL into a Referer header.
          'referrer-policy': 'no-referrer',
        },
      });
    }
    // A share lands IN the board — never a review URL, never a lobby
    // (§2.5). Resolved at redemption like everything else, so a board
    // deleted after minting falls through to the same not-found.
    //
    // A legacy GROUPING share lands here too, and gets that same 404
    // rather than a named 410. The route's own rule is that an unknown,
    // an expired and a tampered URL are indistinguishable — telling a
    // stranger holding a leaked link that it was once real would give
    // away more than the removal takes back. The named 410 is for the
    // MINT routes, where the caller is a peer with a legitimate ask.
    if (!boardShareTarget(share)) {
      return new Response(renderLinkNotFound(), {
        status: 404,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'referrer-policy': 'no-referrer',
        },
      });
    }
    const maxAge = Math.floor((share.expiresAt - Date.now()) / 1000);
    return new Response(null, {
      status: 302,
      headers: {
        location: `/workspaces/${encodeURIComponent(share.workspaceId)}`,
        'set-cookie': sessionCookieHeader(share.shareId, cookieKey(), maxAge),
        // Keep the signed URL out of any downstream Referer header.
        'referrer-policy': 'no-referrer',
      },
    });
  }

  // The RETIRED unsigned form. `/s/<slug>` stopped being accepted when
  // links became signed URLs — the registry is never consulted, so a
  // record that still carries a slug redeems nothing. The records
  // themselves stay (soft behavior): list_shares serves each one a
  // fresh signed URL computed on demand, which is the migration path
  // for anything minted before signing.
  if (req.method === 'GET' && /^\/s\/[^/]+$/.test(pathname)) {
    return new Response(renderLinkNotFound(), {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // An old slug is a retired credential — same Referer hygiene.
        'referrer-policy': 'no-referrer',
      },
    });
  }

  // Mint a share link. Local-only: /api/share* is out of scope for a
  // visitor, so this can only be called from the machine or the tailnet.
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
    const linkTtl = resolveTtl({
      ttl: body?.ttl,
      ttlSeconds: body?.ttlSeconds,
      defaultSeconds: shares.defaultLinkTtlSeconds,
      maxSeconds: shares.maxTtlSeconds,
    });
    if (!linkTtl.ok) return j(400, { error: linkTtl.error, hint: linkTtl.hint });
    try {
      const share = await shares.createShareLink({
        workspaceId,
        ttlSeconds: linkTtl.seconds,
        label: typeof body?.label === 'string' ? body.label : undefined,
      });
      return j(200, {
        share,
        ...(linkTtl.clamped ? { ttlClamped: linkTtl.clamped } : {}),
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'create_share_failed';
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

  // Share a whole workspace (folder bind / diff review) rather than one
  // doc: the visitor gets the file tree and every member, so the set
  // browses as a set. Scope is enforced in middleware/host-guard.ts.
  if (pathname === '/api/share/workspace' && req.method === 'POST') {
    if (!shares) return j(404, { error: 'sharing not enabled' });
    const body = await safeJson(req);
    const workspaceId = (body?.workspaceId as string) ?? '';
    const allowDomains = (body?.allowDomains as string[]) ?? [];
    if (!workspaceId) return j(400, { error: 'workspaceId required' });
    if (!Array.isArray(allowDomains) || allowDomains.length === 0) {
      return j(400, { error: 'allowDomains must be a non-empty array' });
    }
    // Same board-only rule as the link route, and for the same reason:
    // the two modes differ only in how a visitor is authorized, never
    // in what may be shared.
    const accessBoard = taskStore.getWorkspace(workspaceId);
    if (!accessBoard) {
      if (rooms.list().some((m) => m.workspaceId === workspaceId)) {
        return j(410, GROUPING_SHARING_REMOVED);
      }
      return j(404, { error: 'workspace not found', workspaceId });
    }
    // Same Unfiled refusal as the link route — see there for why the
    // predicate is the board's name.
    if (accessBoard.name === DEFAULT_HUB_WORKSPACE_NAME) {
      return j(403, UNFILED_SHARING_REFUSED);
    }
    if (body?.entryDocId) {
      return j(400, {
        error: 'a board share opens the board — entryDocId is not supported',
      });
    }
    try {
      const share = await shares.createShareWorkspace({
        workspaceId,
        allowDomains,
        ttlSeconds: typeof body?.ttlSeconds === 'number' ? body.ttlSeconds : undefined,
        name: typeof body?.name === 'string' ? body.name : undefined,
      });
      return j(200, { share });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'create_share_failed';
      return j(502, { error });
    }
  }
  const shareIdMatch = pathname.match(/^\/api\/share\/([^/]+)$/);
  if (shareIdMatch && req.method === 'DELETE') {
    if (!shares) return j(404, { error: 'sharing not enabled' });
    const shareId = decodeURIComponent(shareIdMatch[1] ?? '');
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
