/**
 * A goal is done when somebody SAYS it is done.
 *
 * Bryan, 2026-08-20: *"No, let's not do anything automatic. Let's say a goal
 * is done when marked done by an agent or person."* So there is no roll-up
 * rule and no auto-close, and the absence is asserted here rather than left to
 * be true by accident — `closing every child leaves the goal open` is the test
 * that would catch somebody adding the derivation later because it looked
 * helpful.
 *
 * Why declared rather than derived, since a derived status can never
 * contradict its children: because it says something false in both directions.
 * A goal whose children are all done is not thereby achieved — that is the
 * entire reason a goal gets prose of its own. And a goal can be genuinely
 * achieved another way, or abandoned, while children remain open. Worse, a
 * derived status has no actor and no chosen moment, so it cannot produce an
 * audit row, and this store's contract is that every status change lands in
 * `transitions` with an actor and a kind.
 *
 * The children are reported and never enforced — "a goal is done because you
 * say so; the children are reported, not enforced". That reuses the advisory
 * arm of the gate that already exists for `after` edges rather than inventing
 * a second notion of blocked, and the tests below pin both halves: the open
 * children come back on the result, and the move still lands.
 *
 * Note what this feature did NOT need: a route, a tool, or a second status
 * machine. A goal moves through the same `transition` gate every task moves
 * through, so `POST /api/tasks/:id/transition` reaches one already — asserted
 * at the bottom, because a new shared-server REST route is the thing old
 * plugin bundles could never call and this design gets to skip.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ServerHandle, createServer } from '../src/server.ts';
import { TaskStore } from '../src/tasks.ts';
import { seedGoals } from './goal-seed.ts';

const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };
const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known' };

describe('a goal is done only when declared', () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'goal-done-'));
    store = new TaskStore({ dataDir: dir, debounceMs: 1 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A board with one goal and `n` open tasks under it. */
  function board(openChildren: number): { wsId: string; goalId: string; childIds: string[] } {
    const ws = store.createWorkspace('Board');
    const G = seedGoals(store, ws.id, [{ key: 'fast', title: 'Make review fast' }], AGENT);
    const childIds: string[] = [];
    for (let i = 0; i < openChildren; i++) {
      const created = store.createTask(ws.id, {
        title: `Child ${i + 1}`,
        assignee: 'Search Revamp',
        goal: G.fast,
        actor: AGENT,
      });
      if (!created.ok) throw new Error('create refused');
      childIds.push(created.task.id);
    }
    return { wsId: ws.id, goalId: G.fast, childIds };
  }

  it('starts open', () => {
    const { goalId } = board(0);
    expect(store.getGoalRow(goalId)?.status).toBe('todo');
  });

  it('closing every child leaves the goal open', () => {
    const { goalId, childIds } = board(3);
    for (const id of childIds) {
      const moved = store.transition(id, 'done', { actor: AGENT });
      if (!moved.ok) throw new Error(`child transition refused: ${moved.error}`);
    }

    // Positive control: the children really did close, so the goal staying
    // open is the absence of a roll-up rather than a board that did nothing.
    expect(childIds.every((id) => store.getTask(id)?.status === 'done')).toBe(true);
    expect(store.getGoalRow(goalId)?.status).toBe('todo');
    expect(store.getGoalRow(goalId)?.transitions).toEqual([]);
  });

  it('moves only through an explicit transition', () => {
    const { goalId } = board(0);
    const moved = store.transition(goalId, 'done', { actor: PERSON });
    expect(moved.ok).toBe(true);
    expect(store.getGoalRow(goalId)?.status).toBe('done');
  });

  it('names who declared it, and when', () => {
    const { goalId } = board(0);
    const moved = store.transition(goalId, 'done', { actor: PERSON, note: 'shipped enough of it' });
    if (!moved.ok) throw new Error('transition refused');

    const trail = store.getGoalRow(goalId)?.transitions ?? [];
    expect(trail).toHaveLength(1);
    const entry = trail[0];
    expect(entry?.from).toBe('todo');
    expect(entry?.to).toBe('done');
    expect(entry?.by.id).toBe('known-jordan');
    expect(entry?.by.name).toBe('Jordan');
    expect(entry?.by.kind).toBe('person');
    expect(entry?.note).toBe('shipped enough of it');
    expect(typeof entry?.ts).toBe('number');
  });

  it('records an agent as the declarer just as readily as a person', () => {
    const { goalId } = board(0);
    const moved = store.transition(goalId, 'done', { actor: AGENT });
    if (!moved.ok) throw new Error('transition refused');
    expect(store.getGoalRow(goalId)?.transitions[0]?.by.name).toBe('Search Revamp');
  });

  it('appends rather than rewrites when a goal is reopened', () => {
    const { goalId } = board(0);
    store.transition(goalId, 'done', { actor: PERSON });
    const reopened = store.transition(goalId, 'todo', { actor: PERSON, note: 'spoke too soon' });
    if (!reopened.ok) throw new Error('reopen refused');

    const trail = store.getGoalRow(goalId)?.transitions ?? [];
    expect(trail.map((t) => `${t.from}->${t.to}`)).toEqual(['todo->done', 'done->todo']);
    expect(store.getGoalRow(goalId)?.status).toBe('todo');
  });

  it('refuses a move that would change nothing, like any other row', () => {
    const { goalId } = board(0);
    const same = store.transition(goalId, 'todo', { actor: PERSON });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error).toBe('same-status');
  });

  describe('open children are reported, never enforced', () => {
    it('reports each open child and still lands the move', () => {
      const { goalId, childIds } = board(2);
      const moved = store.transition(goalId, 'done', { actor: PERSON });
      if (!moved.ok) throw new Error('an advisory blocker must never refuse the move');

      expect(moved.blockers.map((b) => b.taskId).sort()).toEqual([...childIds].sort());
      // The whole point: advisory. Not one of them may enforce.
      expect(moved.blockers.every((b) => b.enforce === false)).toBe(true);
      expect(store.getGoalRow(goalId)?.status).toBe('done');
    });

    it('describes the child well enough to act on without a second lookup', () => {
      const { goalId, childIds } = board(1);
      const moved = store.transition(goalId, 'done', { actor: PERSON });
      if (!moved.ok) throw new Error('transition refused');
      const blocker = moved.blockers[0];
      expect(blocker?.taskId).toBe(childIds[0] as string);
      expect(blocker?.title).toBe('Child 1');
      expect(blocker?.status).toBe('todo');
      expect(blocker?.message).toContain('Child 1');
    });

    it('reports nothing when every child is already closed', () => {
      const { goalId, childIds } = board(2);
      for (const id of childIds) store.transition(id, 'done', { actor: AGENT });
      const moved = store.transition(goalId, 'done', { actor: PERSON });
      if (!moved.ok) throw new Error('transition refused');
      expect(moved.blockers).toEqual([]);
    });

    it('does not report a child of a different goal', () => {
      const ws = store.createWorkspace('Board');
      const G = seedGoals(
        store,
        ws.id,
        [
          { key: 'fast', title: 'Make review fast' },
          { key: 'trust', title: 'Make the board trustworthy' },
        ],
        AGENT,
      );
      const other = store.createTask(ws.id, {
        title: 'Belongs elsewhere',
        assignee: 'Search Revamp',
        goal: G.trust,
        actor: AGENT,
      });
      if (!other.ok) throw new Error('create refused');

      const moved = store.transition(G.fast, 'done', { actor: PERSON });
      if (!moved.ok) throw new Error('transition refused');
      expect(moved.blockers).toEqual([]);
    });

    it('reports children on the way to in-progress too, and never on the way back', () => {
      const { goalId } = board(1);
      const started = store.transition(goalId, 'in-progress', { actor: PERSON });
      if (!started.ok) throw new Error('transition refused');
      expect(started.blockers).toHaveLength(1);

      // Undoing work is never gated — the same rule the task gate follows.
      const back = store.transition(goalId, 'todo', { actor: PERSON });
      if (!back.ok) throw new Error('transition refused');
      expect(back.blockers).toEqual([]);
    });
  });

  it('marks the emitted event as a goal, so the audit log can tell them apart', () => {
    const { goalId, childIds } = board(1);
    const seen: Array<{ taskId: string; kind?: string }> = [];
    const off = store.onEvent((e) => {
      if (e.type === 'task.transitioned') seen.push({ taskId: e.taskId, kind: e.kind });
    });
    try {
      store.transition(childIds[0] as string, 'done', { actor: AGENT });
      store.transition(goalId, 'done', { actor: PERSON });
    } finally {
      off();
    }
    // The task's event carries no kind — absent reads as a task, which is what
    // every event already in an events.jsonl means.
    expect(seen.find((e) => e.taskId === childIds[0])?.kind).toBeUndefined();
    expect(seen.find((e) => e.taskId === goalId)?.kind).toBe('goal');
  });

  describe('the declaration survives', () => {
    it('round-trips a declared status and its trail through a restart', () => {
      const { goalId } = board(0);
      const moved = store.transition(goalId, 'done', { actor: PERSON, note: 'called it' });
      if (!moved.ok) throw new Error('transition refused');
      store.flush();

      const reopened = new TaskStore({ dataDir: dir, debounceMs: 1 });
      try {
        const row = reopened.getGoalRow(goalId);
        expect(row?.status).toBe('done');
        expect(row?.transitions).toHaveLength(1);
        expect(row?.transitions[0]?.by.name).toBe('Jordan');
        expect(row?.transitions[0]?.note).toBe('called it');
      } finally {
        reopened.stop();
      }
    });

    it('is not cleared by a later goal-list edit', () => {
      const { wsId, goalId } = board(0);
      store.transition(goalId, 'done', { actor: PERSON });

      // Every goal-list write re-runs the reconcile. A mint that clobbered an
      // existing row would destroy the declaration this feature records.
      const renamed = store.renameGoal(
        wsId,
        goalId,
        { title: 'Make review instant' },
        {
          actor: PERSON,
        },
      );
      if (!renamed.ok) throw new Error('rename refused');

      const row = store.getGoalRow(goalId);
      expect(row?.status).toBe('done');
      expect(row?.title).toBe('Make review instant');
      expect(row?.transitions).toHaveLength(1);
    });
  });
});

describe('over the route that already exists', () => {
  let dir: string;
  let handle: ServerHandle;
  let base: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'goal-done-http-'));
    handle = createServer({ dataDir: dir, port: 0 });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('declares a goal done through POST /api/tasks/:id/transition', async () => {
    const store = handle.tasks;
    const ws = store.createWorkspace('Board');
    const G = seedGoals(store, ws.id, [{ key: 'fast', title: 'Make review fast' }], AGENT);
    const child = store.createTask(ws.id, {
      title: 'Still open',
      assignee: 'Search Revamp',
      goal: G.fast,
      actor: AGENT,
    });
    if (!child.ok) throw new Error('create refused');

    const res = await fetch(`${base}/api/tasks/${encodeURIComponent(G.fast)}/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'done', author: PERSON }),
    });
    // 200, not 409: an open child advises, it does not refuse.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      task: { id: string; status: string };
      blockers: Array<{ enforce: boolean }>;
    };
    expect(body.task.status).toBe('done');
    expect(body.blockers).toHaveLength(1);
    expect(body.blockers[0]?.enforce).toBe(false);
    expect(store.getGoalRow(G.fast)?.status).toBe('done');
  });
});
