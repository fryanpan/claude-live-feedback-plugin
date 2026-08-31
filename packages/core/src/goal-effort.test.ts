import { describe, expect, it } from 'vitest';
import { EFFORT_ESTIMATE_PROMPT_VERSION } from './effort-estimate-prompt.ts';
import {
  EFFORT_MAX_PROJECTION_DAYS,
  EFFORT_MIN_CLOSES_FOR_PROJECTION,
  EFFORT_MIN_PACE_WINDOW_DAYS,
  EFFORT_PACE_WINDOW_DAYS,
  EFFORT_PRIOR_HANDS_ON_RATIO,
  EFFORT_PRIOR_WALL_CLOCK_RATIO,
  EFFORT_RATIO_MIN,
  type EffortCalibration,
  type EffortCalibrationTask,
  type EffortSample,
  type EffortTaskInput,
  type GoalEffortReady,
  applyEffortRatio,
  clampEffortRatio,
  computeEffortCalibration,
  computeEffortRatios,
  effortActualHandsOnSeconds,
  effortActualWallClockSeconds,
  effortClosedAt,
  effortEstimateState,
  estimateNumbers,
  formatEffortSeconds,
  formatGoalEffortSeconds,
  goalPaceWindowDays,
  isCurrentGenerationEstimate,
  isObservedClose,
  neutralCalibration,
  neutralRatioSet,
  ratioForGoal,
  shrinkEffortRatio,
  summarizeGoalEffort,
  symmetricRatioError,
} from './goal-effort.ts';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);

function ok(wallClockSeconds: number, handsOnSeconds: number): EffortTaskInput['effortEstimate'] {
  // Stamped with the CURRENT generation, because that is what a fixture
  // standing in for a stored run is: the server writes the version on every
  // record. A fixture without one is a row scored under an older ask, and
  // the calibrator refuses to learn from those — which is its own test
  // ("a stale-generation estimate teaches nothing"), not an accident every
  // other test in this file should inherit.
  return {
    status: 'ok',
    wallClockSeconds,
    handsOnSeconds,
    promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION,
  };
}

/**
 * Both ratios at 1: the rollup arithmetic with the correction taken out.
 *
 * `neutralCalibration()` is no longer the identity — it starts at the
 * board's priors (`EFFORT_PRIOR_*`), which is the right default for a real
 * caller and the wrong one for a test asserting that 3600 estimate-seconds
 * come out as 3600. Those tests are about the fraction and the pace; the
 * prior has its own block below.
 */
function identity(): EffortCalibration {
  return { wallClock: neutralRatioSet(), handsOn: neutralRatioSet() };
}

/**
 * A ticket on a goal that has been running a while.
 *
 * `createdAt` is part of the default because the PACE WINDOW is now the
 * goal's own age (`goalPaceWindowDays`), and a fixture with no timestamps
 * would silently date every goal from its first close — making the
 * denominator an accident of when the closes were placed rather than
 * something each test states. Dating the fixture a full window back keeps
 * the denominator at `EFFORT_PACE_WINDOW_DAYS`, which is what the arithmetic
 * in the projection tests is written against; a test about a YOUNG goal
 * overrides it and says so.
 */
function task(over: Partial<EffortTaskInput> = {}): EffortTaskInput {
  return {
    status: 'todo',
    createdAt: NOW - EFFORT_PACE_WINDOW_DAYS * DAY,
    effortEstimate: ok(3600, 600),
    ...over,
  };
}

/** A closed ticket: worked for `workedMs`, finished `agoMs` before NOW. */
function closed(
  agoMs: number,
  workedMs = HOUR,
  over: Partial<EffortTaskInput> = {},
): EffortTaskInput {
  const doneAt = NOW - agoMs;
  return task({
    status: 'done',
    transitions: [
      { ts: doneAt - workedMs, to: 'in-progress' },
      { ts: doneAt, to: 'done' },
    ],
    ...over,
  });
}

describe('estimateNumbers / effortEstimateState', () => {
  it('reads a stored ok run', () => {
    expect(estimateNumbers(task())).toEqual({ wallClockSeconds: 3600, handsOnSeconds: 600 });
    expect(effortEstimateState(task())).toBe('ok');
  });

  it('keeps never-scored and failed apart, and treats neither as a number', () => {
    const never = task({ effortEstimate: undefined });
    const failed = task({ effortEstimate: { status: 'failed' } });
    expect(estimateNumbers(never)).toBeNull();
    expect(estimateNumbers(failed)).toBeNull();
    expect(effortEstimateState(never)).toBe('none');
    expect(effortEstimateState(failed)).toBe('failed');
  });

  it('rejects a half-written or non-positive stored run', () => {
    expect(
      estimateNumbers(task({ effortEstimate: { status: 'ok', wallClockSeconds: 3600 } })),
    ).toBeNull();
    expect(estimateNumbers(task({ effortEstimate: ok(0, 0) }))).toBeNull();
    expect(estimateNumbers(task({ effortEstimate: ok(3600, -5) }))).toBeNull();
  });
});

describe('actuals are derived, never stored', () => {
  it('measures wall-clock from first in-progress to last done', () => {
    const t = task({
      status: 'done',
      transitions: [
        { ts: 1000, to: 'todo' },
        { ts: 2000, to: 'in-progress' },
        { ts: 5000, to: 'todo' },
        { ts: 8000, to: 'in-progress' },
        { ts: 12_000, to: 'done' },
      ],
    });
    // First claim at 2000, last close at 12000 → 10s.
    expect(effortActualWallClockSeconds(t)).toBe(10);
    expect(effortClosedAt(t)).toBe(12_000);
  });

  it('takes the LAST close, so a reopened ticket finished when it finished', () => {
    const t = task({
      status: 'done',
      transitions: [
        { ts: 1000, to: 'in-progress' },
        { ts: 3000, to: 'done' },
        { ts: 4000, to: 'in-progress' },
        { ts: 9000, to: 'done' },
      ],
    });
    expect(effortClosedAt(t)).toBe(9000);
    expect(effortActualWallClockSeconds(t)).toBe(8);
  });

  it('declines to measure a ticket that never entered in-progress', () => {
    // Filling this in from createdAt would report queue length as work
    // length, on exactly the small tickets that skip the claim.
    const t = task({
      status: 'done',
      transitions: [
        { ts: 1000, to: 'todo' },
        { ts: 90_000, to: 'done' },
      ],
    });
    expect(effortActualWallClockSeconds(t)).toBeNull();
    expect(effortClosedAt(t)).toBe(90_000);
  });

  it('has no wall-clock actual with no trail at all', () => {
    expect(effortActualWallClockSeconds(task({ status: 'done' }))).toBeNull();
    expect(effortClosedAt(task({ status: 'done' }))).toBeNull();
  });

  it('reads hands-on off reading time, and reports absence as absence', () => {
    expect(effortActualHandsOnSeconds(task({ readingTime: { totalSeconds: 900 } }))).toBe(900);
    expect(effortActualHandsOnSeconds(task())).toBeNull();
    expect(effortActualHandsOnSeconds(task({ readingTime: {} }))).toBeNull();
    // The line the type doc draws: nobody read it is not "read for 0s".
    expect(effortActualHandsOnSeconds(task({ readingTime: { totalSeconds: 0 } }))).toBeNull();
  });
});

