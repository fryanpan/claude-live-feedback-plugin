/**
 * `unplacedSince` — the durable record that nobody has named a goal for a
 * task (the bucket Bryan asked for, and the "review it later" half).
 *
 * Why this field exists rather than the two proxies that were standing in for
 * it. `listUntriaged` — the sweep handed to every agent on `attach_agent` —
 * used to select "in Backlog and `triagedAgainst` unset", which is wrong in
 * BOTH directions, and each direction was reproduced before this file existed:
 *
 *  - **False positive.** A caller who says `goal: "chores"` has PLACED the
 *    task (that is exactly the distinction `placement.placed` draws, and it
 *    is deliberately not `goal !== chores`). It has no `triagedAgainst`, so
 *    the old predicate re-asked for it on every attach, forever.
 *  - **False negative.** A task swept to Backlog because its band was removed
 *    KEEPS the `triagedAgainst` from its old placement — pointing at a goal
 *    id that no longer exists — so the old predicate never surfaced it, even
 *    though its placement is precisely what stopped being named.
 *
 * And the distinction was not durable at all: `placed` lives only in the
 * create RESPONSE, so after a restart an unplaced task and a deliberate chore
 * were identical. `unplacedSince` is the persisted form, and it SURVIVES
 * hydrate — which is the whole point, since a restart does not place
 * anything.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHORES_GOAL_ID, type Task, TaskStore, tasksSidecarPath } from '../src/tasks.ts';
import { seedGoals } from './goal-seed.ts';

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };

describe('unplacedSince — the bucket remembers that nobody named a goal', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'unplaced-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('stamped by what the caller SAID, not by where the task landed', () => {
    it('an omitted goal stamps unplacedSince', () => {
      const ws = store.createWorkspace('board');
      const res = store.createTask(ws.id, { title: 'figure out og-images' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.goal).toBe(CHORES_GOAL_ID);
      expect(res.task.unplacedSince).toBeGreaterThan(0);
    });

    it('an EXPLICIT goal: "chores" stamps nothing — same landing spot, different claim', () => {
      // This is the case the old `triagedAgainst`-based predicate got wrong,
      // and it is the one Bryan named: "versus if the caller explicitly meant
      // to set the goal to be a chore".
      const ws = store.createWorkspace('board');
      const res = store.createTask(ws.id, { title: 'bump the deps', goal: CHORES_GOAL_ID });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.goal).toBe(CHORES_GOAL_ID);
      expect(res.task.unplacedSince).toBeUndefined();
    });

    it('an explicit real band stamps nothing', () => {
      const ws = store.createWorkspace('board');
      const G = seedGoals(store, ws.id, [{ key: 'ship', title: 'Ship v1' }], PERSON);
      const res = store.createTask(ws.id, { title: 'wire the widget', goal: G.ship });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.unplacedSince).toBeUndefined();
    });

    it('it does NOT depend on anyone being attached — the placement is owed either way', () => {
      // With no attachment at all, and nothing emitted to ask for one, the
      // create still named no goal — so the mark still lands.
      const ws = store.createWorkspace('board');
      const res = store.createTask(ws.id, { title: 'nobody is listening' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.unplacedSince).toBeGreaterThan(0);
    });
  });

  describe('cleared when somebody actually places it', () => {
    it('set_task_goal clears unplacedSince', () => {
      const ws = store.createWorkspace('board');
      const G = seedGoals(store, ws.id, [{ key: 'ship', title: 'Ship v1' }], PERSON);
      const res = store.createTask(ws.id, { title: 'place me' });
      if (!res.ok) throw new Error('create failed');
      expect(res.task.unplacedSince).toBeGreaterThan(0); // positive control
      const placed = store.setTaskGoal(res.task.id, G.ship, { actor: AGENT });
      expect(placed.ok).toBe(true);
      expect(store.getTask(res.task.id)?.unplacedSince).toBeUndefined();
    });

    it('placing it INTO Backlog also clears it — an agent that judged it a chore has named the band', () => {
      // Confirm-in-place is a placement (`setTaskGoal` stamps triagedAgainst
      // for a no-move call too), so the review is answered and must not be
      // asked again.
      const ws = store.createWorkspace('board');
      const res = store.createTask(ws.id, { title: 'genuinely a chore' });
      if (!res.ok) throw new Error('create failed');
      store.setTaskGoal(res.task.id, CHORES_GOAL_ID, { actor: AGENT });
      expect(store.getTask(res.task.id)?.unplacedSince).toBeUndefined();
    });
  });

  describe('re-stamped when a band removal un-names a placement somebody DID make', () => {
    it('a task swept to Backlog by a goal-list removal gets unplacedSince', () => {
      const ws = store.createWorkspace('board');
      const G = seedGoals(
        store,
        ws.id,
        [
          { key: 'ship', title: 'Ship v1' },
          { key: 'old', title: 'Old bet' },
        ],
        PERSON,
      );
      const res = store.createTask(ws.id, { title: 'work under the old bet', goal: G.old });
      if (!res.ok) throw new Error('create failed');
      expect(res.task.unplacedSince).toBeUndefined(); // positive control: placed
      store.setTaskGoal(res.task.id, G.old, { actor: AGENT });

      const dropped = store.setGoalList(ws.id, [{ id: G.ship, title: 'Ship v1' }], {
        actor: PERSON,
        drop: [G.old],
      });
      expect(dropped.ok).toBe(true);
      const after = store.getTask(res.task.id);
      expect(after?.goal).toBe(CHORES_GOAL_ID);
      expect(after?.unplacedSince).toBeGreaterThan(0);
    });

    it('a DONE task swept nowhere is left alone — its placement is history, not a claim', () => {
      const ws = store.createWorkspace('board');
      const G = seedGoals(
        store,
        ws.id,
        [
          { key: 'ship', title: 'Ship v1' },
          { key: 'old', title: 'Old bet' },
        ],
        PERSON,
      );
      const res = store.createTask(ws.id, { title: 'finished under the old bet', goal: G.old });
      if (!res.ok) throw new Error('create failed');
      store.transition(res.task.id, 'done', { actor: AGENT });
      store.setGoalList(ws.id, [{ id: G.ship, title: 'Ship v1' }], {
        actor: PERSON,
        drop: [G.old],
      });
      const after = store.getTask(res.task.id);
      expect(after?.goal).toBe(G.old); // stays put, per the existing contract
      expect(after?.unplacedSince).toBeUndefined();
    });

    it('a task whose band SURVIVES the edit is untouched', () => {
      const ws = store.createWorkspace('board');
      const G = seedGoals(
        store,
        ws.id,
        [
          { key: 'ship', title: 'Ship v1' },
          { key: 'old', title: 'Old bet' },
        ],
        PERSON,
      );
      const res = store.createTask(ws.id, { title: 'safe', goal: G.ship });
      if (!res.ok) throw new Error('create failed');
      store.setGoalList(ws.id, [{ id: G.ship, title: 'Ship v1' }], {
        actor: PERSON,
        drop: [G.old],
      });
      expect(store.getTask(res.task.id)?.unplacedSince).toBeUndefined();
    });
  });

  describe('listUntriaged keys on the field, in both directions', () => {
    it('sweeps the unplaced, skips the explicit chore, skips the done', () => {
      const ws = store.createWorkspace('board');
      const unplaced = store.createTask(ws.id, { title: 'nobody said where' });
      const explicit = store.createTask(ws.id, { title: 'meant it', goal: CHORES_GOAL_ID });
      const finished = store.createTask(ws.id, { title: 'already done' });
      if (!unplaced.ok || !explicit.ok || !finished.ok) throw new Error('create failed');
      store.transition(finished.task.id, 'done', { actor: AGENT });

      const ids = store.listUntriaged(ws.id).map((t) => t.id);
      expect(ids).toContain(unplaced.task.id); // positive control
      expect(ids).not.toContain(explicit.task.id);
      expect(ids).not.toContain(finished.task.id);
    });

    it('a placed task drops out of the sweep', () => {
      const ws = store.createWorkspace('board');
      const G = seedGoals(store, ws.id, [{ key: 'ship', title: 'Ship v1' }], PERSON);
      const res = store.createTask(ws.id, { title: 'place me' });
      if (!res.ok) throw new Error('create failed');
      expect(store.listUntriaged(ws.id).map((t) => t.id)).toContain(res.task.id);
      store.setTaskGoal(res.task.id, G.ship, { actor: AGENT });
      expect(store.listUntriaged(ws.id).map((t) => t.id)).not.toContain(res.task.id);
    });

    it('surfaces a task the OLD predicate could not see: swept there by a band removal', () => {
      const ws = store.createWorkspace('board');
      const G = seedGoals(
        store,
        ws.id,
        [
          { key: 'ship', title: 'Ship v1' },
          { key: 'old', title: 'Old bet' },
        ],
        PERSON,
      );
      const res = store.createTask(ws.id, { title: 'orphaned by the edit', goal: G.old });
      if (!res.ok) throw new Error('create failed');
      store.setTaskGoal(res.task.id, G.old, { actor: AGENT });
      // It carries a triagedAgainst from its old placement — which is exactly
      // why the old predicate skipped it.
      expect(store.getTask(res.task.id)?.triagedAgainst?.goalId).toBe(G.old);
      store.setGoalList(ws.id, [{ id: G.ship, title: 'Ship v1' }], {
        actor: PERSON,
        drop: [G.old],
      });
      expect(store.listUntriaged(ws.id).map((t) => t.id)).toContain(res.task.id);
    });
  });

  describe('durability — the owed review outlives the process', () => {
    it('unplacedSince persists to the sidecar and SURVIVES hydrate', () => {
      const ws = store.createWorkspace('board');
      const res = store.createTask(ws.id, { title: 'still owed after a restart' });
      if (!res.ok) throw new Error('create failed');
      expect(res.task.unplacedSince).toBeGreaterThan(0); // positive control
      store.flush();

      const raw = JSON.parse(readFileSync(tasksSidecarPath(dataDir, ws.id), 'utf8')) as {
        tasks: Task[];
      };
      expect(raw.tasks.find((t) => t.id === res.task.id)?.unplacedSince).toBeGreaterThan(0);

      const reloaded = new TaskStore({ dataDir, debounceMs: 5 });
      try {
        const after = reloaded.getTask(res.task.id);
        // The owed placement outlives the process. That is the design.
        expect(after?.unplacedSince).toBeGreaterThan(0);
        expect(reloaded.listUntriaged(ws.id).map((t) => t.id)).toContain(res.task.id);
      } finally {
        reloaded.stop();
      }
    });

    it('a band-removal marker survives a restart — the case the legacy migration cannot rescue', () => {
      // This is the test that proves the field is not cleared on hydrate. The
      // obvious one (create with no goal, restart, still marked) passes even
      // WITH a clear, because such a task matches the legacy migration's rule
      // and gets re-stamped a line later — two writers agreeing by accident.
      // A task swept to Backlog by a band removal carries a `triagedAgainst`,
      // so the migration refuses it; if hydrate cleared the field, the marker
      // would be gone for good and the task would fall out of the bucket.
      const ws = store.createWorkspace('board');
      const G = seedGoals(
        store,
        ws.id,
        [
          { key: 'ship', title: 'Ship v1' },
          { key: 'old', title: 'Old bet' },
        ],
        PERSON,
      );
      const res = store.createTask(ws.id, { title: 'orphaned then restarted', goal: G.old });
      if (!res.ok) throw new Error('create failed');
      store.setTaskGoal(res.task.id, G.old, { actor: AGENT });
      store.setGoalList(ws.id, [{ id: G.ship, title: 'Ship v1' }], {
        actor: PERSON,
        drop: [G.old],
      });
      expect(store.getTask(res.task.id)?.unplacedSince).toBeGreaterThan(0); // positive control
      store.flush();

      const reloaded = new TaskStore({ dataDir, debounceMs: 5 });
      try {
        const after = reloaded.getTask(res.task.id);
        // The migration cannot have produced this: it skips anything with a
        // triagedAgainst, which this task still carries from its old band.
        expect(after?.triagedAgainst?.goalId).toBe(G.old);
        expect(after?.unplacedSince).toBeGreaterThan(0);
        expect(reloaded.listUntriaged(ws.id).map((t) => t.id)).toContain(res.task.id);
      } finally {
        reloaded.stop();
      }
    });

    it('a placed task stays placed across a restart', () => {
      const ws = store.createWorkspace('board');
      const G = seedGoals(store, ws.id, [{ key: 'ship', title: 'Ship v1' }], PERSON);
      const res = store.createTask(ws.id, { title: 'placed then restarted' });
      if (!res.ok) throw new Error('create failed');
      store.setTaskGoal(res.task.id, G.ship, { actor: AGENT });
      store.flush();

      const reloaded = new TaskStore({ dataDir, debounceMs: 5 });
      try {
        expect(reloaded.getTask(res.task.id)?.unplacedSince).toBeUndefined();
        expect(reloaded.listUntriaged(ws.id)).toHaveLength(0);
      } finally {
        reloaded.stop();
      }
    });
  });

  describe('legacy rows — a writer fix alone would empty the sweep on deploy', () => {
    it('hydrate stamps unplacedSince on a legacy Backlog task that has no marker', () => {
      // Every task already on disk predates the field. Without a migration the
      // sweep goes EMPTY for the whole existing bucket at the deploy, which is
      // the same class of silent regression as the heading-level string.
      // Reproducing today's membership rule (Backlog + open + never placed) is
      // the best available answer, and `createdAt` is the honest timestamp.
      const ws = store.createWorkspace('board');
      const res = store.createTask(ws.id, { title: 'filed before the field existed' });
      if (!res.ok) throw new Error('create failed');
      store.flush();

      // Strip the field from disk to synthesise a pre-field sidecar.
      const path = tasksSidecarPath(dataDir, ws.id);
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        workspace: unknown;
        tasks: Array<Task & { unplacedSince?: number }>;
      };
      for (const t of raw.tasks) t.unplacedSince = undefined;
      Bun.write(path, JSON.stringify(raw, null, 2));

      const reloaded = new TaskStore({ dataDir, debounceMs: 5 });
      try {
        const after = reloaded.getTask(res.task.id);
        expect(after?.unplacedSince).toBe(after?.createdAt);
        expect(reloaded.listUntriaged(ws.id).map((t) => t.id)).toContain(res.task.id);
      } finally {
        reloaded.stop();
      }
    });

    it('hydrate leaves a legacy task that WAS placed alone, even when it sits in Backlog', () => {
      // A legacy explicit-chores create is indistinguishable from a legacy
      // unplaced one — the distinction was never recorded, so the migration
      // over-includes and says so. But a task an agent PLACED into Backlog has
      // a triagedAgainst, and that must keep it out.
      const ws = store.createWorkspace('board');
      const res = store.createTask(ws.id, { title: 'judged a chore long ago' });
      if (!res.ok) throw new Error('create failed');
      store.setTaskGoal(res.task.id, CHORES_GOAL_ID, { actor: AGENT });
      store.flush();

      const path = tasksSidecarPath(dataDir, ws.id);
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        workspace: unknown;
        tasks: Array<Task & { unplacedSince?: number }>;
      };
      for (const t of raw.tasks) t.unplacedSince = undefined;
      Bun.write(path, JSON.stringify(raw, null, 2));

      const reloaded = new TaskStore({ dataDir, debounceMs: 5 });
      try {
        expect(reloaded.getTask(res.task.id)?.unplacedSince).toBeUndefined();
        expect(reloaded.listUntriaged(ws.id)).toHaveLength(0);
      } finally {
        reloaded.stop();
      }
    });

    it('hydrate does not stamp a legacy task under a real band', () => {
      const ws = store.createWorkspace('board');
      const G = seedGoals(store, ws.id, [{ key: 'ship', title: 'Ship v1' }], PERSON);
      const res = store.createTask(ws.id, { title: 'under a band', goal: G.ship });
      if (!res.ok) throw new Error('create failed');
      store.flush();

      const reloaded = new TaskStore({ dataDir, debounceMs: 5 });
      try {
        expect(reloaded.getTask(res.task.id)?.unplacedSince).toBeUndefined();
      } finally {
        reloaded.stop();
      }
    });

    it('hydrate does not stamp a legacy DONE task in Backlog', () => {
      const ws = store.createWorkspace('board');
      const res = store.createTask(ws.id, { title: 'done in the bucket' });
      if (!res.ok) throw new Error('create failed');
      store.transition(res.task.id, 'done', { actor: AGENT });
      store.flush();

      const path = tasksSidecarPath(dataDir, ws.id);
      const raw = JSON.parse(readFileSync(path, 'utf8')) as {
        workspace: unknown;
        tasks: Array<Task & { unplacedSince?: number }>;
      };
      for (const t of raw.tasks) t.unplacedSince = undefined;
      Bun.write(path, JSON.stringify(raw, null, 2));

      const reloaded = new TaskStore({ dataDir, debounceMs: 5 });
      try {
        expect(reloaded.getTask(res.task.id)?.unplacedSince).toBeUndefined();
      } finally {
        reloaded.stop();
      }
    });
  });
});
