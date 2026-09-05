/**
 * Environment variable names across the live-feedback → claude-workspaces
 * rename.
 *
 * WHY ONE PREFIX. There were three spellings, split by nothing anyone could
 * state: a two-letter prefix from the old product name, `FEEDBACK_`, and a
 * long form for a single variable (`LIVE_FEEDBACK_SUMMARY_API_KEY`). The
 * rename was the one cheap moment to collapse them, so every variable this
 * project owns is now `CW_`.
 *
 * WHY `CW_` AND NOT `CLAUDE_WORKSPACES_`. Short enough that a plist or a
 * launch config stays readable, which is what the old prefix was buying. And
 * deliberately NOT under `CLAUDE_`: that namespace belongs to Claude Code
 * itself (`CLAUDE_PLUGIN_ROOT`), so squatting in it risks a collision with a
 * harness-owned name we would not control and could not rename back.
 *
 * WHY SOME OLD NAMES STILL WORK. The rollout was a coordinated flag day — a
 * migration script on the box, launch configs updated, every session
 * respawned. But a launch environment is the one input this repo cannot
 * restart on somebody's behalf, so a straggler that the sweep missed should
 * degrade to "still works" rather than to a silent nothing. The fallback is
 * a permanent cheap read, not a transition scaffold; it costs one property
 * lookup and it is the difference between a missed config line being visible
 * and being catastrophic.
 *
 * The server-facing aliases from the old product name are gone (2026-09-04):
 * they were only ever read from the launchd plist and the dev shell, both of
 * which this repo does own and has since migrated. What remains is the
 * agent-facing set, which is read from a session's launch environment.
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
  // The one variable that never shared the agent-facing prefix.
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

/**
 * A duration an operator types, in whatever unit reads naturally at the call
 * site — minutes for a quiet window, hours for an escalation window — returned
 * in milliseconds, or `undefined` to mean "use the built-in default".
 *
 * WHY EVERY BAD VALUE FALLS BACK RATHER THAN THROWING. These knobs exist to be
 * turned in a launch config at 2am, and the failure that matters is not a typo
 * — it is a typo that silently changes behaviour. `0` is the dangerous one: it
 * reads as "off" and would actually mean "fire on every tick", which is the
 * one behaviour these windows exist to prevent. Negative, non-numeric and
 * `Infinity` land in the same place for the same reason. The server keeps its
 * default and stays boring.
 */
export function positiveEnvDuration(
  env: EnvLike,
  current: string,
  unitMs: number,
): number | undefined {
  const raw = Number(readRenamedEnv(env, current) ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw * unitMs : undefined;
}