describe('ratio arithmetic', () => {
  it('clamps into the trusted band', () => {
    // 0.1 is INSIDE the band now, and that is the point of widening it: a
    // measured ten-fold speed-up used to be reported as half.
    expect(clampEffortRatio(0.1)).toBeCloseTo(0.1);
    expect(clampEffortRatio(0.001)).toBe(EFFORT_RATIO_MIN);
    expect(clampEffortRatio(9)).toBe(2);
    expect(clampEffortRatio(1.3)).toBeCloseTo(1.3);
    expect(clampEffortRatio(Number.NaN)).toBe(1);
  });

  it('shrinks a small sample toward the board, and n=0 lands on the board exactly', () => {
    expect(shrinkEffortRatio(2, 1, 0)).toBe(1);
    expect(shrinkEffortRatio(2, 1, 5)).toBeCloseTo(1.5); // n = K → half weight
    expect(shrinkEffortRatio(2, 1, 45)).toBeCloseTo(1.9);
  });

  it('rounds the applied number once, to whole seconds', () => {
    expect(applyEffortRatio(3600, 1.5)).toBe(5400);
    expect(applyEffortRatio(1001, 1.3335)).toBe(1335);
    expect(Number.isInteger(applyEffortRatio(777, 1.234))).toBe(true);
  });

  it('scores a miss symmetrically in both directions', () => {
    expect(symmetricRatioError(150, 100)).toBeCloseTo(0.5);
    expect(symmetricRatioError(100, 150)).toBeCloseTo(0.5);
    expect(symmetricRatioError(100, 100)).toBeCloseTo(0);
  });
});

describe('computeEffortRatios', () => {
  it('is neutral with nothing closed', () => {
    const set = computeEffortRatios([]);
    expect(set.board.ratio).toBe(1);
    expect(set.board.samples).toBe(0);
    expect(ratioForGoal(set, 'g-anything').ratio).toBe(1);
  });

  it('learns from the median, so one outlier cannot set the board factor', () => {
    const set = computeEffortRatios([
      { goal: 'g1', estimateSeconds: 100, actualSeconds: 200 },
      { goal: 'g1', estimateSeconds: 100, actualSeconds: 200 },
      { goal: 'g1', estimateSeconds: 100, actualSeconds: 1000 },
    ]);
    // A mean would be dragged to ~4.7x; the median holds at 2x — and then
    // the board is shrunk toward its prior (1 here, the default), three
    // samples carrying 3/8 of the answer: 1 + (2 - 1) * 3/8.
    expect(set.board.ratio).toBe(1.375);
    // The property this test is for, stated as a comparison rather than a
    // constant: the same three closes read as a MEAN would land higher, and
    // the outlier is what puts it there.
    expect(shrinkEffortRatio((2 + 2 + 10) / 3, 1, 3)).toBeCloseTo(2.375);
  });

  /** Ten closes that ran exactly to estimate, so the board factor is 1. */
  const boardOfTen = (): EffortSample[] =>
    Array.from({ length: 10 }, () => ({ goal: 'g1', estimateSeconds: 100, actualSeconds: 100 }));

  it('gives a two-sample goal the board factor whole, not a bent version of it', () => {
    // Below EFFORT_MIN_SAMPLES_FOR_CALIBRATION a goal inherits rather than
    // shrinks. This used to read 1.2857 — the board pulled 2/7 of the way
    // toward an anecdote — and on a board whose only closes are that goal's,
    // the same arithmetic moved the factor the whole way, because the shrink
    // target was the anecdote itself.
    const set = computeEffortRatios([
      ...boardOfTen(),
      { goal: 'g2', estimateSeconds: 100, actualSeconds: 200 },
      { goal: 'g2', estimateSeconds: 100, actualSeconds: 200 },
    ]);
    expect(set.board.ratio).toBe(1);
    const g2 = ratioForGoal(set, 'g2');
    expect(g2.ratio).toBe(set.board.ratio);
    // Learned from none of its own, but two DID close, and the goal's
    // projection is calibrated — from the board.
    expect(g2.samples).toBe(0);
    expect(g2.observedSamples).toBe(2);
    expect(g2.calibrated).toBe(true);
  });

  it('pulls a three-sample goal most of the way back to the board', () => {
    // At the floor, shrinkage takes over and does the job it was always good
    // at. Positive control on the test above: the inheritance there is the
    // sample count, not calibration having been switched off.
    const set = computeEffortRatios([
      ...boardOfTen(),
      ...Array.from({ length: 3 }, () => ({
        goal: 'g2',
        estimateSeconds: 100,
        actualSeconds: 200,
      })),
    ]);
    expect(set.board.ratio).toBe(1);
    // 1 + (2 - 1) * 3/(3+5) = 1.375
    expect(ratioForGoal(set, 'g2').ratio).toBeCloseTo(1.375, 5);
    expect(ratioForGoal(set, 'g2').samples).toBe(3);
  });

  it('never lets a wild goal ratio out past the clamp', () => {
    const set = computeEffortRatios(
      Array.from({ length: 50 }, () => ({
        goal: 'g1',
        estimateSeconds: 10,
        actualSeconds: 10_000,
      })),
    );
    expect(set.byGoal.g1?.ratio).toBe(2);
    // The board is clamped too, on the far side of its own shrinkage: a
    // thousand-fold miss shrunk toward a prior of 1 is still 900x.
    expect(set.board.ratio).toBe(2);
  });

  it('claims no spread below three samples', () => {
    const set = computeEffortRatios([
      { goal: 'g1', estimateSeconds: 100, actualSeconds: 100 },
      { goal: 'g1', estimateSeconds: 100, actualSeconds: 400 },
    ]);
    expect(set.byGoal.g1?.spread).toBe(1);
  });
});

