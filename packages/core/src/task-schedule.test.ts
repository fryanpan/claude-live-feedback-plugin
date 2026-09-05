/**
 * The occurrence arithmetic, driven directly. Criterion 2 of the scheduler
 * ticket lives here: fixed-cadence and after-completion rules produce the
 * right next occurrence, and the day math survives a DST transition.
 *
 * Every instant is a literal rather than something derived from the wall
 * clock: these functions are pure, so a test that computed its own expected
 * answer would be asserting the implementation against itself.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'vitest';
import {
  type TaskSchedule,
  dueOccurrence,
  instantForLocal,
  isKnownTimezone,
  nextOccurrence,
  parseSchedule,
  zonedParts,
} from './task-schedule.ts';

/** 2026-03-02T00:00:00Z, a Monday. */
const MON = Date.UTC(2026, 2, 2);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function sched(over: Partial<TaskSchedule> & Pick<TaskSchedule, 'rule'>): TaskSchedule {
  return { armedAt: MON, ...over };
}

describe('nextOccurrence — one-off', () => {
  it('is owed its instant once, and nothing after it has fired', () => {
    const rule = sched({ rule: { kind: 'once', at: MON + HOUR } });
    expect(nextOccurrence(rule)).toBe(MON + HOUR);
    const fired = { ...rule, state: { lastOccurrenceAt: MON + HOUR } };
    expect(nextOccurrence(fired)).toBeUndefined();
  });

  it('is owed nothing when its instant is already behind the arming', () => {
    expect(nextOccurrence(sched({ rule: { kind: 'once', at: MON - HOUR } }))).toBeUndefined();
  });
});

describe('nextOccurrence — fixed cadence on an interval', () => {
  it('anchors every step to the arming, not to when the last one fired', () => {
    const rule = sched({ rule: { kind: 'every', everyMs: 20 * 60_000 } });
    expect(nextOccurrence(rule)).toBe(MON + 20 * 60_000);
    // The fire landed 90s late — a tick noticed it a minute after it was
    // owed. The next occurrence must NOT be 20 minutes after that.
    const late = {
      ...rule,
      state: { lastOccurrenceAt: MON + 20 * 60_000, lastFiredAt: MON + 21 * 60_000 },
    };
    expect(nextOccurrence(late)).toBe(MON + 40 * 60_000);
  });

  it('skips every step already spent when the cursor is far ahead', () => {
    const rule = sched({
      rule: { kind: 'every', everyMs: HOUR },
      state: { lastOccurrenceAt: MON + 9 * HOUR + 1 },
    });
    expect(nextOccurrence(rule)).toBe(MON + 10 * HOUR);
  });

  it('stops at until', () => {
    const rule = sched({ rule: { kind: 'every', everyMs: HOUR }, until: MON + HOUR });
    expect(nextOccurrence(rule)).toBeUndefined();
  });
});

describe('nextOccurrence — fixed cadence on the calendar', () => {
  it('takes the next listed time of day, then the first one tomorrow', () => {
    const rule = sched({
      rule: {
        kind: 'calendar',
        times: [
          { hour: 17, minute: 0 },
          { hour: 9, minute: 0 },
        ],
      },
      timezone: 'UTC',
    });
    expect(nextOccurrence(rule)).toBe(MON + 9 * HOUR);
    const after9 = { ...rule, state: { lastOccurrenceAt: MON + 9 * HOUR } };
    expect(nextOccurrence(after9)).toBe(MON + 17 * HOUR);
    const after17 = { ...rule, state: { lastOccurrenceAt: MON + 17 * HOUR } };
    expect(nextOccurrence(after17)).toBe(MON + DAY + 9 * HOUR);
  });

  it('skips the days the weekday filter excludes', () => {
    // Weekdays only, armed on a Monday, cursor parked on Friday evening.
    const friday9 = MON + 4 * DAY + 9 * HOUR;
    const rule = sched({
      rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }], weekdays: [1, 2, 3, 4, 5] },
      timezone: 'UTC',
      state: { lastOccurrenceAt: friday9 },
    });
    // Saturday and Sunday are skipped: the next is Monday.
    expect(nextOccurrence(rule)).toBe(MON + 7 * DAY + 9 * HOUR);
  });

  it('is owed nothing when the weekday list admits no day', () => {
    const rule = sched({
      rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }], weekdays: [] },
    });
    expect(nextOccurrence(rule)).toBeUndefined();
  });
});

