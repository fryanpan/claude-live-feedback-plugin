/**
 * Archiving a GOAL — the band's soft delete, and the one that takes rows with
 * it.
 *
 * A task's archive is three fields on one row and nothing else moves. A
 * band's cannot be: the tasks standing under it would either strand beneath a
 * header nobody can see or be dumped into Backlog without anybody saying so.
 * Bryan settled it on 2026-08-30 — archiving a goal archives its tasks too,
 * soft and reversible on both — so the whole gesture is still only field
 * writes, and the restore is still only field clears.
 *
 * The assertion this file exists for is the ASYMMETRY between the two halves.
 * The archive takes every open row under the band; the restore puts back
 * exactly the rows THAT archive took, and specifically not a task somebody
 * had archived on its own beforehand. Getting that wrong resurrects work
 * somebody deliberately put away, and it would pass any test that only
 * counted rows.
 *
 * The confirmation's count is asserted here too, against the same walk that
 * runs: the board promises "and its 14 tasks" before it writes, and a count
 * derived separately from the act would be free to be wrong about it.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { TaskStore, type TaskStoreEvent } from '../src/tasks.ts';
import { seedGoals, seedGoalsOverHttp } from './goal-seed.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };

describe('archiving a goal', () => {
  let dataDir: string;
  let store: TaskStore;
  let events: TaskStoreEvent[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-archive-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    events = [];
    store.onEvent((e) => events.push(e));
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A band with a subgoal, two tasks of its own and one under the subgoal,
   *  plus a second band whose task must never be touched by any of this. */
  function seed() {
    const ws = store.createWorkspace('search-revamp');
    const G = seedGoals(
      store,
      ws.id,
      [
        {
          key: 'fast',
          title: 'Make review fast',
          subgoals: [{ key: 'index', title: 'Index the corpus' }],
        },
        { key: 'trust', title: 'Make the board trustworthy' },
      ],
      AGENT,
    );
    const add = (title: string, goal: string) => {
      const res = store.createTask(ws.id, { title, goal });
      if (!res.ok) throw new Error(`create failed: ${title}`);
      return res.task;
    };
    const rows = {
      wire: add('Wire the index', G.fast),
      cache: add('Cache the results', G.fast),
      crawl: add('Crawl the corpus', G.index),
      audit: add('Audit the trail', G.trust),
    };
    events.length = 0;
    return { wsId: ws.id, G, rows };
  }

  it('counts what it is about to take, before it takes it', () => {
    const { G } = seed();
    const cascade = store.goalCascade(G.fast);
    expect(cascade.subgoalIds).toEqual([G.index]);
    // Three: the band's own two, plus the one under its subgoal. The other
    // band's task is not in the blast radius and must not be counted into it.
    expect(cascade.taskIds).toHaveLength(3);
    expect(store.goalCascade(G.fast).goalIds).toEqual([G.fast]);
  });

  it('archives the band, its subgoal and every task under both', () => {
    const { G, rows } = seed();
    const res = store.archiveGoal(G.fast, { actor: PERSON, reason: 'goal moved past' });
    if (!res.ok) throw new Error('archiveGoal refused');
    expect(res.changed).toBe(true);
    expect(res.taskIds).toHaveLength(3);
    expect(res.subgoalIds).toEqual([G.index]);

    expect(store.getGoalRow(G.fast)?.archivedAt).toBeGreaterThan(0);
    expect(store.getGoalRow(G.fast)?.archivedBy).toBe('Jordan');
    expect(store.getGoalRow(G.fast)?.archiveReason).toBe('goal moved past');
    expect(store.getGoalRow(G.index)?.archivedAt).toBeGreaterThan(0);
    for (const id of [rows.wire.id, rows.cache.id, rows.crawl.id]) {
      expect(store.getTask(id)?.archivedAt).toBeGreaterThan(0);
      expect(store.getTask(id)?.archivedWithGoal).toBe(G.fast);
    }
    // The neighbouring band is untouched — in both halves, because a cascade
    // that also archived the board would pass a test that only checked the
    // rows it was meant to take.
    expect(store.getGoalRow(G.trust)?.archivedAt).toBeUndefined();
    expect(store.getTask(rows.audit.id)?.archivedAt).toBeUndefined();
  });

  it('takes the archived tasks out of the board listing, and puts them back', () => {
    const { wsId, G, rows } = seed();
    store.archiveGoal(G.fast, { actor: PERSON });
    const live = store.listTasks(wsId).map((t) => t.id);
    expect(live).toEqual([rows.audit.id]);
    // Both directions: a listing that hid an unarchived row would be a board
    // that has lost work.
    expect(store.listTasks(wsId, { includeArchived: true })).toHaveLength(4);

    store.unarchiveGoal(G.fast, { actor: PERSON });
    expect(
      store
        .listTasks(wsId)
        .map((t) => t.id)
        .sort(),
    ).toEqual([rows.wire.id, rows.cache.id, rows.crawl.id, rows.audit.id].sort());
  });

  it('restores exactly the rows its own archive took — not one archived earlier', () => {
    const { G, rows } = seed();
    // Somebody puts this one away on its own, days before the band goes.
    store.archiveTask(rows.cache.id, { actor: PERSON, reason: 'duplicate' });
    const res = store.archiveGoal(G.fast, { actor: PERSON });
    if (!res.ok) throw new Error('archiveGoal refused');
    // The cascade skipped it: it was already gone, so nothing about it changed.
    expect(res.taskIds).not.toContain(rows.cache.id);
    expect(store.getTask(rows.cache.id)?.archivedWithGoal).toBeUndefined();
    expect(store.getTask(rows.cache.id)?.archiveReason).toBe('duplicate');

    const back = store.unarchiveGoal(G.fast, { actor: PERSON });
    if (!back.ok) throw new Error('unarchiveGoal refused');
    expect(back.taskIds.sort()).toEqual([rows.wire.id, rows.crawl.id].sort());
    // The point of the whole marker: a decision somebody made about ONE row
    // survives a decision somebody made about the band.
    expect(store.getTask(rows.cache.id)?.archivedAt).toBeGreaterThan(0);
    expect(store.getGoalRow(G.fast)?.archivedAt).toBeUndefined();
    expect(store.getGoalRow(G.index)?.archivedAt).toBeUndefined();
  });

  it('a hand restore leaves the cascade, so re-restoring the band does not reclaim it', () => {
    const { G, rows } = seed();
    store.archiveGoal(G.fast, { actor: PERSON });
    store.unarchiveTask(rows.wire.id, { actor: PERSON });
    expect(store.getTask(rows.wire.id)?.archivedWithGoal).toBeUndefined();
    const back = store.unarchiveGoal(G.fast, { actor: PERSON });
    if (!back.ok) throw new Error('unarchiveGoal refused');
    expect(back.taskIds).not.toContain(rows.wire.id);
    expect(back.taskIds.sort()).toEqual([rows.cache.id, rows.crawl.id].sort());
  });

  it('emits one decision with its members batched under it', () => {
    const { G } = seed();
    store.archiveGoal(G.fast, { actor: PERSON, reason: 'goal moved past' });
    const archived = events.filter((e) => e.type === 'task.archived');
    expect(archived).toHaveLength(5); // band + subgoal + three tasks
    const band = archived.find((e) => e.taskId === G.fast);
    expect(band?.kind).toBe('goal');
    expect(band?.cascadeTasks).toBe(3);
    expect(typeof band?.batchId).toBe('string');
    for (const e of archived) {
      if (e.taskId === G.fast) continue;
      expect(e.partOf).toBe(band?.batchId);
    }
    // The subgoal's member event still says what kind of row it is.
    expect(archived.find((e) => e.taskId === G.index)?.kind).toBe('goal');
  });

  it('is idempotent: re-archiving writes nothing and emits nothing', () => {
    const { G } = seed();
    store.archiveGoal(G.fast, { actor: PERSON });
    const stamped = store.getGoalRow(G.fast)?.archivedAt;
    events.length = 0;
    const again = store.archiveGoal(G.fast, { actor: AGENT });
    if (!again.ok) throw new Error('archiveGoal refused');
    expect(again.changed).toBe(false);
    expect(again.taskIds).toEqual([]);
    expect(events).toHaveLength(0);
    expect(store.getGoalRow(G.fast)?.archivedAt).toBe(stamped as number);
    expect(store.getGoalRow(G.fast)?.archivedBy).toBe('Jordan');
  });

  it('refuses an id it does not hold', () => {
    seed();
    expect(store.archiveGoal('g-nope', { actor: PERSON })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(store.unarchiveGoal('g-nope', { actor: PERSON })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(store.goalCascade('g-nope')).toEqual({ goalIds: [], subgoalIds: [], taskIds: [] });
  });

  it('survives a reload — the archive is on disk, not in the process', () => {
    const { wsId, G, rows } = seed();
    store.archiveGoal(G.fast, { actor: PERSON, reason: 'goal moved past' });
    store.stop();

    const reopened = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      expect(reopened.getGoalRow(G.fast)?.archivedAt).toBeGreaterThan(0);
      expect(reopened.getGoalRow(G.fast)?.archiveReason).toBe('goal moved past');
      expect(reopened.getTask(rows.wire.id)?.archivedWithGoal).toBe(G.fast);
      expect(reopened.listTasks(wsId).map((t) => t.id)).toEqual([rows.audit.id]);
      const back = reopened.unarchiveGoal(G.fast, { actor: PERSON });
      if (!back.ok) throw new Error('unarchiveGoal refused after reload');
      expect(back.taskIds).toHaveLength(3);
    } finally {
      reopened.stop();
    }
  });
});

