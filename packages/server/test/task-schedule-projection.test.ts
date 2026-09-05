/**
 * A row's rule has to reach the browser, or the panel's phrase editor opens
 * on an empty box over a schedule that is already armed.
 *
 * Driven against a real `TaskStore`, because the claim is about what
 * `projectTask` puts on the wire for a row the store actually holds — a
 * hand-built task object would satisfy it by construction.
 *
 * All fixtures are invented. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskSchedule } from '@feedback/core/task-schedule';
import { projectTask } from '../src/task-row.ts';
import { setTaskSchedule } from '../src/task-scheduler.ts';
import { TaskStore } from '../src/tasks.ts';

const OWNER = { id: 'agent-lamplighter', name: 'Lamplighter', kind: 'agent' } as const;
/** 2026-03-02T00:00:00Z, a Monday. */
const MON = Date.UTC(2026, 2, 2);

describe('the rule reaches the browser', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-schedule-projection-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function seedRow(title: string) {
    const ws = store.createWorkspace('Harbour Lights');
    const goals = store.setGoalList(ws.id, [{ title: 'Keep the lamps lit' }], { actor: OWNER });
    if (!goals.ok) throw new Error('goal list refused');
    const goal = goals.created[0]?.id;
    if (goal === undefined) throw new Error('no goal id');
    const created = store.createTask(ws.id, {
      title,
      body: `Agent can ${title.toLowerCase()} so that the beam stays clean.`,
      assignee: OWNER.name,
      assigneeKind: 'agent',
      goal,
      actor: OWNER,
    });
    if (!created.ok) throw new Error(`create refused: ${created.error}`);
    return { workspaceId: ws.id, goal, taskId: created.task.id };
  }

  it('projects the whole rule, so the panel can read it back as a phrase', () => {
    const schedule: TaskSchedule = {
      rule: { kind: 'calendar', times: [{ hour: 9, minute: 0 }], weekdays: [1, 2, 3, 4, 5] },
      timezone: 'America/Los_Angeles',
      until: MON + 30 * 86_400_000,
      armedAt: MON,
      armedBy: OWNER.name,
    };
    const { taskId } = seedRow('Sweep the lamp room');
    const armed = setTaskSchedule(store, taskId, schedule);
    if (!armed.ok) throw new Error('arm refused');
    const row = store.getTask(taskId);
    if (!row) throw new Error('rule row vanished');
    expect(projectTask(row).schedule).toEqual(schedule);
  });

  it('projects no key at all for an unscheduled row', () => {
    // So a reader cannot mistake a row nobody has scheduled for one that is
    // armed and has never fired — `schedule.state` is what answers that, and
    // only for rows that carry a rule.
    const { taskId } = seedRow('Polish the lens');
    const row = store.getTask(taskId);
    if (!row) throw new Error('row vanished');
    expect(projectTask(row)).not.toHaveProperty('schedule');
  });
});
