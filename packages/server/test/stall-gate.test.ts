/**
 * Which rows the stall loop may name.
 *
 * The gate is a thin reading of `keep-moving.ts` on purpose — that module
 * already decides what "stalled" means and is the instrument the project uses
 * to judge whether the protocol is working. What is asserted here is the part
 * the gate adds on top: the rows it must REFUSE to name, and the rows it could
 * not read at all.
 *
 * All fixtures are synthetic — invented titles, no real board state. The repo
 * is public.
 */
import { describe, expect, it } from 'bun:test';
import type { EventRow, ReviewItemRow, TaskRow } from '../src/keep-moving.ts';
import {
  BUILDER_SILENT_BUCKET,
  BUILDER_SILENT_MULTIPLIER_DEFAULT,
  HELD_ITEM_DEFAULT_MS,
  STALL_QUIET_DEFAULT_MS,
  evaluateStalls,
  overdueHeldItems,
} from '../src/stall-gate.ts';

const MIN = 60_000;
const now = 1_000 * MIN;

const bands = { dispatchable: new Set(['g1']), ownerBand: new Set(['decisions']) };

function task(over: Partial<TaskRow> & { id: string }): TaskRow {
  return {
    title: 'Rank results by recency',
    status: 'in-progress',
    goal: 'g1',
    createdAt: now - 200 * MIN,
    transitions: [{ ts: now - 200 * MIN, to: 'in-progress' }],
    ownerKind: 'agent',
    ...over,
  };
}

function evaluate(
  over: {
    tasks?: TaskRow[];
    events?: EventRow[];
    reviewItems?: ReviewItemRow[];
    unreadableReviewTaskIds?: Set<string>;
    quietMs?: number;
    watchingDispatchTaskIds?: Set<string>;
    builderSilentMultiplier?: number;
    threadActivity?: Map<string, number>;
  } = {},
) {
  return evaluateStalls({
    tasks: over.tasks ?? [task({ id: 't-1' })],
    events: over.events ?? [],
    reviewItems: over.reviewItems ?? [],
    bands,
    now,
    ...(over.unreadableReviewTaskIds
      ? { unreadableReviewTaskIds: over.unreadableReviewTaskIds }
      : {}),
    ...(over.quietMs !== undefined ? { quietMs: over.quietMs } : {}),
    ...(over.watchingDispatchTaskIds
      ? { watchingDispatchTaskIds: over.watchingDispatchTaskIds }
      : {}),
    ...(over.builderSilentMultiplier !== undefined
      ? { builderSilentMultiplier: over.builderSilentMultiplier }
      : {}),
    ...(over.threadActivity ? { threadActivity: over.threadActivity } : {}),
  });
}

describe('a row that has gone quiet is named', () => {
  it('names an in-progress row nothing has touched for longer than the window', () => {
    const verdict = evaluate();
    expect(verdict.stalled).toHaveLength(1);
    expect(verdict.stalled[0]?.id).toBe('t-1');
    expect(verdict.stalled[0]?.bucket).toBe('in-progress');
    // The lead is deciding whether to intervene, so how long it has been
    // quiet has to ride along — the id alone cannot make that call.
    expect(verdict.stalled[0]?.quietMs).toBeGreaterThan(STALL_QUIET_DEFAULT_MS);
  });

  it('names a todo row that nothing has picked up', () => {
    const verdict = evaluate({
      tasks: [
        task({ id: 't-1', status: 'todo', transitions: [{ ts: now - 90 * MIN, to: 'todo' }] }),
      ],
    });
    expect(verdict.stalled[0]?.bucket).toBe('ready-unpicked');
  });

  it('stays silent while the row is still inside the quiet window', () => {
    const verdict = evaluate({
      tasks: [task({ id: 't-1', transitions: [{ ts: now - 5 * MIN, to: 'in-progress' }] })],
    });
    expect(verdict.stalled).toHaveLength(0);
    // …and the row was still EXAMINED. An empty list over a board of one
    // healthy row and an empty list over an empty board are different facts.
    expect(verdict.considered).toBe(1);
  });

  it('counts a comment on the row as the row moving', () => {
    const threadActivity = new Map([['t-1', now - 2 * MIN]]);
    const verdict = evaluateStalls({
      tasks: [task({ id: 't-1' })],
      events: [],
      reviewItems: [],
      bands,
      now,
      threadActivity,
    });
    expect(verdict.stalled).toHaveLength(0);
  });

  it('sorts the quietest row first — that is the one the lead starts with', () => {
    const verdict = evaluate({
      tasks: [
        task({ id: 't-recent', transitions: [{ ts: now - 40 * MIN, to: 'in-progress' }] }),
        task({ id: 't-oldest', transitions: [{ ts: now - 300 * MIN, to: 'in-progress' }] }),
      ],
    });
    expect(verdict.stalled.map((r) => r.id)).toEqual(['t-oldest', 't-recent']);
  });
});

