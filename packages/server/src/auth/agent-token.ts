/**
 * Proof that a caller IS the agent whose feed it is asking for.
 *
 * Two routes are keyed on an agent id rather than on a doc or a board:
 * `GET /api/agents/<id>/watches` (the durable watch set) and
 * `GET /events/agent/<id>` (the multiplexed stream that fans that set out).
 * Both were gated on one thing only -- not being a share visitor -- and an
 * agent id is `agentIdForName(name)`, a pure hash of a name that is written
 * on the board in plain sight. So knowing a peer's NAME was enough to derive
 * their id, and knowing their id was enough to open their whole feed: every
 * comment, every task event, every board they watch, on one socket, without
 * knowing a single doc id.
 *
 * This module is the whole answer, and it is deliberately two layers,
 * because they close different doors and only one of them needs a client
 * change.
 *
 * ## Layer 1: the caller's SHAPE. No client change, closes today.
 *
 * The only legitimate caller of either route is the MCP child Claude Code
 * spawns per session. That process is always three things at once: it talks
 * to loopback, it is not a browser, and it did not come through the edge.
 * So the three refusals the agent-merge route already carries apply here
 * unchanged, and for the same reasons spelled out there:
 *
 * - **Not through the edge.** cloudflared runs on this box, so a tunnelled
 *   request also has a loopback peer address; only `cf-ray` says it crossed.
 * - **Loopback peer address**, on the SOCKET rather than the Host header,
 *   which is client-controlled. This is what shuts the tailnet out.
 * - **Not a browser.** A page served from this machine also has a loopback
 *   peer address and rides the owner's session cookie, so without this a dev
 *   server on another local port could read any agent's feed with a single
 *   `fetch`. This is the largest of the three doors.
 *
 * Every MCP child on every shipped bundle already satisfies all three, so
 * this layer costs no rollout and is enforced unconditionally.
 *
 * ## Layer 2: WHICH agent. Needs a client change, so it rolls out.
 *
 * Layer 1 still lets one local non-browser process read another's feed, and
 * the requirement is that the caller prove it is that agent. There was
 * nothing to build that proof on: `packages/mcp/src/http-client.ts` sends
 * `content-type` and nothing else -- the MCP child holds no session token
 * today -- and its id is a hash of a public name. So this adds one: an `at1`
 * bearer, minted at `GET /api/agents/<id>/token` behind the Layer 1 gate and
 * presented as `Authorization: Bearer at1.<agentId>.<mac>` on both routes.
 * Stateless: nothing is stored, the MAC is the whole record, and rotating the
 * key file on disk revokes every token at once.
 *
 * **What it is honestly worth.** The mint route is behind the same gate as
 * the routes it unlocks, so a local non-browser process can still mint any
 * agent's token. That is not a hole this module could close: sessions
 * running as one OS user share a single trust zone, which is what
 * `.claude/rules/security-posture.md` says in as many words. The proof is
 * worth exactly this much -- it closes the browser, the edge and the tailnet
 * outright at Layer 1, it makes a WRONG token a refusal rather than a silent
 * cross-agent read, and it is the hook `requireAgentTokenForStreams` hangs
 * on once the fleet is past the deprecation window. It is not claimed to be
 * more.
 *
 * ## No expiry, on purpose
 *
 * `expiresAt` answers null. The MCP child holds this for the life of a
 * session -- sometimes days -- and the stream loop has no re-mint path, so a
 * TTL would end the fleet's event delivery mid-session, which is precisely
 * the failure `/events/agent/` was built to end. The session cookie makes
 * the same call for the same reason; `auth/widget-token.ts` is the format
 * that DOES expire, and says there why it differs. Revocation here is key
 * rotation.
 */
import { isLoopbackAddress } from '../middleware/host-guard.ts';
import { isBrowserRequest } from '../middleware/write-gate.ts';
import { type TokenFormat, mintToken, tokenClaims, tokenKey } from './signed-token.ts';

const VERSION = 'at1';

export interface AgentTokenClaims {
  /** The one agent id this token speaks for. */
  agentId: string;
}

/**
 * `at1.<agentId>.<mac>`.
 *
 * An agent id is `[a-z0-9-]` (see `isValidAgentId`), so it never contains a
 * dot and the payload splits cleanly into two fields.
 */
export const agentToken: TokenFormat<AgentTokenClaims> = {
  keyDomain: 'cw-agent-token-v1',
  tags: [VERSION],
  encode: (claims) => [VERSION, claims.agentId].join('.'),
  decode(payload) {
    const parts = payload.split('.');
    if (parts.length !== 2) return null;
    const [version, agentId] = parts;
    if (version !== VERSION || !agentId) return null;
    return { agentId };
  },
  // See the header: no time-based expiry. Key rotation is the revocation.
  expiresAt: () => null,
};

/** The agent-token key, derived from the shared cookie key under its own
 *  domain so no other protocol's value can ever verify as one of these. */