describe('the priors: what a board forecasts with before it has closed anything', () => {
  it('starts at the priors, not at 1 — and the two quantities differ', () => {
    const c = neutralCalibration();
    expect(c.wallClock.board.ratio).toBeCloseTo(EFFORT_PRIOR_WALL_CLOCK_RATIO);
    expect(c.handsOn.board.ratio).toBeCloseTo(EFFORT_PRIOR_HANDS_ON_RATIO);
    // Hands-on corrects harder: an agent working alone leaves the owner's
    // column entirely, where the calendar still waits on reviews.
    expect(c.handsOn.board.ratio).toBeLessThan(c.wallClock.board.ratio);
    // A prior is not evidence, and the surfaces that explain a factor key on
    // this count. It must never read as "learned from 0 closed tickets… and
    // also here is a correction we measured".
    expect(c.wallClock.board.samples).toBe(0);
    expect(c.handsOn.board.samples).toBe(0);
  });

  it('applies to a goal with no samples, and scales the forecast down', () => {
    const s = summarizeGoalEffort([task(), task()], 'g-new', neutralCalibration(), NOW);
    if (s.kind !== 'ready') throw new Error('expected ready');
    // Two open tickets at 600s hands-on each, and the ratio is applied — and
    // rounded — PER TICKET, before the sum. 600/15 = 40, twice.
    expect(s.handsOnRemainingSeconds).toBe(Math.round(600 * EFFORT_PRIOR_HANDS_ON_RATIO) * 2);
    expect(s.handsOnRatio.ratio).toBeCloseTo(EFFORT_PRIOR_HANDS_ON_RATIO);
    expect(s.wallClockRatio.ratio).toBeCloseTo(EFFORT_PRIOR_WALL_CLOCK_RATIO);
    // Positive control: the identity calibration on the same rows reports
    // the raw sums, so the assertion above cannot be met by a rollup that
    // simply returns small numbers.
    const raw = summarizeGoalEffort([task(), task()], 'g-new', identity(), NOW);
    if (raw.kind !== 'ready') throw new Error('expected ready');
    expect(raw.handsOnRemainingSeconds).toBe(1200);
    expect(s.handsOnRemainingSeconds).toBeLessThan(raw.handsOnRemainingSeconds);
  });

  it('is displaced by measurement — one goal on evidence, another still on the prior', () => {
    // g1 closes ten tickets that each ran at exactly their estimate; g2 has
    // closed nothing. g1 must forecast from its own experience, g2 from the
    // prior — the whole reason the prior is a starting point and not a knob.
    const closes: EffortCalibrationTask[] = Array.from({ length: 10 }, () => ({
      goal: 'g1',
      ...closed(2 * DAY, HOUR, { readingTime: { totalSeconds: 600 } }),
    }));
    const c = computeEffortCalibration(closes);
    // Not 1.0: ten closes is real evidence and not yet overwhelming
    // evidence, so the answer sits between the prior and the measurement —
    // nearer the measurement on the goal that owns the samples, because g1
    // is shrunk toward the board a second time from its own median of 1.
    const g1 = ratioForGoal(c.wallClock, 'g1').ratio;
    const g2 = ratioForGoal(c.wallClock, 'g2').ratio;
    expect(g1).toBeGreaterThan(c.wallClock.board.ratio);
    expect(g1).toBeLessThan(1);
    expect(c.wallClock.board.ratio).toBeGreaterThan(EFFORT_PRIOR_WALL_CLOCK_RATIO);
    // g2 has no bucket, so it falls back to the BOARD — which g1's closes
    // have now moved off the prior. That is correct and worth stating: a
    // prior is what a BOARD starts at, and a board with evidence has left it.
    expect(g2).toBe(c.wallClock.board.ratio);
    expect(g2).toBeGreaterThan(EFFORT_PRIOR_WALL_CLOCK_RATIO);
  });

  it('lets a measured 0.1 through, where the old floor reported it as 0.5', () => {
    // Nine closed tickets running at a tenth of their estimated calendar
    // time is what this board actually measured. The old floor of 0.5 threw
    // the finding away and forecast at half.
    const set = computeEffortRatios(
      Array.from({ length: 9 }, () => ({
        goal: 'g1',
        estimateSeconds: 10_000,
        actualSeconds: 1_000,
      })),
      EFFORT_PRIOR_WALL_CLOCK_RATIO,
    );
    // 0.1 measured, shrunk toward the 1/7 prior on nine samples — so the
    // answer is 0.115 rather than 0.099, and nowhere near the 0.5 the old
    // floor reported. The prior is CLOSE to the measurement here, which is
    // what a well-chosen prior looks like: it barely moves the answer.
    expect(set.board.ratio).toBeCloseTo(
      EFFORT_PRIOR_WALL_CLOCK_RATIO + (0.1 - EFFORT_PRIOR_WALL_CLOCK_RATIO) * (9 / 14),
    );
    expect(set.board.ratio).toBeGreaterThan(EFFORT_RATIO_MIN);
    expect(set.board.ratio).toBeLessThan(0.5);
    // The floor still refuses a correction orders of magnitude out, once
    // enough samples have pulled it clear of the prior.
    const wild = computeEffortRatios(
      Array.from({ length: 200 }, () => ({
        goal: 'g1',
        estimateSeconds: 10_000,
        actualSeconds: 1,
      })),
      EFFORT_PRIOR_WALL_CLOCK_RATIO,
    );
    expect(wild.board.ratio).toBe(EFFORT_RATIO_MIN);
  });
});

describe('a stale-generation estimate teaches nothing', () => {
  const old = (over: Partial<EffortTaskInput> = {}): EffortCalibrationTask => ({
    goal: 'g1',
    ...closed(2 * DAY, 2 * HOUR, {
      readingTime: { totalSeconds: 6 },
      effortEstimate: {
        status: 'ok',
        wallClockSeconds: 3600,
        handsOnSeconds: 600,
        promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION - 1,
      },
      ...over,
    }),
  });

  it('reads the generation off the row', () => {
    expect(isCurrentGenerationEstimate(task())).toBe(true);
    expect(isCurrentGenerationEstimate(old())).toBe(false);
    // A row written before the field existed is an older generation too —
    // the safe direction, and the same one recordEffortEstimate takes.
    expect(
      isCurrentGenerationEstimate(
        task({ effortEstimate: { status: 'ok', wallClockSeconds: 1, handsOnSeconds: 1 } }),
      ),
    ).toBe(false);
    expect(isCurrentGenerationEstimate(task({ effortEstimate: undefined }))).toBe(false);
  });

  it('keeps old-generation closes out of the sample set, so the board sits at its priors', () => {
    // Ten closed tickets, every one of them scored under the previous ask.
    // Their ratios are real — 2x on the calendar, 0.01 on hands-on — and
    // they describe the OLD prompt's bias. Applying them to estimates the
    // new prompt produced would discount the same speed-up twice.
    const c = computeEffortCalibration(Array.from({ length: 10 }, () => old()));
    expect(c.wallClock.board.samples).toBe(0);
    expect(c.handsOn.board.samples).toBe(0);
    expect(c.wallClock.board.ratio).toBeCloseTo(EFFORT_PRIOR_WALL_CLOCK_RATIO);
    expect(c.handsOn.board.ratio).toBeCloseTo(EFFORT_PRIOR_HANDS_ON_RATIO);
    // Positive control: the SAME ten closes, stamped with the current
    // generation, do calibrate — so the assertion above cannot be met by a
    // calibrator that has stopped learning from anything.
    const fresh = computeEffortCalibration(
      Array.from({ length: 10 }, () => ({
        goal: 'g1',
        ...closed(2 * DAY, 2 * HOUR, { readingTime: { totalSeconds: 6 } }),
      })),
    );
    expect(fresh.wallClock.board.samples).toBe(10);
    expect(fresh.wallClock.board.ratio).toBeCloseTo(
      EFFORT_PRIOR_WALL_CLOCK_RATIO + (2 - EFFORT_PRIOR_WALL_CLOCK_RATIO) * (10 / 15),
    );
    expect(fresh.wallClock.board.ratio).toBeGreaterThan(1);
  });

  it('still FORECASTS from an old-generation estimate — it is the best number the row has', () => {
    // The line the calibration gate must not cross. A goal whose tickets are
    // queued for re-scoring would otherwise read "not scored yet" — the
    // never-ran sentence — for as long as the re-score takes.
    const s = summarizeGoalEffort([old(), task({ status: 'todo' })], 'g1', identity(), NOW);
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.estimatedCount).toBe(2);
    expect(s.unestimatedCount).toBe(0);
  });
});

