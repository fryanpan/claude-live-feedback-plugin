/**
 * ── Request attribution: whose name goes on the write ──
 *
 * The other half of the question `request-admission.ts` answers. Admission
 * decides who the boundary PROVED and whether the request gets in at all;
 * attribution decides which of the things it proved is written down as the
 * author, and what a caller is allowed to claim about itself.
 *
 * ── Why this chains after admission instead of composing beside it ──
 *
 * A14 through A19 came out as factories of long-lived values, composed side
 * by side in `createServer`. This one cannot. Its input is the ADMISSION
 * RESULT — `accessEmail` is what Cloudflare verified for this request, and
 * `visitor` / `visitorShareId` are what the share scope decided — so it has
 * nothing to read until the gate has run. It is a second per-request call
 * taking the first one's output.
 *
 * `AttributableRequest` is that input, and it is deliberately not a shape
 * written out here. It is `Extract<Admission, { admitted: true }>` — the
 * admitted branch itself. Add a field to admission and this module sees it;
 * rename one and this file stops compiling, which is the point. A restated
 * interface would have gone on compiling while the two drifted apart.
 *
 * ── Why the widget-token gate is inside ──
 *
 * It is the one gate here, and it is here because it WRITES the state the
 * rest of the file reads: `widgetIdentity` is resolved once for the whole
 * request and then ranked by `authorFor` at rung 0. Splitting the gate from
 * the ranking would leave the field settable by anything and ranked by this
 * module, which is exactly the arrangement the precedence bug in `authorFor`
 * came out of. An invalid token 401s the whole request, so this call has two
 * outcomes and `Attribution` names them both.
 *
 * ── What is NOT here ──
 *
 * The sign-in write gate stays in `createServer`. It CONSUMES
 * `browserProvedNobody`, it does not produce it, and it guards writes rather
 * than naming authors. It still runs in its old position, below this call
 * and above every route, for the reason its own comment gives.
 */
import { type User, isEmailLike } from '@feedback/core';
import { Identities, type IdentityRecord, userForIdentity } from './identities.ts';
import { isBrowserRequest } from './middleware/write-gate.ts';
import type { Admission } from './request-admission.ts';
import { sanitizeVisitorAuthor } from './share/visitor-identity.ts';
import { AUTHOR_REQUIRED_ERROR, AUTHOR_REQUIRED_MESSAGE } from './task-owner.ts';
import { type TaskStore, taskChip } from './tasks.ts';

/**
 * What attribution needs from the request, which is exactly what admission
 * proved about it.
 *
 * Imported rather than restated on purpose — see the note at the top. This
 * module reads three of its fields (`visitor`, `visitorShareId`,
 * `accessEmail`); it takes the whole admitted branch so that a change to
 * what admission proves is a compile error here rather than a silent drift.
 */
export type AttributableRequest = Extract<Admission, { admitted: true }>;

/** What attribution reads. Every member is long-lived; the request and what
 *  admission proved about it arrive per call. */
export interface RequestAttributionContext {
  /** The fleet address book — people and agents. Read to resolve a proven
   *  identity, and written when a roster agent teaches it its own name. */
  identities: Identities;
  /** The boards, for the task chips a thread payload is decorated with. */
  taskStore: TaskStore;
  /** The session cookie's identity, or null. One of the two proofs
   *  `provenIdentityFor` ranks; the other is the Access email admission
   *  already verified. */
  sessionIdentityFor: (req: Request) => IdentityRecord | null;
  /** The widget popup-token presented on this request, if any. */
  widgetBearerOf: (req: Request) => string | null;
  /** That token resolved against the origin it is bound to. Null means the
   *  token is invalid, which refuses the whole request. */
  widgetTokenIdentityFor: (token: string, origin: string | null) => IdentityRecord | null;
  /** The JSON responder, so a refusal here is spelled as a route's. */
  j: (status: number, body: unknown) => Response;
}

