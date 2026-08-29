/**
 * The board telling its lead that work has stopped.
 *
 * What is under test is almost entirely the FRUGALITY, the same way it is for
 * `ready-nudge.ts`: a wake costs the lead a turn, and one that repeats every
 * minute over a row that has not changed teaches them to skim wakes — and
 * then the one that mattered is skimmed too. So most of what is asserted here
 * is silence.
 *
 * The one place this deliberately differs from the ready-work wake is
 * escalation: a row that stays stalled is worth saying again eventually,
 * because unlike ready work it names something that was supposed to be
 * moving. That is the repeat window, and it is asserted here as a bounded
 * thing rather than as a cooldown that fires forever.
 *
 * All fixtures are synthetic — invented titles in a made-up workspace. The
 * repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REVIEW_ITEM_HELD_EVENT,
  type ReviewItemHeldFrame,
  STALL_EVENT,
  STALL_REPEAT_DEFAULT_MS,
  type StallNudgeFrame,
  StallNudger,
  type StallSnapshot,
} from '../src/stall-nudge.ts';

const MIN = 60_000;

interface Sent {
  workspaceId: string;
  agentId: string;
  frame: StallNudgeFrame;
}

interface World {
  now: number;
  boards: StallSnapshot[];
  reachable: Set<string>;
}

function board(over: Partial<StallSnapshot> = {}): StallSnapshot {
  return {
    workspaceId: 'w-atlas',
    leadAgentId: 'agent-cartographer',
    retired: false,
    stalled: [
      { id: 't-1', title: 'Rank results by recency', bucket: 'in-progress', quietMs: 45 * MIN },
    ],
    unfiled: [],
    considered: 4,
    undetermined: [],
    ...over,
  };
}

function harness(
  opts: { repeatMs?: number; stampFile?: string; world?: World; filerDelivers?: () => number } = {},
) {
  const world: World = opts.world ?? {
    now: 1_000_000,
    boards: [board()],
    reachable: new Set(['agent-cartographer']),
  };
  const sent: Sent[] = [];
  const toFilers: Array<{ workspaceId: string; agentId: string; frame: ReviewItemHeldFrame }> = [];
  const reported: string[] = [];
  const nudger = new StallNudger({
    now: () => world.now,
    snapshot: () => world.boards,
    canReach: (_workspaceId, agentId) => world.reachable.has(agentId),
    send: (workspaceId, agentId, frame) => {
      sent.push({ workspaceId, agentId, frame });
      return 1;
    },
    sendToFiler: (workspaceId, agentId, frame) => {
      toFilers.push({ workspaceId, agentId, frame });
      return opts.filerDelivers ? opts.filerDelivers() : 1;
    },
    report: (line) => reported.push(line),
    ...(opts.repeatMs !== undefined ? { repeatMs: opts.repeatMs } : {}),
    ...(opts.stampFile !== undefined ? { stampFile: opts.stampFile } : {}),
  });
  return { world, sent, toFilers, reported, nudger };
}

/** One review item the quality gate has held past the window. */
const HELD = {
  id: 't-7',
  title: 'Rebuild the index nightly',
  reviewItemId: 'ri-1',
  headline: 'ok?',
  reason: 'The headline is not a question the reader can answer.',
  heldMs: 6 * MIN,
  filedBy: 'Index Keeper',
  filerAgentId: 'agent-index-keeper',
};

