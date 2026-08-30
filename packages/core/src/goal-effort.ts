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
 */

/** A ratio outside this band is a correction nobody should trust more than
 *  the estimate it corrects — the same trim the weekly-review multiplier
 *  uses. */
export const EFFORT_RATIO_MIN = 0.5;
export const EFFORT_RATIO_MAX = 2.0;

/** Shrinkage weight: a goal's own ratio carries `n / (n + K)` of the answer
 *  and the board-wide ratio carries the rest, so two closed tickets barely
 *  move a goal off the board's own experience. */
export const EFFORT_SHRINK_K = 5;

/** How far back `pace` looks when turning closes into a finish date. */
export const EFFORT_PACE_WINDOW_DAYS = 14;

/** Below this many closes inside the pace window there is no projection —
 *  a date drawn from one or two closes is a number pretending to be a
 *  forecast. */
export const EFFORT_MIN_CLOSES_FOR_PROJECTION = 3;

/** Below this many samples there is no spread, so no "likely by" date: a
 *  range computed from one sample is not a range. */
export const EFFORT_MIN_SAMPLES_FOR_RANGE = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The slice of a transition this module reads. Structural, so both the
 *  server's `TaskTransition` and the client's `HubTransition` satisfy it. */
export interface EffortTransition {
  ts: number;
  to: string;
}

/**
 * What this module needs off a ticket.
 *
 * Deliberately a structural subset of both `Task` (server) and `HubTask`
 * (client) rather than either of them — that is what lets one
 * implementation serve both callers.
 */
export interface EffortTaskInput {
  status: string;
  /** Soft-deleted. Archived rows are excluded from every sum: a goal is not
   *  more finished because somebody archived the rest of it. */
  archivedAt?: number;
  /** Chunk 2's stored run. Only `status: 'ok'` carries numbers; a `failed`
   *  run is an attempt that produced nothing, and absent is a ticket never
   *  scored. Three states, and none of them is zero. */
  effortEstimate?: {
    status: string;
    handsOnSeconds?: number;
    wallClockSeconds?: number;
  };
  /** The append-only trail. Wall-clock actuals are read from it. */
  transitions?: EffortTransition[];
  /** Folded-up human attention on the ticket's body room. Hands-on actuals
   *  are read from it, and its ABSENCE means not measured — never zero. */
  readingTime?: { totalSeconds?: number };
}

/** A usable estimate, narrowed off the stored union. */
export interface EffortEstimateNumbers {
  handsOnSeconds: number;
  wallClockSeconds: number;
}

function isPositiveFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/**
 * Read a ticket's estimate as numbers, or `null`.
 *
 * `null` covers all three not-a-number cases on purpose — never scored, a
 * recorded failure, and a stored run whose fields did not survive whatever
 * wrote them. A caller that needs to tell those apart asks the row directly
 * (see `effortEstimateState`); a caller that wants to SUM wants exactly
 * this.
 */
export function estimateNumbers(task: EffortTaskInput): EffortEstimateNumbers | null {
  const e = task.effortEstimate;
  if (!e || e.status !== 'ok') return null;
  const { handsOnSeconds, wallClockSeconds } = e;
  if (!isPositiveFinite(handsOnSeconds) || !isPositiveFinite(wallClockSeconds)) return null;
  return { handsOnSeconds, wallClockSeconds };
}

/** The three states named, for a surface that has to say which one it is. */
export function effortEstimateState(task: EffortTaskInput): 'ok' | 'failed' | 'none' {
  const e = task.effortEstimate;
  if (!e) return 'none';
  if (e.status === 'failed') return 'failed';
  return estimateNumbers(task) ? 'ok' : 'failed';
}

export function isEffortDone(task: EffortTaskInput): boolean {
  return task.status === 'done';
}

/** Archived rows are out of every sum — see `EffortTaskInput.archivedAt`. */
export function countsTowardEffort(task: EffortTaskInput): boolean {
  return task.archivedAt === undefined;
}

