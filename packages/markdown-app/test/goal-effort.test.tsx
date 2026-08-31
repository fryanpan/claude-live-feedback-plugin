/**
 * The goal header's effort readout — the board half of the effort model.
 *
 * Three things are worth a test here and nothing else is:
 *
 *  1. **The rollup does not depend on who is looking.** `taskVisible` hides
 *     done rows outside the reader's done-window and, on the "Mine" tab,
 *     every row that is not theirs. Computing the percentage off what
 *     survives that would make a goal's progress a function of the current
 *     filter — switching tabs would swing it without a ticket moving.
 *  2. **Three states reach the screen as three states.** Never scored, an
 *     attempt that failed, and a real 0% are different sentences, and the
 *     easiest bug in this whole feature is rendering the first two as the
 *     third.
 *  3. **The task rows stay clean.** "No need to show hands on or wall clock
 *     hours in the board" (Bryan, 2026-08-30) — the numbers belong on the
 *     ticket, and a row must not sprout one.
 *
 * All fixtures are synthetic.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EFFORT_ESTIMATE_PROMPT_VERSION } from '@feedback/core/effort-estimate-prompt';
import {
  type EffortCalibration,
  type EffortRatio,
  computeEffortCalibration,
  neutralCalibration,
  ratioForGoal,
} from '@feedback/core/goal-effort';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type BoardFilters,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  bandOfGoal,
  boardCalibration,
  boardEffort,
  boardSectionsWithEffort,
  goalBandIds,
  goalEffortLabel,
} from '../src/hub/hub-model.ts';
import { effortComputationLines, effortFields } from '../src/hub/hub-render.ts';
import { disposeBoards, renderBoard } from './support/board.ts';

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

let seq = 0;
function task(overrides: Partial<HubTask> = {}): HubTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'todo',
    assignee: 'Riley Vance',
    goal: 'g-ship',
    order: seq,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${seq}`,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW,
    effortEstimate: {
      status: 'ok',
      handsOnSeconds: 600,
      wallClockSeconds: 3600,
      promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION,
    },
    ...overrides,
  };
}

/** A closed ticket: claimed `workedMs` before it finished, finished `agoMs`
 *  before NOW. */
function closed(agoMs: number, workedMs = HOUR, overrides: Partial<HubTask> = {}): HubTask {
  const doneAt = NOW - agoMs;
  return task({
    status: 'done',
    transitions: [
      {
        ts: doneAt - workedMs,
        from: 'todo',
        to: 'in-progress',
        by: { name: 'Riley', kind: 'agent' },
      },
      { ts: doneAt, from: 'in-progress', to: 'done', by: { name: 'Riley', kind: 'agent' } },
    ],
    ...overrides,
  });
}

const GOALS: HubGoal[] = [{ id: 'g-ship', title: 'Ship the thing' }];

const filters = (over: Partial<BoardFilters> = {}): BoardFilters => ({
  tab: 'all',
  userName: 'Bryan',
  doneWindow: DEFAULT_DONE_WINDOW,
  now: NOW,
  ...over,
});

describe('boardEffort ignores the reader’s filter', () => {
  it('gives the same percentage on the All tab and the Mine tab', () => {
    const tasks = [
      closed(2 * DAY),
      closed(3 * DAY),
      task({ assignee: 'Bryan' }),
      task({ assignee: 'Someone Else' }),
    ];
    const all = boardEffort(GOALS, tasks, NOW).byGoal.get('g-ship');
    if (all?.kind !== 'ready') throw new Error('expected ready');
    expect(all.percentComplete).toBe(50);

    // The rollup takes the unfiltered list, so the tab is irrelevant to it —
    // and `boardSectionsWithEffort` must hand it the same array it hands the
    // grouping, not the grouping's output.
    const mine = boardSectionsWithEffort(GOALS, tasks, filters({ tab: 'mine' }), NOW).find(
      (s) => s.id === 'g-ship',
    );
    // The BAND shows one row on the Mine tab…
    expect(mine?.tasks).toHaveLength(1);
    // …and still reports the goal as half done.
    if (mine?.effort?.kind !== 'ready') throw new Error('expected ready');
    expect(mine.effort.percentComplete).toBe(50);
  });

  it('does not march backwards when the done-window narrows', () => {
    const tasks = [closed(40 * DAY), closed(41 * DAY), task(), task()];
    const wide = boardSectionsWithEffort(GOALS, tasks, filters({ doneWindow: 'all' }), NOW).find(
      (s) => s.id === 'g-ship',
    );
    const narrow = boardSectionsWithEffort(GOALS, tasks, filters({ doneWindow: 'day' }), NOW).find(
      (s) => s.id === 'g-ship',
    );
    // Positive control on the fixture: the narrow window really does hide them.
    expect(wide?.tasks.length).toBeGreaterThan(narrow?.tasks.length ?? 0);
    if (wide?.effort?.kind !== 'ready' || narrow?.effort?.kind !== 'ready') {
      throw new Error('expected ready');
    }
    expect(narrow.effort.percentComplete).toBe(wide.effort.percentComplete);
    expect(narrow.effort.percentComplete).toBe(50);
  });

  it('counts a task whose goal id matches no band under Backlog, as the board draws it', () => {
    const orphan = task({ goal: 'g-deleted' });
    const effort = boardEffort(GOALS, [orphan, task()], NOW);
    const chores = effort.byGoal.get(CHORES_ID);
    if (chores?.kind !== 'ready') throw new Error('expected ready');
    expect(chores.estimatedCount).toBe(1);
  });
});

