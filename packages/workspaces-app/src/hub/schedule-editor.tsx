/**
 * The task panel's SCHEDULE section: a phrase you type, and the same rule as
 * chips you can click.
 *
 * Bryan approved the mock with one condition — *"the phrase and the chips are
 * two views of ONE rule"* — so neither view is the source. The rule is. The
 * phrase is parsed into it (`parseSchedulePhrase`) and written back out of it
 * (`writeSchedulePhrase`), and every chip edits the RULE and then rewrites the
 * phrase from it. That is why a chip can never say something the sentence
 * above it does not, and why typing a new sentence redraws the chips.
 *
 * No captions, no helper text, no explanation of what a phrase may contain
 * (owner's standing rule). What the editor accepts is shown by the example
 * chips, which are the four phrases the ticket names — tap one and watch the
 * chips derive.
 *
 * ── What is editable, and what only reads ──────────────────────────────
 *
 * The times, the weekdays, the cadence word, the end and the mode are chips
 * you click. An interval ("every 20 minutes") and a delay ("3 days after it's
 * done") are numbers, and a number is faster to type than to click — those
 * chips read, and the phrase is where they change. Nothing is disabled and
 * nothing is captioned to say so: an editable chip is a button, a reading
 * chip is not.
 *
 * The timezone reads too. It is the READER's own zone (`Intl`), it is what
 * every clock time in the phrase means, and there is no rule on this board
 * that would set a different one — so it is shown and not offered.
 */
import {
  SCHEDULE_PHRASE_EXAMPLES,
  type SchedulePhrase,
  type ScheduleRule,
  type TimeOfDay,
  WEEKDAYS_MON_FRI,
  WEEKDAY_SHORT,
  WEEKEND_DAYS,
  type Weekday,
  asAfterCompletion,
  asOnSchedule,
  cadenceWords,
  formatInterval,
  formatTimeOfDay,
  formatUntil,
  instantForLocal,
  nextOccurrence,
  parseSchedulePhrase,
  scheduleModeOf,
  sortedUniqueTimes,
  writeSchedulePhrase,
  zonedParts,
} from '@feedback/core';
import type { VNode } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { HubTask, ScheduleWrite } from './hub-board-model.ts';

export interface ScheduleEditorProps {
  task: HubTask;
  /** Epoch ms this paint is reading against — passed like every other clock in
   *  the panel, so a test moves it instead of waiting. */
  now: number;
  /** The zone the phrase's clock times mean. Defaults to the reader's own. */
  timezone?: string;
  onSet: (next: ScheduleWrite) => Promise<boolean>;
}

function readerTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The rule as the phrase would spell it, so state and input never diverge. */
function phraseOf(phrase: SchedulePhrase, now: number, timezone: string): string {
  return writeSchedulePhrase(phrase, { now, timezone });
}

function scheduleOf(task: HubTask): SchedulePhrase | undefined {
  const s = task.schedule;
  if (s === undefined) return undefined;
  return { rule: s.rule, ...(s.until !== undefined ? { until: s.until } : {}) };
}

/** The next instant this rule is owed, worded for the reader. */
function nextLine(phrase: SchedulePhrase, now: number, timezone: string): string {
  const at = nextOccurrence({
    rule: phrase.rule,
    timezone,
    armedAt: now,
    ...(phrase.until !== undefined ? { until: phrase.until } : {}),
  });
  if (at === undefined) {
    // An after-completion rule whose instance is open is owed nothing until
    // that instance closes, which is the mode's whole point rather than a
    // missing answer.
    return phrase.rule.kind === 'after-completion' ? 'when this one closes' : 'never';
  }
  const today = zonedParts(now, timezone);
  const then = zonedParts(at, timezone);
  const clock = formatTimeOfDay({ hour: then.hour, minute: then.minute });
  if (today.year === then.year && today.month === then.month && today.day === then.day) {
    return `Today ${clock}`;
  }
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(at));
  return `${day}, ${clock}`;
}

