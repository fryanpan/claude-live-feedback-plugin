/**
 * Dropping a row between two rows that share an `order`.
 *
 * `order` is fractional and nothing has ever guaranteed it is DISTINCT within
 * a goal — `createTask` and `setTaskGoal` both store whatever number the
 * caller sends, so two agents that each say `1` tie. The board sorts by
 * `(order, createdAt, id)`, so between two tied rows there is no order value
 * at all: any number greater than the first is also greater than the second,
 * and the createdAt tiebreak decides where the row actually lands. A drop
 * there cannot be expressed as a number, which is why the placement also
 * takes `after` — the id of the row the dragged row should land behind.
 *
 * An id rather than an INDEX because the two ends count different rows: the
 * board's list is filtered (done window, "mine" tab) and the server's is not,
 * so an index would mean two different things at the two ends of the request.
 *
 * Measured on a real board before this was written: 5 of the 12 visible rows
 * in one goal shared an order with a neighbour, and 14% of the drops that
 * board could express landed somewhere other than where the pointer put them.
 *
 * Fixtures are synthetic — invented names, the repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { User } from '@feedback/core';

import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';
import { type GoalIds, seedGoalsOverHttp } from './goal-seed.ts';

const PERSON: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
const AGENT: User = {
  id: 'agent-search-revamp',
  name: 'Search Revamp',
  kind: 'known',
  color: '#888888',
};

/** The rows the fixture seeds, and the `order` each one is created with.
 *  Alpha/Bravo tie at 0.5 and Charlie/Delta/Echo all tie at 1 — the shape a
 *  real board had, where every agent that placed a row picked a round number
 *  without looking at what was already there. */
const ROWS = [
  ['Alpha', 0.5],
  ['Bravo', 0.5],
  ['Charlie', 1],
  ['Delta', 1],
  ['Echo', 1],
] as const;

interface Fixture {
  wsId: string;
  goal: string;
  /** row name → task id */
  ids: Record<string, string>;
}

