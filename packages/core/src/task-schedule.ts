/**
 * A board row's SCHEDULE: the rule that says when work should start, and the
 * arithmetic that turns that rule into the next instant it is owed.
 *
 * Everything here is pure and clock-free — the caller passes `now`, and every
 * function is a total function of its arguments. That is what lets the
 * scheduler be driven by an injected clock in tests instead of by a timer, the
 * same seam `StallNudger` uses (docs/architecture/stall-detection.md).
 *
 * It lives in `core` rather than beside the runner because three other
 * surfaces are going to need the same shapes: the phrase editor that writes a
 * rule as chips, the board section that renders the next occurrence, and the
 * MCP verbs that will eventually set one. A second spelling of "every weekday
 * at 9" in the browser would be a second answer to when the row is owed.
 *
 * ── The two recurrence modes ────────────────────────────────────────────
 *
 * The plan (docs/architecture/scheduled-tasks.md) settled on the split Things
 * and Todoist both arrived at:
 *
 *  - **fixed cadence** — the next occurrence comes from the SCHEDULE, whether
 *    or not the last one was finished (`every`, `calendar`);
 *  - **after completion** — the next occurrence comes from when the last
 *    instance FINISHED (`after-completion`), so a rule whose work is still
 *    open is owed nothing at all.
 *
 * `once` is neither: a one-off fires at its instant and is then spent.
 */

import {
  DEFAULT_SCHEDULE_TIMEZONE,
  instantForLocal,
  isKnownTimezone,
  zonedParts,
} from './schedule-timezone.ts';

// The timezone half lives next door (`schedule-timezone.ts`) but is part of
// one vocabulary: a caller reasoning about a calendar rule needs both, and
// making them import two modules to ask one question would be a split that
// showed in the callers.
export {
  DEFAULT_SCHEDULE_TIMEZONE,
  type ZonedParts,
  instantForLocal,
  isKnownTimezone,
  zonedParts,
} from './schedule-timezone.ts';

/** Sunday is 0, matching `Date.prototype.getUTCDay` and every weekday array
 *  a caller is likely to write by hand. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** A wall-clock time of day in the schedule's own timezone. */
export interface TimeOfDay {
  hour: number;
  minute: number;
}

/** Fire once, at an instant. Spent afterwards — `nextOccurrence` returns
 *  nothing once it has fired, which is what makes "a one-off at a time" a
 *  rule rather than a special case in the runner. */
export interface ScheduleOnce {
  kind: 'once';
  /** Epoch ms. */
  at: number;
}

/** Fixed cadence on a fixed interval, anchored to the moment the rule was
 *  armed. The sub-day half of fixed cadence: "every 20 minutes". Deliberately
 *  NOT expressed in days — a day is not a fixed number of milliseconds in any
 *  timezone that observes DST, and a rule written that way drifts by an hour
 *  twice a year. Day-grained rules are `calendar`. */
export interface ScheduleEvery {
  kind: 'every';
  everyMs: number;
}

/**
 * Fixed cadence in LOCAL WALL-CLOCK time: one occurrence per listed time of
 * day, on the listed weekdays. "Every weekday at 9am", "twice a day at 9
 * and 5", "every Monday 9:00".
 *
 * This is the DST-safe form, and the reason the two fixed-cadence kinds are
 * not one: 9am stays 9am across a transition because the instant is
 * recomputed from the local calendar each day rather than added to the last
 * one. An interval rule cannot do that, and a rule that says "every 24 hours"
 * meaning "every morning" is wrong for half the year.
 */
export interface ScheduleCalendar {
  kind: 'calendar';
  /** At least one, in any order — `nextOccurrence` sorts them. */
  times: TimeOfDay[];
  /** Absent means every day. */
  weekdays?: Weekday[];
}

/** The next occurrence is `delayMs` after the LAST INSTANCE FINISHED. A rule
 *  whose instance is still open is owed nothing, which is the whole point of
 *  the mode: it cannot stack up behind work nobody has done. */
export interface ScheduleAfterCompletion {
  kind: 'after-completion';
  delayMs: number;
}

export type ScheduleRule =
  | ScheduleOnce
  | ScheduleEvery
  | ScheduleCalendar
  | ScheduleAfterCompletion;

/** Every rule kind, for error messages and for a caller enumerating them. */
export const SCHEDULE_RULE_KINDS = ['once', 'every', 'calendar', 'after-completion'] as const;

