#!/usr/bin/env bun
/**
 * `bun run verify` — every gate CI runs, in one command.
 *
 * WHY THIS EXISTS. CLAUDE.md used to hand builders "the four gates" and list
 * four commands. CI's `verify` job runs fifteen. A builder on PR 744 ran all
 * four, pushed, and went red on `loc:audit` because a doc comment had taken a
 * file from 496 to 504 lines — then ran four more checks by hand, found them
 * clean, and reported that the list was short. It was short by seven.
 *
 * A hand-maintained list of gates drifts the moment somebody adds a CI step.
 * So this file is the list, and `--parity` is the thing that keeps it true:
 * it reads .github/workflows/ci.yml and fails if CI runs a `bun run` that no
 * member here covers, or if a member claims a gate CI does not run. Parity is
 * itself the first member, and it is also a CI step — so the next person to
 * add a gate to CI learns about this file from a red build rather than from
 * a stale paragraph.
 *
 * WHAT IT WILL NOT DO. It will not report a pass while a member failed. Every
 * member's exit code is recorded (a signal-killed member counts as a failure,
 * not as a null that reads like zero), nothing is piped anywhere — `| tail`
 * would replace the member's status with tail's — and the process exits
 * non-zero if any member did. Output is INHERITED, not captured: a failing
 * member prints its own diagnostics to your terminal exactly as it would if
 * you had run it yourself, and the summary at the end is an index into that
 * scrollback, never a replacement for it.
 *
 * ORDER. CI's order is not this order. CI runs the suites in jobs of their
 * own because its steps are its own report; here the members are sorted
 * cheapest-first, so a broken `loc:audit` costs twenty seconds instead of
 * seven minutes. What is enforced is identical — parity checks the SET, not
 * the sequence. The one ordering that is not cosmetic is the last three:
 * `test:vitest` and `test:server` run UNDER coverage instrumentation and
 * leave their lcov in `.coverage/`, and `coverage` then ratchets what they
 * left. The suites used to run twice — once plain, once again inside the
 * coverage step — which was half of this command's wall clock and all of
 * CI's; each now runs once and answers both questions.
 *
 * PARITY ACROSS JOBS. ci.yml is four jobs now (`gates`, `client`, `server`,
 * `coverage`) plus the note-taking slice. `--parity` reads all of them except
 * the ones named in NON_GATE_JOBS, so a gate added to a NEW job is covered by
 * the same check that covers a gate added to an old one — a parity check
 * pinned to one job name would have gone quietly vacuous the moment CI was
 * split.
 *
 *   bun run verify                  every member, ~4 min, all failures reported
 *   bun run verify --bail           stop at the first failure
 *   bun run verify --only lint,typecheck
 *   bun run verify --list           print the members and exit
 *   bun run verify --parity         only the CI-parity check (instant)
 *   bun run verify --base <ref>     base for the two diff-against-base gates
 */
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `import.meta.url`, not `import.meta.dir`: the colocated test runs under
// vitest, where `import.meta.dir` is undefined and module load throws.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CI_WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

/** One gate. `ci` is the `bun run <token>` in ci.yml that this member covers. */
export interface Member {
  id: string;
  /** What it catches, in one line — printed by `--list` and by the summary. */
  title: string;
  /** Argv after `bun run`. `{base}` is substituted with the --base ref. */
  argv: string[];
  /** The token after `bun run` in ci.yml, or null for a local-only member. */
  ci: string | null;
}

/**
 * The gates, cheapest first. Every `bun run` in ci.yml's `verify` job is here
 * or in CI_ONLY below — `--parity` is what makes that sentence checkable.
 */