describe('the board says when a projection is uncalibrated', () => {
  const labelFor = (tasks: HubTask[]) => {
    const summary = boardEffort(GOALS, tasks, NOW).byGoal.get('g-ship');
    if (!summary) throw new Error('no summary');
    return goalEffortLabel(summary, NOW, 'en-US');
  };

  /** Closed, worked, and scored under an OLDER ask — so it sets a pace and
   *  teaches the calibrator nothing. The shape a board wears right after a
   *  prompt bump, and the only way to hold a date and no correction at once. */
  const staleClose = (agoMs: number): HubTask =>
    closed(agoMs, HOUR, {
      effortEstimate: {
        status: 'ok',
        handsOnSeconds: 600,
        wallClockSeconds: 3600,
        promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION - 1,
      },
    });

  it('marks a date whose factor no closed ticket has corrected', () => {
    const l = labelFor([staleClose(DAY), staleClose(2 * DAY), staleClose(3 * DAY), task()]);
    // Positive control: there IS a date to qualify. Without it the marker
    // would be suppressed and the assertion below would pass on the wrong
    // branch.
    expect(l.finishText).not.toBe('');
    expect(l.uncalibratedText).toBe('estimate only');
    expect(l.title).toContain('Estimate only');
    expect(l.title).toContain("board's starting assumption");
  });

  it('drops the marker once three closes have corrected the factor', () => {
    // The same fixture scored under the CURRENT ask. This is what stops the
    // test above passing for a marker that is simply always on.
    const l = labelFor([closed(DAY), closed(2 * DAY), closed(3 * DAY), task()]);
    expect(l.finishText).not.toBe('');
    expect(l.uncalibratedText).toBe('');
    expect(l.title).not.toContain('Estimate only');
  });

  it('says nothing about calibration when there is no date to qualify', () => {
    // A goal already saying "date after 3 closes" does not also need telling
    // that the estimate behind the date it has not got is uncorrected.
    const l = labelFor([staleClose(DAY), task()]);
    expect(l.finishText).toContain('date after');
    expect(l.uncalibratedText).toBe('');
  });

  it('names the factor, not the pace, as the thing that is uncorrected', () => {
    // The strip is saying something precise: the DATE rests on three closes
    // it did watch, and the estimate that date divides was scaled by a
    // number none of them corrected. Blaming the pace would be wrong.
    const l = labelFor([staleClose(DAY), staleClose(2 * DAY), staleClose(3 * DAY), task()]);
    expect(l.title).toContain('no closed ticket has corrected the scorer');
    expect(l.title).not.toContain('date after');
  });
});

