/**
 * The board waking its lead — ready work that has sat still, and answers
 * that have just landed.
 *
 * The thing under test is not "does a frame go out". It is the FRUGALITY:
 * a nudge that repeats every tick while nothing changes trains the lead to
 * ignore it and bills a wake turn each time. So most of what is asserted
 * here is silence — the second tick, the retired board, the board with no
 * ready work, the lead who is not on the wire.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type NudgeFrame,
  READY_IDLE_DEFAULT_MS,
  ReadyWorkNudger,
  type ReadyWorkSnapshot,
  isBoardActivity,
} from '../src/ready-nudge.ts';

const MIN = 60_000;

interface Sent {
  workspaceId: string;
  agentId: string;
  /** The real wire type rather than a hand-copy of it. The copy that stood
   *  here had already drifted — a `reason` field the frame never had, and
   *  none of the fields the plugin's renderer reads. */
  frame: NudgeFrame;
}

function board(over: Partial<ReadyWorkSnapshot> = {}): ReadyWorkSnapshot {
  return {
    workspaceId: 'w-search',
    leadAgentId: 'agent-cartographer',
    retired: false,
    ready: [{ id: 't-1', title: 'Rank results by recency' }],
    // The gate's own report of the pass that produced `ready`. Required on the
    // snapshot rather than defaulted, deliberately: a producer that forgets to
    // say what it examined would report every board as fully evaluated, which
    // is the reading this whole feature exists to stop being free.
    considered: 1,
    held: {},
    undetermined: [],
    lastActivityAt: 0,
    ...over,
  };
}

/** A nudger over a mutable world, with everything reachable and nothing real. */
function harness(opts: { idleMs?: number; stampFile?: string; world?: World } = {}) {
  const world: World = opts.world ?? {
    now: 1_000_000,
    boards: [board()] as ReadyWorkSnapshot[],
    reachable: new Set<string>(['agent-cartographer']),
  };
  const sent: Sent[] = [];
  const reported: string[] = [];
  const nudger = new ReadyWorkNudger({
    now: () => world.now,
    snapshot: () => world.boards,
    lookup: (workspaceId) => world.boards.find((b) => b.workspaceId === workspaceId),
    canReach: (_workspaceId, agentId) => world.reachable.has(agentId),
    send: (workspaceId, agentId, frame) => {
      sent.push({ workspaceId, agentId, frame });
      return 1;
    },
    report: (line) => reported.push(line),
    ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
    ...(opts.stampFile !== undefined ? { stampFile: opts.stampFile } : {}),
  });
  return { world, sent, reported, nudger };
}

interface World {
  now: number;
  boards: ReadyWorkSnapshot[];
  reachable: Set<string>;
}

describe('ready work that has sat idle wakes the lead — once', () => {
  it('fires exactly one nudge to the lead once the idle window has passed', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.lastActivityAt = world.now - 20 * MIN;

    nudger.tick();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.agentId).toBe('agent-cartographer');
    expect(sent[0]!.workspaceId).toBe('w-search');
    expect(sent[0]!.frame.event).toBe('workspace.ready_idle');
    // The MCP renders an unrecognised hub event off `taskId` alone, so the
    // top ready row has to ride the frame or the wake says nothing.
    expect(sent[0]!.frame.taskId).toBe('t-1');
    expect(sent[0]!.frame.readyCount).toBe(1);
  });

  it('does NOT re-fire on a later tick while nothing has changed', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.lastActivityAt = world.now - 20 * MIN;

    nudger.tick();
    world.now += 20 * MIN;
    nudger.tick();
    world.now += 20 * MIN;
    nudger.tick();

    expect(sent).toHaveLength(1);
  });

  it('stays quiet until the idle window has actually passed', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.lastActivityAt = world.now - 5 * MIN;

    nudger.tick();
    expect(sent).toHaveLength(0);

    world.now += 11 * MIN;
    nudger.tick();
    expect(sent).toHaveLength(1);
  });

  it('arms again once activity resets the clock and the board goes idle anew', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.lastActivityAt = world.now - 20 * MIN;
    nudger.tick();
    expect(sent).toHaveLength(1);

    // Somebody worked the board. The clock resets, the nudge disarms.
    nudger.noteActivity('w-search', world.now);
    nudger.tick();
    expect(sent).toHaveLength(1);

    // …and it sat still again.
    world.now += 20 * MIN;
    nudger.tick();
    expect(sent).toHaveLength(2);
  });

  it('arms again when the ready set changes materially', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.lastActivityAt = world.now - 20 * MIN;
    nudger.tick();
    expect(sent).toHaveLength(1);

    world.boards[0]!.ready = [
      { id: 't-1', title: 'Rank results by recency' },
      { id: 't-2', title: 'Cache the facet counts' },
    ];
    world.now += MIN;
    nudger.tick();

    expect(sent).toHaveLength(2);
    expect(sent[1]!.frame.readyCount).toBe(2);
  });

  it('takes the LATER of the store clock and observed activity', () => {
    const { world, sent, nudger } = harness();
    // The store's own record is stale, but something happened a minute ago.
    world.boards[0]!.lastActivityAt = world.now - 20 * MIN;
    nudger.noteActivity('w-search', world.now - MIN);

    nudger.tick();
    expect(sent).toHaveLength(0);
  });
});