describe('a stalled row wakes the lead — once', () => {
  it('sends one addressed frame naming the quietest row', () => {
    const { sent, nudger } = harness();

    nudger.tick();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.agentId).toBe('agent-cartographer');
    expect(sent[0]?.workspaceId).toBe('w-atlas');
    const frame = sent[0]?.frame as StallNudgeFrame;
    expect(frame.event).toBe(STALL_EVENT);
    // The row has to be nameable without a lookup, or the wake costs a turn
    // before it can say whether it was worth one.
    expect(frame.taskId).toBe('t-1');
    expect(frame.title).toBe('Rank results by recency');
    expect(frame.stalledCount).toBe(1);
    // The denominator, so "1 row stalled" cannot mean two different boards.
    expect(frame.consideredCount).toBe(4);
    expect(frame.rows?.[0]?.quietMs).toBe(45 * MIN);
    expect(frame.rows?.[0]?.bucket).toBe('in-progress');
  });

  it('does NOT re-fire while the same rows are stalled by the same amount', () => {
    const { world, sent, nudger } = harness();

    nudger.tick();
    world.now += 5 * MIN;
    nudger.tick();
    world.now += 5 * MIN;
    nudger.tick();

    expect(sent).toHaveLength(1);
  });

  it('fires again when another row joins the stalled set', () => {
    const { world, sent, nudger } = harness();
    nudger.tick();

    world.boards[0]!.stalled = [
      ...world.boards[0]!.stalled,
      { id: 't-2', title: 'Cache the tile index', bucket: 'ready-unpicked', quietMs: 31 * MIN },
    ];
    nudger.tick();

    expect(sent).toHaveLength(2);
    expect(sent[1]?.frame.stalledCount).toBe(2);
  });

  it('drops the arming when the board recovers, and sends no all-clear', () => {
    const { world, sent, nudger } = harness();
    nudger.tick();

    world.boards[0]!.stalled = [];
    nudger.tick();

    // Nothing is stalled, so there is nothing to say — the wake is dropped,
    // not sent as an all-clear nobody asked for.
    expect(sent).toHaveLength(1);
    expect(nudger.armedCount()).toBe(0);
  });
});

/**
 * The wake must never fire over its own remedy.
 *
 * This is the loop that shipped: the stamp was compared for EQUALITY, so a
 * board whose set merely SHRANK moved the stamp and re-armed. The lead was
 * woken to file an ask, filed it, the row left the unfiled list, and the next
 * tick woke the lead again to announce the fix it had just made — a wake that
 * re-arms on the action it asked for is self-sustaining, and the design at the
 * top of the file wants it self-extinguishing. Measured on a live board: six
 * wakes in one evening, `stalled=0` in every one, the unfiled count walking
 * 1→2→3→2→1 with three of those wakes inside five minutes.
 */
describe('a set that shrinks is not news', () => {
  function unfiled(id: string, quietMs = 30 * MIN) {
    return { id, title: `Decide ${id}`, bucket: 'blocked-on-owner-unfiled', quietMs };
  }

  it('says nothing when the lead files the ask the wake asked for', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.stalled = [];
    world.boards[0]!.unfiled = [unfiled('t-a'), unfiled('t-b')];
    nudger.tick();
    expect(sent).toHaveLength(1);

    // The lead does the one thing the wake asked for. The row leaves the list.
    world.boards[0]!.unfiled = [unfiled('t-b')];
    nudger.tick();

    expect(sent).toHaveLength(1);
  });

  it('still fires when a row arrives after one has left', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.stalled = [];
    world.boards[0]!.unfiled = [unfiled('t-a'), unfiled('t-b')];
    nudger.tick();
    world.boards[0]!.unfiled = [unfiled('t-b')];
    nudger.tick();
    expect(sent).toHaveLength(1);

    world.boards[0]!.unfiled = [unfiled('t-b'), unfiled('t-c')];
    nudger.tick();

    expect(sent).toHaveLength(2);
  });

  /**
   * A shrink is silent, but it is still RECORDED — otherwise the stamp would
   * keep naming a row that is no longer on the list, and the row coming back
   * would read as unchanged and never fire.
   */
  it('fires again when a row that left comes back', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.stalled = [];
    world.boards[0]!.unfiled = [unfiled('t-a'), unfiled('t-b')];
    nudger.tick();
    world.boards[0]!.unfiled = [unfiled('t-b')];
    nudger.tick();
    expect(sent).toHaveLength(1);

    world.boards[0]!.unfiled = [unfiled('t-a'), unfiled('t-b')];
    nudger.tick();

    expect(sent).toHaveLength(2);
  });

  it('does not fire when the board simply gets quieter', () => {
    const { world, sent, nudger } = harness({ repeatMs: 60 * MIN });
    world.boards[0]!.stalled = [
      { id: 't-old', title: 'Rank results by recency', bucket: 'in-progress', quietMs: 185 * MIN },
      { id: 't-young', title: 'Cache the facet counts', bucket: 'in-progress', quietMs: 30 * MIN },
    ];
    nudger.tick();
    expect(sent).toHaveLength(1);

    // The oldest row is picked up and worked. The board's escalation bucket
    // falls from 3 to 0 — a recovery, and recoveries are not announced.
    world.boards[0]!.stalled = [
      { id: 't-young', title: 'Cache the facet counts', bucket: 'in-progress', quietMs: 35 * MIN },
    ];
    nudger.tick();

    expect(sent).toHaveLength(1);
  });

  it('says nothing when a row that could not be read becomes readable', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.stalled = [];
    world.boards[0]!.undetermined = [
      { id: 't-3', reason: 'review-items-unreadable' },
      { id: 't-4', reason: 'review-items-unreadable' },
    ];
    nudger.tick();
    expect(sent).toHaveLength(1);

    world.boards[0]!.undetermined = [{ id: 't-4', reason: 'review-items-unreadable' }];
    nudger.tick();

    expect(sent).toHaveLength(1);
  });

  it('fires when a new row becomes unreadable', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.stalled = [];
    world.boards[0]!.undetermined = [{ id: 't-4', reason: 'review-items-unreadable' }];
    nudger.tick();

    world.boards[0]!.undetermined = [
      { id: 't-4', reason: 'review-items-unreadable' },
      { id: 't-5', reason: 'review-items-unreadable' },
    ];
    nudger.tick();

    expect(sent).toHaveLength(2);
  });
});

