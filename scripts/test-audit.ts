#!/usr/bin/env bun
/**
 * Mechanical audit of the testing standards in .claude/rules/testing-standards.md.
 *
 * Three counts, each a proxy for one standard. A proxy is not the standard:
 * the script cannot tell a test that asserts behaviour from one that asserts
 * source text, so every check below states the pattern it actually matches and
 * the rule file states the standard the pattern stands in for.
 *
 * The counts ratchet. scripts/test-audit.baseline.json holds the highest count
 * each check is allowed to reach; exceeding it fails. Lower a baseline in the
 * same commit that lowers the count, never on its own.
 *
 * Files are enumerated tracked AND untracked-but-not-ignored, so a test file
 * you have written but not staged is judged here exactly as CI will judge it
 * once it is committed. See `gitFiles` for what went wrong when it was not.
 *
 *   bun run test:audit            print the table, exit non-zero over baseline
 *   bun run test:audit --list     also print every matching site
 *   bun run test:audit --write    rewrite the baseline to today's counts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const baselinePath = join(repoRoot, 'scripts', 'test-audit.baseline.json');

type Site = { file: string; line: number; text: string };
type Check = { id: string; title: string; pattern: string; sites: Site[] };

function lsFiles(args: string[], globs: string[]): string[] {
  const out = Bun.spawnSync(['git', 'ls-files', ...args, ...globs], { cwd: repoRoot });
  if (out.exitCode !== 0) throw new Error(`git ls-files failed: ${out.stderr.toString()}`);
  return out.stdout.toString().split('\n').filter(Boolean);
}

/**
 * Every file matching the globs that this audit should judge: tracked, plus
 * untracked-and-not-ignored.
 *
 * The second half is the whole point. A brand-new test file is untracked until
 * somebody stages it, and `git ls-files` alone cannot see it — so the audit
 * whose entire subject is NEW tests was blind to exactly the files being added.
 * A builder ran it locally, got a clean table, pushed, and CI failed on the
 * sleep in the file they had just written: CI checks out the commit, where the
 * file IS tracked. The gate was reporting on a different set of files than the
 * one it was defending.
 *
 * `--exclude-standard` keeps .gitignore honoured, so build output and local
 * scratch files stay out.
 *
 * Files are then filtered to those that exist on disk: `git ls-files` still
 * lists a tracked file that has been deleted in the working tree, and reading
 * one throws ENOENT and takes down the whole audit.
 */
function gitFiles(...globs: string[]): string[] {
  const tracked = lsFiles([], globs);
  const untracked = lsFiles(['--others', '--exclude-standard'], globs);
  return [...new Set([...tracked, ...untracked])]
    .filter((rel) => existsSync(join(repoRoot, rel)))
    .sort();
}

const read = (rel: string): string[] => readFileSync(join(repoRoot, rel), 'utf8').split('\n');

const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

/**
 * A `// timed:` marker exempts a wait. It may sit on the line itself or
 * anywhere in the contiguous comment block directly above it, so the marker
 * can be written next to the sentence that explains the window.
 */
function isTimed(lines: string[], i: number): boolean {
  if (/\/\/\s*timed:/.test(lines[i] ?? '')) return true;
  for (let j = i - 1; j >= 0 && COMMENT_LINE.test(lines[j] ?? ''); j--) {
    if (/timed:/.test(lines[j] ?? '')) return true;
  }
  return false;
}

// 1. Fixed sleeps of 500ms or more in the server suite.
//    Matches `sleep(N)` and `setTimeout(fn, N)`, where N is a literal OR the
//    name of a millisecond constant declared in the same file. Resolving names
//    matters: 16 waits of 2400ms hid behind one `SETTLE_MS` and this check
//    reported zero while they ran.
const SLEEP =
  /(?:\bsleep\(\s*([\w$]+)\s*\)|\bsetTimeout\(\s*[A-Za-z_$][\w$]*\s*,\s*([\w$]+)\s*\))/g;
const MS_CONST = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*(\d[\d_]*)\s*;/;

/** Millisecond constants declared in a file, so `sleep(SETTLE_MS)` resolves. */
function msConstants(lines: string[]): Map<string, number> {
  const found = new Map<string, number>();
  for (const line of lines) {
    const m = line.match(MS_CONST);
    if (m?.[1] && m[2]) found.set(m[1], Number(m[2].replace(/_/g, '')));
  }
  return found;
}

function fixedSleeps(): Check {
  const sites: Site[] = [];
  for (const file of gitFiles('packages/server/test/*.ts')) {
    const lines = read(file);
    const consts = msConstants(lines);
    lines.forEach((text, i) => {
      // A sleep NAMED in a comment is prose, not a wait.
      if (COMMENT_LINE.test(text)) return;
      for (const m of text.matchAll(SLEEP)) {
        const raw = m[1] ?? m[2] ?? '';
        // `.replace` matters: `setTimeout(r, 15_000)` is a legal literal, and
        // `Number('15_000')` is NaN — which read as "below the threshold" and
        // hid the single slowest wait in the suite for a whole conversion pass.
        const ms = /^\d/.test(raw)
          ? Number(raw.replace(/_/g, ''))
          : (consts.get(raw) ?? Number.NaN);
        if (ms >= 500 && !isTimed(lines, i)) sites.push({ file, line: i + 1, text: text.trim() });
      }
    });
  }
  return {
    id: 'fixedSleeps',
    title: 'fixed sleeps >= 500ms (server suite)',
    pattern:
      'sleep(N) or setTimeout(fn, N) with N >= 500 — N literal or a ms constant declared in the same file — without a `// timed:` marker',
    sites,
  };
}

