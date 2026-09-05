/**
 * The two routes keyed on an AGENT ID rather than on a doc or a board:
 * the durable watch set, and the merge that folds one agent id into another.
 *
 * One family because both are written in terms of the same identity — the
 * watch set is keyed by agent id, and the merge is the verb that moves it,
 * along with the roster row, the lead seats and the attachment records. A
 * merge that re-keyed the roster without re-keying the watches would leave
 * an agent's deliveries stranded on the old id, so the two live together and
 * the merge's re-key sits beside the list it moves.
 *
 * Lifted verbatim out of `createServer`'s request closure, keeping the chain
 * position it had: after the goal / promote routes, before the builder
 * dispatch block. Dependencies arrive in an explicit context rather than
 * captured from the closure, following `task-routes-context.ts`.
 */
import type { User } from '@feedback/core';
import {
  type AgentWatches,
  SHARED_AGENT_IDS,
  SHARED_IDENTITY_ERROR,
  SHARED_IDENTITY_MESSAGE,
  isValidAgentId,
  isValidWatchKey,
} from '../agent-watches.ts';
import { authorizeAgentCaller, mintAgentToken } from '../auth/agent-token.ts';
import type { Identities } from '../identities.ts';
import type { ShareTarget } from '../middleware/host-guard.ts';
import { isLoopbackAddress } from '../middleware/host-guard.ts';
import { browserCannotOperateBody, isBrowserRequest } from '../middleware/write-gate.ts';
import type { TaskStore } from '../tasks.ts';

/** The long-lived collaborators these two routes need. */
export interface AgentIdentityRoutesContext {
  /** The durable watch set, per agent identity. */
  agentWatches: AgentWatches;
  /** The roster a merge folds one row into another in. */
  identities: Identities;
  /** The hub store — a merge moves its lead seats, attachments and comments. */
  taskStore: TaskStore;

  /** JSON response helper — status plus body, no CORS (the per-request
   *  wrapper in createServer adds that, because it knows the Origin). */
  j: (status: number, body: unknown) => Response;
  /** Parse a request body, answering null rather than throwing. */
  safeJson: (req: Request) => Promise<Record<string, unknown> | null>;
  /** The request's SOCKET address — not a header, which is the whole point
   *  of the merge route's loopback check. Same shape `ops.ts` uses. */
  requestAddress: (req: Request) => string | undefined;

  /** Whether a watch key still names something on this server. */
  watchKeyExists: (key: string) => boolean;
  /** What the agent's watch set actually covers. Typed loosely because the
   *  route hands it straight to `j`; the shape is `WatchCoverage` in
   *  server.ts, and naming it here would import back out of this package's
   *  entry point into a module it imports. */
  watchCoverageFor: (agentId: string, keys: string[]) => unknown;
  /** A doc's own id, whichever spelling it was addressed by. */
  canonicalDocId: (addressed: string) => string;

  /** The key the `at1` agent bearer is minted and verified under. A thunk
   *  because the key file is read lazily, the way every other derived key on
   *  this server is. See auth/agent-token.ts. */
  agentTokenKey: () => string;
  /** Whether the watch set and the agent stream REFUSE a caller that
   *  presents no token. Off during the deprecation window: a session on a
   *  bundle that predates the token keeps working, with one logged warning.
   *  `CW_REQUIRE_AGENT_TOKEN` is the deployment switch. */
  requireAgentToken: boolean;
  /** Logs that warning, at most once per agent id per route. */
  warnLegacyAgentCaller: (agentId: string, route: string) => void;
}

