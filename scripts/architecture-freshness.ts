#!/usr/bin/env bun
/**
 * The architecture-map gate.
 *
 * `docs/architecture/overview.md` draws one picture: the packages, and the
 * subsystems inside `server`. That picture is only worth opening if it is
 * true, and the way it stops being true is not a refactor anybody would call
 * one — a module gets extracted, a directory gets added, a file moves from
 * `server/src` into `server/src/routes`, and the diagram silently describes a
 * layout that no longer exists. The overview was 241 lines of exactly that
 * before this gate: it named `board/board-model.ts`, three files by then, and drew
 * `server` as one box after eight subsystems had been lifted out of it.
 *
 * WHAT A TOP-LEVEL MODULE IS, precisely, because the whole gate turns on it:
 *
 *   - a FILE sitting directly in `packages/<pkg>/src/` whose extension is
 *     `.ts`, `.tsx` or `.css`, excluding `*.test.ts(x)` and `*.d.ts`; recorded
 *     as `packages/<pkg>/src/<name>`.
 *   - a DIRECTORY sitting directly in `packages/<pkg>/src/`, recorded as
 *     `packages/<pkg>/src/<name>/`. Its CONTENTS ARE NOT DESCENDED INTO.
 *
 * That second half is the point. `routes/`, `middleware/`, `auth/`, `share/`
 * and `review-items/` appear in the overview as directories, so adding a
 * twentieth handler under `routes/` changes nothing a reader of the diagram
 * would have to be told; extracting `routes/` itself, or adding a sibling to
 * it, changes the map. A gate that fired on every file under every directory
 * would fire on almost every PR, and a gate that fires on almost every PR is
 * one people learn to satisfy with a whitespace edit.
 *
 * Tests are excluded because a test file is not a module of the system, and
 * `.d.ts` because it is a declaration for one that is already counted.
 *
 * TWO REFS, ONE QUESTION. Both halves ask about THIS BRANCH'S OWN WORK, so
 * both use the three-dot `${mergeBase}...HEAD` — the module list at the fork
 * point against the list at HEAD, and the files this branch touched. Never
 * `${base}..HEAD`: a two-dot range re-presents everything the base gained
 * since the fork as this branch's additions, which would fail a PR for
 * somebody else's extraction (the same defect `check-plugin-version.ts` and
 * this repo's pre-push scanner both document).
 *
 * The failure is a doc chore, so the message says which modules moved. It does
 * NOT check that the diagram mentions them by name: the overview groups
 * modules into subsystems and uses `task-*.ts` globs, so a name-matching gate
 * would demand a shape the doc deliberately does not have. What is enforced is
 * that somebody looked.
 *
 * Usage: bun run check:architecture [--base <ref>]
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `import.meta.url`, not Bun's `import.meta.dir`: the colocated test runs under
// vitest, where `import.meta.dir` is undefined and module load throws. Every
// git call is anchored here so a pathspec means the same thing whatever the
// caller's cwd is.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const OVERVIEW_DOC = 'docs/architecture/overview.md';

/** Extensions that make a file a module. Markdown, JSON and images are data. */
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.css'];

/** A path segment under `packages/<pkg>/src/` that is a module, or null. */
export function moduleOf(repoRelPath: string): string | null {
  const parts = repoRelPath.split('/');
  // packages / <pkg> / src / <name> [ / ...deeper ]
  if (parts.length < 4) return null;
  if (parts[0] !== 'packages' || parts[2] !== 'src') return null;
  const name = parts[3];
  if (name === undefined || name === '') return null;

  // Deeper than `src/<name>/...` means <name> is a directory. Record the
  // directory itself and stop: what lives inside it is that subsystem's own
  // business, not the overview's.
  if (parts.length > 4) return `packages/${parts[1]}/src/${name}/`;

  if (name.endsWith('.d.ts')) return null;
  if (/\.test\.tsx?$/.test(name)) return null;
  if (!MODULE_EXTENSIONS.some((ext) => name.endsWith(ext))) return null;
  return `packages/${parts[1]}/src/${name}`;
}

/** The top-level module set implied by a full list of tracked file paths. */
export function topLevelModules(paths: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    const m = moduleOf(p);
    if (m !== null) out.add(m);
  }
  return out;
}

