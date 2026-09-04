/**
 * Name resource contention instead of letting it read as a test failure.
 *
 * Two exhaustions, not one. A process runs out of FILE DESCRIPTORS (EMFILE /
 * ENFILE), and the machine runs out of TCP PROTOCOL CONTROL BLOCKS (ENOBUFS)
 * — the kernel-wide table every socket needs an entry in. They are separate
 * limits with separate probes, and the second one is why this comment was
 * rewritten: on 2026-09-04 ten server tests went red on this machine, and
 * the arbiter below cleared the run because opening a regular file still
 * worked. `sysctl net.inet.tcp.pcbcount` read 162,260 against 852 sockets
 * anything could enumerate, and a `socket()` canary returned ENOBUFS
 * continuously for the 52 minutes up to the reboot that cleared it. Every
 * failing test was a socket test — seven SSE wake tests, two SSE review-link
 * tests, one meeting WebSocket — and none of them could say so. The reboot
 * took the table from 162,183 to 684 and the same ten tests passed untouched,
 * after a morning of builders bisecting diffs that were never at fault.
 *
 * So the file probe stays and a socket probe joins it. Opening `/dev/null`
 * allocates no protocol control block, so it cannot see ENOBUFS by
 * construction; a listener on 127.0.0.1:0 allocates one and gives it back.
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
 * darwin FSEvents smoke test in dispatch-registry.test.ts also calls
 * fdContentionError and otherTestRunnerCount directly to pick its timeout
 * wording.
 */
import { execSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

/** Exhaustion codes: the first two are per-process, the rest kernel-wide. */
const SOCKET_EXHAUSTION_CODES = new Set(['EMFILE', 'ENFILE', 'ENOBUFS', 'ENOMEM']);

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

/**
 * Open and immediately release one TCP listener, the cheapest thing that
 * makes the kernel allocate a protocol control block and hand it back.
 * Measured at ~18us per cycle on this machine, so the whole server suite
 * pays under 100ms for the probe.
 */
function openAndCloseListener(): void {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  server.stop(true);
}

/**
 * An Error naming socket-table contention when the machine cannot allocate
 * one more socket, null when it can.
 *
 * `open` is injectable so the ENOBUFS path has a test: exhausting the real
 * kernel table is what took this machine down, and a guard whose failure
 * branch is never exercised is decoration. Any failure other than a known
 * exhaustion code is ignored — this probe accuses nothing it cannot prove.
 */
export function socketContentionError(open: () => void = openAndCloseListener): Error | null {
  try {
    open();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== undefined && SOCKET_EXHAUSTION_CODES.has(code)) {
      return new Error(
        `SOCKET-TABLE CONTENTION (${code}): this machine cannot allocate even one more ` +
          'socket, so every socket test in this run — SSE streams, WebSockets, any fetch — ' +
          'fails for that reason and not because of the diff. Read ' +
          '`sysctl net.inet.tcp.pcbcount`: a count far above the sockets `lsof -nP -i` can ' +
          'list is a leaked protocol-control-block table, which a reboot clears and a re-run ' +
          'does not. Do not bisect a diff against this.',
      );
    }
    return null;
  }
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
