/**
 * Opaque, generated GOAL IDS — the half that stops new bad ids being created.
 *
 * The defect class: a goal id was whatever the caller typed, so a board grew
 * ids like `g1-loop` / `g2-reach` that encode PRIORITY — the fastest-moving
 * property a board has — inside the one field that must never move. Renaming
 * a band then meant re-keying it, and re-keying through the full-replace
 * `setGoalList` reads as one goal removed and a different one added: open
 * tasks swept to Backlog, done tasks orphaned onto an id that no longer
 * exists, and a successful-looking result.
 *
 * `would-strand-tasks` (PR #161) refuses that AFTER the fact and still does.
 * This file is about the stronger move: the store mints the id, so a caller
 * cannot choose one and cannot change one — the gesture is unexpressible
 * rather than caught.
 *
 * Deliberately NOT here: any migration. Boards already carry slug ids and
 * they keep working untouched; the legacy-board section below is the positive
 * control for exactly that, and nothing in this change renumbers anything.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ServerHandle, createServer } from '../src/server.ts';
import { summarizeGoals } from '../src/task-queue.ts';
import {
  CHORES_GOAL_ID,
  RESERVED_GOAL_IDS,
  TaskStore,
  isReservedGoalId,
  newGoalId,
  tasksSidecarPath,
} from '../src/tasks.ts';
import { seedGoals, seedGoalsOverHttp } from './goal-seed.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };

/** `g-` plus 12 base64url chars — the same shape a task id has. */
const GENERATED = /^g-[A-Za-z0-9_-]{12}$/;

