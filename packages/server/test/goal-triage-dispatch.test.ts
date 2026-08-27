/**
 * What a band in triage does to the work under it.
 *
 * A goal in triage is a band nobody has agreed to yet, and the rows under it
 * inherit that: they are still listed, still ranked, still visible on every
 * board surface — and no wake will ever name one.
 *
 * ── Listed, not dropped — and why that is the opposite of a triage TASK ──
 *
 * A triage TASK leaves `buildQueue` entirely (`t.status !== 'triage'`). A row
 * under a triage GOAL does not, and the difference is deliberate.
 *
 * The precedent it follows is `backlog` — a row outside every ranked band.
 * That row is also never auto-dispatched, and it is also still returned,
 * because the gate one rung up has to be able to SAY so. `considered` is a
 * denominator: drop the rows and an all-triage board reports "nothing ready"
 * exactly as an empty board does, which is the single failure the ready gate
 * was rebuilt to prevent. Bryan asked for the report to show these rows as
 * "goal in triage" rather than fail on them, and a row that is not in the
 * queue cannot be shown as anything.
 *
 * So the queue marks the row and the gate withholds it. A lead reading
 * `next_tasks` sees the band and can disagree with it; a wake never spends
 * somebody's turn on it.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateReadyWork } from '../src/ready-gate.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { buildQueue } from '../src/task-queue.ts';
import { TaskStore } from '../src/tasks.ts';
import { seedGoals } from './goal-seed.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const AGENT = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };

describe('a band in triage holds the work under it', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-triage-dispatch-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * One board, two bands: `pending` left in triage, `agreed` activated. Each
   * carries one ready row owned by an agent.
   *
   * Two bands rather than one, always. A single triage band would let a gate
   * that had simply stopped returning anything pass every assertion here.
   */
  function board(): {
    wsId: string;
    pending: string;
    agreed: string;
    rows: Record<string, string>;
  } {
    const wsId = store.createWorkspace('Board').id;
    const G = seedGoals(
      store,
      wsId,
      [
        { key: 'pending', title: 'Rebuild the ranker' },
        { key: 'agreed', title: 'Fix the crawler' },
      ],
      PERSON,
      { leaveInTriage: true },
    );
    const moved = store.transition(G.agreed, 'todo', { actor: PERSON });
    if (!moved.ok) throw new Error(`could not activate: ${moved.error}`);

    const rows: Record<string, string> = {};
    for (const key of ['pending', 'agreed']) {
      const created = store.createTask(wsId, {
        title: `Work under ${key}`,
        body: `Agent can work ${key} so that the queue keeps moving.`,
        assignee: AGENT.name,
        assigneeKind: 'agent',
        goal: G[key] as string,
        actor: PERSON,
      });
      if (!created.ok) throw new Error('create failed');
      rows[key] = created.task.id;
    }
    return { wsId, pending: G.pending as string, agreed: G.agreed as string, rows };
  }

  function queue(wsId: string) {
    return buildQueue(store.listTasks(wsId), store.getWorkspace(wsId)?.goals ?? [], {
      goalRows: store.listGoalRows(wsId),
    });
  }

  describe('the queue marks it', () => {
    it('flags the row under the triage band and leaves the agreed one clear', () => {
      const { wsId, rows } = board();
      const byId = new Map(queue(wsId).map((r) => [r.id, r]));
      expect(byId.get(rows.pending as string)?.goalInTriage).toBe(true);
      // The other half of the same read: a gate that marked everything would
      // satisfy the line above and be useless.
      expect(byId.get(rows.agreed as string)?.goalInTriage).toBe(false);
    });

    it('still LISTS the row — the band is a verdict, not a disappearance', () => {
      const { wsId, rows } = board();
      expect(
        queue(wsId)
          .map((r) => r.id)
          .sort(),
      ).toEqual([rows.pending as string, rows.agreed as string].sort());
    });

    it('clears the flag the moment the band is agreed to', () => {
      const { wsId, pending, rows } = board();
      expect(store.transition(pending, 'todo', { actor: PERSON }).ok).toBe(true);
      const byId = new Map(queue(wsId).map((r) => [r.id, r]));
      expect(byId.get(rows.pending as string)?.goalInTriage).toBe(false);
    });

    it('reads FALSE when no goal rows are supplied, rather than guessing', () => {
      // `goalRows` is what carries a band's status; a caller that cannot
      // supply them has not learned that every band is in triage. The queue
      // says so by marking nothing — the direction that keeps work visible.
      const { wsId, rows } = board();
      const rowsOut = buildQueue(store.listTasks(wsId), store.getWorkspace(wsId)?.goals ?? []);
      expect(rowsOut.every((r) => r.goalInTriage === false)).toBe(true);
      expect(rowsOut.map((r) => r.id).sort()).toEqual(
        [rows.pending as string, rows.agreed as string].sort(),
      );
    });
  });

  describe('the ready gate withholds it', () => {
    it('holds the row as `goal-triage` and still names the agreed one', () => {
      const { wsId, rows } = board();
      const verdict = evaluateReadyWork(queue(wsId), {
        ownerKind: () => 'agent',
        reviewState: () => ({ open: 0, unreadable: 0 }),
      });
      expect(verdict.ready.map((r) => r.id)).toEqual([rows.agreed as string]);
      expect(verdict.held).toEqual({ 'goal-triage': 1 });
      // The denominator still counts it. This is the whole reason the row
      // stays in the queue: "one row held because its band is in triage" and
      // "nothing on this board" must not read the same.
      expect(verdict.considered).toBe(2);
      expect(verdict.undetermined).toEqual([]);
    });

    it('releases the row once the band is agreed to', () => {
      // POSITIVE CONTROL for the hold above: the same board, the same rows,
      // one status changed. Without it, "the row was held" would also be
      // satisfied by a gate that held every row on any board with goals.
      const { wsId, pending, rows } = board();
      expect(store.transition(pending, 'todo', { actor: PERSON }).ok).toBe(true);
      const verdict = evaluateReadyWork(queue(wsId), {
        ownerKind: () => 'agent',
        reviewState: () => ({ open: 0, unreadable: 0 }),
      });
      expect(verdict.ready.map((r) => r.id).sort()).toEqual(
        [rows.pending as string, rows.agreed as string].sort(),
      );
      expect(verdict.held).toEqual({});
    });

    it('holds a row whose band is in triage even when the row itself is free', () => {
      // The band is the verdict. Nothing about the row — unblocked, owned by
      // an agent, unparked, no open questions — can override it.
      const { wsId, rows } = board();
      const verdict = evaluateReadyWork(
        queue(wsId).filter((r) => r.id === rows.pending),
        { ownerKind: () => 'agent', reviewState: () => ({ open: 0, unreadable: 0 }) },
      );
      expect(verdict.ready).toEqual([]);
      expect(verdict.held).toEqual({ 'goal-triage': 1 });
    });
  });
});

