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

import { EFFORT_ESTIMATE_PROMPT_VERSION } from './effort-estimate-prompt.ts';

/**
 * A ratio outside this band is a correction nobody should trust more than
 * the estimate it corrects.
 *
 * The floor was 0.5, borrowed from the weekly-review multiplier, and on
 * this board it threw away the only thing calibration had learned. Nine
 * closed tickets ran at a median 0.099 of their estimated calendar time and
 * five at 0.010 of their estimated hands-on time; the clamp reported both
 * as 0.5, so a measured ten-fold speed-up left the forecast at half. A
 * floor is meant to refuse a correction drawn from too little evidence, and
 * a two-order-of-magnitude one drawn from nine samples is not that — it is
 * the answer. 0.02 still refuses the fifty-fold correction a single
 * mis-scored ticket can produce, and lets a measured 0.1 through intact.
 *
 * The ceiling is untouched: an estimate that ran LONGER than expected is the
 * direction where a single stuck ticket does the damage the trim exists to
 * stop.
 */
export const EFFORT_RATIO_MIN = 0.02;
export const EFFORT_RATIO_MAX = 2.0;

/**
 * What a board assumes before it has closed anything of its own: that the
 * scorer, told agents do the work, still sizes a ticket for a person.
 *
 * The weekly-review tool's priors, and the reason they are not 1.0. An
 * identity ratio is not the neutral choice it looks like — it is the claim
 * that the scorer is unbiased, which this board has direct evidence against
 * in both quantities and in the same direction. Starting at 1.0 meant every
 * goal with nothing closed under it forecast human effort, which on the
 * board that prompted this work read as months of the owner's own attention
 * on a goal an agent was days from finishing.
 *
 * Wall-clock corrects less than hands-on because it corrects a different
 * thing. An agent working continuously compresses the calendar, but a
 * ticket still waits on a review, a decision, or the thing before it — and
 * none of that waiting gets faster. Hands-on has no such floor: the work an
 * agent does alone leaves the owner's column entirely.
 *
 * A prior is a STARTING POINT, not a setting, and the handover is gradual
 * rather than a step: `computeEffortRatios` shrinks the board's measured
 * median TOWARD the prior on `EFFORT_SHRINK_K`, so the first close carries a
 * sixth of the answer and the prior is most of what is left. Without that
 * shrinkage a prior would not be a prior at all — the first ticket to close
 * would delete it, and one outlying close would move every forecast on the
 * board.
 */
export const EFFORT_PRIOR_WALL_CLOCK_RATIO = 1 / 7;
export const EFFORT_PRIOR_HANDS_ON_RATIO = 1 / 15;

/** Shrinkage weight: a goal's own ratio carries `n / (n + K)` of the answer
 *  and the board-wide ratio carries the rest, so two closed tickets barely
 *  move a goal off the board's own experience. */
export const EFFORT_SHRINK_K = 5;

/**
 * The FURTHEST back `pace` looks when turning closes into a finish date.
 *
 * A ceiling rather than the window itself. It used to be both, and dividing
 * every goal's closes by a flat fourteen days made the denominator a fact
 * about the calendar instead of a fact about the goal: a goal three days old
 * with two closes read as `2/14` per day and looked becalmed, while a goal
 * running since spring read fast because only its last fortnight counted.
 * Same numerator, and the one that had earned it got the smaller rate.
 *
 * So the divisor is now the goal's own ACTIVE WINDOW — see
 * `goalPaceWindowDays` — and this constant only stops that window growing
 * without limit. Fourteen days is still the horizon a pace is drawn from,
 * because a rate learned from what a goal was doing two months ago is not a
 * rate: it is history.
 */
export const EFFORT_PACE_WINDOW_DAYS = 14;

/**
 * And the floor, because a young goal's window shrinks toward zero.
 *
 * A goal whose first ticket was filed an hour ago would otherwise divide its
 * closes by 1/24 of a day and claim a pace twenty-four times anything it has
 * actually demonstrated. One day is the shortest span this board is willing
 * to call a rate — below it, the goal is reported at the pace it managed in
 * its first day, which is the most a few hours of evidence can honestly say.
 */
export const EFFORT_MIN_PACE_WINDOW_DAYS = 1;

/** Below this many closes inside the pace window there is no projection —
 *  a date drawn from one or two closes is a number pretending to be a
 *  forecast. */
export const EFFORT_MIN_CLOSES_FOR_PROJECTION = 3;

/** Below this many samples there is no spread, so no "likely by" date: a
 *  range computed from one sample is not a range. */