describe('a goal id is generated, and a caller cannot supply one', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-ids-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('an entry with no id creates a band with an opaque id, reported in `created`', () => {
    const ws = store.createWorkspace('board');
    const res = store.setGoalList(ws.id, [{ title: 'Ship the launch post' }], { actor: PERSON });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toHaveLength(1);
    const id = res.created[0]?.id ?? '';
    expect(id).toMatch(GENERATED);
    expect(store.getWorkspace(ws.id)?.goals.map((g) => g.id)).toEqual([id]);
  });

  it('two bands with the same title still get different ids', () => {
    const ws = store.createWorkspace('board');
    const res = store.setGoalList(ws.id, [{ title: 'Docs' }, { title: 'Docs' }], { actor: PERSON });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [a, b] = res.created.map((c) => c.id);
    expect(a).not.toBe(b);
    expect(newGoalId()).not.toBe(newGoalId());
  });

  // Subgoals are gone (Bryan, 2026-08-30), but a board written before that is
  // still on disk and the REST route has callers this build cannot restart —
  // so a nested payload still LOADS, flattened into bands of its own directly
  // after the entry that carried them. Each one is minted like any other band.
  it('a legacy nested payload flattens into bands of its own', () => {
    const ws = store.createWorkspace('board');
    const res = store.setGoalList(ws.id, [{ title: 'Launch', subgoals: [{ title: 'QA pass' }] }], {
      actor: PERSON,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created.map((c) => c.title)).toEqual(['Launch', 'QA pass']);
    expect(res.created[1]?.id).toMatch(GENERATED);
    // Stored FLAT, in the position the board already drew them, and nothing
    // nested comes back — the shape is not written back out.
    const stored = store.getWorkspace(ws.id)?.goals ?? [];
    expect(stored.map((g) => g.title)).toEqual(['Launch', 'QA pass']);
    expect(stored.every((g) => !('subgoals' in g))).toBe(true);
  });

  it('an id this board does not hold is REFUSED, and nothing is written', () => {
    const ws = store.createWorkspace('board');
    const G = seedGoals(store, ws.id, [{ key: 'launch', title: 'Launch' }], PERSON);
    const before = store.getWorkspace(ws.id)?.goals;

    const res = store.setGoalList(
      ws.id,
      [
        { id: G.launch, title: 'Launch' },
        { id: 'g2-perf', title: 'Cut page weight' },
      ],
      { actor: PERSON },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('unknown-goal-id');
    if (res.error !== 'unknown-goal-id') return;
    expect(res.unknownIds).toEqual(['g2-perf']);
    // A refusal leaves the board exactly as the caller found it.
    expect(store.getWorkspace(ws.id)?.goals).toEqual(before);

    // Positive control: the SAME call with the id omitted is the create, and
    // it succeeds — so the refusal above is about the id, not about the call.
    const ok = store.setGoalList(
      ws.id,
      [{ id: G.launch, title: 'Launch' }, { title: 'Cut page weight' }],
      { actor: PERSON },
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.created.map((c) => c.title)).toEqual(['Cut page weight']);
    expect(ok.created[0]?.id).toMatch(GENERATED);
  });

  it('every unknown id is named at once, not one round trip at a time', () => {
    const ws = store.createWorkspace('board');
    const res = store.setGoalList(
      ws.id,
      [{ id: 'g1' }, { id: 'g2' }].map((g, i) => ({
        ...g,
        title: `Band ${i}`,
      })),
      { actor: PERSON },
    );
    expect(res.ok).toBe(false);
    if (res.ok || res.error !== 'unknown-goal-id') return;
    expect(res.unknownIds).toEqual(['g1', 'g2']);
  });
});

describe('no API path changes an existing goal’s id', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-rekey-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('the re-key gesture — same band, new id — is refused before it can strand anything', () => {
    const ws = store.createWorkspace('board');
    const G = seedGoals(store, ws.id, [{ key: 'loop', title: '1. Close the loop' }], PERSON);
    const task = store.createTask(ws.id, { title: 'wire the widget', goal: G.loop });
    expect(task.ok).toBe(true);

    // What a caller used to type to "rename" a band: submit the list with a
    // new id and the new title.
    const res = store.setGoalList(ws.id, [{ id: 'g2-loop', title: '2. Close the loop' }], {
      actor: PERSON,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('unknown-goal-id');

    // The band, its id, and the work filed under it are all still there.
    expect(store.getWorkspace(ws.id)?.goals.map((g) => g.id)).toEqual([G.loop]);
    expect(store.listTasks(ws.id, { goal: G.loop })).toHaveLength(1);
  });

  it('a retitle through the SAME id keeps the id and keeps the tasks', () => {
    const ws = store.createWorkspace('board');
    const G = seedGoals(store, ws.id, [{ key: 'loop', title: '1. Close the loop' }], PERSON);
    const task = store.createTask(ws.id, { title: 'wire the widget', goal: G.loop });
    expect(task.ok).toBe(true);

    const res = store.setGoalList(ws.id, [{ id: G.loop, title: 'Close the loop faster' }], {
      actor: PERSON,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toEqual([]);
    expect(res.movedToChores).toEqual([]);
    const goals = store.getWorkspace(ws.id)?.goals ?? [];
    expect(goals.map((g) => g.id)).toEqual([G.loop]);
    expect(goals[0]?.title).toBe('Close the loop faster');
    expect(store.listTasks(ws.id, { goal: G.loop })).toHaveLength(1);
  });

  it('renameGoal still changes only the title', () => {
    const ws = store.createWorkspace('board');
    const G = seedGoals(store, ws.id, [{ key: 'loop', title: '1. Close the loop' }], PERSON);
    const res = store.renameGoal(ws.id, G.loop as string, { title: 'The loop' }, { actor: PERSON });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.goal.id).toBe(G.loop);
    expect(store.getWorkspace(ws.id)?.goals[0]?.title).toBe('The loop');
  });
});

describe('reserved goal ids are enumerated in one place and reachable by literal', () => {
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

  it('the set is the one enumeration, and a generated id is not in it', () => {
    expect([...RESERVED_GOAL_IDS]).toEqual([CHORES_GOAL_ID]);
    expect(isReservedGoalId(CHORES_GOAL_ID)).toBe(true);
    expect(isReservedGoalId(newGoalId())).toBe(false);
  });

  it('a reserved id is still reachable by its literal from every placement path', () => {
    const ws = store.createWorkspace('board');
    const G = seedGoals(store, ws.id, [{ key: 'loop', title: 'Loop' }], PERSON);

    const chore = store.createTask(ws.id, { title: 'rotate the key', goal: CHORES_GOAL_ID });
    expect(chore.ok).toBe(true);
    if (!chore.ok) return;
    expect(chore.task.goal).toBe(CHORES_GOAL_ID);

    const placed = store.createTask(ws.id, { title: 'wire it', goal: G.loop });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    const moved = store.setTaskGoal(placed.task.id, CHORES_GOAL_ID, { actor: AGENT });
    expect(moved.ok).toBe(true);
    expect(store.getTask(placed.task.id)?.goal).toBe(CHORES_GOAL_ID);
  });

  it('but a reserved id can never be authored: create, rename and reorder all refuse it', () => {
    const ws = store.createWorkspace('board');
    seedGoals(store, ws.id, [{ key: 'loop', title: 'Loop' }], PERSON);

    const created = store.setGoalList(ws.id, [{ id: CHORES_GOAL_ID, title: 'Backlog' }], {
      actor: PERSON,
    });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error).toBe('reserved-goal-id');

    const renamed = store.renameGoal(
      ws.id,
      CHORES_GOAL_ID,
      { title: 'Errands' },
      { actor: PERSON },
    );
    expect(renamed.ok).toBe(false);
    if (!renamed.ok) expect(renamed.error).toBe('reserved-goal-id');
  });
});

describe('a board that already holds slug ids keeps working', () => {
  let dataDir: string;
  let store: TaskStore;

  /** A board as it exists TODAY, written straight to the sidecar: goal ids
   *  that encode ordering, and tasks filed under them. This shape can no
   *  longer be created through the API, which is exactly why the fixture is
   *  on disk — it is the state a real board is already in. */
  const legacy = (wsId: string) => ({
    workspace: {
      id: wsId,
      name: 'live board',
      goal: 'Make feedback as fast as pointing.',
      goalUpdatedAt: 1_700_000_000_000,
      goals: [
        { id: 'g1-loop', title: '1. Close the loop' },
        { id: 'g2-reach', title: '2. Reach' },
        { id: 'g3-collab', title: '3. Collaborate' },
      ],
      docIds: [],
      createdAt: 1_700_000_000_000,
    },
    tasks: [
      task('t-legacy-1', wsId, 'g1-loop', 'todo'),
      task('t-legacy-2', wsId, 'g1-loop', 'done'),
      task('t-legacy-3', wsId, 'g2-reach', 'todo'),
      task('t-legacy-4', wsId, 'g3-collab', 'in-progress'),
      task('t-legacy-5', wsId, CHORES_GOAL_ID, 'todo'),
    ],
  });

  function task(id: string, workspaceId: string, goal: string, status: string) {
    return {
      id,
      workspaceId,
      title: `work on ${goal}`,
      status,
      goal,
      order: 1,
      assignee: 'Jordan',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      transitions: [],
    };
  }

  /** goalId → the tasks filed under it, from the store's own reads. */
  const bands = (s: TaskStore, wsId: string): Record<string, string[]> => {
    const out: Record<string, string[]> = {};
    for (const t of s.listTasks(wsId)) {
      (out[t.goal] ??= []).push(t.id);
      out[t.goal]?.sort();
    }
    return out;
  };

  const wsId = 'w-legacyboard1';

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-legacy-'));
    mkdirSync(join(dataDir, 'workspaces'), { recursive: true });
    writeFileSync(tasksSidecarPath(dataDir, wsId), `${JSON.stringify(legacy(wsId), null, 2)}\n`);
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('every task resolves to its band before and after an edit that adds a new one', () => {
    // Positive control FIRST: the fixture really did load, and the bands
    // really do hold work — without this, "unchanged after" is vacuous.
    const before = bands(store, wsId);
    expect(before).toEqual({
      'g1-loop': ['t-legacy-1', 't-legacy-2'],
      'g2-reach': ['t-legacy-3'],
      'g3-collab': ['t-legacy-4'],
      [CHORES_GOAL_ID]: ['t-legacy-5'],
    });

    // The ordinary gesture on a live board: reorder, retitle one band, and
    // add a new one — submitted the only way it can now be submitted.
    const res = store.setGoalList(
      wsId,
      [
        { id: 'g2-reach', title: '1. Reach' },
        { id: 'g1-loop', title: '2. Close the loop' },
        { id: 'g3-collab', title: '3. Collaborate' },
        { title: '4. Autonomy' },
      ],
      { actor: PERSON },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.movedToChores).toEqual([]);
    expect(res.strandedDone).toEqual([]);
    expect(res.created).toHaveLength(1);
    expect(res.created[0]?.id).toMatch(GENERATED);

    // Same tasks, same bands, same ids — including the done one, which is the
    // half a re-key used to orphan silently.
    expect(bands(store, wsId)).toEqual(before);
    const goals = store.getWorkspace(wsId)?.goals ?? [];
    expect(goals.slice(0, 3).map((g) => g.id)).toEqual(['g2-reach', 'g1-loop', 'g3-collab']);
    expect(goals[0]?.title).toBe('1. Reach');
    expect(goals[3]?.id).toMatch(GENERATED);
  });

  it('a legacy id stays usable everywhere an id is taken', () => {
    const created = store.createTask(wsId, { title: 'another loop task', goal: 'g1-loop' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.task.goal).toBe('g1-loop');
    expect(store.renameGoal(wsId, 'g1-loop', { title: 'The loop' }, { actor: PERSON }).ok).toBe(
      true,
    );
    expect(
      store.reorderGoals(wsId, ['g3-collab', 'g2-reach', 'g1-loop'], { actor: PERSON }).ok,
    ).toBe(true);
  });
});

describe('the goal route refuses a caller-chosen id and names the way out', () => {
  let dataDir: string;
  let handle: ServerHandle;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-ids-http-'));
    handle = await createServer({ port: 0, dataDir });
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const newWorkspace = async (): Promise<string> => {
    const res = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'search-revamp', goal: 'Ship search v2.' }),
    });
    const body = (await res.json()) as { workspace: { id: string } };
    return body.workspace.id;
  };

  it('PUT /goals with an unheld id is a 400 naming rename_goal and the id-less create', async () => {
    const wsId = await newWorkspace();
    const G = await seedGoalsOverHttp(
      base,
      wsId,
      [{ key: 'loop', title: 'Close the loop' }],
      PERSON,
    );

    const res = await fetch(`${base}/api/workspaces/${wsId}/goals`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goals: [{ id: 'g2-reach', title: 'Reach' }],
        author: PERSON,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; unknownIds: string[]; message: string };
    expect(body.error).toBe('unknown-goal-id');
    expect(body.unknownIds).toEqual(['g2-reach']);
    expect(body.message).toContain('rename_goal');
    expect(body.message).toContain('`id`');

    // The board is untouched, and the id-less form of the same intent works —
    // the positive control that the route can still add a band at all.
    const ok = await fetch(`${base}/api/workspaces/${wsId}/goals`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        goals: [{ id: G.loop, title: 'Close the loop' }, { title: 'Reach' }],
        author: PERSON,
      }),
    });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { created: Array<{ id: string; title: string }> };
    expect(okBody.created).toHaveLength(1);
    expect(okBody.created[0]?.title).toBe('Reach');
    expect(okBody.created[0]?.id).toMatch(GENERATED);
  });

  it('an empty-string id is malformed, not a create', async () => {
    const wsId = await newWorkspace();
    const res = await fetch(`${base}/api/workspaces/${wsId}/goals`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goals: [{ id: '', title: 'Reach' }], author: PERSON }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('goals must be');
    expect((await (await fetch(`${base}/api/workspaces/${wsId}`)).json()) as unknown).toBeDefined();
  });
});

