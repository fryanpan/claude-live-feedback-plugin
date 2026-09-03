/**
 * Blocked, in the store: what an open `after` edge does to the dispatch reads,
 * and the one thing that has to be WRITTEN when a row comes free.
 *
 * Blocked is derived (`@feedback/core/task-blocked`), so there is no state to
 * assert having been set — the tests here drive the transitions and read what
 * the surfaces downstream of them say.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyOpenTasks } from '../src/keep-moving.ts';
import { evaluateReadyWork } from '../src/ready-gate.ts';
import { buildQueue } from '../src/task-queue.ts';
import { TaskStore, type TaskStoreEvent } from '../src/tasks.ts';

const AGENT = { id: 'agent-workspaces', name: 'Workspaces', kind: 'known' };

describe('a blocked row leaves the dispatch reads', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'blocked-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A workspace with one AGREED band and two rows: the blocker, and the row
   *  waiting on it. The band is moved out of triage because a band nobody has
   *  agreed to holds every row under it out of the dispatch reads on its own,
   *  which would make each test below pass for the wrong reason. */
  const board = () => {
    const ws = store.createWorkspace('ws');
    const goals = store.setGoalList(ws.id, [{ title: 'Board reads clearly' }], { actor: AGENT });
    if (!goals.ok) throw new Error('fixture: the goal list was refused');
    const goalId = goals.created[0]?.id ?? '';
    store.transition(goalId, 'todo', { actor: AGENT });
    const dep = store.createTask(ws.id, {
      title: 'Split the huddle renderer',
      assignee: AGENT.name,
      goal: goalId,
    });
    if (!dep.ok) throw new Error('fixture: the blocker was refused');
    const held = store.createTask(ws.id, {
      title: 'Bryan can rename a huddle from the board',
      assignee: AGENT.name,
      goal: goalId,
      after: [dep.task.id],
    });
    if (!held.ok) throw new Error('fixture: the waiting row was refused');
    return { ws, goalId, dep: dep.task, held: held.task };
  };

  const goalsOf = (ws: string) => store.getWorkspace(ws)?.goals ?? [];
  const queueIds = (ws: string) => buildQueue(store.listTasks(ws), goalsOf(ws)).map((r) => r.id);

  it('drops a row waiting on an ADVISORY edge from the queue', () => {
    const { ws, dep, held } = board();
    // Positive control: both rows are there when blocked rows are asked for.
    const all = buildQueue(store.listTasks(ws.id), goalsOf(ws.id), {
      includeBlocked: true,
    });
    expect(all.map((r) => r.id).sort()).toEqual([dep.id, held.id].sort());
    expect(all.find((r) => r.id === held.id)?.blocked).toBe(true);
    // …and the edge is advisory, which used to leave the row dispatchable.
    expect(all.find((r) => r.id === held.id)?.ready).toBe(true);
    expect(queueIds(ws.id)).toEqual([dep.id]);
  });

  it('puts the row back in the queue the moment the blocker closes', () => {
    const { ws, dep, held } = board();
    expect(queueIds(ws.id)).not.toContain(held.id);
    store.transition(dep.id, 'done', { actor: AGENT });
    expect(queueIds(ws.id)).toContain(held.id);
    // Nothing was written to the row itself: it was `todo` throughout.
    expect(store.getTask(held.id)?.status).toBe('todo');
  });

  it('an archived blocker cannot wedge the row it was holding', () => {
    const { ws, dep, held } = board();
    expect(queueIds(ws.id)).not.toContain(held.id);
    store.archiveTask(dep.id, { actor: AGENT, reason: 'duplicate' });
    expect(queueIds(ws.id)).toContain(held.id);
  });

  it('the ready gate holds a blocked row rather than waking an agent for it', () => {
    const { ws, dep, held } = board();
    const rows = buildQueue(store.listTasks(ws.id), goalsOf(ws.id), {
      includeBlocked: true,
      goalRows: store.listGoalRows(ws.id),
    });
    const probes = {
      ownerKind: () => 'agent' as const,
      reviewState: () => ({ open: 0, unreadable: 0 }),
    };
    const before = evaluateReadyWork(rows, probes);
    expect(before.ready.map((r) => r.id)).toEqual([dep.id]);
    expect(before.held.blocked).toBe(1);
    // Positive control: closing the blocker is what puts it on the wake list.
    store.transition(dep.id, 'done', { actor: AGENT });
    const after = evaluateReadyWork(
      buildQueue(store.listTasks(ws.id), goalsOf(ws.id), {
        includeBlocked: true,
        goalRows: store.listGoalRows(ws.id),
      }),
      probes,
    );
    expect(after.ready.map((r) => r.id)).toEqual([held.id]);
    expect(after.held.blocked).toBeUndefined();
  });

  it('the stall check never calls a blocked row stalled, however old it is', () => {
    const { ws, goalId, dep, held } = board();
    const now = Date.now() + 30 * 24 * 60 * 60_000; // a month of silence
    const rows = classifyOpenTasks(
      store.listTasks(ws.id).map((t) => ({ ...t, ownerKind: 'agent' })),
      [],
      [],
      now,
      45 * 60_000,
      { dispatchable: new Set([goalId]), ownerBand: new Set() },
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(held.id)?.bucket).toBe('blocked-on-dependency');
    expect(byId.get(held.id)?.stalled).toBe(false);
    // Positive control: the row with nothing in its way DOES stall, so the
    // false above is the blocker's doing and not the fixture's.
    expect(byId.get(dep.id)?.stalled).toBe(true);
  });
});