describe('computeEffortCalibration — the two quantities stay apart', () => {
  const cal = (tasks: EffortCalibrationTask[]) => computeEffortCalibration(tasks);

  it('calibrates wall-clock from the trail and hands-on from reading time', () => {
    const tasks: EffortCalibrationTask[] = Array.from({ length: 20 }, () => ({
      goal: 'g1',
      // Estimated an hour, actually took two.
      ...closed(2 * DAY, 2 * HOUR, { readingTime: { totalSeconds: 300 } }),
    }));
    const c = cal(tasks);
    // 2.0 measured, shrunk toward the wall-clock prior on 20 samples:
    // 1/7 + (2 - 1/7) * 20/25.
    expect(c.wallClock.board.ratio).toBeCloseTo(
      EFFORT_PRIOR_WALL_CLOCK_RATIO + (2 - EFFORT_PRIOR_WALL_CLOCK_RATIO) * (20 / 25),
    );
    // Estimated 600s hands-on, measured 300 → 0.5, shrunk toward the
    // hands-on prior. The point of the test is that the two quantities land
    // on DIFFERENT numbers from different evidence, and they still do.
    expect(c.handsOn.board.ratio).toBeCloseTo(
      EFFORT_PRIOR_HANDS_ON_RATIO + (0.5 - EFFORT_PRIOR_HANDS_ON_RATIO) * (20 / 25),
    );
    expect(c.handsOn.board.ratio).toBeLessThan(c.wallClock.board.ratio);
  });

  it('a closed ticket nobody read calibrates wall-clock and stays OUT of hands-on', () => {
    const tasks: EffortCalibrationTask[] = Array.from({ length: 6 }, () => ({
      goal: 'g1',
      ...closed(2 * DAY, 2 * HOUR),
    }));
    const c = cal(tasks);
    expect(c.wallClock.board.samples).toBe(6);
    // The bug this guards: entering an unmeasured ticket as 0 hands-on would
    // drive every future hands-on estimate to the floor.
    expect(c.handsOn.board.samples).toBe(0);
    // No samples, so hands-on sits at its prior — not at 1, and not at
    // wall-clock's answer.
    expect(c.handsOn.board.ratio).toBeCloseTo(EFFORT_PRIOR_HANDS_ON_RATIO);
  });

  it('ignores open tickets, archived tickets and unscored tickets', () => {
    const c = cal([
      { goal: 'g1', ...task() },
      { goal: 'g1', ...closed(DAY, 2 * HOUR, { archivedAt: NOW }) },
      { goal: 'g1', ...closed(DAY, 2 * HOUR, { effortEstimate: undefined }) },
    ]);
    expect(c.wallClock.board.samples).toBe(0);
  });

  it('ignores a closed ticket whose trail never claimed it', () => {
    const c = cal([
      {
        goal: 'g1',
        ...task({
          status: 'done',
          transitions: [
            { ts: NOW - 5 * DAY, to: 'todo' },
            { ts: NOW - DAY, to: 'done' },
          ],
        }),
      },
    ]);
    expect(c.wallClock.board.samples).toBe(0);
  });
});

describe('summarizeGoalEffort — absent is never zero', () => {
  it('says not-scored rather than 0% when nothing carries an estimate', () => {
    const s = summarizeGoalEffort(
      [task({ effortEstimate: undefined }), task({ effortEstimate: undefined })],
      'g1',
      identity(),
      NOW,
    );
    if (s.kind !== 'unestimated') throw new Error('expected unestimated');
    expect(s.reason).toBe('not-scored');
    expect(s.unestimatedCount).toBe(2);
    expect(s.failedCount).toBe(0);
  });

  it('distinguishes an empty goal from an unscored one', () => {
    const s = summarizeGoalEffort([], 'g1', identity(), NOW);
    if (s.kind !== 'unestimated') throw new Error('expected unestimated');
    expect(s.reason).toBe('no-tasks');
  });

  it('counts a FAILED scoring run separately from a never-scored one', () => {
    const s = summarizeGoalEffort(
      [task({ effortEstimate: { status: 'failed' } }), task({ effortEstimate: undefined })],
      'g1',
      identity(),
      NOW,
    );
    if (s.kind !== 'unestimated') throw new Error('expected unestimated');
    expect(s.failedCount).toBe(1);
    expect(s.unestimatedCount).toBe(2);
  });

  it('reports a real 0% — every ticket scored, none done — as ready, not absent', () => {
    const s = summarizeGoalEffort([task(), task()], 'g1', identity(), NOW);
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.percentComplete).toBe(0);
    expect(s.estimatedCount).toBe(2);
    expect(s.unestimatedCount).toBe(0);
  });

  it('reports partial coverage rather than hiding it', () => {
    const s = summarizeGoalEffort(
      [task(), task({ effortEstimate: undefined }), task({ effortEstimate: { status: 'failed' } })],
      'g1',
      identity(),
      NOW,
    );
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.estimatedCount).toBe(1);
    expect(s.unestimatedCount).toBe(2);
    expect(s.failedCount).toBe(1);
  });
});

describe('summarizeGoalEffort — the fraction', () => {
  it('keeps estimates on both sides, so a close cannot move the denominator', () => {
    const before = summarizeGoalEffort(
      [closed(DAY), task(), task(), task()],
      'g1',
      identity(),
      NOW,
    );
    const after = summarizeGoalEffort(
      [
        closed(DAY),
        // The second ticket closes, and its ACTUAL was wildly off its estimate.
        closed(0, 40 * HOUR),
        task(),
        task(),
      ],
      'g1',
      identity(),
      NOW,
    );
    if (before.kind !== 'ready' || after.kind !== 'ready') throw new Error('expected ready');
    expect(before.percentComplete).toBe(25);
    // One more of four closes: 50%, and the 40-hour actual is nowhere in it.
    expect(after.percentComplete).toBe(50);
  });

  it('excludes archived rows from both sides', () => {
    const s = summarizeGoalEffort(
      [closed(DAY), task(), task({ archivedAt: NOW - DAY }), task({ archivedAt: NOW - DAY })],
      'g1',
      identity(),
      NOW,
    );
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.percentComplete).toBe(50);
    expect(s.estimatedCount).toBe(2);
  });

  it('sums hands-on across the OPEN tickets only, at the hands-on ratio', () => {
    const calTasks: EffortCalibrationTask[] = Array.from({ length: 50 }, () => ({
      goal: 'g1',
      ...closed(2 * DAY, HOUR, { readingTime: { totalSeconds: 900 } }),
    }));
    const c = computeEffortCalibration(calTasks);
    // 900 measured against a 600 estimate → 1.5 measured, then shrunk toward
    // the hands-on prior and toward the board in turn. Fifty samples is
    // enough to be most of the way there without being all of it.
    const hands = ratioForGoal(c.handsOn, 'g1').ratio;
    const wall = ratioForGoal(c.wallClock, 'g1').ratio;
    expect(hands).toBeGreaterThan(1.4);
    expect(hands).toBeLessThan(1.5);
    // Wall-clock was estimated at 3600 and measured at 3600 → 1.0 measured.
    expect(wall).toBeGreaterThan(0.99);
    expect(wall).toBeLessThan(1);
    const s = summarizeGoalEffort(
      [closed(DAY), task(), task({ status: 'in-progress' })],
      'g1',
      c,
      NOW,
    );
    if (s.kind !== 'ready') throw new Error('expected ready');
    // Two open tickets at 600s hands-on each, at the hands-on factor — and
    // the point of the test is the SEPARATION: the hands-on remainder moves
    // with the hands-on ratio and the calendar remainder does not.
    expect(s.handsOnRemainingSeconds).toBe(Math.round(600 * hands) * 2);
    expect(s.handsOnRemainingSeconds).not.toBe(Math.round(600 * wall) * 2);
    expect(s.wallClockRemainingSeconds).toBe(Math.round(3600 * wall) * 2);
  });
});