describe('a row that stays stalled is said again, eventually', () => {
  it('re-fires once the row has been quiet for another repeat window', () => {
    const { world, sent, nudger } = harness({ repeatMs: 60 * MIN });
    world.boards[0]!.stalled[0]!.quietMs = 45 * MIN;
    nudger.tick();
    expect(sent).toHaveLength(1);

    // Still inside the same window — silence.
    world.now += 10 * MIN;
    world.boards[0]!.stalled[0]!.quietMs = 55 * MIN;
    nudger.tick();
    expect(sent).toHaveLength(1);

    // Crossed into the next one. The escalation is intrinsic to how long the
    // row has been quiet rather than to a timer of its own, so a row that
    // recovers stops escalating without anything having to cancel it.
    world.now += 20 * MIN;
    world.boards[0]!.stalled[0]!.quietMs = 75 * MIN;
    nudger.tick();
    expect(sent).toHaveLength(2);
  });

  /**
   * The escalation window is the BOARD's, not each row's.
   *
   * A per-row bucket amortises catastrophically: every stalled row crosses its
   * own boundary at its own wall-clock moment, each crossing moves the stamp,
   * and the ceiling becomes one wake per row per window. Measured against real
   * boards at the time — 32 eligible rows on one, 24 on another — that is a
   * board re-waking its lead seven or eight times an hour, forever, with
   * nothing about it having changed.
   *
   * So the bucket comes from the OLDEST row: one re-wake per board per window,
   * with the row ids still in the stamp so a genuine set change fires at once.
   */
  it('does not re-fire when one row crosses a boundary the oldest has not', () => {
    const { world, sent, nudger } = harness({ repeatMs: 60 * MIN });
    world.boards[0]!.stalled = [
      // About to cross its own boundary…
      { id: 't-young', title: 'Cache the facet counts', bucket: 'in-progress', quietMs: 59 * MIN },
      // …while the oldest row sits well inside its own.
      { id: 't-old', title: 'Rank results by recency', bucket: 'in-progress', quietMs: 125 * MIN },
    ];
    nudger.tick();
    expect(sent).toHaveLength(1);

    world.now += 2 * MIN;
    world.boards[0]!.stalled[0]!.quietMs = 61 * MIN;
    world.boards[0]!.stalled[1]!.quietMs = 127 * MIN;
    nudger.tick();

    // The young row changed buckets. Nothing about the board did.
    expect(sent).toHaveLength(1);
  });

  it('re-fires when the OLDEST row crosses the next boundary', () => {
    const { world, sent, nudger } = harness({ repeatMs: 60 * MIN });
    world.boards[0]!.stalled = [
      { id: 't-young', title: 'Cache the facet counts', bucket: 'in-progress', quietMs: 10 * MIN },
      { id: 't-old', title: 'Rank results by recency', bucket: 'in-progress', quietMs: 175 * MIN },
    ];
    nudger.tick();
    expect(sent).toHaveLength(1);

    world.now += 10 * MIN;
    world.boards[0]!.stalled[0]!.quietMs = 20 * MIN;
    world.boards[0]!.stalled[1]!.quietMs = 185 * MIN;
    nudger.tick();

    expect(sent).toHaveLength(2);
  });

  it('still fires at once when the set itself changes inside a window', () => {
    const { world, sent, nudger } = harness({ repeatMs: 60 * MIN });
    world.boards[0]!.stalled = [
      { id: 't-old', title: 'Rank results by recency', bucket: 'in-progress', quietMs: 125 * MIN },
    ];
    nudger.tick();
    expect(sent).toHaveLength(1);

    // A board-level clock must not swallow a NEW stall — the ids are in the
    // stamp for exactly this.
    world.boards[0]!.stalled = [
      ...world.boards[0]!.stalled,
      {
        id: 't-new',
        title: 'Cache the facet counts',
        bucket: 'ready-unpicked',
        quietMs: 21 * MIN,
      },
    ];
    nudger.tick();

    expect(sent).toHaveLength(2);
  });

  it('defaults the repeat window to something coarser than the tick', () => {
    expect(STALL_REPEAT_DEFAULT_MS).toBeGreaterThan(60 * MIN);
  });
});

