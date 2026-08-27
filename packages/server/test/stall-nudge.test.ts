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

function harness(opts: { repeatMs?: number; stampFile?: string; world?: World } = {}) {
  const world: World = opts.world ?? {
    now: 1_000_000,
    boards: [board()],
    reachable: new Set(['agent-cartographer']),
  };
  const sent: Sent[] = [];
  const reported: string[] = [];
  const nudger = new StallNudger({
    now: () => world.now,
    snapshot: () => world.boards,
    canReach: (_workspaceId, agentId) => world.reachable.has(agentId),
    send: (workspaceId, agentId, frame) => {
      sent.push({ workspaceId, agentId, frame });
      return 1;
    },
    report: (line) => reported.push(line),
    ...(opts.repeatMs !== undefined ? { repeatMs: opts.repeatMs } : {}),
    ...(opts.stampFile !== undefined ? { stampFile: opts.stampFile } : {}),
  });
  return { world, sent, reported, nudger };
}

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