// 2. Source-shape tests: a test that reads a source, bundle or stylesheet file
//    from the repo and asserts on its text. Counted as read sites, in test
//    files that also carry at least one string assertion.
const SOURCE_READ =
  /(?:readFileSync|readFile|Bun\.file)\(\s*(?:[^)]*?)(?:['"`][^'"`]*(?:\/src\/|\/dist\/|\.css|\.js)['"`]|['"`][^'"`]*packages\/plugin[^'"`]*['"`])/;
const TEXT_ASSERT = /expect\([^\n]*\)\s*(?:\.not)?\.(?:toContain|toMatch)\(/;
function sourceShape(): Check {
  const sites: Site[] = [];
  for (const file of gitFiles('*.test.ts', '*.test.tsx')) {
    const lines = read(file);
    if (!lines.some((l) => TEXT_ASSERT.test(l))) continue;
    lines.forEach((text, i) => {
      if (SOURCE_READ.test(text)) sites.push({ file, line: i + 1, text: text.trim() });
    });
  }
  return {
    id: 'sourceShape',
    title: 'source-shape reads (all suites)',
    pattern:
      'readFileSync/Bun.file of a path under src/ or dist/, or a .css/.js/plugin file, in a test that asserts with toContain/toMatch',
    sites,
  };
}

// 3. Wall-clock assertions: an elapsed-time delta asserted against a number.
const CLOCK_DELTA =
  /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=[^\n]*(?:Date|performance)\.now\(\)\s*[-+]/;
const CLOCK_IN_EXPECT = /expect\([^\n]*(?:Date|performance)\.now\(\)/;
function wallClock(): Check {
  const sites: Site[] = [];
  for (const file of gitFiles('*.test.ts', '*.test.tsx')) {
    const lines = read(file);
    const deltas = new Set<string>();
    for (const l of lines) {
      const m = l.match(CLOCK_DELTA);
      if (m?.[1]) deltas.add(m[1]);
    }
    lines.forEach((text, i) => {
      const named = [...deltas].some((d) =>
        new RegExp(`expect\\(\\s*${d}\\s*\\)\\s*\\.(?:not\\.)?to`).test(text),
      );
      if (named || CLOCK_IN_EXPECT.test(text)) sites.push({ file, line: i + 1, text: text.trim() });
    });
  }
  return {
    id: 'wallClock',
    title: 'wall-clock assertions (all suites)',
    pattern:
      'expect() on a Date.now()/performance.now() value or on a variable assigned from a now() delta',
    sites,
  };
}

const checks = [fixedSleeps(), sourceShape(), wallClock()];
const counts = Object.fromEntries(checks.map((c) => [c.id, c.sites.length]));

if (process.argv.includes('--write')) {
  const body = {
    _comment:
      'Ratchet for bun run test:audit. Counts may only go down. Lower a number in the same commit that lowers the count.',
    ...counts,
  };
  writeFileSync(baselinePath, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`wrote ${baselinePath}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, number>;

if (process.argv.includes('--list')) {
  for (const c of checks) {
    console.log(`\n# ${c.title}`);
    for (const s of c.sites) console.log(`  ${s.file}:${s.line}  ${s.text.slice(0, 110)}`);
  }
  console.log('');
}

const rows = checks.map((c) => {
  const max = baseline[c.id];
  const over = typeof max !== 'number' || c.sites.length > max;
  return { c, max, over };
});

const w = Math.max(...checks.map((c) => c.title.length));
console.log(`${'check'.padEnd(w)}  count  baseline  status`);
console.log('-'.repeat(w + 26));
for (const { c, max, over } of rows) {
  const status = over ? 'OVER' : c.sites.length < (max ?? 0) ? 'under (lower it)' : 'ok';
  console.log(
    `${c.title.padEnd(w)}  ${String(c.sites.length).padStart(5)}  ${String(max ?? '-').padStart(8)}  ${status}`,
  );
}

const failed = rows.filter((r) => r.over);
if (failed.length > 0) {
  console.error('\nOver the ratchet:');
  for (const { c, max } of failed) {
    console.error(`  ${c.id}: ${c.sites.length} > ${max ?? 'no baseline'} — matches ${c.pattern}`);
    for (const s of c.sites.slice(0, 20))
      console.error(`    ${s.file}:${s.line}  ${s.text.slice(0, 100)}`);
  }
  console.error('\nFix the new sites, or run with --list to see all of them.');
  console.error('See .claude/rules/testing-standards.md for what each check stands in for.');
  process.exit(1);
}
console.log('\nAll checks at or under the ratchet.');
