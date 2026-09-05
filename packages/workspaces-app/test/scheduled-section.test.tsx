import type { TaskSchedule } from '@feedback/core/task-schedule';
/**
 * The Scheduled section, and the mark on a live instance.
 *
 * Two rows exist for one recurring thing and the board has to keep them
 * apart: the RULE, which is not the work and sits in its own section, and the
 * INSTANCE the scheduler creates at each occurrence, which is ordinary work
 * and sits in its goal band. Everything below is a property of that split —
 * where each row lands, what each row says, and what happens when one of them
 * is not there to be found.
 *
 * The clock is pinned on every case. `scheduleChips` takes `now` and the
 * island passes `Date.now()`, so a test that let the real clock through would
 * read "Today" in one hour of the day and a date in the next.
 *
 * Fixtures are synthetic — invented names throughout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BoardFilters,
  type BoardGoal,
  type BoardTask,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  SCHEDULED_ID,
  SCHEDULED_TITLE,
  boardSections,
  dropTarget,
  formatNextOccurrence,
  scheduleChips,
  scheduleCursorFor,
  scheduleRules,
  stepTarget,
} from '../src/board/board-model.ts';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';
import { type ShimHandlers, disposeBoards, renderBoard } from './support/board.ts';

/** Tue 14 Nov 2023, 22:13:20 UTC. Rules below are written in UTC, which is
 *  what a schedule with no `timezone` means. */
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const GOALS: BoardGoal[] = [
  { id: 'g-ship', title: 'The release goes out' },
  { id: 'g-quiet', title: 'The board runs itself' },
];

const filters: BoardFilters = {
  tab: 'all',
  userName: 'Wren',
  doneWindow: DEFAULT_DONE_WINDOW,
  now: NOW,
};

let seq = 0;
function task(over: Partial<BoardTask> = {}): BoardTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'todo',
    assignee: 'agent',
    goal: 'g-ship',
    order: seq,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${seq}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

/** Every weekday at 9am, armed just now, in UTC. */
function weekdays9(over: Partial<TaskSchedule> = {}): TaskSchedule {
  return {
    rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }], weekdays: [1, 2, 3, 4, 5] },
    armedAt: NOW,
    ...over,
  };
}

function sectionIds(tasks: BoardTask[]): string[] {
  return boardSections(GOALS, tasks, filters).map((s) => s.id);
}

function sectionOf(tasks: BoardTask[], taskId: string): string | undefined {
  return boardSections(GOALS, tasks, filters).find((s) => s.tasks.some((t) => t.id === taskId))?.id;
}

describe('where a scheduled row lands', () => {
  it('takes a rule row out of its goal band and into Scheduled', () => {
    const rule = task({ title: 'Post the evening digest', schedule: weekdays9() });
    expect(sectionOf([rule], rule.id)).toBe(SCHEDULED_ID);
    // The control: the identical row with no rule stays in the band it names,
    // so the move above is the schedule and not the title or the goal.
    expect(sectionOf([task({ ...rule, schedule: undefined })], rule.id)).toBe('g-ship');
  });

  it('sits directly above Backlog, after every goal band', () => {
    const rule = task({ title: 'Post the evening digest', schedule: weekdays9() });
    expect(sectionIds([rule])).toEqual(['g-ship', 'g-quiet', SCHEDULED_ID, CHORES_ID]);
  });

  it('is not there at all when nothing is scheduled', () => {
    expect(sectionIds([task(), task({ goal: CHORES_ID })])).toEqual([
      'g-ship',
      'g-quiet',
      CHORES_ID,
    ]);
    // Positive control: one scheduled row and the section appears, so the
    // absence above is the emptiness and not a section that never renders.
    expect(sectionIds([task({ schedule: weekdays9() })])).toContain(SCHEDULED_ID);
  });

  it('leaves the LIVE INSTANCE in its own goal band', () => {
    const rule = task({ title: 'Post the evening digest', schedule: weekdays9() });
    const run = task({
      title: 'Post the evening digest',
      goal: 'g-quiet',
      recurrenceOf: { taskId: rule.id, occurrenceAt: NOW + HOUR },
    });
    expect(sectionOf([rule, run], run.id)).toBe('g-quiet');
    expect(sectionOf([rule, run], rule.id)).toBe(SCHEDULED_ID);
  });

  it('keeps an archived or filtered rule row off the board like any other row', () => {
    const rule = task({ title: 'Post the evening digest', schedule: weekdays9() });
    expect(sectionIds([{ ...rule, archivedAt: NOW }])).not.toContain(SCHEDULED_ID);
    // Positive control: unarchived, the same row does open the section.
    expect(sectionIds([rule])).toContain(SCHEDULED_ID);
  });

  it('indexes the rules by id, for the mark that has to find one', () => {
    const rule = task({ schedule: weekdays9() });
    const plain = task();
    const rules = scheduleRules([rule, plain]);
    expect([...rules.keys()]).toEqual([rule.id]);
  });
});

