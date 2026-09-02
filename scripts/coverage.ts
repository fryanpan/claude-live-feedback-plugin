#!/usr/bin/env bun
/**
 * Per-package line coverage, measured and ratcheted.
 *
 * Bryan's bar is 80% line coverage per package, or the gap listed per file.
 * This script is the half that makes the number real: it runs both coverage
 * tools, joins their output, prints a table anyone can read in a CI log, and
 * fails when a package falls below the floor recorded in
 * `scripts/coverage.baseline.json`.
 *
 *   bun run coverage           measure, print, exit non-zero below baseline
 *   bun run coverage --list    also list the least-covered files per package
 *   bun run coverage --write   rewrite the baseline to today's numbers
 *   bun run coverage --reuse   parse the last run's lcov instead of re-running
 *
 * ## Two tools, because there are two runners
 *
 * `vitest run` and `bun test packages/server/test` are separate gates and
 * neither can see the other's suite, so neither can measure the other's
 * sources. Each package is therefore assigned to exactly ONE runner (see
 * `PACKAGES`) and read only from that runner's lcov. `@feedback/core` is
 * additionally exercised by the server suite, so its number here is a floor
 * rather than the whole truth — attributing it twice would mean adding two
 * different instrumenters' line sets together, which is not a percentage of
 * anything.
 *
 * ## The floor is today's number, not 80%
 *
 * A threshold nobody currently meets is a red build, and a red build that is
 * always red gets ignored — so the baseline is the measured number rounded
 * down, and the gate is "do not go backwards". `--list` prints the distance
 * to 80% per file so the gap can be worked down deliberately.
 *
 * ## What a file that no test ever imports counts as
 *
 * Neither tool reports a file it never loaded. Vitest is told `all: true`, so
 * it instruments the whole source tree; bun has no such option, and a handful
 * of server modules are imported by no test at all. Those are counted at zero
 * hits over their CODE lines — non-blank, outside a block comment — which is
 * an approximation of the instrumentable-line count the tools report for
 * everything else. It errs low, which is the safe direction for a floor, and
 * `--list` marks each one `never-imported` so it is never mistaken for a
 * measured 0%.
 */
// `node:child_process`, not `Bun.spawnSync`: the colocated test runs under
// vitest, where the `Bun` global does not exist and module load throws.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, '.coverage');
const BASELINE = join(REPO_ROOT, 'scripts', 'coverage.baseline.json');
/** Bryan's bar. Reported against, never enforced — see the header. */
export const TARGET_PCT = 80;

type Runner = 'vitest' | 'bun';
const PACKAGES: Record<string, Runner> = {
  core: 'vitest',
  'markdown-app': 'vitest',
  mcp: 'vitest',
  widget: 'vitest',
  server: 'bun',
};

/**
 * Entrypoints and declaration files: a process's `main`, not a unit.
 *
 * `server-deps.ts` is the other half of `bin.ts`'s main. Every line in it
 * constructs a REAL adapter — the Keychain read, the metered transcription
 * session, this machine's plugin cache, the launchd restart — which is the one
 * thing no test may do; that seam is the reason the file exists. Its sibling
 * `server-config.ts` is deliberately NOT here: it is a pure read of env and
 * argv, so it is tested like anything else.
 */
const EXCLUDED = /(?:\.test\.tsx?|\.d\.ts|\/bin\.ts|\/server-deps\.ts|\/migrate-review-queue\.ts)$/;

export type FileCoverage = { file: string; found: number; hit: number; neverImported: boolean };
export type PackageCoverage = {
  package: string;
  runner: Runner;
  linesFound: number;
  linesHit: number;
  pct: number;
  files: FileCoverage[];
};

// ── lcov ───────────────────────────────────────────────────────────────────

