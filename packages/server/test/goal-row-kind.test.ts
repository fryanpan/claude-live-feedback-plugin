/**
 * The `kind` discriminator that tells a goal row from a task row.
 *
 * A goal is becoming a row with a status somebody declares, and the first
 * thing that needs saying is which rows those are. `kind` is that fact, and
 * it is OPTIONAL on purpose: every task ever persisted predates the field, so
 * a required one would mean rewriting every sidecar on the deploy to record
 * something already true of all of them. Absent reads as `'task'`, which is
 * what a row written before goals had rows actually is.
 *
 * `isGoalRow` exists so that question is asked ONE way. The alternative — a
 * `kind === 'goal'` comparison at each site — is how a reader ends up treating
 * an absent kind as a goal, and the whole point of the discriminator is that
 * task readers keep seeing exactly what they saw before.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type GoalRow, TaskStore, isGoalRow } from '../src/tasks.ts';

const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };

describe('the kind discriminator', () => {
  let dir: string;
  let store: TaskStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'goal-kind-'));
    store = new TaskStore({ dataDir: dir, debounceMs: 1 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a freshly created task as a task, not a goal', () => {
    const ws = store.createWorkspace('Board');
    const created = store.createTask(ws.id, {
      title: 'Ship the thing',
      assignee: 'Search Revamp',
      actor: AGENT,
    });
    if (!created.ok) throw new Error('create refused');
    expect(isGoalRow(created.task)).toBe(false);
  });

  it('reads an absent kind as a task — the legacy row every sidecar holds', () => {
    // Exactly the shape a row persisted before this field looks like on
    // hydrate. The positive control is below: the same predicate must say
    // yes to something.
    expect(isGoalRow({ kind: undefined })).toBe(false);
    expect(isGoalRow({})).toBe(false);
  });

  it('reads an explicit goal kind as a goal', () => {
    expect(isGoalRow({ kind: 'goal' })).toBe(true);
  });

  it('types a goal row without a goal of its own or an invented owner', () => {
    // A goal row is contained by nothing (only tasks carry `goal`), and its
    // owner is a vacancy rather than the lead agent — the same reason
    // `leadAgentId` is optional. This is a type-level assertion: it fails to
    // compile if either field becomes required.
    const row: GoalRow = {
      id: 'g-abc',
      workspaceId: 'w-abc',
      kind: 'goal',
      title: 'Make review fast',
      order: 1,
      status: 'todo',
      transitions: [],
      createdAt: 1,
      updatedAt: 1,
    };
    expect(isGoalRow(row)).toBe(true);
    expect(row.assignee).toBeUndefined();
  });
});