describe('the Scheduled section is not a band', () => {
  const rule = task({ title: 'Post the evening digest', schedule: weekdays9() });
  const inBand = task({ title: 'Cut the release', goal: 'g-ship' });
  const sections = () => boardSections(GOALS, [rule, inBand], filters);

  it('refuses a drop into it — its id is not a goal id', () => {
    expect(dropTarget(sections(), inBand.id, SCHEDULED_ID, 0)).toBeNull();
    // Positive control: the same row, the same call, into a real band.
    expect(dropTarget(sections(), inBand.id, 'g-quiet', 0)).toEqual({
      goal: 'g-quiet',
      after: null,
    });
  });

  it('refuses to drag a rule row OUT — where a rule sits is decided by the rule', () => {
    expect(dropTarget(sections(), rule.id, 'g-quiet', 0)).toBeNull();
    expect(stepTarget(sections(), rule.id, -1)).toBeNull();
    expect(stepTarget(sections(), rule.id, 1)).toBeNull();
  });

  it('steps the keyboard PAST it, so the boundary key is not dead', () => {
    // Down off the last goal band would land in Scheduled, which is refused
    // — so the step has to reach Backlog instead of reporting nothing.
    const target = stepTarget(sections(), inBand.id, 1);
    expect(target).toEqual({ goal: 'g-quiet', after: null });
    const last = task({ title: 'Rename the huddle', goal: 'g-quiet' });
    const withLast = boardSections(GOALS, [rule, inBand, last], filters);
    expect(stepTarget(withLast, last.id, 1)).toEqual({ goal: CHORES_ID, after: null });
  });
});

