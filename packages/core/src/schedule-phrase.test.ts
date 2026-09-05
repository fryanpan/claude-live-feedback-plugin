/**
 * The phrase and the chips are two views of one rule, so the parser and the
 * writer have to be inverses. These tests assert that in both directions:
 * a phrase a person types produces the rule the chips will show, and writing
 * that rule produces a phrase which parses back to the same rule.
 *
 * `now` is pinned and the zone is named on every case — the whole family is
 * clock-free by construction (`task-schedule.ts`), and a test that read the
 * machine's clock could pass in September and fail in December.
 */
import { describe, expect, it } from 'vitest';
import { parseSchedulePhrase } from './schedule-phrase-parse.ts';
import {
  SCHEDULE_PHRASE_EXAMPLES,
  type SchedulePhrase,
  asAfterCompletion,
  asOnSchedule,
  cadenceWords,
  formatTimeList,
  formatTimeOfDay,
  formatUntil,
  scheduleModeOf,
  writeSchedulePhrase,
} from './schedule-phrase.ts';
import { type ScheduleRule, nextOccurrence, zonedParts } from './task-schedule.ts';

const TZ = 'America/Los_Angeles';
// 2026-09-05 10:00 local, a Saturday — chosen so "Sep 10" is still ahead and
// "until Dec" lands in the same year.
const NOW = Date.UTC(2026, 8, 5, 17, 0, 0);
const CTX = { now: NOW, timezone: TZ };

function parse(phrase: string): SchedulePhrase {
  const res = parseSchedulePhrase(phrase, CTX);
  if (!res.ok) throw new Error(`${phrase} did not parse: ${res.error}`);
  return res.phrase;
}