describe("goalPaceWindowDays — the goal's own age, not the calendar's", () => {
  it('dates a band from its oldest live ticket', () => {
    const days = goalPaceWindowDays(
      [task({ createdAt: NOW - 3 * DAY }), task({ createdAt: NOW - 2 * DAY })],
      NOW,
    );
    expect(days).toBeCloseTo(3, 6);
  });

  it('falls back to the first transition when a row carries no createdAt', () => {
    const { createdAt: _dropped, ...noCreated } = closed(2 * DAY, HOUR);
    // The close is 2 days old and ran for an hour, so the trail starts at
    // 2d 1h — which is what dates the goal once `createdAt` is gone.
    expect(goalPaceWindowDays([noCreated], NOW)).toBeCloseTo(2 + 1 / 24, 4);
  });

  it('gives a band with no timestamps the full window rather than the floor', () => {
    // Nothing is known about this band's age. One day is a claim about a
    // YOUNG goal; the full window is the old behaviour, which is the honest
    // answer when there is no evidence either way.
    expect(goalPaceWindowDays([{ status: 'todo' }], NOW)).toBe(EFFORT_PACE_WINDOW_DAYS);
    expect(goalPaceWindowDays([], NOW)).toBe(EFFORT_PACE_WINDOW_DAYS);
  });

  it('clamps at both ends', () => {
    expect(goalPaceWindowDays([task({ createdAt: NOW - 400 * DAY })], NOW)).toBe(
      EFFORT_PACE_WINDOW_DAYS,
    );
    expect(goalPaceWindowDays([task({ createdAt: NOW - HOUR })], NOW)).toBe(
      EFFORT_MIN_PACE_WINDOW_DAYS,
    );
  });

  it('ignores a zero timestamp rather than dating the goal from the epoch', () => {
    // `Math.min` over a stray 0 would make this band fifty-six years old and
    // clamp to the full window — the same number a correct answer produces
    // for an OLD goal, so the assertion is on the young goal beside it.
    expect(
      goalPaceWindowDays([task({ createdAt: 0 }), task({ createdAt: NOW - 2 * DAY })], NOW),
    ).toBeCloseTo(2, 6);
  });
});

describe("summarizeGoalEffort — pace over the goal's active window", () => {
  // The ticket this covers: "goal pace reflects how long the goal has
  // actually run". Both goals below close the same two tickets; the only
  // difference is how long the goal has existed.
  const twoCloses = (createdAt: number): EffortTaskInput[] => [
    closed(0.5 * DAY, HOUR, { createdAt }),
    closed(DAY, HOUR, { createdAt }),
    task({ createdAt }),
  ];

  it('divides a three-day-old goal by three days, not by fourteen', () => {
    const s = summarizeGoalEffort(twoCloses(NOW - 3 * DAY), 'g1', identity(), NOW);
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.paceWindowDays).toBeCloseTo(3, 6);
    expect(s.closesInWindow).toBe(2);
    // 7,200 estimate-seconds closed over three days.
    expect(s.paceSecondsPerDay).toBeCloseTo(7200 / 3, 6);
  });

  it('divides an old goal with the same closes by the full window', () => {
    const s = summarizeGoalEffort(twoCloses(NOW - 90 * DAY), 'g1', identity(), NOW);
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.paceWindowDays).toBe(EFFORT_PACE_WINDOW_DAYS);
    expect(s.closesInWindow).toBe(2);
    expect(s.paceSecondsPerDay).toBeCloseTo(7200 / EFFORT_PACE_WINDOW_DAYS, 6);
  });

  it('reads the young goal as faster than the old one on identical closes', () => {
    // The whole point, stated as the comparison the ticket makes: same
    // numerator, and the goal that earned it in three days is not reported
    // at the rate of one that took three months.
    const young = summarizeGoalEffort(twoCloses(NOW - 3 * DAY), 'g1', identity(), NOW);
    const old = summarizeGoalEffort(twoCloses(NOW - 90 * DAY), 'g1', identity(), NOW);
    if (young.kind !== 'ready' || old.kind !== 'ready') throw new Error('expected ready');
    expect(young.paceSecondsPerDay).toBeGreaterThan(old.paceSecondsPerDay);
    expect(young.paceSecondsPerDay / old.paceSecondsPerDay).toBeCloseTo(
      EFFORT_PACE_WINDOW_DAYS / 3,
      6,
    );
  });

  it('projects a young goal sooner than an old one, on the same evidence', () => {
    const rows = (createdAt: number): EffortTaskInput[] => [
      closed(0.25 * DAY, HOUR, { createdAt }),
      closed(0.5 * DAY, HOUR, { createdAt }),
      closed(DAY, HOUR, { createdAt }),
      task({ createdAt }),
    ];
    const young = summarizeGoalEffort(rows(NOW - 3 * DAY), 'g1', identity(), NOW);
    const old = summarizeGoalEffort(rows(NOW - 90 * DAY), 'g1', identity(), NOW);
    if (young.kind !== 'ready' || old.kind !== 'ready') throw new Error('expected ready');
    // Positive control: both DO get a date, so "sooner" is a comparison of
    // two projections rather than one projection and one absence.
    expect(young.projectedFinishAt).toBeDefined();
    expect(old.projectedFinishAt).toBeDefined();
    expect(young.projectedFinishAt ?? 0).toBeLessThan(old.projectedFinishAt ?? 0);
  });

  it('will not read a rate off a goal hours old', () => {
    // Three closes inside two hours on a goal filed this morning. Without
    // the floor the denominator is 1/12 of a day and the pace is twelve
    // times anything the goal has shown.
    const born = NOW - 2 * HOUR;
    const s = summarizeGoalEffort(
      [
        closed(5 * 60 * 1000, 60 * 1000, { createdAt: born }),
        closed(10 * 60 * 1000, 60 * 1000, { createdAt: born }),
        closed(15 * 60 * 1000, 60 * 1000, { createdAt: born }),
        task({ createdAt: born }),
      ],
      'g1',
      identity(),
      NOW,
    );
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.paceWindowDays).toBe(EFFORT_MIN_PACE_WINDOW_DAYS);
    expect(s.paceSecondsPerDay).toBeCloseTo(10_800 / EFFORT_MIN_PACE_WINDOW_DAYS, 6);
  });

  it('counts a close only inside the window it divides by', () => {
    // The two halves of the pace share one window. A close five days back on
    // a three-day-old goal cannot happen in real data, but a divisor and a
    // filter derived separately would let one in and rate it against the
    // other's span.
    const born = NOW - 3 * DAY;
    const s = summarizeGoalEffort(
      [
        closed(DAY, HOUR, { createdAt: born }),
        closed(2 * DAY, HOUR, { createdAt: born }),
        closed(5 * DAY, HOUR, { createdAt: born }),
        task({ createdAt: born }),
      ],
      'g1',
      identity(),
      NOW,
    );
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.paceWindowDays).toBeCloseTo(3, 6);
    expect(s.closesInWindow).toBe(2);
  });
});