describe('the default threshold', () => {
  /**
   * Pinned to the NUMBER rather than compared against itself, because the
   * assertion is about a decision somebody made and not about arithmetic.
   * The ticket asked for thirty minutes of silence and for stalls to surface
   * within thirty minutes, which cannot both hold — detection cannot precede
   * the definition. Twenty is what makes the goal reachable, and a later
   * change to it should have to come back through this test.
   */
  it('is twenty minutes, so a stall surfaces within thirty of going quiet', () => {
    expect(STALL_QUIET_DEFAULT_MS).toBe(20 * 60_000);
  });

  it('names a row that has been quiet for longer than the default', () => {
    const verdict = evaluate({
      tasks: [task({ id: 't-1', transitions: [{ ts: now - 25 * MIN, to: 'in-progress' }] })],
    });
    expect(verdict.stalled.map((r) => r.id)).toEqual(['t-1']);
  });

  it('leaves a row that has been quiet for less alone', () => {
    const verdict = evaluate({
      tasks: [task({ id: 't-1', transitions: [{ ts: now - 15 * MIN, to: 'in-progress' }] })],
    });
    expect(verdict.stalled).toHaveLength(0);
  });
});

describe('rows the gate refuses to name', () => {
  it('a pending question to a person is correct waiting, not a stall', () => {
    const verdict = evaluate({ reviewItems: [{ taskId: 't-1' }] });
    expect(verdict.stalled).toHaveLength(0);
  });

  it('a row deliberately deferred to triage is never stalled', () => {
    const verdict = evaluate({ tasks: [task({ id: 't-1', status: 'triage' })] });
    expect(verdict.considered).toBe(0);
    expect(verdict.stalled).toHaveLength(0);
  });

  it('a row behind an unfinished dependency is waiting, not stalled', () => {
    const verdict = evaluate({
      tasks: [
        task({ id: 't-1', status: 'todo', after: ['t-dep'] }),
        task({ id: 't-dep', status: 'todo' }),
      ],
    });
    expect(verdict.stalled.map((r) => r.id)).not.toContain('t-1');
  });

  it('a done row is not examined at all', () => {
    const verdict = evaluate({ tasks: [task({ id: 't-1', status: 'done' })] });
    expect(verdict.considered).toBe(0);
    expect(verdict.stalled).toHaveLength(0);
  });

  it('a backlog row outside every ranked goal is idle by rule', () => {
    const verdict = evaluate({ tasks: [task({ id: 't-1', status: 'todo', goal: 'chores' })] });
    expect(verdict.stalled).toHaveLength(0);
  });
});

