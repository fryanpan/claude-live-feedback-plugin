/**
 * CI must go red when a server test fails — and it must LOOK at the server
 * suite even when something else in the run is already red.
 *
 * This is the only gate in the repo whose subject is a YAML file, so no other
 * test can assert it. It exists because of the shape `bun run test` has:
 * `test:vitest && test:server`. The `&&` is right for a terminal and wrong
 * for CI, where it means a red client suite short-circuits the server suite
 * out of the run entirely. Nothing then reports on the server suite, so a
 * server regression that lands beside an unrelated client failure costs a
 * whole extra gate cycle to discover — the failure mode this repo already
 * pays for in parallel-worktree dispatch.
 *
 * WHAT CHANGED WHEN CI WAS SPLIT INTO JOBS. The two suites used to be two
 * steps of one job, and the server step carried `if: ${{ !cancelled() }}` so
 * that a red client step could not skip it. They are separate JOBS now, which
 * gives the same guarantee structurally: GitHub starts a job when its `needs`
 * are satisfied, and neither suite is in the other's. So this file no longer
 * looks for that `if:` — it asserts the property the `if:` was buying, which
 * is that one suite going red cannot stop the other from running or reporting.
 * Checking for the old `if:` on the new shape would have passed vacuously on
 * a job that never had one.
 *
 * What it does NOT claim: it is a check on the workflow's shape, not proof
 * that a runner behaves. The behavioural control is run by hand and recorded
 * in the PR — break one server test, run the script, watch it exit non-zero.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW = join(import.meta.dir, '..', '..', '..', '.github', 'workflows', 'ci.yml');

/** The lines of one top-level job block, `jobs:` two-space keys. */
function jobBlock(yaml: string, jobName: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `  ${jobName}:`);
  expect(start, `ci.yml has no job named ${jobName}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every top-level job name, in file order. */
function jobNames(yaml: string): string[] {
  const lines = yaml.split('\n');
  const start = lines.indexOf('jobs:');
  expect(start, 'ci.yml has no `jobs:` block').toBeGreaterThanOrEqual(0);
  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = line.match(/^ {2}([\w.-]+):\s*$/);
    if (m?.[1]) names.push(m[1]);
  }
  expect(names.length, 'ci.yml declares no jobs').toBeGreaterThan(0);
  return names;
}

/** Every `run:` payload in a block, one entry per step (block scalars joined). */
function runPayloads(block: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < block.length; i++) {
    const inline = /^\s*run:\s*(?!\|)(\S.*)$/.exec(block[i] ?? '');
    if (inline) {
      out.push(inline[1] ?? '');
      continue;
    }
    if (!/^\s*run:\s*\|/.test(block[i] ?? '')) continue;
    const body: string[] = [];
    for (let j = i + 1; j < block.length; j++) {
      const line = block[j] ?? '';
      if (line.trim() !== '' && !/^\s{10,}/.test(line)) break;
      body.push(line);
    }
    out.push(body.join('\n'));
  }
  return out;
}

/** The jobs whose steps run `bun run <token>`. */
function jobsRunning(yaml: string, token: RegExp): string[] {
  return jobNames(yaml).filter((name) =>
    runPayloads(jobBlock(yaml, name)).some((r) => token.test(r)),
  );
}

/** What a job declares in `needs:`, in either the list or the inline form. */
function needsOf(block: string[]): string[] {
  const line = block.find((l) => /^\s{4}needs:/.test(l));
  if (!line) return [];
  return (line.split('needs:')[1] ?? '')
    .replace(/[[\]]/g, ' ')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe('the CI server gate', () => {
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const serverJobs = jobsRunning(yaml, /\bbun run test:server\b/);
  const clientJobs = jobsRunning(yaml, /\bbun run test:vitest\b/);

  it('runs the server suite in a step of its own', () => {
    expect(
      serverJobs,
      'no job in ci.yml runs `bun run test:server`, so nothing in CI reads ' +
        'packages/server/test on its own terms',
    ).toHaveLength(1);
  });

  it('does not reach the server suite through the chained `bun run test`', () => {
    // The shape this branch was written to reject, and the one it used to
    // accept: a single `run: bun run test` step. That script is
    // `test:vitest && test:server`, so a red client suite short-circuits the
    // server suite out of the run and CI reports nothing about it. A guard
    // that treats the regression as a legal alternative is not a guard.
    for (const name of jobNames(yaml)) {
      for (const run of runPayloads(jobBlock(yaml, name))) {
        expect(run, `CI must not run the chained \`bun run test\` (job ${name})`).not.toMatch(
          /\bbun run test\s*(?:$|[\r\n])/,
        );
      }
    }
  });

  it('does not swallow the suite exit code', () => {
    for (const name of [...serverJobs, ...clientJobs]) {
      for (const run of runPayloads(jobBlock(yaml, name))) {
        if (!/bun run test(:server|:vitest)?\b/.test(run)) continue;
        expect(run, `a test step swallows its exit code: ${run}`).not.toMatch(
          /\|\|\s*(true|:)|;\s*true\b|\|\|\s*echo/,
        );
      }
    }
  });

  it('cannot be marked continue-on-error', () => {
    // The one place `continue-on-error` is legitimate in this workflow is the
    // notes-eval smoke job, which spends money and reaches the network. On a
    // suite job it would turn the suite into a suggestion.
    for (const name of [...serverJobs, ...clientJobs]) {
      expect(jobBlock(yaml, name).join('\n'), `${name} is continue-on-error`).not.toMatch(
        /continue-on-error/,
      );
    }
  });

  it('reaches the server suite even when the client suite is already red', () => {
    // The property, not the mechanism: neither suite may be downstream of the
    // other, because a `needs:` edge is a skip when the upstream job fails.
    expect(clientJobs.length, 'no job runs `bun run test:vitest`').toBeGreaterThan(0);
    const [server] = serverJobs;
    expect(server).toBeDefined();
    expect(clientJobs, 'the two suites must not be steps of one job').not.toContain(server);
    expect(
      needsOf(jobBlock(yaml, server as string)),
      'the server suite waits on another job',
    ).toEqual([]);
    for (const client of clientJobs) {
      expect(needsOf(jobBlock(yaml, client)), `${client} waits on another job`).toEqual([]);
    }
  });

  it('does not let a shard of the client suite cancel its siblings', () => {
    // fail-fast defaults to true: one red shard would cancel the rest, and
    // three quarters of the client suite would go unreported behind it.
    for (const client of clientJobs) {
      const block = jobBlock(yaml, client).join('\n');
      if (!/strategy:/.test(block)) continue;
      expect(block, `${client} is a matrix that cancels its siblings on the first failure`).toMatch(
        /fail-fast:\s*false/,
      );
    }
  });
});
