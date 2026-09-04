/**
 * FIFOs, for the tests that need a file whose `open` never returns.
 *
 * A named pipe with no writer is the only portable way to reproduce the
 * 2026-09-04 outage without cloud storage: `stat` answers, `open` blocks until
 * somebody opens the other end. That is exactly what the sick file provider
 * did, and it is what `slow-fs.ts` exists to survive.
 *
 * The catch is that a blocked read owns a thread pool slot until it is
 * released, and the process cannot be relied on to exit while it is held —
 * a test file that walks away from four of them can hang the runner instead
 * of failing it. So every test that opens one closes it here, deterministically:
 * open the pipe for writing (which unblocks the parked reader), close it
 * (which hands the reader EOF), then wait for `slow-fs` to report that it owns
 * no parked read at all. If that wait runs out, this throws with the count
 * rather than letting the suite hang.
 *
 * `O_NONBLOCK` on the write side is what makes it safe to call on a pipe
 * nobody is reading: instead of blocking in turn, the open fails with ENXIO
 * and says so — which is also how the loop below knows when it is done.
 */
import { execFileSync } from 'node:child_process';
import { constants, closeSync, openSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { boundFiles } from '../src/slow-fs.ts';

/** A named pipe at `path`, with nobody on the write end. */
export function makeFifo(path: string): string {
  // No mkfifo in node:fs, and Bun has no equivalent — this is the POSIX tool.
  execFileSync('mkfifo', [path]);
  return path;
}

/**
 * Open the write end of this pipe and close it again, which hands whatever is
 * reading it an end-of-file. Returns whether anybody had it open for reading.
 *
 * `false` (ENXIO) is the terminating condition callers want: no process holds
 * the read end, so the read that was parked on it has finished. It is also the
 * legitimate state for a pipe whose read was refused as busy and never started
 * a syscall at all.
 *
 * ONE open-and-close is not enough on its own. A reader parked in `open`
 * unblocks the moment the writer arrives, and if the writer has already closed
 * by the time that happens the reader goes straight on to block in `read()`
 * with nothing to read. Measured: four parked reads, four successful releases,
 * two readers still blocked. So callers loop — see `releaseFifosIn`.
 */
export function releaseFifo(path: string): boolean {
  let isFifo = false;
  try {
    isFifo = statSync(path).isFIFO();
  } catch {
    return false; // already gone, or was never a pipe
  }
  if (!isFifo) return false;
  try {
    // Succeeds immediately when the read end is open; ENXIO immediately when
    // it is not. Either way it cannot block, which is the whole point.
    closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENXIO') return false;
    throw err;
  }
}

/** How long to keep handing EOF to the pipes in a directory before giving up. */
const RELEASE_BUDGET_MS = 5_000;

/**
 * Release every pipe in `dir` until nothing is reading any of them.
 *
 * Call it in `afterEach`, BEFORE removing the directory: a pipe that has been
 * unlinked can no longer be opened, so a read parked on its inode would stay
 * parked for the life of the process — and a parked read owns a thread pool
 * slot, which can stop the test runner exiting instead of failing it.
 *
 * The condition is per-pipe rather than the global in-flight count on purpose.
 * `bun test` runs every file in one process, so that counter also carries the
 * mtime poll's stats from every other server test; waiting for it to reach
 * zero would fail here for something happening somewhere else entirely.
 */
export async function releaseFifosIn(dir: string): Promise<void> {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const paths = names.map((name) => join(dir, name));
  const deadline = Date.now() + RELEASE_BUDGET_MS;
  let held: string[] = [];
  for (;;) {
    held = paths.filter((path) => releaseFifo(path));
    if (held.length === 0) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Loud, and specific about which pipe. A read that cannot be released has
  // found something real about this platform's pipe semantics, and it has to
  // say so rather than hanging the runner.
  throw new Error(
    `FIFO cleanup failed: still reading ${held.join(', ')} after ${RELEASE_BUDGET_MS}ms of ` +
      'end-of-file. A parked read owns its pool thread until it is released. ' +
      `slow-fs reports ${boundFiles.stats().leaked} parked call(s) process-wide.`,
  );
}