/** What only this request knows. */
export interface AgentIdentityRouteRequest {
  req: Request;
  pathname: string;
  /** The share target this request resolved to, or null for a member. */
  visitor: ShareTarget | null;
  /** The author this request is allowed to claim. */
  authorFor: (claimed: unknown) => User | undefined;
}

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleAgentIdentityRoutes(
  ctx: AgentIdentityRoutesContext,
  rq: AgentIdentityRouteRequest,
): Promise<Response | undefined> {
  const {
    agentWatches,
    identities,
    taskStore,
    j,
    safeJson,
    requestAddress,
    watchKeyExists,
    watchCoverageFor,
    canonicalDocId,
    agentTokenKey,
    requireAgentToken,
    warnLegacyAgentCaller,
  } = ctx;
  const { req, pathname, visitor, authorFor } = rq;

  // --- REST: mint this agent's stream bearer ---
  //
  // The one place an `at1` token comes from. Behind the SAME shape gate as
  // the routes it unlocks (loopback peer, no `cf-ray`, not a browser), which
  // is the honest boundary this machine has: an agent's own MCP child can
  // ask for its token without a secret it was never given, and nothing off
  // the box or inside a page can ask at all. auth/agent-token.ts spells out
  // what that is worth and what it is not.
  //
  // Stateless and idempotent: the token is an HMAC over the id, so this
  // route stores nothing, a re-mint returns the same bytes, and rotating the
  // key file revokes every token that was ever handed out.
  const agentTokenMatch = pathname.match(/^\/api\/agents\/([^/]+)\/token$/);
  if (agentTokenMatch && req.method === 'GET') {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    const agentId = decodeURIComponent(agentTokenMatch[1] ?? '');
    if (!isValidAgentId(agentId)) return j(400, { error: 'bad agentId' });
    if (SHARED_AGENT_IDS.has(agentId)) {
      // The shared id is every anonymous session at once, so a token over it
      // would be a token every one of them holds. Those sessions keep the
      // per-key routes, which is where they already are.
      return j(400, { error: SHARED_IDENTITY_ERROR, message: SHARED_IDENTITY_MESSAGE });
    }
    // `requireToken: false` — a caller asking for its FIRST token obviously
    // has none. The shape refusals above are what gate this route; the
    // bearer branch only ever fires if a caller sent one anyway, and then a
    // wrong one is still refused.
    const allowed = authorizeAgentCaller({
      agentId,
      req,
      address: requestAddress(req),
      key: agentTokenKey(),
      requireToken: false,
    });
    if (!allowed.ok) return j(allowed.status, allowed.body);
    return j(200, { agentId, token: mintAgentToken(agentId, agentTokenKey()) });
  }

  // --- REST: durable agent watches ---
  // The MCP child's watch set, remembered here per agent identity so a
  // respawned child can ask for it back. The server never opens the
  // streams — it holds the list. GET is the restore path (prunes keys
  // whose doc is gone and says so); POST unions `add` / deletes
  // `remove`, never replaces, so two live sessions sharing one name
  // cannot clobber each other. See agent-watches.ts.
  const agentWatchesMatch = pathname.match(/^\/api\/agents\/([^/]+)\/watches$/);
  if (agentWatchesMatch) {
    // Same defense-in-depth posture as the plugin routes below: a share
    // host never reaches here today (`shareScopeAllows` is a closed
    // allowlist), and this keeps a later allowlisting from exposing one
    // agent's subscription list to an external reviewer.
    if (visitor) return j(403, { error: 'not available to share visitors' });
    const agentId = decodeURIComponent(agentWatchesMatch[1] ?? '');
    if (!isValidAgentId(agentId)) return j(400, { error: 'bad agentId' });
    if (SHARED_AGENT_IDS.has(agentId)) {
      return j(400, { error: SHARED_IDENTITY_ERROR, message: SHARED_IDENTITY_MESSAGE });
    }
    // Prove it is that agent. This list IS the feed's index — it names every
    // key `/events/agent/<id>` will carry — so it is gated identically to the
    // stream, and by the same function, so the two cannot drift apart.
    const allowed = authorizeAgentCaller({
      agentId,
      req,
      address: requestAddress(req),
      key: agentTokenKey(),
      requireToken: requireAgentToken,
    });
    if (!allowed.ok) return j(allowed.status, allowed.body);
    if (allowed.proof === 'legacy') warnLegacyAgentCaller(agentId, '/api/agents/<id>/watches');
    if (req.method === 'GET') {
      const listed = agentWatches.list(agentId, watchKeyExists);
      // ADDITIVE. `coverage` is a new key on an existing 200 body, so a
      // bundle built before it ignores it and behaves exactly as it did
      // — which matters here specifically because this is the restore
      // path every respawned child calls before it can do anything else.
      return j(200, {
        ...listed,
        coverage: watchCoverageFor(
          agentId,
          listed.watches.map((w) => w.key),
        ),
      });
    }
    if (req.method === 'POST') {
      const body = await safeJson(req);
      const rawAdd = Array.isArray(body?.add) ? (body?.add as unknown[]) : [];
      const rawRemove = Array.isArray(body?.remove) ? (body?.remove as unknown[]) : [];
      const badKey = [...rawAdd, ...rawRemove].find((k) => !isValidWatchKey(k));
      if (badKey !== undefined) {
        return j(400, { error: 'bad watch key', key: String(badKey) });
      }
      const name = typeof body?.name === 'string' ? body.name : undefined;
      // Store the doc's own id, whichever spelling the caller watched
      // by. A watch is DURABLE and its key is matched against board
      // membership to answer "is this agent covering that board" — so a
      // key stored as a readable alias would leave the board looking
      // unwatched, which is the alarm going quiet rather than the alarm
      // saying no. `ws:` keys resolve to themselves and pass through.
      const canonicalKeys = (keys: unknown[]): string[] =>
        (keys as string[]).map((k) => canonicalDocId(k));
      const res = agentWatches.update(agentId, {
        add: canonicalKeys(rawAdd),
        // Removal accepts either spelling for the same reason a read
        // does: the caller may only ever have held the readable one.
        remove: canonicalKeys(rawRemove),
        ...(name ? { name } : {}),
      });
      return j(200, res);
    }
    return j(405, { error: 'method not allowed' });
  }
  // Fold one agent id into another — the rename verb. The roster
  // records the merge (old ids resolve forever), every board the old
  // id led hands its seat over, the attachment records re-key, and
  // the durable watch set moves so deliveries follow the new id.
  // `dryRun` answers what WOULD move and touches nothing. Never
  // rewrites activity.jsonl or a ydoc: history resolves at read.
  const agentMergeMatch = pathname.match(/^\/api\/agents\/([^/]+)\/merge$/);
  if (agentMergeMatch && req.method === 'POST') {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    // Loopback only, on the PEER ADDRESS — the deploy route's gate and
    // its reasoning (the Host header is client-controlled). A merge
    // moves lead seats and re-keys an agent's deliveries fleet-wide;
    // that is an operator action run from the box, not something any
    // tailnet client should be able to do to a board it can see.
    if (!isLoopbackAddress(requestAddress(req))) {
      return j(403, {
        error:
          'agent merges must be run from this machine (loopback only) — a merge moves lead seats and re-keys deliveries',
      });
    }
    // The same two refusals the deploy and plugin-refresh routes
    // carry (routes/ops.ts), for the same reasons: cloudflared runs
    // on this box, so a tunnelled request also has a loopback peer
    // address and only `cf-ray` says it crossed the edge; and a
    // page served from this machine also has a loopback peer
    // address and rides the owner's session cookie — see
    // browserCannotOperateBody. (Security review pass 3, 2026-09-02.)
    if (req.headers.has('cf-ray')) {
      return j(403, {
        error:
          'agent merges cannot be run through the edge (proxied request) — run them from the box',
      });
    }
    if (isBrowserRequest(req.headers)) return j(403, browserCannotOperateBody());
    const from = decodeURIComponent(agentMergeMatch[1] ?? '');
    const body = await safeJson(req);
    const into = typeof body?.into === 'string' ? body.into.trim() : '';
    if (!isValidAgentId(from) || !isValidAgentId(into)) {
      return j(400, { error: 'bad agentId', message: 'both ids must be agent ids' });
    }
    if (from === into) return j(400, { error: 'self-merge' });
    if (SHARED_AGENT_IDS.has(into)) {
      return j(400, { error: SHARED_IDENTITY_ERROR, message: SHARED_IDENTITY_MESSAGE });
    }
    const dryRun = body?.dryRun === true;
    const actor = authorFor(body?.author) ?? { id: into, name: into, kind: 'known' };
    // The roster half is skipped for the SHARED id on purpose: the
    // seat and attachments move (a board led by "Agent" gets a real
    // lead), but the old comments signed by it stay unattributed —
    // there is no proof who wrote them.
    const fromShared = SHARED_AGENT_IDS.has(from);
    // A `from` that resolves to a PERSON — `known-bryan`, the owner's
    // own id, an anon id the link file folded — is refused on the dry
    // run too, so the report never promises a fold the write refuses.
    const fromResolved = identities.get(from);
    if (fromResolved && fromResolved.kind !== 'agent') {
      return j(400, {
        error: 'from-not-agent',
        message: `${from} resolves to a person (${fromResolved.id}); only agent ids merge`,
      });
    }
    let roster: { folded: boolean; mergedFrom: string[] } = { folded: false, mergedFrom: [] };
    if (!fromShared) {
      // `get` follows `mergedInto`, which is right for a reader and
      // wrong for this writer. On a MERGE-BACK — the reversal
      // `mergeAgent` documents — `into` was folded into `from` by an
      // earlier merge, so the resolved row IS `from`, and the fold
      // came back as `self-merge` with the seat, the watch and the
      // deliveries stranded on the wrong id. The caller means the id
      // it named: take the raw row whenever resolution lands on
      // `from`. Everything downstream (`taskStore.mergeAgent`,
      // `agentWatches.rekey`) already works on the raw ids.
      const resolved = identities.get(into);
      const target =
        resolved && resolved.id !== from
          ? resolved
          : (identities.rawAgent(into) ?? identities.upsertAgent(into));
      if (!target || target.kind !== 'agent') {
        return j(400, { error: 'into-not-agent', message: `${into} is not an agent` });
      }
      if (!dryRun) {
        const merged = identities.mergeAgent(from, target.id);
        if (!merged.ok) return j(400, { error: merged.error });
        roster = { folded: true, mergedFrom: merged.into.mergedFrom };
      } else {
        // The set the write WOULD leave, computed the way `mergeAgent`
        // computes it — the target's ids, the source's, and `from`
        // itself, minus the target. A dry run that reports a different
        // fold than the write is worse than no dry run: on a
        // merge-back it named the old survivor as still folded in.
        const folded = new Set<string>([
          ...target.mergedFrom,
          from,
          ...(identities.rawAgent(from)?.mergedFrom ?? []),
        ]);
        folded.delete(target.id);
        roster = { folded: true, mergedFrom: [...folded] };
      }
    }
    const boards = taskStore.mergeAgent(from, into, { actor, dryRun });
    const watches = dryRun
      ? agentWatches.list(from, () => true).watches.map((w) => w.key)
      : agentWatches.rekey(from, into).moved;
    return j(200, {
      from,
      into,
      dryRun,
      roster,
      seats: boards.seats,
      seatsSkipped: boards.seatsSkipped,
      attachments: boards.attachments,
      comments: boards.comments,
      watches,
    });
  }
  return undefined;
}