describe('what a scheduled row says', () => {
  it('names the next occurrence and the rule', () => {
    const chips = scheduleChips(task({ schedule: weekdays9() }), NOW);
    // NOW is a Tuesday evening, so the next weekday 9am is Wednesday's.
    expect(chips?.next).toBe('Wed 15 Nov, 9am');
    expect(chips?.rule).toEqual(['Every weekday', '9am']);
    expect(chips?.soon).toBe(false);
  });

  it('says Today, and marks it, when the next run is today on the rule’s own clock', () => {
    const tonight: TaskSchedule = {
      rule: { kind: 'calendar', times: [{ hour: 23, minute: 30 }] },
      armedAt: NOW,
    };
    const chips = scheduleChips(task({ schedule: tonight }), NOW);
    expect(chips?.next).toBe('Today 11:30pm');
    expect(chips?.soon).toBe(true);
  });

  it('reads the rule’s timezone, not the reader’s', () => {
    // 9am in Los Angeles is 17:00 UTC — a different DAY-relative answer than
    // the same rule read as UTC, which is the whole point of the field.
    const la: TaskSchedule = {
      rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }] },
      timezone: 'America/Los_Angeles',
      armedAt: NOW,
    };
    expect(scheduleChips(task({ schedule: la }), NOW)?.next).toBe('Wed 15 Nov, 9am');
    // The control: the same wall-clock rule with no zone is UTC, and NOW is
    // already past 9am UTC on the 14th, so both land on the 15th — read the
    // INSTANTS apart instead. LA's 9am is eight hours later.
    expect(formatNextOccurrence(Date.UTC(2023, 10, 15, 17, 0), NOW, 'America/Los_Angeles')).toBe(
      'Wed 15 Nov, 9am',
    );
    expect(formatNextOccurrence(Date.UTC(2023, 10, 15, 17, 0), NOW)).toBe('Wed 15 Nov, 5pm');
  });

  it('gives a one-off its instant and no rule chip', () => {
    const once: TaskSchedule = { rule: { kind: 'once', at: NOW + 2 * DAY }, armedAt: NOW };
    const chips = scheduleChips(task({ schedule: once }), NOW);
    expect(chips?.rule).toEqual([]);
    expect(chips?.next).toBe('Thu 16 Nov, 10:13pm');
  });

  it('says nothing about a next run when the rule is owed none', () => {
    // A spent one-off: fired, so `nextOccurrence` hands back nothing.
    const spent: TaskSchedule = {
      rule: { kind: 'once', at: NOW - DAY },
      armedAt: NOW - 2 * DAY,
      state: { lastOccurrenceAt: NOW - DAY },
    };
    const chips = scheduleChips(task({ schedule: spent }), NOW);
    expect(chips?.next).toBeUndefined();
    expect(chips?.soon).toBe(false);
    // Positive control: the same shape before it fired does print one.
    expect(
      scheduleChips(
        task({ schedule: { rule: { kind: 'once', at: NOW + DAY }, armedAt: NOW } }),
        NOW,
      )?.next,
    ).toBe('Wed 15 Nov, 10:13pm');
  });

  it('is null for an unscheduled row, so the caller asks once', () => {
    expect(scheduleChips(task(), NOW)).toBeNull();
  });

  it('asks the last instance whether it finished, for an after-completion rule', () => {
    const done = task({ status: 'done', updatedAt: NOW - HOUR });
    const rule = task({
      schedule: {
        rule: { kind: 'after-completion', delayMs: DAY },
        armedAt: NOW - 3 * DAY,
        state: { lastOccurrenceAt: NOW - 2 * DAY, lastInstanceId: done.id },
      },
    });
    const byId = new Map<string, BoardTask>([done, rule].map((t) => [t.id, t]));
    expect(scheduleCursorFor(rule, byId)).toEqual({ lastCompletedAt: NOW - HOUR });
    expect(scheduleChips(rule, NOW, scheduleCursorFor(rule, byId))?.next).toBe(
      'Wed 15 Nov, 9:13pm',
    );
    // The instance still OPEN: the rule is owed nothing, and the row says so
    // by saying nothing rather than by guessing a date.
    const reopened: BoardTask = { ...done, status: 'in-progress' };
    const open = new Map<string, BoardTask>([reopened, rule].map((t) => [t.id, t]));
    expect(scheduleCursorFor(rule, open)).toEqual({});
    expect(scheduleChips(rule, NOW, scheduleCursorFor(rule, open))?.next).toBeUndefined();
  });
});

// ── The rows on screen ─────────────────────────────────────────────────────

function handlers(over: Partial<ShimHandlers> = {}): ShimHandlers {
  return {
    onStatusSet: vi.fn(),
    onGoalTitleCommit: vi.fn(),
    onGoalAdd: vi.fn(),
    onOpenTask: vi.fn(),
    onReorder: vi.fn(),
    onTitleCommit: vi.fn(),
    onAssign: vi.fn(),
    inlineTitleEdit: () => true,
    ...over,
  };
}

let root: HTMLElement;
let sheets = () => {};
beforeEach(() => {
  root = document.createElement('div');
  root.className = 'board';
  document.body.replaceChildren(root);
  setViewport(IPAD);
  sheets = installSheets('board.css', 'styles.css');
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
  disposeBoards();
  sheets();
  document.body.replaceChildren();
});

function paint(tasks: BoardTask[], over: Partial<ShimHandlers> = {}): ShimHandlers {
  const h = handlers({
    tasksById: new Map(tasks.map((t) => [t.id, t])),
    ...over,
  });
  renderBoard(root, boardSections(GOALS, tasks, filters), h);
  return h;
}

function rowOf(id: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-task-id="${id}"]`);
  if (!el) throw new Error(`no row for ${id}`);
  return el;
}

function scheduledBand(): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-goal-id="${SCHEDULED_ID}"]`);
  if (!el) throw new Error('no Scheduled section');
  return el;
}