describe('a factor is learned from three closes, not one', () => {
  // The ticket this covers: "projections stop swinging on a single closed
  // ticket". shrink(r, r, 1) = r exactly, and on a board whose only sample
  // is one goal's close, that goal's shrink target IS the close — so the
  // first ticket to close moved every estimate at full strength.
  const overrun = (goal: string, times: number): EffortSample => ({
    goal,
    estimateSeconds: 100,
    actualSeconds: 100 * times,
  });

  it('leaves the board on its prior after one close', () => {
    const set = computeEffortRatios([overrun('g1', 3)], EFFORT_PRIOR_WALL_CLOCK_RATIO);
    expect(set.board.ratio).toBeCloseTo(EFFORT_PRIOR_WALL_CLOCK_RATIO, 10);
    expect(set.board.samples).toBe(0);
    expect(set.board.calibrated).toBe(false);
    // What DID close is still reported, so nothing has to claim that nothing
    // closed in order to say it has not calibrated.
    expect(set.board.observedSamples).toBe(1);
    expect(ratioForGoal(set, 'g1').observedSamples).toBe(1);
  });

  it('calibrates at the third close, and not before', () => {
    const two = computeEffortRatios([overrun('g1', 3), overrun('g1', 3)], 1);
    expect(two.board.calibrated).toBe(false);
    expect(two.board.ratio).toBe(1);
    // Positive control: one more identical close and the same code path DOES
    // learn — so the two-sample answer above is the floor and not a
    // calibrator that never fires.
    const three = computeEffortRatios([overrun('g1', 3), overrun('g1', 3), overrun('g1', 3)], 1);
    expect(three.board.calibrated).toBe(true);
    expect(three.board.samples).toBe(3);
    expect(three.board.ratio).toBeGreaterThan(1);
  });

  it("does not triple a goal's projection on one ticket that ran 3x its estimate", () => {
    // The acceptance criterion, stated as its arithmetic. One close at 3x on
    // an otherwise fresh board: the remainder must come out at the PRIOR,
    // not at three times the raw estimate.
    const born = NOW - 10 * DAY;
    const rows: EffortCalibrationTask[] = [
      { goal: 'g1', ...closed(DAY, 3 * HOUR, { createdAt: born }) },
      { goal: 'g1', ...task({ createdAt: born }) },
    ];
    const cal = computeEffortCalibration(rows);
    const s = summarizeGoalEffort(rows, 'g1', cal, NOW);
    if (s.kind !== 'ready') throw new Error('expected ready');
    // The close really did run 3x: a 3600s estimate worked for three hours.
    expect(effortActualWallClockSeconds(rows[0] as EffortTaskInput)).toBe(3 * 3600);
    expect(s.wallClockRatio.calibrated).toBe(false);
    expect(s.wallClockRatio.ratio).toBeCloseTo(EFFORT_PRIOR_WALL_CLOCK_RATIO, 10);
    // One open ticket at 3600s. Tripled it would be 10,800s.
    expect(s.wallClockRemainingSeconds).toBe(Math.round(3600 * EFFORT_PRIOR_WALL_CLOCK_RATIO));
    expect(s.wallClockRemainingSeconds).toBeLessThan(3600);
  });

  it('lets three closes at 3x move the forecast', () => {
    // The other half of the same claim, and the reason the assertion above
    // is not just "calibration is off": with enough evidence the correction
    // lands, and it lands upward.
    const born = NOW - 10 * DAY;
    const rows: EffortCalibrationTask[] = [
      { goal: 'g1', ...closed(DAY, 3 * HOUR, { createdAt: born }) },
      { goal: 'g1', ...closed(2 * DAY, 3 * HOUR, { createdAt: born }) },
      { goal: 'g1', ...closed(3 * DAY, 3 * HOUR, { createdAt: born }) },
      { goal: 'g1', ...task({ createdAt: born }) },
    ];
    const cal = computeEffortCalibration(rows);
    const s = summarizeGoalEffort(rows, 'g1', cal, NOW);
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.wallClockRatio.calibrated).toBe(true);
    expect(s.wallClockRatio.samples).toBe(3);
    expect(s.wallClockRatio.ratio).toBeGreaterThan(EFFORT_PRIOR_WALL_CLOCK_RATIO);
  });

  it("never reports another goal's closes as this goal's", () => {
    // Below the floor, the board holds two closes and both belong to g1. A
    // goal with no entry falls back to the board row, and before the
    // fallback zeroed the counts it inherited "2 closed tickets so far" —
    // two closes reported under a goal that has none, on a surface whose
    // every sentence says "on this goal".
    const set = computeEffortRatios(
      [overrun('g1', 3), overrun('g1', 3)],
      EFFORT_PRIOR_WALL_CLOCK_RATIO,
    );
    expect(set.board.observedSamples).toBe(2);
    const other = ratioForGoal(set, 'g2');
    expect(other.observedSamples).toBe(0);
    expect(other.samples).toBe(0);
    // Positive control: the goal those closes DID happen under still counts
    // them, so the zero above is the fallback and not a counter that never
    // increments.
    expect(ratioForGoal(set, 'g1').observedSamples).toBe(2);
  });

  it('keeps a calibrated goal calibrated when it has closed nothing of its own', () => {
    // A goal inheriting a board that HAS learned is not an uncalibrated
    // goal, and must not wear the "estimate only" marker. `samples: 0` is
    // true of both cases and cannot tell them apart; `calibrated` is what
    // does.
    const learned = computeEffortRatios(
      Array.from({ length: 5 }, () => overrun('g1', 2)),
      EFFORT_PRIOR_WALL_CLOCK_RATIO,
    );
    const fresh = ratioForGoal(learned, 'g-never-closed-anything');
    expect(fresh.calibrated).toBe(true);
    expect(fresh.ratio).toBe(learned.board.ratio);
    // It inherits the FACTOR and none of the evidence. Handing back the
    // board's row whole reported the board's five closes as five closes
    // under a goal that has none, on every surface that says "on this goal".
    expect(fresh.samples).toBe(0);
    expect(fresh.observedSamples).toBe(0);
    expect(learned.board.observedSamples).toBe(5);
    const oneClose = computeEffortRatios(
      [...Array.from({ length: 5 }, () => overrun('g1', 2)), overrun('g2', 2)],
      EFFORT_PRIOR_WALL_CLOCK_RATIO,
    );
    expect(ratioForGoal(oneClose, 'g2').calibrated).toBe(true);
    expect(ratioForGoal(oneClose, 'g2').samples).toBe(0);
    expect(ratioForGoal(oneClose, 'g2').observedSamples).toBe(1);
  });
});