/**
 * Everything a route needs to name an author, or the refusal that means the
 * request never gets to name one.
 *
 * The union is A17's shape, for A17's reason: `attributed: false` carries no
 * attribution helpers at all, so no route can resolve an author on a request
 * whose widget token was rejected. That is a compile error rather than a
 * review note.
 */
export type Attribution =
  | { attributed: false; response: Response }
  | {
      attributed: true;
      /** The identity a widget popup-token proved, or null when none was
       *  presented. Handed back because `routes/auth-share.ts` reads it too:
       *  it is resolved once for the whole request, and a second resolution
       *  there would be a second chance to disagree with `authorFor`. */
      widgetIdentity: IdentityRecord | null;
      /** The identity this request has proven, resolved at most once. */
      provenIdentityFor: () => IdentityRecord | null;
      /** The author to attribute a write to, given what the body claimed. */
      authorFor: (claimed: unknown) => User | undefined;
      /** The 400 every comment route answers the shared category with. */
      refuseCategoryAuthor: () => Response;
      /** A thread payload decorated with the tasks that reference it. */
      withTaskChips: <T extends { id: string }>(docId: string, t: T) => T;
      /** True when this request comes from a browser that has proven nobody. */
      browserProvedNobody: () => boolean;
    };

export interface RequestAttribution {
  attributeRequest: (req: Request, admitted: AttributableRequest) => Attribution;
}