describe('a row waiting on a person with nothing filed is its own list', () => {
  it('reports it under unfiled rather than under stalled', () => {
    const verdict = evaluate({
      tasks: [task({ id: 't-1', status: 'todo', ownerKind: 'person' })],
    });
    // Not a stall — nobody is failing to work it. It is an ask that exists in
    // somebody's head, and the lead's move is to file it, not to drive it.
    expect(verdict.stalled).toHaveLength(0);
    expect(verdict.unfiled.map((r) => r.id)).toEqual(['t-1']);
  });

  it('does not report a filed ask as unfiled', () => {
    const verdict = evaluate({
      tasks: [task({ id: 't-1', status: 'todo', ownerKind: 'person' })],
      reviewItems: [{ taskId: 't-1' }],
    });
    expect(verdict.unfiled).toHaveLength(0);
  });

  /**
   * The same clock the stalled list runs on, and for the same reason.
   *
   * Without it a row counts the instant somebody creates it — an agent files
   * a ticket for the owner, and the wake fires before the turn that filed it
   * has finished, telling the lead about a gap it is in the middle of
   * closing. Measured on a live board: six wakes in one evening, none of them
   * naming a stalled row, the unfiled count walking 1→2→3→2→1 as rows were
   * created and answered.
   *
   * This is the WAKE's gate only. The keep-moving report counts every unfiled
   * ask however fresh, because there the reading is "is the protocol being
   * followed right now" and a young violation is still a violation.
   */
  it('leaves a fresh unfiled ask alone until it has been quiet as long as a stall', () => {
    const verdict = evaluate({
      tasks: [
        task({
          id: 't-1',
          status: 'todo',
          ownerKind: 'person',
          transitions: [{ ts: now - 5 * MIN, to: 'todo' }],
        }),
      ],
    });
    expect(verdict.unfiled).toHaveLength(0);
    // …and it was still examined, so the silence is "one row, accounted for".
    expect(verdict.considered).toBe(1);
  });

  it('names the same row once it has been quiet longer than the window', () => {
    const verdict = evaluate({
      tasks: [
        task({
          id: 't-1',
          status: 'todo',
          ownerKind: 'person',
          transitions: [{ ts: now - 25 * MIN, to: 'todo' }],
        }),
      ],
    });
    expect(verdict.unfiled.map((r) => r.id)).toEqual(['t-1']);
  });
});

describe('a row with a watching builder dispatch is judged by builder silence', () => {
  /** A row quiet for the given minutes, with everything else at the fixture
   *  defaults — an in-progress, agent-owned, dispatchable-band row. */
  const quietFor = (minutes: number) =>
    task({ id: 't-1', transitions: [{ ts: now - minutes * MIN, to: 'in-progress' }] });
  const watching = new Set(['t-1']);

  it('does not stall inside the doubled window, where an undispatched row would', () => {
    // 30 minutes: past the ordinary 20-minute window (the control below
    // proves it), inside the builder's 40. The builder promised work by
    // existing, and the price of that promise is a longer leash, not a
    // shorter one.
    const verdict = evaluate({ tasks: [quietFor(30)], watchingDispatchTaskIds: watching });
    expect(verdict.stalled).toHaveLength(0);
    // …and the row was still EXAMINED, not exempted.
    expect(verdict.considered).toBe(1);
  });

  it('the same row without the dispatch stalls on today’s clock — the control', () => {
    const verdict = evaluate({ tasks: [quietFor(30)] });
    expect(verdict.stalled.map((r) => r.bucket)).toEqual(['in-progress']);
  });

  it('a builder silent past twice the window is named, as builder-silent', () => {
    const verdict = evaluate({ tasks: [quietFor(50)], watchingDispatchTaskIds: watching });
    expect(verdict.stalled).toHaveLength(1);
    // The distinct name is the point: the lead's remedy for a silent builder
    // is to probe or replace it, not to find someone to claim the row —
    // flattened into 'in-progress' the frame would ask for the wrong action.
    expect(verdict.stalled[0]?.bucket).toBe(BUILDER_SILENT_BUCKET);
    expect(verdict.stalled[0]?.id).toBe('t-1');
  });

  it('thread or worktree activity inside the doubled window exonerates it', () => {
    // The caller merges worktree churn into threadActivity (the server's
    // exoneration seam); either way the row's last activity is 30 minutes
    // ago, inside the doubled window.
    const verdict = evaluate({
      tasks: [quietFor(200)],
      watchingDispatchTaskIds: watching,
      threadActivity: new Map([['t-1', now - 30 * MIN]]),
    });
    expect(verdict.stalled).toHaveLength(0);
  });

  it('covers a dispatched todo row too — the builder, not the claim, is the promise', () => {
    const verdict = evaluate({
      tasks: [
        task({ id: 't-1', status: 'todo', transitions: [{ ts: now - 50 * MIN, to: 'todo' }] }),
      ],
      watchingDispatchTaskIds: watching,
    });
    expect(verdict.stalled.map((r) => r.bucket)).toEqual([BUILDER_SILENT_BUCKET]);
  });

  it('honors a multiplier override', () => {
    const inside = evaluate({
      tasks: [quietFor(50)],
      watchingDispatchTaskIds: watching,
      builderSilentMultiplier: 3,
    });
    expect(inside.stalled).toHaveLength(0);
    const past = evaluate({
      tasks: [quietFor(70)],
      watchingDispatchTaskIds: watching,
      builderSilentMultiplier: 3,
    });
    expect(past.stalled.map((r) => r.bucket)).toEqual([BUILDER_SILENT_BUCKET]);
  });

  /** Pinned to the number, like the quiet default above: the multiplier is a
   *  decision (one full missed window beyond the ordinary one), and a change
   *  to it should have to come back through this test. */
  it('doubles the window by default', () => {
    expect(BUILDER_SILENT_MULTIPLIER_DEFAULT).toBe(2);
  });
});