/**
 * What the SCHEDULER has already done with this rule — its own bookkeeping,
 * persisted beside the rule on the task and nowhere else.
 *
 * `lastOccurrenceAt` is the idempotency key and the only field the arithmetic
 * reads: an occurrence at or before it is spent, and every later one is owed.
 * Storing the OCCURRENCE rather than the wall clock of the fire is what makes
 * a restart safe in both directions — a catch-up after downtime resumes from
 * the last occurrence actually acted on, so nothing is lost, and an
 * occurrence already acted on can never come out due again.
 */
export interface ScheduleState {
  /** The newest occurrence this rule has fired, epoch ms. */
  lastOccurrenceAt?: number;
  /** When the server actually fired it. Provenance a person reads; never a
   *  key, because a catch-up fires an occurrence long after its instant. */
  lastFiredAt?: number;
  /** The task id of the live instance the last fire created. */
  lastInstanceId?: string;
  /** How many occurrences have fired. */
  fireCount?: number;
  /** How many occurrences have been COLLAPSED into a catch-up rather than
   *  given an instance of their own — the plan's "missed runs do not pile
   *  up", counted so the missed-run policy row has the number to act on. */
  missedTotal?: number;
}

/**
 * A rule as stored on a task. `armedAt` is the floor for the first
 * occurrence: a rule can only ever be owed something strictly after the
 * moment somebody set it, whatever the rule says about the past.
 */
export interface TaskSchedule {
  rule: ScheduleRule;
  /** IANA zone the calendar math runs in. ABSENT READS AS UTC — this board
   *  has no workspace timezone to inherit, so the zone belongs to the rule
   *  and the phrase editor is what will set it. */
  timezone?: string;
  /** No occurrence at or after this instant — the "until Dec" chip. */
  until?: number;
  /** When the rule was set, epoch ms. */
  armedAt: number;
  /** Display name of whoever set it. */
  armedBy?: string;
  state?: ScheduleState;
}

/** How far `nextOccurrence` will walk the calendar looking for a day the
 *  weekday filter admits. A year and a bit: the sparsest expressible rule is
 *  one weekday, so 400 days always finds one or the rule admits no day at
 *  all. Bounded so a malformed weekday list cannot spin. */
const MAX_CALENDAR_DAYS = 400;

/**
 * How many spent CALENDAR occurrences one catch-up pass will walk past.
 *
 * Only the calendar walk is bounded by it: the other three kinds settle in
 * closed form (`dueOccurrence`), so no amount of downtime makes them iterate.
 * Five thousand is a thousand days of a five-a-day rule — far past any outage
 * this board will survive, which is what lets the cap be a guard against a
 * pathological rule rather than a policy about downtime.
 */
export const MAX_CATCHUP_STEPS = 5_000;

// ── Occurrence arithmetic ─────────────────────────────────────────────────

/** What the runner knows about the rule's last instance that the rule itself
 *  cannot hold: whether it has finished, and when. Read by
 *  `after-completion` and by nothing else. */
export interface ScheduleCursor {
  /** When the instance created by the last occurrence reached done. Absent
   *  means "no instance, or it is still open". */
  lastCompletedAt?: number;
}

function timezoneOf(schedule: TaskSchedule): string {
  return schedule.timezone ?? DEFAULT_SCHEDULE_TIMEZONE;
}

/** The instant every occurrence must be strictly later than: the newest one
 *  already fired, or the arming if none has. */
function floorFor(schedule: TaskSchedule): number {
  return schedule.state?.lastOccurrenceAt ?? schedule.armedAt;
}

function sortedTimes(times: readonly TimeOfDay[]): TimeOfDay[] {
  return [...times].sort((a, b) => a.hour - b.hour || a.minute - b.minute);
}

/** The first calendar occurrence strictly after `after`. */
function nextCalendarAfter(
  rule: ScheduleCalendar,
  timeZone: string,
  after: number,
): number | undefined {
  const times = sortedTimes(rule.times);
  if (times.length === 0) return undefined;
  const allowed = rule.weekdays;
  if (allowed !== undefined && allowed.length === 0) return undefined;
  // Start from the local DATE of `after` — an occurrence later the same day
  // is the commonest answer, and starting from the next day would skip it.
  const start = zonedParts(after, timeZone);
  for (let dayOffset = 0; dayOffset < MAX_CALENDAR_DAYS; dayOffset++) {
    // Walk the date in UTC and read the weekday off it. Safe because a
    // calendar date has no offset of its own: adding a day to a date is
    // exact, and only the TIME on that date needs the zone.
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day));
    date.setUTCDate(date.getUTCDate() + dayOffset);
    if (allowed !== undefined && !allowed.includes(date.getUTCDay() as Weekday)) continue;
    for (const time of times) {
      const at = instantForLocal(
        timeZone,
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        time.hour,
        time.minute,
      );
      if (at > after) return at;
    }
  }
  return undefined;
}

