/**
 * A create says what happened to the task's PLACEMENT.
 *
 * The gap this closes, reproduced against a live server before any of it was
 * written: a workspace with two real goal bands, a create that names no
 * `goal`, and the response is `{ task: { goal: "chores", ... } }` and nothing
 * else. The agent that just generated the work — the one party that still
 * knows why the task exists and is best placed to rank it — cannot tell
 * "Backlog because I asked for Backlog" from "Backlog because I named nothing
 * and now nobody will ever place it", and does not know the bands exist
 * without a second `get_workspace` it has no reason to make.
 *
 * So the fix is not to guess a band. Auto-filing an unjudged task into the
 * top band fails in the dangerous direction — it outranks work somebody
 * actually ranked, and stamps a placement nobody made. The fix is to make
 * the create SAY it, grounded in what happened rather than inferred:
 * `placed` comes from whether the caller named a goal, `triageDelivered`
 * from whether the request reached a live attachment (never from "this
 * workspace has an agent somewhere"), and the bands come along so the
 * caller can act in the same breath.
 *
 * All fixtures are synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { TaskStore } from '../src/tasks.ts';
import { openWorkspaceStream } from './agent-stream.ts';
import { type GoalIds, seedGoals, seedGoalsOverHttp } from './goal-seed.ts';

const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known', color: '#888888' };

interface GoalRef {
  id: string;
  title: string;
  depth: number;
  parent?: string;
}
interface SinglePlacement {
  placed: boolean;
  triageDelivered: boolean;
  goals?: GoalRef[];
}
interface BatchPlacement {
  unplaced: string[];
  triageDelivered: string[];
  goals: GoalRef[];
}

describe('the store reports placement, grounded in what actually happened', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-placement-store-'));
  });
  afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

  function seed(): { wsId: string; G: GoalIds } {
    store = new TaskStore({ dataDir });
    const ws = store.createWorkspace('search-revamp', 'Ship search v2.');
    const G = seedGoals(store, ws.id, [{ key: 'ship', title: '1. Ship' }], {
      id: AGENT.id,
      name: AGENT.name,
      kind: AGENT.kind,
    });
    return { wsId: ws.id, G };
  }

  it('an explicit goal is a placement — even an explicit "chores"', () => {
    const { wsId, G } = seed();
    // The distinction the whole field rests on: the same resting bucket,
    // reached two different ways, is not the same event.
    const named = store.createTask(wsId, {
      title: 'Placed',
      assignee: 'Search Revamp',
      goal: G.ship,
    });
    const chores = store.createTask(wsId, {
      title: 'Placed in chores on purpose',
      assignee: 'Search Revamp',
      goal: 'chores',
    });
    expect(named.ok && named.placement.placed).toBe(true);
    expect(chores.ok && chores.placement.placed).toBe(true);
  });

  it('an omitted goal is not a placement, and triageDelivered follows the delivery', () => {
    const { wsId } = seed();
    // No delivery wired: the request reaches nobody, and the report says so.
    const away = store.createTask(wsId, { title: 'Nobody home', assignee: 'Search Revamp' });
    expect(away.ok && away.placement).toEqual({ placed: false, triageDelivered: false });

    // Positive control: with a live delivery the SAME call reports true, so
    // the false above is a measurement and not a constant.
    store.setTriageDelivery(() => true);
    const live = store.createTask(wsId, { title: 'Somebody home', assignee: 'Search Revamp' });
    expect(live.ok && live.placement).toEqual({ placed: false, triageDelivered: true });

    // …and a delivery that reports no live attachment reads as away again.
    store.setTriageDelivery(() => false);
    const refused = store.createTask(wsId, { title: 'Away again', assignee: 'Search Revamp' });
    expect(refused.ok && refused.placement.triageDelivered).toBe(false);
  });

  it('never claims delivery for a placed task — a placement asks for no triage', () => {
    const { wsId, G } = seed();
    store.setTriageDelivery(() => true);
    const res = store.createTask(wsId, {
      title: 'Placed while an agent is live',
      assignee: 'Search Revamp',
      goal: G.ship,
    });
    expect(res.ok && res.placement).toEqual({ placed: true, triageDelivered: false });
  });
});

describe('the create ROUTES carry placement to the caller', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function seedWorkspace(): Promise<{ wsId: string; G: GoalIds }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship search v2.' }),
    );
    const G = await seedGoalsOverHttp(
      base,
      workspace.id,
      [
        { key: 'ship', title: '1. Ship', subgoals: [{ key: 'index', title: '1.1 Index' }] },
        { key: 'trust', title: '2. Trust' },
      ],
      AGENT,
    );
    return { wsId: workspace.id, G };
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-placement-routes-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('single create: an unplaced task comes back with the bands it could go in', async () => {
    const { wsId, G } = await seedWorkspace();
    const res = await jj<{ placement: SinglePlacement }>(
      await post(`/api/workspaces/${wsId}/tasks`, { author: AGENT, title: 'Unplaced' }),
    );
    expect(res.placement.placed).toBe(false);
    // Ordered, flat, parent then subgoal — the same order the board reads.
    expect(res.placement.goals?.map((g) => g.id)).toEqual([G.ship, G.index, G.trust]);
    expect(res.placement.goals?.map((g) => g.depth)).toEqual([0, 1, 0]);
    expect(res.placement.goals?.find((g) => g.id === G.index)?.parent).toBe(G.ship);
    // `chores` is where it just landed, not a band it could have been ranked
    // into — offering it back as a choice would be the tool suggesting the
    // outcome it is reporting.
    expect(res.placement.goals?.some((g) => g.id === 'chores')).toBe(false);
  });

  it('single create: a placed task carries no band list to wade through', async () => {
    const { wsId, G } = await seedWorkspace();
    const res = await jj<{ placement: SinglePlacement }>(
      await post(`/api/workspaces/${wsId}/tasks`, {
        author: AGENT,
        title: 'Placed',
        goal: G.index,
      }),
    );
    expect(res.placement).toEqual({ placed: true, triageDelivered: false });
  });

  it('batch: reports which rows are unplaced, once, with the bands', async () => {
    const { wsId, G } = await seedWorkspace();
    const res = await jj<{
      tasks: Array<{ id: string; title: string }>;
      placement: BatchPlacement;
    }>(
      await post(`/api/workspaces/${wsId}/tasks/batch`, {
        author: AGENT,
        tasks: [
          { title: 'Placed row', goal: G.index },
          { title: 'Unplaced row' },
          { title: 'Another unplaced row' },
        ],
      }),
    );
    const idOf = (title: string) => res.tasks.find((t) => t.title === title)?.id;
    expect(res.placement.unplaced.sort()).toEqual(
      [idOf('Unplaced row') as string, idOf('Another unplaced row') as string].sort(),
    );
    expect(res.placement.unplaced).not.toContain(idOf('Placed row'));
    // One band list for the whole call — repeating it per row would be the
    // same answer a hundred times in a hundred-row burst.
    expect(res.placement.goals.map((g) => g.id)).toEqual([G.ship, G.index, G.trust]);
  });

  it('batch: a fully placed burst carries no placement block at all', async () => {
    const { wsId, G } = await seedWorkspace();
    const res = await jj<{ placement?: BatchPlacement }>(
      await post(`/api/workspaces/${wsId}/tasks/batch`, {
        author: AGENT,
        tasks: [
          { title: 'One', goal: G.ship },
          { title: 'Two', goal: G.trust },
        ],
      }),
    );
    expect(res.placement).toBeUndefined();
  });

  it('the route forwards the DELIVERY, not a guess about it', async () => {
    // The half a unit test cannot prove: whether the route reads the store's
    // answer or re-derives one. With no attachment it must be false; with a
    // live attachment, true — same call, same body, different report.
    const { wsId } = await seedWorkspace();
    const away = await jj<{ placement: SinglePlacement }>(
      await post(`/api/workspaces/${wsId}/tasks`, { author: AGENT, title: 'Filed while away' }),
    );
    expect(away.placement.triageDelivered).toBe(false);

    const attached = await post(`/api/workspaces/${wsId}/attachments`, {
      agentId: AGENT.id,
      runtime: 'claude-code-local',
      author: AGENT,
    });
    expect(attached.status).toBe(200);
    // …and reachable. The MCP opens this stream immediately after attaching,
    // and the request is delivered by broadcasting on it, so an agent that
    // registered without connecting is not somewhere a delivery can land.
    const stream = await openWorkspaceStream(base, wsId);

    const live = await jj<{ placement: SinglePlacement }>(
      await post(`/api/workspaces/${wsId}/tasks`, { author: AGENT, title: 'Filed while live' }),
    );
    expect(live.placement.triageDelivered).toBe(true);
    await stream.close();
  });
});
