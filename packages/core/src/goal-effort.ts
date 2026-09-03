/**
 * Chunks 3 and 4 of the effort model: what a GOAL's tickets add up to, and
 * roughly when the goal finishes.
 *
 * Chunk 2 put an estimate on each ticket (`effort-estimate-prompt.ts` makes
 * the guess, the server stores it). This module is the arithmetic on top:
 * roll a goal's estimates into a percentage and a remaining figure, learn a
 * correction factor from the tickets that already closed, and turn the
 * remainder into a date.
 *
 * **There is no stored "actual".** Both actuals are DERIVED, which is the
 * one design choice worth stating up front. Wall-clock is the ticket's own
 * transition trail — first move into `in-progress`, last move into `done` —
 * and hands-on is the reading time already folded onto the row. Nothing is
 * written at close, so nothing needs backfilling, nothing can drift out of
 * step with the trail it was copied from, and every ticket that closed
 * before this module existed is a calibration sample the moment it has an
 * estimate. A stored copy of a derivable number is a second source of truth
 * that can only ever disagree with the first.
 *
 * Pure, and in `core` rather than the server, because the board renders it:
 * the client already holds every row over the workspace ydoc, so the bar
 * recomputes the instant an estimate lands, with no fetch and no second
 * implementation to keep in step.
 *
 * Three rules run through everything here, and each of them is a bug that
 * was easy to write instead:
 *
 * 1. **Absent is not zero.** A goal nobody has scored returns
 *    `{ kind: 'unestimated' }`, never a 0% bar. A 0% bar is a real and
 *    different statement — every ticket scored, none of them finished — and
 *    the two must never render the same. `Task.readingTime` and
 *    `Task.effortEstimate` both already hold this line in their own type
 *    docs ("no reader may default this to 0"); a rollup that summed a
 *    missing estimate as `0` would quietly cross it at the last step, on the
 *    one surface Bryan actually reads.
 * 2. **Estimates on both sides of the fraction** (Bryan's decision,
 *    2026-08-30). Percent complete is done-estimate over total-estimate, so
 *    closing a ticket moves the numerator and leaves the denominator alone.
 *    Putting the ACTUAL in the numerator would make the bar lurch — forward
 *    or backward — at the moment of a close, which is exactly when somebody
 *    is looking at it.
 * 3. **Measured numbers are never multiplied.** A ratio scales the FORECAST
 *    only; actuals are reported as they happened. This is the
 *    2026-04-19 no-taxes-on-primary-metrics decision holding where it was
 *    aimed — correcting a known bias is the whole job of a forecast and
 *    none of the job of a measurement.
 *
 * The priors added in the same pass as prompt version 2 change none of the
 * three. A prior is the board ratio a goal inherits when nothing has closed
 * to learn from — a starting point for the FORECAST, replacing an identity
 * factor that was itself an assumption (that the scorer is unbiased) and
 * simply a worse one. It multiplies no measurement, it fills no absent
 * estimate with a number, and it sits on the same side of the fraction as
 * everything else the forecast is built from.
 */

import {
  type EffortCalibration,
  type EffortRatio,
  applyEffortRatio,
  ratioForGoal,
} from './effort-calibration.ts';
import {
  DAY_MS,
  EFFORT_MIN_CLOSES_FOR_PROJECTION,
  type EffortTaskInput,
  countsTowardEffort,
  effortClosedAt,
  effortEstimateState,
  estimateNumbers,
  goalPaceWindowDays,
  isEffortDone,
  isObservedClose,
} from './effort-task.ts';

export {
  EFFORT_RATIO_MIN,
  EFFORT_RATIO_MAX,
  EFFORT_PRIOR_WALL_CLOCK_RATIO,
  EFFORT_PRIOR_HANDS_ON_RATIO,
  EFFORT_SHRINK_K,
  EFFORT_MIN_SAMPLES_FOR_RANGE,
  EFFORT_MIN_SAMPLES_FOR_CALIBRATION,
  clampEffortRatio,
  shrinkEffortRatio,
  median,
  quantile,
  symmetricRatioError,
  neutralRatio,
  neutralRatioSet,
  neutralCalibration,
  computeEffortRatios,
  computeEffortCalibration,
  ratioForGoal,
  applyEffortRatio,
} from './effort-calibration.ts';
export type {
  EffortRatio,
  EffortRatioSet,
  EffortCalibration,
  EffortSample,
  EffortCalibrationTask,
} from './effort-calibration.ts';