/**
 * The next instant this rule is owed, or `undefined` when it is owed nothing
 * more — a spent one-off, an after-completion rule whose instance is still
 * open, or a rule past its `until`.
 *
 * Pure: the same schedule and cursor always give the same answer, whatever
 * the wall clock says. The runner compares the answer against its injected
 * `now`; this function never asks what time it is.
 */
export function nextOccurrence(
  schedule: TaskSchedule,
  cursor: ScheduleCursor = {},
): number | undefined {
  const rule = schedule.rule;
  const after = floorFor(schedule);
  let next: number | undefined;
  switch (rule.kind) {
    case 'once':
      next = rule.at > after ? rule.at : undefined;
      break;
    case 'every': {
      if (!(rule.everyMs > 0)) return undefined;
      // Anchored to the arming, so the cadence does not drift with whenever a
      // tick happened to notice a fire was owed.
      const elapsed = after - schedule.armedAt;
      const steps = Math.floor(elapsed / rule.everyMs) + 1;
      next = schedule.armedAt + steps * rule.everyMs;
      break;
    }
    case 'calendar':
      next = nextCalendarAfter(rule, timezoneOf(schedule), after);
      break;
    case 'after-completion': {
      // Never fired: the first run is owed one delay after the arming, which
      // is the only reading that does not require an instance to exist.
      if (schedule.state?.lastOccurrenceAt === undefined) {
        next = schedule.armedAt + rule.delayMs;
        break;
      }
      // Fired, and the instance has not finished: owed nothing. THE defining
      // property of the mode — the next run is computed from a completion
      // that has not happened.
      if (cursor.lastCompletedAt === undefined) return undefined;
      next = cursor.lastCompletedAt + rule.delayMs;
      // A completion older than the occurrence it belongs to would otherwise
      // hand back an instant already spent, and the runner would fire on it
      // every tick forever.
      if (next <= after) next = after + rule.delayMs;
      break;
    }
  }
  if (next === undefined) return undefined;
  if (schedule.until !== undefined && next >= schedule.until) return undefined;
  return next;
}

/** One catch-up's worth of due work: the LATEST occurrence that has come due,
 *  and how many earlier ones it stands in for. */
export interface DueOccurrence {
  /** The occurrence the instance is created for. */
  at: number;
  /** Occurrences collapsed INTO this one — 0 in the ordinary case. The plan's
   *  "a catch-up after downtime creates one run row, not one per missed
   *  slot"; the per-rule choice about that is a separate row, and this is the
   *  count it will act on. */
  missed: number;
}

/**
 * What this rule is owed at `now`, collapsed into at most one occurrence.
 *
 * The collapse is the decided behaviour, not an optimisation: a rule that was
 * owed forty daily runs while the box was down must produce one row somebody
 * can act on, not forty. The answer names the LATEST occurrence that came
 * due, so the cursor the runner writes from it is past all forty and the
 * fortieth is not fired again tomorrow.
 *
 * Pure, like everything else here — the runner passes `now` in.
 */
export function dueOccurrence(
  schedule: TaskSchedule,
  now: number,
  cursor: ScheduleCursor = {},
): DueOccurrence | undefined {
  const first = nextOccurrence(schedule, cursor);
  if (first === undefined || first > now) return undefined;
  const rule = schedule.rule;

  // AFTER COMPLETION IS NEVER CAUGHT UP, and it is the one mode where walking
  // is not merely wasteful but WRONG. The next occurrence is computed from a
  // completion, and the instance this fire is about to create has not reached
  // one — so there is nothing behind `first` to stand in for. A walk re-reads
  // the SAME `lastCompletedAt` after every step and manufactures an occurrence
  // per delay out of one finished run, handing back an instant hours past the
  // one the rule was actually owed.
  if (rule.kind === 'after-completion') return { at: first, missed: 0 };

  // An interval rule is arithmetic, so the catch-up is arithmetic too: a
  // one-minute rule down for a weekend is 2,880 occurrences, and a bounded
  // walk that stopped short would hand back an instant still in the past and
  // fire AGAIN on the next tick — one instance per cap rather than the one
  // instance the design promises. Computed in closed form instead, so the
  // collapse holds however long the box was down.
  if (rule.kind === 'every') {
    // The largest k with `first + k * everyMs <= now`, then clipped to the
    // largest that `until` still admits (`nextOccurrence` refuses an
    // occurrence at or after it, so the last legal one is strictly earlier).
    let steps = Math.floor((now - first) / rule.everyMs);
    if (schedule.until !== undefined) {
      const admitted = Math.ceil((schedule.until - first) / rule.everyMs) - 1;
      if (admitted < steps) steps = admitted;
    }
    return { at: first + steps * rule.everyMs, missed: steps };
  }

  // Calendar rules are day-grained, so the walk is cheap and bounded well
  // past any downtime worth modelling: `MAX_CATCHUP_STEPS` is a thousand days
  // of a five-a-day rule.
  let walked: TaskSchedule = { ...schedule, state: { ...schedule.state, lastOccurrenceAt: first } };
  let latest = first;
  let seen = 1;
  for (let step = 0; step < MAX_CATCHUP_STEPS; step++) {
    const next = nextOccurrence(walked, cursor);
    if (next === undefined || next > now) break;
    latest = next;
    seen++;
    walked = { ...walked, state: { ...walked.state, lastOccurrenceAt: next } };
  }
  return { at: latest, missed: seen - 1 };
}