describe('goalEffortLabel keeps three states apart', () => {
  const labelFor = (tasks: HubTask[]) => {
    const summary = boardEffort(GOALS, tasks, NOW).byGoal.get('g-ship');
    if (!summary) throw new Error('no summary');
    return goalEffortLabel(summary, NOW, 'en-US');
  };

  it('says nothing at all for an empty band', () => {
    expect(labelFor([]).show).toBe(false);
  });

  it('says "not scored yet" — never 0% — when nothing has been scored', () => {
    const l = labelFor([task({ effortEstimate: undefined }), task({ effortEstimate: undefined })]);
    expect(l.show).toBe(true);
    expect(l.leftText).toBe('not scored yet');
    expect(l.percentText).toBe('');
    // No bar: an empty grey track is how this component draws 0% done.
    expect(l.showBar).toBe(false);
  });

  it('says so out loud when the scorer RAN and produced nothing', () => {
    const l = labelFor([
      task({ effortEstimate: { status: 'failed', reason: 'unparseable' } }),
      task({ effortEstimate: undefined }),
    ]);
    expect(l.leftText).toBe('scoring failed on 1');
    expect(l.showBar).toBe(false);
    expect(l.title).toContain('produced nothing usable');
    // The distinction the whole three-state design exists to preserve, and
    // the one it lost at the last step: side by side on the board these were
    // "no estimate yet" and "not estimated", which no reader can tell apart.
    // A run that happened and failed must not read like one that never ran.
    const never = labelFor([task({ effortEstimate: undefined })]);
    expect(never.leftText).toBe('not scored yet');
    expect(l.leftText).not.toBe(never.leftText);
    expect(l.leftText).toContain('failed');
  });

  it('draws a real 0% as a bar at zero, which is a different statement', () => {
    const l = labelFor([task(), task()]);
    expect(l.showBar).toBe(true);
    expect(l.percentText).toBe('0%');
    expect(l.percentFill).toBe(0);
  });

  it('names how much the bar does not cover', () => {
    const l = labelFor([task(), task({ effortEstimate: undefined })]);
    expect(l.coverageText).toBe('1 not scored');
    const withFailure = labelFor([
      task(),
      task({ effortEstimate: undefined }),
      task({ effortEstimate: { status: 'failed', reason: 'x' } }),
    ]);
    expect(withFailure.coverageText).toBe('2 not scored, 1 failed');
  });

  it('names the hands-on figure on the goal, and never the calendar one', () => {
    // This assertion used to ban BOTH phrases from the board, reading "No
    // need to show hands on or wall clock hours in the board" (Bryan,
    // 2026-08-30 morning) as covering the goal header. His later words on
    // the same day are narrower and explicit: *"Secondary task is to see
    // progress and understand how much work is left. And know how much hands
    // on time is left."* So on the GOAL HEADER the hands-on figure is asked
    // for by name — leaving it unlabelled was the defect. The ban survives
    // where it was aimed: on the TASK ROWS, asserted below.
    const l = labelFor([closed(DAY), task()]);
    const printed = [l.percentText, l.leftText, l.finishText, l.coverageText].join(' ');
    expect(printed.toLowerCase()).toContain('hands-on');
    // The calendar figure is the BAR and is never given as a duration here —
    // two durations side by side in different currencies is what made the
    // readout misleading in the first place.
    expect(printed.toLowerCase()).not.toContain('wall clock');
    expect(printed.toLowerCase()).not.toContain('wall-clock');
    expect(printed.toLowerCase()).not.toContain('calendar');
  });

  it('withholds a finish date until enough has closed, and says why', () => {
    const thin = labelFor([closed(DAY), closed(2 * DAY), task()]);
    // No DATE — but the slot is not left blank; see the next test.
    expect(thin.finishText).not.toMatch(/~/);
    expect(thin.title).toContain('No finish date yet');

    const enough = labelFor([closed(DAY), closed(2 * DAY), closed(3 * DAY), task(), task()]);
    // Three closes at a 3600s estimate each, the oldest three days back, is
    // a window of three days and a pace of 3,600 estimate-seconds a day;
    // 7,200s remain, so two days out from Sep 1 is Sep 3.
    expect(enough.finishText).toBe('~Sep 3');
    expect(enough.percentText).toBe('60%');
    // The remainder names whose time it is. The bar beside it is CALENDAR
    // time and this figure is Bryan's attention; unlabelled they invite the
    // reading "60% done, a minute to go", and the calendar remainder on
    // this same goal is 2h.
    //
    // 1m, not the 20m the raw estimates sum to: none of these closes carries
    // a reading time, so hands-on has no sample and sits at its prior
    // (1/15). The DATE above is untouched by the same prior on wall-clock,
    // and that is a property worth noticing rather than a coincidence — the
    // pace and the remainder are both in estimate-seconds, so a factor
    // applied to both cancels out of the division.
    expect(enough.leftText).toBe('1m hands-on left');
    // At the narrow tier the label goes and the NUMBER stays: the title is
    // the primary task there, and 430px does not have room for both.
    expect(enough.leftTextShort).toBe('1m');
  });

  it('says WHY there is no date, rather than just omitting one', () => {
    // On screen the date was simply absent and nothing explained it, so a
    // reader could not tell "too little has closed" from "this goal has no
    // work left" from "it is years away". Three absences, three sentences.
    const thin = labelFor([closed(DAY), closed(2 * DAY), task()]);
    expect(thin.finishText).toBe('date after 3 closes');

    const finished = labelFor([closed(DAY), closed(2 * DAY), closed(3 * DAY)]);
    expect(finished.percentText).toBe('100%');
    expect(finished.leftText).toBe('done');
    expect(finished.finishText).toBe('');

    const tiny = {
      effortEstimate: {
        status: 'ok' as const,
        handsOnSeconds: 600,
        wallClockSeconds: 600,
        promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION,
      },
    };
    const huge = {
      effortEstimate: {
        status: 'ok' as const,
        handsOnSeconds: 3600,
        wallClockSeconds: 144000,
        promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION,
      },
    };
    const faraway = labelFor([
      closed(DAY, HOUR, tiny),
      closed(2 * DAY, HOUR, tiny),
      closed(3 * DAY, HOUR, tiny),
      task(huge),
      task(huge),
      task(huge),
      task(huge),
      task(huge),
    ]);
    expect(faraway.finishText).toBe('over a year out');
    expect(faraway.title).toContain('too far for a date to mean anything');
  });

  it("names the pace window in hours when the goal's run was hours long", () => {
    // The window floors at an hour, not a day, so a goal that closed most of
    // itself in one afternoon carries a window under a day — and the
    // sentence naming it has to be able to count hours. The old whole-day
    // rounding printed this as "the last 1 day's pace", quoting a
    // denominator six times the one the date actually came from.
    const l = labelFor([closed(4 * HOUR), closed(3 * HOUR), closed(2 * HOUR), task()]);
    expect(l.title).toContain("the last 4 hours' pace");
    expect(l.title).not.toContain("day's pace");
  });

  it('still names the window in days when the run took days', () => {
    // Positive control for the test above: the hour wording is chosen by the
    // window, not printed unconditionally.
    const l = labelFor([closed(DAY), closed(2 * DAY), closed(3 * DAY), task()]);
    expect(l.title).toContain("the last 3 days' pace");
  });

  it('carries the year once the date leaves this one', () => {
    // A bare "~Dec 29" was rendered for a date in 2041 — the same four
    // characters a date four months out gets.
    const tiny = {
      effortEstimate: {
        status: 'ok' as const,
        handsOnSeconds: 600,
        wallClockSeconds: 600,
        promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION,
      },
    };
    const mid = {
      effortEstimate: {
        status: 'ok' as const,
        handsOnSeconds: 600,
        wallClockSeconds: 1300,
        promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION,
      },
    };
    const l = labelFor([
      closed(DAY, HOUR, tiny),
      closed(2 * DAY, HOUR, tiny),
      closed(3 * DAY, HOUR, tiny),
      // Sixty of them: three 600s closes over a three-day window is a pace
      // of 600 a day, so 78,000s of remainder is 130 days out — into next
      // year, and still inside the one-year horizon.
      ...Array.from({ length: 60 }, () => task(mid)),
    ]);
    expect(l.finishText).toMatch(/20\d\d/);
    // Positive control: a date inside the current year still renders bare,
    // so the assertion above cannot be met by always printing a year.
    const near = labelFor([closed(DAY), closed(2 * DAY), closed(3 * DAY), task(), task()]);
    expect(near.finishText).toBe('~Sep 3');
  });
});

