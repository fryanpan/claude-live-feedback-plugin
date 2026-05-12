#!/usr/bin/env bun
/**
 * PreToolUse hook for the live-feedback plugin.
 *
 * Auto-approves tool calls that fall inside the plugin's own surface so
 * users don't have to "Allow Claude to use <tool>" for every new MCP tool
 * the plugin ships, plus a small allowlist of Bash operations every plugin
 * consumer eventually has to run (server lifecycle, launchd supervisor
 * install).
 *
 * Two categories, evaluated independently:
 *
 *   1. **MCP tools published by this plugin**
 *      Tool name matches `mcp__plugin_live-feedback_live-feedback__*` → approve.
 *      Rationale: the user opted into the entire MCP surface when they ran
 *      `claude plugin install live-feedback@…`. Making them re-opt-in per
 *      tool is friction without security value — the MCP server is the
 *      trust boundary, not the individual tool names. Auto-approving here
 *      means new tools shipped in plugin updates don't require every user
 *      to re-edit `~/.claude/settings.json`.
 *
 *   2. **Bash patterns specific to the plugin's lifecycle**
 *      Narrow allowlist of known-safe commands the plugin documents in
 *      `/setup` and the README:
 *        - `./scripts/launchd/install.sh` / `uninstall.sh`
 *        - `launchctl {bootstrap,bootout,kickstart,print}` against the
 *          plugin's service label `com.fryanpan.live-feedback`
 *        - `bun run scripts/serve.ts` and `bun run dev` (foreground server)
 *        - `kill` against PIDs holding the plugin's port (8787 / 8788)
 *      Anything else falls through to Claude Code's normal prompt.
 *
 * Everything outside the plugin's domain (file writes outside the project,
 * destructive ops, third-party MCP tools, etc.) is unaffected — the hook
 * does not fire on those matchers, and even when it does fire on a Bash
 * call it pass-throughs unless the command matches one of the named
 * patterns.
 *
 * On any error (malformed payload, unexpected shape) the hook exits 0
 * with no decision so Claude Code's normal prompt fires — fail-open is
 * safer than fail-block here.
 */

type HookPayload = {
  tool_name?: string;
  tool_input?: {
    command?: string;
    [key: string]: unknown;
  };
};

type HookDecision = {
  decision?: 'approve' | 'block';
  reason?: string;
};

const MCP_PREFIX = 'mcp__plugin_live-feedback_live-feedback__';
const SERVICE_LABEL = 'com.fryanpan.live-feedback';

/**
 * Anchored, simple-glob matchers for Bash commands the plugin owns.
 * `command.startsWith(pattern)` is sufficient — these are command lines
 * Claude generates, not arbitrary shell. Keep the list short; surprise
 * approvals are worse than an extra prompt.
 */
const BASH_PREFIX_ALLOWLIST = [
  './scripts/launchd/install.sh',
  './scripts/launchd/uninstall.sh',
  'bun run scripts/serve.ts',
  'bun run dev',
];

/**
 * Substring matchers — for commands where the meaningful pattern can
 * appear with various leading flags or pipes. We keep these scoped to
 * the plugin's service label and ports so a random `launchctl print`
 * for another service still prompts.
 */
const BASH_SUBSTRING_ALLOWLIST = [
  'launchctl bootstrap gui/', // followed by uid + plist; the install.sh script uses this exact form
  'launchctl bootout gui/',
  'launchctl kickstart -k gui/',
  'launchctl print gui/',
  `launchctl list ${SERVICE_LABEL}`,
];

function approveBash(command: string): { approve: true; reason: string } | null {
  for (const prefix of BASH_PREFIX_ALLOWLIST) {
    if (command.startsWith(prefix)) {
      return { approve: true, reason: `plugin lifecycle: ${prefix}` };
    }
  }
  for (const needle of BASH_SUBSTRING_ALLOWLIST) {
    if (command.includes(needle) && command.includes(SERVICE_LABEL)) {
      return { approve: true, reason: `plugin service mgmt: ${needle}` };
    }
  }
  // `launchctl print gui/<uid>/com.fryanpan.live-feedback` — the service
  // label appears later in the path, so the substring match above already
  // catches it. Same for kickstart / bootout. The `SERVICE_LABEL`
  // co-occurrence requirement is the guardrail: no broad `launchctl`
  // ops on someone else's service get auto-approved.
  return null;
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
  const tool = payload.tool_name;
  if (!tool) process.exit(0);

  // MCP tools owned by this plugin — auto-approve unconditionally.
  if (tool.startsWith(MCP_PREFIX)) {
    const out: HookDecision = {
      decision: 'approve',
      reason: 'live-feedback plugin MCP tool — user already opted in via plugin install',
    };
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }

  // Bash — check against the narrow allowlist.
  if (tool === 'Bash') {
    const command = payload.tool_input?.command;
    if (typeof command !== 'string') process.exit(0);
    const decision = approveBash(command);
    if (decision) {
      const out: HookDecision = { decision: 'approve', reason: decision.reason };
      process.stdout.write(JSON.stringify(out));
    }
    // No match → exit 0 with no decision; Claude Code prompts normally.
    process.exit(0);
  }

  // Any other tool: pass through.
  process.exit(0);
}

void main();