export const MEMBERS: Member[] = [
  { id: 'parity', title: 'this list still matches ci.yml', argv: [], ci: 'verify:parity' },
  {
    id: 'loc:audit',
    title: 'files over 500 lines have a written verdict',
    argv: ['loc:audit'],
    ci: 'loc:audit',
  },
  {
    id: 'check:imports',
    title: 'server.ts → routes/ → everything else',
    argv: ['check:imports'],
    ci: 'check:imports',
  },
  {
    id: 'check:architecture',
    title: 'the overview diagram matches the modules',
    argv: ['check:architecture', '--base', '{base}'],
    ci: 'check:architecture',
  },
  {
    id: 'check:plugin-version',
    title: 'a packages/plugin change bumped the version',
    argv: ['check:plugin-version', '--base', '{base}'],
    ci: 'check:plugin-version',
  },
  {
    id: 'test:audit',
    title: 'the mechanical half of testing-standards.md',
    argv: ['test:audit'],
    ci: 'test:audit',
  },
  { id: 'lint', title: 'biome — formatting, any, unused imports', argv: ['lint'], ci: 'lint' },
  {
    id: 'build:widget',
    title: 'the widget bundle builds',
    argv: ['build:widget'],
    ci: 'build:widget',
  },
  {
    id: 'check:widget-size',
    title: 'the widget stays inside its gzip budget',
    argv: ['check:widget-size'],
    ci: 'check:widget-size',
  },
  {
    id: 'check:build-id',
    title: 'the client build id is reproducible',
    argv: ['check:build-id'],
    ci: 'check:build-id',
  },
  {
    id: 'check:scrub-gate',
    title: 'the leak scanner can still see a planted needle',
    argv: ['check:scrub-gate'],
    ci: 'check:scrub-gate',
  },
  {
    id: 'check:mcp-bundle',
    title: 'the committed MCP bundle matches its source',
    argv: ['check:mcp-bundle'],
    ci: 'check:mcp-bundle',
  },
  {
    id: 'typecheck',
    title: 'tsc --noEmit; no test runner typechecks',
    argv: ['typecheck'],
    ci: 'typecheck',
  },
  // The last three are a chain: both suites run instrumented and write their
  // lcov under .coverage/, and `coverage` reads it back instead of running
  // the suites a second time. `--only coverage` on its own says so rather
  // than measuring whatever an older run left behind.
  {
    id: 'test:vitest',
    title: 'unit + client suites',
    argv: [
      'test:vitest',
      '--coverage.enabled',
      '--coverage.reporter=lcovonly',
      '--coverage.reportsDirectory=.coverage/vitest',
    ],
    ci: 'test:vitest',
  },
  {
    id: 'test:server',
    title: 'server suite — vitest does not run it',
    argv: ['test:server', '--coverage', '--coverage-dir=.coverage/server'],
    ci: 'test:server',
  },
  {
    id: 'coverage',
    title: 'per-package line coverage, ratcheted',
    argv: ['coverage', '--reuse', '--list'],
    ci: 'coverage',
  },
];

/**
 * Jobs in ci.yml that are not part of the verdict, and why. Everything else
 * in the file is read by `--parity`, so a new job's gates are covered without
 * anybody remembering to add its name here.
 */
export const NON_GATE_JOBS: Record<string, string> = {
  'notes-eval-smoke':
    'spends money and reaches the network, runs `continue-on-error`, and skips itself when ' +
    'no key is configured — it reports, it does not gate.',
};

/**
 * Gates CI runs that this command cannot, each with the reason. An entry here
 * is a documented hole, which is the point: it is visible in `--list` instead
 * of being an absence nobody can see.
 */
export const CI_ONLY: Record<string, string> = {
  'scripts/collect-open-pr-versions.ts':
    'asks GitHub what version every OTHER open PR declares — needs a token and a PR number, ' +
    'so the collision half of the version gate is only ever checked on CI.',
};

/**
 * Every `bun run <token>` inside one job of a workflow file.
 *
 * Textual, and narrow on purpose. Only the VALUE of a `run:` counts — both the
 * one-line form and the `run: |` block, whose body is every following line
 * indented past the key. Comments and step names are not commands, and reading
 * them was not a hypothetical: ci.yml's prose names half these gates, and the
 * step this gate added is itself called "Local `bun run verify` covers this
 * job". Scanning whole lines reported that step name as an uncovered gate.
 *
 * The job ends at the next two-space key, which is where the next job starts.
 */
export function ciRunTokens(yaml: string, jobId: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `  ${jobId}:`);
  if (start === -1) throw new Error(`no job \`${jobId}\` in the workflow`);
  const tokens: string[] = [];
  const add = (text: string): void => {
    for (const m of text.matchAll(/\bbun run ([\w:@./-]+)/g)) {
      const token = m[1];
      if (token && !tokens.includes(token)) tokens.push(token);
    }
  };
  let blockIndent: number | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^ {2}\S/.test(line)) break;
    if (blockIndent !== null) {
      const indent = line.search(/\S/);
      if (indent === -1) continue; // a blank line does not end a block scalar
      if (indent > blockIndent) {
        if (!line.trimStart().startsWith('#')) add(line);
        continue;
      }
      blockIndent = null;
    }
    const m = line.match(/^(?:\s*- )?\s*run:(.*)$/);
    if (!m) continue;
    const keyIndent = line.indexOf('run:');
    const value = (m[1] ?? '').trim();
    if (/^[|>][-+]?\d*$/.test(value)) blockIndent = keyIndent;
    else add(value);
  }
  return tokens;
}