describe('boards that must never be woken', () => {
  it('says nothing when there is no ready work', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.ready = [];
    world.boards[0]!.lastActivityAt = world.now - 20 * MIN;

    nudger.tick();

    expect(sent).toHaveLength(0);
  });

  it('never nudges a retired workspace', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.retired = true;
    world.boards[0]!.lastActivityAt = world.now - 20 * MIN;

    nudger.tick();

    expect(sent).toHaveLength(0);
  });

  it('says nothing when the lead seat is empty', () => {
    const { world, sent, nudger } = harness();
    // Rebuilt without the key rather than set to undefined: an empty seat is
    // an ABSENT addressee, which is the shape the store hands over.
    const { leadAgentId: _seat, ...leaderless } = board();
    world.boards[0] = { ...leaderless, lastActivityAt: world.now - 20 * MIN };

    nudger.tick();

    expect(sent).toHaveLength(0);
  });

  it('holds the nudge — rather than spending it — while the lead is off the wire', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.lastActivityAt = world.now - 20 * MIN;
    world.reachable.clear();

    nudger.tick();
    expect(sent).toHaveLength(0);

    // The lead comes back to a board that is still idle: the wake is still owed.
    world.reachable.add('agent-cartographer');
    nudger.tick();
    expect(sent).toHaveLength(1);
  });

  it('forgets a workspace that has gone away rather than growing a map forever', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.lastActivityAt = world.now - 20 * MIN;
    nudger.tick();
    expect(sent).toHaveLength(1);

    world.boards = [];
    nudger.tick();
    expect(nudger.armedCount()).toBe(0);

    // Same board back, same state: a fresh nudger owes a fresh wake.
    world.boards = [board({ lastActivityAt: world.now - 20 * MIN })];
    nudger.tick();
    expect(sent).toHaveLength(2);
  });
});

describe('a wake states what the pass examined, not just what it found', () => {
  it('carries the denominator and the held breakdown onto the frame', () => {
    const { world, sent, nudger } = harness();
    world.boards[0] = board({
      lastActivityAt: world.now - 20 * MIN,
      considered: 5,
      held: { 'awaiting-person': 2, backlog: 1, blocked: 1 },
    });

    nudger.tick();

    expect(sent).toHaveLength(1);
    const frame = sent[0]!.frame;
    expect(frame.readyCount).toBe(1);
    // Without this, "1 task is ready" is indistinguishable on a board with one
    // row and on a board with five whose other four are waiting on Bryan.
    expect(frame.consideredCount).toBe(5);
    expect(frame.held).toEqual({ 'awaiting-person': 2, backlog: 1, blocked: 1 });
    expect(frame.undetermined).toBeUndefined();
  });

  it('omits the held breakdown rather than sending an empty one', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.lastActivityAt = world.now - 20 * MIN;

    nudger.tick();

    expect(sent[0]!.frame.held).toBeUndefined();
    expect(sent[0]!.frame.consideredCount).toBe(1);
  });
});

