/**
 * reorder_goals — the permutation-only priority gesture.
 *
 * `setGoalList` is a full REPLACE: reordering with it means restating every
 * id and title, and any id a stale caller leaves out sends that goal's open
 * tasks to the bottom of Chores. `reorderGoals` exists so the most ordinary
 * gesture on a board — "move this band above that one" — cannot do that. Its
 * whole contract is that `order` must be EXACTLY the ids already at one
 * scope: anything omitted, repeated, or invented is refused with the
 * offending ids named, never merged best-effort.
 *
 * Two layers, because the route is the one nothing type-checks (the `groups`
 * lesson): the store semantics below, then the same contract driven over
 * HTTP with the stored effect read back. Every absence assertion (no event,
 * no task moved, no mutation) sits next to a positive control.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ServerHandle, createServer } from '../src/server.ts';
import { type GoalSummaryRow, summarizeGoals } from '../src/task-queue.ts';
import {
  CHORES_GOAL_ID,
  TaskStore,
  type TaskStoreEvent,
  type WorkspaceGoal,
} from '../src/tasks.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };

/** Three top-level bands, the first with two subgoals — enough to reorder at
 *  both scopes and to prove the untouched scope stayed untouched. */
const GOALS: WorkspaceGoal[] = [
  {
    id: 'g-launch',
    title: '1. Ship the launch post',
    dueAt: 1766000000000,
    subgoals: [
      { id: 'g-launch-qa', title: '1.1 QA pass' },
      { id: 'g-launch-copy', title: '1.2 Copy edit', dueAt: 1767000000000 },
    ],
  },
  { id: 'g-perf', title: '2. Cut page weight' },
  {
    id: 'g-docs',
    title: '3. Rewrite the docs',
    subgoals: [{ id: 'g-docs-api', title: '3.1 API reference' }],
  },
];

