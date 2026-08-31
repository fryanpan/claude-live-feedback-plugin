/**
 * `Task.wordsRevision` — the monotonic token `recordEffortEstimate` orders a
 * late scoring answer against.
 *
 * The guard used to compare three wall-clock milliseconds
 * (`forTitleWrittenAt` / `forBodyWrittenAt` / `forGoal` against the row's
 * own). A millisecond cannot separate a create from a rename that lands in
 * the same tick: the older run's captured token still equalled the row's
 * current one, so the guard read "not stale" and the older run's answer
 * overwrote the newer one. Caught in CI on 2026-08-30 (a 999/999 create
 * answer landing on a row that had already accepted the rename's 111/222)
 * and reproducible on the board with two quick edits.
 *
 * What is asserted here is the guard itself and the counter under it,
 * driven directly rather than through the estimator: a same-instant
 * collision refused, a matching revision accepted, and — the case a new
 * field always owes — a row that was on disk BEFORE the field existed
 * behaving correctly in both directions after a reload.
 *
 * All fixtures are synthetic — invented names and generic personas. The
 * repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EFFORT_ESTIMATE_PROMPT_VERSION } from '@feedback/core/effort-estimate-prompt';
import { EFFORT_ESTIMATE_MODEL } from '../src/effort-estimator.ts';
import {
  type Task,
  type TaskEffortEstimate,
  TaskStore,
  tasksSidecarPath,
  wordsRevisionOf,
} from '../src/tasks.ts';

const REVIEWER = { id: 'known-morgan', name: 'Morgan' };

/** What a scoring run captures off the row before it awaits the estimator —
 *  the same read `scoreEffortEstimate` in server.ts does. */
function capture(task: Task): {
  forTitleWrittenAt: number;
  forBodyWrittenAt?: number;
  forGoal: string;
  forWordsRevision: number;
} {
  return {
    forTitleWrittenAt: task.titleWrittenAt ?? task.createdAt,
    ...(task.bodyWrittenAt !== undefined ? { forBodyWrittenAt: task.bodyWrittenAt } : {}),
    forGoal: task.goal,
    forWordsRevision: wordsRevisionOf(task),
  };
}

/** That run's answer, ready to record. */
function answer(captured: ReturnType<typeof capture>, handsOnSeconds: number): TaskEffortEstimate {
  return {
    status: 'ok',
    handsOnSeconds,
    wallClockSeconds: handsOnSeconds * 10,
    model: EFFORT_ESTIMATE_MODEL,
    promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION,
    estimatedAt: Date.now(),
    ...captured,
  };
}

