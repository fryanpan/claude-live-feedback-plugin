/**
 * The `triage` status: a row nobody has vetted yet.
 *
 * A task an agent files is a proposal, not a decision — so it lands in
 * `triage`, keeps its band position, and is invisible to every dispatch read
 * until somebody moves it out. A person filing a task has already made the
 * decision, so their rows skip triage entirely. Clearing is not a separate
 * verb: ANY attributed move out through the ordinary transition gate does it,
 * and the trail that gate already writes is the record of who cleared it.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { buildQueue, summarizeGoals } from '../src/task-queue.ts';
import { CHORES_GOAL_ID, TaskStore } from '../src/tasks.ts';

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };

describe('triage status', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'triage-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function ws(): string {
    return store.createWorkspace('board').id;
  }

  describe('the default a create lands on', () => {
    it('puts an agent-filed task in triage', () => {
      const res = store.createTask(ws(), {
        title: 'Rebuild the ranker',
        assignee: AGENT.name,
        goal: CHORES_GOAL_ID,
        actor: AGENT,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.status).toBe('triage');
      // Nothing else about the row moves: triage is a status, not a bucket.
      expect(res.task.goal).toBe(CHORES_GOAL_ID);
      expect(res.task.transitions).toEqual([]);
    });

    it('puts a person-filed task straight in todo', () => {
      const res = store.createTask(ws(), {
        title: 'Rebuild the ranker',
        assignee: PERSON.name,
        goal: CHORES_GOAL_ID,
        actor: PERSON,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.status).toBe('todo');
    });

    it('leaves a create that attributes nobody in todo', () => {
      // Deliberate, and the opposite direction from `classifyActor`'s own
      // default. Triage takes a row OUT of dispatch, so guessing "an agent
      // filed it" from an absence would silently drop work nobody can see is
      // missing. Every creation route resolves an author first; this covers
      // the direct in-process call that names none.
      const res = store.createTask(ws(), { title: 'Rebuild the ranker' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.status).toBe('todo');
    });

    it('puts a new GOAL row in triage too, on its own rule', () => {
      // Not this function's rule: a goal is a proposal whoever adds it, so
      // the person/agent split above does not apply. `syncGoalRows` owns the
      // goal default, and `goal-triage-default.test.ts` pins both of its
      // answers — the create one here, and the migration one that must not
      // inherit it.
      const wsId = ws();
      const res = store.setGoalList(wsId, [{ title: 'Ship the ranker' }], { actor: AGENT });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const goalId = res.created[0]?.id as string;
      expect(store.getGoalRow(goalId)?.status).toBe('triage');
    });
  });

  /**
   * A goal HOLDS triage, and it means about a band what it means about a row:
   * nobody has agreed this is work yet, so nothing under it is dispatched.
   *
   * This reverses an invariant the gate used to enforce (`goal-not-triageable`,
   * removed here). The reasoning that refusal rested on — "triage is a claim
   * that an agent filed this and nobody vetted it, and a goal is neither filed
   * by an agent nor dispatched" — was right about the first half and wrong
   * about the second. A goal band IS dispatched, transitively: every task in
   * it inherits the band's priority, so a band nobody has agreed to is a band
   * whose tasks get picked up on the strength of an agreement that was never
   * made. That is the hole triage exists to close, one level up.
   *
   * Moving a goal out of triage needs no new verb, exactly as it needs none
   * for a task: any attributed move through this gate does it, and the trail
   * the gate already writes is the record of who agreed.
   */
  describe('a goal row can be moved INTO triage', () => {
    function goal(wsId: string): string {
      const res = store.setGoalList(wsId, [{ title: 'Ship the ranker' }], { actor: AGENT });
      if (!res.ok) throw new Error('goal list refused');
      const id = res.created[0]?.id as string;
      // Seeded goals arrive in triage now (see `goal-triage-default.test.ts`).
      // Activate first, so the move under test is genuinely a move INTO triage
      // rather than a no-op the `same-status` arm would refuse.
      const up = store.transition(id, 'todo', { actor: PERSON });
      if (!up.ok) throw new Error(`could not activate seeded goal: ${up.error}`);
      return id;
    }

    it('accepts the move and writes it to the trail', () => {
      const wsId = ws();
      const goalId = goal(wsId);
      const res = store.transition(goalId, 'triage', { actor: PERSON, note: 'not agreed yet' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(store.getGoalRow(goalId)?.status).toBe('triage');
      const entry = store.getGoalRow(goalId)?.transitions.at(-1);
      expect(entry?.from).toBe('todo');
      expect(entry?.to).toBe('triage');
      expect(entry?.by).toMatchObject({ name: 'Bryan', kind: 'person' });
      expect(entry?.note).toBe('not agreed yet');
    });

    it('is a BACKWARD move, so an open child never blocks it', () => {
      // The mirror of the task rule: undoing an agreement must not be
      // blockable. A goal's forward moves consult `openChildren`; this one
      // must not, or a band could never be sent back once work started under
      // it — which is exactly when somebody discovers it was never agreed.
      const wsId = ws();
      const goalId = goal(wsId);
      const child = store.createTask(wsId, {
        title: 'Rebuild the ranker',
        assignee: PERSON.name,
        goal: goalId,
        actor: PERSON,
      });
      if (!child.ok) throw new Error('create failed');
      const res = store.transition(goalId, 'triage', { actor: PERSON });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.blockers).toEqual([]);
    });

    it('still lets the goal move everywhere else — nothing else about the gate changed', () => {
      const wsId = ws();
      const goalId = goal(wsId);
      // POSITIVE CONTROL. Without it, "triage was accepted" would also be
      // satisfied by a gate that had stopped checking goal rows at all.
      const moved = store.transition(goalId, 'in-progress', { actor: PERSON });
      expect(moved.ok).toBe(true);
      expect(store.getGoalRow(goalId)?.status).toBe('in-progress');
      const done = store.transition(goalId, 'done', { actor: PERSON });
      expect(done.ok).toBe(true);
    });

    it('refuses a no-op move to triage, the same as any other status', () => {
      const wsId = ws();
      const res = store.setGoalList(wsId, [{ title: 'Ship the ranker' }], { actor: AGENT });
      if (!res.ok) throw new Error('goal list refused');
      const goalId = res.created[0]?.id as string;
      // Already in triage from the seed — so the shared `same-status` arm is
      // what answers, and the removal of the old refusal did not open a path
      // that writes a duplicate trail entry.
      const same = store.transition(goalId, 'triage', { actor: PERSON });
      expect(same.ok).toBe(false);
      if (same.ok) return;
      expect(same.error).toBe('same-status');
      expect(store.getGoalRow(goalId)?.transitions).toEqual([]);
    });

    it('leaves a TASK free to be sent back to triage', () => {
      // Unchanged by any of the above: the value was always legal on a task,
      // and widening it to goals must not have narrowed it here.
      const wsId = ws();
      const created = store.createTask(wsId, {
        title: 'Rebuild the ranker',
        assignee: PERSON.name,
        actor: PERSON,
      });
      if (!created.ok) throw new Error('create failed');
      expect(store.transition(created.task.id, 'triage', { actor: PERSON }).ok).toBe(true);
    });
  });

  describe('clearing it', () => {
    function triaged(wsId: string, title = 'Rebuild the ranker'): string {
      const res = store.createTask(wsId, { title, assignee: AGENT.name, actor: AGENT });
      if (!res.ok) throw new Error('create failed');
      expect(res.task.status).toBe('triage');
      return res.task.id;
    }

    it('records who moved it out, on the transition trail the gate already writes', () => {
      const wsId = ws();
      const id = triaged(wsId);
      const moved = store.transition(id, 'todo', { actor: PERSON, note: 'yes, worth doing' });
      expect(moved.ok).toBe(true);
      if (!moved.ok) return;
      expect(moved.task.status).toBe('todo');
      const entry = moved.task.transitions.at(-1);
      expect(entry?.from).toBe('triage');
      expect(entry?.to).toBe('todo');
      expect(entry?.by).toMatchObject({ name: 'Bryan', kind: 'person' });
      expect(entry?.note).toBe('yes, worth doing');
    });

    it('clears on a move to in-progress too — starting it IS vetting it', () => {
      const wsId = ws();
      const id = triaged(wsId);
      const moved = store.transition(id, 'in-progress', { actor: PERSON });
      expect(moved.ok).toBe(true);
      if (!moved.ok) return;
      expect(moved.task.status).toBe('in-progress');
      expect(moved.task.transitions.at(-1)?.from).toBe('triage');
    });

    it('accepts a move BACK to triage, so a mis-vetted row can be sent back', () => {
      const wsId = ws();
      const id = triaged(wsId);
      expect(store.transition(id, 'todo', { actor: PERSON }).ok).toBe(true);
      const back = store.transition(id, 'triage', { actor: PERSON, note: 'not yet' });
      expect(back.ok).toBe(true);
      if (!back.ok) return;
      expect(back.task.status).toBe('triage');
      // Never a forward move, so it is never blockable.
      expect(back.blockers).toEqual([]);
    });

    it('refuses a no-op move to the status the row already holds', () => {
      const wsId = ws();
      const id = triaged(wsId);
      const same = store.transition(id, 'triage', { actor: PERSON });
      expect(same.ok).toBe(false);
      if (same.ok) return;
      expect(same.error).toBe('same-status');
    });
  });

  describe('what reads it', () => {
    it('keeps triage rows out of the dispatch queue and leaves everything else in', () => {
      const wsId = ws();
      const filed = store.createTask(wsId, {
        title: 'Rebuild the ranker',
        assignee: AGENT.name,
        actor: AGENT,
      });
      const vetted = store.createTask(wsId, {
        title: 'Fix the crawler',
        assignee: PERSON.name,
        actor: PERSON,
      });
      if (!filed.ok || !vetted.ok) throw new Error('create failed');

      const queue = buildQueue(store.listTasks(wsId), store.getWorkspace(wsId)?.goals ?? []);
      expect(queue.map((r) => r.id)).toEqual([vetted.task.id]);

      // …and the moment it is vetted it is ordinary work again.
      store.transition(filed.task.id, 'todo', { actor: PERSON });
      const after = buildQueue(store.listTasks(wsId), store.getWorkspace(wsId)?.goals ?? []);
      expect(after.map((r) => r.id).sort()).toEqual([filed.task.id, vetted.task.id].sort());
    });

    it('keeps a triage row hard-blocked out even when blocked rows are asked for', () => {
      // `includeBlocked` widens the queue to rows a dependency holds back. It
      // must not widen it to rows nobody has vetted — that is a different
      // question, and answering both with one flag is how a triage row reaches
      // a dispatcher that asked to see its blocked work.
      const wsId = ws();
      const filed = store.createTask(wsId, {
        title: 'Rebuild the ranker',
        assignee: AGENT.name,
        actor: AGENT,
      });
      if (!filed.ok) throw new Error('create failed');
      const rows = buildQueue(store.listTasks(wsId), store.getWorkspace(wsId)?.goals ?? [], {
        includeBlocked: true,
      });
      expect(rows.map((r) => r.id)).toEqual([]);
    });

    it('still lists triage rows everywhere else — the board shows them in their band', () => {
      const wsId = ws();
      const filed = store.createTask(wsId, {
        title: 'Rebuild the ranker',
        assignee: AGENT.name,
        actor: AGENT,
      });
      if (!filed.ok) throw new Error('create failed');
      expect(store.listTasks(wsId).map((t) => t.id)).toContain(filed.task.id);
      expect(store.listTasks(wsId, { status: 'triage' }).map((t) => t.id)).toEqual([filed.task.id]);
    });

    it('counts a triage row as triage in the goal summary, never as done', () => {
      const wsId = ws();
      store.createTask(wsId, { title: 'Rebuild the ranker', assignee: AGENT.name, actor: AGENT });
      store.createTask(wsId, { title: 'Fix the crawler', assignee: PERSON.name, actor: PERSON });
      const rows = summarizeGoals(store.listTasks(wsId), store.getWorkspace(wsId)?.goals ?? []);
      const backlog = rows.find((r) => r.id === CHORES_GOAL_ID);
      expect(backlog).toBeDefined();
      expect(backlog?.triage).toBe(1);
      expect(backlog?.todo).toBe(1);
      expect(backlog?.done).toBe(0);
      expect(backlog?.inProgress).toBe(0);
    });
  });
});