describe('a scheduled row on screen', () => {
  it('renders under a Scheduled header, with the rule and the next run on the right', () => {
    const rule = task({ title: 'Post the evening digest', schedule: weekdays9() });
    paint([rule, task({ title: 'Cut the release' })]);
    expect(scheduledBand().querySelector('.board-goal-title-text')?.textContent).toBe(
      SCHEDULED_TITLE,
    );
    const badges = rowOf(rule.id).querySelector('.board-task-badges');
    expect(badges?.querySelector('.board-badge-rule')?.textContent).toBe('Every weekday·9am');
    expect(badges?.querySelector('.board-next')?.textContent).toBe('Wed 15 Nov, 9am');
    // The row that is not scheduled carries neither — so the two marks above
    // are the schedule and not something every row gets.
    const plain = root.querySelector('[data-goal-id="g-ship"] .board-task-row');
    expect(plain?.querySelector('.board-next')).toBeNull();
    expect(plain?.querySelector('.board-badge-rule')).toBeNull();
  });

  it('says nothing else — no caption, no kind chip, no helper text', () => {
    const rule = task({ title: 'Post the evening digest', schedule: weekdays9() });
    paint([rule]);
    // Everything the section renders, as text: the header and the row.
    const words = scheduledBand().textContent ?? '';
    expect(words).toContain(SCHEDULED_TITLE);
    expect(words).toContain('Post the evening digest');
    expect(words).toContain('Every weekday');
    // Nothing that explains itself. Each of these is a phrase struck by name
    // from the approved mock.
    for (const caption of ['Scheduled task', 'recurring', 'Recurring', 'next run', 'rule']) {
      expect(words).not.toContain(caption);
    }
    expect(scheduledBand().querySelector('.board-section-empty')).toBeNull();
  });

  it('gives the header no rename and no open caret — it is not a goal', () => {
    paint([task({ schedule: weekdays9() })]);
    const header = scheduledBand().querySelector<HTMLElement>('.board-goal-row');
    expect(header?.getAttribute('tabindex')).toBeNull();
    expect(header?.querySelector('.board-owner-avatar')).toBeNull();
    // The caret is emitted for the grid track and hidden by the sheet, so the
    // assertion is the computed value rather than the node's absence.
    const caret = scheduledBand().querySelector<HTMLElement>('.board-goal-open');
    expect(caret).not.toBeNull();
    if (caret) expect(styleOf(caret).visibility).toBe('hidden');
    // The control: a real goal band's caret is visible and its header focusable.
    const goal = root.querySelector<HTMLElement>('[data-goal-id="g-ship"] .board-goal-open');
    if (goal) expect(styleOf(goal).visibility).not.toBe('hidden');
    expect(
      root.querySelector('[data-goal-id="g-ship"] .board-goal-row')?.getAttribute('tabindex'),
    ).toBe('0');
  });

  it('draws no progress strip on it — a rule has no projected finish', () => {
    paint([task({ schedule: weekdays9() })]);
    expect(scheduledBand().querySelector('.board-goal-effort')).toBeNull();
  });
});

describe('the recurrence mark on a live instance', () => {
  function withRun(over: Partial<BoardTask> = {}) {
    const rule = task({ title: 'Post the evening digest', schedule: weekdays9() });
    const run = task({
      title: 'Post the evening digest',
      goal: 'g-quiet',
      recurrenceOf: { taskId: rule.id, occurrenceAt: NOW },
      ...over,
    });
    return { rule, run };
  }

  it('marks the instance in its band and opens the rule when tapped', () => {
    const { rule, run } = withRun();
    const h = paint([rule, run]);
    const mark = rowOf(run.id).querySelector<HTMLElement>('.board-recur');
    expect(mark).not.toBeNull();
    expect(mark?.tagName).toBe('BUTTON');
    expect(mark?.getAttribute('title')).toContain('Post the evening digest');
    mark?.click();
    expect(h.onOpenTask).toHaveBeenCalledWith(rule);
    // The instance is a plain row otherwise: no rule chip, no next run. It is
    // the work, and the rule is the thing that made it.
    expect(rowOf(run.id).querySelector('.board-badge-rule')).toBeNull();
    expect(rowOf(run.id).querySelector('.board-next')).toBeNull();
    // And the rule row carries no mark — it is not a run of itself.
    expect(rowOf(rule.id).querySelector('.board-recur')).toBeNull();
  });

  it('still marks a run whose rule this board cannot see, and links to nothing', () => {
    const { run } = withRun();
    paint([run]);
    const mark = rowOf(run.id).querySelector<HTMLElement>('.board-recur');
    expect(mark).not.toBeNull();
    expect(mark?.tagName).toBe('SPAN');
    expect(mark?.querySelector('svg')).not.toBeNull();
  });

  it('does not open the row it sits on', () => {
    const { rule, run } = withRun();
    const h = paint([rule, run]);
    rowOf(run.id).querySelector<HTMLElement>('.board-recur')?.click();
    expect(h.onOpenTask).toHaveBeenCalledTimes(1);
    expect(h.onOpenTask).toHaveBeenCalledWith(rule);
  });
});

