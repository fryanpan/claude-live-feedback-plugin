/**
 * This session's proof that it is the agent it says it is.
 *
 * `/api/agents/<id>/watches` and `/events/agent/<id>` are keyed on an agent
 * id that is `agentIdForName(name)` -- a hash of a name written on the board
 * in plain sight -- so knowing a peer's name was enough to open their whole
 * event feed. The server now wants a bearer on both, and this is the client
 * half: ask the server once for a token for THIS process's agent id, hold
 * it, and put it on every call.
 *
 * Three properties worth stating, because each one is a failure this avoids.
 *
 * 1. **Never fatal.** A server that predates the mint route answers 404, and
 *    a server on the far side of a restart may answer anything at all. Every
 *    failure here resolves to "no header", which is exactly what this client
 *    sent before -- and the server serves an un-tokened caller through its
 *    deprecation window. A token that could not be fetched must never be the
 *    reason a tool call fails.
 * 2. **Single-flight.** The first watch, the restore, and the stream open
 *    within milliseconds of each other at session start. Without this they
 *    are three mint calls racing; with it they await one.
 * 3. **Forgettable.** The token is an HMAC under a key on the server's disk,
 *    so rotating that key invalidates it. `forget()` drops the cached value
 *    on the server's own "this token does not speak for you" refusal, and
 *    the next call mints a fresh one rather than retrying a dead value for
 *    the life of the session.
 *
 * The shared identity (`known-agent`, which is what an unset `CW_AGENT_NAME`
 * resolves to) gets no token: the server refuses to mint one, because a
 * token over an id every anonymous session shares is a token all of them
 * hold. Those sessions were already outside the durable-watch and mux paths
 * for the same reason.
 */

export interface AgentTokenDeps {
  /** This session's agent id -- the identity the token speaks for. */
  agentId: string;
  /** Resolved per call, never frozen: the server may move ports. */
  resolveBaseUrl: () => string;
  /** Narrower than `typeof fetch` on purpose, matching the loops. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  log: (...args: unknown[]) => void;
  /** True when this process runs under the shared identity, which mints no
   *  token. Passed rather than re-derived so one module owns that rule. */
  identityIsShared: boolean;
}

export interface AgentTokenStore {
  /** `{ authorization }` when a token could be had, `{}` otherwise. Safe to
   *  call on every request; only the first one costs a round trip. */
  headers(): Promise<Record<string, string>>;
  /** Drop the cached token, so the next call mints again. */
  forget(): void;
  /** Whether a token is held right now. Test surface for single-flight. */
  hasToken(): boolean;
}

/** The route the token comes from. */
export function agentTokenPath(agentId: string): string {
  return `/api/agents/${encodeURIComponent(agentId)}/token`;
}

export function createAgentTokenStore(deps: AgentTokenDeps): AgentTokenStore {
  let token: string | null = null;
  /** In-flight mint, so N concurrent callers make ONE request. */
  let minting: Promise<string | null> | null = null;
  /** Set once the server has told us it has no such route. Not retried: a
   *  404 here is a server version, not a blip, and re-asking on every tool
   *  call would spend a round trip per call forever. */
  let unsupported = false;

  const mint = async (): Promise<string | null> => {
    try {
      const res = await deps.fetch(`${deps.resolveBaseUrl()}${agentTokenPath(deps.agentId)}`, {
        headers: { accept: 'application/json' },
      });
      if (res.status === 404) {
        unsupported = true;
        await res.text().catch(() => '');
        deps.log(
          '[claude-workspaces-mcp] server has no agent-token route — continuing unauthenticated (it accepts that during the rollout)',
        );
        return null;
      }
      const text = await res.text();
      if (!res.ok) {
        deps.log(`[claude-workspaces-mcp] agent token → ${res.status}: ${text}`);
        return null;
      }
      const parsed = JSON.parse(text) as { token?: unknown };
      return typeof parsed.token === 'string' && parsed.token ? parsed.token : null;
    } catch (e) {
      // The server being down is the ordinary case here, not an anomaly:
      // this client is expected to run while the supervisor restarts.
      deps.log('[claude-workspaces-mcp] agent token unavailable:', e);
      return null;
    }
  };

  return {
    hasToken: () => token !== null,
    forget: () => {
      token = null;
    },
    async headers(): Promise<Record<string, string>> {
      if (deps.identityIsShared || unsupported) return {};
      if (token !== null) return { authorization: `Bearer ${token}` };
      // Single-flight: the second caller awaits the first caller's request.
      // The cache is filled INSIDE the chain, before `finally` releases it,
      // so a caller that arrives in that window reads the token rather than
      // starting a second mint.
      minting ??= mint()
        .then((minted) => {
          if (minted !== null) token = minted;
          return minted;
        })
        .finally(() => {
          minting = null;
        });
      const minted = await minting;
      return minted === null ? {} : { authorization: `Bearer ${minted}` };
    },
  };
}
