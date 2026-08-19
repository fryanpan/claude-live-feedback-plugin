/**
 * Environment variable names across the live-feedback → claude-workspaces
 * rename.
 *
 * WHY ONE PREFIX. There were two, `LF_` and `FEEDBACK_`, split by nothing
 * anyone could state — plus a third spelling for a single variable
 * (`LIVE_FEEDBACK_SUMMARY_API_KEY`). The rename is the one cheap moment to
 * collapse them, so every variable this project owns is now `CW_`.
 *
 * WHY `CW_` AND NOT `CLAUDE_WORKSPACES_`. Short enough that a plist or a
 * launch config stays readable, which is what `LF_` was buying. And
 * deliberately NOT under `CLAUDE_`: that namespace belongs to Claude Code
 * itself (`CLAUDE_PLUGIN_ROOT`), so squatting in it risks a collision with a
 * harness-owned name we would not control and could not rename back.
 *
 * WHY THE OLD NAMES KEEP WORKING. The rollout is a coordinated flag day — a
 * migration script on the box, launch configs updated, every session
 * respawned. But a launch environment is the one input this repo cannot
 * restart on somebody's behalf, so a straggler that the sweep missed should
 * degrade to "still works" rather than to a silent nothing. The fallback is
 * a permanent cheap read, not a transition scaffold; it costs one property
 * lookup and it is the difference between a missed config line being visible
 * and being catastrophic.
 */

export type EnvLike = Record<string, string | undefined>;

/**
 * Every variable this project reads, old spelling → new spelling.
 *
 * Keep this the ONE list. A reader that hardcodes its own pair is how half a
 * rename ships: the code compiles, the variable resolves in the shape the
 * author tested, and the other spelling silently stops being honoured.
 */
export const ENV_RENAMES: ReadonlyArray<readonly [legacy: string, current: string]> = [
  // Agent-facing: read by the MCP child from its session's launch environment.
  ['FEEDBACK_BASE_URL', 'CW_BASE_URL'],
  ['FEEDBACK_AGENT_NAME', 'CW_AGENT_NAME'],
  ['FEEDBACK_AUTHOR', 'CW_AUTHOR'],
  // Server-facing: read from the launchd plist / the dev shell.
  ['LF_CLIENT_ROOT', 'CW_CLIENT_ROOT'],
  ['LF_PUBLIC_BASE_URL', 'CW_PUBLIC_BASE_URL'],
  ['LF_WIDGET_DIST', 'CW_WIDGET_DIST'],
  ['LF_MARKDOWN_APP_DIST', 'CW_MARKDOWN_APP_DIST'],
  ['LF_SHARING_DISABLED', 'CW_SHARING_DISABLED'],
  ['LF_SUMMARIES', 'CW_SUMMARIES'],
  ['LF_SUMMARY_BACKFILL', 'CW_SUMMARY_BACKFILL'],
  ['LF_SUMMARY_BACKFILL_MINUTES', 'CW_SUMMARY_BACKFILL_MINUTES'],
  ['LF_PLUGIN_REFRESH_MINUTES', 'CW_PLUGIN_REFRESH_MINUTES'],
  ['LF_CLAUDE_BIN', 'CW_CLAUDE_BIN'],
  ['LF_MCP_PRINT_NODE', 'CW_MCP_PRINT_NODE'],
  // The one variable that never shared either prefix.
  ['LIVE_FEEDBACK_SUMMARY_API_KEY', 'CW_SUMMARY_API_KEY'],
];

const LEGACY_OF = new Map(ENV_RENAMES.map(([legacy, current]) => [current, legacy]));

/** The old spelling of `current`, or undefined if it was never renamed. */
export function legacyEnvName(current: string): string | undefined {
  return LEGACY_OF.get(current);
}

function present(v: string | undefined): boolean {
  return v !== undefined && v.trim() !== '';
}

/**
 * Read `current`, falling back to its old spelling.
 *
 * "Set" means non-empty after trimming, in both positions — see the test for
 * why that asymmetry is the safe one. The value itself comes back untouched;
 * callers that want it trimmed already trim.
 */
export function readRenamedEnv(env: EnvLike, current: string): string | undefined {
  const direct = env[current];
  if (present(direct)) return direct;
  const legacy = LEGACY_OF.get(current);
  if (legacy !== undefined) {
    const old = env[legacy];
    if (present(old)) return old;
  }
  return direct;
}

/**
 * Variables set to two DIFFERENT values under both spellings.
 *
 * A half-migrated launch config is otherwise invisible: the new name wins, the
 * old one sits there meaning something else, and the disagreement only shows
 * up as behaviour nobody can account for. Cheap to compute at boot, so the
 * server says it once rather than leaving it to be discovered.
 */
export function renamedEnvConflicts(env: EnvLike): { current: string; legacy: string }[] {
  const out: { current: string; legacy: string }[] = [];
  for (const [legacy, current] of ENV_RENAMES) {
    const a = env[current];
    const b = env[legacy];
    if (present(a) && present(b) && a !== b) out.push({ current, legacy });
  }
  return out;
}
