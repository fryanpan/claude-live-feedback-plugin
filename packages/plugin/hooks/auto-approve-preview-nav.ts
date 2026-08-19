#!/usr/bin/env bun
/**
 * Shipped as part of the claude-workspaces plugin. Mirrors the repo's own
 * hook at .claude/hooks/auto-approve-preview-nav.ts so users who install
 * the plugin get the same behavior without copying files.
 *
 * When Claude Code enables a plugin, any `hooks` declared in the plugin
 * manifest land in the user's effective PreToolUse list. This script
 * reads the user's `.claude/claude-workspaces.json` (falling back to their
 * home dir) for a `trustedPreviewDomains` list and approves navigates
 * whose host matches an entry. No defaults ship — the file must exist
 * and list trusted hosts for auto-approve to fire.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type HookPayload = { tool_name?: string; tool_input?: { url?: string } };

/**
 * Config filenames, current first.
 *
 * The old name is a permanent fallback, not a transition step: this file lives
 * in whoever's checkout the hook runs against, and nothing in this repo can
 * rename a config in somebody else's repo. Root precedence stays OUTERMOST —
 * a project's own config beats the home one whichever filename it uses.
 */
const CONFIG_NAMES = ['claude-workspaces.json', 'live-feedback.json'];

function readTrusted(): string[] {
  const roots = [process.env.CLAUDE_PROJECT_DIR, process.cwd(), homedir()].filter(
    Boolean,
  ) as string[];
  for (const root of roots) {
    for (const name of CONFIG_NAMES) {
      const p = join(root, '.claude', name);
      if (!existsSync(p)) continue;
      try {
        const j = JSON.parse(readFileSync(p, 'utf8')) as { trustedPreviewDomains?: string[] };
        if (Array.isArray(j.trustedPreviewDomains)) return j.trustedPreviewDomains;
      } catch {
        // ignore
      }
    }
  }
  return [];
}

function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const d = domain.toLowerCase().replace(/^\.?/, '').replace(/\.$/, '');
  if (!d) return false;
  return h === d || h.endsWith(`.${d}`);
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(Buffer.from(chunk));
  let payload: HookPayload = {};
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    process.exit(0);
  }
  if (payload.tool_name !== 'mcp__claude-in-chrome__navigate') process.exit(0);
  const url = payload.tool_input?.url;
  if (!url) process.exit(0);
  let host: string | null = null;
  try {
    host = new URL(url).hostname;
  } catch {
    process.exit(0);
  }
  if (!host) process.exit(0);
  const trusted = readTrusted();
  const matched = trusted.find((d) => hostMatches(host!, d));
  if (!matched) process.exit(0);
  process.stdout.write(
    JSON.stringify({
      decision: 'approve',
      reason: `host "${host}" matches trusted preview domain "${matched}" from .claude/claude-workspaces.json`,
    }),
  );
  process.exit(0);
}

void main();
