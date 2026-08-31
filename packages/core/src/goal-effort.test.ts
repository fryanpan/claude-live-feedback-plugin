import { describe, expect, it } from 'vitest';
import {
  EFFORT_MAX_PROJECTION_DAYS,
  EFFORT_MIN_CLOSES_FOR_PROJECTION,
  EFFORT_PACE_WINDOW_DAYS,
  type EffortCalibrationTask,
  type EffortTaskInput,
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
  neutralCalibration,
  ratioForGoal,
  shrinkEffortRatio,
  summarizeGoalEffort,
  symmetricRatioError,
} from './goal-effort.ts';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);

function ok(wallClockSeconds: number, handsOnSeconds: number): EffortTaskInput['effortEstimate'] {
  return { status: 'ok', wallClockSeconds, handsOnSeconds };
}

function task(over: Partial<EffortTaskInput> = {}): EffortTaskInput {
  return { status: 'todo', effortEstimate: ok(3600, 600), ...over };
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
    expect(clampEffortRatio(0.1)).toBe(0.5);
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
    // A mean would be dragged to ~4.7x; the median holds at 2x.
    expect(set.board.ratio).toBe(2);
  });

  it('pulls a two-sample goal most of the way back to the board', () => {
    const set = computeEffortRatios([
      ...Array.from({ length: 10 }, () => ({
        goal: 'g1',
        estimateSeconds: 100,
        actualSeconds: 100,
      })),
      { goal: 'g2', estimateSeconds: 100, actualSeconds: 200 },
      { goal: 'g2', estimateSeconds: 100, actualSeconds: 200 },
    ]);
    expect(set.board.ratio).toBe(1);
    // 1 + (2 - 1) * 2/(2+5) = 1.2857…
    expect(ratioForGoal(set, 'g2').ratio).toBeCloseTo(1 + 2 / 7, 5);
    expect(ratioForGoal(set, 'g2').samples).toBe(2);
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
  });

  it('claims no spread below three samples', () => {
    const set = computeEffortRatios([
      { goal: 'g1', estimateSeconds: 100, actualSeconds: 100 },
      { goal: 'g1', estimateSeconds: 100, actualSeconds: 400 },
    ]);
    expect(set.byGoal.g1?.spread).toBe(1);
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
    expect(c.wallClock.board.ratio).toBe(2);
    // Estimated 600s hands-on, measured 300 → 0.5.
    expect(c.handsOn.board.ratio).toBe(0.5);
  });

  it('a closed ticket nobody read calibrates wall-clock and stays OUT of hands-on', () => {
    const tasks: EffortCalibrationTask[] = Array.from({ length: 6 }, () => ({
      goal: 'g1',
      ...closed(2 * DAY, 2 * HOUR),
    }));
    const c = cal(tasks);
    expect(c.wallClock.board.samples).toBe(6);
    // The bug this guards: entering an unmeasured ticket as 0 hands-on would
    // drive every future hands-on estimate to the 0.5 floor.
    expect(c.handsOn.board.samples).toBe(0);
    expect(c.handsOn.board.ratio).toBe(1);
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
      neutralCalibration(),
      NOW,
    );
    if (s.kind !== 'unestimated') throw new Error('expected unestimated');
    expect(s.reason).toBe('not-scored');
    expect(s.unestimatedCount).toBe(2);
    expect(s.failedCount).toBe(0);
  });

  it('distinguishes an empty goal from an unscored one', () => {
    const s = summarizeGoalEffort([], 'g1', neutralCalibration(), NOW);
    if (s.kind !== 'unestimated') throw new Error('expected unestimated');
    expect(s.reason).toBe('no-tasks');
  });

  it('counts a FAILED scoring run separately from a never-scored one', () => {
    const s = summarizeGoalEffort(
      [task({ effortEstimate: { status: 'failed' } }), task({ effortEstimate: undefined })],
      'g1',
      neutralCalibration(),
      NOW,
    );
    if (s.kind !== 'unestimated') throw new Error('expected unestimated');
    expect(s.failedCount).toBe(1);
    expect(s.unestimatedCount).toBe(2);
  });

  it('reports a real 0% — every ticket scored, none done — as ready, not absent', () => {
    const s = summarizeGoalEffort([task(), task()], 'g1', neutralCalibration(), NOW);
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.percentComplete).toBe(0);
    expect(s.estimatedCount).toBe(2);
    expect(s.unestimatedCount).toBe(0);
  });

  it('reports partial coverage rather than hiding it', () => {
    const s = summarizeGoalEffort(
      [task(), task({ effortEstimate: undefined }), task({ effortEstimate: { status: 'failed' } })],
      'g1',
      neutralCalibration(),
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
      neutralCalibration(),
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
      neutralCalibration(),
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
      neutralCalibration(),
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
    // 900 measured against a 600 estimate → 1.5.
    expect(c.handsOn.board.ratio).toBeCloseTo(1.5, 5);
    // Wall-clock was estimated at 3600 and measured at 3600 → 1.0.
    expect(c.wallClock.board.ratio).toBeCloseTo(1, 5);
    const s = summarizeGoalEffort(
      [closed(DAY), task(), task({ status: 'in-progress' })],
      'g1',
      c,
      NOW,
    );
    if (s.kind !== 'ready') throw new Error('expected ready');
    // Two open tickets at 600s hands-on each, corrected by 1.5.
    expect(s.handsOnRemainingSeconds).toBe(1800);
    // …and the wall-clock remainder is untouched by the hands-on ratio.
    expect(s.wallClockRemainingSeconds).toBe(7200);
  });
});

describe('summarizeGoalEffort — projection', () => {
  it('shows no date below three closes in the window', () => {
    const s = summarizeGoalEffort(
      [closed(DAY), closed(2 * DAY), task()],
      'g1',
      neutralCalibration(),
      NOW,
    );
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.closesInWindow).toBe(2);
    expect(s.projectedFinishAt).toBeUndefined();
  });

  it('ignores closes older than the pace window', () => {
    const s = summarizeGoalEffort(
      [closed(DAY), closed(2 * DAY), closed((EFFORT_PACE_WINDOW_DAYS + 1) * DAY), task()],
      'g1',
      neutralCalibration(),
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
      neutralCalibration(),
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
      neutralCalibration(),
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
    const s = summarizeGoalEffort([...small, ...big], 'g1', neutralCalibration(), NOW);
    if (s.kind !== 'ready') throw new Error('expected ready');
    expect(s.projectedFinishAt).toBeUndefined();
    expect(s.projectionOverHorizonDays).toBeGreaterThan(EFFORT_MAX_PROJECTION_DAYS);
    // Positive control: the same shape inside the horizon still gets a date,
    // so the assertion above cannot be met by a projection that never fires.
    const near = summarizeGoalEffort(
      [...small, task(tiny), task(tiny)],
      'g1',
      neutralCalibration(),
      NOW,
    );
    if (near.kind !== 'ready') throw new Error('expected ready');
    expect(near.projectedFinishAt).toBeDefined();
    expect(near.projectionOverHorizonDays).toBeUndefined();
  });

  it('adds the later end of the range only when the samples support a spread', () => {
    const noSpread = summarizeGoalEffort(
      [closed(DAY), closed(2 * DAY), closed(3 * DAY), task()],
      'g1',
      neutralCalibration(),
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