/**
 * When a ticket closed: the timestamp of its LAST move into `done`.
 *
 * Last rather than first, because a reopened-and-reclosed ticket finished
 * when it finished. `null` on a row with no done transition — including a
 * row whose status says done but whose trail predates the status gate,
 * which is a row we decline to date rather than one we date at zero.
 */
export function effortClosedAt(task: EffortTaskInput): number | null {
  const trail = task.transitions;
  if (!trail) return null;
  for (let i = trail.length - 1; i >= 0; i--) {
    const t = trail[i];
    if (t && t.to === 'done' && Number.isFinite(t.ts)) return t.ts;
  }
  return null;
}

/**
 * Measured wall-clock: first move into `in-progress` to last move into
 * `done`, in seconds.
 *
 * `null` when the ticket never entered `in-progress` — a row that went
 * straight from `todo` to `done` was never observed being worked, and the
 * honest answer to "how long did it take" is that nobody knows. Filling
 * that in from `createdAt` would report the length of the QUEUE as the
 * length of the work, and it would do it on exactly the small tickets that
 * skip `in-progress`, biasing the whole calibration upward.
 */
export function effortActualWallClockSeconds(task: EffortTaskInput): number | null {
  const trail = task.transitions;
  if (!trail) return null;
  let startedAt: number | null = null;
  for (const t of trail) {
    if (t.to === 'in-progress' && Number.isFinite(t.ts)) {
      startedAt = t.ts;
      break;
    }
  }
  if (startedAt === null) return null;
  const closedAt = effortClosedAt(task);
  if (closedAt === null || closedAt <= startedAt) return null;
  return Math.round((closedAt - startedAt) / 1000);
}

/**
 * Measured hands-on: the reading time already folded onto the row.
 *
 * `null` when nothing was measured. This is the field whose type doc says
 * in as many words that no reader may default it to zero, and a calibration
 * sample built from an assumed zero would drive every future hands-on
 * estimate to the floor.
 */
export function effortActualHandsOnSeconds(task: EffortTaskInput): number | null {
  const total = task.readingTime?.totalSeconds;
  return isPositiveFinite(total) ? Math.round(total) : null;
}

/** Clamp a correction factor into the trusted band. */
export function clampEffortRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 1;
  return Math.min(EFFORT_RATIO_MAX, Math.max(EFFORT_RATIO_MIN, ratio));
}

/**
 * Pull a small sample toward the board-wide answer.
 *
 * `n = 0` returns the board ratio exactly, which is what a brand new goal
 * needs: it inherits the board's experience rather than claiming none.
 */
export function shrinkEffortRatio(sample: number, board: number, n: number): number {
  if (n <= 0 || !Number.isFinite(sample)) return board;
  const w = n / (n + EFFORT_SHRINK_K);
  return board + (sample - board) * w;
}

/** Median of a list. `NaN` on empty — callers check first. */
export function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const hi = s[mid] as number;
  return s.length % 2 === 1 ? hi : ((s[mid - 1] as number) + hi) / 2;
}

/** Nearest-rank quantile — no interpolation, so the value returned is one
 *  that actually occurred. */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[idx] as number;
}

/**
 * How wrong an estimate was, symmetrically: `exp(|ln(actual / estimate)|) - 1`.
 *
 * A 1.5x miss reads as 0.5 whether the estimate ran high or low, which is
 * the property that makes a median error comparable across weeks. A raw
 * `actual / estimate - 1` does not have it: running 2x long scores +1.0 and
 * running 2x short scores -0.5, so a board that is half too-high and half
 * too-low averages out to "accurate".
 */
export function symmetricRatioError(actual: number, estimate: number): number {
  if (!isPositiveFinite(actual) || !isPositiveFinite(estimate)) return Number.NaN;
  return Math.exp(Math.abs(Math.log(actual / estimate))) - 1;
}