export const EFFORT_MIN_SAMPLES_FOR_RANGE = 3;

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
  /** When the ticket was filed. Read by `goalPaceWindowDays` only, to date
   *  the goal it sits under: a goal is as old as its oldest live ticket,
   *  because the goal record itself never reaches this module. Optional so a
   *  caller holding a row without one still gets a pace — the window then
   *  falls back to the ticket's first transition, and to the full
   *  `EFFORT_PACE_WINDOW_DAYS` when a band carries no timestamp at all. */
  createdAt?: number;
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
    /** Which generation of the ask produced this — see
     *  `EFFORT_ESTIMATE_PROMPT_VERSION`. Read by the CALIBRATOR only, never
     *  by the rollup: an estimate made under an older prompt is still the
     *  best number this ticket has, and dropping it from the forecast would
     *  make a scored goal read "not scored" for as long as re-scoring takes.
     *  What it must not do is teach a correction factor — see
     *  `isCurrentGenerationEstimate`. Absent on every row written before the
     *  field existed. */
    promptVersion?: number;
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

/**
 * Was this estimate made under the CURRENT ask?
 *
 * Only calibration asks. A correction factor is `actual / estimate`, and
 * the estimate in that fraction was produced by one particular prompt — so
 * a factor learned from version 1's human-scaled numbers describes version
 * 1's bias and nothing else. Applied to version 2's agent-scaled numbers it
 * would discount the same speed-up twice: once because the prompt now says
 * an agent does the work, and again because the old estimates were wrong
 * about that. On the board this was measured on, that is a factor of 0.02
 * on top of an estimate already ten times smaller, which renders a goal
 * with real work left in it as "<1m".
 *
 * So a prompt bump deliberately empties the sample set, and the priors are
 * what a board forecasts with until it has closed tickets scored under the
 * new ask. That is the cost of changing the question, paid where it is
 * visible, rather than a stale answer to the old one carried forward
 * silently.
 *
 * A row with no `promptVersion` at all predates the field and is treated as
 * an older generation — the safe direction, and the same one
 * `recordEffortEstimate` takes with a missing revision.
 */
