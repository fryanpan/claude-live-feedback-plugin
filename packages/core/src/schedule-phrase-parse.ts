/**
 * English into a `ScheduleRule` — the reading half of the phrase editor.
 *
 * The phrase is the PRIMARY way a rule is set (approved mock): you type
 * "every weekday at 9am" and the chips below are the readback. So this has to
 * accept what a person actually writes, while `writeSchedulePhrase` in
 * `schedule-phrase.ts` decides what the one canonical spelling of the result
 * is. The pair is asserted to round-trip.
 *
 * Pure and clock-free like everything else in this family: `now` arrives in
 * the context, because "Sep 10" means a different instant in September than
 * it does in November and a parser that read the clock could not be tested
 * against either.
 *
 * ── The grammar, in the order it is peeled off ──────────────────────────
 *
 *  1. `until <date>` / `till` / `through` / `ending`      → the end limit
 *  2. `<duration> after it's done`                        → after-completion
 *  3. `every <duration>`                                  → a fixed interval
 *  4. a DATE (`Sep 10`, `10 Sep`, `2026-09-10`, `today`)  → a one-off
 *  5. times, after `at` or trailing (`9am`, `9:00`, `9 and 5`, `noon`)
 *  6. what is left: `day` / `weekday` / `weekend` / named weekdays
 *
 * Step 3 runs before step 6 so "every 20 minutes" is an interval, and step 4
 * runs before step 5 so the 10 in "Sep 10" is a date rather than ten o'clock.
 *
 * **A bare hour reads the way a person means it.** "at 9 and 5" is nine in
 * the morning and five in the afternoon, not nine and five in the morning: an
 * hour of 1–5 with no minutes and no am/pm reads as afternoon, and a later
 * bare hour that would land before an earlier one is pushed past it. An hour
 * with minutes ("9:00") or a meridiem ("9am") is taken literally.
 */

import {
  type SchedulePhrase,
  type SchedulePhraseContext,
  WEEKDAYS_MON_FRI,
  WEEKEND_DAYS,
} from './schedule-phrase.ts';
import {
  DEFAULT_SCHEDULE_TIMEZONE,
  type TimeOfDay,
  type Weekday,
  instantForLocal,
  zonedParts,
} from './task-schedule.ts';

export type SchedulePhraseParse =
  | { ok: true; phrase: SchedulePhrase }
  | { ok: false; error: string };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Longest spelling first, so `\b…\b` cannot stop inside a longer word. */
