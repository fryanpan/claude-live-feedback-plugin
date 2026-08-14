/**
 * The work queue: "what do I pick up next, and what can run at the same
 * time" (§3.9 priority order, agent side).
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

  it('carries the first line of the description, so a row is pickup-able as it stands', () => {
    const t = task({
      body: 'Agent can read the queue so that it works in Bryan’s order.\n\nDone when: …',
    });
    expect(buildQueue([t], GOALS)[0]?.story).toBe(
      'Agent can read the queue so that it works in Bryan’s order.',
    );
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

describe('buildQueue — waves (what can run at once)', () => {
  it('puts independent work in the same wave and a dependant in the next', () => {
    const a = task({ order: 1 });
    const b = task({ order: 2 });
    const afterA = task({ order: 3, after: [a.id] });
    const rows = buildQueue([a, b, afterA], GOALS);
    const wave = new Map(rows.map((r) => [r.id, r.wave]));
    expect(wave.get(a.id)).toBe(0);
    expect(wave.get(b.id)).toBe(0);
    expect(wave.get(afterA.id)).toBe(1);
  });

  it('chains three deep', () => {
    const a = task({ order: 1 });
    const b = task({ order: 2, after: [a.id] });
    const c = task({ order: 3, after: [b.id] });
    const wave = new Map(buildQueue([a, b, c], GOALS).map((r) => [r.id, r.wave]));
    expect([wave.get(a.id), wave.get(b.id), wave.get(c.id)]).toEqual([0, 1, 2]);
  });

  it('never runs two tasks of the same lane at once — the merge-conflict guard', () => {
    // `after` models "don't start yet"; it does not model "these two rewrite
    // the same file". Long branches that both append to styles.css conflict
    // every time (learnings.md), and no dependency edge says so.
    const one = task({ order: 1, lane: 'hub-render' });
    const two = task({ order: 2, lane: 'hub-render' });
    const other = task({ order: 3, lane: 'mcp' });
    const wave = new Map(buildQueue([one, two, other], GOALS).map((r) => [r.id, r.wave]));
    expect(wave.get(one.id)).toBe(0);
    expect(wave.get(other.id)).toBe(0); // a different lane rides along
    expect(wave.get(two.id)).toBe(1);
  });

  it('leaves lane-less tasks unconstrained, and says the grouping is undeclared', () => {
    const a = task({ order: 1 });
    const b = task({ order: 2 });
    const rows = buildQueue([a, b], GOALS);
    expect(rows.every((r) => r.wave === 0)).toBe(true);
    // Honest reach: wave 0 means "nothing DECLARED a conflict", not "proven
    // safe". A caller that can't tell the difference will fan out into a
    // merge conflict, so the queue says which rows it had nothing to go on.
    expect(rows.every((r) => r.laneDeclared === false)).toBe(true);
    expect(buildQueue([task({ lane: 'x' })], GOALS)[0]?.laneDeclared).toBe(true);
  });

  it('limits after grouping, so a wave number never shifts with the page size', () => {
    const a = task({ order: 1 });
    const b = task({ order: 2, after: [a.id] });
    const full = buildQueue([a, b], GOALS);
    const capped = buildQueue([a, b], GOALS, { limit: 1 });
    expect(capped).toHaveLength(1);
    expect(capped[0]?.wave).toBe(full[0]?.wave);
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
