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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ROOM_TIMINGS, ROOM_TIMINGS } from '../src/room-timings.ts';
import { BOUND_READ_MAX_OVERDUE, boundFiles } from '../src/slow-fs.ts';
import { makeFifo, releaseFifo, releaseFifosIn } from './fifo.ts';
import { waitFor } from './wait-for.ts';

describe('boundFiles', () => {
  let scratch: string;
  let stalled: string;
  let readable: string;

  beforeEach(() => {
    boundFiles.reset();
    scratch = mkdtempSync(join(tmpdir(), 'slow-fs-'));
    stalled = join(scratch, 'stalled.md');
    readable = join(scratch, 'readable.md');
    makeFifo(stalled);
    writeFileSync(readable, '# Readable\n');
  });

  afterEach(async () => {
    // Every test here parks at least one read in `open`, and each holds a
    // pool thread until it is released. Release them while the pipes still
    // exist — an unlinked pipe cannot be opened, so the reader would stay
    // parked for the life of the process and could stop the runner exiting.
    await releaseFifosIn(scratch);
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

  it('stops starting calls once BOUND_READ_MAX_OVERDUE are parked', async () => {
    // Distinct paths, so the quarantine cannot be what stops them — the
    // overdue bound has to. Without it a folder full of stalled files would
    // take every other async read in the process down with it.
    const first = Array.from({ length: BOUND_READ_MAX_OVERDUE }, (_, i) =>
      makeFifo(join(scratch, `stall-${i}.md`)),
    );
    const results = await Promise.all(first.map((p) => boundFiles.read(p)));
    expect(results.every((r) => r.status === 'unavailable' && r.reason === 'timeout')).toBe(true);
    expect(boundFiles.stats().leaked).toBe(BOUND_READ_MAX_OVERDUE);

    // The pool now holds the bound's worth of threads that will never come
    // back, so the next path is refused before it can take one more.
    const extra = makeFifo(join(scratch, 'stall-extra.md'));
    expect(await boundFiles.read(extra)).toEqual({ status: 'unavailable', reason: 'busy' });
    expect(boundFiles.stats().leaked).toBe(BOUND_READ_MAX_OVERDUE);

    // And the refusal reaches a HEALTHY path too. That is the fact the
    // synchronous callers depend on: `busy` is the state of the gate, not a
    // property of the path in front of it, so a hydrate cannot read "no
    // quarantine on this file" as "safe to open on the main thread". It also
    // leaves no mark behind — nothing about `readable` is quarantined — which
    // is exactly how a `busy` verdict used to fall through to a blocking read.
    expect(boundFiles.busy()).toBe(true);
    expect(await boundFiles.read(readable)).toEqual({ status: 'unavailable', reason: 'busy' });
    expect(boundFiles.quarantined(readable)).toBe(false);
  });

  it('never refuses a healthy file, however many calls are outstanding', async () => {
    // The regression this exists for: the bound used to count calls IN
    // FLIGHT, and `sweepFilePolls` issues one stat per armed binding in a
    // single synchronous loop. Nothing can settle until that loop yields, so
    // on a corpus of any size every binding past the fourth was refused
    // `busy` by its position in a Map — and an external edit to those files
    // went unseen. A healthy call resolves and gives its thread straight
    // back, so nothing about it is worth capping.
    const fanOut = 32;
    const results = await Promise.all(
      Array.from({ length: fanOut }, () => boundFiles.statMtime(readable)),
    );
    expect(results.filter((r) => r.status === 'unavailable')).toEqual([]);
    expect(boundFiles.stats().leaked).toBe(0);
    // The negative control for the busy assertions above: healthy traffic,
    // however much of it, never puts the gate into the refusing state.
    expect(boundFiles.busy()).toBe(false);
  });

  it('leaves a healthy file readable while another path is stalled', async () => {
    // The whole point: one bad path must not close the door on the rest.
    const [bad, good] = await Promise.all([boundFiles.read(stalled), boundFiles.read(readable)]);
    expect(bad.status).toBe('unavailable');
    expect(good).toMatchObject({ status: 'ok', exists: true });
  });

  it('gives the pool thread back when the file finally answers', async () => {
    // The cleanup every test in this file depends on, asserted directly so a
    // platform where it stops working fails here by name rather than by
    // hanging the runner somewhere else.
    const res = await boundFiles.read(stalled);
    expect(res).toEqual({ status: 'unavailable', reason: 'timeout' });
    expect(boundFiles.stats().leaked).toBe(1);
    // A reader is holding the pipe open, which is what `releaseFifo` reports.
    expect(releaseFifo(stalled)).toBe(true);

    // One end-of-file is not always enough: a reader that was still in `open`
    // when the writer closed goes on to block in `read()`. Keep handing it EOF
    // until nothing holds the read end — that is what `releaseFifosIn` does.
    await waitFor(() => (releaseFifo(stalled) ? false : 'nobody is reading it'), {
      describe: 'the parked read to let go of the pipe',
    });
    // And slow-fs agrees the pool thread came back.
    await waitFor(() => (boundFiles.stats().leaked === 0 ? 'given back' : false), {
      describe: 'slow-fs to stop counting the read as parked',
    });
  });

  it('runs on the scaled room cadences, at three seconds and a minute in production', () => {
    // The deadline is a cadence like the write-back and the poll, so it rides
    // the same `CW_TEST_TIMING_SCALE` — otherwise every test here would pay
    // three real seconds and sit two seconds under the runner's own timeout.
    expect(DEFAULT_ROOM_TIMINGS.boundReadDeadlineMs).toBe(3_000);
    expect(DEFAULT_ROOM_TIMINGS.boundReadRetryMs).toBe(60_000);
    // And the suite is genuinely running the scaled ones, not the defaults.
    expect(ROOM_TIMINGS.boundReadDeadlineMs).toBeLessThan(DEFAULT_ROOM_TIMINGS.boundReadDeadlineMs);
  });
});
