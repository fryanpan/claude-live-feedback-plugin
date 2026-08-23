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

    it('never puts a GOAL row in triage — goals are created by people, from the goal list', () => {
      const wsId = ws();
      const res = store.setGoalList(wsId, [{ title: 'Ship the ranker' }], { actor: AGENT });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const goalId = res.created[0]?.id as string;
      expect(store.getGoalRow(goalId)?.status).toBe('todo');
    });
  });

  /**
   * The create half of "a goal is never in triage" is above; this is the other
   * half, and it is the one that was actually reachable.
   *
   * The transition gate resolves a goal row as readily as a task (`findRow` —
   * that is what let a goal move through the existing route without a new
   * one), and it validates the target against the SHARED status set. So
   * nothing stopped `POST /api/tasks/:goalId/transition` with `to: 'triage'`,
   * and the invariant the tests above assert held only until somebody used the
   * verb the product already ships. Caught by an independent review pass, not
   * by these tests, because they only ever looked at creation.
   */
  describe('a goal row cannot be moved INTO triage', () => {
    function goal(wsId: string): string {
      const res = store.setGoalList(wsId, [{ title: 'Ship the ranker' }], { actor: AGENT });
      if (!res.ok) throw new Error('goal list refused');
      return res.created[0]?.id as string;
    }

    it('refuses the move and says why, without touching the row', () => {
      const wsId = ws();
      const goalId = goal(wsId);
      const res = store.transition(goalId, 'triage', { actor: PERSON });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toBe('goal-not-triageable');
      // A gate that only blocks is a dead end: the message has to name the
      // reason, the way every other refusal on this gate does.
      expect(res.message ?? '').toContain('Ship the ranker');
      expect(res.message ?? '').toMatch(/triage/i);
      // Nothing moved, and nothing was written to the trail.
      expect(store.getGoalRow(goalId)?.status).toBe('todo');
      expect(store.getGoalRow(goalId)?.transitions).toEqual([]);
    });

    it('still lets the goal move everywhere else — the refusal is narrow', () => {
      const wsId = ws();
      const goalId = goal(wsId);
      // POSITIVE CONTROL. Without it, "the move was refused" would also be
      // satisfied by a gate that had stopped moving goals at all.
      const moved = store.transition(goalId, 'in-progress', { actor: PERSON });
      expect(moved.ok).toBe(true);
      expect(store.getGoalRow(goalId)?.status).toBe('in-progress');
      const done = store.transition(goalId, 'done', { actor: PERSON });
      expect(done.ok).toBe(true);
    });

    it('leaves a TASK free to be sent back to triage', () => {
      // The other half of the same control: the refusal is about goal rows,
      // not about the value, so a task must still reach it.
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
      // Never a forward move, so it is never blockable and never `unproven`.
      expect(back.unproven).toBe(false);
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

  it('400s a goal sent to triage, and 200s the same goal sent anywhere else', async () => {
    const store = handle.tasks;
    const wsId = store.createWorkspace('Board').id;
    const listed = store.setGoalList(wsId, [{ title: 'Ship the ranker' }], { actor: AGENT });
    if (!listed.ok) throw new Error('goal list refused');
    const goalId = listed.created[0]?.id as string;

    const refused = await transition(goalId, 'triage');
    // 400 rather than 409: a 409 is the gate saying "not yet" about something
    // that could become true, and this never becomes true for a goal.
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { error: string; message?: string };
    expect(body.error).toBe('goal-not-triageable');
    expect(body.message ?? '').toContain('Ship the ranker');
    expect(store.getGoalRow(goalId)?.status).toBe('todo');

    // POSITIVE CONTROL: the same route, the same goal, a status it may hold.
    expect((await transition(goalId, 'done')).status).toBe(200);
    expect(store.getGoalRow(goalId)?.status).toBe('done');
  });
});
