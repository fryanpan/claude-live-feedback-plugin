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
import { computeEffortCalibration, ratioForGoal } from '@feedback/core/goal-effort';
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
    effortEstimate: { status: 'ok', handsOnSeconds: 600, wallClockSeconds: 3600 },
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
    // Three closes at a 3600s estimate over a 14-day window is a pace of
    // 771.43 estimate-seconds a day; 7,200s remain, so 9.33 days out from
    // Sep 1 is Sep 10.
    expect(enough.finishText).toBe('~Sep 10');
    expect(enough.percentText).toBe('60%');
    // The remainder names whose time it is. The bar beside it is CALENDAR
    // time and this figure is Bryan's attention; unlabelled they invite the
    // reading "60% done, 20 minutes to go", and the calendar remainder on
    // this same goal is 2h.
    expect(enough.leftText).toBe('20m hands-on left');
    // At the narrow tier the label goes and the NUMBER stays: the title is
    // the primary task there, and 430px does not have room for both.
    expect(enough.leftTextShort).toBe('20m');
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
      effortEstimate: { status: 'ok' as const, handsOnSeconds: 600, wallClockSeconds: 600 },
    };
    const huge = {
      effortEstimate: { status: 'ok' as const, handsOnSeconds: 3600, wallClockSeconds: 144000 },
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

  it('carries the year once the date leaves this one', () => {
    // A bare "~Dec 29" was rendered for a date in 2041 — the same four
    // characters a date four months out gets.
    const tiny = {
      effortEstimate: { status: 'ok' as const, handsOnSeconds: 600, wallClockSeconds: 600 },
    };
    const mid = {
      effortEstimate: { status: 'ok' as const, handsOnSeconds: 600, wallClockSeconds: 1300 },
    };
    const l = labelFor([
      closed(DAY, HOUR, tiny),
      closed(2 * DAY, HOUR, tiny),
      closed(3 * DAY, HOUR, tiny),
      ...Array.from({ length: 20 }, () => task(mid)),
    ]);
    expect(l.finishText).toMatch(/20\d\d/);
    // Positive control: a date inside the current year still renders bare,
    // so the assertion above cannot be met by always printing a year.
    const near = labelFor([closed(DAY), closed(2 * DAY), closed(3 * DAY), task(), task()]);
    expect(near.finishText).toBe('~Sep 10');
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

  it('draws ONE readout, on the meta row, with both strings inside it', () => {
    paint([closed(DAY), closed(2 * DAY), closed(3 * DAY), task(), task()]);
    const readouts = host.querySelectorAll('.hub-goal-effort');
    // One node per goal — never a second row under it. The row of its own is
    // what Bryan rejected as "too much space for progress".
    expect(readouts).toHaveLength(1);
    const inline = host.querySelector('.hub-goal-effort-inline');
    expect(inline?.closest('.hub-goal-meta')).not.toBeNull();
    expect(host.querySelector('.hub-goal-effort-strip')).toBeNull();
    // Both strings are in the DOM; the stylesheet picks one (asserted in the
    // stylesheet block below).
    expect(inline?.querySelector('.hub-goal-effort-wide')?.textContent).toContain('~Sep 10');
    expect(inline?.querySelector('.hub-goal-effort-narrow')?.textContent).toContain('60%');
    expect(inline?.querySelector('.hub-goal-effort-narrow')?.textContent).not.toContain('~Sep');
    expect(host.querySelector('.hub-goal-bar i')?.getAttribute('style')).toContain('60%');
  });

  it('carries the coverage caveat on screen, not in a tooltip', () => {
    // A bar drawn over some of a band's tickets has to say so. It lived in
    // the `title` alone until a measurement at 1180px — the iPad tier, and
    // the device this board is mostly read from — showed the caveat was
    // reachable only by hover, which that device does not have.
    paint([
      closed(DAY),
      closed(2 * DAY),
      closed(3 * DAY),
      task(),
      task({ effortEstimate: undefined }),
      task({ effortEstimate: { status: 'failed', reason: 'the body was empty' } }),
    ]);
    const inline = host.querySelector('.hub-goal-effort-inline');
    expect(inline?.querySelector('.hub-goal-effort-note')?.textContent).toBe(
      '2 not scored, 1 failed',
    );
    // Positive control: a band where every ticket is scored gets no caveat,
    // so the assertion above cannot be met by a note that is always drawn.
    disposeBoards();
    host.replaceChildren();
    paint([closed(DAY), closed(2 * DAY), closed(3 * DAY), task()]);
    expect(host.querySelector('.hub-goal-effort-note')).toBeNull();
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

describe('the stylesheet picks exactly one variant per tier', () => {
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

  it('draws the readout on ONE row at every width', () => {
    // The row of its own that the narrow tier used to get is what Bryan
    // rejected — "the second option takes up too much space for progress".
    // There is no strip left to hide.
    expect(CSS).not.toContain('.hub-goal-effort-strip');
    expect(body(CSS, '.hub-goal-effort-narrow')).toContain('display: none');
  });

  it('sheds words rather than numbers below 1100px', () => {
    const mobile = mediaBlocks('(max-width: 1100px)');
    // The title is the primary task at this end, so the date, the caveat and
    // the long label go — and the readout stays on the meta row.
    expect(body(mobile, '.hub-goal-effort-narrow')).toContain('display: inline');
    expect(mobile).toMatch(
      /\.hub-goal-effort-wide,\s*\n\s*\.hub-goal-effort-note \{[^}]*display: none/,
    );
    expect(body(mobile, '.hub-goal-bar')).toContain('width: 40px');
  });

  it('leaves the goal row a five-track grid — the readout takes no track', () => {
    // The inline variant nests inside `.hub-goal-meta` rather than becoming a
    // sixth child of the row, which is what keeps the avatar column aligned
    // with the task rows'. A sixth track here would break both.
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
          effortEstimate: { status: 'ok', handsOnSeconds: 600, wallClockSeconds: 3600 },
          readingTime: { totalSeconds: 1200, sessionCount: 2, lastSessionAt: NOW },
        }),
      );
    }
    return rows;
  };
  const text = (el: HTMLElement): string => el.textContent ?? '';

  it('draws no estimate fields at all for a ticket nobody scored', () => {
    // Absent is not zero: an unscored ticket gets no fields rather than
    // fields reading "0m". Positive control below, on a scored row.
    expect(effortFields(task({ effortEstimate: undefined }))).toBeNull();
    expect(effortFields(task())).not.toBeNull();
  });

  it('puts the two numbers in two ordinary fields, not one sentence', () => {
    const f = effortFields(task(), computeEffortCalibration(closedSet()));
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
    const f = effortFields(task(), computeEffortCalibration(closedSet()));
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

  it('never prints one factor over two different corrections', () => {
    // The two axes learn from different samples: a close with a transition
    // trail and no reading time teaches the calendar and nothing about your
    // attention. One line printed over two DIFFERENT factors would be a claim
    // about a number that was never scaled that way.
    const rows = closedSet().map((t, i) =>
      i === 0
        ? { ...t, readingTime: { totalSeconds: 300, sessionCount: 1, lastSessionAt: NOW } }
        : { ...t, readingTime: undefined },
    ) as HubTask[];
    const differ = effortFields(task(), computeEffortCalibration(rows));
    if (!differ) throw new Error('expected fields');
    expect(differ.detail.textContent).toContain('Hands-on scaled');
    expect(differ.detail.textContent).toContain('Calendar time scaled');

    // When the FACTOR agrees, it is one correction to a reader and is said
    // once — even where the two axes learned it from different numbers of
    // closes. Keying that on the counts too printed the same number twice.
    const uneven = closedSet().map((t, i) =>
      i < 2 ? t : ({ ...t, readingTime: undefined } as HubTask),
    );
    const once = effortFields(task(), computeEffortCalibration(uneven));
    if (!once) throw new Error('expected fields');
    expect(once.detail.textContent).toContain('Scaled ×2.00 from 2–6 closed tickets');
    expect(once.detail.textContent).not.toContain('Calendar time scaled');

    // Positive control: agreeing on both still reads as one plain count.
    const agreed = effortFields(task(), computeEffortCalibration(closedSet()));
    if (!agreed) throw new Error('expected fields');
    expect(agreed.detail.textContent).toContain('Scaled ×2.00 from 6 closed tickets');
  });

  it('looks the correction up by BAND, the way the board filed it', () => {
    // Two populations: six closes under a real band that all ran 2x long,
    // and four under a goal id no band answers to, which all landed on their
    // estimate. A ticket in the second group renders under Backlog, so its
    // correction is Backlog's — four samples, not the board's ten.
    const onTime = closed(2 * DAY, HOUR, {
      goal: 'g-vanished',
      effortEstimate: { status: 'ok', handsOnSeconds: 1200, wallClockSeconds: 3600 },
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
    // back to the board's ten — a different number, quoted about the same
    // ticket. That is the parameter this exists to close.
    expect(stale?.detail.textContent).toContain('10 closed tickets');
  });
});
