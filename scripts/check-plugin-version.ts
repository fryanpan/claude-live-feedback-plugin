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
 *      strictly greater than the base branch's.
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

function marketplaceVersionOf(source: string, label: string): string {
  const manifest = JSON.parse(source);
  const entry = (manifest.plugins ?? []).find((p: { name?: string }) => p.name === 'live-feedback');
  if (!entry) fail(`${label} has no plugins[] entry named "live-feedback".`);
  if (typeof entry.version !== 'string') fail(`${label}'s live-feedback entry has no "version".`);
  return entry.version;
}

// --- invariant 1: the manifests agree -------------------------------------

const pluginVersion = pluginVersionOf(readFileSync(PLUGIN_MANIFEST, 'utf8'), PLUGIN_MANIFEST);
const marketVersion = marketplaceVersionOf(
  readFileSync(MARKETPLACE_MANIFEST, 'utf8'),
  MARKETPLACE_MANIFEST,
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

const mergeBase = tryGit('merge-base', base, 'HEAD') ?? base;
const changed = git('diff', '--name-only', `${mergeBase}...HEAD`).split('\n').filter(Boolean);
const pluginChanges = changed.filter((f) => f.startsWith(GUARDED_PREFIX));

if (pluginChanges.length === 0) {
  console.log(`✓ plugin version gate — no ${GUARDED_PREFIX} changes; version ${pluginVersion}.`);
  process.exit(0);
}

const basePluginJson = tryGit('show', `${mergeBase}:${PLUGIN_MANIFEST}`);
if (basePluginJson === null) {
  console.log(`✓ plugin version gate — manifest is new on this branch; version ${pluginVersion}.`);
  process.exit(0);
}

const baseVersion = pluginVersionOf(basePluginJson, `${mergeBase}:${PLUGIN_MANIFEST}`);

if (compare(current, parseSemver(baseVersion, `${mergeBase}:${PLUGIN_MANIFEST}`)) <= 0) {
  const shown = pluginChanges.slice(0, 10);
  fail(
    `This branch changes ${pluginChanges.length} file(s) under ${GUARDED_PREFIX} but leaves\n` +
      `the version at ${baseVersion}:\n\n` +
      shown.map((f) => `    ${f}`).join('\n') +
      (pluginChanges.length > shown.length
        ? `\n    …and ${pluginChanges.length - shown.length} more`
        : '') +
      '\n\n' +
      `Peers install by version. Unbumped, "claude plugin update" copies nothing\n` +
      'and still reports success — the change reaches nobody.\n\n' +
      'Bump the patch version in BOTH manifests:\n' +
      `    ${PLUGIN_MANIFEST}\n` +
      `    ${MARKETPLACE_MANIFEST}`,
  );
}

console.log(
  `✓ plugin version gate — ${pluginChanges.length} file(s) under ${GUARDED_PREFIX}, ` +
    `version ${baseVersion} → ${pluginVersion}.`,
);
