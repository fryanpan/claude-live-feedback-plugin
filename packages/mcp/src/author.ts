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
 * `FEEDBACK_AGENT_NAME` (set per-peer in the agent's own environment) wins
 * over `FEEDBACK_AUTHOR`, because the plugin's `.mcp.json` pins
 * `FEEDBACK_AUTHOR=agent` for every peer — without the override var, all
 * agents in a fleet collapse into one shared "Agent" identity. Any name that
 * isn't a known user synthesizes a stable identity: same name → same id and
 * color everywhere, so attribution matches across docs and sessions.
 */
export function resolveAgentAuthor(env: {
  FEEDBACK_AUTHOR?: string;
  FEEDBACK_AGENT_NAME?: string;
}): AgentAuthor {
  const name = env.FEEDBACK_AGENT_NAME?.trim() || env.FEEDBACK_AUTHOR?.trim() || 'agent';
  const known = knownUserForName(name);
  if (known) return known;
  // `agentIdForName` is the single derivation — the board matches a task's
  // owner against the agent roster with the same function, and two spellings
  // of it drift into a roster that silently never matches.
  return { name, color: hashToColor(name), id: agentIdForName(name), kind: 'known' };
}
