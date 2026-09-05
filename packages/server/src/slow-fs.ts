/**
 * Reading a bound file without betting the process on it.
 *
 * Every bound doc points at a path the server does not control. Some of
 * those paths live in a cloud-sync folder whose file provider can stop
 * answering: `open` returns EDEADLK, then EINTR, then simply never returns.
 * `readFileSync` on such a path parks the ONLY thread that runs JavaScript,
 * so a single wedged file stops the server answering anything — the doc it
 * was asked for, every other doc, the health route, all of it. The 2026-09-04
 * outage was exactly that: the SSE subscribe route hydrated a doc, hydration
 * called `readFileSync`, and the main thread sat in `openat` while the
 * supervisor restarted the process twenty-one times, each restart wedging on
 * the same file the moment the client reconnected.
 *
 * The fix is not a faster read, it is a read the main thread can walk away
 * from. `fs.promises` runs the syscall on the thread pool, so racing it
 * against a timer keeps the event loop free even when the syscall never
 * returns. Three rules make that safe to do repeatedly:
 *
 *   - A DEADLINE, so a caller waits a bounded time and then proceeds without
 *     the file.
 *   - A QUARANTINE, so the next caller does not pay the deadline again — a
 *     path that blew it is skipped outright until the backoff expires. This
 *     is what stops a reconnecting subscriber re-arming the stall every
 *     second.
 *   - An OVERDUE BOUND, because a read that never returns never gives its
 *     pool thread back. Once `BOUND_READ_MAX_OVERDUE` calls have blown the
 *     deadline without ever landing, no further call starts until some of
 *     them come back, so a whole stalled folder cannot drain the pool and
 *     take every other async read down with it.
 *
 * This is a gate in front of the syscall, not a layer over the filesystem:
 * callers still decide what a missing or unavailable file means for them. The
 * one thing it holds is the bytes of a read that finished seconds ago, so the
 * hydrate that asked for it can use them instead of opening the file again —
 * consumed on first use, never served twice.
 */
import { readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { ROOM_TIMINGS } from './room-timings.ts';

/**
 * The deadline and the backoff live in `room-timings.ts` with every other
 * cadence a bound doc runs on, and for the same reason: the suite would
 * otherwise spend its wall clock waiting them out. Production values are
 * three seconds and one minute.
 *
 * Three seconds is far above any healthy local or network read (a warm
 * cloud-sync file answers in single-digit milliseconds) and far below the
 * supervisor's own patience, so a stalled file parks its doc without ever
 * looking like a dead server. The minute is aimed at the client that
 * reconnects immediately: without a backoff, every reconnect starts another
 * doomed read and leaks another pool thread.
 */
const DEADLINE_MS = ROOM_TIMINGS.boundReadDeadlineMs;
const RETRY_MS = ROOM_TIMINGS.boundReadRetryMs;

/**
 * How many calls may be OVERDUE — past the deadline and still unlanded —
 * before new ones are refused.
 *
 * This is the leak bound, and it counts the right thing. A read the provider
 * never answers holds its pool thread forever; a read that finishes gives it
 * straight back. So the quantity worth capping is the number of calls that
 * have already proved they are never coming back, not the number in flight.
 *
 * The first version of this file capped in-flight calls at four instead, and
 * that starved the very poll it was meant to protect. `sweepFilePolls` issues
 * one stat per armed binding in a single synchronous loop, so on a corpus of
 * N bound docs all N stats are outstanding the moment the loop ends no matter
 * how fast each one resolves — nothing can settle until the loop yields. The
 * first four won every tick and the rest were refused `busy`, deterministically,
 * by position in a Map. On a fast local disk the next tick usually recovered
 * it; on a slower filesystem it did not, and an external edit to a bound file
 * could go unnoticed indefinitely. Measured on one test file: 1,338 refusals
 * with a warm local stat, 12,448 once each stat was made to take 30ms.
 *
 * Gating on overdue calls instead means healthy traffic is never refused —
 * it cannot be, because a healthy call is never overdue. What remains is the
 * first sweep across a folder that has just gone bad: one call per bound path
 * may enter the pool before the deadline fires. After that the per-path
 * quarantine holds every one of them off for `RETRY_MS`, so the exposure is
 * one call per path per minute, and the main thread blocks through none of it.
 */
export const BOUND_READ_MAX_OVERDUE = 4;

/**
 * How long a completed read stays available to the hydrate that asked for it.
 *
 * The prewarm and the hydrate it feeds are microseconds apart — this window
 * only has to survive the awaits between them, and staying short is what
 * stops it becoming a content cache that could serve a stale file.
 */
export const BOUND_READ_FRESH_MS = 5_000;

export type BoundReadResult =
  | { status: 'ok'; exists: false }
  | { status: 'ok'; exists: true; text: string; mtimeMs: number }
  | { status: 'unavailable'; reason: 'timeout' | 'busy' | 'backoff' | 'error' };

export type BoundStatResult =
  | { status: 'ok'; exists: false }
  | { status: 'ok'; exists: true; mtimeMs: number }
  | { status: 'unavailable'; reason: 'timeout' | 'busy' | 'backoff' | 'error' };

function isEnoent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * A cloud-sync provider refusing to materialize an online-only file.
 *
 * Whether a stalled provider HANGS or fails fast is a property of the
 * process, not the file: with dataless-file materialization off — which is
 * how prod's launchd job runs — the kernel refuses immediately with EDEADLK
 * instead of waiting on the provider. That is an ordinary unreadable file,
 * not a hostile path, so it must not earn the backoff: the doc hydrates from
 * its `.ydoc` and the next attempt costs a syscall that returns at once. A
 * minute-long quarantine here would keep a doc parked long after the file
 * came back.
 */
function isDataless(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'EDEADLK';
}

type Raced<T> = { kind: 'settled'; value: T } | { kind: 'failed'; err: unknown } | { kind: 'late' };

class BoundFileReader {
  /** Paths that blew the deadline, and the time they may be tried again. */
  private readonly stalledUntil = new Map<string, number>();
  /** Last time each unusable-but-not-hostile path was logged, keyed by
   *  `<verb>:<path>` so a failing write does not silence a failing read. */
  private readonly unusableLoggedAt = new Map<string, number>();
  /** Reads whose pool thread has not come back yet. Bounded, see above. */
  private inflightRead = 0;
  /** Stats whose pool thread has not come back yet. Bounded separately. */
  private inflightStat = 0;
  /**
   * Calls we stopped waiting for and which have not come back — the number of
   * pool threads a hostile path is holding right now. Counts up on a missed
   * deadline and back down if the call ever does land.
   */
  private leaked = 0;
  /** Just-completed reads, waiting to be consumed by the hydrate that asked. */
  private readonly fresh = new Map<
    string,
    { at: number; result: Extract<BoundReadResult, { status: 'ok' }> }
  >();

  /**
   * Is this path currently known-stalled? Synchronous callers that still do a
   * blocking read consult this first, so once ANY path has proved itself
   * hostile the blocking callers stop touching it too.
   */
  quarantined(path: string): boolean {
    const until = this.stalledUntil.get(path);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    this.stalledUntil.delete(path);
    return false;
  }

  /**
   * Is the pool currently refusing new calls?
   *
   * `quarantined` is per-path; this is the state of the gate itself. It is
   * true only once `BOUND_READ_MAX_OVERDUE` calls have blown their deadline
   * without ever landing, which means some bound path is holding pool threads
   * and has not been identified yet. A synchronous caller must treat that as
   * "do not open a bound file on the main thread": the path in front of it
   * may be one of the bad ones, and the whole reason this file exists is that
   * finding out the blocking way costs the process.
   *
   * Refusing on a global signal parks a doc that may have been perfectly
   * healthy. That is the cheap side of the trade — the doc keeps its `.ydoc`
   * content and the next hydrate after the backoff tries again — and it is
   * rare by construction, because a healthy call is never overdue.
   */
  busy(): boolean {
    return this.leaked >= BOUND_READ_MAX_OVERDUE;
  }

  /**
   * Read a bound file off the main thread, or report why we did not.
   *
   * `keep: false` reads without leaving the bytes for a later hydrate to
   * pick up. The held-bytes map is the prewarm-to-hydrate handoff and nothing
   * else: a caller that already HAS the bytes it asked for must not also
   * leave them lying in a cache keyed only by path, because the next hydrate
   * of that path would take them as its own. A bind doing exactly that made
   * a doc re-bind to bytes read seconds earlier, from a file that had since
   * been replaced.
   */
  async read(path: string, opts: { keep?: boolean } = {}): Promise<BoundReadResult> {
    const keep = opts.keep !== false;
    const blocked = this.gate(path);
    if (blocked) return blocked;
    const raced = await this.race('read', path, async () => {
      const [text, st] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      return { text, mtimeMs: st.mtimeMs };
    });
    if (raced.kind === 'late') return { status: 'unavailable', reason: 'timeout' };
    if (raced.kind === 'failed') {
      if (isEnoent(raced.err)) {
        const gone: Extract<BoundReadResult, { status: 'ok' }> = { status: 'ok', exists: false };
        if (keep) this.keepFresh(path, gone);
        return gone;
      }
      if (isDataless(raced.err)) {
        this.noteUnusable(path, raced.err, 'read');
        return { status: 'unavailable', reason: 'error' };
      }
      // EINTR / EIO from a sick file provider land here. They are the same
      // trouble as a timeout one step earlier, so they earn the same backoff
      // — otherwise a provider that errors fast gets retried as hard as the
      // reconnect loop can ask.
      this.markStalled(path, raced.err);
      return { status: 'unavailable', reason: 'error' };
    }
    const result: Extract<BoundReadResult, { status: 'ok' }> = {
      status: 'ok',
      exists: true,
      text: raced.value.text,
      mtimeMs: raced.value.mtimeMs,
    };
    if (keep) this.keepFresh(path, result);
    return result;
  }

  /**
   * The result of a read that completed a moment ago, consumed once.
   *
   * This is the handoff from a prewarm to the synchronous hydrate it exists
   * to protect: the bytes are already in memory, so the attach performs no
   * syscall on the bound path at all. Consumed rather than cached so a second
   * hydrate reads the file again instead of trusting bytes it never asked for.
   */
  takeFresh(path: string): Extract<BoundReadResult, { status: 'ok' }> | undefined {
    const hit = this.fresh.get(path);
    if (!hit) return undefined;
    this.fresh.delete(path);
    return Date.now() - hit.at > BOUND_READ_FRESH_MS ? undefined : hit.result;
  }

  private keepFresh(path: string, result: Extract<BoundReadResult, { status: 'ok' }>): void {
    // Entries are consumed on use and expire in seconds, so this map is
    // normally near-empty. The sweep is only here so a caller that prewarms
    // and then never hydrates cannot grow it without bound.
    if (this.fresh.size > 64) {
      const cutoff = Date.now() - BOUND_READ_FRESH_MS;
      for (const [key, held] of this.fresh) if (held.at < cutoff) this.fresh.delete(key);
    }
    this.fresh.set(path, { at: Date.now(), result });
  }

  /**
   * Write a bound file off the main thread, atomically.
   *
   * Same shape as `read` and for the same reason: `writeFileSync` on a path
   * whose provider has stopped answering parks the only thread that runs
   * JavaScript, and the write-back timer fires against every bound doc. The
   * temp-then-rename is the editors' save pattern, and the rename lands on
   * the REALPATH so a symlinked bound file is written through rather than
   * replaced.
   *
   * The temp file is named for this LANE, not for the write: the synchronous
   * shutdown flush in `file-binding.ts` writes through a different one. Two
   * writers sharing a temp path can interleave their bytes into it, and the
   * two lanes are exactly the pair that can be live at the same moment — a
   * pool write still on the thread when SIGTERM arrives.
   *
   * Returns the mtime the file ended up with, so the caller can record its
   * own write and keep the poll from reading it back as an external edit.
   */
  async write(path: string, text: string): Promise<BoundStatResult> {
    const blocked = this.gate(path);
    if (blocked) return blocked;
    const raced = await this.race('read', path, async () => {
      let target = path;
      try {
        target = await realpath(path);
      } catch {}
      const tmp = `${target}.cw-pool-write~`;
      await writeFile(tmp, text);
      await rename(tmp, target);
      return stat(target);
    });
    if (raced.kind === 'late') return { status: 'unavailable', reason: 'timeout' };
    if (raced.kind === 'failed') {
      // No backoff here, and this is where the write differs from the read.
      // A read that fails with something other than ENOENT says the FILE is
      // in trouble, so the next caller is right to stay away from it. A write
      // fails for a whole family of reasons that say nothing about reading:
      // EACCES on a file the server may still read, EROFS after a volume
      // remounts read-only, ENOSPC, ENOENT when the parent directory has been
      // renamed out from under a bound doc. Quarantining on those would park
      // every READ of a perfectly healthy file for the whole backoff, which
      // is the opposite of what a failing write should cost.
      //
      // The one write failure that does earn the backoff is the one that
      // never came back, and `race` has already recorded it on the `late`
      // branch above — a wedged write holds a pool thread exactly like a
      // wedged read.
      this.noteUnusable(path, raced.err, 'written');
      return { status: 'unavailable', reason: 'error' };
    }
    return { status: 'ok', exists: true, mtimeMs: raced.value.mtimeMs };
  }

  /** The mtime half of `read`, for the poll's change detection. */
  async statMtime(path: string): Promise<BoundStatResult> {
    const blocked = this.gate(path);
    if (blocked) return blocked;
    const raced = await this.race('stat', path, () => stat(path));
    if (raced.kind === 'late') return { status: 'unavailable', reason: 'timeout' };
    if (raced.kind === 'failed') {
      if (isEnoent(raced.err)) return { status: 'ok', exists: false };
      if (isDataless(raced.err)) {
        this.noteUnusable(path, raced.err, 'read');
        return { status: 'unavailable', reason: 'error' };
      }
      this.markStalled(path, raced.err);
      return { status: 'unavailable', reason: 'error' };
    }
    return { status: 'ok', exists: true, mtimeMs: raced.value.mtimeMs };
  }

  /** Counters for the periodic stats line, so a stall is visible in the log. */
  stats(): { inflight: number; leaked: number; quarantined: number } {
    return {
      inflight: this.inflightRead + this.inflightStat,
      leaked: this.leaked,
      quarantined: this.stalledUntil.size,
    };
  }

  /**
   * Tests only: forget the quarantine and the held bytes.
   *
   * Neither counter is cleared, and that is the point. A read still parked
   * in `open` owns its pool thread whatever this object says, so zeroing
   * `leaked` here would both report a pool that had not been given back and
   * re-open the gate that number now controls — and the parked read would
   * then decrement past zero when it finally landed. Tests release their own
   * blocked reads, which brings both counts down for real (see test/fifo.ts).
   */
  reset(): void {
    this.fresh.clear();
    this.stalledUntil.clear();
    this.unusableLoggedAt.clear();
  }

  private gate(path: string): { status: 'unavailable'; reason: 'backoff' | 'busy' } | undefined {
    if (this.quarantined(path)) return { status: 'unavailable', reason: 'backoff' };
    if (this.leaked >= BOUND_READ_MAX_OVERDUE) return { status: 'unavailable', reason: 'busy' };
    return undefined;
  }

  /**
   * A file we could not use but which has earned no backoff — an
   * un-materialized cloud file (see `isDataless`), or any ordinary write
   * failure (see `write`). Logged at most once a minute per path and verb,
   * because the caller that hit it is free to try again immediately and
   * usually will.
   */
  private noteUnusable(path: string, err: unknown, verb: 'read' | 'written'): void {
    const key = `${verb}:${path}`;
    const last = this.unusableLoggedAt.get(key) ?? 0;
    const now = Date.now();
    if (now - last < RETRY_MS) return;
    this.unusableLoggedAt.set(key, now);
    if (this.unusableLoggedAt.size > 256) {
      for (const [seen, at] of this.unusableLoggedAt) {
        if (now - at >= RETRY_MS) this.unusableLoggedAt.delete(seen);
      }
    }
    console.error(`[slow-fs] ${path} could not be ${verb}; the doc keeps its .ydoc content`, err);
  }

  private markStalled(path: string, err?: unknown): void {
    const first = !this.stalledUntil.has(path);
    this.stalledUntil.set(path, Date.now() + RETRY_MS);
    // Once per stall, not once per attempt: the reconnect loop that exposed
    // this bug would otherwise write a log line per second per subscriber.
    if (first) {
      console.error(
        `[slow-fs] ${path} did not answer within ${DEADLINE_MS}ms; parking it for ${Math.round(RETRY_MS / 1000)}s`,
        err ?? '',
      );
    }
  }

  /**
   * Run `work` on the thread pool and stop waiting after the deadline.
   *
   * The `inflight` counter is released when the work SETTLES, not when the
   * race ends: a syscall we walked away from still owns its pool thread, and
   * pretending otherwise is how the bound above would stop bounding anything.
   */
  private async race<T>(
    kind: 'read' | 'stat',
    path: string,
    work: () => Promise<T>,
  ): Promise<Raced<T>> {
    const release = () => {
      if (kind === 'read') this.inflightRead--;
      else this.inflightStat--;
    };
    if (kind === 'read') this.inflightRead++;
    else this.inflightStat++;
    let landed = false;
    // Whether THIS call was counted against `leaked`. Only the call that was
    // counted may uncount itself — decrementing on any landing would let a
    // healthy read cancel out another path's genuine leak.
    let counted = false;
    const running = work();
    const settle = () => {
      landed = true;
      release();
      if (counted) {
        counted = false;
        this.leaked--;
      }
    };
    void running.then(settle, settle);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Raced<T>>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'late' }), DEADLINE_MS);
      // Never a reason to hold the process open; a stalled read must not be
      // able to stop the server exiting.
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    const outcome = await Promise.race<Raced<T>>([
      running.then(
        (value): Raced<T> => ({ kind: 'settled', value }),
        (err): Raced<T> => ({ kind: 'failed', err }),
      ),
      deadline,
    ]);
    if (timer) clearTimeout(timer);
    if (outcome.kind === 'late') {
      // `landed` is set synchronously by `settle`, so a call that came back in
      // the same turn the timer fired is correctly not counted as parked.
      if (!landed) {
        counted = true;
        this.leaked++;
      }
      this.markStalled(path);
    }
    return outcome;
  }
}

/** The one reader. Shared so the quarantine is shared. */
export const boundFiles = new BoundFileReader();