export function createRequestAttribution(ctx: RequestAttributionContext): RequestAttribution {
  const { identities, taskStore, sessionIdentityFor, widgetBearerOf, widgetTokenIdentityFor, j } =
    ctx;

  const attributeRequest = (req: Request, admitted: AttributableRequest): Attribution => {
    // Read up front rather than closed over from a later `const`, which is
    // what these helpers did inside `fetch`: they were declared above the
    // gate call and read consts declared below them, safe only because
    // nothing called them until after admission had run. Taking the values
    // as an argument removes that ordering dependency without changing a
    // single value any of them sees.
    const { visitor, visitorShareId } = admitted;
    const { accessEmail } = admitted;

    /**
     * The identity this request has PROVEN, resolved at most once.
     *
     * Lazy because most requests never ask, and memoized because a write
     * route can call `authorFor` more than once and each call would
     * otherwise re-verify an HMAC.
     */
    let provenIdentity: IdentityRecord | null | undefined;
    const provenIdentityFor = (): IdentityRecord | null => {
      if (provenIdentity !== undefined) return provenIdentity;
      // Cloudflare Access first. It has already verified a signed claim
      // from an identity provider, which is a STRONGER proof than a code
      // we mailed — so an Access visitor skips the code entirely and
      // mints the same `user-<hash>` the code path would have. Composing
      // here rather than building a second verifier is the whole point:
      // the email was already being extracted (cf-access.ts) and thrown
      // away after authorizing, so the person stayed anonymous on a
      // surface that knew exactly who they were.
      if (accessEmail && isEmailLike(accessEmail)) {
        const rec = identities.upsertByEmail(accessEmail);
        provenIdentity = rec.status === 'active' ? rec : null;
        return provenIdentity;
      }
      provenIdentity = sessionIdentityFor(req);
      return provenIdentity;
    };

    /**
     * The author to attribute a write to.
     *
     * Until this commit the tailnet body was simply trusted — the comment
     * here said so — which meant `?as=bryan` on any URL minted
     * `known-bryan`, and `kind: 'known'` only ever meant "typed a name".
     * Now, when a request carries a VERIFIED session, the server's own
     * verdict outranks whatever the body claims. A caller may still say
     * who they are; they no longer get to say it about someone else.
     *
     * Order matters and each rung has a reason:
     *
     *  1. A proven identity. It outranks the body precisely because the
     *     body is the thing it exists to stop being authoritative — and
     *     it does so whether or not `CW_REQUIRE_EMAIL_AUTH` is on: the
     *     flag governs whether a session is REQUIRED, never whether a
     *     verified one is believed (Bryan, 2026-08-29 — a verified name
     *     is never worse than a typed one).
     *  2. A share visitor with nothing proven stays a `guest-` — that
     *     path is the template this work copies, not a thing it replaces.
     *     Since every share host sits behind Cloudflare Access, a visitor
     *     reaching this rung is a deployment with no verifier wired, not a
     *     normal anonymous reviewer.
     *  3. Otherwise the claimed body, exactly as today. This is the rung
     *     every agent, every MCP call and every un-authenticated browser
     *     lands on, so a request with no session behaves identically
     *     whichever way the flag is set.
     *
     * With no session presented, this function is byte-for-byte what it
     * was whichever way the flag is set.
     */
    const authorFor = (claimed: unknown): User | undefined => {
      /**
       * Rung -1, and it exists ONLY on a share surface: the identity the
       * boundary itself proved outranks a widget popup-token.
       *
       * Everywhere else rung 0 below is right — a token is a stronger
       * proof than a cookie for the page that holds it. On a share or
       * collaboration host it is not, because there the Access email is
       * what the member gate just decided the whole request on, and a
       * token is an `Authorization` header. Ranking the header first let
       * a request choose which of two proven identities to be written
       * down as, which is the "no writing as someone else" half of the
       * member boundary and is what `docs/architecture/security.md`
       * claims outright ("Every write is attributed to the email
       * Cloudflare confirmed").
       *
       * A token is bound to one page origin, so this is reachable by a
       * non-browser client that sets `Origin` by hand rather than by a
       * page; it stays a precedence bug either way, and the fix is that
       * the two proofs cannot disagree about a member.
       */
      if (visitor) {
        const provenHere = provenIdentityFor();
        if (provenHere) return userForIdentity(provenHere);
      }
      // Rung 0: a verified widget popup-token. NOT behind the flag,
      // unlike the cookie rung — no request carries this header by
      // accident, so presenting the token is itself the opt-in, and the
      // whole point of the handshake is attribution on a surface the
      // cookie can never reach. An invalid token never lands here: the
      // gate below 401s it before any route runs.
      if (widgetIdentity) return userForIdentity(widgetIdentity);
      const proven = provenIdentityFor();
      if (proven) return userForIdentity(proven);
      if (visitor) {
        return sanitizeVisitorAuthor(claimed, {
          // The SHARE, not the doc: two links to the same doc are two
          // different audiences, and seeding from the doc id would give a
          // returning browser the same guest identity on both — attributing
          // comments on a freshly minted link to the old one's visitor.
          // The `?? ''` is unreachable: the guard refuses a target with
          // no workspaceId, so a visitor always has one. Typed optional
          // there so an old doc-only shape is refused at runtime rather
          // than only at compile time.
          shareKey: visitorShareId ?? visitor.workspaceId ?? '',
        });
      }
      return stampRosterAgent(claimed as User | undefined);
    };

    /** The 400 every comment route answers the shared category with.
     *  One message, the same fix named, so a peer launched without a
     *  name learns it from the first refusal rather than from silence. */
    const refuseCategoryAuthor = (): Response =>
      j(400, { error: AUTHOR_REQUIRED_ERROR, message: AUTHOR_REQUIRED_MESSAGE });

    /**
     * A write signed by a roster AGENT is stamped with the roster's
     * name and canonical id — the board's record of who holds the seat
     * names the lead, not the launch env of whichever process happened
     * to sign. Mirrors `userForIdentity` for people. An author the
     * roster does not know (a person's typed name, an old bundle's id
     * nothing attached under) passes through exactly as claimed.
     */
    const stampRosterAgent = (claimed: User | undefined): User | undefined => {
      if (!claimed || typeof claimed !== 'object' || typeof claimed.id !== 'string') {
        return claimed;
      }
      const rec = identities.get(claimed.id);
      if (!rec || rec.kind !== 'agent') return claimed;
      // A row written by an older bundle's attach carries no name — its
      // display name is its id. The claim on THIS write is the launch
      // env's name, which is exactly the source the roster wants, so
      // learn it here rather than overwrite a real name with an id.
      const claimedName = typeof claimed.name === 'string' ? claimed.name.trim() : '';
      if (rec.displayName === rec.id && claimedName && claimedName !== rec.id) {
        const learned = identities.upsertAgent(rec.id, claimedName);
        return { ...claimed, id: rec.id, name: learned?.displayName ?? claimedName };
      }
      return { ...claimed, id: rec.id, name: rec.displayName };
    };

    /**
     * Thread→task surfacing (§3.12 commit 4): decorate a thread payload
     * with chips for the tasks that reference it — via `links` or via a
     * promotion `origin`. The chip is the §3.3 rule-2 visitor-safe shape,
     * so visitors get the decoration too. Omitted when empty (trimmed
     * results, §3.10) — every reader treats a missing `tasks` as none.
     */
    const withTaskChips = <T extends { id: string }>(docId: string, t: T): T => {
      const chips = taskStore
        .tasksReferencingThread(docId, t.id)
        // `tasksReferencingThread` spans every workspace, deliberately —
        // a ref may cross a board. For a caller scoped to ONE board that
        // span is a read of a board they were never given: a private
        // row's title, status and assignee, arriving through a thread on
        // a doc they ARE allowed to open. The same filter, for the same
        // reason and in the same words, as `GET /api/tasks/<id>/links`.
        .filter((task) => !visitor || task.workspaceId === visitor.workspaceId)
        .map(taskChip);
      return chips.length > 0 ? { ...t, tasks: chips } : t;
    };

    /**
     * The identity a widget popup-token proved, resolved once below the
     * host gate and read by `authorFor` (rung 0). Stays null when no
     * token was presented; a presented-but-invalid token never gets this
     * far — the gate answers 401 for the whole request.
     */
    let widgetIdentity: IdentityRecord | null = null;

    // The one gate in this file, kept in the position it held and answering
    // exactly as it did. `null` out of the wrapper means no token was
    // presented or the one presented resolved, which is the only way past.
    const refused = ((): Response | null => {
      // --- Widget popup-token gate ---
      // Resolve a presented token ONCE for the whole request, and fail
      // loudly: an invalid token 401s rather than silently downgrading the
      // write to anonymous — the widget hears "signed out" on the request
      // that proved it, not never. Runs below the host gate so a share
      // visitor's request is already scoped; runs above every route so no
      // write path can forget the check.
      {
        const rawWidgetToken = widgetBearerOf(req);
        if (rawWidgetToken !== null) {
          widgetIdentity = widgetTokenIdentityFor(rawWidgetToken, req.headers.get('origin'));
          if (widgetIdentity === null) return j(401, { error: 'widget_token_invalid' });
        }
      }
      return null;
    })();
    if (refused) return { attributed: false, response: refused };

    /**
     * `true` when this request comes from a browser that has proven
     * nobody. The three proofs, in the order `authorFor` ranks them: a
     * widget popup-token, a Cloudflare Access claim, a session cookie —
     * the last two both resolved by `provenIdentityFor`.
     *
     * Shared by the write gate below and by the `/y/` upgrade, which is
     * the one write surface that is not an HTTP write: a markdown doc's
     * prose is edited over the websocket, so a gate that only looked at
     * methods would refuse the comment and wave the edit through.
     */
    const browserProvedNobody = (): boolean =>
      isBrowserRequest(req.headers) && widgetIdentity === null && provenIdentityFor() === null;

    return {
      attributed: true,
      widgetIdentity,
      provenIdentityFor,
      authorFor,
      refuseCategoryAuthor,
      withTaskChips,
      browserProvedNobody,
    };
  };

  return { attributeRequest };
}
