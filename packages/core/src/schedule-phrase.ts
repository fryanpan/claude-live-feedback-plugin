/**
 * A schedule rule written as ENGLISH — the half of the phrase editor that
 * turns a `ScheduleRule` back into the sentence somebody typed.
 *
 * The editor shows one rule two ways: a phrase you type, and chips you can
 * click. Bryan's condition on the approved mock was that neither is the
 * source — *"the phrase and the chips are two views of ONE rule"* — so
 * editing a chip has to rewrite the phrase, and a new phrase has to
 * re-derive the chips. That only works if the writer here and the parser in
 * `schedule-phrase-parse.ts` agree, which is what the round-trip tests
 * assert: for every phrase the parser accepts, writing the rule it produced
 * and parsing THAT gives the same rule back.
 *
 * It lives in `core` beside `task-schedule.ts` for the reason that file
 * gives: a second spelling of "every weekday at 9" anywhere else would be a
 * second answer to when a row is owed. The chips are drawn from these same
 * labels, so a chip can never read differently from the phrase it stands for.
 *
 * ── Canonical forms ─────────────────────────────────────────────────────
 *
 *   once              `Sep 10 at 3pm`            (+ year when it is not this
 *                                                 year, or is in the past)
 *   calendar          `every day at 9am and 5pm`
 *                     `every weekday at 9am`
 *                     `every Monday and Thursday at 9am`
 *   every (interval)  `every 20 minutes`  `every 2 hours`  `every week`
 *   after-completion  `3 days after it's done`
 *   end               ` until Dec`  ` until Dec 15`
 *
 * **An interval rule never says "day".** `every` is a fixed number of
 * milliseconds and `calendar` is a wall clock, and "every day" has to mean
 * the second one — so one day of interval writes as `every 24 hours`. The
 * parser still ACCEPTS "every 3 days" (it is what a person types); it just
 * canonicalises to hours or weeks, which is also the honest reading, because
 * an interval rule really does drift an hour across a daylight-saving change.
 */

import {
  DEFAULT_SCHEDULE_TIMEZONE,
  type ScheduleCalendar,
  type ScheduleRule,
  type TimeOfDay,
  type Weekday,
  zonedParts,
} from './task-schedule.ts';

/** Monday to Friday, the set `weekday` means. */
export const WEEKDAYS_MON_FRI: readonly Weekday[] = [1, 2, 3, 4, 5];
/** Saturday and Sunday, the set `weekend` means. */
export const WEEKEND_DAYS: readonly Weekday[] = [0, 6];

/** Sunday first, matching `Weekday`. */
export const WEEKDAY_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** The day chips' letters, Sunday first. */
export const WEEKDAY_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;

export const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** A rule plus the one limit that is not part of it. `until` sits on
 *  `TaskSchedule` rather than inside the rule, and the phrase carries both
 *  because "until Dec" is a clause of the same sentence. */
export interface SchedulePhrase {
  rule: ScheduleRule;
  /** Exclusive end, epoch ms — no occurrence at or after it. */
  until?: number;
}

/** What reading and writing a phrase need beyond the rule itself: which year
 *  a bare "Sep 10" means, and which wall clock the local times belong to. */
export interface SchedulePhraseContext {
  /** Epoch ms. Passed in, never read from the clock — same seam as every
   *  function in `task-schedule.ts`. */
  now: number;
  timezone?: string;
}

/** The two readings of a cadence, which is the rule KIND under another name:
 *  a fixed-cadence rule is `on-schedule`, `after-completion` is the other. */
export type ScheduleMode = 'on-schedule' | 'after-completion';

/** Which mode this rule is in. A one-off is `on-schedule`: it has a time of
 *  its own and nothing to wait for. */
