#!/usr/bin/env bun
/**
 * Release gate for the plugin manifest.
 *
 * `claude plugin update` keys on the version string: if plugin content changes
 * without the version moving, the command copies nothing and reports success.
 * That failure is silent on both ends — the publisher sees a green push, the
 * peer sees a plugin that never changes. It cost this repo 25 feature commits
 * that never reached a session (0.0.2, 2026-05-09 → 2026-08-10).
 *
 * Two invariants, checked in order:
 *
 *   1. The two manifests agree. `packages/plugin/.claude-plugin/plugin.json` is
 *      what the installed copy reports; `.claude-plugin/marketplace.json` is what
 *      the marketplace advertises. A mismatch means one of them is lying.
 *   2. If this change touches anything under `packages/plugin/`, the version is
 *      strictly greater than the one the base branch currently PUBLISHES.
 *
 * Two refs, two different questions — do not collapse them back into one.
 *
 *   WHICH FILES CHANGED asks about this branch's own work, so it uses the
 *   three-dot `${mergeBase}...HEAD`. It must NOT become `${base}..HEAD`: a
 *   two-dot range re-presents everything the base gained since the fork as this
 *   branch's additions, which is exactly the defect this repo already fixed in
 *   its pre-push scanner ("A merge commit re-presents public content as an
 *   addition" in docs/process/learnings.md).
 *
 *   WHAT VERSION TO BEAT asks "is this strictly ahead of what is published
 *   today", so it reads `${base}` — the TIP. It used to read the merge base,
 *   and that comparand is frozen at the moment the branch was cut while the
 *   base keeps moving. The gate was therefore green precisely when the
 *   regression was largest, and it printed its own defect in its success line:
 *
 *       ✓ plugin version gate — 3 file(s) under packages/plugin/,
 *         version 0.1.47 → 0.1.53
 *
 *   measured 2026-08-17 on branch feat/goal-band-retriage with `--base
 *   origin/main`, exit 0. That 0.1.47 is the frozen FORK POINT being reported
 *   as though it were the thing being beaten; `origin/main` was at 0.1.51.
 *
 *   Note the trigger is not only "a number cut early goes stale while the
 *   branch sits". Every catch-up merge of the base — which this repo's
 *   conventions require before the final push — presents the three version
 *   files as a CONFLICT, and both reflexive resolutions produce a number the
 *   old gate accepted and the fleet would ignore: keep ours (lands behind the
 *   tip) and take theirs (lands exactly ON it, so nothing is published). The
 *   fork point cannot notice either, because it never moves. Which is why this
 *   check must be "strictly GREATER than the base", never "different from the
 *   base" — the latter is satisfied by a branch that is behind.
 *
 *   Re-running CI could not have caught any of it; the comparand does not move
 *   on a re-run.
 *
 * RESIDUAL — this NARROWS the window, it does not close it. CI runs at push
 * time, so the base can still move between the last green run and the merge.
 * What shrank is the exposure: from "the entire life of the branch" to "between
 * the last CI run and the merge". The structural closer is GitHub branch
 * protection's "require branches to be up to date before merging", which forces
 * a re-run against the new tip; until that is enabled, the merger re-checking
 * the number at merge time is still load-bearing.
 *
 * Usage: bun run check:plugin-version [--base <ref>]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PLUGIN_MANIFEST = 'packages/plugin/.claude-plugin/plugin.json';
const MARKETPLACE_MANIFEST = '.claude-plugin/marketplace.json';
const GUARDED_PREFIX = 'packages/plugin/';

const args = process.argv.slice(2);
const baseIdx = args.indexOf('--base');
const base = baseIdx === -1 ? 'origin/main' : args[baseIdx + 1];

function fail(msg: string): never {
  console.error(`\n✗ plugin version gate\n\n${msg}\n`);
  process.exit(1);
}

function git(...a: string[]): string {
  return execFileSync('git', a, { encoding: 'utf8' }).trim();
}

function tryGit(...a: string[]): string | null {
  try {
    // stderr piped: a missing ref is an expected outcome here, not console noise.
    return execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

type Semver = [number, number, number];

function parseSemver(v: string, where: string): Semver {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) fail(`${where} has a version that isn't x.y.z: ${JSON.stringify(v)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function pluginVersionOf(source: string, label: string): string {
  const manifest = JSON.parse(source);
  const v = manifest.version;
  if (typeof v !== 'string') fail(`${label} is missing a top-level "version" string.`);
  return v;
}

function pluginNameOf(source: string, label: string): string {
  const name = JSON.parse(source).name;
  if (typeof name !== 'string') fail(`${label} is missing a top-level "name" string.`);
  return name;
}

/**
 * The entry this repo's plugin manifest names. Matching on a hardcoded name is
 * what the 2026-08-18 rename broke: the literal was `live-feedback`, so the
 * gate would have failed to find an entry the same commit had just renamed —
 * reporting a malformed marketplace rather than a version problem. Take the
 * name from the plugin manifest, and fall back to the sole entry, since a
 * one-plugin marketplace has no ambiguity to resolve.
 */
