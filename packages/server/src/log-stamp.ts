/**
 * An ISO timestamp on a log line, for the lines where "when" is the question.
 *
 * The server's console lines carry no clock of their own — 258 of the 259
 * `console.*` calls in `packages/server/src` print a bare tagged string, and
 * launchd's log file does not add one either. For most of them that is fine:
 * they are boot-time statements of configuration, read in order.
 *
 * It is NOT fine for the `[auth]` code-delivery lines. "How many codes went
 * out, and when" is the whole question somebody asks of those lines — after a
 * mail-bomb, or when a person says a code never arrived — and an undated
 * burst cannot answer it. So those lines are stamped and the rest are left
 * alone rather than sweeping 259 call sites in a change nobody asked for.
 *
 * **Do not put this on a `console.warn` or `console.error` line.**
 * `installLogSquelch` (`log-squelch.ts`) bounds a hot error loop by printing
 * one copy of an IDENTICAL line per window and collapsing the repeats into a
 * summary. A per-call timestamp makes every occurrence a distinct string, so
 * the ceiling stops working on exactly the lines that can loop — which is the
 * mechanism behind the 341 MiB log this repo already paid for once. The two
 * `[auth]` lines that can fire in a loop (the login-start ceiling and a
 * failing sender) are `console.error` for that reason, and they stay bare.
 *
 * If stamping ever has to reach those, the fix is in the squelch — key its
 * map on the line MINUS the stamp — not a timestamp added here and a ceiling
 * quietly lost.
 */

/**
 * `<iso> <line>`.
 *
 * `now` is injectable so a test asserts a stamp it chose rather than racing
 * the wall clock. Milliseconds are kept: a code burst is measured in seconds,
 * and second-resolution would put a whole burst on one reading.
 */
export function stamped(line: string, now: number = Date.now()): string {
  return `${new Date(now).toISOString()} ${line}`;
}

/** The shape `stamped` writes, for a test or a log reader to match against. */
export const STAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;