describe('DST — the day math is wall-clock, not 24 hours', () => {
  // US spring forward 2026: 2026-03-08, clocks go 02:00 -> 03:00 local.
  const NY = 'America/New_York';

  it('keeps 9am at 9am local across a spring-forward, so the gap is 23 hours', () => {
    const saturday9 = instantForLocal(NY, 2026, 3, 7, 9, 0);
    const rule = sched({
      rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }] },
      timezone: NY,
      armedAt: saturday9 - HOUR,
      state: { lastOccurrenceAt: saturday9 },
    });
    const sunday9 = nextOccurrence(rule);
    expect(sunday9).toBeDefined();
    // The wall clock still reads 9am...
    expect(zonedParts(sunday9 as number, NY).hour).toBe(9);
    // ...and exactly 23 hours of real time passed, which is the whole point:
    // an interval rule would have landed on 10am.
    expect((sunday9 as number) - saturday9).toBe(23 * HOUR);
  });

  it('keeps 9am at 9am across a fall-back, so the gap is 25 hours', () => {
    // US fall back 2026: 2026-11-01, clocks go 02:00 -> 01:00 local.
    const saturday9 = instantForLocal(NY, 2026, 10, 31, 9, 0);
    const rule = sched({
      rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }] },
      timezone: NY,
      armedAt: saturday9 - HOUR,
      state: { lastOccurrenceAt: saturday9 },
    });
    const sunday9 = nextOccurrence(rule) as number;
    expect(zonedParts(sunday9, NY).hour).toBe(9);
    expect(sunday9 - saturday9).toBe(25 * HOUR);
  });

  it('fires a 2:30am rule exactly once on the day 2:30am does not exist', () => {
    const saturday = instantForLocal(NY, 2026, 3, 7, 2, 30);
    const rule = sched({
      rule: { kind: 'calendar', times: [{ hour: 2, minute: 30 }] },
      timezone: NY,
      armedAt: saturday - HOUR,
      state: { lastOccurrenceAt: saturday },
    });
    const sunday = nextOccurrence(rule) as number;
    // The local time it lands on is the shifted one, and there is exactly one
    // of it — the rule is not skipped and not doubled.
    expect(zonedParts(sunday, NY).day).toBe(8);
    const after = { ...rule, state: { lastOccurrenceAt: sunday } };
    expect(zonedParts(nextOccurrence(after) as number, NY).day).toBe(9);
  });

  it('an unknown zone is rejected rather than silently computed in UTC', () => {
    expect(isKnownTimezone('Mars/Olympus_Mons')).toBe(false);
    expect(
      parseSchedule({ rule: { kind: 'every', everyMs: 60_000 }, timezone: 'Mars/Olympus_Mons' }),
    ).toEqual({
      ok: false,
      error: 'timezone must be a known IANA zone',
    });
  });
});

describe('nextOccurrence — after completion', () => {
  const rule = { kind: 'after-completion', delayMs: 2 * HOUR } as const;

  it('is owed one delay after the arming when it has never fired', () => {
    expect(nextOccurrence(sched({ rule }))).toBe(MON + 2 * HOUR);
  });

  it('is owed NOTHING while the instance it created is still open', () => {
    const fired = sched({ rule, state: { lastOccurrenceAt: MON + 2 * HOUR } });
    expect(nextOccurrence(fired, {})).toBeUndefined();
  });

  it('computes the next occurrence from when the last instance FINISHED', () => {
    const fired = sched({ rule, state: { lastOccurrenceAt: MON + 2 * HOUR } });
    // The instance ran long: finished nine hours after the occurrence.
    const done = MON + 11 * HOUR;
    expect(nextOccurrence(fired, { lastCompletedAt: done })).toBe(done + 2 * HOUR);
  });

  it('never hands back an instant already spent when the completion predates it', () => {
    const fired = sched({ rule, state: { lastOccurrenceAt: MON + 10 * HOUR } });
    const next = nextOccurrence(fired, { lastCompletedAt: MON + HOUR });
    expect(next).toBe(MON + 12 * HOUR);
  });
});

