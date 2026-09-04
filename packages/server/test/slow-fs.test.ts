/**
 * The gate in front of a bound file's read: deadline, quarantine, bound.
 *
 * `hydrate-wedge.test.ts` proves the server survives a stalled file end to
 * end. This one drives the three rules that make that true, so a change to
 * any of them fails here with a name rather than there with a timeout.
 *
 * The stalled path in every case is a FIFO with no writer: `stat` answers,
 * `open` blocks until somebody opens the other end, and nothing in this file
 * ever does. Paths and contents are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOUND_READ_DEADLINE_MS,
  BOUND_READ_MAX_INFLIGHT,
  BOUND_READ_RETRY_MS,
  boundFiles,
} from '../src/slow-fs.ts';

describe('boundFiles', () => {
  let scratch: string;
  let stalled: string;
  let readable: string;

  beforeEach(() => {
    boundFiles.reset();
    scratch = mkdtempSync(join(tmpdir(), 'slow-fs-'));
    stalled = join(scratch, 'stalled.md');
    readable = join(scratch, 'readable.md');
    execFileSync('mkfifo', [stalled]);
    writeFileSync(readable, '# Readable\n');
  });

  afterEach(() => {
    boundFiles.reset();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('reads a healthy file and hands the bytes to the next caller once', async () => {
    const res = await boundFiles.read(readable);
    expect(res).toMatchObject({ status: 'ok', exists: true, text: '# Readable\n' });
    // The handoff `prewarmHydration` relies on: the hydrate that follows gets
    // the bytes without opening the file.
    expect(boundFiles.takeFresh(readable)?.exists).toBe(true);
    // Consumed, so a later unrelated hydrate reads the file itself.
    expect(boundFiles.takeFresh(readable)).toBeUndefined();
  });

  it('reports a file that is not there as gone, not as unavailable', async () => {
    // ENOENT is an answer. Treating it as a stall would quarantine every
    // deleted worktree for a minute.
    const res = await boundFiles.read(join(scratch, 'never-written.md'));
    expect(res).toEqual({ status: 'ok', exists: false });
    expect(boundFiles.quarantined(join(scratch, 'never-written.md'))).toBe(false);
  });

  it('gives up on a file that never answers, and quarantines it', async () => {
    expect(boundFiles.quarantined(stalled)).toBe(false);
    const res = await boundFiles.read(stalled);
    expect(res).toEqual({ status: 'unavailable', reason: 'timeout' });
    expect(boundFiles.quarantined(stalled)).toBe(true);
  });

  it('refuses the second attempt outright instead of paying the deadline again', async () => {
    await boundFiles.read(stalled);
    // The reconnect loop that turned one stalled file into twenty-one
    // restarts: this attempt must cost nothing and start no syscall.
    const second = await boundFiles.read(stalled);
    expect(second).toEqual({ status: 'unavailable', reason: 'backoff' });
    // Still only ONE leaked read, from the first attempt.
    expect(boundFiles.stats().leaked).toBe(1);
  });

  it('leaks at most BOUND_READ_MAX_INFLIGHT pool threads to a stalled folder', async () => {
    // Distinct paths, so the quarantine cannot be what stops them — the
    // inflight bound has to. Without it a folder full of stalled files would
    // take every other async read in the process down with it.
    const paths = Array.from({ length: BOUND_READ_MAX_INFLIGHT + 3 }, (_, i) => {
      const p = join(scratch, `stall-${i}.md`);
      execFileSync('mkfifo', [p]);
      return p;
    });
    const results = await Promise.all(paths.map((p) => boundFiles.read(p)));
    const busy = results.filter((r) => r.status === 'unavailable' && r.reason === 'busy');
    const timedOut = results.filter((r) => r.status === 'unavailable' && r.reason === 'timeout');
    expect(timedOut.length).toBe(BOUND_READ_MAX_INFLIGHT);
    expect(busy.length).toBe(3);
    expect(boundFiles.stats().leaked).toBe(BOUND_READ_MAX_INFLIGHT);
  });

  it('leaves a healthy file readable while another path is stalled', async () => {
    // The whole point: one bad path must not close the door on the rest.
    const [bad, good] = await Promise.all([boundFiles.read(stalled), boundFiles.read(readable)]);
    expect(bad.status).toBe('unavailable');
    expect(good).toMatchObject({ status: 'ok', exists: true });
  });

  it('states its constants, because callers reason about them', () => {
    // Not decoration: `hydrate-wedge.test.ts` waits under the deadline and the
    // backoff is the difference between one doomed read and one per reconnect.
    expect(BOUND_READ_DEADLINE_MS).toBe(3_000);
    expect(BOUND_READ_RETRY_MS).toBe(60_000);
  });
});