/** `SF:` path → line number → times hit. Later records for one file merge. */
export function parseLcov(text: string): Map<string, Map<number, number>> {
  const files = new Map<string, Map<number, number>>();
  let lines: Map<number, number> | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const file = normalize(line.slice(3));
      lines = files.get(file);
      if (!lines) {
        lines = new Map();
        files.set(file, lines);
      }
    } else if (line.startsWith('DA:') && lines) {
      const [n, hits] = line.slice(3).split(',');
      const num = Number(n);
      if (!Number.isFinite(num)) continue;
      // A line hit by ANY record is hit: two lcov records for one file are
      // two views of the same source, not two different files.
      lines.set(num, Math.max(lines.get(num) ?? 0, Number(hits) || 0));
    } else if (line === 'end_of_record') {
      lines = undefined;
    }
  }
  return files;
}

/** lcov paths arrive absolute from one tool and repo-relative from the other. */
function normalize(p: string): string {
  const rel = p.startsWith('/') ? relative(REPO_ROOT, p) : p;
  return rel.split('\\').join('/');
}

/** Lines that could carry code: non-blank, not inside or opening a comment. */
export function codeLines(text: string): number {
  let n = 0;
  let inBlock = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line === '') continue;
    if (line.startsWith('//')) continue;
    if (line.startsWith('/*')) {
      if (!line.includes('*/')) inBlock = true;
      continue;
    }
    n++;
  }
  return n;
}

// ── measuring ──────────────────────────────────────────────────────────────

function sh(cmd: string[]): void {
  const [bin, ...args] = cmd;
  const res = spawnSync(bin as string, args, { cwd: REPO_ROOT, stdio: 'inherit' });
  // A failing suite is reported by its own gate. Coverage of a red suite is
  // still the coverage that run achieved, and refusing to print it would hide
  // the number behind an unrelated failure.
  if (res.status !== 0) console.error(`\n[coverage] ${cmd[0]} exited ${res.status}\n`);
}

function measure(reuse: boolean): { vitest: string; bun: string } {
  const vitestDir = join(OUT_DIR, 'vitest');
  const bunDir = join(OUT_DIR, 'server');
  if (!reuse) {
    rmSync(OUT_DIR, { recursive: true, force: true });
    mkdirSync(OUT_DIR, { recursive: true });
    sh([
      'bunx',
      'vitest',
      'run',
      '--coverage.enabled',
      '--coverage.reporter=lcovonly',
      `--coverage.reportsDirectory=${vitestDir}`,
    ]);
    sh([
      'bun',
      'test',
      '--coverage',
      '--coverage-reporter=lcov',
      `--coverage-dir=${bunDir}`,
      'packages/server/test',
    ]);
  }
  const read = (dir: string) => {
    const p = join(dir, 'lcov.info');
    if (!existsSync(p)) throw new Error(`no lcov at ${p} — run without --reuse`);
    return readFileSync(p, 'utf8');
  };
  return { vitest: read(vitestDir), bun: read(bunDir) };
}

/** Every source file the bar applies to, from the git tree — not from a
 *  coverage report, which by construction cannot list what it never saw. */