export function scheduleModeOf(rule: ScheduleRule): ScheduleMode {
  return rule.kind === 'after-completion' ? 'after-completion' : 'on-schedule';
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 604_800_000;

/** The spacing a rule implies, used when a reader flips the mode: the delay
 *  an after-completion rule should start from. A calendar rule has no single
 *  interval, so one day is the reading — it fires at a time of day, and the
 *  nearest thing to "again" is tomorrow. */
export function spacingMsOf(rule: ScheduleRule): number {
  switch (rule.kind) {
    case 'every':
      return rule.everyMs;
    case 'after-completion':
      return rule.delayMs;
    default:
      return DAY_MS;
  }
}

/** The same rule read as "a delay after the last run finished". */
export function asAfterCompletion(rule: ScheduleRule): ScheduleRule {
  if (rule.kind === 'after-completion') return rule;
  return { kind: 'after-completion', delayMs: spacingMsOf(rule) };
}

/** The same rule read as a fixed cadence. An interval, not a calendar rule:
 *  a delay carries no time of day, and inventing one would put an hour in the
 *  phrase that the reader never typed. A caller that still holds the rule the
 *  reader flipped AWAY from should restore that instead. */
export function asOnSchedule(rule: ScheduleRule): ScheduleRule {
  if (rule.kind !== 'after-completion') return rule;
  return { kind: 'every', everyMs: rule.delayMs };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `9am`, `9:30am`, `12pm`, `12am`. */
export function formatTimeOfDay(time: TimeOfDay): string {
  const suffix = time.hour < 12 ? 'am' : 'pm';
  const h12 = time.hour % 12 === 0 ? 12 : time.hour % 12;
  return time.minute === 0 ? `${h12}${suffix}` : `${h12}:${pad2(time.minute)}${suffix}`;
}

/** Sorted, de-duplicated, and joined the way a sentence joins a list. */
export function sortedUniqueTimes(times: readonly TimeOfDay[]): TimeOfDay[] {
  const seen = new Set<number>();
  const out: TimeOfDay[] = [];
  for (const t of [...times].sort((a, b) => a.hour - b.hour || a.minute - b.minute)) {
    const key = t.hour * 60 + t.minute;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ hour: t.hour, minute: t.minute });
  }
  return out;
}