/**
 * The wiring, over the route.
 *
 * The cases above pin the rule against rows built by hand. What they cannot
 * see is whether the SHIPPED dispatch read passes the goal rows in at all —
 * `goalRows` is an option, and an option nobody passes is a gate that is
 * always off while every unit test around it stays green.
 */
describe('over the dispatch route', () => {
  let dir: string;
  let handle: ServerHandle;
  let base: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'goal-triage-next-'));
    handle = createServer({ dataDir: dir, port: 0 });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('carries the band verdict on every row `/next` returns', async () => {
    const store = handle.tasks;
    const wsId = store.createWorkspace('Board').id;
    const G = seedGoals(
      store,
      wsId,
      [
        { key: 'pending', title: 'Rebuild the ranker' },
        { key: 'agreed', title: 'Fix the crawler' },
      ],
      PERSON,
      { leaveInTriage: true },
    );
    if (!store.transition(G.agreed as string, 'todo', { actor: PERSON }).ok) {
      throw new Error('could not activate the agreed band');
    }
    const ids: Record<string, string> = {};
    for (const key of ['pending', 'agreed']) {
      const created = store.createTask(wsId, {
        title: `Work under ${key}`,
        assignee: AGENT.name,
        assigneeKind: 'agent',
        goal: G[key] as string,
        actor: PERSON,
      });
      if (!created.ok) throw new Error('create failed');
      ids[key] = created.task.id;
    }

    const res = await fetch(`${base}/api/workspaces/${encodeURIComponent(wsId)}/next`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ id: string; goalInTriage: boolean }> };
    const byId = new Map(body.tasks.map((r) => [r.id, r]));
    expect(byId.get(ids.pending as string)?.goalInTriage).toBe(true);
    // POSITIVE CONTROL: the same route, the same shape, the other band. A
    // route that hard-coded `true` — or that simply never learned the rows —
    // fails on one of these two lines.
    expect(byId.get(ids.agreed as string)?.goalInTriage).toBe(false);
  });
});
