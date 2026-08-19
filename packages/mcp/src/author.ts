import { type EnvLike, readRenamedEnv } from '../../core/src/env-names.ts';
import { agentIdForName, hashToColor, knownUserForName } from '../../core/src/identity.ts';

export interface AgentAuthor {
  name: string;
  color: string;
  id: string;
  kind: 'known' | 'anon';
}

/**
 * Resolve this MCP process's author identity from env.
 *
 * `CW_AGENT_NAME` (set per-peer in the agent's own environment) wins over
 * `CW_AUTHOR`, because the plugin's `.mcp.json` pins `CW_AUTHOR=agent` for
 * every peer — without the override var, all agents in a fleet collapse into
 * one shared "Agent" identity. Any name that isn't a known user synthesizes a
 * stable identity: same name → same id and color everywhere, so attribution
 * matches across docs and sessions.
 *
 * Both variables are read through `readRenamedEnv`, so the pre-rename
 * `FEEDBACK_AGENT_NAME` / `FEEDBACK_AUTHOR` keep working. That fallback
 * matters more here than anywhere else: these are read ONCE from the
 * session's launch environment, so a peer whose launcher config the rollout
 * sweep missed cannot pick up the new name without a full restart — and the
 * failure would be silent, collapsing that agent into the shared "agent"
 * identity the override exists to prevent.
 */
export function resolveAgentAuthor(env: EnvLike): AgentAuthor {
  const name =
    readRenamedEnv(env, 'CW_AGENT_NAME')?.trim() ||
    readRenamedEnv(env, 'CW_AUTHOR')?.trim() ||
    'agent';
  const known = knownUserForName(name);
  if (known) return known;
  // `agentIdForName` is the single derivation — the board matches a task's
  // owner against the agent roster with the same function, and two spellings
  // of it drift into a roster that silently never matches.
  return { name, color: hashToColor(name), id: agentIdForName(name), kind: 'known' };
}