// ── Validation ────────────────────────────────────────────────────────────

export type ScheduleParse =
  | { ok: true; rule: ScheduleRule; timezone?: string; until?: number }
  | { ok: false; error: string };

function parseTimes(raw: unknown): TimeOfDay[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: TimeOfDay[] = [];
  for (const entry of raw) {
    const hour = (entry as TimeOfDay | undefined)?.hour;
    const minute = (entry as TimeOfDay | undefined)?.minute;
    if (!Number.isInteger(hour) || (hour as number) < 0 || (hour as number) > 23) return undefined;
    if (!Number.isInteger(minute) || (minute as number) < 0 || (minute as number) > 59) {
      return undefined;
    }
    out.push({ hour: hour as number, minute: minute as number });
  }
  return out;
}

function parseWeekdays(raw: unknown): { ok: true; weekdays?: Weekday[] } | { ok: false } {
  if (raw === undefined) return { ok: true };
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false };
  for (const day of raw) {
    if (!Number.isInteger(day) || (day as number) < 0 || (day as number) > 6) return { ok: false };
  }
  return { ok: true, weekdays: [...new Set(raw as Weekday[])].sort() };
}

/**
 * Read a caller's JSON into a rule, or say why not. The one door: the REST
 * route, and every later door (the MCP verb, the phrase editor's writer), get
 * their validation from here so a rule that reaches disk always computes.
 */
export function parseSchedule(raw: unknown): ScheduleParse {
  const body = raw as { rule?: unknown; timezone?: unknown; until?: unknown } | null | undefined;
  const input = body?.rule as Record<string, unknown> | undefined;
  const kind = input?.kind;
  if (typeof kind !== 'string' || !(SCHEDULE_RULE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `rule.kind must be one of ${SCHEDULE_RULE_KINDS.join(' | ')}` };
  }
  let timezone: string | undefined;
  if (body?.timezone !== undefined) {
    if (typeof body.timezone !== 'string' || !isKnownTimezone(body.timezone)) {
      return { ok: false, error: 'timezone must be a known IANA zone' };
    }
    timezone = body.timezone;
  }
  let until: number | undefined;
  if (body?.until !== undefined) {
    if (typeof body.until !== 'number' || !Number.isFinite(body.until)) {
      return { ok: false, error: 'until must be an epoch-ms number' };
    }
    until = body.until;
  }
  const tail = {
    ...(timezone !== undefined ? { timezone } : {}),
    ...(until !== undefined ? { until } : {}),
  };
  switch (kind) {
    case 'once': {
      const at = input?.at;
      if (typeof at !== 'number' || !Number.isFinite(at)) {
        return { ok: false, error: 'once needs at (epoch ms)' };
      }
      return { ok: true, rule: { kind: 'once', at }, ...tail };
    }
    case 'every': {
      const everyMs = input?.everyMs;
      if (typeof everyMs !== 'number' || !Number.isFinite(everyMs) || everyMs <= 0) {
        return { ok: false, error: 'every needs a positive everyMs' };
      }
      return { ok: true, rule: { kind: 'every', everyMs }, ...tail };
    }
    case 'calendar': {
      const times = parseTimes(input?.times);
      if (!times) return { ok: false, error: 'calendar needs times: [{hour: 0-23, minute: 0-59}]' };
      const weekdays = parseWeekdays(input?.weekdays);
      if (!weekdays.ok) return { ok: false, error: 'weekdays must be a non-empty array of 0-6' };
      return {
        ok: true,
        rule: {
          kind: 'calendar',
          times,
          ...(weekdays.weekdays !== undefined ? { weekdays: weekdays.weekdays } : {}),
        },
        ...tail,
      };
    }
    default: {
      const delayMs = input?.delayMs;
      if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs <= 0) {
        return { ok: false, error: 'after-completion needs a positive delayMs' };
      }
      return { ok: true, rule: { kind: 'after-completion', delayMs }, ...tail };
    }
  }
}