describe('a pass that could not evaluate a row says so', () => {
  const unreadable = (over: Partial<ReadyWorkSnapshot> = {}) =>
    board({
      ready: [],
      considered: 1,
      undetermined: [{ id: 't-9', reason: 'review-items-unreadable' }],
      ...over,
    });

  it('wakes the lead about a board it could not read, even with nothing ready', () => {
    // The failure this closes: `ready.length === 0` used to mean "quiet
    // board, say nothing" whether the gate had read every row and found them
    // all healthy, or had failed to read any of them. Those two must not
    // arrive as the same silence.
    const { world, sent, nudger } = harness();
    world.boards[0] = unreadable({ lastActivityAt: world.now - 20 * MIN });

    nudger.tick();

    expect(sent).toHaveLength(1);
    const frame = sent[0]!.frame;
    expect(frame.readyCount).toBe(0);
    expect(frame.undetermined).toEqual({
      count: 1,
      reasons: ['review-items-unreadable'],
    });
    // No subject to start with — the frame must not invent one.
    expect(frame.taskId).toBeUndefined();
  });

  it('still says nothing when the pass read every row and found none ready', () => {
    // The positive control for the test above: silence has to remain the
    // answer on a board that was fully evaluated, or the new clause turns
    // every quiet board into a wake.
    const { world, sent, nudger } = harness();
    world.boards[0] = board({ ready: [], considered: 3, held: { claimed: 3 } });
    world.boards[0]!.lastActivityAt = world.now - 20 * MIN;

    nudger.tick();

    expect(sent).toHaveLength(0);
  });

  it('does not repeat itself while the unreadable set is unchanged', () => {
    const { world, sent, nudger } = harness();
    world.boards[0] = unreadable({ lastActivityAt: world.now - 20 * MIN });

    nudger.tick();
    world.now += 20 * MIN;
    nudger.tick();
    world.now += 20 * MIN;
    nudger.tick();

    expect(sent).toHaveLength(1);
  });

  it('fires again when a DIFFERENT row becomes unreadable', () => {
    const { world, sent, nudger } = harness();
    world.boards[0] = unreadable({ lastActivityAt: world.now - 20 * MIN });
    nudger.tick();
    expect(sent).toHaveLength(1);

    world.boards[0] = unreadable({
      lastActivityAt: world.now - 20 * MIN,
      undetermined: [{ id: 't-11', reason: 'owner-kind-unreadable' }],
    });
    nudger.tick();

    expect(sent).toHaveLength(2);
  });

  it('reports the condition even when the lead is off the wire', () => {
    // A wake that reached nobody is the case where the frame proves nothing.
    // A monitor with no reader is indistinguishable from no monitor, so the
    // condition has to land somewhere a person can still find it.
    const { world, sent, reported, nudger } = harness();
    world.boards[0] = unreadable({ lastActivityAt: world.now - 20 * MIN });
    world.reachable.clear();

    nudger.tick();

    expect(sent).toHaveLength(0);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('w-search');
    expect(reported[0]).toContain('review-items-unreadable');
  });

  it('reports once per condition rather than once per tick', () => {
    // The other half of the same lesson: an archiver that logged 395
    // identical hourly failures had a reader, and the reader had learned
    // there was nothing to read.
    const { world, reported, nudger } = harness();
    world.boards[0] = unreadable({ lastActivityAt: world.now - 20 * MIN });
    world.reachable.clear();

    nudger.tick();
    world.now += 20 * MIN;
    nudger.tick();
    world.now += 20 * MIN;
    nudger.tick();

    expect(reported).toHaveLength(1);
  });

  it('names the rows it could read alongside the one it could not', () => {
    const { world, sent, nudger } = harness();
    world.boards[0] = board({
      lastActivityAt: world.now - 20 * MIN,
      considered: 2,
      undetermined: [{ id: 't-9', reason: 'owner-kind-unreadable' }],
    });

    nudger.tick();

    const frame = sent[0]!.frame;
    expect(frame.taskId).toBe('t-1');
    expect(frame.readyCount).toBe(1);
    expect(frame.undetermined).toEqual({ count: 1, reasons: ['owner-kind-unreadable'] });
  });
});