describe('reading a phrase', () => {
  it('reads "every weekday at 9am" as nine on Monday through Friday', () => {
    expect(parse('every weekday at 9am')).toEqual({
      rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }], weekdays: [1, 2, 3, 4, 5] },
    });
  });

  it('reads "Sep 10 at 3pm" as a one-off at that local instant', () => {
    const phrase = parse('Sep 10 at 3pm');
    expect(phrase.rule.kind).toBe('once');
    const at = (phrase.rule as { kind: 'once'; at: number }).at;
    expect(zonedParts(at, TZ)).toMatchObject({
      year: 2026,
      month: 9,
      day: 10,
      hour: 15,
      minute: 0,
    });
  });

  it('reads "twice a day at 9 and 5" as nine in the morning and five in the afternoon', () => {
    expect(parse('twice a day at 9 and 5')).toEqual({
      rule: {
        kind: 'calendar',
        times: [
          { hour: 9, minute: 0 },
          { hour: 17, minute: 0 },
        ],
      },
    });
  });

  it('reads "every Monday 9:00 until Dec" with a weekday, a clock time and an end', () => {
    const phrase = parse('every Monday 9:00 until Dec');
    expect(phrase.rule).toEqual({
      kind: 'calendar',
      times: [{ hour: 9, minute: 0 }],
      weekdays: [1],
    });
    expect(zonedParts(phrase.until ?? 0, TZ)).toMatchObject({
      year: 2026,
      month: 12,
      day: 1,
      hour: 0,
    });
  });

  it('takes a bare hour with minutes or a meridiem literally', () => {
    expect(parse('every day at 9:00')).toMatchObject({
      rule: { times: [{ hour: 9, minute: 0 }] },
    });
    expect(parse('every day at 5am')).toMatchObject({
      rule: { times: [{ hour: 5, minute: 0 }] },
    });
    expect(parse('every day at noon')).toMatchObject({
      rule: { times: [{ hour: 12, minute: 0 }] },
    });
  });

  it('reads a counted interval as a fixed cadence, and a bare day as a wall clock', () => {
    expect(parse('every 20 minutes').rule).toEqual({ kind: 'every', everyMs: 1_200_000 });
    expect(parse('every 3 days').rule).toEqual({ kind: 'every', everyMs: 259_200_000 });
    expect(parse('every hour').rule).toEqual({ kind: 'every', everyMs: 3_600_000 });
    expect(parse('every day').rule).toEqual({ kind: 'calendar', times: [{ hour: 9, minute: 0 }] });
  });

  it('reads a delay after completion', () => {
    expect(parse("3 days after it's done").rule).toEqual({
      kind: 'after-completion',
      delayMs: 259_200_000,
    });
    expect(parse('2 hours after completion').rule).toEqual({
      kind: 'after-completion',
      delayMs: 7_200_000,
    });
  });

  it('reads named weekdays, weekends and several at once', () => {
    expect(parse('every Monday and Thursday at 9am').rule).toMatchObject({ weekdays: [1, 4] });
    expect(parse('every weekend at 10am').rule).toMatchObject({ weekdays: [0, 6] });
    expect(parse('every Tue at 7:30am').rule).toMatchObject({ weekdays: [2] });
  });

  it('refuses what it cannot express, rather than dropping half of it', () => {
    expect(parseSchedulePhrase('', CTX)).toMatchObject({ ok: false });
    expect(parseSchedulePhrase('sometime soonish', CTX)).toMatchObject({ ok: false });
    // `calendar` has no interval and `every` has no clock, so this rule has
    // no shape to land in — and silently becoming "every day at 9am" would
    // throw away the interval the reader typed.
    expect(parseSchedulePhrase('every 3 days at 9am', CTX)).toMatchObject({ ok: false });
    expect(parseSchedulePhrase('every Sep 10 at 9am', CTX)).toMatchObject({ ok: false });
  });

  it('refuses a word it did not read, rather than defaulting to every day at 9am', () => {
    // A fresh-eyes review typed "every purple" and got a daily rule with no
    // error: the repeat word matched and the rest was never looked at.
    expect(parseSchedulePhrase('every purple', CTX)).toMatchObject({
      ok: false,
      error: 'did not understand "purple"',
    });
    expect(parseSchedulePhrase('every day purple at 9am', CTX)).toMatchObject({ ok: false });
    expect(parseSchedulePhrase('every', CTX)).toMatchObject({ ok: false });
    // The words a scope may hold still read, alone and together.
    expect(parseSchedulePhrase('daily', CTX)).toMatchObject({ ok: true });
    expect(parseSchedulePhrase('every 9am', CTX)).toMatchObject({ ok: true });
    expect(parseSchedulePhrase('every Mon, Wed and Fri at 9am', CTX)).toMatchObject({ ok: true });
  });

  it('reads a spent date as the next one, and a bare time as the next time round', () => {
    // NOW is 5 Sep; 1 Sep has gone, so the rule is next year's.
    const past = parse('Sep 1 at 9am').rule as { kind: 'once'; at: number };
    expect(zonedParts(past.at, TZ)).toMatchObject({ year: 2027, month: 9, day: 1 });
    const soon = parse('at 3pm').rule as { kind: 'once'; at: number };
    expect(soon.at).toBeGreaterThan(NOW);
    expect(zonedParts(soon.at, TZ)).toMatchObject({ day: 5, hour: 15 });
  });
});

describe('writing a rule back as English', () => {
  it('writes each example in its canonical spelling', () => {
    const canonical = SCHEDULE_PHRASE_EXAMPLES.map((p) => writeSchedulePhrase(parse(p), CTX));
    expect(canonical).toEqual([
      'every weekday at 9am',
      'Sep 10 at 3pm',
      'every day at 9am and 5pm',
      'every Monday at 9am until Dec',
    ]);
  });

  it('never says "day" for an interval rule, because "every day" is a wall clock', () => {
    expect(writeSchedulePhrase({ rule: { kind: 'every', everyMs: 86_400_000 } }, CTX)).toBe(
      'every 24 hours',
    );
    expect(writeSchedulePhrase({ rule: { kind: 'every', everyMs: 604_800_000 } }, CTX)).toBe(
      'every week',
    );
    // …and what it writes still reads back as an interval, not a calendar.
    expect(parse('every 24 hours').rule).toEqual({ kind: 'every', everyMs: 86_400_000 });
  });

  it('drops an end clause from a one-off, which is already bounded', () => {
    const at = (parse('Sep 10 at 3pm').rule as { kind: 'once'; at: number }).at;
    expect(writeSchedulePhrase({ rule: { kind: 'once', at }, until: NOW + 1 }, CTX)).toBe(
      'Sep 10 at 3pm',
    );
  });

  it('says the year when the date is not this year or has gone', () => {
    const next = parse('Sep 1 at 9am');
    expect(writeSchedulePhrase(next, CTX)).toBe('Sep 1 2027 at 9am');
  });
});

