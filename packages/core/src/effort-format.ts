/**
 * The last step of the effort model: a number a person reads.
 *
 * Seconds never reach the screen and a raw timestamp never reaches it
 * either, so every conversion out of the model's units happens here and
 * nowhere else. Pure and free of the model — nothing above imports it —
 * which is why the widths and roundings can be argued about on their own
 * terms.
 *
 * Two roundings and two functions rather than one function with a flag: the
 * fine and the coarse form answer different questions, and a flag would
 * eventually be passed the wrong way round on one of the two surfaces.
 *
 * Every date produced here is approximate, and the surface that shows one
 * says so beside it.
 */

/**
 * Seconds as a person reads them: at most two units, never a decimal.
 *
 * Seconds never reach the screen (plan §4) and the conversion happens in
 * exactly one place, which is this function and its coarse sibling below.
 * Anything under half a minute is `<1m` rather than a count of seconds — a
 * ticket estimated at eleven seconds is a scoring artefact, not a fact
 * worth four characters of precision.
 */
export function formatEffortSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 30) return '<1m';
  // Round to whole minutes ONCE, up front, and branch on the ROUNDED value.
  // Branching first and rounding inside each branch is what produced "60m"
  // for 3599s and "24h" for 86399s: the carry was handled inside the hours
  // branch and never ACROSS a branch boundary, so a value that rounds up into
  // the next unit was still formatted by the unit it started in. Rounding
  // first makes the carry structural instead of something each branch has to
  // remember.
  const totalMinutes = Math.round(s / 60);
  if (totalMinutes < 1) return '<1m';
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  // The leftover hours are ROUNDED, not truncated — 1d 23h 53m reads as 2d
  // rather than losing the best part of an hour — and the carry that rounding
  // can produce is handled here rather than left to the caller.
  const hours = Math.round((totalMinutes - days * 24 * 60) / 60);
  if (hours >= 24) return `${days + 1}d`;
  return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

/**
 * The same conversion, coarser, for a GOAL total.
 *
 * A goal's total is a sum of guesses and is never precise enough to earn a
 * minute — so below a day it rounds to ten minutes, and above one to half a
 * day. A separate function rather than a flag, because the two roundings
 * answer different questions and a flag would eventually be passed the
 * wrong way round on one of the two surfaces.
 */
export function formatGoalEffortSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 30) return '<1m';
  // Under ten minutes there is no bucket to round into, so report the real
  // minutes. Bucketing here produced a hard step at the boundary — 4m59s
  // rounded down to nothing and printed "<1m", while 5m00s rounded up a whole
  // bucket and printed "10m", a jump of a full bucket across one second. The
  // two paths meet continuously at 600s, which both render as "10m".
  if (s < 600) return formatEffortSeconds(s);
  if (s < 86400) return formatEffortSeconds(Math.round(s / 600) * 600);
  const days = Math.round(s / (86400 / 2)) / 2;
  return `${days}d`;
}

/**
 * `Sep 12` — or `Sep 12, 2027` once the date leaves the current year.
 *
 * The year is not decoration. Without it a projection years out renders in
 * the same four characters as one months out, and the reader has no way to
 * tell them apart; `~Dec 29` was observed on the board for a date in 2041.
 * `now` is a parameter rather than a `Date.now()` call so that the decision
 * is testable and so every date on one render is judged against one clock.
 *
 * Every date this module produces is approximate; the surface that shows one
 * says so beside it.
 */
export function formatEffortDate(at: number, now: number, locale?: string): string {
  const d = new Date(at);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