describe('who is never woken', () => {
  it('says nothing about a board with no stalled and no unfiled rows', () => {
    const { sent, nudger } = harness({
      world: {
        now: 1_000_000,
        boards: [board({ stalled: [], unfiled: [], undetermined: [] })],
        reachable: new Set(['agent-cartographer']),
      },
    });
    nudger.tick();
    expect(sent).toHaveLength(0);
  });

  it('never wakes a retired board', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.retired = true;
    nudger.tick();
    expect(sent).toHaveLength(0);
  });

  it('never wakes an empty lead seat', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.leadAgentId = undefined;
    nudger.tick();
    expect(sent).toHaveLength(0);
  });

  it('keeps the wake OWED when the lead holds no stream', () => {
    const { world, sent, nudger } = harness();
    world.reachable.clear();

    nudger.tick();
    expect(sent).toHaveLength(0);

    // The lead attaches. The board must not have decided it already told them
    // — a wake delivered to nobody is gone, not delivered.
    world.reachable.add('agent-cartographer');
    nudger.tick();
    expect(sent).toHaveLength(1);
  });

  it('survives a snapshot that throws rather than taking the timer down', () => {
    const sent: Sent[] = [];
    const nudger = new StallNudger({
      now: () => 1_000_000,
      snapshot: () => {
        throw new Error('store is mid-hydrate');
      },
      canReach: () => true,
      send: (workspaceId, agentId, frame) => {
        sent.push({ workspaceId, agentId, frame });
        return 1;
      },
    });
    expect(() => nudger.tick()).not.toThrow();
    expect(sent).toHaveLength(0);
  });
});

describe('rows waiting on a person with nothing filed', () => {
  it('wakes the lead about them even when nothing is stalled', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.stalled = [];
    world.boards[0]!.unfiled = [
      {
        id: 't-9',
        title: 'Pick a retention window',
        bucket: 'blocked-on-owner-unfiled',
        quietMs: 2 * 60 * MIN,
      },
    ];

    nudger.tick();

    expect(sent).toHaveLength(1);
    const frame = sent[0]?.frame as StallNudgeFrame;
    expect(frame.stalledCount).toBe(0);
    expect(frame.unfiled?.[0]?.id).toBe('t-9');
    // The frame still names a row to start with, and with nothing stalled it
    // is the unfiled one — a wake with no subject costs a turn and says
    // nothing.
    expect(frame.taskId).toBe('t-9');
  });
});

describe('rows the pass could not read', () => {
  it('wakes the lead even when nothing else is on the list', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.stalled = [];
    world.boards[0]!.undetermined = [{ id: 't-3', reason: 'review-items-unreadable' }];

    nudger.tick();

    expect(sent).toHaveLength(1);
    const frame = sent[0]?.frame as StallNudgeFrame;
    expect(frame.undetermined).toEqual({ count: 1, reasons: ['review-items-unreadable'] });
  });

  it('says so through the reporter when there is no lead to tell', () => {
    const { world, reported, nudger } = harness();
    world.boards[0]!.leadAgentId = undefined;
    world.boards[0]!.undetermined = [{ id: 't-3', reason: 'review-items-unreadable' }];

    nudger.tick();

    expect(reported.join('\n')).toContain('t-3');
  });
});

