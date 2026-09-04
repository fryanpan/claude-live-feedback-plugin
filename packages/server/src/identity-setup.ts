/**
 * Email-keyed identity: the roster, the sign-in stores, and the four
 * predicates that answer "who is this request".
 *
 * One module because they are one chain. A session cookie names a session,
 * a widget token names the same session, and every liveness rule the cookie
 * faces — the failed-closed denylist, the per-session revocations a logout
 * writes, roster status, the `sessionsValidFrom` watermark — has to apply to
 * the token on every use as well. `sessionIdentityFor` and
 * `widgetTokenIdentityFor` are written to read the same, deliberately, so an
 * edit to one is obviously a change to both; splitting them would be the
 * drift that lets a revoked session keep commenting through its token.
 *
 * The roster is built here whether or not `CW_REQUIRE_EMAIL_AUTH` is set:
 * the flag governs what a session MEANS, not whether a person can create
 * one. The four sign-in switches are resolved here for the same reason —
 * they are read as one set and defaulted against each other.
 *
 * Lifted verbatim out of `createServer`.
 */
import { emailIdentityId, isEmailLike } from '@feedback/core';
import { acquireActivityLock } from './activity-lock.ts';
import {
  identityLinks,
  ownerIdentityIds,
  registerOwnerIdentity,
  resolveIdentityId,
  setIdentityRoster,
} from './actor-identity.ts';
import { type CodeSender, createLogCodeSender } from './auth/code-sender.ts';
import { EmailCodes } from './auth/email-code.ts';
import { SessionRevocations } from './auth/session-revocations.ts';
import {
  SESSION_COOKIE,
  sessionKey as deriveSessionKey,
  sessionCookieHeader as emailSessionCookieHeader,
  refreshedSession,
  sessionNeedsRefresh,
  verifySession as verifyEmailSession,
} from './auth/session.ts';
import { widgetTokenKey as deriveWidgetTokenKey, verifyWidgetToken } from './auth/widget-token.ts';
import { Identities, type IdentityRecord } from './identities.ts';
import { loadIdentityLinks } from './identity-links.ts';
import { clientAddressKey } from './middleware/client-address.ts';
import { WebhookReplayGuard } from './recall-webhook-auth.ts';
import { readCookie } from './share/link-session.ts';

/**
 * The `ServerOptions` fields this module reads, and no more.
 *
 * Structural rather than importing `ServerOptions`: that type lives in
 * server.ts, which imports this module, so naming it would close a cycle.
 */
export interface IdentitySetupOptions {
  ownerEmail?: string;
  codeSender?: CodeSender;
  authCeilings?: { globalStartsPerHour?: number; peerStartsPerHour?: number };
  requireEmailAuth?: boolean;
  requireSignInToWrite?: boolean;
  accessOnlyBrowserHosts?: boolean;
  emailCodeSignIn?: boolean;
}

export interface IdentitySetupContext {
  /** Where `identities.json`, the revocation denylist and the activity log
   *  and its lock all live. */
  dataDir: string;
  /** The resolved settings, narrowed to what this file reads. */
  opts: IdentitySetupOptions;
  /** The root HMAC key both derived keys hang off. A thunk because the key
   *  is generated on first use rather than at boot. */
  cookieKey: () => string;
  /** Teach the hub store which roster resolves its agent ids. A thunk
   *  rather than the store itself: this is the only thing wanted from it,
   *  and naming the store would pull the whole hub in for one call. */
  setTaskStoreAgentRoster: (roster: Identities) => void;
  /** The request's SOCKET address. Not a header — see client-address.ts for
   *  why both of this deployment's proxies dial over loopback. */
  requestAddress: (req: Request) => string | undefined;
  /** The origin policy, which is the ONE place a scheme is derived from an
   *  allowlisted `x-forwarded-proto`. `isSecureRequest` reads it rather than
   *  the request URL, whose protocol is always plain http. */
  policyFor: (req: Request) => { requestOrigin: string };
}