describe('the two viewports this project verifies', () => {
  it('shows both marks on the iPad, muted rule and accented today', () => {
    setViewport(IPAD);
    const later = task({ title: 'Post the release notes', schedule: weekdays9() });
    const soon = task({
      title: 'Post the evening digest',
      schedule: { rule: { kind: 'calendar', times: [{ hour: 23, minute: 30 }] }, armedAt: NOW },
    });
    paint([later, soon]);
    const soonChip = rowOf(soon.id).querySelector<HTMLElement>('.board-next');
    const laterChip = rowOf(later.id).querySelector<HTMLElement>('.board-next');
    const ruleChip = rowOf(later.id).querySelector<HTMLElement>('.board-badge-rule');
    if (!soonChip || !laterChip || !ruleChip) throw new Error('a scheduled row lost a chip');
    expect(styleOf(soonChip).display).not.toBe('none');
    expect(styleOf(ruleChip).display).not.toBe('none');
    // Today is the accent; a run further out is not, and the rule beside it
    // is muted. Read as three colours the reader actually sees, and pinned
    // against each other rather than against a token name.
    expect(soonChip.classList.contains('board-next-soon')).toBe(true);
    expect(laterChip.classList.contains('board-next-soon')).toBe(false);
    const accent = styleOf(soonChip).color;
    const plain = styleOf(laterChip).color;
    const muted = styleOf(ruleChip).color;
    expect(accent).not.toBe(plain);
    expect(muted).not.toBe(plain);
    expect(muted).not.toBe('');
  });

  /**
   * happy-dom lays nothing out, so "did it clip" is asked of the CASCADE
   * rather than of pixels: a chip clips silently exactly when it can be
   * squeezed (`min-width: 0` with a shrink factor) and has no
   * `text-overflow`, or when its container crops it. Both are computed
   * values. The pixel half — a real 430px row with real text in it — is the
   * headless-Chromium pass, and its numbers are in the PR.
   */
  it('never cuts a chip mid-word at 430px, and never eats the state word', () => {
    setViewport(PHONE);
    // A row carrying all three at once, which is the shape that overflowed:
    // a rule, a next run and the state word the band's triage status puts on
    // every row under it.
    const crowded = task({
      title: 'Post the morning and evening digest',
      status: 'triage',
      schedule: {
        rule: {
          kind: 'calendar',
          times: [
            { hour: 9, minute: 0 },
            { hour: 17, minute: 0 },
          ],
        },
        until: NOW + 40 * DAY,
        armedAt: NOW,
      },
    });
    paint([crowded]);
    const row = rowOf(crowded.id);
    const strip = row.querySelector<HTMLElement>('.board-task-badges');
    const ruleChip = row.querySelector<HTMLElement>('.board-badge-rule');
    const next = row.querySelector<HTMLElement>('.board-next');
    const state = row.querySelector<HTMLElement>('.board-state-note');
    if (!strip || !ruleChip || !next || !state) throw new Error('the crowded row lost a chip');
    // The strip wraps rather than hiding, and crops nothing itself. `''` is
    // happy-dom's reading of a property no rule sets, which is the same
    // answer as `visible` here.
    expect(styleOf(strip).flexWrap).toBe('wrap');
    expect(['', 'visible']).toContain(styleOf(strip).overflow);
    // Every chip that CAN be squeezed says so when it is. This is the whole
    // assertion: a shrinkable chip with no ellipsis is the silent cut.
    for (const chip of [ruleChip, next]) {
      expect(Number(styleOf(chip).flexShrink)).toBeGreaterThan(0);
      expect(styleOf(chip).textOverflow).toBe('ellipsis');
    }
    // The state word does not shrink at all, so it cannot lose characters —
    // it collapsed to the single letter "t" when it could.
    expect(styleOf(state).flexShrink).toBe('0');
    expect(state.textContent).toBe('triage');
    // And the cadence gives way long before the time does.
    expect(Number(styleOf(ruleChip).flexShrink)).toBeGreaterThan(Number(styleOf(next).flexShrink));
    // The control: the same three reads at the iPad width, where nothing is
    // under pressure, give the same answers — the guarantee is not a phone
    // rule that a wider window quietly drops.
    setViewport(IPAD);
    expect(styleOf(strip).flexWrap).toBe('wrap');
    expect(styleOf(row.querySelector('.board-badge-rule') as HTMLElement).textOverflow).toBe(
      'ellipsis',
    );
  });

  it('gives the recurrence mark a target past the 36px floor, without widening the row', () => {
    const rule = task({ title: 'Post the evening digest', schedule: weekdays9() });
    const run = task({
      title: 'Post the evening digest',
      goal: 'g-quiet',
      recurrenceOf: { taskId: rule.id, occurrenceAt: NOW },
    });
    for (const size of [IPAD, PHONE]) {
      setViewport(size);
      paint([rule, run]);
      const mark = rowOf(run.id).querySelector<HTMLElement>('.board-recur-link');
      const target = mark?.querySelector<HTMLElement>('.board-recur-target');
      const glyph = mark?.querySelector('svg');
      if (!mark || !target || !glyph) throw new Error(`no tap target at ${size.width}`);
      // docs/product/design-mobile.md: "Minimum 36×36px for any interactive
      // element". 44 is the stricter convention and clears it at both sizes.
      expect(Number.parseFloat(styleOf(target).width)).toBeGreaterThanOrEqual(36);
      expect(Number.parseFloat(styleOf(target).height)).toBeGreaterThanOrEqual(36);
      // Out of flow and centred on the mark, so the row's grid never learns
      // it is there — the glyph stays 13px and nothing else moves.
      expect(styleOf(target).position).toBe('absolute');
      expect(styleOf(mark).position).toBe('relative');
      expect(styleOf(glyph).width).toBe('13px');
      // Nothing crops it. A target inside a clipping strip is a 13px target
      // wearing a 44px rule.
      const strip = rowOf(run.id).querySelector<HTMLElement>('.board-task-badges');
      if (strip) expect(['', 'visible']).toContain(styleOf(strip).overflow);
    }
  });

  it('paints the Scheduled rail grey, not the goal bands’ accent', () => {
    setViewport(IPAD);
    paint([task({ schedule: weekdays9() }), task({ title: 'Cut the release' })]);
    const sched = scheduledBand().querySelector<HTMLElement>('.board-goal-row');
    const goal = root.querySelector<HTMLElement>('[data-goal-id="g-ship"] .board-goal-row');
    if (!sched || !goal) throw new Error('a band lost its header');
    const grey = styleOf(sched).borderLeftColor;
    const accent = styleOf(goal).borderLeftColor;
    expect(grey).not.toBe(accent);
    expect(grey).not.toBe('');
    // The width is untouched — it is the same rail, in a different ink.
    expect(styleOf(sched).borderLeftWidth).toBe(styleOf(goal).borderLeftWidth);
  });

  it('keeps the next run at 430px, where the badge strip is capped', () => {
    setViewport(PHONE);
    const r = task({ title: 'Post the evening digest', schedule: weekdays9() });
    paint([r]);
    const next = rowOf(r.id).querySelector<HTMLElement>('.board-next');
    if (!next) throw new Error('the next run is gone at 430px');
    expect(styleOf(next).display).not.toBe('none');
    // The strip cannot win the row against the title at this width — the
    // ceiling the ≤900px block sets, resolved against THIS viewport (30vw of
    // 430). happy-dom resolves the viewport unit, so the number is the
    // evidence the media query applied.
    const strip = rowOf(r.id).querySelector<HTMLElement>('.board-task-badges');
    if (!strip) throw new Error('no badge strip');
    expect(styleOf(strip).maxWidth).toBe('129px');
    // The control: the same read at the iPad width, where the block does not
    // match, so the ceiling above is the media query and not a base rule.
    setViewport(IPAD);
    const wide = rowOf(r.id).querySelector<HTMLElement>('.board-task-badges');
    if (!wide) throw new Error('no badge strip');
    expect(styleOf(wide).maxWidth).not.toBe('129px');
  });
});
