/**
 * Renaming a goal without stranding the work filed under it.
 *
 * `set_goal_list` is a full REPLACE keyed by id, and there was no rename
 * verb — so the natural way to rename a band was to submit the list with a
 * new id and the new title. To the store that is one goal removed and a
 * different one added: the removal swept the old band's OPEN tasks to the
 * bottom of Chores, and left its DONE tasks pointing at an id no longer in
 * the list (the bare row `get_workspace` has to append, which is why #153
 * needed `reorderable`). Nothing errored, the new title appeared, and the
 * caller believed it worked. Reproduced end-to-end against a live server
 * before any of this was written.
 *
 * Two changes, tested at both layers:
 *
 *   1. `renameGoal` — retitle by id at either scope. No reachable input
 *      regroups anything, which is the whole point: the common case never
 *      goes near the replace.
 *   2. `setGoalList` REFUSES a replace that drops an id still holding tasks
 *      unless the caller names that id in `drop`. A stale caller cannot name
 *      a goal it never read, which is exactly the case the guard is for.
 *      Removing an EMPTY goal needs no ceremony — the guard can only refuse
 *      a call that was about to lose track of real work.
 *
 * The route layer gets its own describe block because it is the layer
 * nothing type-checks: `drop` is precisely the shape of param a hand-copying
 * handler accepts and discards while still answering 200 (the `groups`
 * lesson). Every absence assertion sits next to a positive control.
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
  type Task,
  TaskStore,
  type TaskStoreEvent,
  type WorkspaceGoal,
} from '../src/tasks.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };

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
];

describe('TaskStore.renameGoal', () => {
  let dataDir: string;
  let store: TaskStore;
  let events: TaskStoreEvent[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-rename-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    events = [];
    store.onEvent((e) => events.push(e));
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A board with work under the band being renamed, at both statuses and
   *  both depths. Without tasks on it "nothing moved" is vacuously true. */
  function seed(): { wsId: string; open: string; done: string; sub: string } {
    const ws = store.createWorkspace('search-revamp', 'Ship search v2.');
    store.setGoalList(ws.id, GOALS, { actor: PERSON });
    const mk = (title: string, goal: string): string => {
      const res = store.createTask(ws.id, { title, goal, actor: AGENT });
      if (!res.ok) throw new Error(`fixture create failed: ${res.error}`);
      return res.task.id;
    };
    const open = mk('draft the announcement', 'g-launch');
    const done = mk('book the slot', 'g-launch');
    const sub = mk('proof the headline', 'g-launch-qa');
    store.transition(done, 'in-progress', { actor: AGENT });
    store.transition(done, 'done', { actor: AGENT });
    events.length = 0;
    return { wsId: ws.id, open, done, sub };
  }

  const goalOf = (id: string): string | undefined => store.getTask(id)?.goal;

  it('retitles a top-level goal and moves nothing', () => {
    const { wsId, open, done, sub } = seed();
    // Positive control: the probe can see tasks under this band right now.
    expect([goalOf(open), goalOf(done), goalOf(sub)]).toEqual([
      'g-launch',
      'g-launch',
      'g-launch-qa',
    ]);

    const res = store.renameGoal(
      wsId,
      'g-launch',
      { title: '1. Ship the relaunch post' },
      {
        actor: PERSON,
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(true);
    expect(res.goal.title).toBe('1. Ship the relaunch post');

    const goals = store.getWorkspace(wsId)?.goals ?? [];
    expect(goals.map((g) => g.id)).toEqual(['g-launch', 'g-perf']);
    expect(goals[0]?.title).toBe('1. Ship the relaunch post');
    // The id is untouched, so every task keeps its band — including the done
    // one, which is the half the replace path leaves orphaned.
    expect([goalOf(open), goalOf(done), goalOf(sub)]).toEqual([
      'g-launch',
      'g-launch',
      'g-launch-qa',
    ]);
    // And no orphan row appears in the read.
    const rows = summarizeGoals(store.listTasks(wsId), goals);
    expect(rows.filter((r) => !r.reorderable && r.id !== CHORES_GOAL_ID)).toEqual([]);
  });

  it('retitles a SUBGOAL, leaving the parent and its sibling untouched', () => {
    const { wsId, sub } = seed();
    const res = store.renameGoal(
      wsId,
      'g-launch-qa',
      { title: '1.1 Editorial pass' },
      {
        actor: PERSON,
      },
    );
    expect(res.ok).toBe(true);

    const goals = store.getWorkspace(wsId)?.goals ?? [];
    expect(goals[0]?.title).toBe('1. Ship the launch post');
    expect(goals[0]?.subgoals?.map((s) => [s.id, s.title])).toEqual([
      ['g-launch-qa', '1.1 Editorial pass'],
      ['g-launch-copy', '1.2 Copy edit'],
    ]);
    // dueAt on the untouched sibling rides along.
    expect(goals[0]?.subgoals?.[1]?.dueAt).toBe(1767000000000);
    expect(goalOf(sub)).toBe('g-launch-qa');
  });

  it('sets and clears dueAt without touching the title of anything else', () => {
    const { wsId } = seed();
    store.renameGoal(
      wsId,
      'g-perf',
      { title: '2. Cut page weight', dueAt: 1768000000000 },
      {
        actor: PERSON,
      },
    );
    expect(store.getWorkspace(wsId)?.goals[1]?.dueAt).toBe(1768000000000);
    store.renameGoal(
      wsId,
      'g-perf',
      { title: '2. Cut page weight', dueAt: null },
      {
        actor: PERSON,
      },
    );
    expect(store.getWorkspace(wsId)?.goals[1]?.dueAt).toBeUndefined();
    // The band that was never named keeps its own dueAt.
    expect(store.getWorkspace(wsId)?.goals[0]?.dueAt).toBe(1766000000000);
  });

  it('emits goals_changed with the OLD title on oldGoals and nothing moved', () => {
    const { wsId } = seed();
    store.renameGoal(wsId, 'g-launch', { title: '1. Ship the relaunch post' }, { actor: PERSON });
    const changed = events.filter((e) => e.type === 'workspace.goals_changed');
    expect(changed).toHaveLength(1);
    const ev = changed[0] as Extract<TaskStoreEvent, { type: 'workspace.goals_changed' }>;
    expect(ev.kind).toBe('edit');
    expect(ev.movedToChores).toEqual([]);
    // `oldGoals` aliasing the array we replaced would make both sides read
    // the NEW title and the audit row would say nothing.
    expect(ev.oldGoals[0]?.title).toBe('1. Ship the launch post');
    expect(ev.newGoals[0]?.title).toBe('1. Ship the relaunch post');
    // No task.regrouped rides along — a rename is not a placement change.
    expect(events.filter((e) => e.type === 'task.regrouped')).toEqual([]);
  });

  it('refuses an unknown id, and `chores` as RESERVED rather than unknown', () => {
    const { wsId } = seed();
    const unknown = store.renameGoal(wsId, 'g-nope', { title: 'x' }, { actor: PERSON });
    expect(unknown).toEqual({ ok: false, error: 'goal-not-found' });
    const chores = store.renameGoal(wsId, CHORES_GOAL_ID, { title: 'Errands' }, { actor: PERSON });
    expect(chores).toEqual({ ok: false, error: 'reserved-goal-id' });
    // Nothing was written on either refusal.
    expect(store.getWorkspace(wsId)?.goals).toEqual(GOALS);
    expect(events.filter((e) => e.type === 'workspace.goals_changed')).toEqual([]);
  });

  it('is a no-op when the title already matches — no event', () => {
    const { wsId } = seed();
    const res = store.renameGoal(
      wsId,
      'g-perf',
      { title: '2. Cut page weight' },
      {
        actor: PERSON,
      },
    );
    expect(res.ok && res.changed).toBe(false);
    expect(events.filter((e) => e.type === 'workspace.goals_changed')).toEqual([]);
  });
});