/** Build the roster, the sign-in stores and the request predicates. */
export function createIdentitySetup(ctx: IdentitySetupContext) {
  const { dataDir, opts, cookieKey, setTaskStoreAgentRoster, requestAddress, policyFor } = ctx;
  // --- Email-keyed identity ---------------------------------------------
  // The roster and the challenge store. Both are cheap to construct and
  // neither reads anything at boot beyond `identities.json`, so they exist
  // whether or not `CW_REQUIRE_EMAIL_AUTH` is set — the flag governs what a
  // session MEANS, not whether a person can create one. See ServerOptions.
  const identities = new Identities({ dataDir });
  if (identities.loadError) {
    console.error(`[identities] ${identities.loadError}`);
  }
  // Agents are roster rows too: an attach writes one, and the seat claim
  // names the lead by it. See identities.ts. The activity readers resolve
  // through the same roster, so an old actor id reads as the identity it
  // was merged into.
  setTaskStoreAgentRoster(identities);
  setIdentityRoster(identities);
  // Teach the owner check which anonymous session ids belong to a known
  // person. Logged either way: a link file that failed to parse and one that
  // was never written both leave the map empty, and the difference is
  // invisible everywhere downstream — it shows up only as an activity stream
  // that under-attributes, months later. See identity-links.ts.
  // Advertise that this process appends to `<dataDir>/activity.jsonl`, so the
  // repair tool can verify the log has no live writer instead of trusting an
  // operator to have stopped us. BEST EFFORT on purpose: a leftover lock file
  // must never be able to stop the server from booting — that would turn a
  // stray file into an outage. The refusal lives on the repair side, where
  // refusing means "changed nothing". See activity-lock.ts.
  const activityLock = acquireActivityLock(dataDir, 'server');
  if (!activityLock.ok) {
    console.error(
      `[activity] ${activityLock.path} is held by pid ${activityLock.heldBy?.pid} ` +
        `(${activityLock.heldBy?.holder}); starting anyway. A repair running now cannot see us.`,
    );
  }
  const identityLinkLoad = loadIdentityLinks(dataDir);
  if (identityLinkLoad.error) {
    console.error(`[identities] ${identityLinkLoad.error}`);
  } else if (identityLinkLoad.loaded > 0) {
    console.log(`[identities] ${identityLinkLoad.loaded} identity link(s) loaded`);
  }
  const emailCodes = new EmailCodes(opts.authCeilings ?? {});
  const sessionRevocations = new SessionRevocations({ dataDir });
  if (sessionRevocations.loadError) {
    console.error(`[auth] revoked-sessions file was unreadable: ${sessionRevocations.loadError}`);
    // Fail closed, then self-heal (Bryan + security review, 2026-08-28): a
    // revoked id could be hiding in the unreadable file, so end EVERY
    // outstanding session via the roster watermark — after which an empty
    // denylist resurrects nothing and the store can restart. Order matters:
    // the bump must be durable before the store reopens.
    const bumped = identities.revokeAllSessions();
    if (sessionRevocations.resetAfterWatermarkBump()) {
      console.error(
        `[auth] self-healed: sessions for ${bumped} identities ended via the sessionsValidFrom watermark; denylist restarted empty (broken file kept aside) — everyone signs in again`,
      );
    } else {
      // The broken file would not even move aside. The store stays failed
      // closed, which sessionIdentityFor turns into "nobody is signed in".
      console.error(
        '[auth] could not move the broken revoked-sessions file aside — REFUSING ALL SESSIONS until it is restored or deleted',
      );
    }
  }
  const codeSender = opts.codeSender ?? createLogCodeSender();
  const requireEmailAuth = opts.requireEmailAuth ?? false;
  // ON by default (owner decision on the security row, 2026-09-02). Tests of
  // OTHER gates that write from a browser pass `false` explicitly; the
  // deployment switch is `CW_REQUIRE_SIGNIN_TO_WRITE` in bin.ts.
  const requireSignInToWrite = opts.requireSignInToWrite ?? true;
  // ON by default (Bryan, 2026-09-02). Off restores the tailnet/LAN grant;
  // the deployment switch is `CW_ACCESS_ONLY_BROWSER_HOSTS` in bin.ts.
  const accessOnlyBrowserHosts = opts.accessOnlyBrowserHosts ?? true;
  const emailCodeSignIn = opts.emailCodeSignIn ?? !accessOnlyBrowserHosts;
  /** Which signed Recall webhook ids have already been accepted. */
  const webhookReplayGuard = new WebhookReplayGuard();
  // Teach the owner check the owner's email identity. Without this the check
  // keeps matching only `known-bryan` / "Bryan", and the day the owner's
  // identity becomes `user-<hash>` the owner-activity view quietly reads
  // empty with nothing anywhere reporting it. See activity.ts.
  if (opts.ownerEmail && isEmailLike(opts.ownerEmail)) {
    const ownerId = emailIdentityId(opts.ownerEmail);
    registerOwnerIdentity(ownerId);
    // Named so the identity exists in the roster before its first write,
    // rather than appearing the first time the owner happens to log in.
    identities.upsertByEmail(opts.ownerEmail);
    // The owner's legacy spellings fold into the owner's roster row: the
    // pre-email id, and every link-file id whose target is an owner id. So
    // every reader that resolves through the roster — activity rows, the
    // home brief, the weekly-review projections — lands on ONE identity for
    // the owner. Read-time only; nothing on disk is rewritten.
    const owners = new Set(ownerIdentityIds());
    identities.addMergedFrom(ownerId, 'known-bryan');
    for (const [from, to] of Object.entries(identityLinks())) {
      if (owners.has(to) || owners.has(resolveIdentityId(to))) {
        identities.addMergedFrom(ownerId, from);
      }
    }
  } else if (opts.ownerEmail) {
    console.error(`[identities] CW_OWNER_EMAIL is not an address: ${opts.ownerEmail}`);
  }
  let emailSessionKeyCache: string | null = null;
  const emailSessionKey = (): string => {
    emailSessionKeyCache ??= deriveSessionKey(cookieKey());
    return emailSessionKeyCache;
  };
  let widgetTokenKeyCache: string | null = null;
  const widgetTokenKey = (): string => {
    widgetTokenKeyCache ??= deriveWidgetTokenKey(cookieKey());
    return widgetTokenKeyCache;
  };

  /**
   * The widget popup-token off a request's Authorization header, or null.
   *
   * Only `Bearer wt1.…` is ours — any other Authorization value is somebody
   * else's protocol and must stay invisible here, so presenting one can
   * never trip the widget-token 401.
   */
  const widgetBearerOf = (req: Request): string | null => {
    const header = req.headers.get('authorization');
    if (!header) return null;
    const m = header.match(/^Bearer\s+(wt1\..+)$/i);
    return m?.[1] ?? null;
  };

  /**
   * The identity a widget token attests to, or null. The mirror of
   * `sessionIdentityFor`: the token names a session, so every liveness rule
   * a cookie faces — the failed-closed denylist, the per-session revocation
   * logout writes, roster status, the `sessionsValidFrom` watermark —
   * applies to the token on every use. Remove any of these and a revoked
   * session keeps commenting through its token.
   *
   * `presentedOrigin` is the request's `Origin` header. The token was
   * minted for exactly one page origin (signed in), and only a request the
   * browser stamped with that origin may use it: absent (curl, a server-
   * side replay), `null` (an opaque origin), or any other origin is a 401.
   * The widget's every use is a cross-origin fetch, which always carries
   * the header — this costs the real caller nothing and a thief everything.
   */
  const widgetTokenIdentityFor = (
    raw: string,
    presentedOrigin: string | null,
  ): IdentityRecord | null => {
    // Belt-and-braces, deliberately: `isRevoked` below already answers true
    // while the denylist is failed closed, and a widget token always
    // carries a session id (verifyWidgetToken refuses one without), so this
    // line is never the only thing refusing. It mirrors sessionIdentityFor,
    // where a v1 cookie has no session id and WOULD skip `isRevoked`; kept
    // so the two gates read the same and a future edit to one is obviously
    // a change to both. Mutation-tested: removing it turns nothing red.
    if (sessionRevocations.failedClosed()) return null;
    const claims = verifyWidgetToken(raw, widgetTokenKey());
    if (!claims) return null;
    if (presentedOrigin === null || presentedOrigin !== claims.origin) return null;
    if (sessionRevocations.isRevoked(claims.sessionId)) return null;
    const rec = identities.get(claims.identityId);
    // Status is load-bearing on its own, not only via the watermark:
    // `archive()` bumps sessionsValidFrom, but a roster row hand-edited to
    // `archived` (the file is meant to be editable) carries no bump, and
    // only this check refuses its tokens. Pinned in the routes test.
    if (!rec || rec.status !== 'active') return null;
    if (claims.sessionIssuedAt < rec.sessionsValidFrom) return null;
    return rec;
  };

  /**
   * Which client the login rate limits count this request against.
   *
   * NOT `server.requestIP(req)` on its own: both of this deployment's reverse
   * proxies run on this machine and dial the server over loopback, so that
   * call answers `127.0.0.1` for every remote reviewer and collapsed all of
   * them into one shared budget. See middleware/client-address.ts for the
   * measurements and for why the header is read only from a loopback socket
   * and only from its rightmost entry.
   */
  const clientKeyFor = (req: Request): string =>
    clientAddressKey({
      socketAddress: requestAddress(req),
      forwardedFor: req.headers.get('x-forwarded-for'),
    });

  /**
   * Whether this request really reached us over https.
   *
   * Read off `policyFor`, which is the ONE place that derives a scheme from
   * an allowlisted `x-forwarded-proto` — the server's own socket is always
   * plain http, so `new URL(req.url).protocol` would answer "http" for every
   * https visitor and strip `Secure` from every cookie they get. Reusing that
   * derivation also inherits its defence against header injection.
   */
  const isSecureRequest = (req: Request): boolean =>
    policyFor(req).requestOrigin.startsWith('https://');

  /**
   * The identity a request's session cookie attests to, or null.
   *
   * Six ways to be null and they are deliberately indistinguishable to the
   * caller: no cookie, a cookie that does not verify (or, old format, has
   * expired), an identity the roster does not hold, an identity whose
   * sessions have been revoked or archived, a session that was logged out,
   * and a revocation list in its failed-closed state (unhealable at boot,
   * or deleted at runtime). Every one of them means "not signed in".
   */
  const sessionIdentityFor = (req: Request): IdentityRecord | null => {
    // Fail closed on a broken revocation list — with it gone, nothing can
    // tell a live session from a logged-out one. Checked here and not only
    // inside `isRevoked` because a surviving v1 cookie has no session id
    // and would skip that call entirely.
    if (sessionRevocations.failedClosed()) return null;
    const claims = verifyEmailSession(
      readCookie(req.headers.get('cookie'), SESSION_COOKIE),
      emailSessionKey(),
    );
    if (!claims) return null;
    // Per-session revocation — what logout writes. This is the only thing
    // that ends a v2 cookie, which carries no expiry of its own.
    if (claims.sessionId !== null && sessionRevocations.isRevoked(claims.sessionId)) return null;
    const rec = identities.get(claims.identityId);
    if (!rec || rec.status !== 'active') return null;
    // Identity-wide revocation: a cookie minted before the watermark is dead
    // however long it says it lives.
    if (claims.issuedAt < rec.sessionsValidFrom) return null;
    return rec;
  };

  /**
   * Re-issue a live session's cookie in place. The session itself never
   * expires; what slides is the browser's own cap on cookie retention (and,
   * for surviving old-format cookies, their baked-in 90-day expiry — this is
   * where they upgrade to the revocable format).
   *
   * Done in the response wrapper rather than per route because "on use" means
   * every request, and a session that lapsed while somebody was reviewing
   * daily would be the one failure this design exists to avoid. Skipped when
   * the response already sets the cookie (login and logout own it), and
   * cheap: the refresh only fires once a day of the session has been spent.
   */
  const refreshSession = (req: Request, res: Response): Response => {
    const raw = readCookie(req.headers.get('cookie'), SESSION_COOKIE);
    if (!raw) return res;
    const claims = verifyEmailSession(raw, emailSessionKey());
    if (!claims || !sessionNeedsRefresh(claims)) return res;
    if (res.headers.get('set-cookie')?.includes(`${SESSION_COOKIE}=`)) return res;
    const rec = sessionIdentityFor(req);
    if (!rec) return res;
    const headers = new Headers(res.headers);
    headers.append(
      'set-cookie',
      // NOT a fresh mint: the refresh keeps the session id, so a later
      // logout on this device revokes the session it has had all along.
      // (An old-format cookie gains its id here — the upgrade path.)
      emailSessionCookieHeader(refreshedSession(claims), emailSessionKey(), {
        secure: isSecureRequest(req),
      }),
    );
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

  return {
    identities,
    activityLock,
    emailCodes,
    sessionRevocations,
    codeSender,
    requireEmailAuth,
    requireSignInToWrite,
    accessOnlyBrowserHosts,
    emailCodeSignIn,
    webhookReplayGuard,
    emailSessionKey,
    widgetTokenKey,
    widgetBearerOf,
    widgetTokenIdentityFor,
    clientKeyFor,
    isSecureRequest,
    sessionIdentityFor,
    refreshSession,
  };
}
