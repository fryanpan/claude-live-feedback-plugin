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
import { STALL_QUIET_DEFAULT_MS, evaluateStalls } from '../src/stall-gate.ts';

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
