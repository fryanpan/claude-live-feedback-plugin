/**
 * The work queue: "what do I pick up next" (§3.9 priority order, agent side).
 *
 * Priority is goal order, then task order — and until this existed there was
 * no way for an agent to READ goal order at all, so ordering lived in each
 * agent's head and the answer to "why are you in the 1.2 band" was a guess.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { buildQueue, summarizeGoals } from '../src/task-queue.ts';
import type { Task, WorkspaceGoal } from '../src/tasks.ts';

const GOALS: WorkspaceGoal[] = [
  {
    id: 'g-ship',
    title: '1. Ship the search revamp',
    subgoals: [
      { id: 'g-ship-blockers', title: '1.1 Delivery blockers' },
      { id: 'g-ship-loop', title: '1.2 The loop itself' },
    ],
  },
  { id: 'g-reach', title: '2. Reach' },
];

let seq = 0;
function task(over: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t-${seq}`,
    workspaceId: 'w-1',
    title: `Task ${seq}`,
    assignee: 'agent',
    goal: 'chores',
    order: seq,
    status: 'todo',
    after: [],
    links: [],
    transitions: [],
    createdAt: seq,
    updatedAt: seq,
    ...over,
  };
}

describe('buildQueue — priority order', () => {
  it('ranks by goal position first, task order second, with chores last', () => {
    const chore = task({ goal: 'chores', order: 0 });
    const reach = task({ goal: 'g-reach', order: 0 });
    const loop = task({ goal: 'g-ship-loop', order: 9 });
    const blocker = task({ goal: 'g-ship-blockers', order: 9 });
    const parent = task({ goal: 'g-ship', order: 9 });

    const rows = buildQueue([chore, reach, loop, blocker, parent], GOALS);
    expect(rows.map((r) => r.id)).toEqual([parent.id, blocker.id, loop.id, reach.id, chore.id]);
    // The band label is the goal's own title — the numbering is Bryan's, typed
    // into the title, and inventing a second numbering scheme here would let
    // the two disagree.
    expect(rows[1]?.goalTitle).toBe('1.1 Delivery blockers');
  });

  it('sorts by task order within one goal', () => {
    const late = task({ goal: 'g-ship-loop', order: 5 });
    const early = task({ goal: 'g-ship-loop', order: 0.5 });
    expect(buildQueue([late, early], GOALS).map((r) => r.id)).toEqual([early.id, late.id]);
  });

  it('drops done tasks and keeps in-progress ones', () => {
    const open = task({ status: 'in-progress' });
    const shipped = task({ status: 'done' });
    const rows = buildQueue([open, shipped], GOALS);
    expect(rows.map((r) => r.id)).toEqual([open.id]);
  });

  it('files a task under a goal the list no longer has, rather than dropping it', () => {
    const orphan = task({ goal: 'g-deleted' });
    const rows = buildQueue([orphan], GOALS);
    expect(rows.map((r) => r.id)).toEqual([orphan.id]);
    expect(rows[0]?.goalTitle).toBe('g-deleted');
  });

  it('filters to one assignee when asked, and reports the whole board otherwise', () => {
    const mine = task({ assignee: 'Live Feedback' });
    const theirs = task({ assignee: 'human' });
    expect(buildQueue([mine, theirs], GOALS)).toHaveLength(2); // positive control
    expect(buildQueue([mine, theirs], GOALS, { assignee: 'Live Feedback' })).toHaveLength(1);
  });

  it('carries the WHOLE description, so a row is pickup-able as it stands', () => {
    // A first line is not a task. Truncating here sends the reader for a
    // second call to find out what the work actually is, which is the
    // navigation this queue exists to remove.
    const body =
      'Agent can read the queue so that it works in Bryan’s order.\n\nDone when: the top row is the highest band.';
    expect(buildQueue([task({ body })], GOALS)[0]?.body).toBe(body);
  });

  it('reports an empty description as empty rather than undefined', () => {
    expect(buildQueue([task()], GOALS)[0]?.body).toBe('');
  });
});

describe('buildQueue — blockers', () => {
  it('reports open dependencies and holds back only the enforced ones', () => {
    const dep = task({ status: 'todo', title: 'The thing it waits on' });
    const soft = task({ after: [dep.id], order: 10 });
    const hard = task({ after: [dep.id], afterEnforce: [dep.id], order: 11 });

    const rows = buildQueue([dep, soft, hard], GOALS, { includeBlocked: true });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(soft.id)?.blockedBy.map((b) => b.taskId)).toEqual([dep.id]);
    expect(byId.get(soft.id)?.ready).toBe(true); // advisory, not a gate
    expect(byId.get(hard.id)?.ready).toBe(false);
    expect(byId.get(hard.id)?.blockedBy[0]?.enforce).toBe(true);
  });

  it('hides hard-blocked work by default — the queue is what you can DO', () => {
    const dep = task();
    const hard = task({ after: [dep.id], afterEnforce: [dep.id] });
    // Positive control: it is in there when asked for.
    expect(buildQueue([dep, hard], GOALS, { includeBlocked: true }).map((r) => r.id)).toContain(
      hard.id,
    );
    expect(buildQueue([dep, hard], GOALS).map((r) => r.id)).not.toContain(hard.id);
  });

  it('a dependency that is done blocks nothing', () => {
    const dep = task({ status: 'done' });
    const t = task({ after: [dep.id], afterEnforce: [dep.id] });
    const rows = buildQueue([dep, t], GOALS);
    expect(rows[0]?.blockedBy).toEqual([]);
    expect(rows[0]?.ready).toBe(true);
  });

  it('a dangling dependency id cannot block — a deleted task must not wedge the queue', () => {
    const t = task({ after: ['t-deleted'], afterEnforce: ['t-deleted'] });
    expect(buildQueue([t], GOALS)[0]?.ready).toBe(true);
  });
});

describe('summarizeGoals', () => {
  it('flattens parent-then-subgoals in priority order, with counts', () => {
    const rows = summarizeGoals(
      [
        task({ goal: 'g-ship-blockers', status: 'todo' }),
        task({ goal: 'g-ship-blockers', status: 'in-progress' }),
        task({ goal: 'g-ship-blockers', status: 'done' }),
        task({ goal: 'g-reach', status: 'todo' }),
      ],
      GOALS,
    );
    expect(rows.map((r) => r.id)).toEqual(['g-ship', 'g-ship-blockers', 'g-ship-loop', 'g-reach']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 0]);
    const blockers = rows.find((r) => r.id === 'g-ship-blockers');
    expect(blockers).toMatchObject({ todo: 1, inProgress: 1, done: 1 });
    // A goal with nothing in it still appears — an empty band is information.
    expect(rows.find((r) => r.id === 'g-ship-loop')).toMatchObject({ todo: 0, done: 0 });
  });

  it('appends Chores last, and only when it holds something', () => {
    expect(summarizeGoals([task({ goal: 'g-reach' })], GOALS).map((r) => r.id)).not.toContain(
      'chores',
    );
    const rows = summarizeGoals([task({ goal: 'chores' })], GOALS);
    expect(rows[rows.length - 1]).toMatchObject({ id: 'chores', title: 'Chores', todo: 1 });
  });

  it('surfaces a goal id the list no longer has instead of hiding its tasks', () => {
    const rows = summarizeGoals([task({ goal: 'g-deleted', status: 'todo' })], GOALS);
    expect(rows.find((r) => r.id === 'g-deleted')).toMatchObject({ todo: 1 });
  });
});
