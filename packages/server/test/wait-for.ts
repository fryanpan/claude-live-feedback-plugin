/**
 * Poll-until helpers for the server suite.
 *
 * A test that waits on a debounce, a flush or a socket round-trip should wait
 * for the OBSERVABLE, not for a duration. `await sleep(1100)` pays a full
 * second every run and still loses the race on a loaded machine; `await
 * waitFor(...)` returns the moment the condition holds and only spends the
 * budget when something is actually broken.
 *
 * See .claude/rules/testing-standards.md, standard 2.
 */

import { ROOM_TIMINGS } from '../src/doc-store-timings.ts';

export type WaitOptions = {
  /** Give up after this long. Default 5000ms — generous, since it is only paid on failure. */
  timeout?: number;
  /** Gap between probes. Default 20ms. */
  interval?: number;
  /** Named in the timeout error, so a failure says what never happened. */
  describe?: string;
};

const DEFAULTS = { timeout: 5000, interval: 20 };

/**
 * Resolve as soon as `probe` returns a value that is neither `false`,
 * `undefined` nor `null`. Rejects with `describe` and the last seen value if
 * the budget runs out. A probe that throws is treated as "not yet" until the
 * budget runs out, at which point its error is reported.
 */
export async function waitFor<T>(
  probe: () => T | Promise<T>,
  options: WaitOptions = {},
): Promise<Exclude<NonNullable<T>, false>> {
  const { timeout, interval } = { ...DEFAULTS, ...options };
  const label = options.describe ?? 'condition';
  const deadline = Date.now() + timeout;
  let last: unknown;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== false && value !== undefined && value !== null) {
        return value as Exclude<NonNullable<T>, false>;
      }
      last = value;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const detail = lastError
        ? `last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
        : `last value: ${JSON.stringify(last)}`;
      throw new Error(`waitFor timed out after ${timeout}ms waiting for ${label} — ${detail}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Wait until `predicate` holds for the file's current UTF-8 contents, then return them. */
export async function waitForFile(
  path: string,
  predicate: (text: string) => boolean,
  options: WaitOptions = {},
): Promise<string> {
  const { readFileSync } = await import('node:fs');
  return waitFor(
    () => {
      const text = readFileSync(path, 'utf8');
      return predicate(text) ? text : false;
    },
    { describe: `${path} to satisfy the predicate`, ...options },
  );
}

/** Wait until the file's contents equal `want` exactly, then return them. */
export async function waitForFileToBe(
  path: string,
  want: string,
  options: WaitOptions = {},
): Promise<string> {
  return waitForFile(path, (text) => text === want, {
    describe: `${path} to equal ${JSON.stringify(want.slice(0, 60))}`,
    ...options,
  });
}

/**
 * Windows derived from the server's own cadences, for the waits that cannot
 * become a poll: the ones asserting that something NEVER happens, and the one
 * that has to land a write INSIDE a debounce window.
 *
 * They are derived rather than written as literals because the suite scales
 * every cadence down (see packages/server/test/timing.preload.ts). A literal
 * 1100 would be a 14x overshoot under the scale, and a literal 700 meant to
 * sit inside an 800ms window would sit far outside an 80ms one — turning the
 * race the test builds into no race at all.
 *
 * The multipliers are set so that at the DEFAULT cadences every one of these
 * returns at least the literal it replaced. Nothing lost margin in the
 * conversion; the scale is what makes them fast.
 */

/** Long enough that a doc → disk write-back would have fired. */
export const pastWriteBack = (): number => Math.ceil(ROOM_TIMINGS.writeBackMs * 1.625);

/** Long enough that an external edit would have been polled, read and applied. */
export const pastExternalRead = (): number =>
  Math.ceil(
    (ROOM_TIMINGS.filePollMs + ROOM_TIMINGS.readDebounceMs + ROOM_TIMINGS.writeBackMs) * 1.75,
  );

/**
 * After the `.ydoc` persist has run but before the `.md` write-back does —
 * the gap a test needs to build "the server died with an edit still unflushed".
 * Midway between the two so neither side is close.
 */
export const afterPersist = (): number =>
  Math.round((ROOM_TIMINGS.persistMs + ROOM_TIMINGS.writeBackMs) / 2);

/** Late in the write-back window but before it fires — where a racing write must land. */
export const insideWriteBack = (): number => Math.round(ROOM_TIMINGS.writeBackMs * 0.875);

/** Long enough that the thread re-anchor sweep would have run. */
export const pastReanchor = (): number => Math.ceil(ROOM_TIMINGS.reanchorMs * 2);
