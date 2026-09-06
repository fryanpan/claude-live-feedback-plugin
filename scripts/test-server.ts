#!/usr/bin/env bun
/**
 * `bun run test:server` — the server suite, run across several bun processes.
 *
 * WHY THIS EXISTS. `bun test packages/server/test` is one process running 412
 * files one after another: 175 seconds of wall clock for 61 seconds of CPU.
 * Two thirds of that is the suite waiting — on debounce timers, on fs.watch,
 * on SSE round trips — with nothing to run. Waiting parallelises for free, so
 * the same work across four processes finishes in about a minute, and the CI
 * verdict a person is waiting on gets three minutes shorter.
 *
 * WHAT IT DOES NOT CHANGE. The set of files is the same set `bun test` would
 * have found: this walks the directory, so a test file that is not committed
 * yet still runs. (`git ls-files` would not have seen it — that is the hole
 * `coverage` and `test:audit` are documented to have, and it is not repeated
 * here.) Every worker's output is printed in full, grouped by the chunk that
 * produced it, and the run fails if ANY worker did. Nothing is summarised
 * away: a failure prints exactly what bun printed, and the footer names the
 * chunk to re-run.
 *
 *   bun run test:server                      the whole suite
 *   bun run test:server --jobs 1             one process, exactly as before
 *   bun run test:server board doc            only files matching a substring
 *   bun run test:server --coverage --coverage-dir .coverage/server
 *   bun run test:server --shard 2/3          this third of the files only
 *
 * SHARDING vs JOBS. `--jobs` splits across processes on THIS machine and is
 * how the wall clock comes down. `--shard i/n` takes a slice of the files and
 * is for splitting across machines — CI uses neither today; it runs the whole
 * suite with the default job count in one runner. Both compose.
 *
 * COVERAGE. Each CHUNK writes its own lcov — not each worker: bun rewrites
 * `<coverage-dir>/lcov.info` on every run, so a worker pointed at one
 * directory keeps only its last chunk, which is a coverage number quietly
 * measured from a fraction of the suite. They are concatenated into
 * `<dir>/lcov.info` at the end. That is a legitimate merge for this format:
 * `scripts/coverage.ts` takes the MAXIMUM hit count across records for a
 * line, so a line covered in any worker is covered, and a file no worker
 * loaded is still absent — which is what makes it count as zero rather than
 * disappear from the denominator.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SUITE_DIR = 'packages/server/test';

/**
 * What bun test treats as a test file. Mirrors its documented pattern —
 * `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*` over js/jsx/ts/tsx/mjs/cjs —
 * so this enumerator and bun's own discovery agree on the same directory.
 */
export const TEST_FILE = /(?:\.|_)(?:test|spec)\.(?:[cm]?[jt]sx?)$/;

/** Every test file under `dir`, repo-relative, sorted. Filesystem, not git. */
export function discover(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && TEST_FILE.test(entry.name)) out.push(child);
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Deterministic interleave, so neighbouring filenames do not land in one
 * chunk. Alphabetical order clusters a subsystem's slow files together —
 * every `sse-*.test.ts` is adjacent, and they are the slowest files here.
 */
export function interleave(files: string[]): string[] {
  const keyed = files.map((f) => {
    let h = 2166136261;
    for (let i = 0; i < f.length; i++) h = Math.imul(h ^ f.charCodeAt(i), 16777619);
    return { f, h: h >>> 0 };
  });
  keyed.sort((a, b) => a.h - b.h || (a.f < b.f ? -1 : 1));
  return keyed.map((k) => k.f);
}

/** The `i/n` slice of a list, round-robin so slow files spread across shards. */
export function shardOf(files: string[], index: number, total: number): string[] {
  return files.filter((_, i) => i % total === index - 1);
}

/**
 * Guided self-scheduling: a chunk is about 1/2n of what is left, so the first
 * chunks are big (module loading is paid once per chunk) and the last are
 * single files (nobody is left holding a long tail). No weights file to go
 * stale — a suite that changes shape rebalances itself on the next run.
 */
export function nextChunkSize(remaining: number, jobs: number): number {
  return Math.max(1, Math.floor(remaining / (jobs * 2)));
}

/**
 * The chunks, decided BEFORE any of them runs.
 *
 * Which worker picks a chunk up still depends on when it finishes the last
 * one; which files are in a chunk must not. Deciding the split as workers
 * grab from a shared cursor would have made the grouping depend on machine
 * speed, so the same commit would run its tests in different company on two
 * runs — and a file that only passes beside (or apart from) another would
 * fail intermittently, with nothing in the run to say why. Each chunk is its
 * own bun process, so a fixed chunk list is a fixed grouping.
 */
export function planChunks(files: string[], jobs: number): string[][] {
  const chunks: string[][] = [];
  let cursor = 0;
  while (cursor < files.length) {
    const size = nextChunkSize(files.length - cursor, jobs);
    chunks.push(files.slice(cursor, cursor + size));
    cursor += size;
  }
  return chunks;
}