describe('the parser and the writer round-trip', () => {
  const cases = [
    ...SCHEDULE_PHRASE_EXAMPLES,
    'every day at 9am',
    'every day at 9am, 12pm and 5pm',
    'every weekend at 10am',
    'every Monday and Thursday at 7:30am',
    'every 20 minutes',
    'every 2 hours',
    'every 3 days',
    'every week',
    "3 days after it's done",
    "90 minutes after it's done",
    'Sep 10 at 3pm',
    '2027-01-04 at 8am',
    'every weekday at 9am until Dec 15',
  ];

  it.each(cases)('%s survives write(parse(x)) and parses back the same', (phrase) => {
    const first = parse(phrase);
    const written = writeSchedulePhrase(first, CTX);
    const second = parseSchedulePhrase(written, CTX);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.phrase).toEqual(first);
    // …and the canonical spelling is a fixed point: writing it again changes
    // nothing, so a chip edit followed by a phrase edit cannot drift.
    expect(writeSchedulePhrase(second.phrase, CTX)).toBe(written);
  });

  it('gives a rule the scheduler can compute a next occurrence for', () => {
    for (const phrase of cases) {
      const { rule, until } = parse(phrase);
      const next = nextOccurrence({
        rule,
        timezone: TZ,
        armedAt: NOW,
        ...(until !== undefined ? { until } : {}),
      });
      if (rule.kind === 'once' && (rule as { at: number }).at <= NOW) continue;
      expect(next, phrase).toBeGreaterThan(NOW);
    }
  });
});

describe('the pieces the chips are drawn from', () => {
  it('labels a cadence the same way the phrase spells it', () => {
    expect(cadenceWords({ kind: 'calendar', times: [], weekdays: [1, 2, 3, 4, 5] })).toBe(
      'weekday',
    );
    expect(cadenceWords({ kind: 'calendar', times: [], weekdays: [0, 6] })).toBe('weekend');
    expect(cadenceWords({ kind: 'calendar', times: [] })).toBe('day');
    expect(cadenceWords({ kind: 'calendar', times: [], weekdays: [1, 4] })).toBe(
      'Monday and Thursday',
    );
  });

  it('formats clock times and lists the way the phrase does', () => {
    expect(formatTimeOfDay({ hour: 0, minute: 0 })).toBe('12am');
    expect(formatTimeOfDay({ hour: 12, minute: 0 })).toBe('12pm');
    expect(formatTimeOfDay({ hour: 17, minute: 30 })).toBe('5:30pm');
    expect(
      formatTimeList([
        { hour: 17, minute: 0 },
        { hour: 9, minute: 0 },
      ]),
    ).toBe('9am and 5pm');
  });

  it('names an end the way the phrase clause does', () => {
    const until = parse('every day at 9am until Dec').until ?? 0;
    expect(formatUntil(until, CTX)).toBe('Dec');
    const mid = parse('every day at 9am until Dec 15').until ?? 0;
    expect(formatUntil(mid, CTX)).toBe('Dec 15');
  });

  it('flips the mode between a cadence and a delay', () => {
    const weekly: ScheduleRule = {
      kind: 'calendar',
      times: [{ hour: 9, minute: 0 }],
      weekdays: [1],
    };
    expect(scheduleModeOf(weekly)).toBe('on-schedule');
    const delayed = asAfterCompletion(weekly);
    expect(delayed).toEqual({ kind: 'after-completion', delayMs: 86_400_000 });
    expect(scheduleModeOf(delayed)).toBe('after-completion');
    expect(writeSchedulePhrase({ rule: delayed }, CTX)).toBe("1 day after it's done");
    // Back the other way is an interval, never an invented time of day.
    expect(asOnSchedule(delayed)).toEqual({ kind: 'every', everyMs: 86_400_000 });
    expect(asAfterCompletion({ kind: 'every', everyMs: 7_200_000 })).toEqual({
      kind: 'after-completion',
      delayMs: 7_200_000,
    });
  });
});
