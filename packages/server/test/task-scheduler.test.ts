/**
 * The scheduled-task loop, driven against a REAL task store with an injected
 * clock (`task-scheduler.ts`).
 *
 * The three things the ticket asks for are asserted here rather than through
 * a fake store, because two of them are claims about persistence: the rule
 * has to survive a restart, and the instance has to be created through the
 * same door as any other filing so its owner, band and activity behave. A
 * stub store would satisfy both by construction and prove neither. The
 * restart is a real one — the store is flushed and a second `TaskStore` is
 * built over the same data directory, which is exactly what a redeploy does.
 *
 * Nothing here reads the wall clock. `now` is a number the test moves, and
 * every assertion is about which occurrence the loop chose, never how long
 * anything took.
 *
 * All fixtures are invented — a made-up board with made-up rows. The repo is
 * public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskSchedule } from '@feedback/core/task-schedule';
import {
  SCHEDULER_TICK_DEFAULT_MS,
  TaskScheduler,
  createTaskScheduler,
  scheduleCursorFor,
  scheduledRows,
  setTaskSchedule,
} from '../src/task-scheduler.ts';
import { TaskStore } from '../src/tasks.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 2026-03-02T00:00:00Z, a Monday. */
const MON = Date.UTC(2026, 2, 2);

const OWNER = { id: 'agent-lamplighter', name: 'Lamplighter', kind: 'agent' } as const;

/** A board with one goal band and one row carrying a rule. */
function seed(store: TaskStore, schedule: TaskSchedule) {
  const ws = store.createWorkspace('Harbour Lights');
  const goals = store.setGoalList(ws.id, [{ title: 'Keep the lamps lit' }], { actor: OWNER });
  if (!goals.ok) throw new Error('goal list refused');
  const goalId = goals.created[0]?.id;
  if (goalId === undefined) throw new Error('no goal id');
  const created = store.createTask(ws.id, {
    title: 'Sweep the lamp room',
    body: 'Agent can sweep the lamp room so that the beam stays clean.',
    assignee: OWNER.name,
    assigneeKind: 'agent',
    goal: goalId,
    actor: OWNER,
  });
  if (!created.ok) throw new Error(`create refused: ${created.error}`);
  const armed = setTaskSchedule(store, created.task.id, schedule);
  if (!armed.ok) throw new Error('arm refused');
  return { workspaceId: ws.id, goalId, ruleId: created.task.id };
}