const DAY_WORDS: readonly (readonly string[])[] = [
  ['sundays', 'sunday', 'sun'],
  ['mondays', 'monday', 'mon'],
  ['tuesdays', 'tuesday', 'tues', 'tue'],
  ['wednesdays', 'wednesday', 'weds', 'wed'],
  ['thursdays', 'thursday', 'thurs', 'thur', 'thu'],
  ['fridays', 'friday', 'fri'],
  ['saturdays', 'saturday', 'sat'],
];

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const UNIT_MS: Record<string, number> = {
  millisecond: 1,
  ms: 1,
  second: 1000,
  sec: 1000,
  minute: 60_000,
  min: 60_000,
  hour: 3_600_000,
  hr: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

const DEFAULT_TIME: TimeOfDay = { hour: 9, minute: 0 };

interface Duration {
  ms: number;
  /** Whether a count was said out loud. "every day" is a calendar rule and
   *  "every 3 days" is an interval, and this is the only thing that tells
   *  them apart. */
  counted: boolean;
  unit: string;
}

function parseDuration(text: string): Duration | undefined {
  const s = text.trim();
  if (/^half\s+an?\s+hour$/.test(s)) return { ms: 1_800_000, counted: true, unit: 'hour' };
  const m = s.match(/^(?:(\d+)|([a-z]+)\s)?\s*(ms|[a-z]+?)s?$/);
  if (!m) return undefined;
  const unit = m[3] ?? '';
  const per = UNIT_MS[unit];
  if (per === undefined) return undefined;
  let count = 1;
  let counted = false;
  if (m[1] !== undefined) {
    count = Number.parseInt(m[1], 10);
    counted = true;
  } else if (m[2] !== undefined) {
    const word = NUMBER_WORDS[m[2]];
    if (word === undefined) return undefined;
    count = word;
    counted = true;
  }
  if (!(count > 0)) return undefined;
  return { ms: count * per, counted, unit };
}

interface DateHit {
  month: number;
  day?: number;
  year?: number;
  /** The phrase with the date taken out. */
  rest: string;
}

const MONTH_ALT = MONTHS.join('|');
const DAY_NUM = String.raw`(\d{1,2})(?:st|nd|rd|th)?`;

function monthIndex(word: string): number {
  return MONTHS.indexOf(word.slice(0, 3)) + 1;
}

function cut(s: string, from: number, length: number): string {
  return `${s.slice(0, from)} ${s.slice(from + length)}`.replace(/\s+/g, ' ').trim();
}

/** A calendar date somewhere in the phrase, or nothing. ISO first because it
 *  is unambiguous; then month-name forms in both orders. */
function extractDate(s: string): DateHit | undefined {
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso?.index !== undefined) {
    return {
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
      rest: cut(s, iso.index, iso[0].length),
    };
  }
  const md = s.match(
    new RegExp(String.raw`\b(${MONTH_ALT})[a-z]*\.?\s+${DAY_NUM}(?:,?\s+(\d{4}))?\b`),
  );
  if (md?.index !== undefined) {
    return {
      month: monthIndex(md[1] ?? ''),
      day: Number(md[2]),
      ...(md[3] !== undefined ? { year: Number(md[3]) } : {}),
      rest: cut(s, md.index, md[0].length),
    };
  }
  const dm = s.match(
    new RegExp(String.raw`\b${DAY_NUM}\s+(${MONTH_ALT})[a-z]*\.?(?:,?\s+(\d{4}))?\b`),
  );
  if (dm?.index !== undefined) {
    return {
      month: monthIndex(dm[2] ?? ''),
      day: Number(dm[1]),
      ...(dm[3] !== undefined ? { year: Number(dm[3]) } : {}),
      rest: cut(s, dm.index, dm[0].length),
    };
  }
  const bare = s.match(new RegExp(String.raw`\b(${MONTH_ALT})[a-z]*\.?(?:\s+(\d{4}))?\b`));
  if (bare?.index !== undefined) {
    return {
      month: monthIndex(bare[1] ?? ''),
      ...(bare[2] !== undefined ? { year: Number(bare[2]) } : {}),
      rest: cut(s, bare.index, bare[0].length),
    };
  }
  return undefined;
}

/** The instant a date-and-time names. With no year said, the NEXT one: the
 *  first year from this one on whose instant is still ahead, which is what
 *  makes "Sep 10" in November mean next September rather than a spent date. */
function instantFor(hit: DateHit, time: TimeOfDay, ctx: SchedulePhraseContext, tz: string): number {
  const day = hit.day ?? 1;
  if (hit.year !== undefined) {
    return instantForLocal(tz, hit.year, hit.month, day, time.hour, time.minute);
  }
  const thisYear = zonedParts(ctx.now, tz).year;
  const here = instantForLocal(tz, thisYear, hit.month, day, time.hour, time.minute);
  if (here > ctx.now) return here;
  return instantForLocal(tz, thisYear + 1, hit.month, day, time.hour, time.minute);
}

const TIME_TOKEN = String.raw`\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?`;