describe('wordsRevision orders a late scoring answer', () => {
  let dataDir: string;
  let store: TaskStore;
  let realNow: () => number;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'effort-revision-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    realNow = Date.now;
  });

  afterEach(() => {
    Date.now = realNow;
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** Every stamp taken inside `run` falls on ONE millisecond — the
   *  production collision, made to happen on demand instead of by luck. */
  function inOneMillisecond<T>(run: () => T): T {
    const frozen = realNow.call(Date);
    Date.now = () => frozen;
    try {
      return run();
    } finally {
      Date.now = realNow;
    }
  }

  const newTask = (): Task => {
    const ws = store.createWorkspace('effort');
    const res = store.createTask(ws.id, {
      title: 'Original title',
      assignee: 'Morgan',
      actor: REVIEWER,
    });
    if (!res.ok) throw new Error('fixture task was not created');
    return res.task;
  };

  it('refuses the older run when the create and the rename land in the SAME millisecond', () => {
    const { createRun, renameRun, taskId } = inOneMillisecond(() => {
      const task = newTask();
      // The create's scoring run reads the row and goes out to the network.
      const createRun = capture(task);
      // A rename lands before it answers — inside the same tick.
      const renamed = store.renameTask(task.id, 'Renamed title', { actor: REVIEWER });
      if (!renamed.ok) throw new Error('rename failed');
      const renameRun = capture(renamed.task);
      return { createRun, renameRun, taskId: task.id };
    });

    // The control this test exists for: the timestamp tokens the guard used
    // to compare are byte-identical across the two runs, so nothing built on
    // them can tell the create's answer from the rename's.
    expect(createRun.forTitleWrittenAt).toBe(renameRun.forTitleWrittenAt);
    expect(createRun.forBodyWrittenAt).toBe(renameRun.forBodyWrittenAt);
    expect(createRun.forGoal).toBe(renameRun.forGoal);
    // The revision can, and that is the entire fix.
    expect(renameRun.forWordsRevision).toBeGreaterThan(createRun.forWordsRevision);

    // The newer run answers first — ordinary, a network call has no order.
    expect(store.recordEffortEstimate(taskId, answer(renameRun, 111))).toMatchObject({ ok: true });
    // The older run answers late. It must be refused.
    expect(store.recordEffortEstimate(taskId, answer(createRun, 999))).toEqual({
      ok: false,
      error: 'stale',
    });
    expect(store.getTask(taskId)?.effortEstimate).toMatchObject({ handsOnSeconds: 111 });
  });

  it('accepts a run nothing overtook, in the same frozen millisecond', () => {
    // The negative control's positive twin: a frozen clock must not make
    // EVERY answer stale, or the guard would pass this test by refusing all.
    const taskId = inOneMillisecond(() => {
      const task = newTask();
      const run = capture(task);
      expect(store.recordEffortEstimate(task.id, answer(run, 60))).toMatchObject({ ok: true });
      return task.id;
    });
    expect(store.getTask(taskId)?.effortEstimate).toMatchObject({ handsOnSeconds: 60 });
  });

  it('counts a body rewrite and a goal move, and ignores a plain reorder', () => {
    const task = newTask();
    const start = wordsRevisionOf(store.getTask(task.id)!);

    store.updateBodySnapshot(task.id, 'A much bigger rewrite of the description.');
    const afterBody = wordsRevisionOf(store.getTask(task.id)!);
    expect(afterBody).toBe(start + 1);

    // A no-op flush changes no words, so it must move no revision — the same
    // rule `bodyWrittenAt` follows, and for the same reason.
    store.updateBodySnapshot(task.id, 'A much bigger rewrite of the description.');
    expect(wordsRevisionOf(store.getTask(task.id)!)).toBe(afterBody);

    const goals = store.setGoalList(task.workspaceId, [{ title: 'Launch week' }], {
      actor: { ...REVIEWER, kind: 'person' },
    });
    if (!goals.ok) throw new Error('goal list not set');
    const goalId = goals.created[0]?.id ?? '';

    // A reorder inside the SAME goal changes nothing the scorer weighs.
    store.setTaskGoal(task.id, task.goal, {
      actor: { ...REVIEWER, kind: 'person' },
      after: null,
    });
    expect(wordsRevisionOf(store.getTask(task.id)!)).toBe(afterBody);

    // A move to a DIFFERENT goal changes the goal title the scorer reads.
    store.setTaskGoal(task.id, goalId, { actor: { ...REVIEWER, kind: 'person' } });
    expect(wordsRevisionOf(store.getTask(task.id)!)).toBe(afterBody + 1);
  });

  it('round-trips the counter through a save and a reload', () => {
    const task = newTask();
    store.updateBodySnapshot(task.id, 'rewritten once');
    const before = wordsRevisionOf(store.getTask(task.id)!);
    expect(before).toBeGreaterThan(0);
    store.flush();

    const reloaded = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      expect(wordsRevisionOf(reloaded.getTask(task.id)!)).toBe(before);
    } finally {
      reloaded.stop();
    }
  });

  describe('a row written BEFORE the field existed', () => {
    /**
     * Builds the pre-change on-disk shape honestly: a real sidecar, with
     * `wordsRevision` stripped from the task and the row's stored estimate
     * carrying only the old timestamp provenance — which is exactly what
     * every board on disk holds at the moment this ships.
     */
    function reloadWithoutTheField(): { store: TaskStore; taskId: string } {
      const task = newTask();
      store.flush();
      const path = tasksSidecarPath(dataDir, task.workspaceId);
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        tasks: Array<Record<string, unknown>>;
      };
      for (const row of parsed.tasks) {
        // Assigned rather than deleted: `JSON.stringify` drops an
        // undefined-valued key entirely, so the sidecar comes out with no
        // `wordsRevision` at all — the exact shape every board holds today.
        row.wordsRevision = undefined;
        row.effortEstimate = {
          status: 'ok',
          handsOnSeconds: 300,
          wallClockSeconds: 3_000,
          model: EFFORT_ESTIMATE_MODEL,
          promptVersion: EFFORT_ESTIMATE_PROMPT_VERSION,
          estimatedAt: row.createdAt,
          forTitleWrittenAt: row.createdAt,
          forGoal: row.goal,
        };
      }
      writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
      const reloaded = new TaskStore({ dataDir, debounceMs: 5 });
      const hydrated = reloaded.getTask(task.id);
      if (!hydrated) throw new Error('legacy row did not hydrate');
      expect(hydrated.wordsRevision).toBeUndefined();
      expect(wordsRevisionOf(hydrated)).toBe(0);
      return { store: reloaded, taskId: task.id };
    }

    it('is not "always stale" — a run started after the load still lands', () => {
      const { store: reloaded, taskId } = reloadWithoutTheField();
      try {
        const run = capture(reloaded.getTask(taskId)!);
        expect(run.forWordsRevision).toBe(0);
        expect(reloaded.recordEffortEstimate(taskId, answer(run, 42))).toMatchObject({ ok: true });
        expect(reloaded.getTask(taskId)?.effortEstimate).toMatchObject({ handsOnSeconds: 42 });
      } finally {
        reloaded.stop();
      }
    });

    it('is not "never stale" — the first edit after the load still overtakes a run', () => {
      const { store: reloaded, taskId } = reloadWithoutTheField();
      try {
        const staleRun = capture(reloaded.getTask(taskId)!);
        const renamed = reloaded.renameTask(taskId, 'Renamed after the reload', {
          actor: REVIEWER,
        });
        if (!renamed.ok) throw new Error('rename failed');
        const freshRun = capture(renamed.task);
        expect(freshRun.forWordsRevision).toBe(1);

        expect(reloaded.recordEffortEstimate(taskId, answer(freshRun, 111))).toMatchObject({
          ok: true,
        });
        expect(reloaded.recordEffortEstimate(taskId, answer(staleRun, 999))).toEqual({
          ok: false,
          error: 'stale',
        });
        expect(reloaded.getTask(taskId)?.effortEstimate).toMatchObject({ handsOnSeconds: 111 });
      } finally {
        reloaded.stop();
      }
    });

    it('refuses a record that carries no revision at all', () => {
      // The safe direction: provenance that cannot be established must not
      // overwrite provenance that can.
      const { store: reloaded, taskId } = reloadWithoutTheField();
      try {
        const run = capture(reloaded.getTask(taskId)!);
        const noRevision = answer(run, 7) as unknown as Record<string, unknown>;
        noRevision.forWordsRevision = undefined;
        expect(
          reloaded.recordEffortEstimate(taskId, noRevision as unknown as TaskEffortEstimate),
        ).toEqual({ ok: false, error: 'stale' });
      } finally {
        reloaded.stop();
      }
    });
  });
});
