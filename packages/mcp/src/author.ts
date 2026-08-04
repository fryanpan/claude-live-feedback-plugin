import { hashToColor, knownUserForName } from '../../core/src/identity.ts';

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
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    // Names with no alphanumerics (emoji, punctuation) must not all collapse
    // to the same id — fall back to a content hash of the raw name.
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    slug = h.toString(36);
  }
  return { name, color: hashToColor(name), id: `agent-${slug}`, kind: 'known' };
}