/** One learned correction, plus what it was learned from. */
export interface EffortRatio {
  /** The factor a raw estimate is multiplied by. Already shrunk and clamped. */
  ratio: number;
  /** How many closed tickets it was learned from. `0` means this goal is
   *  simply inheriting the board-wide ratio. */
  samples: number;
  /** Spread of the samples, as p75 over median. `1` when there are too few
   *  to say — which is what suppresses the "likely by" date. */
  spread: number;
}

/** The identity ratio: what a board with nothing to learn from uses. */
export function neutralRatio(): EffortRatio {
  return { ratio: 1, samples: 0, spread: 1 };
}

/** One quantity's ratios: the board's, and each goal's. */
export interface EffortRatioSet {
  board: EffortRatio;
  byGoal: Record<string, EffortRatio>;
}

/**
 * Both quantities' ratios.
 *
 * Kept apart on purpose. Wall-clock is measured for nearly every closed
 * ticket and hands-on for very few, so folding them into one factor would
 * let a well-measured wall-clock correction quietly rewrite hands-on
 * numbers it knows nothing about. Each side falls back to neutral on its
 * own evidence.
 */
export interface EffortCalibration {
  wallClock: EffortRatioSet;
  handsOn: EffortRatioSet;
}

export function neutralRatioSet(): EffortRatioSet {
  return { board: neutralRatio(), byGoal: {} };
}

export function neutralCalibration(): EffortCalibration {
  return { wallClock: neutralRatioSet(), handsOn: neutralRatioSet() };
}

/** A closed ticket with both an estimate and a measured actual. */
export interface EffortSample {
  goal: string;
  estimateSeconds: number;
  actualSeconds: number;
}

function spreadOf(ratios: number[], centre: number): number {
  if (ratios.length < EFFORT_MIN_SAMPLES_FOR_RANGE || !isPositiveFinite(centre)) return 1;
  const p75 = quantile(ratios, 0.75);
  if (!isPositiveFinite(p75)) return 1;
  return Math.min(EFFORT_RATIO_MAX, Math.max(1, p75 / centre));
}

/**
 * Learn one quantity's correction factors from tickets that already closed.
 *
 * Medians rather than means throughout: the distribution is heavy-tailed —
 * one ticket that sat open over a holiday would otherwise set the whole
 * board's factor.
 */
export function computeEffortRatios(samples: EffortSample[]): EffortRatioSet {
  const usable = samples.filter(
    (s) => isPositiveFinite(s.estimateSeconds) && isPositiveFinite(s.actualSeconds),
  );
  if (usable.length === 0) return neutralRatioSet();
  const allRatios = usable.map((s) => s.actualSeconds / s.estimateSeconds);
  const boardMedian = median(allRatios);
  const board: EffortRatio = {
    ratio: clampEffortRatio(boardMedian),
    samples: usable.length,
    spread: spreadOf(allRatios, boardMedian),
  };
  const grouped = new Map<string, number[]>();
  for (const s of usable) {
    const r = s.actualSeconds / s.estimateSeconds;
    const list = grouped.get(s.goal);
    if (list) list.push(r);
    else grouped.set(s.goal, [r]);
  }
  const byGoal: Record<string, EffortRatio> = {};
  for (const [goal, ratios] of grouped) {
    const own = median(ratios);
    // Shrink toward the board BEFORE clamping. Clamping a wild sample first
    // and then pulling it toward the board would launder an outlier into a
    // number that looks like evidence.
    byGoal[goal] = {
      ratio: clampEffortRatio(shrinkEffortRatio(own, boardMedian, ratios.length)),
      samples: ratios.length,
      spread: spreadOf(ratios, own),
    };
  }
  return { board, byGoal };
}

/** A ticket as the calibrator reads it: whatever `EffortTaskInput` holds,
 *  plus the band it sits under. */
export interface EffortCalibrationTask extends EffortTaskInput {
  goal: string;
}

