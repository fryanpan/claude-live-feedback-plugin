/**
 * Adding a goal band without losing one.
 *
 * Inline goal editing on the board needs two verbs, and `renameGoal` was only
 * the first. The second — add a band — has no safe spelling through
 * `setGoalList`, because that is a full REPLACE keyed by id: a board that
 * submits "the list I am looking at, plus one" submits the list it last READ,
 * so any band another writer added since is absent from it, and an absent id
 * is a removal. Measured here, both arms are wrong and only one of them is
 * loud: if the concurrent band holds tasks the stranding guard refuses the
 * whole call, so the add simply fails; if it holds none, the replace succeeds
 * and the band is silently gone. Nothing about an empty band makes it
 * disposable — it is where the person who just created it is about to file
 * work.
 *
 * `addGoal` rebuilds the entry list from the LIVE `workspace.goals` at call
 * time and splices in exactly one entry with no id, so the only difference
 * between what goes in and what was already there is the addition. It then
 * delegates to `setGoalList`, which is what mints the id and asks for the
 * bucket re-look — a new band IS a new destination, which is the case that
 * trigger is keyed on.
 *
 * The concurrency case is the reason this file exists rather than a couple of
 * assertions bolted onto goal-rename.test.ts, and it is written the way the
 * incident happens: seed a board, take a snapshot of it the way a client
 * would, let a SECOND writer add a band, then add through the stale client's
 * gesture and assert the second writer's band and its tasks are still there.
 *
 * The route layer gets its own block because it is the layer nothing
 * type-checks — `after` is exactly the shape of param a hand-copying handler
 * accepts and discards while answering 200 (the `groups` lesson).
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ServerHandle, createServer } from '../src/server.ts';
import { CHORES_GOAL_ID, type Task, TaskStore, type TaskStoreEvent } from '../src/tasks.ts';
import { type SeedGoalSpec, seedGoals, seedGoalsOverHttp } from './goal-seed.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };

const GOAL_SPEC: SeedGoalSpec[] = [
  {
    key: 'launch',
    title: '1. Ship the launch post',
    subgoals: [{ key: 'launchQa', title: '1.1 QA pass' }],
  },
  { key: 'perf', title: '2. Cut page weight' },
];

describe('TaskStore.addGoal', () => {
  let dataDir: string;
  let store: TaskStore;
  let events: TaskStoreEvent[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-add-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    events = [];
    store.onEvent((e) => events.push(e));
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function seed(): { wsId: string; launch: string; perf: string; launchQa: string; task: string } {
    const ws = store.createWorkspace('search-revamp');
    const ids = seedGoals(store, ws.id, GOAL_SPEC, PERSON);
    const launch = ids.launch as string;
    const perf = ids.perf as string;
    const launchQa = ids.launchQa as string;
    const res = store.createTask(ws.id, {
      title: 'draft the announcement',
      goal: launch,
      actor: AGENT,
    });
    if (!res.ok) throw new Error(`fixture create failed: ${res.error}`);
    events.length = 0;
    return { wsId: ws.id, launch, perf, launchQa, task: res.task.id };
  }

  const goalIds = (wsId: string): string[] =>
    (store.getWorkspace(wsId)?.goals ?? []).map((g) => g.id);

  it('appends a band with a fresh id, leaving every other band and its tasks alone', () => {
    const { wsId, launch, perf, launchQa, task } = seed();
    // Positive control: the probe can see the pre-existing bands and the work
    // filed under one of them right now.
    expect(goalIds(wsId)).toEqual([launch, perf]);
    expect(store.getTask(task)?.goal).toBe(launch);

    const res = store.addGoal(wsId, { title: '3. Cut support load' }, { actor: PERSON });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.goal.title).toBe('3. Cut support load');
    // A minted id, not one the caller could have guessed, and not a reused one.
    expect(res.goal.id).not.toBe(launch);
    expect(res.goal.id).not.toBe(perf);
    expect(res.goal.id).not.toBe(CHORES_GOAL_ID);

    expect(goalIds(wsId)).toEqual([launch, perf, res.goal.id]);
    // Nothing moved, and the subgoal rode along.
    expect(store.getTask(task)?.goal).toBe(launch);
    const goals = store.getWorkspace(wsId)?.goals ?? [];
    expect(goals[0]?.subgoals?.map((s) => s.id)).toEqual([launchQa]);
  });

  it('inserts directly after a named band', () => {
    const { wsId, launch, perf } = seed();
    const res = store.addGoal(wsId, { title: '1a. Warm the list' }, { actor: PERSON });
    expect(res.ok).toBe(true);
    const first = res.ok ? res.goal.id : '';
    // Appended, so far.
    expect(goalIds(wsId)).toEqual([launch, perf, first]);

    const res2 = store.addGoal(
      wsId,
      { title: '1b. Draft the FAQ', after: launch },
      { actor: PERSON },
    );
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    expect(goalIds(wsId)).toEqual([launch, res2.goal.id, perf, first]);
  });

  it('refuses an `after` that names nothing on the list rather than silently appending', () => {
    const { wsId, launch, perf, launchQa } = seed();
    const before = goalIds(wsId);
    const res = store.addGoal(
      wsId,
      { title: '3. Cut support load', after: 'g-nope' },
      { actor: PERSON },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('after-not-found');
    // A SUBGOAL id is the realistic near-miss, and it is refused for the same
    // reason: display flattens subgoals, but the list this splices is the
    // top-level one, so there is no position for it to mean.
    const sub = store.addGoal(
      wsId,
      { title: '3. Cut support load', after: launchQa },
      { actor: PERSON },
    );
    expect(sub.ok).toBe(false);
    // Neither refusal wrote anything.
    expect(goalIds(wsId)).toEqual(before);
    expect(goalIds(wsId)).toEqual([launch, perf]);
    expect(events).toEqual([]);
  });

  it('does not remove a band a CONCURRENT writer added, the way a full replace would', () => {
    const { wsId, launch, perf } = seed();

    // What a client is looking at when it decides to add a band.
    const stale = (store.getWorkspace(wsId)?.goals ?? []).map((g) => ({
      id: g.id,
      title: g.title,
    }));
    expect(stale.map((g) => g.id)).toEqual([launch, perf]);

    // Somebody else adds a band and files work under it.
    const other = store.addGoal(wsId, { title: '3. Support load' }, { actor: AGENT });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    const otherTask = store.createTask(wsId, {
      title: 'triage the backlog',
      goal: other.goal.id,
      actor: AGENT,
    });
    expect(otherTask.ok).toBe(true);
    if (!otherTask.ok) return;

    // The stale client adds ITS band. This is the gesture that used to be a
    // full replace of `stale` plus one entry.
    const mine = store.addGoal(wsId, { title: '4. Cut page weight again' }, { actor: PERSON });
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;

    expect(goalIds(wsId)).toEqual([launch, perf, other.goal.id, mine.goal.id]);
    // The other writer's task is still in its band rather than swept to Backlog.
    expect(store.getTask(otherTask.task.id)?.goal).toBe(other.goal.id);

    // The control that makes the assertion above non-vacuous: the full replace
    // the client would otherwise have sent does NOT produce this state. With
    // work under the concurrent band the stranding guard catches it, so the
    // gesture fails outright and the person is told to re-read — recoverable,
    // but not an add.
    const stalePlusOne = [...stale.map((g) => ({ id: g.id, title: g.title }))];
    const refused = store.setGoalList(wsId, [...stalePlusOne, { title: '5. Another' }], {
      actor: PERSON,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBe('would-strand-tasks');
  });

  it('does not remove an EMPTY band a concurrent writer added — the case no guard catches', () => {
    const { wsId, launch, perf } = seed();
    const stale = (store.getWorkspace(wsId)?.goals ?? []).map((g) => ({
      id: g.id,
      title: g.title,
    }));

    const other = store.addGoal(wsId, { title: '3. Support load' }, { actor: AGENT });
    expect(other.ok).toBe(true);
    if (!other.ok) return;

    const mine = store.addGoal(wsId, { title: '4. Cut page weight again' }, { actor: PERSON });
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    expect(goalIds(wsId)).toEqual([launch, perf, other.goal.id, mine.goal.id]);

    // The control, and this is the arm with no guard behind it: an empty band
    // holds no tasks to strand, so the full replace the client would otherwise
    // have sent succeeds and the band is simply gone.
    const replaced = store.setGoalList(wsId, [...stale, { title: '5. Another' }], {
      actor: PERSON,
    });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(goalIds(wsId)).not.toContain(other.goal.id);
    expect(goalIds(wsId)).not.toContain(mine.goal.id);
  });

  it('emits goals_changed naming the new band, and asks for a bucket re-look', () => {
    const { wsId } = seed();
    const res = store.addGoal(wsId, { title: '3. Cut support load' }, { actor: PERSON });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const changed = events.filter((e) => e.type === 'workspace.goals_changed');
    expect(changed).toHaveLength(1);
    const e = changed[0] as Extract<TaskStoreEvent, { type: 'workspace.goals_changed' }>;
    expect(e.newGoals.map((g) => g.id)).toContain(res.goal.id);
    expect(e.oldGoals.map((g) => g.id)).not.toContain(res.goal.id);
    expect(e.movedToChores).toEqual([]);
  });

  it('answers workspace-not-found rather than creating anything', () => {
    const res = store.addGoal('ws-nope', { title: 'anything' }, { actor: PERSON });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('workspace-not-found');
  });
});

describe('POST /api/workspaces/:id/goals/add', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-add-http-'));
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

  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  async function seedWorkspace(): Promise<{ wsId: string; launch: string; perf: string }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship search v2.' }),
    );
    const ids = await seedGoalsOverHttp(base, workspace.id, GOAL_SPEC, PERSON);
    return { wsId: workspace.id, launch: ids.launch as string, perf: ids.perf as string };
  }

  const readGoals = async (
    wsId: string,
  ): Promise<Array<{ id: string; title: string; dueAt?: number }>> =>
    (
      await jj<{ workspace: { goals: Array<{ id: string; title: string; dueAt?: number }> } }>(
        await fetch(`${base}/api/workspaces/${wsId}`),
      )
    ).workspace.goals;

  it('forwards `title`, `dueAt` and `after` — the stored list reads them back', async () => {
    const { wsId, launch, perf } = await seedWorkspace();
    const res = await jj<{ goal: { id: string; title: string; dueAt?: number } }>(
      await post(`/api/workspaces/${wsId}/goals/add`, {
        title: '1a. Warm the list',
        dueAt: 1769000000000,
        after: launch,
        author: PERSON,
      }),
    );
    expect(res.goal.title).toBe('1a. Warm the list');

    const goals = await readGoals(wsId);
    // `after` is the param a hand-copying route drops while still answering
    // 200, so the position is asserted rather than only the membership.
    expect(goals.map((g) => g.id)).toEqual([launch, res.goal.id, perf]);
    expect(goals[1]?.dueAt).toBe(1769000000000);
  });

  it('a task filed under the new band reads it back', async () => {
    const { wsId } = await seedWorkspace();
    const { goal } = await jj<{ goal: { id: string } }>(
      await post(`/api/workspaces/${wsId}/goals/add`, { title: '9. Later work', author: PERSON }),
    );
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/api/workspaces/${wsId}/tasks`, {
        author: AGENT,
        title: 'scope it',
        goal: goal.id,
      }),
    );
    const tasks = (await jj<{ tasks: Task[] }>(await fetch(`${base}/api/workspaces/${wsId}/tasks`)))
      .tasks;
    expect(tasks.find((t) => t.id === task.id)?.goal).toBe(goal.id);
  });

  it('refuses a missing author, an empty title, and an unknown `after`', async () => {
    const { wsId, launch } = await seedWorkspace();
    const before = (await readGoals(wsId)).map((g) => g.id);

    expect((await post(`/api/workspaces/${wsId}/goals/add`, { title: 'x' })).status).toBe(400);
    expect(
      (await post(`/api/workspaces/${wsId}/goals/add`, { title: '   ', author: PERSON })).status,
    ).toBe(400);
    expect(
      (
        await post(`/api/workspaces/${wsId}/goals/add`, {
          title: 'x',
          after: 'g-nope',
          author: PERSON,
        })
      ).status,
    ).toBe(404);
    expect(
      (await post('/api/workspaces/ws-nope/goals/add', { title: 'x', author: PERSON })).status,
    ).toBe(404);

    // Positive control beside the refusals: the route CAN write, so the
    // unchanged list above is a refusal rather than a dead route.
    const ok = await jj<{ goal: { id: string } }>(
      await post(`/api/workspaces/${wsId}/goals/add`, { title: 'a real one', author: PERSON }),
    );
    expect((await readGoals(wsId)).map((g) => g.id)).toEqual([...before, ok.goal.id]);
    expect(before).toContain(launch);
  });
});