describe('dueOccurrence — a catch-up collapses into one run', () => {
  it('is undefined when the next occurrence is still ahead', () => {
    const rule = sched({ rule: { kind: 'every', everyMs: HOUR } });
    expect(dueOccurrence(rule, MON + 30 * 60_000)).toBeUndefined();
  });

  it('reports the latest due occurrence and how many it stands in for', () => {
    const rule = sched({
      rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }] },
      timezone: 'UTC',
    });
    // Four days of downtime: Mon..Thu 9am all came due.
    const thursdayEvening = MON + 3 * DAY + 20 * HOUR;
    expect(dueOccurrence(rule, thursdayEvening)).toEqual({
      at: MON + 3 * DAY + 9 * HOUR,
      missed: 3,
    });
  });

  it('reports missed 0 for an ordinary single occurrence', () => {
    const rule = sched({ rule: { kind: 'every', everyMs: HOUR } });
    expect(dueOccurrence(rule, MON + HOUR + 1)).toEqual({ at: MON + HOUR, missed: 0 });
  });

  it('collapses a long outage on a fine cadence into ONE occurrence', () => {
    // A one-minute rule down for a weekend: 2,880 occurrences came due. The
    // answer has to be the LATEST of them, whatever the number is — an answer
    // that stopped short would be an instant still in the past, and the runner
    // would fire again on the next tick and the tick after that, producing one
    // instance per pass instead of the single catch-up the design promises.
    const rule = sched({ rule: { kind: 'every', everyMs: 60_000 } });
    const twoDaysLater = MON + 2 * DAY;
    expect(dueOccurrence(rule, twoDaysLater)).toEqual({
      at: twoDaysLater,
      missed: 2 * 24 * 60 - 1,
    });
    // And the cursor that answer produces is genuinely spent: nothing more is
    // owed at the same instant.
    const advanced = { ...rule, state: { lastOccurrenceAt: twoDaysLater } };
    expect(dueOccurrence(advanced, twoDaysLater)).toBeUndefined();
  });

  it('never walks past until on an interval rule', () => {
    const rule = sched({ rule: { kind: 'every', everyMs: HOUR }, until: MON + 3 * HOUR });
    // 1h, 2h and 3h all fall at or before `now`, but `until` admits only the
    // occurrences strictly before it — so the latest legal one is 2h.
    expect(dueOccurrence(rule, MON + 10 * HOUR)).toEqual({ at: MON + 2 * HOUR, missed: 1 });
  });

  it('an after-completion rule is owed ONE occurrence, however late the tick', () => {
    // The bug this pins: the walk re-read the same `lastCompletedAt` after
    // every step and manufactured an occurrence per delay out of one finished
    // run — handing back an instant hours past the one the rule was owed.
    const rule = sched({
      rule: { kind: 'after-completion', delayMs: 2 * HOUR },
      state: { lastOccurrenceAt: MON + 2 * HOUR },
    });
    const finished = MON + 3 * HOUR;
    // Ticking a full day late must still name the occurrence two hours after
    // the completion, and stand in for nothing.
    expect(dueOccurrence(rule, MON + DAY, { lastCompletedAt: finished })).toEqual({
      at: finished + 2 * HOUR,
      missed: 0,
    });
  });

  it('is owed nothing while an after-completion instance is still open', () => {
    const rule = sched({
      rule: { kind: 'after-completion', delayMs: 2 * HOUR },
      state: { lastOccurrenceAt: MON + 2 * HOUR },
    });
    expect(dueOccurrence(rule, MON + DAY)).toBeUndefined();
  });
});

describe('parseSchedule', () => {
  it('refuses a rule kind it cannot compute', () => {
    expect(parseSchedule({ rule: { kind: 'phase-of-moon' } }).ok).toBe(false);
  });

  it('refuses a calendar rule with an impossible time', () => {
    expect(parseSchedule({ rule: { kind: 'calendar', times: [{ hour: 24, minute: 0 }] } }).ok).toBe(
      false,
    );
  });

  it('refuses a non-positive interval', () => {
    expect(parseSchedule({ rule: { kind: 'every', everyMs: 0 } }).ok).toBe(false);
  });

  it('accepts a weekday rule and dedupes the day list', () => {
    expect(
      parseSchedule({
        rule: { kind: 'calendar', times: [{ hour: 9, minute: 30 }], weekdays: [1, 1, 3] },
        timezone: 'America/New_York',
      }),
    ).toEqual({
      ok: true,
      rule: { kind: 'calendar', times: [{ hour: 9, minute: 30 }], weekdays: [1, 3] },
      timezone: 'America/New_York',
    });
  });
});