/** Every instance the rule has produced, oldest first. */
function instancesOf(store: TaskStore, workspaceId: string, ruleId: string) {
  return store
    .listTasks(workspaceId)
    .filter((t) => t.recurrenceOf?.taskId === ruleId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

describe('an occurrence creates the live instance, once', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-scheduler-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('fires at the occurrence and files the instance in the rule’s own band', () => {
    const { workspaceId, goalId, ruleId } = seed(store, {
      rule: { kind: 'every', everyMs: HOUR },
      armedAt: MON,
    });
    let now = MON + 30 * 60_000;
    const scheduler = createTaskScheduler(store, { now: () => now });

    // Half an hour in, nothing is owed yet.
    expect(scheduler.tick()).toEqual([]);
    expect(instancesOf(store, workspaceId, ruleId)).toHaveLength(0);

    now = MON + HOUR + 1;
    const fired = scheduler.tick();
    expect(fired).toEqual([
      { taskId: ruleId, instanceId: fired[0]?.instanceId ?? '', at: MON + HOUR, missed: 0 },
    ]);

    const instances = instancesOf(store, workspaceId, ruleId);
    expect(instances).toHaveLength(1);
    const instance = instances[0];
    // The rule's band, the rule's owner, and READY — not the triage an agent
    // create otherwise lands in, because the rule row was already placed.
    expect(instance?.goal).toBe(goalId);
    expect(instance?.assignee).toBe(OWNER.name);
    expect(instance?.status).toBe('todo');
    // The mark names the occurrence's own instant, which is what lets a
    // catch-up say it stands for a moment other than its creation.
    expect(instance?.recurrenceOf).toEqual({ taskId: ruleId, occurrenceAt: MON + HOUR });
    // The RULE row is untouched by its own occurrence — it is the rule, not
    // the work.
    expect(store.getTask(ruleId)?.status).not.toBe('todo');
    expect(store.getTask(ruleId)?.recurrenceOf).toBeUndefined();
  });

  it('records the occurrence in the rule row’s activity', () => {
    const { ruleId } = seed(store, { rule: { kind: 'every', everyMs: HOUR }, armedAt: MON });
    let now = MON + HOUR + 1;
    const scheduler = createTaskScheduler(store, { now: () => now });
    const fired = scheduler.tick();
    const instanceId = fired[0]?.instanceId;
    expect(instanceId).toBeDefined();

    const notes = store.getTask(ruleId)?.notes ?? [];
    expect(notes).toHaveLength(1);
    // The note names both the occurrence and the row it started, because a
    // catch-up fires long after the instant it stands for and a reader has to
    // be able to tell those two apart.
    expect(notes[0]?.text).toContain(new Date(MON + HOUR).toISOString());
    expect(notes[0]?.text).toContain(instanceId as string);

    // A second occurrence adds a second entry rather than replacing the first
    // — the activity is the run history the record row will later read.
    now = MON + 2 * HOUR + 1;
    scheduler.tick();
    expect(store.getTask(ruleId)?.notes ?? []).toHaveLength(2);
  });

  it('does not fire the same occurrence twice however often it ticks', () => {
    const { workspaceId, ruleId } = seed(store, {
      rule: { kind: 'every', everyMs: HOUR },
      armedAt: MON,
    });
    let now = MON + HOUR + 1;
    const scheduler = createTaskScheduler(store, { now: () => now });
    expect(scheduler.tick()).toHaveLength(1);
    // Four more passes inside the same cadence window.
    for (const step of [2, 10, 100, 1000]) {
      now = MON + HOUR + step;
      expect(scheduler.tick()).toEqual([]);
    }
    expect(instancesOf(store, workspaceId, ruleId)).toHaveLength(1);
  });

  it('leaves the occurrence owed when the create is refused', () => {
    const { workspaceId, ruleId } = seed(store, {
      rule: { kind: 'every', everyMs: HOUR },
      armedAt: MON,
    });
    const now = MON + HOUR + 1;
    const reported: string[] = [];
    const scheduler = new TaskScheduler({
      now: () => now,
      rows: () => scheduledRows(store),
      createInstance: () => undefined,
      commit: () => {
        throw new Error('the cursor must not move on a refused create');
      },
      record: () => {
        throw new Error('nothing to record');
      },
      report: (line) => reported.push(line),
    });
    expect(scheduler.tick()).toEqual([]);
    expect(reported).toHaveLength(1);
    // The rule is exactly where it was, so a later tick can still fire it.
    expect(store.getTask(ruleId)?.schedule?.state).toBeUndefined();
    expect(instancesOf(store, workspaceId, ruleId)).toHaveLength(0);
  });

  it('fires nothing for a board that has been stood down', () => {
    const { workspaceId, ruleId } = seed(store, {
      rule: { kind: 'every', everyMs: HOUR },
      armedAt: MON,
    });
    store.setWorkspaceRetired(workspaceId, true, { actor: OWNER });
    const now = MON + 10 * HOUR;
    expect(createTaskScheduler(store, { now: () => now }).tick()).toEqual([]);
    // The rule is KEPT, so an unretire resumes it.
    expect(store.getTask(ruleId)?.schedule).toBeDefined();
  });
});

describe('a rule survives a restart', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-scheduler-restart-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('neither loses an occurrence nor fires one twice across a restart', () => {
    // ── Before the restart ────────────────────────────────────────────────
    const before = new TaskStore({ dataDir, debounceMs: 5 });
    const { workspaceId, ruleId } = seed(before, {
      rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }] },
      timezone: 'UTC',
      armedAt: MON,
    });
    let now = MON + 9 * HOUR + 1;
    expect(createTaskScheduler(before, { now: () => now }).tick()).toHaveLength(1);
    expect(instancesOf(before, workspaceId, ruleId)).toHaveLength(1);
    // `stop` flushes the debounced save, which is what a clean shutdown does.
    before.stop();

    // ── The restart ───────────────────────────────────────────────────────
    const after = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      const rehydrated = after.getTask(ruleId);
      // The rule AND the scheduler's cursor came back off disk. Without the
      // cursor the loop would have no way to know Monday had already fired.
      expect(rehydrated?.schedule?.rule).toEqual({
        kind: 'calendar',
        times: [{ hour: 9, minute: 0 }],
      });
      expect(rehydrated?.schedule?.state?.lastOccurrenceAt).toBe(MON + 9 * HOUR);
      expect(rehydrated?.schedule?.state?.fireCount).toBe(1);
      expect(instancesOf(after, workspaceId, ruleId)).toHaveLength(1);

      // NOT FIRED TWICE: the same day, on a fresh process, is owed nothing.
      now = MON + 12 * HOUR;
      const scheduler = createTaskScheduler(after, { now: () => now });
      expect(scheduler.tick()).toEqual([]);
      expect(instancesOf(after, workspaceId, ruleId)).toHaveLength(1);

      // NOT LOST: Tuesday's 9am is still owed, and firing it does not replay
      // Monday's.
      now = MON + DAY + 9 * HOUR + 1;
      const fired = scheduler.tick();
      expect(fired.map((f) => f.at)).toEqual([MON + DAY + 9 * HOUR]);
      const instances = instancesOf(after, workspaceId, ruleId);
      expect(instances).toHaveLength(2);
      expect(instances.map((t) => t.recurrenceOf?.occurrenceAt)).toEqual([
        MON + 9 * HOUR,
        MON + DAY + 9 * HOUR,
      ]);
    } finally {
      after.stop();
    }
  });

  it('collapses a whole outage into ONE catch-up instance', () => {
    const before = new TaskStore({ dataDir, debounceMs: 5 });
    const { workspaceId, ruleId } = seed(before, {
      rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }] },
      timezone: 'UTC',
      armedAt: MON,
    });
    // The server never ran on Monday at all — it comes up on Friday evening,
    // by which point Mon/Tue/Wed/Thu/Fri 9am have all come due.
    before.stop();

    const after = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      const now = MON + 4 * DAY + 20 * HOUR;
      const fired = createTaskScheduler(after, { now: () => now }).tick();
      expect(fired).toHaveLength(1);
      // The LATEST occurrence, standing in for the four behind it — one row a
      // person can act on, not five.
      expect(fired[0]?.at).toBe(MON + 4 * DAY + 9 * HOUR);
      expect(fired[0]?.missed).toBe(4);
      const instances = instancesOf(after, workspaceId, ruleId);
      expect(instances).toHaveLength(1);
      expect(instances[0]?.recurrenceOf?.missed).toBe(4);
      // Counted on the rule too, so the missed-run policy has the number.
      expect(after.getTask(ruleId)?.schedule?.state?.missedTotal).toBe(4);
    } finally {
      after.stop();
    }
  });
});