export type Verdict =
  | { ok: true; reason: 'unchanged' | 'documented'; added: string[]; removed: string[] }
  | { ok: false; added: string[]; removed: string[] };

/**
 * The whole decision, as a pure function of three lists, so the test does not
 * need a git repository to exercise it.
 */
export function judge(
  basePaths: readonly string[],
  headPaths: readonly string[],
  changedFiles: readonly string[],
): Verdict {
  const before = topLevelModules(basePaths);
  const after = topLevelModules(headPaths);
  const added = [...after].filter((m) => !before.has(m)).sort();
  const removed = [...before].filter((m) => !after.has(m)).sort();

  if (added.length === 0 && removed.length === 0) {
    return { ok: true, reason: 'unchanged', added, removed };
  }
  if (changedFiles.includes(OVERVIEW_DOC)) {
    return { ok: true, reason: 'documented', added, removed };
  }
  return { ok: false, added, removed };
}

// --- the git half ---------------------------------------------------------

function git(...a: string[]): string {
  return execFileSync('git', ['-C', REPO_ROOT, ...a], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function tryGit(...a: string[]): string | null {
  try {
    // stderr piped: a missing ref is an expected outcome here, not console noise.
    return execFileSync('git', ['-C', REPO_ROOT, ...a], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

function lines(out: string): string[] {
  return out.split('\n').filter(Boolean);
}

export function pathsAt(ref: string): string[] {
  return lines(git('ls-tree', '-r', '--name-only', ref, '--', 'packages'));
}

function main(): void {
  const args = process.argv.slice(2);
  const i = args.indexOf('--base');
  const base = i === -1 ? 'origin/main' : (args[i + 1] ?? 'origin/main');

  if (tryGit('rev-parse', '--verify', `${base}^{commit}`) === null) {
    // Never pass vacuously in CI: without the base ref, "no modules moved" is
    // unknowable, and a silent pass is exactly the failure this gate exists for.
    const msg =
      `Base ref "${base}" is not available, so the module-list comparison cannot run.\n` +
      'In CI, fetch it (actions/checkout with fetch-depth: 0).';
    if (process.env.CI) {
      console.error(`\n✗ architecture freshness gate\n\n${msg}\n`);
      process.exit(1);
    }
    console.warn(`⚠ ${msg}\n  Skipping locally.`);
    process.exit(0);
  }

  const mergeBase = tryGit('merge-base', base, 'HEAD') ?? base;
  const verdict = judge(
    pathsAt(mergeBase),
    pathsAt('HEAD'),
    lines(git('diff', '--name-only', `${mergeBase}...HEAD`)),
  );

  if (verdict.ok) {
    if (verdict.reason === 'unchanged') {
      console.log(
        '✓ architecture freshness gate — no top-level module was added, removed or moved.',
      );
    } else {
      console.log(
        `✓ architecture freshness gate — ${verdict.added.length} added, ` +
          `${verdict.removed.length} removed, and ${OVERVIEW_DOC} was updated.`,
      );
    }
    return;
  }

  const show = (label: string, list: string[]): string =>
    list.length === 0 ? '' : `${label}\n${list.map((m) => `    ${m}`).join('\n')}\n\n`;

  console.error(
    '\n✗ architecture freshness gate\n\n' +
      `This branch moves the top-level module map, and ${OVERVIEW_DOC} does not\n` +
      'change with it.\n\n' +
      show('  Added:', verdict.added) +
      show('  Removed:', verdict.removed) +
      `${OVERVIEW_DOC} draws the packages and the subsystems inside \`server\`. A module\n` +
      'appearing, vanishing or moving between directories is exactly what makes that\n' +
      'picture wrong, and a wrong map is worse than no map — an agent reads it, trusts\n' +
      'it, and looks for code where it used to be.\n\n' +
      'Fix: open the diagram, put the module in the subsystem it belongs to (or take it\n' +
      'out), and commit the doc in the same PR. If the module genuinely does not change\n' +
      'the picture — a private helper inside a subsystem already drawn — say so in a\n' +
      'line of that subsystem, so the next reader knows it was considered rather than\n' +
      'missed. The gate does not check the wording; it checks that somebody looked.\n',
  );
  process.exit(1);
}

if (import.meta.main) main();