describe('coming free is recorded, because nothing else about the row changes', () => {
  let dataDir: string;
  let store: TaskStore;
  let events: TaskStoreEvent[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'unblocked-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    events = [];
    store.onEvent((ev) => events.push(ev));
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const mk = (ws: string, title: string, after?: string[]) => {
    const res = store.createTask(ws, {
      title,
      assignee: AGENT.name,
      ...(after ? { after } : {}),
    });
    if (!res.ok) throw new Error(`fixture: ${title} was refused`);
    return res.task;
  };

  const unblocked = () => events.filter((e) => e.type === 'task.unblocked');

  it('emits task.unblocked on the row that came free, naming what cleared it', () => {
    const ws = store.createWorkspace('ws');
    const dep = mk(ws.id, 'Give the huddle a stable share id');
    const held = mk(ws.id, 'Agent can post a huddle summary', [dep.id]);
    store.transition(dep.id, 'done', { actor: AGENT });
    expect(unblocked()).toHaveLength(1);
    expect(unblocked()[0]).toMatchObject({
      taskId: held.id,
      clearedBy: dep.id,
      clearedByTitle: 'Give the huddle a stable share id',
    });
  });

  it('stays silent while another blocker is still open', () => {
    const ws = store.createWorkspace('ws');
    const first = mk(ws.id, 'First');
    const second = mk(ws.id, 'Second');
    mk(ws.id, 'Waiting on both', [first.id, second.id]);
    store.transition(first.id, 'done', { actor: AGENT });
    expect(unblocked()).toHaveLength(0);
    // …and speaks once, on the closure that actually frees it.
    store.transition(second.id, 'done', { actor: AGENT });
    expect(unblocked()).toHaveLength(1);
    expect(unblocked()[0]).toMatchObject({ clearedBy: second.id });
  });

  it('says nothing when a blocker merely starts', () => {
    const ws = store.createWorkspace('ws');
    const dep = mk(ws.id, 'The thing it waits on');
    mk(ws.id, 'Waiting', [dep.id]);
    store.transition(dep.id, 'in-progress', { actor: AGENT });
    expect(unblocked()).toHaveLength(0);
  });

  it('an archive frees the row and says so too', () => {
    const ws = store.createWorkspace('ws');
    const dep = mk(ws.id, 'Turned out not to be work');
    const held = mk(ws.id, 'Waiting', [dep.id]);
    store.archiveTask(dep.id, { actor: AGENT, reason: 'duplicate' });
    expect(unblocked()).toHaveLength(1);
    expect(unblocked()[0]).toMatchObject({ taskId: held.id, clearedBy: dep.id });
  });

  it('never names an archived dependant — it is off the board', () => {
    const ws = store.createWorkspace('ws');
    const dep = mk(ws.id, 'The blocker');
    const held = mk(ws.id, 'Waiting, then archived', [dep.id]);
    store.archiveTask(held.id, { actor: AGENT });
    store.transition(dep.id, 'done', { actor: AGENT });
    expect(unblocked()).toHaveLength(0);
    // Positive control: restored, the same closure would have named it.
    expect(store.getTask(held.id)?.after).toEqual([dep.id]);
  });
});