/**
 * Every job id in the workflow — the two-space keys under `jobs:`.
 *
 * Enumerated rather than listed, so splitting the verify job into four (or
 * forty) cannot leave a gate unscanned. A `jobs:` key that is not there at
 * all throws: an empty set is the answer that makes parity vacuous.
 */
export function ciJobIds(yaml: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === 'jobs:');
  if (start === -1) throw new Error('no `jobs:` in the workflow');
  const ids: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\S/.test(line)) break; // a top-level key ends the jobs block
    const m = line.match(/^ {2}([\w.-]+):\s*$/);
    if (m?.[1]) ids.push(m[1]);
  }
  if (ids.length === 0) throw new Error('`jobs:` in the workflow has no jobs under it');
  return ids;
}

/**
 * Every `bun run` token in every job that gates a pull request.
 *
 * A name in NON_GATE_JOBS that no longer matches a job is drift too — the
 * exclusion would be silently protecting nothing — so it is reported rather
 * than ignored.
 */
export function ciGateTokens(
  yaml: string,
  excluded: Record<string, string> = NON_GATE_JOBS,
): { tokens: string[]; problems: string[] } {
  const ids = ciJobIds(yaml);
  const problems = Object.keys(excluded)
    .filter((id) => !ids.includes(id))
    .map(
      (id) =>
        `NON_GATE_JOBS excuses a job \`${id}\` that ci.yml does not have.\n` +
        '    Either the job was renamed, or the entry is stale — drop it.',
    );
  const tokens: string[] = [];
  for (const id of ids) {
    if (id in excluded) continue;
    for (const token of ciRunTokens(yaml, id)) if (!tokens.includes(token)) tokens.push(token);
  }
  return { tokens, problems };
}

/** Everything that makes MEMBERS and ci.yml disagree, as printable lines. */
export function parityProblems(members: Member[], ciTokens: string[]): string[] {
  const claimed = new Set(members.map((m) => m.ci).filter((c): c is string => c !== null));
  const problems: string[] = [];
  for (const token of ciTokens) {
    if (claimed.has(token) || token in CI_ONLY) continue;
    problems.push(
      `ci.yml runs \`bun run ${token}\` and no member of MEMBERS covers it.\n` +
        '    Add it to MEMBERS in scripts/verify.ts, or to CI_ONLY with the reason it cannot run locally.',
    );
  }
  for (const token of claimed) {
    if (ciTokens.includes(token)) continue;
    problems.push(
      `MEMBERS claims \`bun run ${token}\` is a CI gate, and ci.yml's verify job does not run it.\n` +
        `    Either CI lost a step, or the member's \`ci\` field should be null.`,
    );
  }
  return problems;
}

/** The parity member, as a member: 0 when the two agree. */
export function runParity(): number {
  const { tokens, problems: jobProblems } = ciGateTokens(readFileSync(CI_WORKFLOW, 'utf8'));
  const problems = [...jobProblems, ...parityProblems(MEMBERS, tokens)];
  if (problems.length === 0) {
    console.log(
      `✓ every gate in ci.yml (${ciJobIds(readFileSync(CI_WORKFLOW, 'utf8')).length} job(s)) is a member of \`bun run verify\`.`,
    );
    return 0;
  }
  for (const p of problems) console.error(`  ✗ ${p}`);
  return 1;
}

export interface Result {
  member: Member;
  exitCode: number;
  ms: number;
}

/**
 * Run the members in order and report every one.
 *
 * `exec` returns the member's exit code. A member that never produced one —
 * killed by a signal — is a FAILURE, not a zero: the whole value of this
 * command is that it cannot report a pass over a member that did not pass.
 */
export function runMembers(
  members: Member[],
  exec: (m: Member) => number | null,
  opts: { bail?: boolean; now?: () => number } = {},
): Result[] {
  const now = opts.now ?? (() => Date.now());
  const results: Result[] = [];
  for (const member of members) {
    const started = now();
    const code = exec(member);
    results.push({ member, exitCode: code ?? 1, ms: now() - started });
    if (opts.bail && (code ?? 1) !== 0) break;
  }
  return results;
}

