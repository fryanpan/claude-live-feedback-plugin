/**
 * Goals get a ROW, so a goal has somewhere to carry a status.
 *
 * The migration is deliberately partial and this file pins which half moved.
 * `workspace.goals[]` stays authoritative for a goal's title and its priority
 * order; the ROW is authoritative for the one fact the array has never been
 * able to hold — its status, and the append-only trail of who declared it.
 * Nothing that reads the goal list changes, which is what lets the status half
 * land without rewriting the four readers that derive the board from that
 * array.
 *
 * The load-bearing constraint, and most of what is asserted here: a goal row
 * is NOT in the tasks map. Bryan reversed the earlier "return goals in task
 * lists and see how it goes" on 2026-08-23 — *"No don't do this. The tasks
 * need more room to focus on the most important part — the title."* — so a
 * goal must never reach `list_tasks`, `next_tasks` or My Tasks. A filter on
 * each reader would be one forgotten call site away from handing an agent a
 * band to implement; a separate map cannot leak, because the readers iterate
 * a collection the rows are not in. That is why the invisibility tests below
 * go through the real readers rather than asserting on the map directly.
 *
 * Minting is reconciliation, not a one-shot migration: it runs on hydrate and
 * after every goal-list write, mints what is missing, and — the assertion that
 * matters most for the ticket — NEVER resets the status of a row that already
 * exists. A migration that ran twice and cleared a declared `done` would
 * destroy exactly the claim this feature exists to record.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskStore, tasksSidecarPath } from '../src/tasks.ts';
import { seedGoals } from './goal-seed.ts';

const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };
const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known' };

describe('goal rows', () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'goal-rows-'));
    store = new TaskStore({ dataDir: dir, debounceMs: 1 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('mints one row per goal, open and with an empty trail', () => {
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

    const fast = store.getGoalRow(G.fast);
    expect(fast?.kind).toBe('goal');
    expect(fast?.title).toBe('Make review fast');
    expect(fast?.status).toBe('todo');
    // The trail starts at migration — history is never fabricated.
    expect(fast?.transitions).toEqual([]);
    expect(store.getGoalRow(G.trust)?.title).toBe('Make the board trustworthy');
  });

  it('mints a row for a goal added later', () => {
    const ws = store.createWorkspace('Board');
    seedGoals(store, ws.id, [{ key: 'fast', title: 'Make review fast' }], AGENT);
    const added = store.addGoal(ws.id, { title: 'Ship the widget' }, { actor: PERSON });
    if (!added.ok) throw new Error('addGoal refused');
    expect(store.getGoalRow(added.goal.id)?.title).toBe('Ship the widget');
    expect(store.getGoalRow(added.goal.id)?.status).toBe('todo');
  });

  it('follows a rename, so the row and the list cannot drift', () => {
    const ws = store.createWorkspace('Board');
    const G = seedGoals(store, ws.id, [{ key: 'fast', title: 'Make review fast' }], AGENT);
    const renamed = store.renameGoal(
      ws.id,
      G.fast,
      { title: 'Make review instant' },
      { actor: PERSON },
    );
    if (!renamed.ok) throw new Error('rename refused');
    expect(store.getGoalRow(G.fast)?.title).toBe('Make review instant');
  });

  it('flattens a subgoal into a row of its own', () => {
    const ws = store.createWorkspace('Board');
    const G = seedGoals(
      store,
      ws.id,
      [
        {
          key: 'fast',
          title: 'Make review fast',
          subgoals: [{ key: 'sub', title: 'Cut latency' }],
        },
      ],
      AGENT,
    );
    // A subgoal is a top-level row in the position the board already draws it
    // — the board has rendered one flat level all along.
    expect(store.getGoalRow(G.sub)?.title).toBe('Cut latency');
    expect(store.getGoalRow(G.sub)?.kind).toBe('goal');
  });

  describe('are invisible to every task reader', () => {
    it('stays out of listTasks', () => {
      const ws = store.createWorkspace('Board');
      const G = seedGoals(store, ws.id, [{ key: 'fast', title: 'Make review fast' }], AGENT);
      const created = store.createTask(ws.id, {
        title: 'Ship the thing',
        assignee: 'Search Revamp',
        goal: G.fast,
        actor: AGENT,
      });
      if (!created.ok) throw new Error('create refused');

      const rows = store.listTasks(ws.id);
      // Positive control: the reader CAN see something, so an absent goal is
      // an absence rather than a reader that returned nothing at all.
      expect(rows.map((r) => r.id)).toContain(created.task.id);
      expect(rows.map((r) => r.id)).not.toContain(G.fast);
    });

    it('stays out of getTask, so no task verb can reach one by id', () => {
      const ws = store.createWorkspace('Board');
      const G = seedGoals(store, ws.id, [{ key: 'fast', title: 'Make review fast' }], AGENT);
      expect(store.getTask(G.fast)).toBeUndefined();
      expect(store.getGoalRow(G.fast)).toBeDefined();
    });

    it('stops resolving once its board is deleted', () => {
      const ws = store.createWorkspace('Board');
      const G = seedGoals(store, ws.id, [{ key: 'fast', title: 'Make review fast' }], AGENT);
      // Positive control first: the id resolves while the board is alive, so
      // the assertion below is a removal rather than a lookup that never
      // worked.
      expect(store.getGoalRow(G.fast)).toBeDefined();

      const gone = store.deleteWorkspace(ws.id);
      if (!gone.ok) throw new Error(`delete refused: ${gone.error}`);
      expect(store.getGoalRow(G.fast)).toBeUndefined();
      // Stated because it would otherwise be assumed: this pins the LOOKUP
      // contract and not the goalIndex sweep that `deleteWorkspace` also does.
      // `getGoalRow` re-reads the workspace map, so it answers undefined with
      // or without that sweep — measured, by removing the line and watching
      // this test still pass. The sweep is leak hygiene with no observable
      // behaviour, and no test here can prove it ran.
    });

    it('is not counted as open work when a board is deleted', () => {
      const ws = store.createWorkspace('Board');
      seedGoals(store, ws.id, [{ key: 'fast', title: 'Make review fast' }], AGENT);
      // Two open goals would otherwise read as two open tasks and refuse the
      // delete with a count nobody could explain.
      expect(store.openTaskCount(ws.id)).toBe(0);
    });
  });

  describe('persistence', () => {
    it('round-trips a row through a restart', () => {
      const ws = store.createWorkspace('Board');
      const G = seedGoals(store, ws.id, [{ key: 'fast', title: 'Make review fast' }], AGENT);
      store.flush();

      const reopened = new TaskStore({ dataDir: dir, debounceMs: 1 });
      try {
        const row = reopened.getGoalRow(G.fast);
        expect(row?.title).toBe('Make review fast');
        expect(row?.status).toBe('todo');
        expect(row?.kind).toBe('goal');
      } finally {
        reopened.stop();
      }
    });

    it('keeps workspace.goals[] in the sidecar — the rollback path', () => {
      const ws = store.createWorkspace('Board');
      const G = seedGoals(store, ws.id, [{ key: 'fast', title: 'Make review fast' }], AGENT);
      store.flush();
      const raw = JSON.parse(readFileSync(tasksSidecarPath(dir, ws.id), 'utf8')) as {
        workspace: { goals: Array<{ id: string }> };
        goalRows?: Array<{ id: string }>;
      };
      // Both halves on disk: the array nothing purges, and the rows.
      expect(raw.workspace.goals.map((g) => g.id)).toEqual([G.fast]);
      expect(raw.goalRows?.map((g) => g.id)).toEqual([G.fast]);
    });

    it('mints rows for a legacy sidecar that has goals and no rows', () => {
      const ws = store.createWorkspace('Board');
      const G = seedGoals(store, ws.id, [{ key: 'fast', title: 'Make review fast' }], AGENT);
      store.flush();

      // Exactly what every board on disk looks like today.
      const path = tasksSidecarPath(dir, ws.id);
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      raw.goalRows = undefined;
      writeFileSync(path, JSON.stringify(raw, null, 2));

      const reopened = new TaskStore({ dataDir: dir, debounceMs: 1 });
      try {
        expect(reopened.getGoalRow(G.fast)?.title).toBe('Make review fast');
        expect(reopened.getGoalRow(G.fast)?.status).toBe('todo');
      } finally {
        reopened.stop();
      }
    });

    it('updates an existing row rather than re-minting it', () => {
      const ws = store.createWorkspace('Board');
      const G = seedGoals(store, ws.id, [{ key: 'fast', title: 'Make review fast' }], AGENT);
      const before = store.getGoalRow(G.fast);
      expect(before).toBeDefined();

      // Any later goal-list write re-runs the reconcile. `createdAt` is the
      // witness: a row that was replaced would carry a fresh one, and
      // replacing it is how a declared status gets silently cleared (the
      // status half of this is asserted once transitions can reach a goal).
      const renamed = store.renameGoal(
        ws.id,
        G.fast,
        { title: 'Make review instant' },
        { actor: PERSON },
      );
      if (!renamed.ok) throw new Error('rename refused');

      const after = store.getGoalRow(G.fast);
      expect(after?.title).toBe('Make review instant');
      expect(after?.createdAt).toBe(before?.createdAt as number);
      expect(after?.transitions).toEqual([]);
    });
  });

  /**
   * Retained is not the same as listed. `syncGoalRows` keeps the row of a goal
   * that left the list — soft delete, so a restored band comes back with its
   * declaration — but a retained row is history, and a list API that returns it
   * hands a caller a band the board is not working as if it were current.
   *
   * Unlike the `goalIndex`-sweep test in the delete suite, this one can see its
   * own fix: measured with the filter removed, `listGoalRows` returns both ids
   * and the first assertion fails.
   */
  describe('a goal removed from the list', () => {
    it('leaves listGoalRows but stays reachable by id, declaration intact', () => {
      const ws = store.createWorkspace('Board');
      const G = seedGoals(
        store,
        ws.id,
        [
          { key: 'keep', title: 'Make review fast' },
          { key: 'retired', title: 'Retire the old importer' },
        ],
        PERSON,
      );

      const declared = store.transition(G.retired, 'done', { actor: PERSON, note: 'shipped it' });
      expect(declared.ok).toBe(true);

      const removed = store.setGoalList(ws.id, [{ id: G.keep, title: 'Make review fast' }], {
        actor: PERSON,
      });
      if (!removed.ok) throw new Error(`setGoalList refused with ${removed.error}`);

      expect(store.listGoalRows(ws.id).map((r) => r.id)).toEqual([G.keep]);

      const kept = store.getGoalRow(G.retired);
      expect(kept?.status).toBe('done');
      expect(kept?.transitions).toHaveLength(1);
    });

    /**
     * What "restoring the band" actually does today, pinned because it is not
     * what you would guess. `setGoalList` refuses an id that is not in the
     * CURRENT list, so a removed goal cannot be re-submitted by id — retyping
     * the band mints a fresh id and therefore a fresh, open row. The retained
     * row keeps its declaration and stays reachable by its old id; it does not
     * come back to the list.
     *
     * That is the soft-delete guarantee holding (nothing was destroyed) and no
     * more than it: an undelete verb for a band does not exist yet, and this
     * test is here so the next person reads that from a measurement rather
     * than from a comment claiming otherwise.
     */
    it('cannot be re-listed by its old id; retyping the band mints a new row', () => {
      const ws = store.createWorkspace('Board');
      const G = seedGoals(
        store,
        ws.id,
        [
          { key: 'keep', title: 'Make review fast' },
          { key: 'retired', title: 'Retire the old importer' },
        ],
        PERSON,
      );
      store.transition(G.retired, 'done', { actor: PERSON });

      const away = store.setGoalList(ws.id, [{ id: G.keep, title: 'Make review fast' }], {
        actor: PERSON,
      });
      if (!away.ok) throw new Error('removal refused');

      const byId = store.setGoalList(
        ws.id,
        [
          { id: G.keep, title: 'Make review fast' },
          { id: G.retired, title: 'Retire the old importer' },
        ],
        { actor: PERSON },
      );
      expect(byId.ok).toBe(false);
      if (byId.ok) throw new Error('expected the removed id to be refused');
      expect(byId.error).toBe('unknown-goal-id');

      const retyped = store.setGoalList(
        ws.id,
        [{ id: G.keep, title: 'Make review fast' }, { title: 'Retire the old importer' }],
        { actor: PERSON },
      );
      if (!retyped.ok) throw new Error(`retype refused with ${retyped.error}`);
      const fresh = retyped.created[0]?.id as string;
      expect(fresh).not.toBe(G.retired);

      expect(store.listGoalRows(ws.id).map((r) => r.id)).toEqual([G.keep, fresh]);
      expect(store.getGoalRow(fresh)?.status).toBe('todo');
      // Nothing was destroyed: the old row still holds what was declared.
      expect(store.getGoalRow(G.retired)?.status).toBe('done');
    });
  });
});
