/**
 * reorder_goals — the permutation-only priority gesture.
 *
 * `setGoalList` is a full REPLACE: reordering with it means restating every
 * id and title, and any id a stale caller leaves out sends that goal's open
 * tasks to the bottom of Backlog. `reorderGoals` exists so the most ordinary
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
 * Goal ids are generated, so no fixture here can name one in advance: each
 * board is seeded through `seedGoals` and every test refers to its bands by
 * the ids that came back. An id a test INVENTS (`g-social`) stays invented —
 * that is the stale-caller case these refusals are about.
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
import { type GoalIds, type SeedGoalSpec, seedGoals, seedGoalsOverHttp } from './goal-seed.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };

/** Three top-level bands, the first with two subgoals — enough to reorder at
 *  both scopes and to prove the untouched scope stayed untouched. The labels
 *  are what used to be hard-coded ids (`launch` was `g-launch`). */
const GOAL_SPEC: SeedGoalSpec[] = [
  {
    key: 'launch',
    title: '1. Ship the launch post',
    dueAt: 1766000000000,
    subgoals: [
      { key: 'launchQa', title: '1.1 QA pass' },
      { key: 'launchCopy', title: '1.2 Copy edit', dueAt: 1767000000000 },
    ],
  },
  { key: 'perf', title: '2. Cut page weight' },
  {
    key: 'docs',
    title: '3. Rewrite the docs',
    subgoals: [{ key: 'docsApi', title: '3.1 API reference' }],
  },
];

type Bands = Record<'launch' | 'launchQa' | 'launchCopy' | 'perf' | 'docs' | 'docsApi', string>;

/** The seed map, narrowed to the labels these tests index. A missing label is
 *  a broken fixture, not an undefined id flowing into an assertion. */
function bands(ids: GoalIds): Bands {
  const at = (key: string): string => {
    const id = ids[key];
    if (id === undefined) throw new Error(`seed produced no id for "${key}"`);
    return id;
  };
  return {
    launch: at('launch'),
    launchQa: at('launchQa'),
    launchCopy: at('launchCopy'),
    perf: at('perf'),
    docs: at('docs'),
    docsApi: at('docsApi'),
  };
}

/** The seeded board restated as a submittable list — `setGoalList` is a full
 *  replace, so keeping a band means naming it by the id the seed minted. */
const boardFor = (G: Bands): WorkspaceGoal[] => [
  {
    id: G.launch,
    title: '1. Ship the launch post',
    dueAt: 1766000000000,
    subgoals: [
      { id: G.launchQa, title: '1.1 QA pass' },
      { id: G.launchCopy, title: '1.2 Copy edit', dueAt: 1767000000000 },
    ],
  },
  { id: G.perf, title: '2. Cut page weight' },
  {
    id: G.docs,
    title: '3. Rewrite the docs',
    subgoals: [{ id: G.docsApi, title: '3.1 API reference' }],
  },
];

/** A throwaway board, seeded, handing back the list it holds. The pure
 *  `summarizeGoals` tests read a goal LIST rather than a store — but the ids
 *  in that list can only come from a real seed now, so even they need one. */