describe('placing a row among tied orders', () => {
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

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'reorder-ties-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function seedTiedGoal(): Promise<Fixture> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship search v2.' }),
    );
    const G: GoalIds = await seedGoalsOverHttp(
      base,
      workspace.id,
      [{ key: 'loop', title: '1. The loop' }],
      PERSON,
    );
    const goal = G.loop as string;
    const ids: Record<string, string> = {};
    for (const [name, order] of ROWS) {
      // Spaced so `createdAt` is strictly increasing. The rows TIE on order by
      // design, which puts the whole fixture on the createdAt tiebreak — and
      // rows created inside one millisecond fall through to a comparison of
      // two random ids, which would make every assertion below a coin flip.
      await new Promise((r) => setTimeout(r, 2));
      const { task } = await jj<{ task: Task }>(
        await post(`/api/workspaces/${workspace.id}/tasks`, {
          author: AGENT,
          title: `${name} row`,
          goal,
          order,
        }),
      );
      ids[name] = task.id;
    }
    return { wsId: workspace.id, goal, ids };
  }

  async function tasksOf(wsId: string): Promise<Task[]> {
    const { tasks } = await jj<{ tasks: Task[] }>(
      await fetch(`${base}/api/workspaces/${wsId}/tasks`),
    );
    return tasks;
  }

  /** The goal's rows in the order the BOARD renders them — `byBoardOrder`
   *  spelled out, since what a reader sees is the thing under test. */
  async function boardOrder(f: Fixture): Promise<string[]> {
    const name = new Map(Object.entries(f.ids).map(([n, id]) => [id, n]));
    return (await tasksOf(f.wsId))
      .filter((t) => name.has(t.id))
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((t) => name.get(t.id) as string);
  }

  async function orderOf(f: Fixture): Promise<Record<string, number>> {
    const name = new Map(Object.entries(f.ids).map(([n, id]) => [id, n]));
    const out: Record<string, number> = {};
    for (const t of await tasksOf(f.wsId)) {
      const n = name.get(t.id);
      if (n) out[n] = t.order;
    }
    return out;
  }

  it('seeds the tie the field produces — the shape every case below rests on', async () => {
    // Asserted before any behaviour is: a fixture that failed to build the tie
    // would make the cases below pass against arithmetic that cannot handle
    // one. Both halves matter — tied orders, and the strictly increasing
    // createdAt that makes the resulting sequence deterministic.
    const f = await seedTiedGoal();
    const orders = await orderOf(f);
    expect(orders.Alpha).toBe(orders.Bravo as number);
    expect(orders.Charlie).toBe(orders.Delta as number);
    expect(orders.Delta).toBe(orders.Echo as number);

    const byName = new Map((await tasksOf(f.wsId)).map((t) => [t.id, t.createdAt]));
    const stamps = ROWS.map(([n]) => byName.get(f.ids[n] as string) as number);
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i] as number).toBeGreaterThan(stamps[i - 1] as number);
    }
    expect(await boardOrder(f)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']);
  });

  it('lands a row between two TIED neighbours, where no position could', async () => {
    // Reproduced in a browser before this was written: dragging Charlie onto
    // the gap between Delta and Echo put it BELOW Echo, because the client can
    // only say `1.5` and 1.5 sorts after both of them.
    const f = await seedTiedGoal();
    await jj(
      await post(`/api/tasks/${f.ids.Charlie}/goal`, {
        author: PERSON,
        goal: f.goal,
        after: f.ids.Delta,
      }),
    );
    expect(await boardOrder(f)).toEqual(['Alpha', 'Bravo', 'Delta', 'Charlie', 'Echo']);
  });

  it('two different drop slots reach two different places', async () => {
    // The symptom Bryan reported was not "off by one" — it was that visibly
    // different drop targets collapsed onto ONE outcome, so the row could not
    // be put where he wanted it at all. A case asserting a single drop cannot
    // see that, so this one asserts the two answers disagree.
    const a = await seedTiedGoal();
    await jj(
      await post(`/api/tasks/${a.ids.Charlie}/goal`, {
        author: PERSON,
        goal: a.goal,
        after: a.ids.Delta,
      }),
    );
    const b = await seedTiedGoal();
    await jj(
      await post(`/api/tasks/${b.ids.Charlie}/goal`, {
        author: PERSON,
        goal: b.goal,
        after: b.ids.Echo,
      }),
    );
    expect(await boardOrder(a)).toEqual(['Alpha', 'Bravo', 'Delta', 'Charlie', 'Echo']);
    expect(await boardOrder(b)).toEqual(['Alpha', 'Bravo', 'Delta', 'Echo', 'Charlie']);
  });

  it('`after: null` means the top of the goal', async () => {
    const f = await seedTiedGoal();
    await jj(
      await post(`/api/tasks/${f.ids.Echo}/goal`, { author: PERSON, goal: f.goal, after: null }),
    );
    expect(await boardOrder(f)).toEqual(['Echo', 'Alpha', 'Bravo', 'Charlie', 'Delta']);
  });

  it('leaves the goal with distinct orders, so the next drop has somewhere to land', async () => {
    // The repair is the point, not a side effect: a goal that keeps its ties
    // needs this same step-around on every future drag, and a tie the board
    // never drops into never heals.
    const f = await seedTiedGoal();
    await jj(
      await post(`/api/tasks/${f.ids.Charlie}/goal`, {
        author: PERSON,
        goal: f.goal,
        after: f.ids.Delta,
      }),
    );
    const orders = Object.values(await orderOf(f));
    expect(orders).toHaveLength(ROWS.length);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('a placement that renumbers does not restamp every row as freshly updated', async () => {
    // Renumbering rewrites `order` on rows nobody moved. Bumping their
    // `updatedAt` too would report the whole goal as touched, which the
    // staleness sweep and the activity feed both read.
    const f = await seedTiedGoal();
    const was = new Map((await tasksOf(f.wsId)).map((t) => [t.id, t.updatedAt]));
    await new Promise((r) => setTimeout(r, 5));
    await jj(
      await post(`/api/tasks/${f.ids.Charlie}/goal`, {
        author: PERSON,
        goal: f.goal,
        after: f.ids.Delta,
      }),
    );
    for (const t of await tasksOf(f.wsId)) {
      if (t.id === f.ids.Charlie) {
        expect(t.updatedAt).toBeGreaterThan(was.get(t.id) as number);
      } else {
        expect(t.updatedAt).toBe(was.get(t.id) as number);
      }
    }
  });

  it('moves a row into a DIFFERENT goal at a named position', async () => {
    // `after` has to survive the cross-goal case, which is the same gesture on
    // the board — drag a row into another section and drop it partway down.
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship search v2.' }),
    );
    const G = await seedGoalsOverHttp(
      base,
      workspace.id,
      [
        { key: 'loop', title: '1. The loop' },
        { key: 'trust', title: '2. Trust' },
      ],
      PERSON,
    );
    const ids: Record<string, string> = {};
    for (const [name, goal, order] of [
      ['Alpha', G.loop, 1],
      ['Bravo', G.loop, 1],
      ['Solo', G.trust, 1],
    ] as const) {
      await new Promise((r) => setTimeout(r, 2));
      const { task } = await jj<{ task: Task }>(
        await post(`/api/workspaces/${workspace.id}/tasks`, {
          author: AGENT,
          title: `${name} row`,
          goal,
          order,
        }),
      );
      ids[name] = task.id;
    }
    const res = await jj<{ ok: true; changed: boolean; task: Task }>(
      await post(`/api/tasks/${ids.Solo}/goal`, {
        author: PERSON,
        goal: G.loop as string,
        after: ids.Alpha,
      }),
    );
    expect(res.task.goal).toBe(G.loop as string);
    const f: Fixture = { wsId: workspace.id, goal: G.loop as string, ids };
    expect(await boardOrder(f)).toEqual(['Alpha', 'Solo', 'Bravo']);
  });

  it('still honours a position-only caller — an older bundle keeps working', async () => {
    // `after` is new; every MCP session older than this release places with
    // `position` alone and cannot be restarted from here. The old payload is
    // sent verbatim rather than alongside the new field.
    const f = await seedTiedGoal();
    const res = await jj<{ ok: true; changed: boolean; task: Task }>(
      await post(`/api/tasks/${f.ids.Alpha}/goal`, { author: AGENT, goal: f.goal, position: 9 }),
    );
    expect(res.task.order).toBe(9);
    expect(await boardOrder(f)).toEqual(['Bravo', 'Charlie', 'Delta', 'Echo', 'Alpha']);
  });

  it('refuses an `after` that names a row in another goal', async () => {
    const f = await seedTiedGoal();
    const other = await seedTiedGoal();
    const res = await post(`/api/tasks/${f.ids.Charlie}/goal`, {
      author: PERSON,
      goal: f.goal,
      after: other.ids.Delta,
    });
    expect(res.status).toBe(400);
    // Positive control: the same request with a row from the TARGET goal is
    // accepted, so the 400 is about where the named row lives and not about
    // `after` being rejected wholesale.
    expect(
      (
        await post(`/api/tasks/${f.ids.Charlie}/goal`, {
          author: PERSON,
          goal: f.goal,
          after: f.ids.Delta,
        })
      ).status,
    ).toBe(200);
  });

  it('refuses an `after` that is neither a string nor null', async () => {
    const f = await seedTiedGoal();
    expect(
      (await post(`/api/tasks/${f.ids.Charlie}/goal`, { author: PERSON, goal: f.goal, after: 3 }))
        .status,
    ).toBe(400);
  });
});