/**
 * Over the route, because the route is where this was reachable from.
 *
 * The store cases above pin the gate; this pins that the gate is what the
 * shipped verb actually reaches. `POST /api/tasks/:id/transition` resolves a
 * goal id — that is by design and is why declaring a goal done needed no new
 * route — so it is also the door an old MCP bundle and a browser both come
 * through, and neither of them can be restarted to fix a hole here.
 */
describe('over the route a goal is already moved through', () => {
  let dir: string;
  let handle: ServerHandle;
  let base: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'triage-http-'));
    handle = createServer({ dataDir: dir, port: 0 });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const transition = (id: string, to: string) =>
    fetch(`${base}/api/tasks/${encodeURIComponent(id)}/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to, author: PERSON }),
    });

  it('200s a goal sent to triage, over the same route that moves it anywhere else', async () => {
    const store = handle.tasks;
    const wsId = store.createWorkspace('Board').id;
    const listed = store.setGoalList(wsId, [{ title: 'Ship the ranker' }], { actor: AGENT });
    if (!listed.ok) throw new Error('goal list refused');
    const goalId = listed.created[0]?.id as string;
    // Seeded goals arrive in triage; activate over the same route so the move
    // under test is a real transition and not the `same-status` refusal.
    expect((await transition(goalId, 'todo')).status).toBe(200);

    expect((await transition(goalId, 'triage')).status).toBe(200);
    expect(store.getGoalRow(goalId)?.status).toBe('triage');

    // POSITIVE CONTROL: the same route, the same goal, a different status —
    // so a 200 above cannot be a route that stopped reading `to` at all.
    expect((await transition(goalId, 'done')).status).toBe(200);
    expect(store.getGoalRow(goalId)?.status).toBe('done');
  });
});
