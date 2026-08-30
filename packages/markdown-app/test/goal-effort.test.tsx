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
import { computeEffortCalibration } from '@feedback/core/goal-effort';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type BoardFilters,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  boardEffort,
  boardSectionsWithEffort,
  goalEffortLabel,
} from '../src/hub/hub-model.ts';
import { effortCellText } from '../src/hub/hub-render.ts';
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

  it('says "not estimated" — never 0% — when nothing has been scored', () => {
    const l = labelFor([task({ effortEstimate: undefined }), task({ effortEstimate: undefined })]);
    expect(l.show).toBe(true);
    expect(l.leftText).toBe('not estimated');
    expect(l.percentText).toBe('');
    // No bar: an empty grey track is how this component draws 0% done.
    expect(l.showBar).toBe(false);
  });

  it('says so out loud when the scorer RAN and produced nothing', () => {
    const l = labelFor([
      task({ effortEstimate: { status: 'failed', reason: 'unparseable' } }),
      task({ effortEstimate: undefined }),
    ]);
    expect(l.leftText).toBe('no estimate yet');
    expect(l.showBar).toBe(false);
    expect(l.title).toContain('produced nothing usable');
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

  it('never puts the words "hands on" or "wall clock" on the board', () => {
    const l = labelFor([closed(DAY), task()]);
    const printed = [l.percentText, l.leftText, l.finishText, l.coverageText].join(' ');
    expect(printed.toLowerCase()).not.toContain('hands on');
    expect(printed.toLowerCase()).not.toContain('hands-on');
    expect(printed.toLowerCase()).not.toContain('wall clock');
    expect(printed.toLowerCase()).not.toContain('wall-clock');
  });

  it('withholds a finish date until enough has closed, and says why', () => {
    const thin = labelFor([closed(DAY), closed(2 * DAY), task()]);
    expect(thin.finishText).toBe('');
    expect(thin.title).toContain('No finish date yet');

    const enough = labelFor([closed(DAY), closed(2 * DAY), closed(3 * DAY), task(), task()]);
    // Three closes at a 3600s estimate over a 14-day window is a pace of
    // 771.43 estimate-seconds a day; 7,200s remain, so 9.33 days out from
    // Sep 1 is Sep 10.
    expect(enough.finishText).toBe('~Sep 10');
    expect(enough.percentText).toBe('60%');
    expect(enough.leftText).toBe('20m left');
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

  it('draws both variants, so CSS can pick one by width', () => {
    paint([closed(DAY), closed(2 * DAY), closed(3 * DAY), task(), task()]);
    const inline = host.querySelector('.hub-goal-effort-inline');
    const strip = host.querySelector('.hub-goal-effort-strip');
    expect(inline).not.toBeNull();
    expect(strip).not.toBeNull();
    // The inline one rides the meta row; the strip is a sibling of the row.
    expect(inline?.closest('.hub-goal-meta')).not.toBeNull();
    expect(strip?.closest('.hub-goal-row')).toBeNull();
    expect(strip?.parentElement?.classList.contains('hub-band')).toBe(true);
    expect(strip?.textContent).toContain('60%');
    expect(strip?.textContent).toContain('~Sep 10');
    expect(host.querySelector('.hub-goal-bar i')?.getAttribute('style')).toContain('60%');
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

  it('hides the strip above the mobile tier', () => {
    expect(body(CSS, '.hub-goal-effort-strip')).toContain('display: none');
  });

  it('swaps them below 1100px', () => {
    const mobile = mediaBlocks('(max-width: 1100px)');
    expect(body(mobile, '.hub-goal-effort-inline')).toContain('display: none');
    expect(body(mobile, '.hub-goal-effort-strip')).toContain('display: flex');
  });

  it('leaves the goal row a five-track grid — the readout takes no track', () => {
    // The inline variant nests inside `.hub-goal-meta` rather than becoming a
    // sixth child of the row, which is what keeps the avatar column aligned
    // with the task rows'. A sixth track here would break both.
    expect(body(CSS, '.hub-goal-row')).toContain('auto minmax(0, 1fr) auto auto auto');
  });
});

/**
 * The ticket's Effort field — the other half of the trade Bryan made when he
 * struck the numbers from the board rows. If this cell does not carry them,
 * they are nowhere a person can read: the goal header states the calibration
 * factor in a `title`, and the primary device has no hover.
 */
describe('the ticket panel states the numbers the board no longer shows', () => {
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
          readingTime: { totalSeconds: 1200, sessionCount: 2, lastReadAt: NOW },
        }),
      );
    }
    return rows;
  };

  it('says nothing at all about a ticket nobody scored', () => {
    // Absent is not zero, and an unscored ticket gets no field rather than a
    // field reading "0m". Positive control below: the same call on a SCORED
    // row is non-empty, so an always-empty implementation cannot pass.
    expect(effortCellText(task({ effortEstimate: undefined }))).toBe('');
    expect(effortCellText(task())).not.toBe('');
  });

  it('says the scorer failed, rather than looking unscored', () => {
    const text = effortCellText(
      task({ effortEstimate: { status: 'failed', reason: 'the body was empty' } }),
    );
    expect(text).toContain('could not produce');
    // The distinction the acceptance criterion turns on.
    expect(text).not.toBe(effortCellText(task({ effortEstimate: undefined })));
  });

  it('shows the raw numbers when no board is behind the panel', () => {
    const text = effortCellText(task());
    expect(text).toContain('10m');
    expect(text).toContain('1h');
    // No factor is invented out of nothing.
    expect(text).not.toContain('scaled');
  });

  it('states the calibration factor and what it was learned from', () => {
    const calibration = computeEffortCalibration(closedSet());
    const text = effortCellText(task(), calibration);
    // 3600s estimated x 2.00 learned = 7200s = 2h, said out loud with its
    // sample count so the reader can weigh it.
    expect(text).toContain('×2.00');
    expect(text).toContain('6 closed tickets');
    expect(text).toContain('2h');
  });

  it('reports what a closed ticket actually took, unmultiplied', () => {
    const text = effortCellText(closedSet()[0], computeEffortCalibration(closedSet()));
    expect(text).toContain('actually took 2h');
    expect(text).toContain('20m of it read');
  });
});
