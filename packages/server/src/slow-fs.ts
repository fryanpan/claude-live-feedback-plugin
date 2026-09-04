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
 *   - A CONCURRENCY BOUND, because a read that never returns never gives its
 *     pool thread back. Only `BOUND_READ_MAX_INFLIGHT` reads may be
 *     outstanding at once, so a whole stalled folder can leak at most that
 *     many pool threads for the life of the process rather than draining the
 *     pool and taking every other async read down with it.
 *
 * This is a gate in front of the syscall, not a layer over the filesystem:
 * callers still decide what a missing or unavailable file means for them. The
 * one thing it holds is the bytes of a read that finished seconds ago, so the
 * hydrate that asked for it can use them instead of opening the file again —
 * consumed on first use, never served twice.
 */
import { readFile, stat } from 'node:fs/promises';

/**
 * How long a bound file gets to answer before the caller gives up on it.
 *
 * Three seconds is far above any healthy local or network read (a warm
 * Dropbox file answers in single-digit milliseconds) and far below the
 * supervisor's own patience, so a stalled file parks its doc without ever
 * looking like a dead server.
 */
export const BOUND_READ_DEADLINE_MS = 3_000;

/**
 * Minimum gap between attempts on a path that already blew the deadline.
 *
 * The failure mode this exists for is a client that reconnects immediately:
 * without a backoff, every reconnect starts another doomed read and leaks
 * another pool thread. One attempt per minute per path is enough to notice a
 * provider that woke up, and cheap enough that a folder full of stalled files
 * costs nothing.
 */
export const BOUND_READ_RETRY_MS = 60_000;

/**
 * How many bound-file reads may be outstanding at once.
 *
 * This is the leak bound. A read the provider never answers holds its thread
 * pool slot forever, so the worst case for a permanently stalled folder is
 * four parked pool threads — not the whole pool. Healthy reads finish in
 * microseconds and never approach the limit; when it is reached, callers get
 * `unavailable` and retry later rather than queueing.
 */
export const BOUND_READ_MAX_INFLIGHT = 4;

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

type Raced<T> = { kind: 'settled'; value: T } | { kind: 'failed'; err: unknown } | { kind: 'late' };

class BoundFileReader {
  /** Paths that blew the deadline, and the time they may be tried again. */
  private readonly stalledUntil = new Map<string, number>();
  /** Reads whose pool thread has not come back yet. Bounded, see above. */
  private inflight = 0;
  /** Reads that never returned at all — reported by `stats()` for the log. */
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

  /** Read a bound file off the main thread, or report why we did not. */
  async read(path: string): Promise<BoundReadResult> {
    const blocked = this.gate(path);
    if (blocked) return blocked;
    const raced = await this.race(path, async () => {
      const [text, st] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      return { text, mtimeMs: st.mtimeMs };
    });
    if (raced.kind === 'late') return { status: 'unavailable', reason: 'timeout' };
    if (raced.kind === 'failed') {
      if (isEnoent(raced.err)) {
        const gone: Extract<BoundReadResult, { status: 'ok' }> = { status: 'ok', exists: false };
        this.keepFresh(path, gone);
        return gone;
      }
      // EDEADLK / EINTR / EIO from a sick file provider land here. They are
      // the same trouble as a timeout one step earlier, so they earn the
      // same backoff — otherwise a provider that errors fast gets retried
      // as hard as the reconnect loop can ask.
      this.markStalled(path, raced.err);
      return { status: 'unavailable', reason: 'error' };
    }
    const result: Extract<BoundReadResult, { status: 'ok' }> = {
      status: 'ok',
      exists: true,
      text: raced.value.text,
      mtimeMs: raced.value.mtimeMs,
    };
    this.keepFresh(path, result);
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

  /** The mtime half of `read`, for the poll's change detection. */
  async statMtime(path: string): Promise<BoundStatResult> {
    const blocked = this.gate(path);
    if (blocked) return blocked;
    const raced = await this.race(path, () => stat(path));
    if (raced.kind === 'late') return { status: 'unavailable', reason: 'timeout' };
    if (raced.kind === 'failed') {
      if (isEnoent(raced.err)) return { status: 'ok', exists: false };
      this.markStalled(path, raced.err);
      return { status: 'unavailable', reason: 'error' };
    }
    return { status: 'ok', exists: true, mtimeMs: raced.value.mtimeMs };
  }

  /** Counters for the periodic stats line, so a stall is visible in the log. */
  stats(): { inflight: number; leaked: number; quarantined: number } {
    return { inflight: this.inflight, leaked: this.leaked, quarantined: this.stalledUntil.size };
  }

  /** Tests only: forget every quarantine and counter. */
  reset(): void {
    this.fresh.clear();
    this.stalledUntil.clear();
    this.inflight = 0;
    this.leaked = 0;
  }

  private gate(path: string): { status: 'unavailable'; reason: 'backoff' | 'busy' } | undefined {
    if (this.quarantined(path)) return { status: 'unavailable', reason: 'backoff' };
    if (this.inflight >= BOUND_READ_MAX_INFLIGHT) return { status: 'unavailable', reason: 'busy' };
    return undefined;
  }

  private markStalled(path: string, err?: unknown): void {
    const first = !this.stalledUntil.has(path);
    this.stalledUntil.set(path, Date.now() + BOUND_READ_RETRY_MS);
    // Once per stall, not once per attempt: the reconnect loop that exposed
    // this bug would otherwise write a log line per second per subscriber.
    if (first) {
      console.error(
        `[slow-fs] ${path} did not answer within ${BOUND_READ_DEADLINE_MS}ms; parking it for ${Math.round(BOUND_READ_RETRY_MS / 1000)}s`,
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
  private async race<T>(path: string, work: () => Promise<T>): Promise<Raced<T>> {
    this.inflight++;
    let landed = false;
    const running = work();
    void running.then(
      () => {
        landed = true;
        this.inflight--;
      },
      () => {
        landed = true;
        this.inflight--;
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Raced<T>>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'late' }), BOUND_READ_DEADLINE_MS);
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
      if (!landed) this.leaked++;
      this.markStalled(path);
    }
    return outcome;
  }
}

/** The one reader. Shared so the quarantine is shared. */
export const boundFiles = new BoundFileReader();