describe('TaskStore.reorderGoals', () => {
  let dataDir: string;
  let store: TaskStore;
  let events: TaskStoreEvent[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-reorder-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    events = [];
    store.onEvent((e) => events.push(e));
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A workspace seeded with GOALS and no events recorded yet. */
  function seed(): string {
    const ws = store.createWorkspace('search-revamp', 'Ship search v2.');
    store.setGoalList(ws.id, GOALS, { actor: PERSON });
    events.length = 0;
    return ws.id;
  }

  it('permutes the top-level list, carries title/dueAt/subgoals along, and emits one reorder event', () => {
    const wsId = seed();
    const res = store.reorderGoals(wsId, ['g-perf', 'g-docs', 'g-launch'], { actor: PERSON });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(true);

    const goals = store.getWorkspace(wsId)?.goals ?? [];
    expect(goals.map((g) => g.id)).toEqual(['g-perf', 'g-docs', 'g-launch']);
    // Nothing about a goal changed except where it sits.
    const launch = goals.find((g) => g.id === 'g-launch');
    expect(launch?.title).toBe('1. Ship the launch post');
    expect(launch?.dueAt).toBe(1766000000000);
    expect(launch?.subgoals?.map((s) => s.id)).toEqual(['g-launch-qa', 'g-launch-copy']);

    expect(events).toHaveLength(1);
    const e = events[0];
    if (e?.type !== 'workspace.goals_changed')
      throw new Error(`expected goals_changed, got ${e?.type}`);
    expect(e.kind).toBe('reorder');
    expect(e.actor.kind).toBe('person');
    expect(e.movedToChores).toEqual([]);
    // oldGoals must show the list as it WAS — an aliased array would report
    // the new order on both sides and the audit row would say nothing.
    expect(e.oldGoals.map((g) => g.id)).toEqual(['g-launch', 'g-perf', 'g-docs']);
    expect(e.newGoals.map((g) => g.id)).toEqual(['g-perf', 'g-docs', 'g-launch']);
  });

  it('refuses an order that OMITS a goal — the set_goal_list hazard — and changes nothing', () => {
    const wsId = seed();
    const res = store.reorderGoals(wsId, ['g-perf', 'g-launch'], { actor: PERSON });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('order-mismatch');
    if (res.error !== 'order-mismatch') return;
    expect(res.missingIds).toEqual(['g-docs']);
    expect(res.unknownIds).toEqual([]);
    expect(res.duplicateIds).toEqual([]);
    // Absence assertions, with the positive control right after them.
    expect(store.getWorkspace(wsId)?.goals.map((g) => g.id)).toEqual([
      'g-launch',
      'g-perf',
      'g-docs',
    ]);
    expect(events).toHaveLength(0);
    const good = store.reorderGoals(wsId, ['g-perf', 'g-launch', 'g-docs'], { actor: PERSON });
    expect(good.ok).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('refuses an id the workspace does not have — the stale-caller case — naming it', () => {
    const wsId = seed();
    // Another writer removed g-docs and added g-social since this caller read.
    const res = store.reorderGoals(wsId, ['g-social', 'g-perf', 'g-launch', 'g-docs'], {
      actor: AGENT,
    });
    expect(res.ok).toBe(false);
    if (res.ok || res.error !== 'order-mismatch') throw new Error('expected order-mismatch');
    expect(res.unknownIds).toEqual(['g-social']);
    expect(res.missingIds).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it('refuses a repeated id, and refuses the reserved chores id as RESERVED', () => {
    const wsId = seed();
    const dup = store.reorderGoals(wsId, ['g-perf', 'g-perf', 'g-launch'], { actor: PERSON });
    expect(dup.ok).toBe(false);
    if (dup.ok || dup.error !== 'order-mismatch') throw new Error('expected order-mismatch');
    expect(dup.duplicateIds).toEqual(['g-perf']);
    expect(dup.missingIds).toEqual(['g-docs']);

    // 'chores' is never in goals[], so trying to position it is a mismatch
    // rather than a silent no-op that looks like it worked — but it is a
    // DIFFERENT mismatch from an invented id, because the caller really did
    // see the row and the fix is "leave it out", not "re-read".
    const chores = store.reorderGoals(wsId, [CHORES_GOAL_ID, 'g-launch', 'g-perf', 'g-docs'], {
      actor: PERSON,
    });
    expect(chores.ok).toBe(false);
    if (chores.ok || chores.error !== 'order-mismatch') throw new Error('expected order-mismatch');
    expect(chores.reservedIds).toEqual([CHORES_GOAL_ID]);
    expect(chores.unknownIds).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it('reorders one parent’s subgoals, leaving the top level and the other parent alone', () => {
    const wsId = seed();
    const res = store.reorderGoals(wsId, ['g-launch-copy', 'g-launch-qa'], {
      parent: 'g-launch',
      actor: PERSON,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(true);

    const goals = store.getWorkspace(wsId)?.goals ?? [];
    expect(goals.map((g) => g.id)).toEqual(['g-launch', 'g-perf', 'g-docs']);
    expect(goals[0]?.subgoals?.map((s) => s.id)).toEqual(['g-launch-copy', 'g-launch-qa']);
    // The moved subgoal kept its own fields, and the other parent is intact.
    expect(goals[0]?.subgoals?.[0]?.dueAt).toBe(1767000000000);
    expect(goals[2]?.subgoals?.map((s) => s.id)).toEqual(['g-docs-api']);

    const e = events[0];
    if (e?.type !== 'workspace.goals_changed') throw new Error('expected goals_changed');
    expect(e.kind).toBe('reorder');
    // Same aliasing trap, one level deeper: the event's old copy must still
    // hold the pre-reorder subgoal order.
    expect(e.oldGoals[0]?.subgoals?.map((s) => s.id)).toEqual(['g-launch-qa', 'g-launch-copy']);
    expect(e.newGoals[0]?.subgoals?.map((s) => s.id)).toEqual(['g-launch-copy', 'g-launch-qa']);
  });

  it('refuses an unknown parent, and refuses a SUBGOAL as parent (one level max)', () => {
    const wsId = seed();
    const missing = store.reorderGoals(wsId, ['g-launch-qa'], {
      parent: 'g-nope',
      actor: PERSON,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBe('parent-not-found');

    const nested = store.reorderGoals(wsId, ['g-launch-qa'], {
      parent: 'g-launch-copy',
      actor: PERSON,
    });
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.error).toBe('parent-not-found');
    expect(events).toHaveLength(0);
  });

  it('is a no-op when the order already matches: changed=false, no event', () => {
    const wsId = seed();
    const res = store.reorderGoals(wsId, ['g-launch', 'g-perf', 'g-docs'], { actor: PERSON });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.changed).toBe(false);
    expect(events).toHaveLength(0);
    // Positive control: the same store DOES emit for a real reorder.
    store.reorderGoals(wsId, ['g-docs', 'g-launch', 'g-perf'], { actor: PERSON });
    expect(events).toHaveLength(1);
  });

  it('reports workspace-not-found rather than throwing', () => {
    const res = store.reorderGoals('w-nope', ['g-launch'], { actor: PERSON });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('workspace-not-found');
  });

  it('never moves a task: every task keeps its goal across a reorder, where set_goal_list would not', () => {
    const wsId = seed();
    const a = store.createTask(wsId, { title: 'Trim the bundle', goal: 'g-perf' });
    const b = store.createTask(wsId, { title: 'Proof the copy', goal: 'g-launch-copy' });
    if (!a.ok || !b.ok) throw new Error('create failed');
    events.length = 0;

    const res = store.reorderGoals(wsId, ['g-docs', 'g-perf', 'g-launch'], { actor: PERSON });
    expect(res.ok).toBe(true);
    expect(store.getTask(a.task.id)?.goal).toBe('g-perf');
    expect(store.getTask(b.task.id)?.goal).toBe('g-launch-copy');
    expect(events.filter((e) => e.type === 'task.regrouped')).toHaveLength(0);

    // Positive control for the assertion above: the SAME omission expressed
    // through set_goal_list is exactly what dumps a goal's tasks into Chores,
    // which is the hazard reorderGoals cannot express.
    // `drop` names the band being removed — the acknowledgement the guard
    // now asks for. It changes who has to SAY the removal, not what one does.
    const dropped = store.setGoalList(wsId, [GOALS[2], GOALS[1]] as WorkspaceGoal[], {
      actor: PERSON,
      drop: ['g-launch-copy'],
    });
    expect(dropped.ok).toBe(true);
    if (dropped.ok) expect(dropped.movedToChores).toEqual([b.task.id]);
    expect(store.getTask(b.task.id)?.goal).toBe(CHORES_GOAL_ID);
  });
});

describe('summarizeGoals names each subgoal’s parent', () => {
  it('stamps parent on subgoal rows only, so a reorder call can be written from the read', () => {
    const rows = summarizeGoals([], GOALS);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('g-launch')?.parent).toBeUndefined();
    expect(byId.get('g-launch-qa')?.parent).toBe('g-launch');
    expect(byId.get('g-docs-api')?.parent).toBe('g-docs');
  });
});

/**
 * `parent` scopes a SUBGOAL reorder. Nothing scoped the TOP-LEVEL one, and
 * "every depth-0 row" — the only rule the read offered — is wrong: the list
 * ends with rows that are not goals at all. `chores` is appended whenever it
 * holds anything, and a goal id that a `setGoalList` removal left behind on a
 * DONE task comes back as a bare row so the work stays visible. Both render
 * at depth 0, identical in shape to a real band, and both are refused by
 * `reorderGoals` — so the most obvious way to write the call from the read is
 * a 400. `reorderable` is the field that says which rows the write accepts.
 */
describe('summarizeGoals marks which rows a reorder accepts', () => {
  /** Rows for a workspace built by `seed`, read the way the route reads them. */
  function rowsFor(seed: (s: TaskStore, wsId: string) => void): GoalSummaryRow[] {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rows-'));
    const s = new TaskStore({ dataDir: dir, debounceMs: 5 });
    try {
      const ws = s.createWorkspace('search-revamp', 'Ship search v2.');
      s.setGoalList(ws.id, GOALS, { actor: PERSON });
      seed(s, ws.id);
      return summarizeGoals(s.listTasks(ws.id, {}), s.getWorkspace(ws.id)?.goals ?? []);
    } finally {
      s.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('marks every real goal reorderable, at both depths', () => {
    const rows = summarizeGoals([], GOALS);
    // Positive control for the negative assertions below: the field is
    // present and TRUE on every row that is genuinely in the ordered list.
    expect(rows.map((r) => r.id)).toEqual([
      'g-launch',
      'g-launch-qa',
      'g-launch-copy',
      'g-perf',
      'g-docs',
      'g-docs-api',
    ]);
    expect(rows.every((r) => r.reorderable === true)).toBe(true);
  });

  it('marks the Chores row NOT reorderable — it is appended, never ordered', () => {
    const rows = rowsFor((s, wsId) => {
      s.createTask(wsId, { title: 'Rotate the API key', goal: CHORES_GOAL_ID });
    });
    const chores = rows.find((r) => r.id === CHORES_GOAL_ID);
    // Presence first: the row this asserts about must actually be here.
    expect(chores).toBeDefined();
    expect(chores?.depth).toBe(0);
    expect(chores?.reorderable).toBe(false);
    // …and the real goals in the same payload still say true, so `false` is
    // reporting something about this row rather than about the field.
    expect(rows.find((r) => r.id === 'g-perf')?.reorderable).toBe(true);
  });

  it('marks an orphaned goal row NOT reorderable', () => {
    const rows = rowsFor((s, wsId) => {
      const t = s.createTask(wsId, { title: 'Trim the bundle', goal: 'g-perf' });
      if (!t.ok) throw new Error('create failed');
      // Only a DONE task survives a removal in place; an open one is swept
      // into Chores, which is the other synthetic row.
      s.transition(t.task.id, 'in-progress', { actor: PERSON });
      s.transition(t.task.id, 'done', { actor: PERSON, evidence: { commit: 'abc1234' } });
      s.setGoalList(wsId, [GOALS[0], GOALS[2]] as WorkspaceGoal[], {
        actor: PERSON,
        drop: ['g-perf'],
      });
    });
    const orphan = rows.find((r) => r.id === 'g-perf');
    expect(orphan).toBeDefined();
    expect(orphan?.done).toBe(1);
    expect(orphan?.depth).toBe(0);
    expect(orphan?.reorderable).toBe(false);
    expect(rows.find((r) => r.id === 'g-launch')?.reorderable).toBe(true);
  });
});

describe('TaskStore.reorderGoals names a RESERVED id as reserved', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-reserved-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });
  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function seeded(): string {
    const ws = store.createWorkspace('search-revamp', 'Ship search v2.');
    store.setGoalList(ws.id, GOALS, { actor: PERSON });
    return ws.id;
  }

  it('separates `chores` from an id the caller invented', () => {
    const wsId = seeded();
    const res = store.reorderGoals(
      wsId,
      ['g-launch', 'g-perf', 'g-docs', CHORES_GOAL_ID, 'g-social'],
      { actor: PERSON },
    );
    expect(res.ok).toBe(false);
    if (res.ok || res.error !== 'order-mismatch') throw new Error('expected order-mismatch');
    // `chores` is not unknown — it is a real bucket that is never ordered.
    // Telling the caller "unknown" sends them looking for a typo.
    expect(res.reservedIds).toEqual([CHORES_GOAL_ID]);
    // Positive control: a genuinely invented id still lands in unknownIds,
    // so `reservedIds` is a split rather than a relabelling of everything.
    expect(res.unknownIds).toEqual(['g-social']);
    expect(res.missingIds).toEqual([]);
  });

  /** Both rows read `reorderable: false`, so the caller's ACTION is the same
   *  for both — drop it. They are still reported differently on purpose, and
   *  an independent reviewer read the asymmetry as a bug, so it is pinned
   *  here with the reason rather than left to be "fixed" into a field name
   *  that would then be wrong. `chores` is RESERVED: a permanent bucket that
   *  will never be orderable. An orphan is UNKNOWN: a goal that genuinely
   *  was removed, and saying "reserved" would imply it is coming back. */
  it('reports an ORPHANED id as unknown, not reserved — it was removed, not reserved', () => {
    const wsId = seeded();
    const t = store.createTask(wsId, { title: 'Trim the bundle', goal: 'g-perf' });
    if (!t.ok) throw new Error('create failed');
    store.transition(t.task.id, 'in-progress', { actor: PERSON });
    store.transition(t.task.id, 'done', { actor: PERSON, evidence: { commit: 'abc1234' } });
    store.setGoalList(wsId, [GOALS[0], GOALS[2]] as WorkspaceGoal[], {
      actor: PERSON,
      drop: ['g-perf'],
    });

    // Presence control: g-perf really is still a row in the read, which is
    // the whole reason a caller would send it back.
    const rows = summarizeGoals(store.listTasks(wsId, {}), store.getWorkspace(wsId)?.goals ?? []);
    expect(rows.find((r) => r.id === 'g-perf')?.reorderable).toBe(false);

    const res = store.reorderGoals(wsId, ['g-launch', 'g-docs', 'g-perf'], { actor: PERSON });
    expect(res.ok).toBe(false);
    if (res.ok || res.error !== 'order-mismatch') throw new Error('expected order-mismatch');
    expect(res.unknownIds).toEqual(['g-perf']);
    expect(res.reservedIds).toEqual([]);
  });

  it('still refuses `chores` even when the rest of the order is perfect', () => {
    const wsId = seeded();
    const res = store.reorderGoals(wsId, ['g-docs', 'g-perf', 'g-launch', CHORES_GOAL_ID], {
      actor: PERSON,
    });
    expect(res.ok).toBe(false);
    // Accepting it would be the silent-wrong-result failure: `chores` always
    // renders last, so honouring a caller who put it FIRST is impossible and
    // quietly ignoring the position is worse than saying so.
    expect(store.getWorkspace(wsId)?.goals.map((g) => g.id)).toEqual([
      'g-launch',
      'g-perf',
      'g-docs',
    ]);
  });
});

describe('POST /api/workspaces/:id/goals/reorder', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-reorder-http-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const put = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  async function seedWorkspace(): Promise<string> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship search v2.' }),
    );
    await jj(await put(`/api/workspaces/${workspace.id}/goals`, { goals: GOALS, author: PERSON }));
    return workspace.id;
  }

  async function readGoals(wsId: string): Promise<WorkspaceGoal[]> {
    const got = await jj<{ workspace: { goals: WorkspaceGoal[] } }>(
      await fetch(`${base}/api/workspaces/${wsId}`),
    );
    return got.workspace.goals;
  }

  it('forwards `order` — the stored list reads back in the new order', async () => {
    const wsId = await seedWorkspace();
    expect((await readGoals(wsId)).map((g) => g.id)).toEqual(['g-launch', 'g-perf', 'g-docs']);
    const res = await jj<{ changed: boolean; order: string[] }>(
      await post(`/api/workspaces/${wsId}/goals/reorder`, {
        order: ['g-docs', 'g-launch', 'g-perf'],
        author: PERSON,
      }),
    );
    expect(res.changed).toBe(true);
    expect(res.order).toEqual(['g-docs', 'g-launch', 'g-perf']);
    expect((await readGoals(wsId)).map((g) => g.id)).toEqual(['g-docs', 'g-launch', 'g-perf']);
  });

  it('forwards `parent` — the subgoal scope actually moves, and the top level does not', async () => {
    const wsId = await seedWorkspace();
    await jj(
      await post(`/api/workspaces/${wsId}/goals/reorder`, {
        order: ['g-launch-copy', 'g-launch-qa'],
        parent: 'g-launch',
        author: PERSON,
      }),
    );
    const goals = await readGoals(wsId);
    // A dropped `parent` would have been read as a top-level reorder and
    // refused as a mismatch — so a 200 here is only meaningful alongside the
    // subgoal order actually having changed.
    expect(goals.map((g) => g.id)).toEqual(['g-launch', 'g-perf', 'g-docs']);
    expect(goals[0]?.subgoals?.map((s) => s.id)).toEqual(['g-launch-copy', 'g-launch-qa']);
  });

  it('forwards `author` into the goals_changed event (person and agent both classify)', async () => {
    const wsId = await seedWorkspace();
    const seen: TaskStoreEvent[] = [];
    const off = handle.tasks.onEvent((e) => seen.push(e));
    try {
      await jj(
        await post(`/api/workspaces/${wsId}/goals/reorder`, {
          order: ['g-perf', 'g-launch', 'g-docs'],
          author: PERSON,
        }),
      );
      await jj(
        await post(`/api/workspaces/${wsId}/goals/reorder`, {
          order: ['g-launch', 'g-perf', 'g-docs'],
          author: AGENT,
        }),
      );
    } finally {
      off();
    }
    const changed = seen.filter((e) => e.type === 'workspace.goals_changed');
    expect(changed.map((e) => (e as { actor: { kind: string } }).actor.kind)).toEqual([
      'person',
      'agent',
    ]);
    expect(changed.map((e) => (e as { kind: string }).kind)).toEqual(['reorder', 'reorder']);
  });

  it('refuses a mismatched order with 400 and the offending ids, leaving the list untouched', async () => {
    const wsId = await seedWorkspace();
    const res = await post(`/api/workspaces/${wsId}/goals/reorder`, {
      order: ['g-perf', 'g-social'],
      author: PERSON,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      unknownIds: string[];
      missingIds: string[];
      duplicateIds: string[];
      message: string;
    };
    expect(body.error).toBe('order-mismatch');
    expect(body.unknownIds).toEqual(['g-social']);
    expect(body.missingIds.sort()).toEqual(['g-docs', 'g-launch']);
    expect(body.message).toContain('g-social');
    expect((await readGoals(wsId)).map((g) => g.id)).toEqual(['g-launch', 'g-perf', 'g-docs']);
  });

  it('rejects a bad shape, a missing author, and an unknown workspace', async () => {
    const wsId = await seedWorkspace();
    const cases: Array<[string, unknown, number]> = [
      [wsId, { order: 'not-a-list', author: PERSON }, 400],
      [wsId, { order: ['g-launch', 7], author: PERSON }, 400],
      [wsId, { order: ['g-launch', 'g-perf', 'g-docs'], parent: 42, author: PERSON }, 400],
      [wsId, { order: ['g-launch', 'g-perf', 'g-docs'], parent: 'g-nope', author: PERSON }, 400],
      [wsId, { order: ['g-launch', 'g-perf', 'g-docs'] }, 400],
      ['w-missing', { order: ['g-launch'], author: PERSON }, 404],
    ];
    for (const [id, body, status] of cases) {
      const r = await post(`/api/workspaces/${id}/goals/reorder`, body);
      expect(r.status, `${id} ${JSON.stringify(body)}`).toBe(status);
    }
    // Positive control: the same route accepts a well-formed call.
    const ok = await post(`/api/workspaces/${wsId}/goals/reorder`, {
      order: ['g-perf', 'g-launch', 'g-docs'],
      author: PERSON,
    });
    expect(ok.status).toBe(200);
  });

  it('leaves task placement alone across an HTTP reorder', async () => {
    const wsId = await seedWorkspace();
    const { task } = await jj<{ task: { id: string; goal: string } }>(
      await post(`/api/workspaces/${wsId}/tasks`, {
        author: AGENT,
        title: 'tune the ranking',
        goal: 'g-perf',
      }),
    );
    await jj(
      await post(`/api/workspaces/${wsId}/goals/reorder`, {
        order: ['g-docs', 'g-perf', 'g-launch'],
        author: PERSON,
      }),
    );
    const { tasks } = await jj<{ tasks: Array<{ id: string; goal: string }> }>(
      await fetch(`${base}/api/workspaces/${wsId}/tasks`),
    );
    expect(tasks.find((t) => t.id === task.id)?.goal).toBe('g-perf');
  });

  it('GET /api/workspaces/:id carries parent on subgoal rows, so the reorder call is writable from the read', async () => {
    const wsId = await seedWorkspace();
    const got = await jj<{ goalSummary: Array<{ id: string; depth: number; parent?: string }> }>(
      await fetch(`${base}/api/workspaces/${wsId}`),
    );
    const byId = new Map(got.goalSummary.map((r) => [r.id, r]));
    expect(byId.get('g-launch-qa')?.parent).toBe('g-launch');
    expect(byId.get('g-launch')?.parent).toBeUndefined();
  });

  /** The whole round trip, over HTTP, exactly as an agent performs it. The
   *  store-level tests above prove `reorderable` is computed; only this one
   *  proves the field survives the route and that filtering on it produces an
   *  order the write ACCEPTS. */
  describe('the read is writable back into the reorder', () => {
    const readRows = async (wsId: string) =>
      (await jj<{ goalSummary: GoalSummaryRow[] }>(await fetch(`${base}/api/workspaces/${wsId}`)))
        .goalSummary;

    /** A board with the two synthetic rows on it: Chores holding work, and a
     *  goal id left behind on a done task. Without these the round trip
     *  passes for the wrong reason — there is nothing to filter out. */
    async function seedBoardWithBuckets(): Promise<string> {
      const wsId = await seedWorkspace();
      await jj(
        await post(`/api/workspaces/${wsId}/tasks`, {
          author: AGENT,
          title: 'rotate the api key',
          goal: CHORES_GOAL_ID,
        }),
      );
      const { task } = await jj<{ task: { id: string } }>(
        await post(`/api/workspaces/${wsId}/tasks`, {
          author: AGENT,
          title: 'trim the bundle',
          goal: 'g-perf',
        }),
      );
      for (const to of ['in-progress', 'done']) {
        await jj(
          await post(`/api/tasks/${task.id}/transition`, {
            author: AGENT,
            to,
            evidence: { commit: 'abc1234' },
          }),
        );
      }
      // Remove g-perf: the done task stays put, so its goal id becomes an
      // orphan row rather than disappearing. `drop` is what makes that
      // removal deliberate rather than the accident a stale list produces.
      await jj(
        await put(`/api/workspaces/${wsId}/goals`, {
          goals: [GOALS[0], GOALS[2]],
          drop: ['g-perf'],
          author: PERSON,
        }),
      );
      return wsId;
    }

    it('sending back every reorderable depth-0 row succeeds; sending every depth-0 row does not', async () => {
      const wsId = await seedBoardWithBuckets();
      const rows = await readRows(wsId);

      // Presence control: the payload really does carry rows that are NOT
      // goals, otherwise the filter below proves nothing.
      const notGoals = rows.filter((r) => r.depth === 0 && !r.reorderable).map((r) => r.id);
      expect(notGoals.sort()).toEqual([CHORES_GOAL_ID, 'g-perf']);

      // The naive read → write, which is what an agent writes when the only
      // rule available is "the depth-0 rows": refused.
      const naive = rows.filter((r) => r.depth === 0).map((r) => r.id);
      const naiveRes = await post(`/api/workspaces/${wsId}/goals/reorder`, {
        order: [...naive].reverse(),
        author: PERSON,
      });
      expect(naiveRes.status).toBe(400);

      // The same gesture written from `reorderable`: accepted, and the board
      // actually moved.
      const scoped = rows.filter((r) => r.depth === 0 && r.reorderable).map((r) => r.id);
      expect(scoped).toEqual(['g-launch', 'g-docs']);
      const res = await jj<{ changed: boolean; order: string[] }>(
        await post(`/api/workspaces/${wsId}/goals/reorder`, {
          order: [...scoped].reverse(),
          author: PERSON,
        }),
      );
      expect(res.changed).toBe(true);
      expect((await readGoals(wsId)).map((g) => g.id)).toEqual(['g-docs', 'g-launch']);
    });

    it('the same filter scopes a SUBGOAL reorder from the read alone', async () => {
      const wsId = await seedBoardWithBuckets();
      const rows = await readRows(wsId);
      const subgoals = rows
        .filter((r) => r.parent === 'g-launch' && r.reorderable)
        .map((r) => r.id);
      expect(subgoals).toEqual(['g-launch-qa', 'g-launch-copy']);
      await jj(
        await post(`/api/workspaces/${wsId}/goals/reorder`, {
          order: [...subgoals].reverse(),
          parent: 'g-launch',
          author: PERSON,
        }),
      );
      const goals = await readGoals(wsId);
      expect(goals.find((g) => g.id === 'g-launch')?.subgoals?.map((s) => s.id)).toEqual([
        'g-launch-copy',
        'g-launch-qa',
      ]);
    });

    it('the refusal calls `chores` reserved, not unknown, and says what to send', async () => {
      const wsId = await seedWorkspace();
      const res = await post(`/api/workspaces/${wsId}/goals/reorder`, {
        order: ['g-launch', 'g-perf', 'g-docs', CHORES_GOAL_ID],
        author: PERSON,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: string;
        reservedIds: string[];
        unknownIds: string[];
        message: string;
      };
      expect(body.error).toBe('order-mismatch');
      expect(body.reservedIds).toEqual([CHORES_GOAL_ID]);
      expect(body.unknownIds).toEqual([]);
      expect(body.message).toContain('reserved');
      expect(body.message).toContain('reorderable');
    });
  });
});