export interface ChunkResult {
  files: string[];
  exitCode: number;
  output: string;
  ms: number;
}

function flagValue(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/** Concatenate every worker's lcov into one. See the header for why that is sound. */
export function mergeLcov(dirs: string[], outDir: string): number {
  const parts: string[] = [];
  for (const dir of dirs) {
    const p = join(dir, 'lcov.info');
    if (existsSync(p)) parts.push(readFileSync(p, 'utf8'));
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'lcov.info'), parts.join(''));
  return parts.length;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jobsFlag = flagValue(argv, '--jobs') ?? process.env.CW_TEST_JOBS;
  const jobs = Math.max(1, Number(jobsFlag) || 4);
  const shard = flagValue(argv, '--shard');
  const coverage = argv.includes('--coverage');
  const coverageDir = flagValue(argv, '--coverage-dir');
  const bail = argv.includes('--bail');

  const consumed = new Set(['--jobs', '--shard', '--coverage', '--coverage-dir', '--bail']);
  const filters = argv.filter((a, i) => {
    if (a.startsWith('--')) return false;
    const prev = argv[i - 1];
    return !(prev !== undefined && consumed.has(prev) && !prev.includes('='));
  });

  let files = interleave(discover(REPO_ROOT, SUITE_DIR));
  if (filters.length > 0) files = files.filter((f) => filters.some((s) => f.includes(s)));
  if (shard) {
    const [i, n] = shard.split('/').map(Number);
    if (!i || !n || i < 1 || i > n) {
      console.error(`--shard wants i/n with 1 <= i <= n; got ${shard}`);
      process.exit(2);
    }
    files = shardOf(files, i, n);
  }
  if (files.length === 0) {
    console.error(
      `no test files under ${SUITE_DIR}${filters.length ? ` matching ${filters.join(', ')}` : ''}`,
    );
    process.exit(1);
  }

  const covRoot = coverageDir ? resolve(REPO_ROOT, coverageDir) : null;
  if (covRoot) rmSync(covRoot, { recursive: true, force: true });

  const label = `${files.length} file(s) across ${jobs} process(es)`;
  console.log(`${SUITE_DIR} — ${label}${shard ? ` (shard ${shard})` : ''}\n`);

  const plan = planChunks(files, jobs);
  let next = 0;
  let failed = false;
  const results: ChunkResult[] = [];
  const chunkDirs = covRoot ? plan.map((_, i) => join(covRoot, `chunk-${i + 1}`)) : [];

  const worker = async (): Promise<void> => {
    for (;;) {
      if (bail && failed) return;
      const index = next++;
      const chunk = plan[index];
      if (chunk === undefined) return;
      const dir = chunkDirs[index] ?? null;
      const args = ['test'];
      if (coverage) {
        args.push('--coverage', '--coverage-reporter=lcov');
        if (dir) args.push(`--coverage-dir=${dir}`);
      }
      const started = Date.now();
      const proc = Bun.spawn(['bun', ...args, ...chunk], {
        cwd: REPO_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const result: ChunkResult = {
        files: chunk,
        exitCode: code,
        output: `${out}${err}`,
        ms: Date.now() - started,
      };
      results.push(result);
      if (code !== 0) failed = true;
      // Flushed whole, when the chunk finishes: four processes writing to one
      // terminal as they go would interleave mid-line and no failure would be
      // attributable to the file that produced it.
      process.stdout.write(result.output);
    }
  };

  const started = Date.now();
  await Promise.all(Array.from({ length: jobs }, () => worker()));
  const ms = Date.now() - started;

  const bad = results.filter((r) => r.exitCode !== 0);

  if (covRoot) {
    const merged = mergeLcov(chunkDirs, covRoot);
    console.log(
      `\ncoverage: merged ${merged} of ${chunkDirs.length} chunk lcov file(s) into ${coverageDir}/lcov.info`,
    );
    // A short merge means the number would be measured from part of the suite,
    // which is the one way this can be wrong without looking wrong. Only worth
    // saying when nothing else failed: a red chunk (or --bail) explains the
    // missing lcov by itself, and a second error on top of it buries the first.
    if (merged !== chunkDirs.length && bad.length === 0 && !bail) {
      console.error(
        `❌ ${chunkDirs.length - merged} chunk(s) produced no lcov — the coverage number would be measured from part of the suite.`,
      );
      process.exit(1);
    }
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log(
    `${SUITE_DIR}: ${files.length} file(s), ${plan.length} chunk(s), ${jobs} process(es), ${(ms / 1000).toFixed(1)}s`,
  );
  if (bad.length === 0) {
    console.log('✅ server suite passed.');
    process.exit(0);
  }
  console.log(`❌ ${bad.length} chunk(s) failed. Their output is above, in full.`);
  for (const r of bad) {
    console.log(`   exit ${r.exitCode}: bun test ${r.files.join(' ')}`);
  }
  process.exit(1);
}

if (import.meta.main) await main();