describe('the board renders the readout and leaves the rows alone', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    disposeBoards();
    host.remove();
  });

  const paint = (tasks: HubTask[]): void => {
    renderBoard(host, boardSectionsWithEffort(GOALS, tasks, filters(), NOW), {} as never);
  };

  it('draws "estimate only" under the date, never in the title row', () => {
    // Scored under an older ask: three closes set a pace, and none of them
    // corrected the factor the date divides.
    const stale = (agoMs: number): HubTask =>
      closed(agoMs, HOUR, {
        effortEstimate: {
          status: 'ok',
          handsOnSeconds: 600,
          wallClockSeconds: 3600,
          promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION - 1,
        },
      });
    paint([stale(DAY), stale(2 * DAY), stale(3 * DAY), task()]);
    const strip = host.querySelector('.hub-goal-effort') as HTMLElement;
    const est = strip.querySelector('.hub-goal-effort-est');
    expect(est?.textContent).toBe('estimate only');
    // In the DATE's column — so it wraps under the date and spends height,
    // the axis this board has, rather than width from the goal title.
    expect(est?.closest('.hub-goal-effort-fin')).not.toBeNull();
    expect(est?.closest('.hub-goal-row')).toBeNull();
    // The pair still has exactly two children, which is what keeps
    // `space-between` holding the label and the date at opposite edges.
    expect(strip.querySelector('.hub-goal-effort-fin')?.children).toHaveLength(2);
    // The date itself is untouched beside it.
    expect(strip.querySelector('.hub-goal-effort-fin .hub-goal-effort-v')?.textContent).toContain(
      '~',
    );

    // Positive control: the same board scored under the CURRENT ask draws no
    // marker at all, so the assertion above is the state and not the markup.
    disposeBoards();
    host.innerHTML = '';
    paint([closed(DAY), closed(2 * DAY), closed(3 * DAY), task()]);
    expect(host.querySelector('.hub-goal-effort-est')).toBeNull();
  });

  it('draws the strip on its own row beneath the header, not on the meta row', () => {
    paint([closed(DAY), closed(2 * DAY), closed(3 * DAY), task(), task()]);
    const strips = host.querySelectorAll('.hub-goal-effort');
    // One strip per goal — the treatment Bryan approved on 2026-08-30 (mock
    // round six, variant 1): a row of its own under the header, not a
    // fragment tucked into the due date's slot.
    expect(strips).toHaveLength(1);
    const strip = strips[0] as HTMLElement;
    expect(strip.closest('.hub-goal-meta')).toBeNull();
    // A SIBLING of the goal row, and after it — which is what the "one block"
    // hairline rule and the folded-band rule in the stylesheet both key on.
    expect(strip.previousElementSibling?.classList.contains('hub-goal-row')).toBe(true);
    // …and outside the task list, so folding the band keeps the strip.
    expect(strip.closest('.hub-band-tasks')).toBeNull();
    // Three labelled facts, in Bryan's order: hands-on on the left, then
    // progress, then the projected finish.
    const label = (sel: string): string =>
      strip.querySelector(`${sel} .hub-goal-effort-k`)?.textContent ?? '';
    const value = (sel: string): string =>
      strip.querySelector(`${sel} .hub-goal-effort-v`)?.textContent ?? '';
    expect(label('.hub-goal-effort-hands')).toBe('Hands-on left');
    expect(label('.hub-goal-effort-progress')).toBe('Progress');
    expect(label('.hub-goal-effort-fin')).toBe('Projected finish');
    expect(value('.hub-goal-effort-progress')).toBe('60%');
    expect(value('.hub-goal-effort-fin')).toContain('~Sep 3');
    // The figure is the figure alone: the words are the label's job now, so
    // the value must not repeat them.
    expect(value('.hub-goal-effort-hands')).not.toContain('hands-on');
    expect(host.querySelector('.hub-goal-bar i')?.getAttribute('style')).toContain('60%');
  });

  it('keeps the coverage caveat in the FLEXIBLE column, off the pinned ones', () => {
    // A bar drawn over some of a band's tickets has to say so on screen — the
    // device this board is read from has no hover. Where it says so is the
    // alignment correction Bryan asked for: the caveat rides the left column,
    // because anything in a pinned column would push PROGRESS and PROJECTED
    // FINISH off the x its neighbouring bands drew them on.
    paint([
      closed(DAY),
      closed(2 * DAY),
      closed(3 * DAY),
      task(),
      task({ effortEstimate: undefined }),
      task({ effortEstimate: { status: 'failed', reason: 'the body was empty' } }),
    ]);
    const note = host.querySelector('.hub-goal-effort-note');
    expect(note?.textContent).toBe('2 not scored, 1 failed');
    expect(note?.closest('.hub-goal-effort-hands')).not.toBeNull();
    expect(note?.closest('.hub-goal-effort-progress')).toBeNull();
    expect(note?.closest('.hub-goal-effort-fin')).toBeNull();
    // Positive control: a band where every ticket is scored gets no caveat,
    // so the assertion above cannot be met by a note that is always drawn.
    disposeBoards();
    host.replaceChildren();
    paint([closed(DAY), closed(2 * DAY), closed(3 * DAY), task()]);
    expect(host.querySelector('.hub-goal-effort-note')).toBeNull();
  });

  it('reddens a projected finish that lands past the goal’s due date', () => {
    // The strip's one colour. The fixture projects ~Sep 3; a goal due Sep 2
    // is late by it, a goal due Sep 20 is not — the same tasks either way, so
    // what is under test is the comparison and not the projection.
    const withDue = (dueAt: number): HTMLElement => {
      disposeBoards();
      host.replaceChildren();
      const goals: HubGoal[] = [{ id: 'g-ship', title: 'Ship the thing', dueAt }];
      renderBoard(
        host,
        boardSectionsWithEffort(
          goals,
          [closed(DAY), closed(2 * DAY), closed(3 * DAY), task(), task()],
          filters(),
          NOW,
        ),
        {} as never,
      );
      return host.querySelector('.hub-goal-effort-fin .hub-goal-effort-v') as HTMLElement;
    };
    expect(withDue(Date.UTC(2026, 8, 2)).className).toContain('hub-goal-effort-late');
    expect(withDue(Date.UTC(2026, 8, 20)).className).not.toContain('hub-goal-effort-late');
  });

  it('puts no numbers on a task row', () => {
    paint([closed(DAY), task()]);
    for (const row of host.querySelectorAll('.hub-task-row')) {
      const text = row.textContent ?? '';
      // The struck pair, in the shapes the mock showed them: "2h · 10m".
      expect(text).not.toMatch(/\d+\s*h\s*·/);
      expect(text).not.toMatch(/\d+\s*m\s*(left|·)/);
      expect(row.querySelector('.hub-goal-bar')).toBeNull();
      expect(row.querySelector('.hub-goal-effort')).toBeNull();
    }
  });

  it('gives Backlog no bar — it is a bucket, not a goal', () => {
    renderBoard(
      host,
      boardSectionsWithEffort(GOALS, [task({ goal: CHORES_ID })], filters(), NOW),
      {} as never,
    );
    const chores = host.querySelector('.hub-chores') ?? host.querySelector('.hub-band-reserved');
    expect(chores, 'no Backlog band rendered').not.toBeNull();
    expect(chores?.querySelector('.hub-goal-effort')).toBeNull();
  });
});

