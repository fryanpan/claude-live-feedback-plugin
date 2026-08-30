/**
 * A bound on what a hot error loop can cost.
 *
 * On 2026-08-29 a premature-Yjs-access warning fired once per table cell and
 * per list item at every hydrate — 57,936 lines per pass over the live data
 * dir's bound docs. Measured on the prod error log that day: 357,378,067
 * bytes, 5,585,625 lines, of which 5,580,927 were that one string. 99.92% of
 * the log was a single repeated sentence.
 *
 * The cause is fixed (prose.ts builds prelim types with a single insert), but
 * the log had no ceiling of its OWN: the next loop would cost the same. This
 * is that ceiling. launchd owns the file and /etc/newsyslog.d is not ours to
 * edit, so it has to live in the process.
 *
 * The rule: an identical line prints ONCE per window, and the repeats it
 * stood in for are reported as one summary when the window rolls. Output per
 * window is bounded by the number of DISTINCT lines, not by how often they
 * fire, so the same incident would have cost about two lines a minute — tens
 * of kilobytes over the days it actually ran, instead of 341 MiB.
 *
 * `squelchLine` is the whole decision and does no I/O: it takes the state,
 * the line and the clock reading, and returns exactly the lines to write.
 * `installLogSquelch` is the thin wrapper that puts it on console.warn /
 * console.error. Deliberately NOT installed by `createServer` — patching a
 * global console belongs to the process that owns the log (bin.ts), not to
 * a library every test imports.
 */

/** One line prints at most once per window; repeats collapse into a summary. */
export const SQUELCH_WINDOW_MS = 60_000;

/**
 * Distinct lines tracked per window. A caller emitting more unique strings
 * than this in one window is not a repeating loop — it is normal chatter, and
 * chatter passes through unsquelched rather than growing the map without
 * bound.
 */
export const SQUELCH_MAX_KEYS = 256;

/** Longest prefix of the repeated line echoed back in its summary. */
const SUMMARY_EXCERPT = 200;

export interface SquelchOptions {
  windowMs?: number;
  maxKeys?: number;
}

export interface SquelchState {
  /** Start of the current window, on the caller's clock. */
  windowStartedAt: number;
  /** line → how many times it was SUPPRESSED since it last printed. */
  counts: Map<string, number>;
}

export function newSquelchState(now: number): SquelchState {
  return { windowStartedAt: now, counts: new Map() };
}

function summaryFor(line: string, n: number, windowMs: number): string {
  const excerpt = line.length > SUMMARY_EXCERPT ? `${line.slice(0, SUMMARY_EXCERPT)}…` : line;
  const secs = Math.round(windowMs / 1000);
  return `[log-squelch] …repeated ${n} more time${n === 1 ? '' : 's'} in ${secs}s: ${excerpt}`;
}

/**
 * Summaries for everything the window suppressed, then a fresh window.
 * Exported because shutdown has to be able to drain the pending counts —
 * they are otherwise reported only by the next call, which may never come.
 */
export function flushSquelch(
  state: SquelchState,
  now: number,
  opts: SquelchOptions = {},
): string[] {
  const windowMs = opts.windowMs ?? SQUELCH_WINDOW_MS;
  const out: string[] = [];
  for (const [line, n] of state.counts) {
    if (n > 0) out.push(summaryFor(line, n, windowMs));
  }
  state.counts.clear();
  state.windowStartedAt = now;
  return out;
}

export interface SquelchResult {
  /** Summaries for the window this line just closed, in order. */
  flushed: string[];
  /** Whether `line` itself should be written, or only counted. */
  emit: boolean;
}

/**
 * What to write for `line` at time `now`. `state` is advanced in place; the
 * function itself reads no clock and writes nothing, so a test drives it
 * entirely by the numbers it passes in.
 *
 * `emit` is kept separate from `flushed` so the caller can write the line
 * with its ORIGINAL console arguments (an Error keeps its stack) while the
 * summaries go out as plain strings.
 */
export function squelchLine(
  state: SquelchState,
  line: string,
  now: number,
  opts: SquelchOptions = {},
): SquelchResult {
  const maxKeys = opts.maxKeys ?? SQUELCH_MAX_KEYS;

  // The window rolls lazily, on the next line rather than on a timer: a
  // process with nothing to say should not be woken to say nothing.
  const flushed =
    now - state.windowStartedAt >= (opts.windowMs ?? SQUELCH_WINDOW_MS)
      ? flushSquelch(state, now, opts)
      : [];

  const seen = state.counts.get(line);
  if (seen === undefined) {
    // Past the key cap we stop tracking rather than stop printing. Losing the
    // squelch on chatter is a smaller failure than dropping a line nobody
    // asked us to drop.
    if (state.counts.size < maxKeys) state.counts.set(line, 0);
    return { flushed, emit: true };
  }
  state.counts.set(line, seen + 1);
  return { flushed, emit: false };
}

/** What `console.error('[ws] send failed', err)` should be keyed and matched on. */
export function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a) ?? String(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export interface LogSquelchHandle {
  /** Emit the pending summaries now (shutdown). */
  flush(): void;
  /** Put the original console.warn / console.error back. */
  restore(): void;
}

/**
 * Wrap console.warn and console.error so identical lines collapse.
 *
 * The FIRST occurrence goes through with the caller's original arguments, so
 * an Error still prints with its stack; only the summary is a plain string.
 *
 * Each level gets its OWN state. Sharing one would let a `console.warn('x')`
 * swallow the `console.error('x')` that followed it — a lower severity
 * hiding a higher one, and the count then surfacing on whichever level
 * happened to roll the window. Separate states also mean each level's
 * summaries go out on that level's own writer.
 */
export function installLogSquelch(
  opts: SquelchOptions & { now?: () => number } = {},
): LogSquelchHandle {
  const now = opts.now ?? Date.now;
  const original = { warn: console.warn, error: console.error };
  const states = { warn: newSquelchState(now()), error: newSquelchState(now()) };

  const wrap = (level: 'warn' | 'error') => {
    const write = (...args: unknown[]) => original[level](...args);
    return (...args: unknown[]) => {
      const { flushed, emit } = squelchLine(states[level], formatArgs(args), now(), opts);
      for (const line of flushed) write(line);
      // The line we were handed prints as it was handed to us — an Error
      // argument keeps its stack; only the summaries are plain strings.
      if (emit) write(...args);
    };
  };

  console.warn = wrap('warn');
  console.error = wrap('error');

  return {
    flush() {
      for (const line of flushSquelch(states.warn, now(), opts)) original.warn(line);
      for (const line of flushSquelch(states.error, now(), opts)) original.error(line);
    },
    restore() {
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}
