#!/usr/bin/env bun
/**
 * PreToolUse hook for mcp__claude-in-chrome__navigate.
 *
 * Auto-approves navigates to hostnames declared as trusted in
 * .claude/claude-workspaces.local.json (gitignored, and where the list
 * belongs), else .claude/claude-workspaces.json or
 * ~/.claude/claude-workspaces.json (all three falling back to the
 * pre-rename live-feedback.json):
 *
 *   {
 *     "trustedPreviewDomains": ["tunnel.fryanpan.com"]
 *   }
 *
 * An entry like "tunnel.fryanpan.com" matches the domain itself and any
 * subdomain under it (e.g. `abc.tunnel.fryanpan.com`). No wildcards over
 * paths — the host is the only gate. If the file is missing or the list
 * is empty, the hook is a no-op and Claude Code's normal approval prompt
 * fires.
 *
 * We deliberately ship **no defaults**. Bundling e.g. *.trycloudflare.com
 * would let any agent navigate to any Cloudflare quick-tunnel URL in the
 * world, which is not the trust model the user opted into.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type HookPayload = {
  tool_name?: string;
  tool_input?: { url?: string };
};

type HookDecision = {
  decision?: 'approve' | 'block';
  reason?: string;
};

/**
 * Config filenames, most specific first.
 *
 * `.local.json` comes first and is gitignored. The domains name private
 * networks, so in a PUBLIC repository the list cannot live in a tracked file —
 * and it cannot be replaced by a placeholder either, because a placeholder
 * silently stops matching and nobody notices until a preview refuses to open.
 * An untracked file keeps the hook working and keeps the names out of the repo.
 *
 * The old name is a permanent fallback, not a transition step: this file lives
 * in whoever's checkout the hook runs against, and nothing in this repo can
 * rename a config in somebody else's repo. Root precedence stays OUTERMOST —
 * a project's own config beats the home one whichever filename it uses.
 */
const CONFIG_NAMES = [
  'claude-workspaces.local.json',
  'claude-workspaces.json',
  'live-feedback.json',
];

function readConfig(): { domains: string[]; source: string | null } {
  const roots = [
    process.env.CLAUDE_PROJECT_DIR,
    process.cwd(),
    homedir(),
  ].filter(Boolean) as string[];
  for (const root of roots) {
    for (const name of CONFIG_NAMES) {
      const p = join(root, '.claude', name);
      if (!existsSync(p)) continue;
      try {
        const j = JSON.parse(readFileSync(p, 'utf8')) as {
          trustedPreviewDomains?: string[];
        };
        // The source is carried out so the approval reason can name the file it
        // actually came from. It used to say claude-workspaces.json whatever had
        // been read, which is now wrong more often than right.
        if (Array.isArray(j.trustedPreviewDomains)) {
          return { domains: j.trustedPreviewDomains, source: name };
        }
      } catch {
        // ignore malformed config; fall through to defaults (empty)
      }
    }
  }
  return { domains: [], source: null };
}

function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const d = domain.toLowerCase().replace(/^\.?/, '').replace(/\.$/, '');
  if (!d) return false;
  if (h === d) return true;
  return h.endsWith(`.${d}`);
}

async function main(): Promise<void> {
  // Read JSON payload from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  let payload: HookPayload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    // Malformed input — let Claude Code handle normally
    process.exit(0);
  }

  if (payload.tool_name !== 'mcp__claude-in-chrome__navigate') {
    process.exit(0);
  }
  const url = payload.tool_input?.url;
  if (!url || typeof url !== 'string') {
    process.exit(0);
  }

  let host: string | null = null;
  try {
    host = new URL(url).hostname;
  } catch {
    process.exit(0);
  }
  if (!host) process.exit(0);

  const { domains: trusted, source } = readConfig();
  const matched = trusted.find((d) => hostMatches(host!, d));
  if (!matched) {
    // Fall through to the normal prompt. exit 0 with no decision.
    process.exit(0);
  }

  const out: HookDecision = {
    decision: 'approve',
    reason: `host "${host}" matches trusted preview domain "${matched}" from .claude/${source}`,
  };
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

void main();
