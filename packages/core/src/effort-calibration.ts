/**
 * Chunk 3 of the effort model: what a goal's closed tickets say about how
 * its open ones were scored.
 *
 * A ratio is a correction factor learned from the tickets that already
 * finished — actual over estimate, per goal, shrunk toward the board — and
 * it scales the FORECAST only. That last clause is the rule the whole file
 * is built to keep: **measured numbers are never multiplied.** Actuals are
 * reported as they happened. Correcting a known bias is the whole job of a
 * forecast and none of the job of a measurement.
 *
 * The priors are the same rule read one step earlier. A prior is the board
 * ratio a goal inherits when nothing has closed to learn from — a starting
 * point for the forecast, replacing an identity factor that was itself an
 * assumption (that the scorer is unbiased) and simply a worse one. It
 * multiplies no measurement and fills no absent estimate with a number.
 *
 * The doc comments on each constant are load-bearing:
 * docs/architecture/goal-projection.md points at them for why a prior is the
 * value it is, and they must move with the arithmetic rather than being
 * summarised anywhere else.
 *
 * Reads one ticket through `effort-task.ts`; chunk 4 (`goal-effort.ts`)
 * reads this.
 */
import {
  type EffortTaskInput,
  countsTowardEffort,
  effortActualHandsOnSeconds,
  effortActualWallClockSeconds,
  estimateNumbers,
  isCurrentGenerationEstimate,
  isEffortDone,
  isPositiveFinite,
} from './effort-task.ts';

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

/** Below this many samples there is no spread, so no "likely by" date: a
 *  range computed from one sample is not a range. */
export const EFFORT_MIN_SAMPLES_FOR_RANGE = 3;

/**
 * Below this many closed tickets a level does not get a factor of its own.
 *
 * Shrinkage was supposed to be the whole answer here and it is not, because
 * `shrink(r, r, 1) = r` exactly. A goal's own median is pulled toward the
 * BOARD's — and on a board whose only closed ticket is that goal's, the
 * board median IS that ticket. The pull is toward itself, the weight never
 * matters, and one close moved every forecast on the board at full strength.
 * The second close could move it back just as far.
 *
 * So there is a floor, and it applies at both levels the same way: below
 * three closes a level inherits the level above it — a goal takes the
 * board's factor, and the board takes the prior — rather than claiming a
 * correction of its own. Above three, shrinkage does the job it was always
 * good at: blending a small sample into a larger one.
 *
 * Three, and the same three as `EFFORT_MIN_CLOSES_FOR_PROJECTION` and
 * `EFFORT_MIN_SAMPLES_FOR_RANGE`, because it is the same judgement in all
 * three places: below three there is a data point, not a distribution. A
 * board that has closed two tickets is not a board that knows how fast it
 * is; it is a board with an anecdote.
 */
export const EFFORT_MIN_SAMPLES_FOR_CALIBRATION = 3;

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
  /** How many closed tickets this level's factor was LEARNED FROM. `0` means
   *  the level is inheriting — the board from the prior, or a goal from the
   *  board — and it is the field every "×N from M closed tickets" sentence
   *  keys on, so it must never be a count of closes that did not move the
   *  number. */
  samples: number;
  /** How many closed tickets this level actually has, whether or not they
   *  were enough to move the factor. The difference between this and
   *  `samples` is the honest wording for a goal with one or two closes:
   *  something HAS closed, and saying "nothing has closed yet" about it
   *  would be false. */
  observedSamples: number;
  /** Spread of the samples, as p75 over median. `1` when there are too few
   *  to say — which is what suppresses the "likely by" date. */
  spread: number;
  /** Does this factor rest on measured closes anywhere — this level, or the
   *  level it inherited from?
   *
   *  Distinct from `samples > 0`, and the distinction is the whole reason
   *  the flag exists. A goal with one close inherits a board factor learned
   *  from forty, and its projection is calibrated even though the goal
   *  taught it nothing; a goal on a board that has closed twice inherits a
   *  prior, and its projection is a guess. Both have `samples: 0`. The
   *  board's "estimate only" marker is this field, negated. */
  calibrated: boolean;
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
export function neutralRatio(prior = 1, observedSamples = 0): EffortRatio {
  return {
    ratio: clampEffortRatio(prior),
    samples: 0,
    observedSamples,
    spread: 1,
    calibrated: false,
  };
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
  if (usable.length < EFFORT_MIN_SAMPLES_FOR_CALIBRATION) {
    // One or two closes on the whole board. Every goal keeps the prior, and
    // says so — `observedSamples` carries what did close, so a panel can
    // report "two so far" instead of the false "nothing has closed yet".
    // Shrinking here instead would not hold: with a single sample the board
    // median is that sample and a goal's shrink target is itself, which is
    // the bug this floor exists to close.
    const board = neutralRatio(prior, usable.length);
    const byGoal: Record<string, EffortRatio> = {};
    for (const s of usable) {
      const seen = (byGoal[s.goal]?.observedSamples ?? 0) + 1;
      byGoal[s.goal] = neutralRatio(prior, seen);
    }
    return { board, byGoal };
  }
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
    observedSamples: usable.length,
    // Spread is measured against the board's OWN median, not the shrunk
    // ratio: it answers "how scattered were these closes", which is a fact
    // about the samples and has nothing to do with how much of the prior is
    // still in the answer.
    spread: spreadOf(allRatios, boardMedian),
    calibrated: true,
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
    if (ratios.length < EFFORT_MIN_SAMPLES_FOR_CALIBRATION) {
      // One or two closes under this goal: it takes the board's factor
      // whole, rather than a version of it bent by an anecdote. The board is
      // calibrated (we are past the floor above), so the goal's projection
      // is calibrated too — it simply learned the correction from the board
      // rather than from itself, which `samples: 0` says and `calibrated`
      // qualifies.
      //
      // The board's SPREAD comes with it, deliberately. A goal with no
      // closes at all already inherits it — `ratioForGoal` falls through to
      // `set.board` — and a goal with one close knowing less about its own
      // scatter than a goal with none would be a strange thing to build.
      byGoal[goal] = { ...board, samples: 0, observedSamples: ratios.length };
      continue;
    }
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
      observedSamples: ratios.length,
      spread: spreadOf(ratios, own),
      calibrated: true,
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

/**
 * The factor in force for one goal, in one ratio set.
 *
 * A goal with no entry has closed nothing, and inherits the board's FACTOR —
 * that is the whole design. What it must not inherit is the board's
 * EVIDENCE. Handing back `set.board` whole gave such a goal the board's
 * counts, and every sentence on the surfaces below says "on this goal": a
 * board holding two closes under some other band reported them as two closes
 * under this one, and a board holding forty reported forty. Both counts are
 * zeroed here, at the one place the inheritance happens, so no caller has to
 * remember to.
 *
 * `calibrated` is deliberately NOT zeroed: whether the factor rests on
 * measurement is a fact about the factor, and it travels with it.
 */
export function ratioForGoal(set: EffortRatioSet, goal: string): EffortRatio {
  return set.byGoal[goal] ?? { ...set.board, samples: 0, observedSamples: 0 };
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