describe('TaskStore.setGoalList — the stranding guard', () => {
  let dataDir: string;
  let store: TaskStore;
  let events: TaskStoreEvent[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-strand-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    events = [];
    store.onEvent((e) => events.push(e));
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function seed(): { wsId: string; open: string; done: string; sub: string } {
    const ws = store.createWorkspace('search-revamp', 'Ship search v2.');
    store.setGoalList(ws.id, GOALS, { actor: PERSON });
    const mk = (title: string, goal: string): string => {
      const res = store.createTask(ws.id, { title, goal, actor: AGENT });
      if (!res.ok) throw new Error(`fixture create failed: ${res.error}`);
      return res.task.id;
    };
    const open = mk('draft the announcement', 'g-launch');
    const done = mk('book the slot', 'g-launch');
    const sub = mk('proof the headline', 'g-launch-qa');
    store.transition(done, 'in-progress', { actor: AGENT });
    store.transition(done, 'done', { actor: AGENT });
    events.length = 0;
    return { wsId: ws.id, open, done, sub };
  }

  /** The exact gesture reproduced against the live server: same band, new id,
   *  new title. Before the guard this succeeded and emptied the band. */
  it('refuses a rename-by-new-id, naming the old id and what it holds', () => {
    const { wsId, open, done } = seed();
    const res = store.setGoalList(
      wsId,
      [
        {
          id: 'g-launch-v2',
          title: '1. Ship the relaunch post',
          subgoals: [
            { id: 'g-launch-qa', title: '1.1 QA pass' },
            { id: 'g-launch-copy', title: '1.2 Copy edit', dueAt: 1767000000000 },
          ],
        },
        { id: 'g-perf', title: '2. Cut page weight' },
      ],
      { actor: PERSON },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('would-strand-tasks');
    if (res.error !== 'would-strand-tasks') return;
    expect(res.stranding).toEqual([
      { id: 'g-launch', title: '1. Ship the launch post', openTasks: 1, doneTasks: 1 },
    ]);
    // Nothing happened: not the goals, not the tasks, not one event.
    expect(store.getWorkspace(wsId)?.goals).toEqual(GOALS);
    expect(store.getTask(open)?.goal).toBe('g-launch');
    expect(store.getTask(done)?.goal).toBe('g-launch');
    expect(events).toEqual([]);
  });

  it('refuses when the dropped band holds ONLY done tasks — the silent half', () => {
    const { wsId, open, done } = seed();
    // Move the open one out, so `g-launch` holds nothing but history. The old
    // behaviour reported this case in NO field at all: movedToChores was empty
    // and the caller saw a clean success.
    store.setTaskGoal(open, 'g-perf', { actor: AGENT });
    events.length = 0;

    const res = store.setGoalList(wsId, [GOALS[1] as WorkspaceGoal], { actor: PERSON });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('would-strand-tasks');
    if (res.error !== 'would-strand-tasks') return;
    expect(res.stranding.map((row) => [row.id, row.openTasks, row.doneTasks])).toEqual([
      ['g-launch', 0, 1],
      // The subgoal disappears with its parent and it holds an open task.
      ['g-launch-qa', 1, 0],
    ]);
    expect(store.getTask(done)?.goal).toBe('g-launch');
    expect(events).toEqual([]);
  });

  it('allows dropping a band that holds NOTHING — the guard is one-directional', () => {
    const { wsId } = seed();
    // g-perf and g-launch-copy are empty; g-launch and g-launch-qa are not.
    const res = store.setGoalList(
      wsId,
      [
        {
          id: 'g-launch',
          title: '1. Ship the launch post',
          dueAt: 1766000000000,
          subgoals: [{ id: 'g-launch-qa', title: '1.1 QA pass' }],
        },
      ],
      { actor: PERSON },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(true);
    expect(res.movedToChores).toEqual([]);
    expect(res.strandedDone).toEqual([]);
    expect(store.getWorkspace(wsId)?.goals.map((g) => g.id)).toEqual(['g-launch']);
  });

  it('proceeds when the caller NAMES the id in `drop`, and reports both halves', () => {
    const { wsId, open, done, sub } = seed();
    const res = store.setGoalList(wsId, [GOALS[1] as WorkspaceGoal], {
      actor: PERSON,
      drop: ['g-launch', 'g-launch-qa', 'g-launch-copy'],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Open work lands in Chores, as before…
    expect(res.movedToChores.sort()).toEqual([open, sub].sort());
    // …and the done task, which stays put, is now REPORTED rather than
    // silently left pointing at a vanished id.
    expect(res.strandedDone).toEqual([done]);
    expect(store.getTask(done)?.goal).toBe('g-launch');
    expect(store.getTask(open)?.goal).toBe(CHORES_GOAL_ID);
  });

  it('ignores a `drop` entry for an id that is not being removed', () => {
    const { wsId } = seed();
    const res = store.setGoalList(wsId, GOALS.concat({ id: 'g-new', title: '3. Docs' }), {
      actor: PERSON,
      drop: ['g-launch'],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.movedToChores).toEqual([]);
    expect(res.strandedDone).toEqual([]);
    expect(store.getWorkspace(wsId)?.goals.map((g) => g.id)).toEqual([
      'g-launch',
      'g-perf',
      'g-new',
    ]);
  });

  it('still short-circuits an unchanged list without asking for `drop`', () => {
    const { wsId } = seed();
    const res = store.setGoalList(wsId, GOALS, { actor: PERSON });
    expect(res.ok && res.changed).toBe(false);
    expect(events).toEqual([]);
  });
});

describe('the goal routes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-rename-http-'));
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

  /** A board carrying an open AND a done task under `g-launch`. */
  async function seedWorkspace(): Promise<{ wsId: string; open: string; done: string }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship search v2.' }),
    );
    await jj(await put(`/api/workspaces/${workspace.id}/goals`, { goals: GOALS, author: PERSON }));
    const mk = async (title: string) =>
      (
        await jj<{ task: { id: string } }>(
          await post(`/api/workspaces/${workspace.id}/tasks`, {
            author: AGENT,
            title,
            goal: 'g-launch',
          }),
        )
      ).task.id;
    const open = await mk('draft the announcement');
    const done = await mk('book the slot');
    for (const to of ['in-progress', 'done']) {
      await jj(
        await post(`/api/tasks/${done}/transition`, {
          author: AGENT,
          to,
          evidence: { commit: 'abc1234' },
        }),
      );
    }
    return { wsId: workspace.id, open, done };
  }

  const readGoals = async (wsId: string): Promise<WorkspaceGoal[]> =>
    (
      await jj<{ workspace: { goals: WorkspaceGoal[] } }>(
        await fetch(`${base}/api/workspaces/${wsId}`),
      )
    ).workspace.goals;

  const readTasks = async (wsId: string): Promise<Task[]> =>
    (await jj<{ tasks: Task[] }>(await fetch(`${base}/api/workspaces/${wsId}/tasks`))).tasks;

  it('forwards `goal`, `title` and `dueAt` — the stored list reads them back', async () => {
    const { wsId, open, done } = await seedWorkspace();
    const res = await jj<{ changed: boolean; goal: { id: string; title: string } }>(
      await post(`/api/workspaces/${wsId}/goals/rename`, {
        goal: 'g-launch',
        title: '1. Ship the relaunch post',
        dueAt: 1769000000000,
        author: PERSON,
      }),
    );
    expect(res.changed).toBe(true);
    expect(res.goal.title).toBe('1. Ship the relaunch post');

    const goals = await readGoals(wsId);
    expect(goals[0]?.title).toBe('1. Ship the relaunch post');
    expect(goals[0]?.dueAt).toBe(1769000000000);
    // The subgoals rode along untouched, and no task moved.
    expect(goals[0]?.subgoals?.map((s) => s.id)).toEqual(['g-launch-qa', 'g-launch-copy']);
    const byId = new Map((await readTasks(wsId)).map((t) => [t.id, t.goal]));
    expect([byId.get(open), byId.get(done)]).toEqual(['g-launch', 'g-launch']);
  });

  it('renames a SUBGOAL through the same route', async () => {
    const { wsId } = await seedWorkspace();
    await jj(
      await post(`/api/workspaces/${wsId}/goals/rename`, {
        goal: 'g-launch-copy',
        title: '1.2 Line edit',
        author: PERSON,
      }),
    );
    const goals = await readGoals(wsId);
    expect(goals[0]?.subgoals?.map((s) => s.title)).toEqual(['1.1 QA pass', '1.2 Line edit']);
  });

  it('404s an unknown goal and 400s `chores`, without writing anything', async () => {
    const { wsId } = await seedWorkspace();
    expect(
      (
        await post(`/api/workspaces/${wsId}/goals/rename`, {
          goal: 'g-nope',
          title: 'x',
          author: PERSON,
        })
      ).status,
    ).toBe(404);
    const reserved = await post(`/api/workspaces/${wsId}/goals/rename`, {
      goal: CHORES_GOAL_ID,
      title: 'Errands',
      author: PERSON,
    });
    expect(reserved.status).toBe(400);
    expect(((await reserved.json()) as { error: string }).error).toBe('reserved-goal-id');
    expect((await readGoals(wsId)).map((g) => g.title)).toEqual([
      '1. Ship the launch post',
      '2. Cut page weight',
    ]);
  });

  /** The param the route layer is most likely to accept and discard. Both
   *  directions in one test: without `drop` the same body is refused, with it
   *  the same body succeeds — so a handler that dropped the field would fail
   *  the second half rather than pass both. */
  it('refuses a stranding replace, and accepts the same body once `drop` names the id', async () => {
    const { wsId, open, done } = await seedWorkspace();
    const goals = [{ id: 'g-launch-v2', title: '1. Ship the relaunch post' }];

    const refused = await put(`/api/workspaces/${wsId}/goals`, { goals, author: PERSON });
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as {
      error: string;
      stranding: Array<{ id: string; openTasks: number; doneTasks: number }>;
      message: string;
    };
    expect(body.error).toBe('would-strand-tasks');
    // Only the ids that actually hold work — the empty subgoals vanishing
    // with their parent need no acknowledgement, because losing track of
    // nothing is not a loss.
    expect(body.stranding.map((s) => [s.id, s.openTasks, s.doneTasks])).toEqual([
      ['g-launch', 1, 1],
    ]);
    // The refusal has to name the way out, or it is just a wall.
    expect(body.message).toContain('rename_goal');
    expect(body.message).toContain('drop');
    // Presence control: the board is untouched by the refusal.
    expect((await readGoals(wsId)).map((g) => g.id)).toEqual(['g-launch', 'g-perf']);

    const okRes = await jj<{ movedToChores: string[]; strandedDone: string[] }>(
      await put(`/api/workspaces/${wsId}/goals`, {
        goals,
        drop: ['g-launch'],
        author: PERSON,
      }),
    );
    expect(okRes.movedToChores).toEqual([open]);
    expect(okRes.strandedDone).toEqual([done]);
    expect((await readGoals(wsId)).map((g) => g.id)).toEqual(['g-launch-v2']);
  });

  it('rejects a malformed `drop` rather than treating it as absent', async () => {
    const { wsId } = await seedWorkspace();
    const res = await put(`/api/workspaces/${wsId}/goals`, {
      goals: GOALS,
      drop: 'g-launch',
      author: PERSON,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('drop');
  });

  /** The read has to keep working for the caller who DID mean the removal:
   *  the orphan row is still there, still not reorderable. */
  it('an acknowledged drop still leaves a non-reorderable orphan row in the read', async () => {
    const { wsId } = await seedWorkspace();
    await jj(
      await put(`/api/workspaces/${wsId}/goals`, {
        goals: [{ id: 'g-perf', title: '2. Cut page weight' }],
        drop: ['g-launch'],
        author: PERSON,
      }),
    );
    const { goalSummary } = await jj<{ goalSummary: GoalSummaryRow[] }>(
      await fetch(`${base}/api/workspaces/${wsId}`),
    );
    const orphan = goalSummary.find((r) => r.id === 'g-launch');
    expect(orphan).toMatchObject({ reorderable: false, done: 1 });
  });
});