describe('the arming survives a restart', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('does not re-fire a wake a previous process already delivered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stall-nudge-'));
    dirs.push(dir);
    const stampFile = join(dir, 'stall-nudge-stamps.json');

    const first = harness({ stampFile });
    first.nudger.tick();
    expect(first.sent).toHaveLength(1);
    expect(JSON.parse(readFileSync(stampFile, 'utf8')).stamps['w-atlas']).toBeTruthy();

    // Prod restarts at every merge. Without the file each deploy would re-fire
    // one wake per board over a fact the lead had already been told.
    const second = harness({ stampFile });
    second.nudger.tick();
    expect(second.sent).toHaveLength(0);
  });

  it('starts clean rather than throwing when the file cannot be parsed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stall-nudge-'));
    dirs.push(dir);
    const stampFile = join(dir, 'stall-nudge-stamps.json');
    writeFileSync(stampFile, 'not json at all');

    const { sent, nudger } = harness({ stampFile });
    expect(() => nudger.tick()).not.toThrow();
    // One duplicate wake is the cheaper failure than a wake that never fires.
    expect(sent).toHaveLength(1);
  });
});

/**
 * Every DELIVERED wake leaves a line, so somebody can count what this feature
 * costs.
 *
 * The measurement it exists for is wakes per board per hour — a lead's turn is
 * the unit of spend here, and a loop that fires more often than anyone
 * realises is exactly the failure the arming rules were written against. A
 * count nobody can take is a claim nobody can check.
 *
 * It rides the injectable `report` rather than `console.error` for the same
 * reason the unevaluable notice does: a line only a human tailing a log can
 * see is a line no test can assert, and this one has to stay true as the
 * arming rules change around it.
 */
describe('every delivered wake is counted', () => {
  it('reports the board, the lead, and what the wake was about', () => {
    const { reported, nudger } = harness();

    nudger.tick();

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('w-atlas');
    expect(reported[0]).toContain('agent-cartographer');
    expect(reported[0]).toContain('stalled=1');
    expect(reported[0]).toContain('unfiled=0');
    expect(reported[0]).toContain('undetermined=0');
  });

  it('counts each list separately rather than as one total', () => {
    const { world, reported, nudger } = harness();
    world.boards[0]!.unfiled = [
      {
        id: 't-9',
        title: 'Pick a retention window',
        bucket: 'blocked-on-owner-unfiled',
        quietMs: 0,
      },
    ];
    world.boards[0]!.undetermined = [{ id: 't-3', reason: 'review-items-unreadable' }];

    nudger.tick();

    const wake = reported.find((line) => line.includes('wake'));
    expect(wake).toContain('stalled=1');
    expect(wake).toContain('unfiled=1');
    expect(wake).toContain('undetermined=1');
  });

  it('says nothing on a tick that delivers no wake', () => {
    const { world, reported, nudger } = harness();
    nudger.tick();
    expect(reported.filter((line) => line.includes('wake'))).toHaveLength(1);

    // Nothing has changed, so no wake is owed — and a line here would count a
    // turn nobody spent, which is the opposite of what the measurement is for.
    world.now += 5 * MIN;
    nudger.tick();
    world.now += 5 * MIN;
    nudger.tick();

    expect(reported.filter((line) => line.includes('wake'))).toHaveLength(1);
  });

  it('says nothing when the lead holds no stream', () => {
    const { world, reported, nudger } = harness();
    world.reachable.clear();

    nudger.tick();

    // The wake is still OWED, not spent — logging it would inflate the very
    // number this line exists to make honest.
    expect(reported.filter((line) => line.includes('wake'))).toHaveLength(0);
  });
});

describe('the timer', () => {
  it('starts and stops idempotently', () => {
    const { nudger } = harness();
    expect(nudger.running()).toBe(false);
    nudger.start(60_000);
    expect(nudger.running()).toBe(true);
    nudger.start(60_000);
    expect(nudger.running()).toBe(true);
    nudger.stop();
    nudger.stop();
    expect(nudger.running()).toBe(false);
  });
});

// ── A held review item is its own finding ────────────────────────────────────

