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
 *   bun run test:audit            print the table, exit non-zero over baseline
 *   bun run test:audit --list     also print every matching site
 *   bun run test:audit --write    rewrite the baseline to today's counts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const baselinePath = join(repoRoot, 'scripts', 'test-audit.baseline.json');

type Site = { file: string; line: number; text: string };
type Check = { id: string; title: string; pattern: string; sites: Site[] };

function gitFiles(...globs: string[]): string[] {
  const out = Bun.spawnSync(['git', 'ls-files', ...globs], { cwd: repoRoot });
  if (out.exitCode !== 0) throw new Error(`git ls-files failed: ${out.stderr.toString()}`);
  return out.stdout.toString().split('\n').filter(Boolean);
}

const read = (rel: string): string[] => readFileSync(join(repoRoot, rel), 'utf8').split('\n');

/** A `// timed:` marker on the line or the line above exempts a wait. */
function isTimed(lines: string[], i: number): boolean {
  return /\/\/\s*timed:/.test(lines[i] ?? '') || /\/\/\s*timed:/.test(lines[i - 1] ?? '');
}

// 1. Fixed sleeps of 500ms or more in the server suite.
//    Matches `sleep(N)` and `setTimeout(fn, N)` with a literal N >= 500.
const SLEEP = /(?:\bsleep\(\s*(\d+)\s*\)|\bsetTimeout\(\s*[A-Za-z_$][\w$]*\s*,\s*(\d+)\s*\))/g;
function fixedSleeps(): Check {
  const sites: Site[] = [];
  for (const file of gitFiles('packages/server/test/*.ts')) {
    const lines = read(file);
    lines.forEach((text, i) => {
      for (const m of text.matchAll(SLEEP)) {
        const ms = Number(m[1] ?? m[2]);
        if (ms >= 500 && !isTimed(lines, i)) sites.push({ file, line: i + 1, text: text.trim() });
      }
    });
  }
  return {
    id: 'fixedSleeps',
    title: 'fixed sleeps >= 500ms (server suite)',
    pattern: 'sleep(N) or setTimeout(fn, N) with N >= 500, without a `// timed:` marker',
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