export {
  EFFORT_PACE_WINDOW_DAYS,
  EFFORT_MIN_PACE_WINDOW_DAYS,
  EFFORT_MIN_CLOSES_FOR_PROJECTION,
  estimateNumbers,
  isCurrentGenerationEstimate,
  effortEstimateState,
  isEffortDone,
  countsTowardEffort,
  effortClosedAt,
  effortFirstSeenAt,
  goalPaceWindowDays,
  effortActualWallClockSeconds,
  effortActualHandsOnSeconds,
  isObservedClose,
} from './effort-task.ts';
export type {
  EffortTransition,
  EffortTaskInput,
  EffortEstimateNumbers,
} from './effort-task.ts';

/**
 * Past this many days out, a projection stops being a forecast.
 *
 * The pace window is fourteen days and the remainder is unbounded, so an
 * ordinary shape — a handful of small closes against a tail of large open
 * tickets — divides into years. Measured on a seeded board: three ten-minute
 * closes against five forty-hour tickets projected 5,600 days, and the board
 * printed it as a bare `~Dec 29`, which is December 2041 in the same four
 * characters as four months away. Nobody would have believed that date if
 * they could see it, and nobody could see it.
 *
 * So the horizon is a year: beyond it the readout says how far out it is
 * rather than naming a day. The date is not suppressed silently — a reader
 * who sees no date at all cannot tell "too little has closed" from "this
 * will take forever", and those are opposite situations.
 */
export const EFFORT_MAX_PROJECTION_DAYS = 365;

/** A goal that has something to say. */
export interface GoalEffortReady {
  kind: 'ready';
  /** 0–100, applied done-estimate over applied total-estimate. */
  percentComplete: number;
  /** Applied hands-on seconds across the tickets that are NOT done. */
  handsOnRemainingSeconds: number;
  /** Applied wall-clock seconds across the tickets that are NOT done. */
  wallClockRemainingSeconds: number;
  /** Projected finish, ms epoch. Absent below
   *  `EFFORT_MIN_CLOSES_FOR_PROJECTION` closes in the pace window. */
  projectedFinishAt?: number;
  /** The pessimistic end of the range, from the ratio spread. Absent
   *  whenever the spread is 1 — too few samples to claim one. */
  projectedLatestAt?: number;
  /** Estimate-seconds closed per calendar day over the window. */
  paceSecondsPerDay: number;
  /** How many days that rate was measured over — the span the goal's counted
   *  closes happened in (its age, while nothing has closed), capped
   *  at `EFFORT_PACE_WINDOW_DAYS` and floored at
   *  `EFFORT_MIN_PACE_WINDOW_DAYS` (one hour), so a sub-day window is a
   *  fraction here and any surface naming it must say hours, not round it up
   *  to a day it never used. On the summary rather than recomputed by
   *  each surface, because the sentence a header prints ("on the last N
   *  days' pace") has to name the same N the arithmetic used. */
  paceWindowDays: number;
  /** OBSERVED closes inside that window — tickets that entered
   *  `in-progress` and later closed. A row swept straight to done is not
   *  counted here, so a bulk close cannot unlock a date it did not earn;
   *  `EFFORT_MIN_CLOSES_FOR_PROJECTION` is checked against this number. */
  closesInWindow: number;
  /** How many of the goal's live tickets carry a usable estimate, and how
   *  many do not. The bar covers only the first group and a reader is
   *  entitled to know that, so both numbers are on the summary rather than
   *  quietly dropped. */
  estimatedCount: number;
  unestimatedCount: number;
  /** Tickets whose scoring RAN and produced nothing. A subset of
   *  `unestimatedCount`, and a different thing to say about a row. */
  failedCount: number;
  /** The corrections in force, so a number on screen can be traced back. */
  wallClockRatio: EffortRatio;
  handsOnRatio: EffortRatio;
  /** Every SCORED ticket in this goal is closed. Distinct from
   *  `percentComplete === 100`, which rounding can also produce, and it is
   *  what lets a surface say "done" instead of "<1m left" — a finished goal
   *  was rendering as a goal with a minute of work landing today. Unscored
   *  tickets may still remain; the coverage figures say so separately. */
  complete: boolean;
  /** How many days out the projection came to, when that is past
   *  `EFFORT_MAX_PROJECTION_DAYS`. Present INSTEAD of `projectedFinishAt`:
   *  the pace says the goal is years away, which is a real answer and a
   *  useless date. A surface says how far out rather than naming a day, and
   *  the presence of this field is what lets it tell "too far to say" apart
   *  from "too little has closed to say". */
  projectionOverHorizonDays?: number;
}

/** A goal with nothing to say, and which of the two silences it is. */
export interface GoalEffortAbsent {
  kind: 'unestimated';
  /** No live tickets at all, versus live tickets none of which is scored. */
  reason: 'no-tasks' | 'not-scored';
  unestimatedCount: number;
  failedCount: number;
}