describe('a held review item wakes its filer and then the lead — once each', () => {
  it('a quiet board with one overdue hold sends the lead a frame naming it', () => {
    const { world, sent, toFilers, nudger } = harness();
    world.boards = [board({ stalled: [], held: [HELD] })];
    world.reachable.add('agent-index-keeper');
    nudger.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.agentId).toBe('agent-cartographer');
    expect(sent[0]?.frame.event).toBe(STALL_EVENT);
    expect(sent[0]?.frame.heldItems).toEqual([HELD]);
    // The lead's next act is on the ticket, so the frame's subject is the ticket.
    expect(sent[0]?.frame.taskId).toBe('t-7');
    expect(toFilers).toHaveLength(1);
    expect(toFilers[0]?.agentId).toBe('agent-index-keeper');
    expect(toFilers[0]?.frame).toMatchObject({
      event: REVIEW_ITEM_HELD_EVENT,
      taskId: 't-7',
      reviewItemId: 'ri-1',
      reason: HELD.reason,
      overdue: true,
    });
  });

  it('does NOT complain again on the next pass while the same item stays held', () => {
    const { world, sent, toFilers, nudger } = harness();
    world.boards = [board({ stalled: [], held: [HELD] })];
    world.reachable.add('agent-index-keeper');
    nudger.tick();
    world.now += 3 * MIN;
    world.boards = [board({ stalled: [], held: [{ ...HELD, heldMs: 9 * MIN }] })];
    nudger.tick();
    expect(sent).toHaveLength(1);
    expect(toFilers).toHaveLength(1);
  });

  it('fires again for a second held item, and again for the same item held afresh', () => {
    const { world, sent, toFilers, nudger } = harness();
    world.boards = [board({ stalled: [], held: [HELD] })];
    world.reachable.add('agent-index-keeper');
    nudger.tick();
    // A second item on another ticket joins the held set: news.
    world.boards = [
      board({ stalled: [], held: [HELD, { ...HELD, id: 't-8', reviewItemId: 'ri-2' }] }),
    ];
    nudger.tick();
    expect(sent).toHaveLength(2);
    expect(toFilers.map((f) => f.frame.reviewItemId)).toEqual(['ri-1', 'ri-2']);
    // The first item is revised, judged ok, then held again on a later
    // revision: the filer hears about the new hold, because the old one
    // left the set in between.
    world.boards = [board({ stalled: [], held: [{ ...HELD, id: 't-8', reviewItemId: 'ri-2' }] })];
    nudger.tick();
    world.boards = [
      board({ stalled: [], held: [{ ...HELD, id: 't-8', reviewItemId: 'ri-2' }, HELD] }),
    ];
    nudger.tick();
    expect(toFilers.map((f) => f.frame.reviewItemId)).toEqual(['ri-1', 'ri-2', 'ri-1']);
  });

  // Found by codex review: stamping held rows by ticket alone meant a second
  // item held on a ticket the lead had already heard about was not news.
  it('a second item held on the SAME ticket is news to the lead', () => {
    const { world, sent, nudger } = harness();
    world.boards = [board({ stalled: [], held: [HELD] })];
    nudger.tick();
    world.boards = [board({ stalled: [], held: [HELD, { ...HELD, reviewItemId: 'ri-2' }] })];
    nudger.tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.frame.heldItems?.map((r) => r.reviewItemId)).toEqual(['ri-1', 'ri-2']);
    // And the same ticket going quiet over the same held ask is NOT.
    world.boards = [
      board({
        stalled: [{ id: 't-7', title: HELD.title, bucket: 'in-progress', quietMs: 45 * MIN }],
        held: [HELD, { ...HELD, reviewItemId: 'ri-2' }],
      }),
    ];
    nudger.tick();
    expect(sent).toHaveLength(2);
  });

  // Found by codex review: a filer that dropped between the reachability
  // check and the send got nothing, and was marked told forever.
  it('a filer nudge that reached nobody is not "told" — the next pass tries again', () => {
    let delivers = 0;
    const { world, toFilers, nudger } = harness({ filerDelivers: () => delivers });
    world.boards = [board({ stalled: [], held: [HELD] })];
    world.reachable.add('agent-index-keeper');
    nudger.tick();
    expect(toFilers).toHaveLength(1);
    delivers = 1;
    nudger.tick();
    expect(toFilers).toHaveLength(2);
    nudger.tick();
    expect(toFilers).toHaveLength(2);
  });

  it('an unreachable filer is skipped, not marked told — the next pass tries again', () => {
    const { world, sent, toFilers, nudger } = harness();
    world.boards = [board({ stalled: [], held: [HELD] })];
    nudger.tick();
    expect(sent).toHaveLength(1);
    expect(toFilers).toHaveLength(0);
    world.reachable.add('agent-index-keeper');
    nudger.tick();
    expect(toFilers).toHaveLength(1);
  });

  it('a retired board holds nothing', () => {
    const { world, sent, toFilers, nudger } = harness();
    world.boards = [board({ stalled: [], held: [HELD], retired: true })];
    world.reachable.add('agent-index-keeper');
    nudger.tick();
    expect(sent).toHaveLength(0);
    expect(toFilers).toHaveLength(0);
  });
});