/** Non-zero when any member did not pass. */
export function overallExit(results: Result[]): number {
  return results.some((r) => r.exitCode !== 0) ? 1 : 0;
}

function printSummary(results: Result[], total: number): void {
  const failed = results.filter((r) => r.exitCode !== 0);
  console.log(`\n${'─'.repeat(72)}`);
  for (const r of results) {
    const mark = r.exitCode === 0 ? '✓' : '✗';
    const secs = `${(r.ms / 1000).toFixed(1)}s`.padStart(7);
    console.log(`  ${mark} ${secs}  ${r.member.id.padEnd(22)} ${r.member.title}`);
  }
  const ran = results.length;
  if (ran < total) console.log(`    (${total - ran} member(s) not run — --bail stopped the run)`);
  console.log('─'.repeat(72));
  if (failed.length === 0) {
    console.log(`✅ ${ran} gate(s) passed. This is the set CI runs.`);
    return;
  }
  console.log(
    `❌ ${failed.length} of ${ran} gate(s) failed: ${failed.map((f) => f.member.id).join(', ')}`,
  );
  console.log('   Their output is above, in full. Re-run one with:');
  console.log(`     bun run verify --only ${failed.map((f) => f.member.id).join(',')}`);
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function main(): void {
  const argv = process.argv.slice(2);
  const base = flagValue(argv, '--base') ?? 'origin/main';

  if (argv.includes('--parity')) process.exit(runParity());

  if (argv.includes('--list')) {
    for (const m of MEMBERS) console.log(`  ${m.id.padEnd(22)} ${m.title}`);
    for (const [token, why] of Object.entries(CI_ONLY)) {
      console.log(`\n  CI-only: bun run ${token}\n    ${why}`);
    }
    for (const [job, why] of Object.entries(NON_GATE_JOBS)) {
      console.log(`\n  not a gate: ci.yml job \`${job}\`\n    ${why}`);
    }
    process.exit(0);
  }

  const only = flagValue(argv, '--only');
  const wanted = only ? new Set(only.split(',').map((s) => s.trim())) : null;
  const members = wanted ? MEMBERS.filter((m) => wanted.has(m.id)) : MEMBERS;
  if (wanted) {
    const unknown = [...wanted].filter((id) => !MEMBERS.some((m) => m.id === id));
    if (unknown.length > 0) {
      console.error(`unknown member(s): ${unknown.join(', ')} — see bun run verify --list`);
      process.exit(2);
    }
  }

  // A suite in this run rewrites its lcov, so anything already in .coverage
  // is from a previous run — and `coverage --reuse` would ratchet it without
  // a word. Cleared here rather than by the suites, because a run of
  // `--only coverage` is deliberately reading what a previous run left.
  if (members.some((m) => m.id === 'test:vitest' || m.id === 'test:server')) {
    rmSync(join(REPO_ROOT, '.coverage'), { recursive: true, force: true });
  }

  const needsBase = members.some((m) => m.argv.includes('{base}'));
  if (needsBase) {
    const ref = Bun.spawnSync(['git', 'rev-parse', '--verify', `${base}^{commit}`], {
      cwd: REPO_ROOT,
    });
    if (ref.exitCode !== 0) {
      console.error(`❌ --base ${base} does not resolve. Fetch it, or pass --base <ref>.`);
      process.exit(2);
    }
  }

  console.log(`Running ${members.length} gate(s) — the set .github/workflows/ci.yml runs.\n`);
  const results = runMembers(
    members,
    (m) => {
      console.log(`\n▶ ${m.id} — ${m.title}`);
      if (m.id === 'parity') return runParity();
      const args = m.argv.map((a) => (a === '{base}' ? base : a));
      // stdio inherited: the member writes straight to this terminal. Nothing
      // is captured, summarised or piped, so its own diagnostics survive whole.
      const proc = Bun.spawnSync(['bun', 'run', ...args], {
        cwd: REPO_ROOT,
        stdio: ['inherit', 'inherit', 'inherit'],
      });
      return proc.exitCode;
    },
    { bail: argv.includes('--bail') },
  );

  printSummary(results, members.length);
  process.exit(overallExit(results));
}

if (import.meta.main) main();
