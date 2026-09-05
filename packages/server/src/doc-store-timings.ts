/**
 * The debounce and poll cadences a bound doc runs on.
 *
 * These are production constants with production defaults. They live behind a
 * resolver for ONE reason: the server test suite spent most of its wall clock
 * waiting for them. A poll tick plus a read debounce plus a write-back is
 * ~1.45s of unavoidable latency, and the suite crosses that chain hundreds of
 * times. No amount of poll-until in the tests can shorten a debounce the
 * server itself schedules.
 *
 * `CW_TEST_TIMING_SCALE` multiplies every cadence by one factor. One factor,
 * not five knobs, because the ORDER of these debounces is load-bearing — the
 * `.ydoc` persists before the `.md` write-back, which is what makes
 * "a crash inside the flush window" a real state the tests can build. A
 * uniform scale preserves every ratio; five independent overrides would let a
 * careless value invert one and quietly delete the case a test was covering.
 *
 * Unset, malformed, out of range: the defaults, unchanged. The variable can
 * only make the server FASTER (scale <= 1), so a stray value in a production
 * environment cannot slow a deploy down or widen a race window.
 */

export type DocStoreTimings = {
  /** How often the shared mtime sweep runs. */
  filePollMs: number;
  /** Settle time after a file change before reading it, so no half-written save is parsed. */
  readDebounceMs: number;
  /** Doc → disk: how long a prose change waits before the serialize+write. */
  writeBackMs: number;
  /** Doc → `.ydoc`: how long a change waits before the CRDT snapshot is persisted. */
  persistMs: number;
  /** How long a doc must go quiet before an authoring burst commits one revision bump. */
  revisionSettleMs: number;
  /** How long after a content change the thread re-anchor sweep runs. */
  reanchorMs: number;
  /** How long a bound file gets to answer a read before it is parked (slow-fs). */
  boundReadDeadlineMs: number;
  /** Minimum gap between attempts on a bound file that blew the deadline. */
  boundReadRetryMs: number;
};

/** The production cadences. Every one of these is a documented number elsewhere. */
export const DEFAULT_DOC_STORE_TIMINGS: DocStoreTimings = {
  filePollMs: 500,
  readDebounceMs: 150,
  writeBackMs: 800,
  persistMs: 200,
  revisionSettleMs: 1000,
  reanchorMs: 250,
  boundReadDeadlineMs: 3000,
  boundReadRetryMs: 60000,
};

/**
 * Below this a timer is at the mercy of event-loop jitter on a loaded box,
 * and two cadences scaled from different defaults can land on the same
 * millisecond — which erases the ordering the ratios exist to preserve.
 */
const MIN_MS = 5;

/**
 * Resolve the cadences for a scale factor. Anything that is not a finite
 * number in `(0, 1]` yields the defaults untouched — including `undefined`,
 * an empty string, a word, a negative, a zero, and anything above 1.
 */
export function resolveDocStoreTimings(scale: string | undefined): DocStoreTimings {
  if (scale === undefined || scale.trim() === '') return { ...DEFAULT_DOC_STORE_TIMINGS };
  const factor = Number(scale);
  if (!Number.isFinite(factor) || factor <= 0 || factor > 1)
    return { ...DEFAULT_DOC_STORE_TIMINGS };
  const scaled = (ms: number): number => Math.max(MIN_MS, Math.round(ms * factor));
  return {
    filePollMs: scaled(DEFAULT_DOC_STORE_TIMINGS.filePollMs),
    readDebounceMs: scaled(DEFAULT_DOC_STORE_TIMINGS.readDebounceMs),
    writeBackMs: scaled(DEFAULT_DOC_STORE_TIMINGS.writeBackMs),
    persistMs: scaled(DEFAULT_DOC_STORE_TIMINGS.persistMs),
    revisionSettleMs: scaled(DEFAULT_DOC_STORE_TIMINGS.revisionSettleMs),
    reanchorMs: scaled(DEFAULT_DOC_STORE_TIMINGS.reanchorMs),
    boundReadDeadlineMs: scaled(DEFAULT_DOC_STORE_TIMINGS.boundReadDeadlineMs),
    boundReadRetryMs: scaled(DEFAULT_DOC_STORE_TIMINGS.boundReadRetryMs),
  };
}

/**
 * Resolved once, at module load, because these feed `setTimeout` calls on
 * every keystroke and re-reading the environment there would be a syscall in
 * the hot path. A test that needs different cadences sets the variable before
 * the process starts — which is what `bun run test:server` does.
 */
export const DOC_STORE_TIMINGS: DocStoreTimings = resolveDocStoreTimings(
  process.env.CW_TEST_TIMING_SCALE,
);