function seededGoalList(): { goals: WorkspaceGoal[]; G: Bands } {
  const dir = mkdtempSync(join(tmpdir(), 'goal-list-'));
  const s = new TaskStore({ dataDir: dir, debounceMs: 5 });
  try {
    const ws = s.createWorkspace('search-revamp');
    const G = bands(seedGoals(s, ws.id, GOAL_SPEC, PERSON));
    return { goals: s.getWorkspace(ws.id)?.goals ?? [], G };
  } finally {
    s.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

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

  /** A workspace seeded with GOAL_SPEC and no events recorded yet. */
  function seed(): { wsId: string; G: Bands } {
    const ws = store.createWorkspace('search-revamp');
    const G = bands(seedGoals(store, ws.id, GOAL_SPEC, PERSON));
    events.length = 0;
    return { wsId: ws.id, G };
  }

  it('permutes the top-level list, carries title/dueAt/subgoals along, and emits one reorder event', () => {
    const { wsId, G } = seed();
    const res = store.reorderGoals(wsId, [G.perf, G.docs, G.launch], { actor: PERSON });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(true);

    const goals = store.getWorkspace(wsId)?.goals ?? [];
    expect(goals.map((g) => g.id)).toEqual([G.perf, G.docs, G.launch]);
    // Nothing about a goal changed except where it sits.
    const launch = goals.find((g) => g.id === G.launch);
    expect(launch?.title).toBe('1. Ship the launch post');
    expect(launch?.dueAt).toBe(1766000000000);
    expect(launch?.subgoals?.map((s) => s.id)).toEqual([G.launchQa, G.launchCopy]);

    expect(events).toHaveLength(1);
    const e = events[0];
    if (e?.type !== 'workspace.goals_changed')
      throw new Error(`expected goals_changed, got ${e?.type}`);
    expect(e.kind).toBe('reorder');
    expect(e.actor.kind).toBe('person');
    expect(e.movedToChores).toEqual([]);
    // oldGoals must show the list as it WAS — an aliased array would report
    // the new order on both sides and the audit row would say nothing.
    expect(e.oldGoals.map((g) => g.id)).toEqual([G.launch, G.perf, G.docs]);
    expect(e.newGoals.map((g) => g.id)).toEqual([G.perf, G.docs, G.launch]);
  });

  it('refuses an order that OMITS a goal — the set_goal_list hazard — and changes nothing', () => {
    const { wsId, G } = seed();
    const res = store.reorderGoals(wsId, [G.perf, G.launch], { actor: PERSON });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('order-mismatch');
    if (res.error !== 'order-mismatch') return;
    expect(res.missingIds).toEqual([G.docs]);
    expect(res.unknownIds).toEqual([]);
    expect(res.duplicateIds).toEqual([]);
    // Absence assertions, with the positive control right after them.
    expect(store.getWorkspace(wsId)?.goals.map((g) => g.id)).toEqual([G.launch, G.perf, G.docs]);
    expect(events).toHaveLength(0);
    const good = store.reorderGoals(wsId, [G.perf, G.launch, G.docs], { actor: PERSON });
    expect(good.ok).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('refuses an id the workspace does not have — the stale-caller case — naming it', () => {
    const { wsId, G } = seed();
    // Another writer removed the docs band and added `g-social` since this
    // caller read — an id no board ever minted is exactly the stale case.
    const res = store.reorderGoals(wsId, ['g-social', G.perf, G.launch, G.docs], {
      actor: AGENT,
    });
    expect(res.ok).toBe(false);
    if (res.ok || res.error !== 'order-mismatch') throw new Error('expected order-mismatch');
    expect(res.unknownIds).toEqual(['g-social']);
    expect(res.missingIds).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it('refuses a repeated id, and refuses the reserved chores id as RESERVED', () => {
    const { wsId, G } = seed();
    const dup = store.reorderGoals(wsId, [G.perf, G.perf, G.launch], { actor: PERSON });
    expect(dup.ok).toBe(false);
    if (dup.ok || dup.error !== 'order-mismatch') throw new Error('expected order-mismatch');
    expect(dup.duplicateIds).toEqual([G.perf]);
    expect(dup.missingIds).toEqual([G.docs]);

    // 'chores' is never in goals[], so trying to position it is a mismatch
    // rather than a silent no-op that looks like it worked — but it is a
    // DIFFERENT mismatch from an invented id, because the caller really did
    // see the row and the fix is "leave it out", not "re-read".
    const chores = store.reorderGoals(wsId, [CHORES_GOAL_ID, G.launch, G.perf, G.docs], {
      actor: PERSON,
    });
    expect(chores.ok).toBe(false);
    if (chores.ok || chores.error !== 'order-mismatch') throw new Error('expected order-mismatch');
    expect(chores.reservedIds).toEqual([CHORES_GOAL_ID]);
    expect(chores.unknownIds).toEqual([]);
    expect(events).toHaveLength(0);
  });

  it('reorders one parent’s subgoals, leaving the top level and the other parent alone', () => {
    const { wsId, G } = seed();
    const res = store.reorderGoals(wsId, [G.launchCopy, G.launchQa], {
      parent: G.launch,
      actor: PERSON,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(true);

    const goals = store.getWorkspace(wsId)?.goals ?? [];
    expect(goals.map((g) => g.id)).toEqual([G.launch, G.perf, G.docs]);
    expect(goals[0]?.subgoals?.map((s) => s.id)).toEqual([G.launchCopy, G.launchQa]);
    // The moved subgoal kept its own fields, and the other parent is intact.
    expect(goals[0]?.subgoals?.[0]?.dueAt).toBe(1767000000000);
    expect(goals[2]?.subgoals?.map((s) => s.id)).toEqual([G.docsApi]);

    const e = events[0];
    if (e?.type !== 'workspace.goals_changed') throw new Error('expected goals_changed');
    expect(e.kind).toBe('reorder');
    // Same aliasing trap, one level deeper: the event's old copy must still
    // hold the pre-reorder subgoal order.
    expect(e.oldGoals[0]?.subgoals?.map((s) => s.id)).toEqual([G.launchQa, G.launchCopy]);
    expect(e.newGoals[0]?.subgoals?.map((s) => s.id)).toEqual([G.launchCopy, G.launchQa]);
  });

  it('refuses an unknown parent, and refuses a SUBGOAL as parent (one level max)', () => {
    const { wsId, G } = seed();
    const missing = store.reorderGoals(wsId, [G.launchQa], {
      parent: 'g-nope',
      actor: PERSON,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toBe('parent-not-found');

    const nested = store.reorderGoals(wsId, [G.launchQa], {
      parent: G.launchCopy,
      actor: PERSON,
    });
    expect(nested.ok).toBe(false);
    if (!nested.ok) expect(nested.error).toBe('parent-not-found');
    expect(events).toHaveLength(0);
  });

  it('is a no-op when the order already matches: changed=false, no event', () => {
    const { wsId, G } = seed();
    const res = store.reorderGoals(wsId, [G.launch, G.perf, G.docs], { actor: PERSON });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.changed).toBe(false);
    expect(events).toHaveLength(0);
    // Positive control: the same store DOES emit for a real reorder.
    store.reorderGoals(wsId, [G.docs, G.launch, G.perf], { actor: PERSON });
    expect(events).toHaveLength(1);
  });

  it('reports workspace-not-found rather than throwing', () => {
    const res = store.reorderGoals('w-nope', ['g-anything'], { actor: PERSON });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('workspace-not-found');
  });

  it('never moves a task: every task keeps its goal across a reorder, where set_goal_list would not', () => {
    const { wsId, G } = seed();
    const a = store.createTask(wsId, { title: 'Trim the bundle', goal: G.perf });
    const b = store.createTask(wsId, { title: 'Proof the copy', goal: G.launchCopy });
    if (!a.ok || !b.ok) throw new Error('create failed');
    events.length = 0;

    const res = store.reorderGoals(wsId, [G.docs, G.perf, G.launch], { actor: PERSON });
    expect(res.ok).toBe(true);
    expect(store.getTask(a.task.id)?.goal).toBe(G.perf);
    expect(store.getTask(b.task.id)?.goal).toBe(G.launchCopy);
    expect(events.filter((e) => e.type === 'task.regrouped')).toHaveLength(0);

    // Positive control for the assertion above: the SAME omission expressed
    // through set_goal_list is exactly what dumps a goal's tasks into Backlog,
    // which is the hazard reorderGoals cannot express.
    // `drop` names the band being removed — the acknowledgement the guard
    // now asks for. It changes who has to SAY the removal, not what one does.
    const board = boardFor(G);
    const dropped = store.setGoalList(wsId, [board[2], board[1]] as WorkspaceGoal[], {
      actor: PERSON,
      drop: [G.launchCopy],
    });
    expect(dropped.ok).toBe(true);
    if (dropped.ok) expect(dropped.movedToChores).toEqual([b.task.id]);
    expect(store.getTask(b.task.id)?.goal).toBe(CHORES_GOAL_ID);
  });
});

describe('summarizeGoals names each subgoal’s parent', () => {
  it('stamps parent on subgoal rows only, so a reorder call can be written from the read', () => {
    const { goals, G } = seededGoalList();
    const rows = summarizeGoals([], goals);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(G.launch)?.parent).toBeUndefined();
    expect(byId.get(G.launchQa)?.parent).toBe(G.launch);
    expect(byId.get(G.docsApi)?.parent).toBe(G.docs);
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
  /** Rows for a workspace built by `seed`, read the way the route reads them,
   *  alongside the ids the seed minted. */
  function rowsFor(seed: (s: TaskStore, wsId: string, G: Bands) => void): {
    rows: GoalSummaryRow[];
    G: Bands;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rows-'));
    const s = new TaskStore({ dataDir: dir, debounceMs: 5 });
    try {
      const ws = s.createWorkspace('search-revamp');
      const G = bands(seedGoals(s, ws.id, GOAL_SPEC, PERSON));
      seed(s, ws.id, G);
      return {
        rows: summarizeGoals(s.listTasks(ws.id, {}), s.getWorkspace(ws.id)?.goals ?? []),
        G,
      };
    } finally {
      s.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('marks every real goal reorderable, at both depths', () => {
    const { goals, G } = seededGoalList();
    const rows = summarizeGoals([], goals);
    // Positive control for the negative assertions below: the field is
    // present and TRUE on every row that is genuinely in the ordered list.
    expect(rows.map((r) => r.id)).toEqual([
      G.launch,
      G.launchQa,
      G.launchCopy,
      G.perf,
      G.docs,
      G.docsApi,
    ]);
    expect(rows.every((r) => r.reorderable === true)).toBe(true);
  });

  it('marks the Backlog row NOT reorderable — it is appended, never ordered', () => {
    const { rows, G } = rowsFor((s, wsId) => {
      s.createTask(wsId, { title: 'Rotate the API key', goal: CHORES_GOAL_ID });
    });
    const chores = rows.find((r) => r.id === CHORES_GOAL_ID);
    // Presence first: the row this asserts about must actually be here.
    expect(chores).toBeDefined();
    expect(chores?.depth).toBe(0);
    expect(chores?.reorderable).toBe(false);
    // …and the real goals in the same payload still say true, so `false` is
    // reporting something about this row rather than about the field.
    expect(rows.find((r) => r.id === G.perf)?.reorderable).toBe(true);
  });

  it('marks an orphaned goal row NOT reorderable', () => {
    const { rows, G } = rowsFor((s, wsId, ids) => {
      const t = s.createTask(wsId, { title: 'Trim the bundle', goal: ids.perf });
      if (!t.ok) throw new Error('create failed');
      // Only a DONE task survives a removal in place; an open one is swept
      // into Backlog, which is the other synthetic row.
      s.transition(t.task.id, 'in-progress', { actor: PERSON });
      s.transition(t.task.id, 'done', { actor: PERSON, evidence: { commit: 'abc1234' } });
      const board = boardFor(ids);
      s.setGoalList(wsId, [board[0], board[2]] as WorkspaceGoal[], {
        actor: PERSON,
        drop: [ids.perf],
      });
    });
    const orphan = rows.find((r) => r.id === G.perf);
    expect(orphan).toBeDefined();
    expect(orphan?.done).toBe(1);
    expect(orphan?.depth).toBe(0);
    expect(orphan?.reorderable).toBe(false);
    expect(rows.find((r) => r.id === G.launch)?.reorderable).toBe(true);
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

  function seeded(): { wsId: string; G: Bands } {
    const ws = store.createWorkspace('search-revamp');
    const G = bands(seedGoals(store, ws.id, GOAL_SPEC, PERSON));
    return { wsId: ws.id, G };
  }

  it('separates `chores` from an id the caller invented', () => {
    const { wsId, G } = seeded();
    const res = store.reorderGoals(wsId, [G.launch, G.perf, G.docs, CHORES_GOAL_ID, 'g-social'], {
      actor: PERSON,
    });
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
    const { wsId, G } = seeded();
    const t = store.createTask(wsId, { title: 'Trim the bundle', goal: G.perf });
    if (!t.ok) throw new Error('create failed');
    store.transition(t.task.id, 'in-progress', { actor: PERSON });
    store.transition(t.task.id, 'done', { actor: PERSON, evidence: { commit: 'abc1234' } });
    const board = boardFor(G);
    store.setGoalList(wsId, [board[0], board[2]] as WorkspaceGoal[], {
      actor: PERSON,
      drop: [G.perf],
    });

    // Presence control: the removed band really is still a row in the read,
    // which is the whole reason a caller would send it back.
    const rows = summarizeGoals(store.listTasks(wsId, {}), store.getWorkspace(wsId)?.goals ?? []);
    expect(rows.find((r) => r.id === G.perf)?.reorderable).toBe(false);

    const res = store.reorderGoals(wsId, [G.launch, G.docs, G.perf], { actor: PERSON });
    expect(res.ok).toBe(false);
    if (res.ok || res.error !== 'order-mismatch') throw new Error('expected order-mismatch');
    expect(res.unknownIds).toEqual([G.perf]);
    expect(res.reservedIds).toEqual([]);
  });

  it('still refuses `chores` even when the rest of the order is perfect', () => {
    const { wsId, G } = seeded();
    const res = store.reorderGoals(wsId, [G.docs, G.perf, G.launch, CHORES_GOAL_ID], {
      actor: PERSON,
    });
    expect(res.ok).toBe(false);
    // Accepting it would be the silent-wrong-result failure: `chores` always
    // renders last, so honouring a caller who put it FIRST is impossible and
    // quietly ignoring the position is worse than saying so.
    expect(store.getWorkspace(wsId)?.goals.map((g) => g.id)).toEqual([G.launch, G.perf, G.docs]);
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

  async function seedWorkspace(): Promise<{ wsId: string; G: Bands }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship search v2.' }),
    );
    const G = bands(await seedGoalsOverHttp(base, workspace.id, GOAL_SPEC, PERSON));
    return { wsId: workspace.id, G };
  }

  async function readGoals(wsId: string): Promise<WorkspaceGoal[]> {
    const got = await jj<{ workspace: { goals: WorkspaceGoal[] } }>(
      await fetch(`${base}/api/workspaces/${wsId}`),
    );
    return got.workspace.goals;
  }

  it('forwards `order` — the stored list reads back in the new order', async () => {
    const { wsId, G } = await seedWorkspace();
    expect((await readGoals(wsId)).map((g) => g.id)).toEqual([G.launch, G.perf, G.docs]);
    const res = await jj<{ changed: boolean; order: string[] }>(
      await post(`/api/workspaces/${wsId}/goals/reorder`, {
        order: [G.docs, G.launch, G.perf],
        author: PERSON,
      }),
    );
    expect(res.changed).toBe(true);
    expect(res.order).toEqual([G.docs, G.launch, G.perf]);
    expect((await readGoals(wsId)).map((g) => g.id)).toEqual([G.docs, G.launch, G.perf]);
  });

  it('forwards `parent` — the subgoal scope actually moves, and the top level does not', async () => {
    const { wsId, G } = await seedWorkspace();
    await jj(
      await post(`/api/workspaces/${wsId}/goals/reorder`, {
        order: [G.launchCopy, G.launchQa],
        parent: G.launch,
        author: PERSON,
      }),
    );
    const goals = await readGoals(wsId);
    // A dropped `parent` would have been read as a top-level reorder and
    // refused as a mismatch — so a 200 here is only meaningful alongside the
    // subgoal order actually having changed.
    expect(goals.map((g) => g.id)).toEqual([G.launch, G.perf, G.docs]);
    expect(goals[0]?.subgoals?.map((s) => s.id)).toEqual([G.launchCopy, G.launchQa]);
  });

  it('forwards `author` into the goals_changed event (person and agent both classify)', async () => {
    const { wsId, G } = await seedWorkspace();
    const seen: TaskStoreEvent[] = [];
    const off = handle.tasks.onEvent((e) => seen.push(e));
    try {
      await jj(
        await post(`/api/workspaces/${wsId}/goals/reorder`, {
          order: [G.perf, G.launch, G.docs],
          author: PERSON,
        }),
      );
      await jj(
        await post(`/api/workspaces/${wsId}/goals/reorder`, {
          order: [G.launch, G.perf, G.docs],
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
    const { wsId, G } = await seedWorkspace();
    const res = await post(`/api/workspaces/${wsId}/goals/reorder`, {
      order: [G.perf, 'g-social'],
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
    expect(body.missingIds.sort()).toEqual([G.docs, G.launch].sort());
    expect(body.message).toContain('g-social');
    expect((await readGoals(wsId)).map((g) => g.id)).toEqual([G.launch, G.perf, G.docs]);
  });

  it('rejects a bad shape, a missing author, and an unknown workspace', async () => {
    const { wsId, G } = await seedWorkspace();
    const order = [G.launch, G.perf, G.docs];
    const cases: Array<[string, unknown, number]> = [
      [wsId, { order: 'not-a-list', author: PERSON }, 400],
      [wsId, { order: [G.launch, 7], author: PERSON }, 400],
      [wsId, { order, parent: 42, author: PERSON }, 400],
      [wsId, { order, parent: 'g-nope', author: PERSON }, 400],
      [wsId, { order }, 400],
      ['w-missing', { order: [G.launch], author: PERSON }, 404],
    ];
    for (const [id, body, status] of cases) {
      const r = await post(`/api/workspaces/${id}/goals/reorder`, body);
      expect(r.status, `${id} ${JSON.stringify(body)}`).toBe(status);
    }
    // Positive control: the same route accepts a well-formed call.
    const ok = await post(`/api/workspaces/${wsId}/goals/reorder`, {
      order: [G.perf, G.launch, G.docs],
      author: PERSON,
    });
    expect(ok.status).toBe(200);
  });

  it('leaves task placement alone across an HTTP reorder', async () => {
    const { wsId, G } = await seedWorkspace();
    const { task } = await jj<{ task: { id: string; goal: string } }>(
      await post(`/api/workspaces/${wsId}/tasks`, {
        author: AGENT,
        title: 'tune the ranking',
        goal: G.perf,
      }),
    );
    await jj(
      await post(`/api/workspaces/${wsId}/goals/reorder`, {
        order: [G.docs, G.perf, G.launch],
        author: PERSON,
      }),
    );
    const { tasks } = await jj<{ tasks: Array<{ id: string; goal: string }> }>(
      await fetch(`${base}/api/workspaces/${wsId}/tasks`),
    );
    expect(tasks.find((t) => t.id === task.id)?.goal).toBe(G.perf);
  });

  it('GET /api/workspaces/:id carries parent on subgoal rows, so the reorder call is writable from the read', async () => {
    const { wsId, G } = await seedWorkspace();
    const got = await jj<{ goalSummary: Array<{ id: string; depth: number; parent?: string }> }>(
      await fetch(`${base}/api/workspaces/${wsId}`),
    );
    const byId = new Map(got.goalSummary.map((r) => [r.id, r]));
    expect(byId.get(G.launchQa)?.parent).toBe(G.launch);
    expect(byId.get(G.launch)?.parent).toBeUndefined();
  });

  /** The whole round trip, over HTTP, exactly as an agent performs it. The
   *  store-level tests above prove `reorderable` is computed; only this one
   *  proves the field survives the route and that filtering on it produces an
   *  order the write ACCEPTS. */
  describe('the read is writable back into the reorder', () => {
    const readRows = async (wsId: string) =>
      (await jj<{ goalSummary: GoalSummaryRow[] }>(await fetch(`${base}/api/workspaces/${wsId}`)))
        .goalSummary;

    /** A board with the two synthetic rows on it: Backlog holding work, and a
     *  goal id left behind on a done task. Without these the round trip
     *  passes for the wrong reason — there is nothing to filter out. */
    async function seedBoardWithBuckets(): Promise<{ wsId: string; G: Bands }> {
      const { wsId, G } = await seedWorkspace();
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
          goal: G.perf,
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
      // Remove the perf band: the done task stays put, so its goal id becomes
      // an orphan row rather than disappearing. `drop` is what makes that
      // removal deliberate rather than the accident a stale list produces.
      const board = boardFor(G);
      await jj(
        await put(`/api/workspaces/${wsId}/goals`, {
          goals: [board[0], board[2]],
          drop: [G.perf],
          author: PERSON,
        }),
      );
      return { wsId, G };
    }

    it('sending back every reorderable depth-0 row succeeds; sending every depth-0 row does not', async () => {
      const { wsId, G } = await seedBoardWithBuckets();
      const rows = await readRows(wsId);

      // Presence control: the payload really does carry rows that are NOT
      // goals, otherwise the filter below proves nothing.
      const notGoals = rows.filter((r) => r.depth === 0 && !r.reorderable).map((r) => r.id);
      expect(notGoals.sort()).toEqual([CHORES_GOAL_ID, G.perf].sort());

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
      expect(scoped).toEqual([G.launch, G.docs]);
      const res = await jj<{ changed: boolean; order: string[] }>(
        await post(`/api/workspaces/${wsId}/goals/reorder`, {
          order: [...scoped].reverse(),
          author: PERSON,
        }),
      );
      expect(res.changed).toBe(true);
      expect((await readGoals(wsId)).map((g) => g.id)).toEqual([G.docs, G.launch]);
    });

    it('the same filter scopes a SUBGOAL reorder from the read alone', async () => {
      const { wsId, G } = await seedBoardWithBuckets();
      const rows = await readRows(wsId);
      const subgoals = rows.filter((r) => r.parent === G.launch && r.reorderable).map((r) => r.id);
      expect(subgoals).toEqual([G.launchQa, G.launchCopy]);
      await jj(
        await post(`/api/workspaces/${wsId}/goals/reorder`, {
          order: [...subgoals].reverse(),
          parent: G.launch,
          author: PERSON,
        }),
      );
      const goals = await readGoals(wsId);
      expect(goals.find((g) => g.id === G.launch)?.subgoals?.map((s) => s.id)).toEqual([
        G.launchCopy,
        G.launchQa,
      ]);
    });

    it('the refusal calls `chores` reserved, not unknown, and says what to send', async () => {
      const { wsId, G } = await seedWorkspace();
      const res = await post(`/api/workspaces/${wsId}/goals/reorder`, {
        order: [G.launch, G.perf, G.docs, CHORES_GOAL_ID],
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