/**
 * The instrument that can kill this feature.
 *
 * The stopping rule "if the gate suppresses everything, delete the nudge"
 * cannot fire on its own, because nobody notices a nudge that stopped
 * appearing — it would sit in forever on the grounds that nothing disproved
 * it. That is the same failure the gate itself was built out of: a checker
 * that ran 22 times with 116 unread RED lines, an archiver that logged 395
 * identical hourly failures. A stopping rule with no instrument is not a
 * stopping rule.
 *
 * So both outcomes are counted, per condition, and the verdict FIRES ITSELF
 * rather than waiting to be looked up.
 */
describe('the nudge counts what it suppressed and what it delivered', () => {
  const DAY = 24 * 60 * 60_000;

  it('counts a delivered nudge as passed', () => {
    const { world, nudger } = harness();
    world.boards[0]!.lastActivityAt = world.now - 20 * MIN;

    nudger.tick();

    expect(nudger.tally().passed).toBe(1);
    expect(nudger.tally().suppressed).toEqual({});
  });

  it('counts the rows it withheld, by condition', () => {
    const { world, nudger } = harness();
    world.boards[0] = board({
      lastActivityAt: world.now - 20 * MIN,
      ready: [],
      considered: 4,
      held: { 'awaiting-person': 2, backlog: 1, blocked: 1 },
    });

    nudger.tick();

    // "4 suppressed, all backlog" and "4 suppressed across three conditions"
    // are different findings, so the breakdown is what is kept.
    expect(nudger.tally().suppressed).toEqual({ 'awaiting-person': 2, backlog: 1, blocked: 1 });
    expect(nudger.tally().passed).toBe(0);
  });

  it('counts a row it could not evaluate as its own condition', () => {
    const { world, nudger } = harness();
    world.boards[0] = board({
      lastActivityAt: world.now - 20 * MIN,
      ready: [],
      considered: 1,
      undetermined: [{ id: 't-9', reason: 'review-items-unreadable' }],
    });

    nudger.tick();

    expect(nudger.tally().suppressed).toEqual({ undetermined: 1 });
  });

  it('counts one board state once, not once per tick', () => {
    // The tick runs every 60 seconds forever. Counting per tick would make
    // "suppressed 1,440" a statement about the clock rather than about the
    // board, which is the exact confusion this whole change removes.
    const { world, nudger } = harness();
    world.boards[0] = board({
      lastActivityAt: world.now - 20 * MIN,
      ready: [],
      considered: 1,
      held: { backlog: 1 },
    });

    nudger.tick();
    world.now += 20 * MIN;
    nudger.tick();
    world.now += 20 * MIN;
    nudger.tick();

    expect(nudger.tally().suppressed).toEqual({ backlog: 1 });
  });

  it('counts again once the board has actually moved', () => {
    const { world, nudger } = harness();
    world.boards[0] = board({
      lastActivityAt: world.now - 20 * MIN,
      ready: [],
      considered: 1,
      held: { backlog: 1 },
    });
    nudger.tick();

    world.boards[0] = board({
      lastActivityAt: world.now - 10 * MIN,
      ready: [],
      considered: 1,
      held: { backlog: 1 },
    });
    world.now += 20 * MIN;
    nudger.tick();

    expect(nudger.tally().suppressed).toEqual({ backlog: 2 });
  });

  it('declares the nudge deletable after seven days of suppressing and never firing', () => {
    const { world, reported, nudger } = harness();
    world.boards[0] = board({
      lastActivityAt: world.now - 20 * MIN,
      ready: [],
      considered: 1,
      held: { backlog: 1 },
    });
    nudger.tick();
    expect(reported).toHaveLength(0);

    world.now += 7 * DAY;
    nudger.tick();

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('suppressed');
    expect(reported[0]).toContain('never fired');
    expect(reported[0]).toContain('delete');
    // The window rolls, so the next seven days are measured fresh rather than
    // re-announcing the same verdict every tick forever.
    expect(nudger.tally().passed).toBe(0);
    expect(nudger.tally().suppressed).toEqual({});
  });

  it('says nothing at the seven-day mark when the nudge has actually fired', () => {
    // The positive control for the verdict: a nudge that delivers must not be
    // declared dead, or the instrument recommends deleting every feature.
    const { world, reported, nudger } = harness();
    world.boards[0]!.lastActivityAt = world.now - 20 * MIN;
    nudger.tick();
    expect(nudger.tally().passed).toBe(1);

    world.now += 7 * DAY;
    nudger.tick();

    expect(reported).toHaveLength(0);
  });

  it('says nothing at the seven-day mark when it has suppressed nothing either', () => {
    // An idle install proves nothing in either direction. Declaring it dead
    // would be a verdict reached from no evidence, which is the shape of
    // reasoning this instrument exists to replace.
    const { world, reported, nudger } = harness();
    world.boards = [];

    world.now += 7 * DAY;
    nudger.tick();

    expect(reported).toHaveLength(0);
  });

  it('keeps the seven-day window running across a restart', () => {
    // Prod restarts at every merge — several times a day. A window that began
    // again at each start would never close, so the stopping rule would be
    // unreachable by construction and nobody would ever know.
    const dir = mkdtempSync(join(tmpdir(), 'nudge-tally-'));
    const stampFile = join(dir, 'stamps.json');
    try {
      const first = harness({ stampFile });
      first.world.boards[0] = board({
        lastActivityAt: first.world.now - 20 * MIN,
        ready: [],
        considered: 1,
        held: { backlog: 1 },
      });
      first.nudger.tick();
      const since = first.nudger.tally().since;

      const second = harness({
        stampFile,
        world: {
          now: first.world.now + 7 * DAY,
          boards: [
            board({
              lastActivityAt: first.world.now - 20 * MIN,
              ready: [],
              considered: 1,
              held: { backlog: 1 },
            }),
          ],
          reachable: new Set<string>(['agent-cartographer']),
        },
      });
      expect(second.nudger.tally().since).toBe(since);
      expect(second.nudger.tally().suppressed).toEqual({ backlog: 1 });

      second.nudger.tick();
      expect(second.reported).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts a fresh window rather than throwing on a stamp file that predates the tally', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nudge-tally-old-'));
    const stampFile = join(dir, 'stamps.json');
    try {
      writeFileSync(stampFile, JSON.stringify({ version: 1, stamps: { 'w-search': '0|t-1' } }));
      const { world, nudger } = harness({ stampFile });

      // The stamps still load — a format bump must not cost every board its
      // arming and bill each lead a duplicate wake.
      expect(nudger.armedCount()).toBe(1);
      expect(nudger.tally().since).toBe(world.now);
      expect(nudger.tally().passed).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an answered review item wakes the lead immediately', () => {
  it('fires without waiting for the idle window', () => {
    const { world, sent, nudger } = harness();
    nudger.noteActivity('w-search', world.now);

    nudger.reviewAnswered({
      workspaceId: 'w-search',
      taskId: 't-1',
      actorId: 'user-jordan',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.frame.event).toBe('workspace.review_answered');
    expect(sent[0]!.frame.taskId).toBe('t-1');
    expect(sent[0]!.agentId).toBe('agent-cartographer');
  });

  // The plugin renders this frame as a sentence, and the id alone makes the
  // recipient call `get_task` before it can tell whether the wake was worth
  // the turn. The caller resolves the name; the nudger only carries it.
  it('carries the row’s name when the caller resolved one', () => {
    const { sent, nudger } = harness();

    nudger.reviewAnswered({
      workspaceId: 'w-search',
      taskId: 't-1',
      taskTitle: 'Ship the search revamp',
      actorId: 'user-jordan',
    });

    expect(sent[0]!.frame.title).toBe('Ship the search revamp');
  });

  it('omits the name rather than inventing one when the caller had none', () => {
    const { sent, nudger } = harness();

    nudger.reviewAnswered({ workspaceId: 'w-search', taskId: 't-1', actorId: 'user-jordan' });

    expect(sent[0]!.frame.title).toBeUndefined();
  });

  it('does not wake the lead for the lead’s own answer', () => {
    const { sent, nudger } = harness();

    nudger.reviewAnswered({
      workspaceId: 'w-search',
      taskId: 't-1',
      actorId: 'agent-cartographer',
    });

    expect(sent).toHaveLength(0);
  });

  it('never wakes a retired board', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.retired = true;

    nudger.reviewAnswered({ workspaceId: 'w-search', taskId: 't-1', actorId: 'user-jordan' });

    expect(sent).toHaveLength(0);
  });

  it('says nothing for a workspace it has never heard of', () => {
    const { sent, nudger } = harness();

    nudger.reviewAnswered({ workspaceId: 'w-gone', taskId: 't-9', actorId: 'user-jordan' });

    expect(sent).toHaveLength(0);
  });

  it('counts as activity, so the idle nudge does not pile on top of it', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.lastActivityAt = world.now - 20 * MIN;

    nudger.reviewAnswered({ workspaceId: 'w-search', taskId: 't-1', actorId: 'user-jordan' });
    expect(sent).toHaveLength(1);

    nudger.tick();
    expect(sent).toHaveLength(1);
  });
});

describe('the timer', () => {
  it('defaults to a fifteen-minute idle window', () => {
    expect(READY_IDLE_DEFAULT_MS).toBe(15 * MIN);
  });

  it('never holds the process open, and stops cleanly twice', () => {
    const { nudger } = harness();
    nudger.start(50);
    nudger.stop();
    // A second stop is what a shutdown path that already cleared the timer
    // does; it must not throw.
    nudger.stop();
    expect(nudger.running()).toBe(false);
  });

  it('does not fire during or after shutdown', async () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.lastActivityAt = world.now - 20 * MIN;
    nudger.start(5);
    nudger.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toHaveLength(0);
  });

  it('survives a snapshot that throws — a wake must never take the server down', () => {
    const sent: Sent[] = [];
    const nudger = new ReadyWorkNudger({
      now: () => 1_000_000,
      snapshot: () => {
        throw new Error('store mid-hydrate');
      },
      lookup: () => undefined,
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

/**
 * The armed map is the whole frugality mechanism, and until now it lived only
 * in this process — so every deploy restart handed each idle board a clean
 * slate and re-fired one nudge per board over facts the lead had already been
 * told. The stamp is durable by construction (`<last activity>|<ready ids>`,
 * both read off the store), so the only thing missing was somewhere to keep it.
 */
describe('an armed stamp survives a restart', () => {
  let dir: string;
  const stampPath = () => join(dir, 'ready-nudge-stamps.json');
  const freshDir = () => {
    dir = mkdtempSync(join(tmpdir(), 'nudge-stamps-'));
    return stampPath();
  };

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('does not re-fire the same nudge after the process restarts', () => {
    const file = freshDir();
    const first = harness({ stampFile: file });
    first.world.boards[0]!.lastActivityAt = first.world.now - 20 * MIN;
    first.nudger.tick();
    expect(first.sent).toHaveLength(1);

    // A deploy. Same data dir, same board, a brand-new nudger with an empty
    // `observed` map — which is exactly the state a restart produces.
    const second = harness({ stampFile: file, world: first.world });
    second.nudger.tick();

    expect(second.sent).toHaveLength(0);
  });

  it('still fires after a restart when the board has moved on', () => {
    const file = freshDir();
    const first = harness({ stampFile: file });
    first.world.boards[0]!.lastActivityAt = first.world.now - 20 * MIN;
    first.nudger.tick();
    expect(first.sent).toHaveLength(1);

    // A second row became ready while the server was down. The stamp on disk
    // describes a board that no longer exists, so the wake is owed again.
    first.world.boards[0]!.ready = [
      { id: 't-1', title: 'Rank results by recency' },
      { id: 't-2', title: 'Cache the facet counts' },
    ];
    const second = harness({ stampFile: file, world: first.world });
    second.nudger.tick();

    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]!.frame.readyCount).toBe(2);
  });

  it('starts empty — and still nudges — when the file on disk is corrupt', () => {
    const file = freshDir();
    writeFileSync(file, '{ this is not json');

    const { world, sent, nudger } = harness({ stampFile: file });
    world.boards[0]!.lastActivityAt = world.now - 20 * MIN;
    nudger.tick();

    // A stamp file that cannot be read must cost at most one duplicate wake,
    // never the wake itself.
    expect(sent).toHaveLength(1);
    expect(nudger.armedCount()).toBe(1);
  });

  it('writes nothing anyone else has to clean up when a board disappears', () => {
    const file = freshDir();
    const first = harness({ stampFile: file });
    first.world.boards[0]!.lastActivityAt = first.world.now - 20 * MIN;
    first.nudger.tick();
    expect(JSON.parse(readFileSync(file, 'utf8')).stamps['w-search']).toBeString();

    // The board was deleted. The pruning that already keeps the in-memory map
    // bounded has to reach the file too, or it grows for the life of the
    // install.
    first.world.boards = [];
    first.nudger.tick();

    expect(JSON.parse(readFileSync(file, 'utf8')).stamps['w-search']).toBeUndefined();
  });

  it('keeps working with no stamp file configured at all', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.lastActivityAt = world.now - 20 * MIN;
    nudger.tick();
    nudger.tick();
    expect(sent).toHaveLength(1);
  });
});

describe('a task captured from a meeting wakes the lead immediately', () => {
  it('fires a ready_idle frame naming the row, without the idle window', () => {
    const { world, sent, nudger } = harness();
    nudger.noteActivity('w-search', world.now);

    nudger.taskReady({
      workspaceId: 'w-search',
      taskId: 't-cap',
      taskTitle: 'Strip overlaps navbar on short screens',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.frame.event).toBe('workspace.ready_idle');
    expect(sent[0]!.frame.taskId).toBe('t-cap');
    expect(sent[0]!.frame.title).toBe('Strip overlaps navbar on short screens');
    expect(sent[0]!.agentId).toBe('agent-cartographer');
  });

  it('never wakes a retired board or an empty lead seat', () => {
    const { world, sent, nudger } = harness();
    world.boards[0]!.retired = true;
    nudger.taskReady({ workspaceId: 'w-search', taskId: 't-cap', taskTitle: 'x' });
    world.boards[0]!.retired = false;
    const { leadAgentId: _seat, ...emptySeat } = world.boards[0]!;
    world.boards[0] = emptySeat;
    nudger.taskReady({ workspaceId: 'w-search', taskId: 't-cap', taskTitle: 'x' });
    expect(sent).toHaveLength(0);
  });

  it('an unreachable lead gets nothing rather than a frame into the void', () => {
    const { world, sent, nudger } = harness();
    world.reachable.clear();
    nudger.taskReady({ workspaceId: 'w-search', taskId: 't-cap', taskTitle: 'x' });
    expect(sent).toHaveLength(0);
  });
});

describe('isBoardActivity — what restarts a board’s idle clock', () => {
  it('counts a row moving and not liveness: agent.* and the per-turn note', () => {
    // A builder ending turns while nothing on the board changes is exactly
    // the state the ready-idle wake exists to catch.
    for (const type of [
      'task.created',
      'task.transitioned',
      'decision.answered',
      'workspace.goals_changed',
    ]) {
      expect(isBoardActivity(type), type).toBe(true);
    }
    for (const type of ['agent.attached', 'agent.heartbeat', 'agent.detached', 'task.noted']) {
      expect(isBoardActivity(type), type).toBe(false);
    }
  });
});
