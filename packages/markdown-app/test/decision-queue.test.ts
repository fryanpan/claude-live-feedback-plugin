import { describe, expect, it } from 'vitest';
import { CHORES_ID, type HubTask, decisionQueue } from '../src/hub/hub-model.ts';

/**
 * Urgency is DERIVED. "This decision is blocking work now" is the same fact
 * as "something depends on it", and `after` / `afterEnforce` already record
 * that — so the queue reads the edges rather than a field someone set by hand
 * at creation, the moment they knew least.
 *
 * All fixtures are synthetic — invented names, jordan@partner.example register.
 */

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

let seq = 0;
function task(overrides: Partial<HubTask> = {}): HubTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'todo',
    assignee: 'agent',
    goal: CHORES_ID,
    order: seq,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${seq}`,
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    ...overrides,
  };
}

function decision(overrides: Partial<HubTask> = {}): HubTask {
  return task({ assignee: 'human', needs: 'decision', ...overrides });
}

describe('decisionQueue', () => {
  it('counts only open, unanswered decisions', () => {
    const open = decision();
    const answered = decision({ answer: { text: 'yes', by: 'Bryan', ts: NOW } });
    const closed = decision({ status: 'done' });
    const notADecision = task({ assignee: 'human', needs: 'action' });
    const q = decisionQueue([open, answered, closed, notADecision]);
    expect(q.total).toBe(1);
    expect(q.rows.map((r) => r.task.id)).toEqual([open.id]);
  });

  it('splits blocking-now from can-wait by what depends on each one', () => {
    const blocking = decision({ title: 'Blocking' });
    const parked = decision({ title: 'Parked' });
    const dependent = task({ after: [blocking.id] });
    const q = decisionQueue([blocking, parked, dependent]);
    expect(q.total).toBe(2);
    expect(q.blocking).toBe(1);
    expect(q.waiting).toBe(1);
    expect(q.rows.find((r) => r.task.id === blocking.id)?.blocks.map((t) => t.id)).toEqual([
      dependent.id,
    ]);
    expect(q.rows.find((r) => r.task.id === parked.id)?.blocks).toEqual([]);
  });

  it('a DONE dependent no longer blocks — finished work waits on nothing', () => {
    const d = decision();
    // Presence first: while the dependent is open, the decision is blocking.
    expect(decisionQueue([d, task({ after: [d.id] })]).blocking).toBe(1);
    expect(decisionQueue([d, task({ after: [d.id], status: 'done' })]).blocking).toBe(0);
  });

  it('orders by what it blocks, not by goal: enforced first, then by count, then oldest', () => {
    const many = decision({ title: 'blocks two', createdAt: NOW });
    const hard = decision({ title: 'hard-blocks one', createdAt: NOW });
    const one = decision({ title: 'blocks one', createdAt: NOW });
    const oldParked = decision({ title: 'old parked', createdAt: NOW - 10 * HOUR });
    const newParked = decision({ title: 'new parked', createdAt: NOW });
    const q = decisionQueue([
      // Deliberately shuffled, and every decision sits in a different goal, so
      // a goal-ordered or insertion-ordered result cannot pass by accident.
      newParked,
      task({ after: [one.id] }),
      one,
      task({ after: [hard.id], afterEnforce: [hard.id] }),
      hard,
      oldParked,
      task({ after: [many.id] }),
      task({ after: [many.id] }),
      many,
    ]);
    expect(q.rows.map((r) => r.task.title)).toEqual([
      'hard-blocks one',
      'blocks two',
      'blocks one',
      'old parked',
      'new parked',
    ]);
    expect(q.rows[0]?.hard).toBe(true);
    expect(q.rows[1]?.hard).toBe(false);
  });

  it('a hard edge outranks a bigger soft one — an enforced dependency cannot proceed at all', () => {
    const hard = decision({ title: 'hard', createdAt: NOW });
    const soft = decision({ title: 'soft', createdAt: NOW - HOUR });
    const q = decisionQueue([
      soft,
      task({ after: [soft.id] }),
      task({ after: [soft.id] }),
      task({ after: [soft.id] }),
      hard,
      task({ after: [hard.id], afterEnforce: [hard.id] }),
    ]);
    expect(q.rows.map((r) => r.task.title)).toEqual(['hard', 'soft']);
  });

  it('ignores an `after` id that names nothing, and one that names a non-decision', () => {
    const d = decision();
    const q = decisionQueue([d, task({ after: ['t-ghost'] })]);
    expect(q.total).toBe(1);
    expect(q.blocking).toBe(0);
  });

  it('is empty and consistent when there are no decisions at all', () => {
    const q = decisionQueue([task(), task()]);
    expect(q).toEqual({ rows: [], total: 0, blocking: 0, waiting: 0 });
  });

  it('counts one dependent once even when it lists the decision twice', () => {
    const d = decision();
    const q = decisionQueue([d, task({ after: [d.id, d.id] })]);
    expect(q.rows[0]?.blocks).toHaveLength(1);
  });
});