function marketplaceVersionOf(source: string, label: string, pluginName: string): string {
  const plugins: { name?: string; version?: unknown }[] = JSON.parse(source).plugins ?? [];
  const entry =
    plugins.find((p) => p.name === pluginName) ?? (plugins.length === 1 ? plugins[0] : undefined);
  if (!entry) {
    fail(
      `${label} has no plugins[] entry named "${pluginName}" (and is not a single-plugin file).`,
    );
  }
  if (typeof entry.version !== 'string') fail(`${label}'s "${entry.name}" entry has no "version".`);
  return entry.version as string;
}

// --- invariant 1: the manifests agree -------------------------------------

const pluginManifestSource = readFileSync(PLUGIN_MANIFEST, 'utf8');
const pluginVersion = pluginVersionOf(pluginManifestSource, PLUGIN_MANIFEST);
const marketVersion = marketplaceVersionOf(
  readFileSync(MARKETPLACE_MANIFEST, 'utf8'),
  MARKETPLACE_MANIFEST,
  pluginNameOf(pluginManifestSource, PLUGIN_MANIFEST),
);
const current = parseSemver(pluginVersion, PLUGIN_MANIFEST);
parseSemver(marketVersion, MARKETPLACE_MANIFEST);

if (pluginVersion !== marketVersion) {
  fail(
    'The two manifests disagree:\n' +
      `  ${PLUGIN_MANIFEST}      ${pluginVersion}\n` +
      `  ${MARKETPLACE_MANIFEST}  ${marketVersion}\n\n` +
      'They must be identical — one is what an installed copy reports, the other\n' +
      'is what the marketplace advertises.',
  );
}

// --- invariant 2: plugin changes move the version -------------------------

const baseExists = tryGit('rev-parse', '--verify', `${base}^{commit}`) !== null;

if (!baseExists) {
  // Never pass vacuously in CI: without the base ref, "no plugin files changed"
  // is unknowable, and a silent pass is exactly the failure this gate exists for.
  const msg =
    `Base ref "${base}" is not available, so the changed-file check cannot run.\n` +
    'In CI, fetch it (actions/checkout with fetch-depth: 0).';
  if (process.env.CI) fail(msg);
  console.warn(`⚠ ${msg}\n  Skipping locally. Manifests agree at ${pluginVersion}.`);
  process.exit(0);
}

// Which files this branch changed — its own work only, so three-dot against the
// fork point. Never `${base}..HEAD`: see the header comment.
const mergeBase = tryGit('merge-base', base, 'HEAD') ?? base;
const changed = git('diff', '--name-only', `${mergeBase}...HEAD`).split('\n').filter(Boolean);
const pluginChanges = changed.filter((f) => f.startsWith(GUARDED_PREFIX));

if (pluginChanges.length === 0) {
  console.log(`✓ plugin version gate — no ${GUARDED_PREFIX} changes; version ${pluginVersion}.`);
  process.exit(0);
}

// What version to beat — what the base branch PUBLISHES right now, so its tip
// rather than the fork point. See the header comment for why this differs.
const baseRef = `${base}:${PLUGIN_MANIFEST}`;
const basePluginJson = tryGit('show', baseRef);
if (basePluginJson === null) {
  console.log(`✓ plugin version gate — manifest is new on this branch; version ${pluginVersion}.`);
  process.exit(0);
}

const baseVersion = pluginVersionOf(basePluginJson, baseRef);

if (compare(current, parseSemver(baseVersion, baseRef)) <= 0) {
  const shown = pluginChanges.slice(0, 10);
  fail(
    `This branch changes ${pluginChanges.length} file(s) under ${GUARDED_PREFIX}, but its\n` +
      `version ${pluginVersion} is not ahead of the ${baseVersion} that ${base} publishes today:\n\n` +
      shown.map((f) => `    ${f}`).join('\n') +
      (pluginChanges.length > shown.length
        ? `\n    …and ${pluginChanges.length - shown.length} more`
        : '') +
      '\n\n' +
      `Compared against the TIP of ${base}, not this branch's fork point. Your number\n` +
      'may well have been correct when you cut the branch — the base has moved since,\n' +
      'and this comparison moves with it. So the instruction is RE-BUMP, not "you\n' +
      'forgot to bump".\n\n' +
      `Peers install by version. Merged at ${pluginVersion}, "claude plugin update"\n` +
      'copies nothing — it only acts when the string moves FORWARD — and still reports\n' +
      'success, so the change reaches nobody and nothing anywhere goes red.\n\n' +
      `Re-bump all three sites, to the same value, above ${baseVersion}:\n` +
      `    ${PLUGIN_MANIFEST}\n` +
      `    ${MARKETPLACE_MANIFEST}\n` +
      '    PLUGIN_VERSION in packages/mcp/src/mcp.ts\n\n' +
      'With several branches in flight, ask whoever owns the merges for your number\n' +
      `rather than reading the next one off ${base}: two branches that independently\n` +
      'pick the same number merge clean, because a conflict requires disagreement.',
  );
}

console.log(
  `✓ plugin version gate — ${pluginChanges.length} file(s) under ${GUARDED_PREFIX}, ` +
    `version ${baseVersion} (${base} tip) → ${pluginVersion}.`,
);