/**
 * Build both ratio sets from a board's own history.
 *
 * A ticket contributes to a quantity only when it closed, carries an
 * estimate, AND has a measured actual for THAT quantity — so a closed
 * ticket nobody ever opened calibrates wall-clock and stays out of
 * hands-on entirely, rather than entering it as a zero.
 */
export function computeEffortCalibration(tasks: EffortCalibrationTask[]): EffortCalibration {
  const wallClock: EffortSample[] = [];
  const handsOn: EffortSample[] = [];
  for (const task of tasks) {
    if (!countsTowardEffort(task) || !isEffortDone(task)) continue;
    const est = estimateNumbers(task);
    if (!est) continue;
    const wall = effortActualWallClockSeconds(task);
    if (wall !== null) {
      wallClock.push({
        goal: task.goal,
        estimateSeconds: est.wallClockSeconds,
        actualSeconds: wall,
      });
    }
    const hands = effortActualHandsOnSeconds(task);
    if (hands !== null) {
      handsOn.push({ goal: task.goal, estimateSeconds: est.handsOnSeconds, actualSeconds: hands });
    }
  }
  return { wallClock: computeEffortRatios(wallClock), handsOn: computeEffortRatios(handsOn) };
}

/** The factor in force for one goal, in one ratio set. */
export function ratioForGoal(set: EffortRatioSet, goal: string): EffortRatio {
  return set.byGoal[goal] ?? set.board;
}

/**
 * A raw estimate, corrected.
 *
 * Rounds once, here, at the point the applied number is summed — seconds
 * are integers everywhere (Bryan, 2026-08-30), and thousands of rows
 * summing into a goal must not carry drifting fractions.
 */
export function applyEffortRatio(rawSeconds: number, ratio: number): number {
  return Math.round(rawSeconds * clampEffortRatio(ratio));
}

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
  const windowStart = now - EFFORT_PACE_WINDOW_DAYS * DAY_MS;
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
      doneWallClock += wall;
      // Pace is measured in ESTIMATE-seconds closed per day, not in actual
      // seconds. That keeps it in the same currency as the remainder it is
      // divided into — dividing a remaining estimate by a rate of actuals
      // would apply the correction twice, once in each operand.
      const closedAt = effortClosedAt(task);
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
  const paceSecondsPerDay = closedSecondsInWindow / EFFORT_PACE_WINDOW_DAYS;
  const summary: GoalEffortReady = {
    kind: 'ready',
    percentComplete,
    handsOnRemainingSeconds: handsOnRemaining,
    wallClockRemainingSeconds: wallClockRemaining,
    paceSecondsPerDay,
    closesInWindow,
    estimatedCount,
    unestimatedCount,
    failedCount,
    wallClockRatio,
    handsOnRatio,
  };
  if (closesInWindow >= EFFORT_MIN_CLOSES_FOR_PROJECTION && paceSecondsPerDay > 0) {
    if (wallClockRemaining === 0) {
      summary.projectedFinishAt = now;
    } else {
      const days = wallClockRemaining / paceSecondsPerDay;
      summary.projectedFinishAt = now + days * DAY_MS;
      if (wallClockRatio.spread > 1) {
        summary.projectedLatestAt = now + days * wallClockRatio.spread * DAY_MS;
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
  if (s >= 86400) {
    const days = Math.floor(s / 86400);
    const hours = Math.round((s % 86400) / 3600);
    if (hours >= 24) return `${days + 1}d`;
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    // 59.6 minutes past the hour must carry, not render as "1h 60m".
    return m >= 60 ? `${h + 1}h` : m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const minutes = Math.round(s / 60);
  return minutes >= 1 ? `${minutes}m` : '<1m';
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
  if (s < 86400) return formatEffortSeconds(Math.round(s / 600) * 600);
  const days = Math.round(s / (86400 / 2)) / 2;
  return `${days}d`;
}

/** `Sep 12`, in the reader's own locale. Every date this module produces is
 *  approximate; the surface that shows one says so beside it. */
export function formatEffortDate(at: number, locale?: string): string {
  return new Date(at).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}
