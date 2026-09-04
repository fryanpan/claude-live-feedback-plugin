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

/** The step a `run:` line belongs to, back to its `- name:`/`- run:` marker. */
function stepOf(block: string[], runLineIndex: number): string[] {
  let start = runLineIndex;
  while (start > 0 && !/^\s*- /.test(block[start] ?? '')) start--;
  let end = start + 1;
  while (end < block.length && !/^\s*- /.test(block[end] ?? '')) end++;
  return block.slice(start, end);
}

describe('the CI server gate', () => {
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const verify = jobBlock(yaml, 'verify');

  it('runs the server suite in the verify job', () => {
    const runs = runPayloads(verify);
    const server = runs.filter((r) => /bun run test(:server)?\b/.test(r));
    expect(
      server.length,
      'no step in `verify` runs the server suite — `bun run test:server` (or the ' +
        '`bun run test` script that chains it) must appear, or nothing in CI reads ' +
        'packages/server/test at all',
    ).toBeGreaterThan(0);
  });

  it('does not swallow the suite exit code', () => {
    for (const run of runPayloads(verify)) {
      if (!/bun run test(:server|:vitest)?\b/.test(run)) continue;
      expect(run, `a test step swallows its exit code: ${run}`).not.toMatch(
        /\|\|\s*(true|:)|;\s*true\b|\|\|\s*echo/,
      );
    }
  });

  it('cannot be marked continue-on-error', () => {
    // The one place `continue-on-error` is legitimate in this workflow is the
    // notes-eval smoke job, which spends money and reaches the network. On
    // `verify` it would turn every gate in this file into a suggestion.
    expect(verify.join('\n')).not.toMatch(/continue-on-error/);
  });

  it('reaches the server suite even when the client suite is already red', () => {
    const serverLine = verify.findIndex((l) => /run:.*bun run test:server\b/.test(l));
    if (serverLine === -1) {
      // Single chained `bun run test` step: the server suite is inside the
      // same process, so there is no separate step for a failure to skip.
      // Its own short-circuit is the cost this test documents, not a skip.
      expect(verify.join('\n')).toMatch(/run:\s*bun run test\s*$/m);
      return;
    }
    const clientLine = verify.findIndex((l) => /run:.*bun run test:vitest\b/.test(l));
    if (clientLine === -1 || clientLine > serverLine) return; // nothing ahead of it
    const step = stepOf(verify, serverLine).join('\n');
    expect(
      step,
      'the server suite runs after the client suite in its own step, so a failing ' +
        'client suite would skip it by default. It needs `if: ${{ !cancelled() }}` ' +
        '(or always()) so one CI run still reports on both.',
    ).toMatch(/if:.*(!\s*cancelled\(\)|always\(\))/);
  });
});
