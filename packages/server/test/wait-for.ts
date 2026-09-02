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
