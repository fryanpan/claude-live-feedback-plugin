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
 * The rule, in order: the originating task's goal (a huddle records no
 * task yet, so this step is documented and skipped), the board's top ACTIVE
 * goal, else chores. Owner: the lead when the seat is held, else the
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

describe('POST /api/workspaces/:id/tasks with spinoff: true', () => {
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
        await post('/api/workspaces', {
          name,
          ...(leadAgentId ? { leadAgentId } : {}),
        }),
      )
    ).workspace.id;
  const spinoff = (workspaceId: string, over: Record<string, unknown> = {}) =>
    post(`/api/workspaces/${workspaceId}/tasks`, {
      title: 'Check whether Access covers the mockup route',
      author: PERSON,
      origin: { kind: 'doc', docId: 'd-huddle' },
      spinoff: true,
      ...over,
    });
  const rowOf = async (workspaceId: string, id: string): Promise<TaskRow | undefined> =>
    (
      await jj<{ tasks: TaskRow[] }>(
        await fetch(`${base}/api/workspaces/${workspaceId}/tasks`, {
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