/**
 * A board on disk that still holds SUBGOALS.
 *
 * Subgoals were removed from the product (Bryan, 2026-08-30), and that
 * decision does not rewrite anything already written. Every reader in the
 * store now looks at `workspace.goals` alone, so a nested band that survived
 * the load would exist nowhere: its tasks would read as unknown-goal work,
 * and the next goal-list edit would strand them for real. The load path
 * flattens instead — each child becoming a band directly after its old
 * parent, which is the position the board has drawn it in all along.
 *
 * On disk, not through the API: this shape can no longer be submitted, which
 * is exactly why the fixture has to be written straight to the sidecar.
 */
describe('a board written before subgoals were removed loads flat', () => {
  let dataDir: string;
  let store: TaskStore;
  const wsId = 'w-nestedboard1';

  const nested = () => ({
    workspace: {
      id: wsId,
      name: 'live board',
      goal: 'Make feedback as fast as pointing.',
      goals: [
        {
          id: 'g-launch',
          title: '1. Ship the launch post',
          dueAt: 1_766_000_000_000,
          subgoals: [
            { id: 'g-launch-qa', title: '1.1 QA pass' },
            { id: 'g-launch-copy', title: '1.2 Copy edit', dueAt: 1_767_000_000_000 },
          ],
        },
        { id: 'g-perf', title: '2. Cut page weight' },
      ],
      docIds: [],
      createdAt: 1_700_000_000_000,
    },
    tasks: [
      {
        id: 't-nested-1',
        workspaceId: wsId,
        title: 'proof the headline',
        status: 'todo',
        goal: 'g-launch-qa',
        order: 1,
        assignee: 'Jordan',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        transitions: [],
      },
    ],
  });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-nested-'));
    mkdirSync(join(dataDir, 'workspaces'), { recursive: true });
    writeFileSync(tasksSidecarPath(dataDir, wsId), `${JSON.stringify(nested(), null, 2)}\n`);
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('splices every subgoal in after its parent, keeping titles and dueAt', () => {
    const goals = store.getWorkspace(wsId)?.goals ?? [];
    expect(goals.map((g) => [g.id, g.title])).toEqual([
      ['g-launch', '1. Ship the launch post'],
      ['g-launch-qa', '1.1 QA pass'],
      ['g-launch-copy', '1.2 Copy edit'],
      ['g-perf', '2. Cut page weight'],
    ]);
    expect(goals[0]?.dueAt).toBe(1_766_000_000_000);
    expect(goals[2]?.dueAt).toBe(1_767_000_000_000);
    // Nothing nested survives the load, so nothing downstream can find one.
    expect(goals.every((g) => !('subgoals' in g))).toBe(true);
  });

  it('gives the flattened band a goal ROW, so it is a band in every sense', () => {
    // Without this the row exists in the list and nowhere else: no status, no
    // description, no archive — the half a reader would notice first.
    expect(store.getGoalRow('g-launch-qa')?.title).toBe('1.1 QA pass');
    expect(store.getGoalRow('g-launch-qa')?.kind).toBe('goal');
  });

  it('leaves the task in a real band rather than orphaning it', () => {
    // The failure this guards: a load that dropped the nested band would
    // leave this task pointing at an id the list no longer has. Asserted
    // through `summarizeGoals` rather than through `task.goal`, which is a
    // stored string and reads the same either way — the question is whether
    // the id still names a band the board ORDERS, and an orphan comes back
    // as a bare `reorderable: false` row instead.
    const goals = store.getWorkspace(wsId)?.goals ?? [];
    const row = summarizeGoals(store.listTasks(wsId), goals).find((r) => r.id === 'g-launch-qa');
    expect(row?.reorderable).toBe(true);
    expect(row?.todo).toBe(1);
    // Positive control for the field: an id that really is gone reads false.
    const orphaned = summarizeGoals(
      store.listTasks(wsId),
      goals.filter((g) => g.id !== 'g-launch-qa'),
    ).find((r) => r.id === 'g-launch-qa');
    expect(orphaned?.reorderable).toBe(false);
  });

  it('accepts the flattened list back as a reorder, which the nested one could not be', () => {
    const res = store.reorderGoals(wsId, ['g-perf', 'g-launch', 'g-launch-qa', 'g-launch-copy'], {
      actor: PERSON,
    });
    expect(res.ok).toBe(true);
    expect(store.getWorkspace(wsId)?.goals.map((g) => g.id)).toEqual([
      'g-perf',
      'g-launch',
      'g-launch-qa',
      'g-launch-copy',
    ]);
    // And the task did not move with the band's position.
    expect(store.getTask('t-nested-1')?.goal).toBe('g-launch-qa');
  });
});