/** The end chip's `<input type="date">` value, in the schedule's own zone. */
function dateInputValue(instant: number, timezone: string): string {
  const p = zonedParts(instant, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** day → weekday → weekend → day. The cadence chip's one gesture: three sets
 *  cover almost every rule, and anything else is a day chip away. */
function cycleCadence(weekdays: readonly Weekday[] | undefined): Weekday[] | undefined {
  const same = (a: readonly Weekday[]): boolean =>
    weekdays !== undefined && weekdays.length === a.length && a.every((d) => weekdays.includes(d));
  if (weekdays === undefined || weekdays.length === 0 || weekdays.length === 7) {
    return [...WEEKDAYS_MON_FRI];
  }
  if (same(WEEKDAYS_MON_FRI)) return [...WEEKEND_DAYS];
  if (same(WEEKEND_DAYS)) return undefined;
  return [...WEEKDAYS_MON_FRI];
}

export function ScheduleEditor({ task, now, timezone, onSet }: ScheduleEditorProps) {
  const tz = timezone ?? readerTimezone();
  const stored = scheduleOf(task);
  const [open, setOpen] = useState(stored !== undefined);
  const [phrase, setPhrase] = useState<SchedulePhrase | undefined>(stored);
  const [text, setText] = useState(stored === undefined ? '' : phraseOf(stored, now, tz));
  const [bad, setBad] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  // What the reader flipped AWAY from, so flipping the mode back restores the
  // rule they had rather than the interval it would otherwise derive.
  const priorOnSchedule = useRef<ScheduleRule | undefined>(undefined);

  // Follow the projection while the reader is not editing: another session, or
  // an agent, can arm this row. A reset while they are mid-sentence would
  // delete what they are typing, so `dirty` holds the panel still.
  const syncedFrom = useRef(JSON.stringify(stored ?? null));
  const incoming = JSON.stringify(stored ?? null);
  useLayoutEffect(() => {
    if (incoming === syncedFrom.current || dirty) return;
    syncedFrom.current = incoming;
    setPhrase(stored);
    setText(stored === undefined ? '' : phraseOf(stored, now, tz));
    setBad(false);
    setOpen(stored !== undefined);
  }, [incoming, dirty, stored, now, tz]);

  /** One rule edit: the rule changes, and the sentence is rewritten from it. */
  const apply = (rule: ScheduleRule, until?: number): void => {
    const next: SchedulePhrase = { rule, ...(until !== undefined ? { until } : {}) };
    setPhrase(next);
    setText(phraseOf(next, now, tz));
    setBad(false);
    setDirty(true);
  };

  const onType = (value: string): void => {
    setText(value);
    setDirty(true);
    const read = parseSchedulePhrase(value, { now, timezone: tz });
    if (read.ok) {
      setPhrase(read.phrase);
      setBad(false);
      return;
    }
    // The last good chips stay put. A phrase mid-typing is unreadable most of
    // the way through, and clearing the readback on every keystroke would
    // make the section flash rather than inform.
    setBad(value.trim() !== '');
  };

  const save = async (): Promise<void> => {
    if (phrase === undefined) return;
    setBusy(true);
    const ok = await onSet({
      rule: phrase.rule,
      timezone: tz,
      ...(phrase.until !== undefined ? { until: phrase.until } : {}),
    });
    setBusy(false);
    if (ok === false) return;
    setDirty(false);
    syncedFrom.current = JSON.stringify(phrase);
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    await onSet(null);
    setBusy(false);
    setPhrase(undefined);
    setText('');
    setBad(false);
    setDirty(false);
    setOpen(false);
  };

  if (!open) {
    return (
      <div class="hub-sched">
        <button
          type="button"
          class="hub-btn hub-sched-arm"
          onClick={() => {
            setOpen(true);
            setDirty(true);
          }}
        >
          Schedule…
        </button>
      </div>
    );
  }

  return (
    <div class="hub-sched">
      <label class={`hub-sched-nl${bad ? ' is-bad' : ''}`}>
        <span class="hub-sched-nl-mark" aria-hidden="true">
          ⏱
        </span>
        <input
          class="hub-sched-input"
          value={text}
          spellcheck={false}
          autocomplete="off"
          placeholder="every weekday at 9am"
          aria-label="When should this run"
          aria-invalid={bad ? 'true' : 'false'}
          onInput={(e) => onType((e.currentTarget as HTMLInputElement).value)}
        />
      </label>

      <div class="hub-sched-tries">
        {SCHEDULE_PHRASE_EXAMPLES.map((example) => (
          <button key={example} type="button" class="hub-sched-try" onClick={() => onType(example)}>
            {example}
          </button>
        ))}
      </div>

      {phrase !== undefined && (
        <ScheduleChips phrase={phrase} now={now} timezone={tz} apply={apply} />
      )}

      {phrase !== undefined && (
        <div class="hub-sched-foot">
          <fieldset class="hub-sched-mode" aria-label="Next run is computed from">
            <button
              type="button"
              class="hub-sched-mode-btn"
              aria-pressed={scheduleModeOf(phrase.rule) === 'on-schedule' ? 'true' : 'false'}
              onClick={() => {
                if (scheduleModeOf(phrase.rule) === 'on-schedule') return;
                apply(priorOnSchedule.current ?? asOnSchedule(phrase.rule), phrase.until);
              }}
            >
              On schedule
            </button>
            <button
              type="button"
              class="hub-sched-mode-btn"
              aria-pressed={scheduleModeOf(phrase.rule) === 'after-completion' ? 'true' : 'false'}
              onClick={() => {
                if (scheduleModeOf(phrase.rule) === 'after-completion') return;
                priorOnSchedule.current = phrase.rule;
                apply(asAfterCompletion(phrase.rule), phrase.until);
              }}
            >
              After completion
            </button>
          </fieldset>
          <p class="hub-sched-next">
            <span class="hub-sched-next-k">Next</span>
            <span class="hub-sched-next-v">{nextLine(phrase, now, tz)}</span>
          </p>
        </div>
      )}

      <div class="hub-sched-actions">
        <button
          type="button"
          class="hub-btn hub-btn-ghost"
          disabled={busy}
          onClick={() => {
            if (stored === undefined) {
              setOpen(false);
              setText('');
              setPhrase(undefined);
              setDirty(false);
              return;
            }
            void clear();
          }}
        >
          {stored === undefined ? 'Cancel' : 'Remove'}
        </button>
        <button
          type="button"
          class="hub-btn hub-btn-primary hub-sched-save"
          disabled={busy || phrase === undefined}
          onClick={() => void save()}
        >
          {stored === undefined ? 'Schedule' : 'Update'}
        </button>
      </div>
    </div>
  );
}

/** The readback. Every chip here either edits the rule or states a fact the
 *  phrase already states — and the words come from the writer's own
 *  vocabulary, so a chip cannot spell a cadence differently from the
 *  sentence. */
function ScheduleChips(props: {
  phrase: SchedulePhrase;
  now: number;
  timezone: string;
  apply: (rule: ScheduleRule, until?: number) => void;
}) {
  const { phrase, now, timezone, apply } = props;
  const rule = phrase.rule;
  const chips: VNode[] = [];

  if (rule.kind === 'once') {
    const p = zonedParts(rule.at, timezone);
    chips.push(
      <span class="hub-sched-chip is-read" key="date">
        {new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          month: 'short',
          day: 'numeric',
        }).format(new Date(rule.at))}
      </span>,
      <span class="hub-sched-chip is-read" key="time">
        {formatTimeOfDay({ hour: p.hour, minute: p.minute })}
      </span>,
    );
  } else if (rule.kind === 'every') {
    chips.push(
      <span class="hub-sched-chip is-read" key="interval">
        {`Every ${formatInterval(rule.everyMs, { allowDays: false, bareSingular: true })}`}
      </span>,
    );
  } else if (rule.kind === 'after-completion') {
    chips.push(
      <span class="hub-sched-chip is-read" key="delay">
        {`${formatInterval(rule.delayMs, { allowDays: true, bareSingular: false })} after`}
      </span>,
    );
  } else {
    const words = cadenceWords(rule);
    chips.push(
      <button
        type="button"
        class="hub-sched-chip"
        key="cadence"
        aria-label={`Repeats every ${words} — change`}
        onClick={() => {
          const next = cycleCadence(rule.weekdays);
          apply(
            {
              kind: 'calendar',
              times: rule.times,
              ...(next !== undefined ? { weekdays: next } : {}),
            },
            phrase.until,
          );
        }}
      >
        {`Every ${words}`}
      </button>,
    );
    const times = sortedUniqueTimes(rule.times);
    times.forEach((time, i) => {
      chips.push(
        <span class="hub-sched-chip hub-sched-time" key={`t${time.hour}:${time.minute}`}>
          {formatTimeOfDay(time)}
          {times.length > 1 && (
            <button
              type="button"
              class="hub-sched-x"
              aria-label={`Remove ${formatTimeOfDay(time)}`}
              onClick={() =>
                apply({ ...rule, times: times.filter((_, j) => j !== i) }, phrase.until)
              }
            >
              ×
            </button>
          )}
        </span>,
      );
    });
    chips.push(
      <button
        type="button"
        class="hub-sched-chip hub-sched-add"
        key="add"
        aria-label="Add a time"
        onClick={() => {
          const last = times[times.length - 1] ?? { hour: 9, minute: 0 };
          const next: TimeOfDay = { hour: Math.min(23, last.hour + 3), minute: 0 };
          apply({ ...rule, times: [...times, next] }, phrase.until);
        }}
      >
        +
      </button>,
    );
    const on = rule.weekdays;
    chips.push(
      <span class="hub-sched-chip hub-sched-days" key="days">
        {WEEKDAY_SHORT.map((letter, day) => {
          const lit = on === undefined || on.includes(day as Weekday);
          return (
            <button
              type="button"
              key={DAY_NAMES[day]}
              class={`hub-sched-day${lit ? ' is-on' : ''}`}
              aria-pressed={lit ? 'true' : 'false'}
              aria-label={DAY_NAMES[day]}
              onClick={() => {
                const current: Weekday[] = on === undefined ? [0, 1, 2, 3, 4, 5, 6] : [...on];
                const at = current.indexOf(day as Weekday);
                if (at >= 0) {
                  // Never all seven off: a rule that admits no day is owed
                  // nothing forever, which is a schedule that silently is not
                  // one.
                  if (current.length === 1) return;
                  current.splice(at, 1);
                } else {
                  current.push(day as Weekday);
                }
                current.sort((a, b) => a - b);
                apply({ kind: 'calendar', times: rule.times, weekdays: current }, phrase.until);
              }}
            >
              {letter}
            </button>
          );
        })}
      </span>,
    );
  }

  if (rule.kind !== 'once') {
    chips.push(
      <label class="hub-sched-chip hub-sched-end" key="end">
        <span>
          {phrase.until === undefined
            ? 'No end'
            : `Until ${formatUntil(phrase.until, { now, timezone })}`}
        </span>
        <input
          type="date"
          class="hub-sched-end-input"
          aria-label="Stop repeating after"
          value={phrase.until === undefined ? '' : dateInputValue(phrase.until, timezone)}
          onChange={(e) => {
            const v = (e.currentTarget as HTMLInputElement).value;
            if (v === '') {
              apply(rule, undefined);
              return;
            }
            const [y, m, d] = v.split('-').map(Number);
            if (!y || !m || !d) return;
            // Local midnight, not UTC midnight — the same conversion trap the
            // Due field documents, solved by the module that owns the zone.
            apply(rule, instantForLocal(timezone, y, m, d, 0, 0));
          }}
        />
      </label>,
    );
  }

  chips.push(
    <span class="hub-sched-chip hub-sched-tz is-read" key="tz">
      {timezone.split('/').pop()?.replace(/_/g, ' ') ?? timezone}
    </span>,
  );

  return <div class="hub-sched-chips">{chips}</div>;
}

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