describe('summarizeGoalEffort — a close with no work behind it', () => {
  // The ticket this covers: "projected finish ignores tickets that went
  // straight to done". A row swept out of the backlog was already refused by
  // the calibrator, which needs an actual; pace and the projection floor
  // took it, so bulk-closing stale rows faked a speed-up.
  const born = NOW - 10 * DAY;

  /** Closed without ever entering `in-progress` — a bulk sweep. */
  const swept = (agoMs: number): EffortTaskInput =>
    task({
      status: 'done',
      createdAt: born,
      transitions: [{ ts: NOW - agoMs, to: 'done' }],
    });

  const worked = (agoMs: number): EffortTaskInput => closed(agoMs, HOUR, { createdAt: born });

  it('keeps a swept row out of the pace', () => {
    const s = summarizeGoalEffort([swept(HOUR), swept(2 * HOUR), task()], 'g1', identity(), NOW);
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.closesInWindow).toBe(0);
    expect(s.paceSecondsPerDay).toBe(0);
    // Positive control on the fixture: those rows ARE closed, so a zero pace
    // is the exclusion firing and not two tickets that never closed.
    expect(s.percentComplete).toBe(67);
  });

  it('still counts a swept row as done everywhere it is a plain fact', () => {
    // The bar, the remainder and `complete` are statements about what is
    // finished, not about how fast the goal moves. Withholding those would
    // be a different and worse bug.
    const s = summarizeGoalEffort([swept(HOUR), swept(2 * HOUR)], 'g1', identity(), NOW);
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.complete).toBe(true);
    expect(s.percentComplete).toBe(100);
    expect(s.wallClockRemainingSeconds).toBe(0);
  });

  it('does not move the projected date when three stale rows close in one minute', () => {
    const base = [worked(DAY), worked(2 * DAY), worked(3 * DAY), task({ createdAt: born })];
    const before = summarizeGoalEffort(base, 'g1', identity(), NOW);
    if (before.kind !== 'ready') throw new Error('expected ready');
    // Positive control: there IS a date to move, so "unmoved" is a
    // comparison of two projections rather than two absences.
    expect(before.projectedFinishAt).toBeDefined();

    const bulk = [...base, swept(20_000), swept(40_000), swept(60_000)];
    const after = summarizeGoalEffort(bulk, 'g1', identity(), NOW);
    if (after.kind !== 'ready') throw new Error('expected ready');
    expect(after.closesInWindow).toBe(before.closesInWindow);
    expect(after.paceSecondsPerDay).toBe(before.paceSecondsPerDay);
    expect(after.projectedFinishAt).toBe(before.projectedFinishAt);

    // And the control in the other direction: the same three rows, this time
    // actually worked, DO pull the date in. Without this the assertion above
    // would also pass on a projection that never responds to anything.
    const real = summarizeGoalEffort(
      [...base, worked(20_000), worked(40_000), worked(60_000)],
      'g1',
      identity(),
      NOW,
    );
    if (real.kind !== 'ready') throw new Error('expected ready');
    expect(real.paceSecondsPerDay).toBeGreaterThan(before.paceSecondsPerDay);
    expect(real.projectedFinishAt ?? 0).toBeLessThan(before.projectedFinishAt ?? 0);
  });

  it('will not unlock a date on swept rows alone', () => {
    // Three closes in the window and still no projection, because none of
    // them was worked. The floor counts observed closes.
    const s = summarizeGoalEffort(
      [swept(HOUR), swept(2 * HOUR), swept(3 * HOUR), task({ createdAt: born })],
      'g1',
      identity(),
      NOW,
    );
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.closesInWindow).toBe(0);
    expect(s.projectedFinishAt).toBeUndefined();
    expect(s.projectionOverHorizonDays).toBeUndefined();
  });

  it('reports a swept close as unobserved and a worked one as observed', () => {
    expect(isObservedClose(swept(HOUR))).toBe(false);
    expect(isObservedClose(worked(HOUR))).toBe(true);
    // An open ticket is not a close at all, however much of a trail it has.
    expect(isObservedClose(task({ transitions: [{ ts: NOW - HOUR, to: 'in-progress' }] }))).toBe(
      false,
    );
  });
});

