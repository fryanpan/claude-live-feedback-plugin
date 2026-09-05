/**
 * Where a row spun off a doc LANDS — `TaskStore.placeSpinoff` and the
 * create route's `spinoff: true`.
 *
 * Bryan's report from a discussion doc on prod (2026-09-01): "Tasks were
 * created in Backlog and not automatically started — does the lead agent
 * have a chance to automatically assign tickets into the proper goal?"
 * The pointer pill's Create Task filed rows into chores, owned by whoever
 * tapped, and the lead's dispatch never read them.
 *
 * The rule, in order: the goal of the task the doc BELONGS TO (a huddle
 * started for a task links the doc onto it), the board's top ACTIVE goal,
 * else chores. Owner: the lead when the seat is held, else the
 * author keeps it — never "unowned at triage", which is the unplaced row
 * this exists to prevent. Status: todo. Fixtures synthetic; port 0.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { CHORES_GOAL_ID, TaskStore } from '../src/tasks.ts';
import { seedGoals, seedGoalsOverHttp } from './goal-seed.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };

describe('TaskStore.placeSpinoff', () => {
  let dataDir: string;
  let store: TaskStore;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'spinoff-place-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });
  afterAll(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('picks the first band being worked, in priority order, and names the lead', () => {
    const ws = store.createWorkspace('Placed', { leadAgentId: 'agent-helper' });
    const G = seedGoals(
      store,
      ws.id,
      [
        { key: 'first', title: 'Ship the pill' },
        { key: 'second', title: 'Ship the strip' },
      ],
      PERSON,
    );
    expect(store.placeSpinoff(ws.id)).toEqual({
      goal: G.first,
      rule: 'top-active-goal',
      leadAgentId: 'agent-helper',
    });
  });

  it('skips a proposed band and a finished one — active means being worked', () => {
    const ws = store.createWorkspace('Skips');
    const G = seedGoals(
      store,
      ws.id,
      [
        { key: 'proposed', title: 'Only proposed' },
        { key: 'shipped', title: 'Already shipped' },
        { key: 'live', title: 'Being worked' },
      ],
      PERSON,
      { leaveInTriage: true },
    );
    store.transition(G.shipped, 'todo', { actor: PERSON });
    store.transition(G.shipped, 'done', { actor: PERSON });
    store.transition(G.live, 'todo', { actor: PERSON });
    const placed = store.placeSpinoff(ws.id);
    expect(placed?.goal).toBe(G.live);
    expect(placed?.rule).toBe('top-active-goal');
    // No lead seated: nothing to address the row to.
    expect(placed?.leadAgentId).toBeUndefined();
  });

  it('falls back to chores — placed, not triaged — when no band is active', () => {
    const ws = store.createWorkspace('Empty');
    expect(store.placeSpinoff(ws.id)).toEqual({ goal: CHORES_GOAL_ID, rule: 'chores' });
    const proposed = store.createWorkspace('Proposed only');
    seedGoals(store, proposed.id, [{ key: 'p', title: 'Someday' }], PERSON, {
      leaveInTriage: true,
    });
    expect(store.placeSpinoff(proposed.id)?.rule).toBe('chores');
  });

  it('answers nothing for a board that does not exist', () => {
    expect(store.placeSpinoff('w-nope')).toBeUndefined();
  });

  it('the goal of the task the doc belongs to comes before the top band', () => {
    const ws = store.createWorkspace('Owned', { leadAgentId: 'agent-helper' });
    const G = seedGoals(
      store,
      ws.id,
      [
        { key: 'top', title: 'Ship the pill' },
        { key: 'lower', title: 'Ship the strip' },
      ],
      PERSON,
    );
    const owner = store.createTask(ws.id, {
      title: 'Plan the strip',
      goal: G.lower,
      actor: PERSON,
    });
    if (!owner.ok) throw new Error('create refused');
    // The link the huddle route writes when started for a task.
    expect(store.linkRef(owner.task.id, { kind: 'doc', docId: 'd-owned' }).ok).toBe(true);
    expect(store.placeSpinoff(ws.id, { docId: 'd-owned' })).toEqual({
      goal: G.lower,
      rule: 'originating-task',
      taskId: owner.task.id,
      leadAgentId: 'agent-helper',
    });
    // Control: any other doc still takes the top band.
    expect(store.placeSpinoff(ws.id, { docId: 'd-other' })?.goal).toBe(G.top);
  });

  it('a row spun off the doc is its child, not its owner — origin does not decide', () => {
    const ws = store.createWorkspace('Children');
    const G = seedGoals(
      store,
      ws.id,
      [
        { key: 'top', title: 'Ship the pill' },
        { key: 'lower', title: 'Ship the strip' },
      ],
      PERSON,
    );
    const child = store.createTask(ws.id, {
      title: 'Check the mockup route',
      goal: G.lower,
      origin: { kind: 'doc', docId: 'd-huddle' },
      actor: PERSON,
    });
    if (!child.ok) throw new Error('create refused');
    expect(store.placeSpinoff(ws.id, { docId: 'd-huddle' })).toEqual({
      goal: G.top,
      rule: 'top-active-goal',
    });
  });

  it('a done owner, one at triage, or one in chores lends no band — the rule falls through', () => {
    const ws = store.createWorkspace('Spent');
    const G = seedGoals(
      store,
      ws.id,
      [
        { key: 'top', title: 'Ship the pill' },
        { key: 'lower', title: 'Ship the strip' },
      ],
      PERSON,
    );
    const done = store.createTask(ws.id, { title: 'Shipped it', goal: G.lower, actor: PERSON });
    if (!done.ok) throw new Error('create refused');
    store.linkRef(done.task.id, { kind: 'doc', docId: 'd-spent' });
    store.transition(done.task.id, 'in-progress', { actor: PERSON });
    store.transition(done.task.id, 'done', { actor: PERSON });
    expect(store.placeSpinoff(ws.id, { docId: 'd-spent' })?.rule).toBe('top-active-goal');
    const proposed = store.createTask(ws.id, {
      title: 'Someday',
      fileToTriage: true,
      actor: PERSON,
    });
    if (!proposed.ok) throw new Error('create refused');
    store.linkRef(proposed.task.id, { kind: 'doc', docId: 'd-proposed' });
    expect(store.placeSpinoff(ws.id, { docId: 'd-proposed' })?.rule).toBe('top-active-goal');
    // Backlog is where the rule ends, never where it starts.
    const chore = store.createTask(ws.id, {
      title: 'Tidy up',
      goal: CHORES_GOAL_ID,
      actor: PERSON,
    });
    if (!chore.ok) throw new Error('create refused');
    store.linkRef(chore.task.id, { kind: 'doc', docId: 'd-chore' });
    expect(store.placeSpinoff(ws.id, { docId: 'd-chore' })?.goal).toBe(G.top);
  });
});

interface TaskRow {
  id: string;
  title: string;
  status: string;
  goal?: string;
  assignee?: string;
  assigneeKind?: string;
  ownerKind?: string;
}
interface CreateResponse {
  task: TaskRow;
  placement: { placed?: boolean; spinoff?: string };
}

describe('POST /workspaces/:id/tasks with spinoff: true', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: `localhost:${handle.port}` },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const board = async (name: string, leadAgentId?: string): Promise<string> =>
    (
      await jj<{ workspace: { id: string } }>(
        await post('/workspaces', {
          name,
          ...(leadAgentId ? { leadAgentId } : {}),
        }),
      )
    ).workspace.id;
  const spinoff = (workspaceId: string, over: Record<string, unknown> = {}) =>
    post(`/workspaces/${workspaceId}/tasks`, {
      title: 'Check whether Access covers the mockup route',
      author: PERSON,
      origin: { kind: 'doc', docId: 'd-huddle' },
      spinoff: true,
      ...over,
    });
  const rowOf = async (workspaceId: string, id: string): Promise<TaskRow | undefined> =>
    (
      await jj<{ tasks: TaskRow[] }>(
        await fetch(`${base}/workspaces/${workspaceId}/tasks?format=json`, {
          headers: { host: `localhost:${handle.port}` },
        }),
      )
    ).tasks.find((t) => t.id === id);

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'spinoff-route-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('lands in the top active goal, owned by the lead, at todo — and says which rule', async () => {
    const ws = await board('Led', 'agent-helper');
    const G = await seedGoalsOverHttp(base, ws, [{ key: 'top', title: 'Ship the pill' }], PERSON);
    const r = await jj<CreateResponse>(await spinoff(ws));
    expect(r.task.goal).toBe(G.top);
    expect(r.task.assignee).toBe('agent-helper');
    expect(r.task.status).toBe('todo');
    expect(r.placement.spinoff).toBe('top-active-goal');
    const row = await rowOf(ws, r.task.id);
    expect(row?.ownerKind).toBe('agent');
    expect(row?.status).toBe('todo');
  });

  it('keeps the author as owner when no lead is seated — still placed, still todo', async () => {
    const ws = await board('Unled');
    const G = await seedGoalsOverHttp(base, ws, [{ key: 'top', title: 'Ship the strip' }], PERSON);
    const r = await jj<CreateResponse>(await spinoff(ws));
    expect(r.task.goal).toBe(G.top);
    expect(r.task.assignee).toBe('Jordan');
    expect(r.task.status).toBe('todo');
  });

  it('files to chores when the board has no active band, and says so', async () => {
    const ws = await board('Bare', 'agent-helper');
    const r = await jj<CreateResponse>(await spinoff(ws));
    expect(r.task.goal).toBe(CHORES_GOAL_ID);
    expect(r.placement.spinoff).toBe('chores');
    expect(r.task.assignee).toBe('agent-helper');
    expect(r.task.status).toBe('todo');
  });

  it('a thin selection still goes to triage, but in its band and to the lead', async () => {
    const ws = await board('Thin', 'agent-helper');
    const G = await seedGoalsOverHttp(base, ws, [{ key: 'top', title: 'Ship the pill' }], PERSON);
    const r = await jj<CreateResponse>(await spinoff(ws, { title: 'Cloudflare', triage: true }));
    expect(r.task.status).toBe('triage');
    expect(r.task.goal).toBe(G.top);
    expect(r.task.assignee).toBe('agent-helper');
  });

  it('a row spun off a huddle started FOR a task joins that task’s band', async () => {
    const ws = await board('For a task', 'agent-helper');
    const G = await seedGoalsOverHttp(
      base,
      ws,
      [
        { key: 'top', title: 'Ship the pill' },
        { key: 'lower', title: 'Ship the strip' },
      ],
      PERSON,
    );
    const owner = await jj<CreateResponse>(
      await post(`/workspaces/${ws}/tasks`, {
        title: 'Plan the strip',
        goal: G.lower,
        author: PERSON,
      }),
    );
    const huddle = await jj<{ docId: string; taskId?: string }>(
      await post(`/workspaces/${ws}/huddles`, { kind: 'discussion', taskId: owner.task.id }),
    );
    expect(huddle.taskId).toBe(owner.task.id);
    const r = await jj<CreateResponse & { placement: { spinoffTask?: string } }>(
      await spinoff(ws, { origin: { kind: 'doc', docId: huddle.docId } }),
    );
    expect(r.task.goal).toBe(G.lower);
    expect(r.task.status).toBe('todo');
    expect(r.task.assignee).toBe('agent-helper');
    expect(r.placement.spinoff).toBe('originating-task');
    expect(r.placement.spinoffTask).toBe(owner.task.id);
    // Control: a spin-off from some other doc on the same board takes the
    // top band, so the join above is the link's doing.
    const other = await jj<CreateResponse>(await spinoff(ws));
    expect(other.task.goal).toBe(G.top);
    expect(other.placement.spinoff).toBe('top-active-goal');
  });

  it('an explicit goal or assignee in the same body wins over the rule', async () => {
    const ws = await board('Explicit', 'agent-helper');
    const G = await seedGoalsOverHttp(
      base,
      ws,
      [
        { key: 'top', title: 'Ship the pill' },
        { key: 'named', title: 'Ship the strip' },
      ],
      PERSON,
    );
    const r = await jj<CreateResponse>(await spinoff(ws, { goal: G.named, assignee: 'Dana' }));
    expect(r.task.goal).toBe(G.named);
    expect(r.task.assignee).toBe('Dana');
  });

  it('a create WITHOUT the flag is untouched — the control', async () => {
    const ws = await board('Control', 'agent-helper');
    await seedGoalsOverHttp(base, ws, [{ key: 'top', title: 'Ship the pill' }], PERSON);
    const r = await jj<CreateResponse>(await spinoff(ws, { spinoff: undefined }));
    expect(r.placement.spinoff).toBeUndefined();
    expect(r.task.assignee).toBe('Jordan');
    expect(r.task.goal).not.toBe(undefined);
  });
});

/**
 * The title a pill-made row carries — and where "Untitled task" actually
 * comes from.
 *
 * Bryan's report (2026-09-01) said a task made with Create Task landed as
 * "Untitled task" in chores. The two such rows on the board carry no
 * origin, no body, `untitled: true` and a person as creator — the shape
 * of the Board's own "New task" button, not the pill's: the pill always
 * sends the selected words as the title and the doc as `origin`, and the
 * parser only ever stores the placeholder for a create that DECLARES
 * itself untitled. Both shapes are pinned here so the two cannot be
 * confused again.
 */