export function agentTokenKey(cookieKey: string): string {
  return tokenKey(cookieKey, agentToken);
}

/** A bearer for one agent id. Idempotent -- the same id always mints the
 *  same bytes under the same key, so a re-mint costs nothing and invalidates
 *  nothing. */
export function mintAgentToken(agentId: string, key: string): string {
  return mintToken(agentToken, { agentId }, key);
}

/** The claims a value attests to, or null. */
export function verifyAgentToken(
  value: string | undefined | null,
  key: string,
): AgentTokenClaims | null {
  return tokenClaims(agentToken, value, key);
}

/** The `at1` bearer this request carries, or undefined. Shape-matched the
 *  way `widgetBearerOf` is, so a bearer for another protocol is never even
 *  offered to this verifier. */
export function agentBearerOf(headers: Headers): string | undefined {
  const raw = headers.get('authorization');
  const m = raw?.match(/^Bearer\s+(at1\.[^\s]+)$/i);
  return m ? m[1] : undefined;
}

/** How a caller was allowed, or why it was refused. `legacy` is the
 *  deprecation window: allowed, but only because nothing was presented and
 *  enforcement is still off. */
export type AgentCallerVerdict =
  | { ok: true; proof: 'token' }
  | { ok: true; proof: 'legacy' }
  | { ok: false; status: number; body: { error: string; message: string } };

export interface AgentCallerCheck {
  /** The agent id in the path -- the identity being claimed. */
  agentId: string;
  /** The request, for its headers. */
  req: Request;
  /** The request's SOCKET peer address, never a header. */
  address: string | undefined;
  /** The verification key, from `agentTokenKey`. */
  key: string;
  /**
   * Whether a token is REQUIRED. False during the deprecation window, when a
   * caller presenting nothing is allowed through with a logged warning. A
   * caller presenting a token is checked either way: a wrong token is always
   * a refusal, never a fall-back onto the legacy path.
   */
  requireToken: boolean;
}

/**
 * The one policy both routes run.
 *
 * Written once so the two cannot drift: a gate added to the stream and
 * forgotten on the REST route would leave the same feed readable through the
 * other door, and the watch set is how you learn which keys the stream will
 * carry.
 */
export function authorizeAgentCaller({
  agentId,
  req,
  address,
  key,
  requireToken,
}: AgentCallerCheck): AgentCallerVerdict {
  // Shape refusals first, so a caller that could never be an agent learns
  // nothing about the token grammar from a value it could not have signed.
  if (req.headers.has('cf-ray')) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'agent-stream-proxied',
        message:
          "An agent's watch set and event stream are local to the machine that agent runs on; they are never served through the edge.",
      },
    };
  }
  if (!isLoopbackAddress(address)) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'agent-stream-remote',
        message:
          "An agent's watch set and event stream are served to that agent's own process on this machine (loopback only).",
      },
    };
  }
  if (isBrowserRequest(req.headers)) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'agent-stream-browser',
        message:
          "An agent's event stream is not a page's to read: a page on this machine rides the owner's session, and this feed is every board that agent watches.",
      },
    };
  }
  const bearer = agentBearerOf(req.headers);
  if (bearer !== undefined) {
    const claims = verifyAgentToken(bearer, key);
    // A token that does not verify and a token that verifies for SOMEBODY
    // ELSE are the same refusal: the caller does not get to learn which.
    if (!claims || claims.agentId !== agentId) {
      return {
        ok: false,
        status: 403,
        body: {
          error: 'agent-token-mismatch',
          message: `This token does not speak for ${agentId}. Mint one with GET /api/agents/${agentId}/token.`,
        },
      };
    }
    return { ok: true, proof: 'token' };
  }
  if (requireToken) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'agent-token-required',
        message: `Present an agent token for ${agentId}: GET /api/agents/${agentId}/token, then Authorization: Bearer <token>.`,
      },
    };
  }
  return { ok: true, proof: 'legacy' };
}

/**
 * The deprecation-window warning, at most once per agent id per route per
 * process.
 *
 * Once, because this fires on the restore path every respawned child takes
 * and on every stream reconnect. A line per event would bury the log it is
 * meant to make readable, and the news -- this session is on a bundle that
 * predates the token -- does not change between two calls.
 */
export function createLegacyAgentWarner(
  log: (message: string) => void = (m) => console.warn(m),
): (agentId: string, route: string) => void {
  const seen = new Set<string>();
  return (agentId, route) => {
    const key = `${agentId} ${route}`;
    if (seen.has(key)) return;
    seen.add(key);
    log(
      `[claude-workspaces] ${route} served to ${agentId} with no agent token -- ` +
        'this session is on a bundle that predates agent-stream auth. It keeps working ' +
        'through the deprecation window; set CW_REQUIRE_AGENT_TOKEN=1 to refuse it once the fleet has updated.',
    );
  };
}
