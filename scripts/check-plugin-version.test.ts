/**
 * End-to-end tests for the plugin release gate.
 *
 * These drive the real script against real temp git repos rather than a pure
 * helper, because the defect being pinned is WHICH GIT COMMAND RUNS — a unit
 * test over pre-fetched version strings would pass against both the broken and
 * the fixed script and prove nothing about either.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// vitest rewrites import.meta.url away from a file: URL, so resolve from the
// project root instead. The first case below asserts this path exists — a
// mistyped one would otherwise make every spawn fail for the wrong reason.
const GATE = resolve(process.cwd(), 'scripts/check-plugin-version.ts');
const MANIFEST = 'packages/plugin/.claude-plugin/plugin.json';
const MARKETPLACE = '.claude-plugin/marketplace.json';

/**
 * git exports GIT_DIR (and friends) into hooks and child processes, and a
 * `git init` that inherits GIT_DIR re-initializes the repo that variable NAMES
 * rather than its own cwd — which has set core.bare on this repo's primary
 * checkout before. Strip every GIT_* key.
 */
function gitSafeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return env;
}

/**
 * Stripping GIT_* also removes GIT_AUTHOR_* / GIT_COMMITTER_*, and CI runners
 * have no global identity, so a bare `git commit` there exits 128. Pass one.
 */
const IDENT = ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Version Gate Fixture'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...IDENT, ...args], {
    cwd,
    encoding: 'utf8',
    env: gitSafeEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

const built: string[] = [];