describe('a pill-made row is titled by its words and points at its doc', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let ws: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: `localhost:${handle.port}` },
      body: JSON.stringify(body),
    });
  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'spinoff-title-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    ws = (await jj<{ workspace: { id: string } }>(await post('/workspaces', { name: 'Titles' })))
      .workspace.id;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('the pill shape: the selected words are the title, the doc is the origin', async () => {
    const r = await jj<{ task: TaskRow & { untitled?: boolean; origin?: unknown } }>(
      await post(`/workspaces/${ws}/tasks`, {
        title: 'Check whether Access covers the mockup route',
        body: 'Spun off from a line of the discussion "Widget rollout".\n\n> Check whether…',
        author: PERSON,
        origin: { kind: 'doc', docId: 'd-huddle' },
        spinoff: true,
      }),
    );
    expect(r.task.title).toBe('Check whether Access covers the mockup route');
    expect(r.task.untitled).toBeUndefined();
    expect(r.task.origin).toEqual({ kind: 'doc', docId: 'd-huddle' });
  });

  it('the Board’s New-task shape is the one that stores "Untitled task" — the control', async () => {
    const r = await jj<{ task: TaskRow & { untitled?: boolean; origin?: unknown } }>(
      await post(`/workspaces/${ws}/tasks`, { untitled: true, author: PERSON }),
    );
    expect(r.task.title).toBe('Untitled task');
    expect(r.task.untitled).toBe(true);
    expect(r.task.origin).toBeUndefined();
  });

  it('a pill create with words that reduce to nothing is refused, never filed untitled', async () => {
    const res = await post(`/workspaces/${ws}/tasks`, {
      title: '   ',
      author: PERSON,
      origin: { kind: 'doc', docId: 'd-huddle' },
      spinoff: true,
    });
    expect(res.status).toBe(400);
  });
});