function joinEnglish(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** `9am and 5pm`, `9am, 12pm and 5pm`. */
export function formatTimeList(times: readonly TimeOfDay[]): string {
  return joinEnglish(sortedUniqueTimes(times).map(formatTimeOfDay));
}

function sameDays(a: readonly Weekday[], b: readonly Weekday[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((d) => set.has(d));
}

/** `day`, `weekday`, `weekend`, `Monday`, `Monday and Thursday` — the word
 *  after "every" for a calendar rule, and the cadence chip's own label with
 *  the first letter raised. */
export function cadenceWords(rule: ScheduleCalendar): string {
  const days = rule.weekdays;
  if (days === undefined || days.length === 0 || days.length === 7) return 'day';
  if (sameDays(days, WEEKDAYS_MON_FRI)) return 'weekday';
  if (sameDays(days, WEEKEND_DAYS)) return 'weekend';
  return joinEnglish([...days].sort((a, b) => a - b).map((d) => WEEKDAY_LONG[d]));
}

interface IntervalOptions {
  /** Whether `day` may be used. False for an `every` rule, where "every day"
   *  has to mean the calendar reading — see the module doc. */
  allowDays: boolean;
  /** Whether one of something may drop its count. "every hour" reads right
   *  and "hour after it's done" does not, so the two callers differ. */
  bareSingular: boolean;
}

/** `20 minutes`, `hour`, `2 hours`, `week`, `3 days`. */
export function formatInterval(ms: number, opts: IntervalOptions): string {
  const unit = (n: number, word: string): string =>
    n === 1 && opts.bareSingular ? word : `${n} ${word}${n === 1 ? '' : 's'}`;
  if (ms % WEEK_MS === 0 && ms >= WEEK_MS) return unit(ms / WEEK_MS, 'week');
  if (opts.allowDays && ms % DAY_MS === 0 && ms >= DAY_MS) return unit(ms / DAY_MS, 'day');
  if (ms % HOUR_MS === 0 && ms >= HOUR_MS) return unit(ms / HOUR_MS, 'hour');
  if (ms % MINUTE_MS === 0 && ms >= MINUTE_MS) return unit(ms / MINUTE_MS, 'minute');
  if (ms % 1000 === 0 && ms >= 1000) return unit(ms / 1000, 'second');
  return unit(ms, 'millisecond');
}

/** Does this instant need its year said out loud? Yes when it is not the
 *  current year, and yes when it is in the past — a bare "Sep 10" always
 *  reads as the NEXT one, so a spent date has to carry its year or it would
 *  come back a year later. */
function needsYear(instant: number, ctx: SchedulePhraseContext, tz: string): boolean {
  return zonedParts(instant, tz).year !== zonedParts(ctx.now, tz).year || instant <= ctx.now;
}

function formatDay(instant: number, ctx: SchedulePhraseContext, tz: string): string {
  const p = zonedParts(instant, tz);
  const head = `${MONTH_SHORT[p.month - 1]} ${p.day}`;
  return needsYear(instant, ctx, tz) ? `${head} ${p.year}` : head;
}

/** `Dec` for the first instant of a month, `Dec 15` otherwise — the end
 *  chip's label and the phrase's `until` clause, one function so they cannot
 *  disagree. */
export function formatUntil(until: number, ctx: SchedulePhraseContext): string {
  const tz = ctx.timezone ?? DEFAULT_SCHEDULE_TIMEZONE;
  const p = zonedParts(until, tz);
  const year = needsYear(until, ctx, tz) ? ` ${p.year}` : '';
  if (p.day === 1 && p.hour === 0 && p.minute === 0) return `${MONTH_SHORT[p.month - 1]}${year}`;
  return `${MONTH_SHORT[p.month - 1]} ${p.day}${year}`;
}

/** The rule as canonical English. The inverse of `parseSchedulePhrase`, and
 *  asserted to be so: parsing what this writes gives the rule back. */
export function writeSchedulePhrase(phrase: SchedulePhrase, ctx: SchedulePhraseContext): string {
  const tz = ctx.timezone ?? DEFAULT_SCHEDULE_TIMEZONE;
  const rule = phrase.rule;
  let head: string;
  switch (rule.kind) {
    case 'once': {
      const p = zonedParts(rule.at, tz);
      head = `${formatDay(rule.at, ctx, tz)} at ${formatTimeOfDay({ hour: p.hour, minute: p.minute })}`;
      break;
    }
    case 'every':
      head = `every ${formatInterval(rule.everyMs, { allowDays: false, bareSingular: true })}`;
      break;
    case 'calendar':
      head = `every ${cadenceWords(rule)} at ${formatTimeList(rule.times)}`;
      break;
    case 'after-completion':
      head = `${formatInterval(rule.delayMs, { allowDays: true, bareSingular: false })} after it's done`;
      break;
  }
  // A one-off is already bounded by its own instant, so an end clause on it
  // would be a second answer to a question already settled.
  if (phrase.until === undefined || rule.kind === 'once') return head;
  return `${head} until ${formatUntil(phrase.until, ctx)}`;
}

/**
 * The rule as CHIPS: the same labels `writeSchedulePhrase` builds its sentence
 * from, split at the joints a reader scans rather than read as prose.
 *
 * One function rather than a second vocabulary, for the reason the module
 * doc gives: a chip that read differently from the phrase it stands for would
 * be a second answer to when the row is owed. Everything here comes back out
 * of `cadenceWords`, `formatTimeList`, `formatInterval` and `formatUntil` —
 * add a label and it has to go in one of those, where the phrase gets it too.
 *
 * A ONE-OFF GETS NO PARTS, deliberately. Its rule is its instant, and every
 * surface that draws these already draws the next occurrence beside them — so
 * a chip would say the date the row is already showing, twice.
 */
export function scheduleRuleChipParts(
  phrase: SchedulePhrase,
  ctx: SchedulePhraseContext,
): string[] {
  const rule = phrase.rule;
  const parts: string[] = [];
  switch (rule.kind) {
    case 'once':
      return [];
    case 'every':
      parts.push(`Every ${formatInterval(rule.everyMs, { allowDays: false, bareSingular: true })}`);
      break;
    case 'calendar':
      // Two parts, because they are two questions — which days, and at what
      // time — and a reader scanning a column of rules compares them one at a
      // time. `cadenceWords` writes them lower-case for the sentence.
      parts.push(`Every ${cadenceWords(rule)}`, formatTimeList(rule.times));
      break;
    case 'after-completion':
      parts.push(
        `${formatInterval(rule.delayMs, { allowDays: true, bareSingular: false })} after it's done`,
      );
      break;
  }
  // The end is part of the rule, so a rule that stops in December must say so
  // — a chip strip that showed the cadence and swallowed the end would read
  // as a rule that runs forever.
  if (phrase.until !== undefined) parts.push(`until ${formatUntil(phrase.until, ctx)}`);
  return parts;
}

/** The phrases the editor offers as one-tap starting points. They are the
 *  four the ticket's acceptance criteria name, so the row a reader sees and
 *  the row the round-trip tests walk are the same four. */
export const SCHEDULE_PHRASE_EXAMPLES = [
  'every weekday at 9am',
  'Sep 10 at 3pm',
  'twice a day at 9 and 5',
  'every Monday 9:00 until Dec',
] as const;