describe('after-completion rules run off the last instance finishing', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-scheduler-after-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('is owed nothing while its instance is open, and one delay after it closes', () => {
    const { workspaceId, ruleId } = seed(store, {
      rule: { kind: 'after-completion', delayMs: 2 * HOUR },
      armedAt: MON,
    });
    let now = MON + 2 * HOUR + 1;
    const scheduler = createTaskScheduler(store, { now: () => now });
    const first = scheduler.tick();
    expect(first).toHaveLength(1);
    const instanceId = first[0]?.instanceId as string;

    // A day later, with the instance still open, the rule is owed NOTHING —
    // the defining property of the mode, and the reason it cannot stack up
    // behind work nobody has done.
    now = MON + DAY;
    expect(scheduler.tick()).toEqual([]);
    expect(instancesOf(store, workspaceId, ruleId)).toHaveLength(1);

    // Close it. The next occurrence is measured from the CLOSE, not from the
    // occurrence that opened it.
    const closed = store.transition(instanceId, 'done', { actor: OWNER });
    expect(closed.ok).toBe(true);
    const closedAt = store.getTask(instanceId)?.transitions.at(-1)?.ts;
    expect(closedAt).toBeDefined();
    expect(scheduleCursorFor(store, store.getTask(ruleId)?.schedule as TaskSchedule)).toEqual({
      lastCompletedAt: closedAt as number,
    });

    // Still inside the delay: nothing.
    now = (closedAt as number) + HOUR;
    expect(scheduler.tick()).toEqual([]);
    // Past it: exactly one, standing in for nothing however late the tick.
    now = (closedAt as number) + 3 * DAY;
    const second = scheduler.tick();
    expect(second).toHaveLength(1);
    expect(second[0]?.at).toBe((closedAt as number) + 2 * HOUR);
    expect(second[0]?.missed).toBe(0);
    expect(instancesOf(store, workspaceId, ruleId)).toHaveLength(2);
  });

  it('is not blocked forever by an instance somebody archived', () => {
    seed(store, {
      rule: { kind: 'after-completion', delayMs: 2 * HOUR },
      armedAt: MON,
    });
    let now = MON + 2 * HOUR + 1;
    const scheduler = createTaskScheduler(store, { now: () => now });
    const instanceId = scheduler.tick()[0]?.instanceId as string;
    // An archive takes the row out of the open set as finally as closing it
    // does, so the rule must come due again rather than waiting on a `done`
    // that will never arrive.
    expect(store.archiveTask(instanceId, { actor: OWNER, reason: 'not needed' }).ok).toBe(true);
    // The store stamps the archive from ITS clock, not the loop's injected
    // one — in production they are the same clock, so the test reads the
    // stamp back rather than assuming where it landed.
    const archivedAt = store.getTask(instanceId)?.archivedAt;
    expect(archivedAt).toBeDefined();
    now = (archivedAt as number) + HOUR;
    expect(scheduler.tick()).toEqual([]);
    now = (archivedAt as number) + 3 * HOUR;
    const resumed = scheduler.tick();
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.at).toBe((archivedAt as number) + 2 * HOUR);
  });
});