afterEach(() => {
  for (const dir of built.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-version-gate-'));
  built.push(root);
  git(root, 'init', '-q', '-b', 'main');
  return root;
}

function write(root: string, rel: string, body: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

function setVersion(root: string, version: string, name = 'live-feedback'): void {
  write(root, MANIFEST, `${JSON.stringify({ name, version }, null, 2)}\n`);
  write(root, MARKETPLACE, `${JSON.stringify({ plugins: [{ name, version }] }, null, 2)}\n`);
}

function commit(root: string, message: string): void {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

function versionAt(root: string, ref: string): string {
  return JSON.parse(git(root, 'show', `${ref}:${MANIFEST}`)).version;
}

function pluginPaths(root: string, range: string): string[] {
  return git(root, 'diff', '--name-only', range)
    .split('\n')
    .filter((f) => f.startsWith('packages/plugin/'));
}

function runGate(root: string): { code: number; out: string } {
  const r = spawnSync('bun', ['run', GATE, '--base', 'main'], {
    cwd: root,
    encoding: 'utf8',
    env: gitSafeEnv(),
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/**
 * The measured shape (2026-08-17, branch feat/goal-band-retriage): the fork
 * point holds 0.1.47, the branch carries `branchVersion`, and `main` has since
 * published 0.1.51. Comparing against the fork point says yes; comparing
 * against what is published says no.
 */
function repoWhereBaseMovedAhead(branchVersion: string): string {
  const root = newRepo();
  setVersion(root, '0.1.47');
  write(root, 'README.md', 'fork point\n');
  commit(root, 'fork point publishes 0.1.47');

  git(root, 'checkout', '-q', '-b', 'feature');
  setVersion(root, branchVersion);
  write(root, 'packages/plugin/skills/demo/SKILL.md', 'branch work\n');
  commit(root, `branch work at ${branchVersion}`);

  git(root, 'checkout', '-q', 'main');
  setVersion(root, '0.1.51');
  commit(root, 'main publishes 0.1.51');

  git(root, 'checkout', '-q', 'feature');
  return root;
}

/**
 * The catch-up merge this repo's conventions require before the final push.
 * `main` is merged into the branch, the three version files conflict, and the
 * resolution KEEPS OURS — the normal instinct when merging main into a feature
 * branch, and correct at the moment it is made here (0.1.50 beats the 0.1.49
 * being merged in). `main` then moves on to 0.1.51 and the resolution is stale.
 *
 * This shape matters because the merge MOVES the merge base onto a main commit,
 * so it is not the plain stale-bump case: a merge-base comparand reads 0.1.49,
 * sees 0.1.50 ahead of it, and is satisfied.
 */
function repoWithCatchUpMergeKeepingOurs(): string {
  const root = newRepo();
  setVersion(root, '0.1.47');
  write(root, 'README.md', 'fork point\n');
  commit(root, 'fork point publishes 0.1.47');

  git(root, 'checkout', '-q', '-b', 'feature');
  setVersion(root, '0.1.50');
  write(root, 'packages/plugin/skills/demo/SKILL.md', 'branch work\n');
  commit(root, 'branch work at 0.1.50');

  git(root, 'checkout', '-q', 'main');
  setVersion(root, '0.1.49');
  commit(root, 'main publishes 0.1.49');

  git(root, 'checkout', '-q', 'feature');
  try {
    git(root, 'merge', '--no-commit', '--no-ff', 'main');
  } catch {
    // The version files conflict. That is the point of this fixture.
  }
  setVersion(root, '0.1.50'); // keep ours
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'merge main, keeping our 0.1.50');

  git(root, 'checkout', '-q', 'main');
  setVersion(root, '0.1.51');
  commit(root, 'main publishes 0.1.51');
  git(root, 'checkout', '-q', 'feature');
  return root;
}

describe('plugin version gate', () => {
  it('runs the real script — the path under test resolves', () => {
    expect(existsSync(GATE)).toBe(true);
  });

  // Ordinary conflict resolution defeats a merge-base gate from BOTH sides, and
  // neither direction requires anyone to be careless. Both cases below are
  // named for the human action rather than the arithmetic, because the action
  // is what a reader will recognise. Note what this means for the fix's
  // phrasing: "must DIFFER from the base" would catch neither — it is satisfied
  // by a branch that is behind. Only "must be strictly GREATER than the base"
  // catches both, which is why the comparison is `<= 0` and not `=== 0`.
  it('fails a catch-up merge resolved by KEEPING OURS, once the base has moved on', () => {
    const root = repoWithCatchUpMergeKeepingOurs();

    // Shape before behaviour. The merge moved the merge base onto a main
    // commit, and the branch is strictly AHEAD of that — which is exactly why a
    // merge-base comparand waves this through. It is behind the tip.
    const mergeBase = git(root, 'merge-base', 'main', 'HEAD');
    expect(versionAt(root, mergeBase)).toBe('0.1.49');
    expect(versionAt(root, 'HEAD')).toBe('0.1.50');
    expect(versionAt(root, 'main')).toBe('0.1.51');

    const { code, out } = runGate(root);
    expect(code).toBe(1);
    expect(out).toContain('0.1.51');
    expect(out).toContain('RE-BUMP');
  }, 30_000);

  it('fails a branch whose version beats its fork point but not what the base publishes now', () => {
    const root = repoWhereBaseMovedAhead('0.1.48');

    // Shape before behaviour: a fixture that did not actually split the fork
    // point from the tip would pass or fail for a reason unrelated to the bug.
    const forkPoint = git(root, 'merge-base', 'main', 'HEAD');
    expect(forkPoint).not.toBe(git(root, 'rev-parse', 'main'));
    expect(versionAt(root, forkPoint)).toBe('0.1.47');
    expect(versionAt(root, 'main')).toBe('0.1.51');
    expect(versionAt(root, 'HEAD')).toBe('0.1.48');

    const { code, out } = runGate(root);
    expect(code).toBe(1);
    expect(out).toContain('0.1.51');
    expect(out).toContain('RE-BUMP');
  }, 30_000);

  // The other resolution of the same conflict. PR #187 went `mergeable_state:
  // dirty` with the three version files in the conflict set (branch 0.1.53
  // against main 0.1.51); taking MAIN'S side lands the branch at exactly main's
  // version, which publishes nothing. Equality is also the boundary the `<= 0`
  // comparison turns on, so this is the case most likely to be broken by a
  // later edit to that operator.
  it('fails a version conflict resolved by TAKING THEIRS, landing on the base version', () => {
    const root = repoWhereBaseMovedAhead('0.1.51');

    // Shape before behaviour: equal to the tip, strictly ahead of the fork
    // point — the two comparands must disagree or this proves nothing.
    const forkPoint = git(root, 'merge-base', 'main', 'HEAD');
    expect(versionAt(root, forkPoint)).toBe('0.1.47');
    expect(versionAt(root, 'HEAD')).toBe(versionAt(root, 'main'));

    const { code, out } = runGate(root);
    expect(code).toBe(1);
    expect(out).toContain('RE-BUMP');
  }, 30_000);

  it('passes a branch whose version is above what the base publishes now', () => {
    const root = repoWhereBaseMovedAhead('0.1.52');
    expect(versionAt(root, 'main')).toBe('0.1.51');
    expect(versionAt(root, 'HEAD')).toBe('0.1.52');

    const { code, out } = runGate(root);
    expect(code).toBe(0);
    expect(out).toContain('0.1.51');
    expect(out).toContain('0.1.52');
  }, 30_000);

  it('exempts a branch touching no plugin files, even when the base moved the plugin forward', () => {
    const root = newRepo();
    setVersion(root, '0.1.47');
    write(root, 'README.md', 'fork point\n');
    commit(root, 'fork point publishes 0.1.47');

    git(root, 'checkout', '-q', '-b', 'feature');
    write(root, 'packages/server/src/unrelated.ts', 'export const x = 1;\n');
    commit(root, 'server-only work, ships no plugin');

    git(root, 'checkout', '-q', 'main');
    setVersion(root, '0.1.51');
    write(root, 'packages/plugin/skills/demo/SKILL.md', 'main shipped this\n');
    commit(root, 'main publishes 0.1.51');
    git(root, 'checkout', '-q', 'feature');

    // Shape before behaviour: the two ranges must genuinely disagree here, or
    // this case cannot tell a three-dot changed-file set from a two-dot one.
    const forkPoint = git(root, 'merge-base', 'main', 'HEAD');
    expect(pluginPaths(root, `${forkPoint}...HEAD`)).toEqual([]);
    expect(pluginPaths(root, 'main..HEAD').length).toBeGreaterThan(0);

    const { code, out } = runGate(root);
    expect(code).toBe(0);
    expect(out).toContain('no packages/plugin/ changes');
  }, 30_000);

  it('passes when the base branch has no plugin manifest at all', () => {
    const root = newRepo();
    write(root, 'README.md', 'before the plugin existed\n');
    commit(root, 'repo without a plugin');

    git(root, 'checkout', '-q', '-b', 'feature');
    setVersion(root, '0.1.0');
    write(root, 'packages/plugin/skills/demo/SKILL.md', 'brand new\n');
    commit(root, 'introduce the plugin');

    // Shape before behaviour: the base really has nothing to compare against.
    expect(() => git(root, 'show', `main:${MANIFEST}`)).toThrow();

    const { code, out } = runGate(root);
    expect(code).toBe(0);
    expect(out).toContain('manifest is new on this branch');
  }, 30_000);

  it('fails when the two manifests disagree', () => {
    const root = repoWhereBaseMovedAhead('0.1.52');
    write(
      root,
      MARKETPLACE,
      `${JSON.stringify({ plugins: [{ name: 'live-feedback', version: '0.1.53' }] }, null, 2)}\n`,
    );

    const { code, out } = runGate(root);
    expect(code).toBe(1);
    expect(out).toContain('The two manifests disagree');
  }, 30_000);

  // The gate used to find the marketplace entry with a hardcoded 'live-feedback'.
  // A branch that renames the plugin renames BOTH manifests in the same commit,
  // so the literal matched nothing and the gate failed claiming the marketplace
  // had no such entry — a malformed-file error for a version that was fine.
  function repoRenamingThePluginOnABranch(branchVersion: string): string {
    const root = newRepo();
    setVersion(root, '0.1.60');
    write(root, 'README.md', 'fork point\n');
    commit(root, 'main publishes 0.1.60 as live-feedback');

    git(root, 'checkout', '-q', '-b', 'feature');
    setVersion(root, branchVersion, 'renamed-plugin');
    write(root, 'packages/plugin/skills/demo/SKILL.md', 'branch work\n');
    commit(root, `rename to renamed-plugin at ${branchVersion}`);
    return root;
  }

  it('resolves the marketplace entry after the plugin is renamed on this branch', () => {
    const root = repoRenamingThePluginOnABranch('0.1.61');

    // Non-vacuity: the branch really did change a guarded file, so the gate
    // reaches the version comparison rather than exiting on the no-changes path.
    expect(pluginPaths(root, 'main...HEAD').length).toBeGreaterThan(0);

    const { code, out } = runGate(root);
    expect(code).toBe(0);
    expect(out).toContain('0.1.60 (main tip) → 0.1.61');
  }, 30_000);

  it('still fails a rename that does NOT move the version forward', () => {
    const root = repoRenamingThePluginOnABranch('0.1.60');

    const { code, out } = runGate(root);
    expect(code).toBe(1);
    expect(out).toContain('0.1.60');
  }, 30_000);
});
