import { hashToColor } from '../../core/src/identity.ts';

export interface AgentAuthor {
  name: string;
  color: string;
  id: string;
  kind: 'known' | 'anon';
}

const KNOWN_USERS: Record<string, AgentAuthor> = {
  bryan: { name: 'Bryan', color: '#2e7dd7', id: 'known-bryan', kind: 'known' },
  agent: { name: 'Agent', color: '#e36f1e', id: 'known-agent', kind: 'known' },
};

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
  const known = KNOWN_USERS[name.toLowerCase()];
  if (known) return known;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return { name, color: hashToColor(name), id: `agent-${slug}`, kind: 'known' };
}
