/**
 * Name file-descriptor contention instead of letting it read as a test
 * failure.
 *
 * Parallel worktrees are how this board dispatches, so several suite runs
 * sharing this machine is the normal case, not an accident. When the
 * machine or the process runs out of file descriptors, whatever test
 * happens to be running starts failing on ordinary fs calls with EMFILE —
 * reported 2026-08-31 on a doc-eviction test — and the failure reads like a
 * fault in the diff, sending the agent hunting through changes that are
 * fine. The probe below is the arbiter: if the process cannot open ONE more
 * file descriptor, no red in this run means anything.
 *
 * Wired into every test via fd-contention.preload.ts (bunfig.toml). The
 * darwin FSEvents smoke test in dispatch-registry.test.ts also consults
 * both helpers directly to pick its timeout wording.
 */
import { execSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

/**
 * An Error naming descriptor contention when the process cannot open one
 * more fd, null when headroom exists. Any failure other than exhaustion is
 * ignored — this probe accuses nothing it cannot prove.
 */
export function fdContentionError(): Error | null {
  let fd: number;
  try {
    fd = openSync('/dev/null', 'r');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'EMFILE' || code === 'ENFILE') {
      return new Error(
        `FILE-DESCRIPTOR CONTENTION (${code}): this test process cannot open even one more ` +
          'file descriptor, so failures in this run are exhaustion fallout, not a verdict on ' +
          'the diff. Likely cause: concurrent suite runs in other worktrees (or an fd leak in ' +
          'this run). Re-run `bun test packages/server/test` with no other suite running ' +
          'before believing any red above.',
      );
    }
    return null;
  }
  closeSync(fd);
  return null;
}

/** Matches a test-runner command line: `bun test ...` or a vitest run. */
const RUNNER_RE = /\bbun(?:-[a-z]+)?(?:\.exe)? test\b|\bvitest\b/;

/**
 * Other test-runner processes alive on this machine right now — the
 * concurrent-suite evidence a timeout message can cite. Takes a `ps`
 * dump for tests; reads the live process table otherwise. Best-effort:
 * an unreadable ps reports zero, and zero rivals never blocks anything.
 */
export function otherTestRunnerCount(psOutput?: string): number {
  let out = psOutput;
  if (out === undefined) {
    try {
      out = execSync('ps -Ao pid=,command=', { encoding: 'utf8', timeout: 5_000 });
    } catch {
      return 0;
    }
  }
  let count = 0;
  for (const line of out.split('\n')) {
    const pid = Number.parseInt(line, 10);
    if (!Number.isFinite(pid) || pid === process.pid) continue;
    if (RUNNER_RE.test(line)) count++;
  }
  return count;
}