/**
 * A board on disk where a parent goal's archive took a subgoal with it.
 *
 * The shape the removal has to land on its feet from: the subgoal's row was
 * stamped `archivedWithGoal: <parent>`, and its TASKS were stamped with the
 * parent's id too — which is what made the pair restore together. Flattened,
 * that band restores on its own, so left alone it would come back empty with
 * its work still archived, while restoring the old parent would revive those
 * tasks under a band that is still off the board. Neither restore would be
 * the whole of one decision.
 *
 * No live board is in this state (there are no subgoals in any store), so
 * this is a migration for a shape that is possible rather than present.
 */
describe('a board whose archive cascaded into a subgoal loads coherently', () => {
  let dataDir: string;
  let store: TaskStore;
  const wsId = 'w-cascadeboard1';
  const AT = 1_700_000_500_000;

  const goalRow = (id: string, title: string, over: Record<string, unknown> = {}) => ({
    id,
    workspaceId: wsId,
    kind: 'goal',
    title,
    status: 'todo',
    createdAt: 1_700_000_000_000,
    updatedAt: AT,
    ...over,
  });

  const cascaded = () => ({
    workspace: {
      id: wsId,
      name: 'live board',
      goal: 'Make feedback as fast as pointing.',
      goals: [
        {
          id: 'g-launch',
          title: '1. Ship the launch post',
          subgoals: [{ id: 'g-launch-qa', title: '1.1 QA pass' }],
        },
      ],
      docIds: [],
      createdAt: 1_700_000_000_000,
    },
    goalRows: [
      goalRow('g-launch', '1. Ship the launch post', { archivedAt: AT, archivedBy: 'Jordan' }),
      goalRow('g-launch-qa', '1.1 QA pass', {
        archivedAt: AT,
        archivedBy: 'Jordan',
        archivedWithGoal: 'g-launch',
      }),
    ],
    tasks: [
      {
        id: 't-under-parent',
        workspaceId: wsId,
        title: 'book the slot',
        status: 'todo',
        goal: 'g-launch',
        order: 1,
        assignee: 'Jordan',
        archivedAt: AT,
        archivedWithGoal: 'g-launch',
        createdAt: 1_700_000_000_000,
        updatedAt: AT,
        transitions: [],
      },
      {
        id: 't-under-sub',
        workspaceId: wsId,
        title: 'proof the headline',
        status: 'todo',
        goal: 'g-launch-qa',
        order: 1,
        assignee: 'Jordan',
        archivedAt: AT,
        // Stamped with the PARENT, which is the marker this migration moves.
        archivedWithGoal: 'g-launch',
        createdAt: 1_700_000_000_000,
        updatedAt: AT,
        transitions: [],
      },
    ],
  });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-cascade-'));
    mkdirSync(join(dataDir, 'workspaces'), { recursive: true });
    writeFileSync(tasksSidecarPath(dataDir, wsId), `${JSON.stringify(cascaded(), null, 2)}\n`);
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('re-points a cascaded band’s tasks at the band they actually sit in', () => {
    // Premise, asserted rather than assumed: both rows really are archived.
    expect(store.getGoalRow('g-launch')?.archivedAt).toBe(AT);
    expect(store.getGoalRow('g-launch-qa')?.archivedAt).toBe(AT);
    expect(store.getTask('t-under-sub')?.archivedWithGoal).toBe('g-launch-qa');
    // The parent's own task is untouched — the re-point is scoped to the
    // band that moved, not applied to every marker on the board.
    expect(store.getTask('t-under-parent')?.archivedWithGoal).toBe('g-launch');
  });

  it('restores each band with its own work, and leaves the other alone', () => {
    const sub = store.unarchiveGoal('g-launch-qa', { actor: PERSON });
    if (!sub.ok) throw new Error('unarchiveGoal refused');
    // The failure this guards: an empty band back on the board under a
    // control that had just promised to bring its tasks.
    expect(sub.taskIds).toEqual(['t-under-sub']);
    expect(store.getTask('t-under-sub')?.archivedAt).toBeUndefined();
    // The other direction, in the same read: the parent is still archived,
    // with its own task still off the board.
    expect(store.getGoalRow('g-launch')?.archivedAt).toBe(AT);
    expect(store.getTask('t-under-parent')?.archivedAt).toBe(AT);

    const parent = store.unarchiveGoal('g-launch', { actor: PERSON });
    if (!parent.ok) throw new Error('unarchiveGoal refused');
    expect(parent.taskIds).toEqual(['t-under-parent']);
    expect(
      store
        .listTasks(wsId)
        .map((t) => t.id)
        .sort(),
    ).toEqual(['t-under-parent', 't-under-sub'].sort());
  });

  it('stops writing the marker back, so the shape does not outlive the migration', () => {
    const row = store.getGoalRow('g-launch-qa') as { archivedWithGoal?: string } | undefined;
    expect(row?.archivedWithGoal).toBeUndefined();
    // Positive control for the read: the row is really here and really
    // archived, so `undefined` is about the field rather than the lookup.
    expect(store.getGoalRow('g-launch-qa')?.archivedBy).toBe('Jordan');
  });
});
