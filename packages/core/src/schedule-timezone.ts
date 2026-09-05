/**
 * What a wall clock reads, and which instant a wall-clock reading names.
 *
 * The timezone half of the scheduled-task arithmetic
 * (docs/architecture/scheduled-tasks.md), split out of `task-schedule.ts`
 * because it answers a different question from every other function there:
 * that file decides WHICH occurrence a rule is owed, and this one only
 * converts between an instant and a local calendar reading. Nothing here
 * knows what a rule is.
 *
 * Built on `Intl` rather than on a dependency, because it is the only
 * timezone database in the runtime. Two operations are needed and neither is
 * provided directly, which is what the two exported functions are.
 */
/** UTC when a rule names no zone — see `TaskSchedule.timezone`. It lives here
 *  rather than beside the field because it is a claim about how the CONVERSION
 *  behaves with nothing to convert against, and a second default declared
 *  next to a second caller is how two answers to one question start. */
export const DEFAULT_SCHEDULE_TIMEZONE = 'UTC';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(timeZone, made);
  return made;
}

/** Is this a zone the runtime's Intl knows? The one validator — a rule
 *  carrying a zone nothing can resolve would compute occurrences in UTC while
 *  claiming otherwise, which is the silent-wrong-answer failure. */
export function isKnownTimezone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** What the wall clock in `timeZone` reads at `instant`. */
export function zonedParts(instant: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const read = (type: string): number => {
    const found = parts.find((p) => p.type === type)?.value ?? '0';
    return Number.parseInt(found, 10);
  };
  // `hour12: false` still spells midnight as 24 in some ICU versions, which
  // would push a midnight rule onto the wrong day.
  const hour = read('hour');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
    second: read('second'),
  };
}

/** The zone's offset from UTC at `instant`, in ms (east of UTC is positive). */
function offsetMsAt(instant: number, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `timeZone` reads this local time.
 *
 * Two passes, which is the standard fix for the fact that the offset depends
 * on the answer: guess with the offset at the naive instant, then re-read the
 * offset AT the guess and re-derive. Wrong only across a transition, and both
 * of those cases are defined rather than accidental:
 *
 *  - **Spring forward**, where the local time does not exist: the result is
 *    the instant one offset-step later, so a 2:30am rule fires at 3:30am that
 *    day and once, rather than being skipped.
 *  - **Fall back**, where the local time happens twice: the EARLIER of the
 *    two, so the rule fires once and at the first reading.
 *
 * Firing exactly once on a transition day is the property that matters here;
 * which side of an ambiguous hour it lands on is not something any rule in
 * this design can express a preference about.
 */
export function instantForLocal(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstPass = naive - offsetMsAt(naive, timeZone);
  return naive - offsetMsAt(firstPass, timeZone);
}