describe('the stylesheet pins the columns and folds to two rows', () => {
  const CSS = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8');

  /** Every `@media <query> { … }` block's inner text, brace-matched. */
  function mediaBlocks(query: string): string {
    const out: string[] = [];
    let idx = 0;
    for (;;) {
      const at = CSS.indexOf(`@media ${query}`, idx);
      if (at === -1) break;
      const open = CSS.indexOf('{', at);
      let depth = 1;
      let i = open + 1;
      while (i < CSS.length && depth > 0) {
        if (CSS[i] === '{') depth += 1;
        else if (CSS[i] === '}') depth -= 1;
        i += 1;
      }
      out.push(CSS.slice(open + 1, i - 1));
      idx = i;
    }
    expect(out, `no @media ${query} block found`).not.toHaveLength(0);
    return out.join('\n');
  }

  function body(css: string, selector: string): string {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:^|[};])\\s*${esc}\\s*\\{([^}]*)\\}`, 'm').exec(css);
    expect(m, `no rule for ${selector}`).not.toBeNull();
    return m?.[1] ?? '';
  }

  it('gives the two right-hand columns a FIXED width, which is what aligns them', () => {
    // Bryan's first correction: *"please align the PROGRESS label and
    // PROJECTED FINISH label across goals so it doesn't look shabby"*. Each
    // band is its own grid, so an `auto` track is sized by that band's own
    // content and the labels land somewhere different in every band. Only a
    // px track pins them without the bands agreeing on a width first — this
    // assertion is the invariant the 0px measurement rests on.
    const cols = body(CSS, '.hub-goal-effort').match(/grid-template-columns:([^;]*)/)?.[1] ?? '';
    expect(cols).toMatch(/minmax\(0,\s*1fr\)\s+\d+px\s+\d+px/);
    // …and the flexible track is the LEFT one, so nothing on the left can
    // move anything on the right.
    expect(cols.trimStart().startsWith('minmax(0, 1fr)')).toBe(true);
  });

  it('holds the readability floor at both tiers: 12px labels, 16px values', () => {
    // The floor that got this variant through five rounds of mocks. It is
    // asserted at BOTH tiers because the cheapest way to win a row on a phone
    // is to shrink type, and that trade is not one this branch may make.
    expect(body(CSS, '.hub-goal-effort-k')).toContain('font-size: 12px');
    expect(body(CSS, '.hub-goal-effort-v')).toContain('font-size: 16px');
    const mobile = mediaBlocks('(max-width: 1100px)');
    const strip = mobile.slice(mobile.indexOf('.hub-goal-effort'));
    expect(strip).not.toMatch(/\.hub-goal-effort-[kv]\s*\{[^}]*font-size/);
  });

  it('folds to exactly two rows below 1100px, progress first', () => {
    // Bryan's second correction: *"on mobile, put PROGRESS on the first row
    // and Hands-on on the second row"*. Two area rows, and `prog` is the
    // first of them — the row count is asserted here in the template and
    // measured in a real browser at 430px.
    const mobile = mediaBlocks('(max-width: 1100px)');
    const areas = body(mobile, '.hub-goal-effort').match(/grid-template-areas:([^;]*)/)?.[1] ?? '';
    const rows = areas.match(/"[^"]*"/g) ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe('"prog prog"');
    expect(rows[1]).toBe('"hands fin"');
    expect(body(mobile, '.hub-goal-effort-progress')).toContain('grid-area: prog');
    expect(body(mobile, '.hub-goal-effort-hands')).toContain('grid-area: hands');
    // The bar takes the first row's slack rather than a fixed width — that,
    // and not a smaller type size, is what buys the row.
    expect(body(mobile, '.hub-goal-effort-progress .hub-goal-bar')).toContain('width: auto');
  });

  it('leaves the goal row a five-track grid — the strip takes no track', () => {
    // The strip is a SIBLING of the row, not a sixth child of it. A sixth
    // track here would knock the goal's owner avatar out of the column the
    // task rows' avatars sit in.
    expect(body(CSS, '.hub-goal-row')).toContain('auto minmax(0, 1fr) auto auto auto');
  });
});

/**
 * The ticket panel's two estimate fields.
 *
 * *"On task details, the estimate is a secondary function. Don't use so much
 * space for it. Just show the hands on and wall clock estimates with other
 * top level fields. And if I click on one show the detailed estimation
 * computation."* (Bryan, 2026-08-30.) So: two ordinary fields, and the
 * arithmetic only on a tap — which also has to be a TAP, because the device
 * this is read on has no hover.
 */
describe('the ticket panel shows two estimates and hides the arithmetic', () => {
  const closedSet = (): HubTask[] => {
    // Six closes, each of which took twice its estimate — 2h of wall clock
    // against an hour estimated, 20m read against 10m — so the learned factor
    // is a round 2.00 and the assertions below are arithmetic rather than a
    // snapshot.
    const rows: HubTask[] = [];
    for (let i = 0; i < 6; i += 1) {
      rows.push(
        closed(2 * DAY, 2 * HOUR, {
          effortEstimate: {
            status: 'ok',
            handsOnSeconds: 600,
            wallClockSeconds: 3600,
            promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION,
          },
          readingTime: { totalSeconds: 1200, sessionCount: 2, lastSessionAt: NOW },
        }),
      );
    }
    return rows;
  };
  const text = (el: HTMLElement): string => el.textContent ?? '';

  /**
   * A calibration built by hand, so the PANEL's wording can be asserted
   * against a factor chosen for readability.
   *
   * These tests are about what the drawer SAYS. Deriving their factor from
   * `computeEffortCalibration` coupled four assertions about sentences to
   * the calibrator's internals, and a change there — shrinking the board
   * median toward the board's prior — rewrote all four without a word of the
   * panel changing. The calibrator's arithmetic has its own tests in core;
   * `looks the correction up by BAND` below still runs the real one, because
   * WHICH bucket the panel reads is the thing that test is about.
   */
  const factor = (ratio: number, samples: number, spread = 1): EffortRatio => ({
    ratio,
    samples,
    // A hand-built factor with samples behind it is a CALIBRATED one; the
    // panel's prior-only wording is keyed on that flag, and a fixture that
    // left it false would put every one of these assertions on the wrong
    // branch. `uncalibrated` below is the deliberate other case.
    observedSamples: samples,
    spread,
    calibrated: samples > 0,
  });
  /** A factor resting on no measured close: the prior, plus what HAS closed. */
  const uncalibrated = (ratio: number, observedSamples = 0): EffortRatio => ({
    ratio,
    samples: 0,
    observedSamples,
    spread: 1,
    calibrated: false,
  });
  const shipCal = (wall: EffortRatio, hands: EffortRatio = wall): EffortCalibration => ({
    wallClock: { board: wall, byGoal: { 'g-ship': wall } },
    handsOn: { board: hands, byGoal: { 'g-ship': hands } },
  });

  it('draws no estimate fields at all for a ticket nobody scored', () => {
    // Absent is not zero: an unscored ticket gets no fields rather than
    // fields reading "0m". Positive control below, on a scored row.
    expect(effortFields(task({ effortEstimate: undefined }))).toBeNull();
    expect(effortFields(task())).not.toBeNull();
  });

  it('puts the two numbers in two ordinary fields, not one sentence', () => {
    const f = effortFields(task(), shipCal(factor(2, 6)));
    if (!f) throw new Error('expected fields');
    // 600s x 2.00 = 20m of attention; 3600s x 2.00 = 2h of calendar.
    expect(text(f.handsOn)).toBe('20m');
    expect(text(f.wallClock)).toBe('2h');
    // The calibration sentence is NOT in the field — that is the space Bryan
    // asked not to spend.
    expect(text(f.handsOn)).not.toContain('scaled');
    expect(text(f.wallClock)).not.toContain('scaled');
  });

  it('keeps the arithmetic behind a tap, and opens it on either field', () => {
    const f = effortFields(task(), shipCal(factor(2, 6)));
    if (!f) throw new Error('expected fields');
    expect(f.detail.hidden).toBe(true);
    expect(text(f.detail)).toContain('×2.00');
    expect(text(f.detail)).toContain('6 closed tickets');
    // A tap, not a hover: the primary device has no hover, and this used to
    // be the only place the factor appeared.
    (f.handsOn as HTMLButtonElement).click();
    expect(f.detail.hidden).toBe(false);
    (f.handsOn as HTMLButtonElement).click();
    expect(f.detail.hidden).toBe(true);
    const g = effortFields(task(), computeEffortCalibration(closedSet()));
    if (!g) throw new Error('expected fields');
    (g.wallClock as HTMLButtonElement).click();
    expect(g.detail.hidden).toBe(false);
  });

  it('says the scorer failed, rather than looking unscored', () => {
    const f = effortFields(task({ effortEstimate: { status: 'failed', reason: 'empty body' } }));
    if (!f) throw new Error('a failed run still draws its fields');
    expect(text(f.handsOn)).toBe('not estimated');
    expect(text(f.wallClock)).toBe('not estimated');
    expect(text(f.detail)).toContain('could not produce an estimate');
    // The distinction the acceptance criterion turns on: never scored draws
    // nothing at all, a failed run draws fields that say so.
    expect(effortFields(task({ effortEstimate: undefined }))).toBeNull();
  });

  it('reports what a closed ticket actually took, unmultiplied', () => {
    const lines = effortComputationLines(
      closedSet()[0] as HubTask,
      { handsOnSeconds: 600, wallClockSeconds: 3600 },
      ratioForGoal(computeEffortCalibration(closedSet()).wallClock, 'g-ship'),
      ratioForGoal(computeEffortCalibration(closedSet()).handsOn, 'g-ship'),
    ).join(' ');
    expect(lines).toContain('Actually took 20m of reading over 2h of calendar time');
  });

  it('stops reporting what it took once the ticket is reopened', () => {
    // A reopened ticket keeps the `done` transition from its first life, so
    // the measurement helpers keep answering — and the drawer would report
    // how long it took as a finished fact about work that is running again.
    const cal = shipCal(factor(2, 6));
    const wall = ratioForGoal(cal.wallClock, 'g-ship');
    const hands = ratioForGoal(cal.handsOn, 'g-ship');
    const wasClosed = closedSet()[0] as HubTask;
    // Positive control: the same row, still closed, does report it — so the
    // absence below is the status and not a fixture that never had actuals.
    expect(
      effortComputationLines(
        wasClosed,
        { handsOnSeconds: 600, wallClockSeconds: 3600 },
        wall,
        hands,
      ).join(' '),
    ).toContain('Actually took');
    const reopened: HubTask = {
      ...wasClosed,
      status: 'in-progress',
      transitions: [
        ...wasClosed.transitions,
        { ts: NOW, from: 'done', to: 'in-progress', by: { name: 'Bryan', kind: 'person' } },
      ],
    };
    const lines = effortComputationLines(
      reopened,
      { handsOnSeconds: 600, wallClockSeconds: 3600 },
      wall,
      hands,
    ).join(' ');
    expect(lines).not.toContain('Actually took');
    // The rest of the drawer is unchanged — the correction it was scaled by
    // is still true of a reopened ticket.
    expect(lines).toContain('\u00d72.00');
  });

  it('never prints one factor over two different corrections', () => {
    // The two axes learn from different samples: a close with a transition
    // trail and no reading time teaches the calendar and nothing about your
    // attention. One line printed over two DIFFERENT factors would be a claim
    // about a number that was never scaled that way.
    const differ = effortFields(task(), shipCal(factor(2, 6), factor(0.5, 1)));
    if (!differ) throw new Error('expected fields');
    expect(differ.detail.textContent).toContain('Hands-on scaled');
    expect(differ.detail.textContent).toContain('Calendar time scaled');

    // When the FACTOR agrees, it is one correction to a reader and is said
    // once — even where the two axes learned it from different numbers of
    // closes. Keying that on the counts too printed the same number twice.
    const once = effortFields(task(), shipCal(factor(2, 6), factor(2, 2)));
    if (!once) throw new Error('expected fields');
    expect(once.detail.textContent).toContain('Scaled ×2.00 from 2–6 closed tickets');
    expect(once.detail.textContent).not.toContain('Calendar time scaled');

    // Positive control: agreeing on both still reads as one plain count.
    const agreed = effortFields(task(), shipCal(factor(2, 6)));
    if (!agreed) throw new Error('expected fields');
    expect(agreed.detail.textContent).toContain('Scaled ×2.00 from 6 closed tickets');
  });

  it('says how many HAVE closed when a goal is below the calibration floor', () => {
    // One or two closes and the factor is still the prior. "Nothing has
    // closed under this goal" would be false about a row the reader can see
    // on the same board, so the sentence names the count it has.
    const two = effortFields(task(), shipCal(uncalibrated(0.07, 2), uncalibrated(0.07, 2)));
    if (!two) throw new Error('expected fields');
    const text = two.detail.textContent ?? '';
    expect(text).toContain('2 closed tickets so far, below the 3 needed');
    expect(text).not.toContain('nothing has closed');
    // Singular, because a sentence that says "1 closed tickets" is a
    // sentence nobody proof-read.
    const one = effortFields(task(), shipCal(uncalibrated(0.07, 1), uncalibrated(0.07, 1)));
    if (!one) throw new Error('expected fields');
    expect(one.detail.textContent).toContain('1 closed ticket so far');
    // Positive control: with nothing closed at all the older wording stands.
    const none = effortFields(task(), shipCal(uncalibrated(0.07), uncalibrated(0.07)));
    if (!none) throw new Error('expected fields');
    expect(none.detail.textContent).toContain('nothing has closed under this goal');
  });

  it('does not call a board-learned factor an assumption', () => {
    // A goal that has closed nothing of its own, on a board that HAS
    // learned, inherits a measured correction. It reports samples: 0 like a
    // prior does, and the panel used to key on exactly that — so the one
    // number it exists to explain would have been described as a guess.
    const inherited: EffortRatio = {
      ratio: 0.07,
      samples: 0,
      observedSamples: 1,
      spread: 1,
      calibrated: true,
    };
    const f = effortFields(task(), shipCal(inherited, inherited));
    if (!f) throw new Error('expected fields');
    expect(f.detail.textContent).not.toContain('starting assumption');
  });

  it('accounts for a factor with no closed tickets behind it — the board\u2019s prior', () => {
    // A board that has closed nothing still scales, because the priors are
    // not 1 (see EFFORT_PRIOR_* in core). Until they existed, a factor of 1
    // needed no sentence because it changed nothing; a silent \u00d70.07 would
    // leave a reader looking at a figure fifteen times smaller than the
    // scorer's own with nothing on the panel accounting for it.
    const fresh = effortFields(task(), neutralCalibration());
    if (!fresh) throw new Error('expected fields');
    const text = fresh.detail.textContent ?? '';
    expect(text).toContain('starting assumption that agents do the work');
    expect(text).toContain('nothing has closed under this goal to measure yet');
    // Both factors named, and NOT as a learned correction — the "from N
    // closed tickets" wording must never appear over a number no ticket
    // produced.
    expect(text).toContain('\u00d70.07');
    expect(text).toContain('\u00d70.14');
    expect(text).not.toContain('closed ticket');
    // And the figure on the panel really is the scaled one, so the sentence
    // is describing the arithmetic rather than decorating it: 600s of
    // hands-on at the 1/15 prior is 40s, which reads as 1m.
    expect(fresh.handsOn.textContent).toBe('1m');
    // Control: with no calibration passed at all the panel shows the raw
    // 600s as 10m, so the line above is the prior and not the formatter.
    expect(effortFields(task())?.handsOn.textContent).toBe('10m');

    // Positive control: a board WITH closes says the learned thing instead,
    // so the assertion above cannot be met by a panel that always prints the
    // prior sentence.
    const learned = effortFields(task(), computeEffortCalibration(closedSet()));
    if (!learned) throw new Error('expected fields');
    expect(learned.detail.textContent).toContain('closed tickets');
    expect(learned.detail.textContent).not.toContain('starting assumption');
  });

  it('looks the correction up by BAND, the way the board filed it', () => {
    // Two populations: six closes under a real band that all ran 2x long,
    // and four under a goal id no band answers to, which all landed on their
    // estimate. A ticket in the second group renders under Backlog, so its
    // correction is Backlog's — four samples, not the board's ten.
    const onTime = closed(2 * DAY, HOUR, {
      goal: 'g-vanished',
      effortEstimate: {
        status: 'ok',
        handsOnSeconds: 1200,
        wallClockSeconds: 3600,
        promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION,
      },
      readingTime: { totalSeconds: 1200, sessionCount: 1, lastSessionAt: NOW },
    });
    const rows = [...closedSet(), onTime, { ...onTime }, { ...onTime }, { ...onTime }];
    const calibration = boardCalibration(GOALS, rows);
    const orphan = task({ goal: 'g-vanished' });
    const band = bandOfGoal(goalBandIds(GOALS), orphan.goal);
    expect(band).toBe(CHORES_ID);
    const filed = effortFields(orphan, calibration, band);
    const stale = effortFields(orphan, calibration, 'g-vanished');
    expect(filed?.detail.textContent).toContain('4 closed tickets');
    // Keyed on the stale id the lookup misses the bucket entirely and falls
    // back to the board — a different factor, and now a visibly different
    // sentence, quoted about the same ticket. That is the parameter this
    // exists to close.
    expect(stale?.detail.textContent).toContain('closed tickets elsewhere on the board');
    expect(stale?.detail.textContent).not.toContain('4 closed tickets');
    // And the board's own count never lands on the goal: ten closed on this
    // board, none of them under `g-vanished`, and the sentence says so.
    expect(stale?.detail.textContent).not.toContain('10 closed');
    expect(stale?.detail.textContent).toContain('nothing has closed under this goal yet');
  });
});