describe('setting a rule', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-scheduler-set-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps the cursor when the rule is unchanged and drops it when it moves', () => {
    const { ruleId } = seed(store, { rule: { kind: 'every', everyMs: HOUR }, armedAt: MON });
    const now = MON + HOUR + 1;
    createTaskScheduler(store, { now: () => now }).tick();
    expect(store.getTask(ruleId)?.schedule?.state?.fireCount).toBe(1);

    // Re-arming the SAME rule — a phrase editor rewriting it, a timezone edit
    // — must not replay what has already fired.
    setTaskSchedule(store, ruleId, {
      rule: { kind: 'every', everyMs: HOUR },
      timezone: 'America/New_York',
      armedAt: now,
    });
    expect(store.getTask(ruleId)?.schedule?.state?.lastOccurrenceAt).toBe(MON + HOUR);

    // A DIFFERENT rule has fired nothing, so it starts clean — and `armedAt`
    // is then the floor, which is what stops a fresh rule firing for the past.
    setTaskSchedule(store, ruleId, {
      rule: { kind: 'every', everyMs: 6 * HOUR },
      armedAt: now,
    });
    expect(store.getTask(ruleId)?.schedule?.state).toBeUndefined();
  });

  it('clears the rule without touching what the row already recorded', () => {
    const { ruleId } = seed(store, { rule: { kind: 'every', everyMs: HOUR }, armedAt: MON });
    const now = MON + HOUR + 1;
    createTaskScheduler(store, { now: () => now }).tick();
    expect(setTaskSchedule(store, ruleId, null).ok).toBe(true);
    expect(store.getTask(ruleId)?.schedule).toBeUndefined();
    // The run history stays: clearing a schedule is not a delete of the rows
    // it produced or the activity it wrote.
    expect(store.getTask(ruleId)?.notes ?? []).toHaveLength(1);
    expect(createTaskScheduler(store, { now: () => MON + 10 * HOUR }).tick()).toEqual([]);
  });

  it('refuses a row that does not exist', () => {
    expect(setTaskSchedule(store, 't-missing', null)).toEqual({
      ok: false,
      error: 'not-found',
    });
  });
});

describe('the loop itself', () => {
  it('starts and stops idempotently, and its default cadence is well under a minute', () => {
    const scheduler = new TaskScheduler({
      rows: () => [],
      createInstance: () => undefined,
      commit: () => {},
      record: () => {},
    });
    expect(scheduler.running()).toBe(false);
    scheduler.start(50);
    scheduler.start(50);
    expect(scheduler.running()).toBe(true);
    scheduler.stop();
    scheduler.stop();
    expect(scheduler.running()).toBe(false);
    // The finest rule a phrase can express is minutes, so the tick has to sit
    // an order of magnitude under one for the lateness of a fire to be
    // invisible.
    expect(SCHEDULER_TICK_DEFAULT_MS).toBeLessThanOrEqual(60_000);
  });

  it('keeps going when one rule throws', () => {
    const reported: string[] = [];
    let commits = 0;
    const row = (taskId: string) => ({
      taskId,
      workspaceId: 'w-harbour',
      schedule: { rule: { kind: 'every' as const, everyMs: HOUR }, armedAt: MON },
      cursor: {},
    });
    const scheduler = new TaskScheduler({
      now: () => MON + HOUR + 1,
      rows: () => [row('t-bad'), row('t-good')],
      createInstance: (r) => {
        if (r.taskId === 't-bad') throw new Error('the board moved under us');
        return 't-instance';
      },
      commit: () => {
        commits++;
      },
      record: () => {},
      report: (line) => reported.push(line),
    });
    const fired = scheduler.tick();
    expect(fired.map((f) => f.taskId)).toEqual(['t-good']);
    expect(commits).toBe(1);
    expect(reported).toHaveLength(1);
    expect(scheduler.firedCount()).toBe(1);
  });
});