describe('goal archive + restore routes', () => {
  let handle: ServerHandle;
  let routesDir: string;
  let base: string;
  let wsId: string;
  let G: Record<string, string>;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const post = (path: string, body: unknown) =>
    local(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // PERSON, so the rows land in `todo` and are real board work: filing as an
  // agent would leave them in triage, and every "gone from the board" claim
  // below would then pass whether the archive did anything or not.
  const makeTask = async (title: string, goal: string): Promise<{ id: string }> => {
    const r = await post(`/api/workspaces/${wsId}/tasks`, { author: PERSON, title, goal });
    return ((await r.json()) as { task: { id: string } }).task;
  };

  const listIds = async (query = ''): Promise<string[]> => {
    const r = await local(`/api/workspaces/${wsId}/tasks${query}`);
    const { tasks } = (await r.json()) as { tasks: Array<{ id: string }> };
    return tasks.map((t) => t.id);
  };

  beforeAll(async () => {
    routesDir = mkdtempSync(join(tmpdir(), 'goal-archive-routes-'));
    handle = createServer({ port: 0, dataDir: routesDir });
    base = `http://localhost:${handle.port}`;
    const r = await post('/api/workspaces', { name: 'search-revamp' });
    wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
    G = await seedGoalsOverHttp(
      base,
      wsId,
      [
        {
          key: 'fast',
          title: 'Make review fast',
          subgoals: [{ key: 'index', title: 'Index the corpus' }],
        },
        { key: 'trust', title: 'Make the board trustworthy' },
      ],
      PERSON,
    );
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(routesDir, { recursive: true, force: true });
  });

  it('400s without an author, and 404s an unknown band', async () => {
    expect((await post(`/api/goals/${G.trust}/archive`, {})).status).toBe(400);
    expect((await post(`/api/goals/${G.trust}/restore`, {})).status).toBe(400);
    expect((await post('/api/goals/g-nope/archive', { author: PERSON })).status).toBe(404);
    expect((await local('/api/goals/g-nope/cascade')).status).toBe(404);
    // Positive control: with an author the same call lands, so the 400s above
    // are about the author rather than about the route not existing.
    expect((await post(`/api/goals/${G.trust}/archive`, { author: PERSON })).status).toBe(200);
    await post(`/api/goals/${G.trust}/restore`, { author: PERSON });
  });

  it('projects the band’s archive, so the board can take it off the lanes', async () => {
    await post(`/api/goals/${G.trust}/archive`, { author: PERSON, reason: 'shipped' });
    // The board renders bands off the `ws:` room's projected `goals` and
    // nothing else, so an archive only the store can see is the
    // store-has-it/surface-can't-show-it bug for the field that hides it.
    const room = handle.rooms.get(`ws:${wsId}`);
    const goals = room?.ydoc.getMap('workspace').get('goals') as
      | Array<{ id: string; archivedAt?: number; archivedBy?: string; archiveReason?: string }>
      | undefined;
    const band = (goals ?? []).find((g) => g.id === G.trust);
    expect(band?.archivedAt).toBeGreaterThan(0);
    expect(band?.archivedBy).toBe('Jordan');
    expect(band?.archiveReason).toBe('shipped');
    // And the other direction, in the same read: a projection that stamped
    // every band would pass the half above on its own.
    expect((goals ?? []).find((g) => g.id === G.fast)?.archivedAt).toBeUndefined();

    await post(`/api/goals/${G.trust}/restore`, { author: PERSON });
    const after = handle.rooms.get(`ws:${wsId}`)?.ydoc.getMap('workspace').get('goals') as
      | Array<{ id: string; archivedAt?: number }>
      | undefined;
    expect((after ?? []).find((g) => g.id === G.trust)?.archivedAt).toBeUndefined();
  });

  it('reports the cascade before the write, and the same rows after it', async () => {
    const wire = await makeTask('Wire the index', G.fast);
    const crawl = await makeTask('Crawl the corpus', G.index);
    const audit = await makeTask('Audit the trail', G.trust);

    const pre = (await (await local(`/api/goals/${G.fast}/cascade`)).json()) as {
      taskIds: string[];
      subgoalIds: string[];
    };
    expect(pre.taskIds.sort()).toEqual([wire.id, crawl.id].sort());
    expect(pre.subgoalIds).toEqual([G.index]);

    const res = await post(`/api/goals/${G.fast}/archive`, {
      author: PERSON,
      reason: 'goal moved past',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      changed: boolean;
      taskIds: string[];
      goal: { archiveReason?: string };
    };
    expect(body.changed).toBe(true);
    expect(body.taskIds.sort()).toEqual([wire.id, crawl.id].sort());
    expect(body.goal.archiveReason).toBe('goal moved past');

    // The board's own listing, both directions.
    expect(await listIds()).toEqual([audit.id]);
    expect((await listIds('?includeArchived=true')).length).toBe(3);

    const back = await post(`/api/goals/${G.fast}/restore`, { author: PERSON });
    expect(back.status).toBe(200);
    expect((await listIds()).sort()).toEqual([wire.id, crawl.id, audit.id].sort());
  });
});
