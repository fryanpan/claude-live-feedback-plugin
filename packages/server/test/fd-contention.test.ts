/**
 * The suite's answer to a machine it is sharing: when descriptors or sockets
 * run out, the failure must NAME the exhaustion (fd-contention.ts, wired into
 * every test by the bunfig preload) rather than surface as a bare EMFILE, or
 * as ten socket tests failing on assertions with no cause given at all.
 */
import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fdContentionError, otherTestRunnerCount, socketContentionError } from './fd-contention.ts';

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

describe('socket-table contention probe', () => {
  const throwing = (code: string) => () => {
    const err = new Error(`listen failed: ${code}`) as NodeJS.ErrnoException;
    err.code = code;
    throw err;
  };

  it('stays silent while the machine can still allocate a socket', () => {
    // The positive control on the real opener: it runs, it returns, and it
    // gives the protocol control block back. Without this the injected
    // faults below could pass against an opener that never worked.
    expect(socketContentionError()).toBeNull();
  });

  it('names socket-table contention on ENOBUFS', () => {
    // ENOBUFS by injection, deliberately. The real fault is a kernel-wide
    // table shared with everything else on the machine, and exhausting it
    // on purpose is what took this machine down on 2026-09-04.
    const err = socketContentionError(throwing('ENOBUFS'));
    expect(err?.message).toContain('SOCKET-TABLE CONTENTION (ENOBUFS)');
    expect(err?.message).toContain('pcbcount');
    expect(err?.message).toContain('Do not bisect a diff against this');
  });

  it('names the other exhaustion codes too', () => {
    for (const code of ['ENFILE', 'EMFILE', 'ENOMEM']) {
      expect(socketContentionError(throwing(code))?.message).toContain(
        `SOCKET-TABLE CONTENTION (${code})`,
      );
    }
  });

  it('accuses nothing on a failure it cannot prove', () => {
    // A refused connection, a bad address, an ordinary throw: none of these
    // are exhaustion, and a probe that reported them would make every real
    // red in the run unreadable behind a false cause.
    expect(socketContentionError(throwing('ECONNREFUSED'))).toBeNull();
    expect(socketContentionError(throwing('EADDRINUSE'))).toBeNull();
    expect(
      socketContentionError(() => {
        throw new Error('no code at all');
      }),
    ).toBeNull();
  });

  it('is a probe the descriptor half cannot stand in for', () => {
    // The gap this file exists to close. Opening a regular file allocates no
    // protocol control block, so the fd probe reports headroom in exactly the
    // state that fails every socket test — which is how ten of them went red
    // under a green arbiter. Same machine, same instant, two answers.
    const socketOut = socketContentionError(throwing('ENOBUFS'));
    expect(socketOut).not.toBeNull();
    expect(fdContentionError()).toBeNull();
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