describe('a row whose questions cannot be read is named as unread, never as healthy', () => {
  it('keeps it out of stalled and says so separately', () => {
    const verdict = evaluate({ unreadableReviewTaskIds: new Set(['t-1']) });
    // The row looks stalled on its clock, but its review state is exactly
    // what would have exonerated it. "I could not look" must not be
    // delivered as "I looked and it is stuck".
    expect(verdict.stalled).toHaveLength(0);
    expect(verdict.undetermined).toEqual([{ id: 't-1', reason: 'review-items-unreadable' }]);
  });

  it('leaves a healthy board with nothing undetermined', () => {
    expect(evaluate().undetermined).toHaveLength(0);
  });
});

// ── Review items the quality gate is holding ─────────────────────────────────

describe('a held review item is a finding once it has stood past the window', () => {
  const held = (over: { heldAt?: number; reviewItemId?: string } = {}) => ({
    taskId: 't-9',
    title: 'Rebuild the index nightly',
    reviewItemId: over.reviewItemId ?? 'ri-1',
    headline: 'ok?',
    reason: 'The headline is not a question the reader can answer.',
    heldAt: over.heldAt ?? now - 5 * MIN - 1,
    filedBy: 'Index Keeper',
    filerAgentId: 'agent-index-keeper',
  });

  it('the default window is five minutes — the number Bryan named', () => {
    expect(HELD_ITEM_DEFAULT_MS).toBe(5 * MIN);
  });

  it('names an item held for longer than five minutes', () => {
    const rows = overdueHeldItems([held({ heldAt: now - 5 * MIN - 1 })], now);
    expect(rows.map((r) => r.reviewItemId)).toEqual(['ri-1']);
    expect(rows[0]).toMatchObject({
      id: 't-9',
      title: 'Rebuild the index nightly',
      reason: 'The headline is not a question the reader can answer.',
      filedBy: 'Index Keeper',
      filerAgentId: 'agent-index-keeper',
      heldMs: 5 * MIN + 1,
    });
  });

  it('leaves an item held for four minutes alone — and exactly five is not "more than"', () => {
    expect(overdueHeldItems([held({ heldAt: now - 4 * MIN })], now)).toEqual([]);
    expect(overdueHeldItems([held({ heldAt: now - 5 * MIN })], now)).toEqual([]);
  });

  it('sorts the longest-held first and honours a window override', () => {
    const rows = overdueHeldItems(
      [
        held({ reviewItemId: 'ri-young', heldAt: now - 2 * MIN }),
        held({ reviewItemId: 'ri-old', heldAt: now - 9 * MIN }),
      ],
      now,
      MIN,
    );
    expect(rows.map((r) => r.reviewItemId)).toEqual(['ri-old', 'ri-young']);
  });
});
