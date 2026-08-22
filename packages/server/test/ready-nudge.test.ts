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
import { describe, expect, it } from 'bun:test';
import {
  type NudgeFrame,
  READY_IDLE_DEFAULT_MS,
  ReadyWorkNudger,
  type ReadyWorkSnapshot,
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
    lastActivityAt: 0,
    ...over,
  };
}

/** A nudger over a mutable world, with everything reachable and nothing real. */
function harness(opts: { idleMs?: number } = {}) {
  const world = {
    now: 1_000_000,
    boards: [board()] as ReadyWorkSnapshot[],
    reachable: new Set<string>(['agent-cartographer']),
  };
  const sent: Sent[] = [];
  const nudger = new ReadyWorkNudger({
    now: () => world.now,
    snapshot: () => world.boards,
    lookup: (workspaceId) => world.boards.find((b) => b.workspaceId === workspaceId),
    canReach: (_workspaceId, agentId) => world.reachable.has(agentId),
    send: (workspaceId, agentId, frame) => {
      sent.push({ workspaceId, agentId, frame });
      return 1;
    },
    ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
  });
  return { world, sent, nudger };
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
