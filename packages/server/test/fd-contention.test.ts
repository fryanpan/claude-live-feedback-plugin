/**
 * The suite's answer to concurrent worktree runs: when descriptors run out,
 * the failure must NAME contention (fd-contention.ts, wired into every test
 * by the bunfig preload) rather than surface as a bare EMFILE inside
 * whichever test happened to be running.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fdContentionError, otherTestRunnerCount } from './fd-contention.ts';

const fixture = join(import.meta.dir, 'fixtures', 'fd-exhaust-probe.ts');

describe('fd contention probe', () => {
  it('stays silent while headroom exists', () => {
    expect(fdContentionError()).toBeNull();
  });

  it('names contention when the process is out of descriptors', () => {
    // The injected fault that proves the probe can say no — a child under
    // `ulimit -n 64`, exhausted on purpose. The HARD limit, deliberately:
    // bun raises its soft rlimit to the hard limit at startup, so a
    // lowered soft limit alone does not constrain it (measured 2026-08-31:
    // `ulimit -Sn 64` still allowed 61,436 opens — kern.maxfilesperproc).
    // A probe that cannot fail is decoration, not a guard.
    const out = execFileSync(
      'sh',
      ['-c', `ulimit -n 64; exec "${process.execPath}" run "${fixture}"`],
      { encoding: 'utf8', timeout: 30_000 },
    );
    const parsed = JSON.parse(out.trim().split('\n').at(-1) ?? '{}') as {
      exhausted?: number;
      message?: string | null;
    };
    // Control on the control: exhaustion really happened — the fixture ran
    // out of descriptors before its own safety cap.
    expect(parsed.exhausted).toBeGreaterThan(0);
    expect(parsed.exhausted).toBeLessThan(4096);
    expect(parsed.message).toContain('FILE-DESCRIPTOR CONTENTION');
    expect(parsed.message).toContain('concurrent suite runs');
  });
});

describe('counting rival test runners', () => {
  const dump = (lines: string[]) => lines.join('\n');

  it('counts bun test and vitest processes, nothing else', () => {
    expect(
      otherTestRunnerCount(
        dump([
          '  101 /Users/x/.bun/bin/bun test packages/server/test',
          '  102 node /repo/node_modules/.bin/vitest run',
          '  103 /usr/bin/vim notes.md',
          '  104 bun run scripts/serve.ts',
          '  105 /bin/sh -c ulimit -Sn 64',
        ]),
      ),
    ).toBe(2);
  });

  it('does not count this process itself', () => {
    expect(otherTestRunnerCount(dump([`  ${process.pid} /Users/x/.bun/bin/bun test x`]))).toBe(0);
  });

  it('reads the live process table without throwing', () => {
    // No fixed count: rival suites genuinely may be running — that is the
    // whole premise of this file.
    expect(otherTestRunnerCount()).toBeGreaterThanOrEqual(0);
  });
});