describe('summarizeGoalEffort — projection', () => {
  it('shows no date below three closes in the window', () => {
    const s = summarizeGoalEffort([closed(DAY), closed(2 * DAY), task()], 'g1', identity(), NOW);
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.closesInWindow).toBe(2);
    expect(s.projectedFinishAt).toBeUndefined();
  });

  it('ignores closes older than the pace window', () => {
    const s = summarizeGoalEffort(
      [closed(DAY), closed(2 * DAY), closed((EFFORT_PACE_WINDOW_DAYS + 1) * DAY), task()],
      'g1',
      identity(),
      NOW,
    );
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.closesInWindow).toBe(2);
    expect(s.projectedFinishAt).toBeUndefined();
  });

  it('projects a finish date from pace, and the arithmetic is checkable by hand', () => {
    // Three closes at a 3600s estimate each inside a 14-day window:
    //   pace = 10,800 / 14 = 771.4286 estimate-seconds per calendar day.
    // Two open tickets at 3600s each = 7,200s of wall-clock remaining.
    //   days = 7,200 / 771.4286 = 9.3333…
    const s = summarizeGoalEffort(
      [closed(DAY), closed(2 * DAY), closed(3 * DAY), task(), task()],
      'g1',
      identity(),
      NOW,
    );
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.closesInWindow).toBe(EFFORT_MIN_CLOSES_FOR_PROJECTION);
    expect(s.paceSecondsPerDay).toBeCloseTo(10_800 / 14, 6);
    expect(s.wallClockRemainingSeconds).toBe(7200);
    expect(s.percentComplete).toBe(60); // 3 of 5 equal tickets
    const days = 7200 / (10_800 / 14);
    expect(days).toBeCloseTo(9.3333, 4);
    expect(s.projectedFinishAt).toBeCloseTo(NOW + days * DAY, 0);
  });

  it('calls a finished goal finished, rather than dating it today', () => {
    const s = summarizeGoalEffort(
      [closed(DAY), closed(2 * DAY), closed(3 * DAY)],
      'g1',
      identity(),
      NOW,
    );
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.complete).toBe(true);
    expect(s.percentComplete).toBe(100);
    // No date at all. Dating it "now" rendered as a goal with a minute of
    // work landing today, which is the opposite of what it is.
    expect(s.projectedFinishAt).toBeUndefined();
    expect(s.handsOnRemainingSeconds).toBe(0);
  });

  it('refuses to name a day for a projection years out', () => {
    // Three small closes against five large open tickets — an ordinary shape
    // on a board with a long tail — divides into 5,600 days. A date that far
    // out rendered in the same four characters as one months away.
    const tiny = { effortEstimate: ok(600, 600) };
    const huge = { effortEstimate: ok(144000, 3600) };
    const small = [
      closed(DAY, HOUR, tiny),
      closed(2 * DAY, HOUR, tiny),
      closed(3 * DAY, HOUR, tiny),
    ];
    const big = [task(huge), task(huge), task(huge), task(huge), task(huge)];
    const s = summarizeGoalEffort([...small, ...big], 'g1', identity(), NOW);
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.projectedFinishAt).toBeUndefined();
    expect(s.projectionOverHorizonDays).toBeGreaterThan(EFFORT_MAX_PROJECTION_DAYS);
    // Positive control: the same shape inside the horizon still gets a date,
    // so the assertion above cannot be met by a projection that never fires.
    const near = summarizeGoalEffort([...small, task(tiny), task(tiny)], 'g1', identity(), NOW);
    if (near.kind !== 'ready') throw new Error('expected ready');
    expect(near.projectedFinishAt).toBeDefined();
    expect(near.projectionOverHorizonDays).toBeUndefined();
  });

  it('adds the later end of the range only when the samples support a spread', () => {
    const noSpread = summarizeGoalEffort(
      [closed(DAY), closed(2 * DAY), closed(3 * DAY), task()],
      'g1',
      identity(),
      NOW,
    );
    if (noSpread.kind !== 'ready') throw new Error('expected ready');
    expect(noSpread.projectedLatestAt).toBeUndefined();

    const c = computeEffortCalibration([
      { goal: 'g1', ...closed(4 * DAY, HOUR) },
      { goal: 'g1', ...closed(5 * DAY, HOUR) },
      { goal: 'g1', ...closed(6 * DAY, 1.8 * HOUR) },
      { goal: 'g1', ...closed(7 * DAY, 1.8 * HOUR) },
    ]);
    const spread = summarizeGoalEffort(
      [closed(DAY), closed(2 * DAY), closed(3 * DAY), task()],
      'g1',
      c,
      NOW,
    );
    if (spread.kind !== 'ready') throw new Error('expected ready');
    expect(spread.wallClockRatio.spread).toBeGreaterThan(1);
    expect(spread.projectedLatestAt).toBeGreaterThan(spread.projectedFinishAt ?? 0);
  });

  it('drops the later end when the RANGE runs past the horizon', () => {
    // The central date can sit inside the year while the spread throws the
    // late end well outside it. Naming that date is exactly what the horizon
    // refuses to do for a central projection, so a range may not do it either.
    const c = computeEffortCalibration([
      { goal: 'g1', ...closed(4 * DAY, HOUR) },
      { goal: 'g1', ...closed(5 * DAY, HOUR) },
      { goal: 'g1', ...closed(6 * DAY, 1.8 * HOUR) },
      { goal: 'g1', ...closed(7 * DAY, 1.8 * HOUR) },
    ]);
    const closes = [closed(DAY), closed(2 * DAY), closed(3 * DAY)];
    const openWork = (wallClockSeconds: number): EffortTaskInput =>
      task({ effortEstimate: ok(wallClockSeconds, 600) });
    // Read the pace and the spread off the fixture rather than assuming them,
    // then size the open pile to land the central date a chosen number of
    // days out.
    const probe = summarizeGoalEffort([...closes, openWork(3600)], 'g1', c, NOW);
    if (probe.kind !== 'ready') throw new Error('expected ready');
    const spread = probe.wallClockRatio.spread;
    expect(spread).toBeGreaterThan(1);
    const remainingFor = (days: number): number =>
      (days * probe.paceSecondsPerDay) / probe.wallClockRatio.ratio;
    const at = (days: number): GoalEffortReady => {
      const s = summarizeGoalEffort([...closes, openWork(remainingFor(days))], 'g1', c, NOW);
      if (s.kind !== 'ready') throw new Error('expected ready');
      return s;
    };

    // Far: the central date inside the horizon, the late end outside it. The
    // fixture is checked, not assumed — a spread too small to leave the
    // horizon would make the assertion below pass for the wrong reason.
    const farDays = EFFORT_MAX_PROJECTION_DAYS * 0.95;
    expect(farDays * spread).toBeGreaterThan(EFFORT_MAX_PROJECTION_DAYS);
    const far = at(farDays);
    // Positive control on the central date: an absent late end here must not
    // be the horizon check on the CENTRAL projection firing instead.
    expect(far.projectedFinishAt).toBeDefined();
    expect(far.projectionOverHorizonDays).toBeUndefined();
    expect(far.projectedLatestAt).toBeUndefined();

    // Near: both ends inside the horizon, and the range is still drawn — the
    // other half of the rule, and the control that says the drop above is the
    // horizon and not the range being switched off.
    const nearDays = 30;
    expect(nearDays * spread).toBeLessThan(EFFORT_MAX_PROJECTION_DAYS);
    const near = at(nearDays);
    expect(near.projectedLatestAt).toBeGreaterThan(near.projectedFinishAt ?? 0);
  });
});

describe('formatting — seconds never reach the screen', () => {
  it('shows at most two units and never a decimal', () => {
    expect(formatEffortSeconds(45)).toBe('1m');
    expect(formatEffortSeconds(480)).toBe('8m');
    expect(formatEffortSeconds(5760)).toBe('1h 36m');
    expect(formatEffortSeconds(3600)).toBe('1h');
    expect(formatEffortSeconds(90_000)).toBe('1d 1h');
    expect(formatEffortSeconds(4 * 86400)).toBe('4d');
  });

  it('never renders a 60-minute hour or a 24-hour day', () => {
    expect(formatEffortSeconds(3600 + 3576)).toBe('2h');
    expect(formatEffortSeconds(86400 + 86000)).toBe('2d');
    // The carry across a BRANCH boundary, which the version that rounded
    // inside each branch got wrong in both directions: a second under an
    // hour rendered "60m" and a second under a day rendered "24h".
    expect(formatEffortSeconds(3599)).toBe('1h');
    expect(formatEffortSeconds(86399)).toBe('1d');
    // Positive control on the same pair: a value that genuinely belongs to
    // the smaller unit still uses it, so the assertions above cannot be met
    // by a formatter that always promotes.
    expect(formatEffortSeconds(3540)).toBe('59m');
    expect(formatEffortSeconds(85000)).toBe('23h 37m');
  });

  it('has no step where a bucket boundary swallows a goal total', () => {
    // Bucketing to ten minutes made 4m59s print "<1m" and 5m00s print "10m"
    // — a full bucket of movement across one second. Under ten minutes the
    // real minutes are reported, and the two paths meet at 600s.
    expect(formatGoalEffortSeconds(299)).toBe('5m');
    expect(formatGoalEffortSeconds(300)).toBe('5m');
    expect(formatGoalEffortSeconds(599)).toBe('10m');
    expect(formatGoalEffortSeconds(600)).toBe('10m');
  });

  it('says <1m rather than counting a handful of seconds', () => {
    expect(formatEffortSeconds(0)).toBe('<1m');
    expect(formatEffortSeconds(11)).toBe('<1m');
    expect(formatEffortSeconds(29)).toBe('<1m');
    expect(formatEffortSeconds(30)).toBe('1m');
  });

  it('rounds a goal total to ten minutes below a day and half a day above', () => {
    // 1h 37m 20s of stacked guesses is not 1h 37m of anything.
    expect(formatGoalEffortSeconds(5840)).toBe('1h 40m');
    expect(formatGoalEffortSeconds(2 * 86400 + 3600)).toBe('2d');
    expect(formatGoalEffortSeconds(2 * 86400 + 50_000)).toBe('2.5d');
  });

  it('refuses to invent a number for a non-number', () => {
    expect(formatEffortSeconds(Number.NaN)).toBe('—');
    expect(formatGoalEffortSeconds(-1)).toBe('—');
  });
});