export type GoalEffortSummary = GoalEffortReady | GoalEffortAbsent;

/**
 * Roll one goal's tickets into a bar, a remaining figure and a date.
 *
 * `now` is a parameter rather than a `Date.now()` call so the projection is
 * testable and so every band on one render shares a single clock.
 */
export function summarizeGoalEffort(
  tasks: EffortTaskInput[],
  goal: string,
  calibration: EffortCalibration,
  now: number,
): GoalEffortSummary {
  const live = tasks.filter(countsTowardEffort);
  const wallClockRatio = ratioForGoal(calibration.wallClock, goal);
  const handsOnRatio = ratioForGoal(calibration.handsOn, goal);
  let doneWallClock = 0;
  let totalWallClock = 0;
  let handsOnRemaining = 0;
  let wallClockRemaining = 0;
  let estimatedCount = 0;
  let unestimatedCount = 0;
  let failedCount = 0;
  let closesInWindow = 0;
  let closedSecondsInWindow = 0;
  // One window, used for both halves of the pace: the span it is divided by
  // and the span a close has to fall inside to count. Deriving them
  // separately is how a rate ends up measured over one period and divided by
  // another.
  const paceWindowDays = goalPaceWindowDays(live, now);
  const windowStart = now - paceWindowDays * DAY_MS;
  for (const task of live) {
    const est = estimateNumbers(task);
    if (!est) {
      unestimatedCount++;
      if (effortEstimateState(task) === 'failed') failedCount++;
      continue;
    }
    estimatedCount++;
    const wall = applyEffortRatio(est.wallClockSeconds, wallClockRatio.ratio);
    totalWallClock += wall;
    if (isEffortDone(task)) {
      // The bar counts every close, observed or not: the ticket is finished,
      // and how it got there is not a fact about how much of the goal is
      // left.
      doneWallClock += wall;
      // The PACE counts only closes somebody watched happen — see
      // `isObservedClose`. Pace is measured in ESTIMATE-seconds closed per
      // day, not in actual seconds. That keeps it in the same currency as
      // the remainder it is divided into — dividing a remaining estimate by
      // a rate of actuals would apply the correction twice, once in each
      // operand.
      const closedAt = isObservedClose(task) ? effortClosedAt(task) : null;
      if (closedAt !== null && closedAt >= windowStart && closedAt <= now) {
        closesInWindow++;
        closedSecondsInWindow += wall;
      }
    } else {
      handsOnRemaining += applyEffortRatio(est.handsOnSeconds, handsOnRatio.ratio);
      wallClockRemaining += wall;
    }
  }
  if (estimatedCount === 0) {
    return {
      kind: 'unestimated',
      reason: live.length === 0 ? 'no-tasks' : 'not-scored',
      unestimatedCount,
      failedCount,
    };
  }
  const percentComplete =
    totalWallClock > 0 ? Math.round((doneWallClock / totalWallClock) * 100) : 0;
  const paceSecondsPerDay = closedSecondsInWindow / paceWindowDays;
  const summary: GoalEffortReady = {
    kind: 'ready',
    complete: wallClockRemaining === 0,
    percentComplete,
    handsOnRemainingSeconds: handsOnRemaining,
    wallClockRemainingSeconds: wallClockRemaining,
    paceSecondsPerDay,
    paceWindowDays,
    closesInWindow,
    estimatedCount,
    unestimatedCount,
    failedCount,
    wallClockRatio,
    handsOnRatio,
  };
  if (closesInWindow >= EFFORT_MIN_CLOSES_FOR_PROJECTION && paceSecondsPerDay > 0) {
    if (wallClockRemaining === 0) {
      // Nothing left to project. No date at all rather than "today": the
      // goal is finished, and `complete` is how a surface says so.
    } else {
      const days = wallClockRemaining / paceSecondsPerDay;
      if (days > EFFORT_MAX_PROJECTION_DAYS) {
        summary.projectionOverHorizonDays = days;
      } else {
        summary.projectedFinishAt = now + days * DAY_MS;
        if (wallClockRatio.spread > 1) {
          // The late end obeys the SAME horizon as the central date. A goal
          // 300 days out with a spread of 2 would otherwise print "likely by"
          // a day 600 out — precisely the far-future date the horizon exists
          // to refuse, smuggled in on the end of a range whose first half is
          // inside it. When the range runs past the horizon the central date
          // stands alone: "finishing around X", with no second date.
          const latestDays = days * wallClockRatio.spread;
          if (latestDays <= EFFORT_MAX_PROJECTION_DAYS) {
            summary.projectedLatestAt = now + latestDays * DAY_MS;
          }
        }
      }
    }
  }
  return summary;
}

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