/** Every clock reading in a fragment, or nothing when it holds none. */
function parseTimes(text: string): TimeOfDay[] | undefined {
  const norm = text
    .replace(/\bnoon\b/g, '12pm')
    .replace(/\bmidday\b/g, '12pm')
    .replace(/\bmidnight\b/g, '12am');
  const re = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/g;
  const out: TimeOfDay[] = [];
  let last = -1;
  let m = re.exec(norm);
  while (m !== null) {
    const raw = Number(m[1]);
    const minute = m[2] === undefined ? 0 : Number(m[2]);
    const mer = m[3] === undefined ? undefined : m[3][0];
    let hour = raw;
    if (mer === 'p') {
      if (raw < 1 || raw > 12) return undefined;
      if (hour < 12) hour += 12;
    } else if (mer === 'a') {
      if (raw < 1 || raw > 12) return undefined;
      if (hour === 12) hour = 0;
    } else if (m[2] === undefined) {
      // A bare hour. 1–5 reads as the afternoon, and a reading that would go
      // backwards in a list ("9 and 5") is pushed past the one before it.
      if (hour >= 1 && hour <= 5) hour += 12;
      if (hour <= last) hour = (hour % 12) + 12;
    }
    if (hour > 23 || minute > 59) return undefined;
    last = hour;
    out.push({ hour, minute });
    m = re.exec(norm);
  }
  return out.length > 0 ? out : undefined;
}

/** The times a phrase names and the words that are left once they are gone.
 *  After `at` when there is one, trailing otherwise. */
function splitTimes(s: string): { scope: string; times?: TimeOfDay[]; bad?: boolean } {
  const at = s.match(/\bat\s+(.+)$/);
  if (at?.index !== undefined) {
    const times = parseTimes(at[1] ?? '');
    if (times === undefined) return { scope: s, bad: true };
    return { scope: s.slice(0, at.index).trim(), times };
  }
  const trailing = s.match(
    new RegExp(String.raw`((?:${TIME_TOKEN})(?:\s*(?:,|and)\s*(?:${TIME_TOKEN}))*)\s*$`),
  );
  if (trailing?.index !== undefined && (trailing[1] ?? '').trim() !== '') {
    const times = parseTimes(trailing[1] ?? '');
    if (times !== undefined) return { scope: s.slice(0, trailing.index).trim(), times };
  }
  return { scope: s };
}

function weekdaysIn(scope: string): Weekday[] | undefined {
  if (/\bweekdays?\b/.test(scope)) return [...WEEKDAYS_MON_FRI];
  if (/\bweekends?\b/.test(scope)) return [...WEEKEND_DAYS];
  const found: Weekday[] = [];
  DAY_WORDS.forEach((names, i) => {
    if (new RegExp(String.raw`\b(?:${names.join('|')})\b`).test(scope)) found.push(i as Weekday);
  });
  return found.length > 0 ? found : undefined;
}

const RECUR = /\b(every|each|daily|weekly|twice|thrice|\d+\s*(?:x|times))\b/;

/**
 * Read a phrase, or say why it could not be read.
 *
 * The error is short on purpose: the editor shows a bad phrase by outlining
 * the box, not by printing a sentence under it (owner's standing rule —
 * affordances, not captions), so the text is for the accessible name and for
 * the tests.
 */