export function isCurrentGenerationEstimate(task: EffortTaskInput): boolean {
  return task.effortEstimate?.promptVersion === EFFORT_ESTIMATE_PROMPT_VERSION;
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
 * The earliest moment this module can prove the ticket existed.
 *
 * `createdAt` when the caller has one, and the first transition otherwise —
 * a row that moved must have existed by the time it moved. `null` when
 * neither is there, which is a row we decline to date rather than one we
 * date at the epoch: `Math.min` over a stray `0` would make every goal
 * containing that row fifty-six years old.
 */
export function effortFirstSeenAt(task: EffortTaskInput): number | null {
  if (isPositiveFinite(task.createdAt)) return task.createdAt;
  let earliest: number | null = null;
  for (const t of task.transitions ?? []) {
    if (!Number.isFinite(t.ts) || t.ts <= 0) continue;
    if (earliest === null || t.ts < earliest) earliest = t.ts;
  }
  return earliest;
}

/**
 * How many days of history a goal's pace is divided by.
 *
 * The goal's own age — first ticket filed to now — clamped into
 * `[EFFORT_MIN_PACE_WINDOW_DAYS, EFFORT_PACE_WINDOW_DAYS]`. This is the
 * denominator that used to be a flat fourteen, and the fix is the whole of
 * ticket "goal pace reflects how long the goal has actually run": two closes
 * on a three-day-old goal are two closes in three days, not two closes in a
 * fortnight.
 *
 * The goal's OWN creation date would be the better input and this module
 * never sees it — `summarizeGoalEffort` is handed a list of tickets, by
 * design, so that the board can recompute it client-side from the rows it
 * already holds. The oldest live ticket in the band is the closest honest
 * proxy, and it errs the safe way: a goal cannot have been running before
 * anything was filed under it, so the window can only come out too SHORT,
 * never too long. Where it is too short — a goal whose early tickets were
 * all archived — the clamp still bounds the damage to a single day.
 *
 * Archived rows are already out of the list the caller passes (see
 * `countsTowardEffort`); nothing here re-filters them.
 */
export function goalPaceWindowDays(tasks: EffortTaskInput[], now: number): number {
  let earliest: number | null = null;
  for (const task of tasks) {
    const seen = effortFirstSeenAt(task);
    if (seen === null) continue;
    if (earliest === null || seen < earliest) earliest = seen;
  }
  // A band with no timestamp anywhere gets the old behaviour rather than the
  // floor: nothing is known about its age, and one day is a CLAIM about a
  // young goal, not a neutral answer.
  if (earliest === null) return EFFORT_PACE_WINDOW_DAYS;
  const days = (now - earliest) / DAY_MS;
  if (!Number.isFinite(days)) return EFFORT_PACE_WINDOW_DAYS;
  return Math.min(EFFORT_PACE_WINDOW_DAYS, Math.max(EFFORT_MIN_PACE_WINDOW_DAYS, days));
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

/**
 * The ratio a board with nothing to learn from uses.
 *
 * `samples: 0` is the load-bearing field and it stays honest: a prior is
 * not evidence, so nothing may report it as a correction learned from
 * closed tickets. Every surface that explains a factor keys on this count,
 * and the one that says "×N from M closed tickets" must never say it about
 * a number no ticket produced.
 *
 * Defaults to the identity for a caller that genuinely has no prior; the
 * two quantities' own priors are named above and applied by
 * `neutralCalibration`.
 */
export function neutralRatio(prior = 1): EffortRatio {
  return { ratio: clampEffortRatio(prior), samples: 0, spread: 1 };
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

export function neutralRatioSet(prior = 1): EffortRatioSet {
  return { board: neutralRatio(prior), byGoal: {} };
}

/**
 * Both quantities at their priors — what a board forecasts with before
 * anything has closed under the current prompt.
 *
 * Not the identity calibration any more, and callers that want THAT (a
 * test isolating the rollup arithmetic from the correction) ask for it by
 * building one out of `neutralRatioSet()` with no argument. Making the
 * priors the default is deliberate: this is the function every real caller
 * reaches for when there is nothing to calibrate from, and a default that
 * quietly forecast human effort is the bug being fixed.
 */
export function neutralCalibration(): EffortCalibration {
  return {
    wallClock: neutralRatioSet(EFFORT_PRIOR_WALL_CLOCK_RATIO),
    handsOn: neutralRatioSet(EFFORT_PRIOR_HANDS_ON_RATIO),
  };
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
export function computeEffortRatios(samples: EffortSample[], prior = 1): EffortRatioSet {
  const usable = samples.filter(
    (s) => isPositiveFinite(s.estimateSeconds) && isPositiveFinite(s.actualSeconds),
  );
  if (usable.length === 0) return neutralRatioSet(prior);
  const allRatios = usable.map((s) => s.actualSeconds / s.estimateSeconds);
  const boardMedian = median(allRatios);
  // The BOARD is shrunk toward the prior, on the same weight a goal is
  // shrunk toward the board. Without this the prior is not a prior at all —
  // it is a placeholder that the first close deletes: `boardMedian` would
  // replace it outright, every goal with no samples inherits the board, and
  // every goal WITH samples is shrunk toward it, so one outlying close moves
  // every forecast on the board from ×0.07 to anywhere inside the clamp.
  // Shrinkage is what makes the handover gradual, which is the only thing
  // that makes a prior worth having.
  const boardRatio = clampEffortRatio(shrinkEffortRatio(boardMedian, prior, usable.length));
  const board: EffortRatio = {
    ratio: boardRatio,
    samples: usable.length,
    // Spread is measured against the board's OWN median, not the shrunk
    // ratio: it answers "how scattered were these closes", which is a fact
    // about the samples and has nothing to do with how much of the prior is
    // still in the answer.
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
    //
    // Toward `boardRatio` — the board as everything else on this board sees
    // it — not toward the raw median. A goal with no samples inherits
    // `board.ratio`, so shrinking a one-sample goal toward a different number
    // would have two goals disagreeing about what the board's answer is.
    byGoal[goal] = {
      ratio: clampEffortRatio(shrinkEffortRatio(own, boardRatio, ratios.length)),
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
    if (!isCurrentGenerationEstimate(task)) continue;
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
  return {
    wallClock: computeEffortRatios(wallClock, EFFORT_PRIOR_WALL_CLOCK_RATIO),
    handsOn: computeEffortRatios(handsOn, EFFORT_PRIOR_HANDS_ON_RATIO),
  };
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
  /** How many days that rate was measured over — the goal's own age, capped
   *  at `EFFORT_PACE_WINDOW_DAYS` and floored at
   *  `EFFORT_MIN_PACE_WINDOW_DAYS`. On the summary rather than recomputed by
   *  each surface, because the sentence a header prints ("on the last N
   *  days' pace") has to name the same N the arithmetic used. */
  paceWindowDays: number;
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