function sourceFiles(pkg: string): string[] {
  return execFileSync('git', ['ls-files', `packages/${pkg}/src`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !EXCLUDED.test(f));
}

export function summarize(lcov: { vitest: string; bun: string }): PackageCoverage[] {
  const parsed = { vitest: parseLcov(lcov.vitest), bun: parseLcov(lcov.bun) };
  return Object.entries(PACKAGES).map(([pkg, runner]) => {
    const measured = parsed[runner];
    const files: FileCoverage[] = [];
    for (const file of sourceFiles(pkg)) {
      const lines = measured.get(file);
      if (lines === undefined) {
        files.push({
          file,
          found: codeLines(readFileSync(join(REPO_ROOT, file), 'utf8')),
          hit: 0,
          neverImported: true,
        });
        continue;
      }
      let hit = 0;
      for (const count of lines.values()) if (count > 0) hit++;
      files.push({ file, found: lines.size, hit, neverImported: false });
    }
    const linesFound = files.reduce((n, f) => n + f.found, 0);
    const linesHit = files.reduce((n, f) => n + f.hit, 0);
    return {
      package: pkg,
      runner,
      linesFound,
      linesHit,
      pct: linesFound === 0 ? 100 : (linesHit / linesFound) * 100,
      files,
    };
  });
}

const pct = (f: FileCoverage) => (f.found === 0 ? 100 : (f.hit / f.found) * 100);

// ── reporting ──────────────────────────────────────────────────────────────

function table(packages: PackageCoverage[], baseline: Record<string, number>): void {
  const w = Math.max(...packages.map((p) => p.package.length), 'package'.length);
  console.log(
    `${'package'.padEnd(w)}  runner  ${'lines'.padStart(11)}  ${'cov'.padStart(6)}  ${'floor'.padStart(5)}  status`,
  );
  console.log('-'.repeat(w + 44));
  for (const p of packages) {
    const floor = baseline[p.package];
    const status =
      typeof floor !== 'number'
        ? 'NO BASELINE'
        : p.pct + 1e-9 < floor
          ? 'BELOW FLOOR'
          : p.pct >= TARGET_PCT
            ? 'ok'
            : `under ${TARGET_PCT}%`;
    console.log(
      `${p.package.padEnd(w)}  ${p.runner.padEnd(6)}  ${`${p.linesHit}/${p.linesFound}`.padStart(11)}  ${`${p.pct.toFixed(1)}%`.padStart(6)}  ${`${floor ?? '-'}`.padStart(5)}  ${status}`,
    );
  }
}

/** The ten least-covered files of a package under the bar, worst first. */
export function worstFiles(p: PackageCoverage, n = 10): FileCoverage[] {
  return p.files
    .filter((f) => f.found > 0 && pct(f) < TARGET_PCT)
    .sort((a, b) => pct(a) - pct(b) || b.found - a.found)
    .slice(0, n);
}

function main(): void {
  const argv = process.argv.slice(2);
  const packages = summarize(measure(argv.includes('--reuse')));

  if (argv.includes('--write')) {
    const body = {
      _comment:
        'Per-package line-coverage floors for `bun run coverage`. Set to the measured number rounded down; a number may only go UP. The bar is 80% (scripts/coverage.ts TARGET_PCT); these are where the packages are today.',
      ...Object.fromEntries(packages.map((p) => [p.package, Math.floor(p.pct)])),
    };
    writeFileSync(BASELINE, `${JSON.stringify(body, null, 2)}\n`);
    writeFileSync(join(OUT_DIR, 'summary.json'), `${JSON.stringify(packages, null, 2)}\n`);
    console.log(`wrote ${BASELINE}`);
    return;
  }

  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>;
  // The machine-readable half, one entry per package, beside the lcov it came
  // from. `files` carries every source file, so a reader can compute any
  // per-file question without re-running anything.
  writeFileSync(join(OUT_DIR, 'summary.json'), `${JSON.stringify(packages, null, 2)}\n`);
  table(packages, baseline);

  for (const p of packages) {
    if (p.pct >= TARGET_PCT && !argv.includes('--list')) continue;
    const worst = worstFiles(p);
    if (worst.length === 0) continue;
    console.log(`\n${p.package} — ten least-covered files (bar is ${TARGET_PCT}%):`);
    for (const f of worst) {
      const note = f.neverImported ? '  never-imported' : '';
      console.log(
        `  ${`${pct(f).toFixed(1)}%`.padStart(6)}  ${`${f.hit}/${f.found}`.padStart(9)}  ${f.file}${note}`,
      );
    }
  }

  const below = packages.filter(
    (p) =>
      typeof baseline[p.package] !== 'number' || p.pct + 1e-9 < (baseline[p.package] as number),
  );
  if (below.length > 0) {
    console.error('\nBelow the floor:');
    for (const p of below) {
      console.error(
        `  ${p.package}: ${p.pct.toFixed(1)}% < ${baseline[p.package] ?? 'no baseline'}`,
      );
    }
    console.error(
      '\nAdd tests, or — if lines were deliberately deleted — lower the floor in the same commit and say why.',
    );
    process.exit(1);
  }
  console.log('\nEvery package at or above its floor.');
}

if (import.meta.main) main();