export function parseSchedulePhrase(raw: string, ctx: SchedulePhraseContext): SchedulePhraseParse {
  const tz = ctx.timezone ?? DEFAULT_SCHEDULE_TIMEZONE;
  let s = raw
    .toLowerCase()
    .replace(/[.!]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s === '') return { ok: false, error: 'say when this should run' };

  // 1. the end limit, taken off first so nothing downstream sees its date.
  let until: number | undefined;
  const untilMatch = s.match(/\b(?:until|till|til|through|thru|ending)\s+(.+)$/);
  if (untilMatch?.index !== undefined) {
    const hit = extractDate(untilMatch[1] ?? '');
    if (hit === undefined) return { ok: false, error: 'an end needs a date, like "until Dec 1"' };
    const endTimes = parseTimes(hit.rest);
    until = instantFor(hit, endTimes?.[0] ?? { hour: 0, minute: 0 }, ctx, tz);
    s = s.slice(0, untilMatch.index).trim();
  }
  const tail = until === undefined ? {} : { until };

  // 2. after completion. The whole phrase, because the delay is its subject.
  const done = s.match(
    /^(.*?)\s*(?:after|once|when)\s+(?:it'?s?\s+|it\s+is\s+)?(?:done|complete|completed|finished|completion)$/,
  );
  if (done !== null) {
    const head = (done[1] ?? '').replace(/^(?:every|each)\s+/, '');
    const delay = parseDuration(head);
    if (delay === undefined) {
      return { ok: false, error: 'say how long after, like "3 days after it\'s done"' };
    }
    return { ok: true, phrase: { rule: { kind: 'after-completion', delayMs: delay.ms }, ...tail } };
  }

  // 3. a fixed interval. Before the calendar branch, so "every 20 minutes" is
  //    an interval — and only with a count for day-grained units, so bare
  //    "every day" falls through to the wall-clock reading it means.
  const everyMatch = s.match(/^(?:every|each)\s+(.+)$/);
  if (everyMatch !== null) {
    const dur = parseDuration(everyMatch[1] ?? '');
    if (dur !== undefined && (dur.counted || dur.unit !== 'day')) {
      return { ok: true, phrase: { rule: { kind: 'every', everyMs: dur.ms }, ...tail } };
    }
  }

  // 4. a date, before times, so the 10 in "Sep 10" is not ten o'clock.
  let dated: DateHit | undefined;
  const relative = s.match(/\b(today|tomorrow)\b/);
  if (relative?.index !== undefined) {
    const p = zonedParts(ctx.now + (relative[1] === 'tomorrow' ? 86_400_000 : 0), tz);
    dated = {
      year: p.year,
      month: p.month,
      day: p.day,
      rest: cut(s, relative.index, relative[0].length),
    };
  } else {
    dated = extractDate(s);
  }

  // 5. times, 6. what is left.
  const split = splitTimes(dated?.rest ?? s);
  if (split.bad) return { ok: false, error: 'that time did not read as a clock time' };
  const scope = split.scope;
  const times = split.times;
  const weekdays = weekdaysIn(scope);
  const recurring = RECUR.test(scope) || weekdays !== undefined;

  if (dated !== undefined && recurring) {
    return { ok: false, error: 'a repeat and a single date cannot both be set' };
  }
  if (dated !== undefined) {
    const at = instantFor(dated, times?.[0] ?? DEFAULT_TIME, ctx, tz);
    // `until` belongs to a repeat. A one-off is already bounded by its own
    // instant, and carrying one here would survive into a phrase the writer
    // never prints.
    return { ok: true, phrase: { rule: { kind: 'once', at } } };
  }
  if (recurring) {
    // An interval and a time of day cannot both be expressed: `calendar` has
    // no interval field and `every` has no clock. Saying so beats silently
    // dropping half of what was typed.
    if (/\b\d+\s*(?:minute|min|hour|hr|day|week)s?\b/.test(scope)) {
      return { ok: false, error: 'an interval and a time of day cannot both be set' };
    }
    return {
      ok: true,
      phrase: {
        rule: {
          kind: 'calendar',
          times: times ?? [DEFAULT_TIME],
          ...(weekdays !== undefined ? { weekdays } : {}),
        },
        ...tail,
      },
    };
  }
  if (times !== undefined && scope === '') {
    // A bare clock time is the next time it comes round. Tomorrow is read off
    // the local calendar rather than added as a day of milliseconds, for the
    // reason `calendar` exists at all: a day is not 24 hours twice a year.
    const time = times[0] ?? DEFAULT_TIME;
    const dayOf = (shiftMs: number): number => {
      const p = zonedParts(ctx.now + shiftMs, tz);
      return instantForLocal(tz, p.year, p.month, p.day, time.hour, time.minute);
    };
    const today = dayOf(0);
    return {
      ok: true,
      phrase: { rule: { kind: 'once', at: today > ctx.now ? today : dayOf(86_400_000) } },
    };
  }
  return { ok: false, error: 'try "every weekday at 9am" or "Sep 10 at 3pm"' };
}
