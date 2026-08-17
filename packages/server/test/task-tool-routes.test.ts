/**
 * Routes added for the MCP tool surface (plan §3.10 / §3.12 commit 6):
 *
 *   POST /api/tasks/:id/goal          — set_task_goal (placement IS triage)
 *   POST /api/tasks/:id/answer        — answer_decision (verbatim text)
 *   PUT  /api/workspaces/:id/goals    — set_goal_list (ordered board sections)
 *   POST /api/docs/:docId/threads/:threadId/promote — promote_to_task
 *
 * The route layer hand-copies body fields and nothing type-checks it — a
 * field that isn't forwarded is silently discarded while the request still
 * returns 200 (the `groups` lesson). So EVERY parameter these routes accept
 * is asserted end-to-end: send it over HTTP, read the stored effect back.
 * Every absence assertion has a positive control beside it.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementAnchor, Thread, User } from '@feedback/core';

import { type ServerHandle, createServer } from '../src/server.ts';
import { workspaceRoomId } from '../src/task-projection.ts';
import type { Task, TaskStoreEvent } from '../src/tasks.ts';
import { type GoalIds, seedGoalsOverHttp } from './goal-seed.ts';

const PERSON: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
const AGENT: User = {
  id: 'agent-search-revamp',
  name: 'Search Revamp',
  kind: 'known',
  color: '#888888',
};

/** Clears the decision-shape gate, so a fixture about the answer route is not
 *  accidentally a test of the gate. */
const DECISION_BODY =
  'Ship now or wait for the index rebuild? Waiting costs a week and removes the stale-results risk. Blocked until answered: the launch note.';

const anchor: ElementAnchor = {
  kind: 'element',
  fingerprint: {
    tag: 'P',
    stableAttrs: {},
    classes: [],
    text: 'the ranking clause',
    path: 'P[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'the ranking clause' },
};

describe('task tool routes (plan §3.12 commit 6)', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let docSeq = 0;

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

  const put = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** A fresh hub workspace with a north-star goal + two board goals. The ids
   *  are minted by the server, so the bands come back keyed by the labels this
   *  file used to hard-code as ids (`g1`, `g1a`, `g2`). */
  async function seedWorkspace(): Promise<{ wsId: string; G: GoalIds }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship search v2.' }),
    );
    const G = await seedGoalsOverHttp(
      base,
      workspace.id,
      [
        {
          key: 'g1',
          title: '1. Get the PR out',
          subgoals: [{ key: 'g1a', title: 'Post-PR tickets' }],
        },
        { key: 'g2', title: '2. Blog post' },
      ],
      PERSON,
    );
    return { wsId: workspace.id, G };
  }

  async function seedTask(
    workspaceId: string,
    goal: string,
    opts: Record<string, unknown> = {},
  ): Promise<Task> {
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        author: AGENT,
        title: 'tune the ranking',
        goal,
        ...opts,
      }),
    );
    return task;
  }

  async function getTasks(workspaceId: string): Promise<Task[]> {
    const { tasks } = await jj<{ tasks: Task[] }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/tasks`),
    );
    return tasks;
  }

  /** A markdown doc with one PERSON-authored thread. */
  async function seedThread(): Promise<{ docId: string; threadId: string }> {
    const docId = `promote-${docSeq++}`;
    const file = join(dataDir, `${docId}.md`);
    writeFileSync(file, '# Doc\n\nthe ranking clause\n');
    await jj(await post('/api/docs', { docId, type: 'markdown', sourceUrl: file }));
    const { thread } = await jj<{ thread: Thread }>(
      await post(`/api/docs/${docId}/threads`, {
        author: PERSON,
        text: 'This ranking clause reads backwards — flip the priority order.',
        anchor,
      }),
    );
    return { docId, threadId: thread.id };
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-tools-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ── PUT /api/workspaces/:id/goals ─────────────────────────────────────────

  describe('PUT /api/workspaces/:id/goals', () => {
    it('forwards the goal list — subgoals and dueAt included — and GET reads it back', async () => {
      const { workspace } = await jj<{ workspace: { id: string } }>(
        await post('/api/workspaces', { name: 'goals-fwd', goal: 'North star.' }),
      );
      const goals = [
        {
          title: 'First',
          dueAt: 1765000000000,
          subgoals: [{ title: 'Sub one', dueAt: 1766000000000 }],
        },
        { title: 'Second' },
      ];
      const res = await jj<{
        ok: true;
        changed: boolean;
        created: Array<{ id: string; title: string; parent?: string }>;
      }>(await put(`/api/workspaces/${workspace.id}/goals`, { goals, author: PERSON }));
      expect(res.changed).toBe(true);
      // The ids come back from the server, in submission order: each entry,
      // then its subgoals.
      expect(res.created.map((c) => c.title)).toEqual(['First', 'Sub one', 'Second']);
      const [first, sub, second] = res.created.map((c) => c.id) as [string, string, string];
      expect(res.created[1]?.parent).toBe(first);

      const got = await jj<{ workspace: { goals: unknown } }>(
        await fetch(`${base}/api/workspaces/${workspace.id}`),
      );
      expect(got.workspace.goals).toEqual([
        {
          id: first,
          title: 'First',
          dueAt: 1765000000000,
          subgoals: [{ id: sub, title: 'Sub one', dueAt: 1766000000000 }],
        },
        { id: second, title: 'Second' },
      ]);
    });

    it('forwards the author into the goals_changed event (person and agent both classify)', async () => {
      const { workspace } = await jj<{ workspace: { id: string } }>(
        await post('/api/workspaces', { name: 'goals-author', goal: 'North star.' }),
      );
      const events: TaskStoreEvent[] = [];
      const off = handle.tasks.onEvent((e) => events.push(e));
      try {
        await jj(
          await put(`/api/workspaces/${workspace.id}/goals`, {
            goals: [{ title: 'Person set this' }],
            author: PERSON,
          }),
        );
        await jj(
          await put(`/api/workspaces/${workspace.id}/goals`, {
            goals: [{ title: 'Agent set this' }],
            author: AGENT,
          }),
        );
      } finally {
        off();
      }
      const changed = events.filter((e) => e.type === 'workspace.goals_changed');
      expect(changed.length).toBe(2);
      expect(changed[0]?.actor).toMatchObject({ name: 'Jordan', kind: 'person' });
      expect(changed[1]?.actor).toMatchObject({ name: 'Search Revamp', kind: 'agent' });
    });

    it('moves open tasks of a vanished goal to Chores and reports them', async () => {
      const { wsId, G } = await seedWorkspace();
      const task = await seedTask(wsId, G.g2);
      const res = await jj<{ movedToChores: string[] }>(
        await put(`/api/workspaces/${wsId}/goals`, {
          goals: [{ id: G.g1, title: '1. Get the PR out' }],
          drop: [G.g2],
          author: PERSON,
        }),
      );
      expect(res.movedToChores).toEqual([task.id]);
      const after = await getTasks(wsId);
      expect(after.find((t) => t.id === task.id)?.goal).toBe('chores');
    });

    it('rejects malformed lists, the reserved id, duplicates, a missing author, and an unknown workspace', async () => {
      const { wsId, G } = await seedWorkspace();
      // An id-less entry used to head this table as "malformed"; it is now the
      // CREATE path, so the structural case it stood for is an empty title.
      // The rows that share a 400 also assert WHICH refusal, since
      // `duplicate-goal-id` and `unknown-goal-id` are no longer told apart by
      // the status alone.
      const cases: Array<[string, unknown, number, string?]> = [
        [wsId, { goals: [{ title: '' }], author: PERSON }, 400],
        [wsId, { goals: 'not-a-list', author: PERSON }, 400],
        [
          wsId,
          { goals: [{ id: 'chores', title: 'Reserved' }], author: PERSON },
          400,
          'reserved-goal-id',
        ],
        [
          wsId,
          {
            goals: [
              { id: G.g1, title: 'One' },
              { id: G.g1, title: 'Two' },
            ],
            author: PERSON,
          },
          400,
          'duplicate-goal-id',
        ],
        [
          wsId,
          { goals: [{ id: 'g-not-on-this-board', title: 'Invented' }], author: PERSON },
          400,
          'unknown-goal-id',
        ],
        [wsId, { goals: [{ title: 'Fine' }] }, 400],
        ['w-missing', { goals: [{ title: 'Fine' }], author: PERSON }, 404],
      ];
      for (const [id, body, status, error] of cases) {
        const r = await put(`/api/workspaces/${id}/goals`, body);
        expect(r.status, JSON.stringify(body)).toBe(status);
        if (error) expect(((await r.json()) as { error: string }).error).toBe(error);
      }

      // Positive control for the inverted row: the same list with no `id` at
      // all is accepted, and the minted id comes back in `created`.
      const ok = await jj<{ created: Array<{ id: string; title: string }> }>(
        await put(`/api/workspaces/${wsId}/goals`, {
          goals: [{ title: 'Newly minted' }],
          author: PERSON,
        }),
      );
      expect(ok.created.map((c) => c.title)).toEqual(['Newly minted']);
      expect(ok.created[0]?.id).toMatch(/^g-[A-Za-z0-9_-]{12}$/);
    });
  });

  // ── POST /api/tasks/:id/goal ──────────────────────────────────────────────

  describe('POST /api/tasks/:id/goal', () => {
    it('forwards goal + position + riskTier + author; emits task.regrouped', async () => {
      const { wsId, G } = await seedWorkspace();
      const task = await seedTask(wsId, G.g1);
      const events: TaskStoreEvent[] = [];
      const off = handle.tasks.onEvent((e) => events.push(e));
      try {
        const res = await jj<{ task: Task; changed: boolean }>(
          await post(`/api/tasks/${task.id}/goal`, {
            goal: G.g2,
            position: 1.5,
            riskTier: 'yellow',
            author: AGENT,
          }),
        );
        expect(res.changed).toBe(true);
        expect(res.task.goal).toBe(G.g2);
        expect(res.task.order).toBe(1.5);
        expect(res.task.riskTier).toBe('yellow');
      } finally {
        off();
      }
      // Read the stored effect back over HTTP, not just the response echo.
      const stored = (await getTasks(wsId)).find((t) => t.id === task.id);
      expect(stored?.goal).toBe(G.g2);
      expect(stored?.order).toBe(1.5);
      expect(stored?.riskTier).toBe('yellow');

      const regrouped = events.filter((e) => e.type === 'task.regrouped');
      expect(regrouped.length).toBe(1);
      expect(regrouped[0]).toMatchObject({
        taskId: task.id,
        fromGoal: G.g1,
        toGoal: G.g2,
        order: 1.5,
        actor: { name: 'Search Revamp', kind: 'agent' },
      });
    });

    // The board's drag handle and its arrow-key twin post THIS route — no
    // ordering API of their own, because `order` was already fractional. So
    // the reorder gesture is only as real as this call is: a person as the
    // author (every case above sends an agent), a fractional position from
    // the midpoint of two neighbours, a position ABOVE the current top row
    // (which is `first.order - 1`, i.e. zero or negative), and `chores` —
    // reserved, absent from goals[], and a legitimate drop target on screen.
    it('carries the board reorder: a person, a fractional position, and a drop above the top row', async () => {
      const { wsId, G } = await seedWorkspace();
      const top = await seedTask(wsId, G.g1, { order: 1 });
      const bottom = await seedTask(wsId, G.g1, { order: 2 });
      const mover = await seedTask(wsId, G.g2, { order: 1 });

      // Dropped between the two g1 rows: the midpoint of their orders.
      const between = await jj<{ task: Task; changed: boolean }>(
        await post(`/api/tasks/${mover.id}/goal`, { goal: G.g1, position: 1.5, author: PERSON }),
      );
      expect(between.changed).toBe(true);
      expect(between.task.order).toBe(1.5);

      // …and dragged again to the very top, which is below the first order.
      const above = await jj<{ task: Task }>(
        await post(`/api/tasks/${mover.id}/goal`, { goal: G.g1, position: 0, author: PERSON }),
      );
      expect(above.task.order).toBe(0);

      // The stored ordering is what the board re-renders from, so assert the
      // relationship rather than the numbers: mover < top < bottom.
      const stored = await getTasks(wsId);
      const orderOf = (id: string) => stored.find((t) => t.id === id)?.order ?? Number.NaN;
      expect(orderOf(mover.id)).toBeLessThan(orderOf(top.id));
      expect(orderOf(top.id)).toBeLessThan(orderOf(bottom.id));

      // Chores is a section on the board like any other; dropping into it is
      // the same call with the reserved id.
      const chores = await jj<{ task: Task; changed: boolean }>(
        await post(`/api/tasks/${mover.id}/goal`, {
          goal: 'chores',
          position: 0.5,
          author: PERSON,
        }),
      );
      expect(chores.changed).toBe(true);
      expect(chores.task.goal).toBe('chores');
      expect(chores.task.order).toBe(0.5);
    });

    it('accepts a subgoal id as the target', async () => {
      const { wsId, G } = await seedWorkspace();
      const task = await seedTask(wsId, G.g1);
      const res = await jj<{ task: Task }>(
        await post(`/api/tasks/${task.id}/goal`, { goal: G.g1a, author: AGENT }),
      );
      expect(res.task.goal).toBe(G.g1a);
    });

    it('defaults the position to the bottom of the target goal', async () => {
      const { wsId, G } = await seedWorkspace();
      const existing = await seedTask(wsId, G.g2, { order: 7 });
      const task = await seedTask(wsId, G.g1);
      const res = await jj<{ task: Task }>(
        await post(`/api/tasks/${task.id}/goal`, { goal: G.g2, author: AGENT }),
      );
      expect(res.task.order).toBeGreaterThan(existing.order);
    });

    it('placement IS triage: stamps triagedAgainst with the goal text and clears the pending marker', async () => {
      const { wsId, G } = await seedWorkspace();
      // A live attachment makes the triage request deliverable, which is the
      // only path that stamps triagePendingTs (grounded-pending rule).
      await jj(
        await post(`/api/workspaces/${wsId}/attachments`, {
          agentId: 'agent-search-revamp',
          runtime: 'claude-code-local',
        }),
      );
      const { task } = await jj<{ task: Task }>(
        await post(`/api/workspaces/${wsId}/tasks`, {
          assignee: 'human',
          title: 'untriaged capture',
        }),
      );
      // Positive control: the marker IS set before placement.
      expect(task.triagePendingTs).toBeGreaterThan(0);
      expect(task.triagedAgainst).toBeUndefined();

      const res = await jj<{ task: Task }>(
        await post(`/api/tasks/${task.id}/goal`, { goal: G.g1, author: AGENT }),
      );
      expect(res.task.triagePendingTs).toBeUndefined();
      expect(res.task.triagedAgainst).toMatchObject({ goalId: G.g1, goal: 'Ship search v2.' });
      expect(res.task.triagedAgainst?.ts).toBeGreaterThan(0);
    });

    it('same goal + same position → changed:false and NO task.regrouped, but the triage stamp still lands', async () => {
      const { wsId, G } = await seedWorkspace();
      const task = await seedTask(wsId, G.g1);
      const events: TaskStoreEvent[] = [];
      const off = handle.tasks.onEvent((e) => events.push(e));
      try {
        // Positive control: a real move DOES reach this listener.
        await jj(await post(`/api/tasks/${task.id}/goal`, { goal: G.g2, author: AGENT }));
        expect(events.filter((e) => e.type === 'task.regrouped').length).toBe(1);
        // The no-op confirm: same goal, no position.
        const res = await jj<{ task: Task; changed: boolean }>(
          await post(`/api/tasks/${task.id}/goal`, { goal: G.g2, author: AGENT }),
        );
        expect(res.changed).toBe(false);
        expect(res.task.triagedAgainst?.goalId).toBe(G.g2);
        expect(events.filter((e) => e.type === 'task.regrouped').length).toBe(1);
      } finally {
        off();
      }
    });

    it('rejects an unknown goal id, an unknown task, a bad riskTier, and missing fields', async () => {
      const { wsId, G } = await seedWorkspace();
      const task = await seedTask(wsId, G.g1);
      expect(
        (await post(`/api/tasks/${task.id}/goal`, { goal: 'nope', author: AGENT })).status,
      ).toBe(400);
      expect((await post('/api/tasks/t-missing/goal', { goal: G.g1, author: AGENT })).status).toBe(
        404,
      );
      expect(
        (
          await post(`/api/tasks/${task.id}/goal`, {
            goal: G.g1,
            riskTier: 'purple',
            author: AGENT,
          })
        ).status,
      ).toBe(400);
      expect((await post(`/api/tasks/${task.id}/goal`, { author: AGENT })).status).toBe(400);
      expect((await post(`/api/tasks/${task.id}/goal`, { goal: G.g1 })).status).toBe(400);
    });
  });

  // ── POST /api/tasks/:id/assignee ──────────────────────────────────────────
  //
  // §3.6 lists `task.assigned`, and until this route existed nothing could
  // ever emit it: `assignee` was writable only at creation, so handing a task
  // between the human and the agent — the single most common move on a board
  // whose whole premise is that both work it — was unrepresentable. "The
  // store has it" was not even true here; there was no way in.

  describe('POST /api/tasks/:id/assignee', () => {
    it('forwards the assignee + author, emits task.assigned, and the projection follows', async () => {
      const { wsId, G } = await seedWorkspace();
      // Created BY the agent, so it starts owned by the agent — the route
      // below is what hands it to a person.
      const task = await seedTask(wsId, G.g1);
      expect(task.assignee).toBe(AGENT.name);
      const events: TaskStoreEvent[] = [];
      const off = handle.tasks.onEvent((e) => events.push(e));
      try {
        const res = await jj<{ ok: true; task: Task; changed: boolean }>(
          await post(`/api/tasks/${task.id}/assignee`, { assignee: 'human', author: PERSON }),
        );
        expect(res.changed).toBe(true);
        expect(res.task.assignee).toBe('human');
        // Read the STORED effect back, not just the response body.
        expect((await getTasks(wsId)).find((t) => t.id === task.id)?.assignee).toBe('human');

        const assigned = events.filter((e) => e.type === 'task.assigned');
        expect(assigned.length).toBe(1);
        const ev = assigned[0] as Extract<TaskStoreEvent, { type: 'task.assigned' }>;
        expect(ev.taskId).toBe(task.id);
        expect(ev.from).toBe(AGENT.name);
        expect(ev.to).toBe('human');
        expect(ev.actor).toEqual({ id: PERSON.id, name: PERSON.name, kind: 'person' });

        // The board room is what every browser and share visitor reads; a
        // store-only change would be invisible there (§3.3).
        const board = handle.rooms.get(workspaceRoomId(wsId));
        expect(board).toBeDefined(); // positive control: the room exists at all
        const projected = board?.ydoc.getMap('tasks').get(task.id) as
          | { assignee?: string; title?: string }
          | undefined;
        expect(projected?.title).toBe(task.title); // positive control
        expect(projected?.assignee).toBe('human');
      } finally {
        off();
      }
    });

    it('a re-assignment to the same name changes nothing and emits nothing', async () => {
      const { wsId, G } = await seedWorkspace();
      const task = await seedTask(wsId, G.g1, { assignee: 'human' });
      const events: TaskStoreEvent[] = [];
      const off = handle.tasks.onEvent((e) => events.push(e));
      try {
        // Positive control: a real change on this task DOES emit…
        const moved = await jj<{ changed: boolean }>(
          await post(`/api/tasks/${task.id}/assignee`, { assignee: AGENT.name, author: AGENT }),
        );
        expect(moved.changed).toBe(true);
        expect(events.filter((e) => e.type === 'task.assigned').length).toBe(1);
        // …and the no-op that follows does not.
        const same = await jj<{ changed: boolean }>(
          await post(`/api/tasks/${task.id}/assignee`, { assignee: AGENT.name, author: AGENT }),
        );
        expect(same.changed).toBe(false);
        expect(events.filter((e) => e.type === 'task.assigned').length).toBe(1);
      } finally {
        off();
      }
    });

    it('rejects an unknown task and the missing fields', async () => {
      const { wsId, G } = await seedWorkspace();
      const task = await seedTask(wsId, G.g1);
      expect(
        (await post('/api/tasks/t-missing/assignee', { assignee: 'human', author: PERSON })).status,
      ).toBe(404);
      expect((await post(`/api/tasks/${task.id}/assignee`, { author: PERSON })).status).toBe(400);
      expect((await post(`/api/tasks/${task.id}/assignee`, { assignee: 'human' })).status).toBe(
        400,
      );
      expect(
        (await post(`/api/tasks/${task.id}/assignee`, { assignee: '  ', author: PERSON })).status,
      ).toBe(400);
    });
  });

  // ── POST /api/tasks/:id/answer ────────────────────────────────────────────

  describe('POST /api/tasks/:id/answer', () => {
    it('forwards the verbatim text + author; the event carries the links checklist', async () => {
      const { wsId, G } = await seedWorkspace();
      const decision = await seedTask(wsId, G.g1, {
        title: 'ship now or wait for the index rebuild?',
        assignee: 'human',
        needs: 'decision',
        body: DECISION_BODY,
        links: [{ kind: 'doc', docId: 'plan-doc' }],
      });
      const events: TaskStoreEvent[] = [];
      const off = handle.tasks.onEvent((e) => events.push(e));
      try {
        const res = await jj<{ task: Task }>(
          await post(`/api/tasks/${decision.id}/answer`, {
            text: 'Ship now — the rebuild can trail.',
            author: PERSON,
          }),
        );
        expect(res.task.answer).toMatchObject({
          text: 'Ship now — the rebuild can trail.',
          by: 'Jordan',
        });
      } finally {
        off();
      }
      const answered = events.filter((e) => e.type === 'decision.answered');
      expect(answered.length).toBe(1);
      expect(answered[0]).toMatchObject({
        taskId: decision.id,
        answer: 'Ship now — the rebuild can trail.',
        actor: { name: 'Jordan', kind: 'person' },
        links: [{ kind: 'doc', docId: 'plan-doc' }],
      });
      // Stored effect, read back.
      const stored = (await getTasks(wsId)).find((t) => t.id === decision.id);
      expect(stored?.answer?.text).toBe('Ship now — the rebuild can trail.');
    });

    it('refuses a non-decision task (positive control above proves the happy path)', async () => {
      const { wsId, G } = await seedWorkspace();
      const plain = await seedTask(wsId, G.g1);
      const r = await post(`/api/tasks/${plain.id}/answer`, { text: 'nope', author: PERSON });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('not-a-decision');
    });

    it('404s an unknown task; 400s missing text or author', async () => {
      const { wsId, G } = await seedWorkspace();
      const decision = await seedTask(wsId, G.g1, {
        assignee: 'human',
        needs: 'decision',
        body: DECISION_BODY,
      });
      expect(
        (await post('/api/tasks/t-missing/answer', { text: 'x', author: PERSON })).status,
      ).toBe(404);
      expect((await post(`/api/tasks/${decision.id}/answer`, { author: PERSON })).status).toBe(400);
      expect((await post(`/api/tasks/${decision.id}/answer`, { text: 'x' })).status).toBe(400);
    });
  });

  // ── POST /api/docs/:docId/threads/:threadId/promote ───────────────────────

  describe('POST /api/docs/:docId/threads/:threadId/promote', () => {
    it('captures origin, quotes the latest HUMAN comment, drafts title+body, and backlinks the thread', async () => {
      const { wsId } = await seedWorkspace();
      const { docId, threadId } = await seedThread();
      // An agent reply lands AFTER the person's comment — the quote must
      // still be the person's words, not the most recent comment.
      await jj(
        await post(`/api/docs/${docId}/threads/${threadId}/comments`, {
          author: AGENT,
          text: 'On it — flipping the order now.',
        }),
      );
      const res = await jj<{ task: Task }>(
        await post(`/api/docs/${docId}/threads/${threadId}/promote`, {
          workspaceId: wsId,
          author: AGENT,
        }),
      );
      expect(res.task.origin).toEqual({ kind: 'thread', docId, threadId });
      expect(res.task.quote).toBe('This ranking clause reads backwards — flip the priority order.');
      expect(res.task.title.length).toBeGreaterThan(0);
      expect(res.task.title.length).toBeLessThanOrEqual(80);
      expect(res.task.body ?? '').toContain(
        'This ranking clause reads backwards — flip the priority order.',
      );
      // The origin ref is what the thread payload's chips resolve through.
      const got = await jj<{ thread: { tasks?: Array<{ id: string }> } }>(
        await fetch(`${base}/api/docs/${docId}/threads/${threadId}`),
      );
      expect(got.thread.tasks?.map((c) => c.id)).toEqual([res.task.id]);
    });

    it('forwards every explicit opt: title, assignee, needs, goal, body, dueAt, links', async () => {
      const { wsId, G } = await seedWorkspace();
      const { docId, threadId } = await seedThread();
      const res = await jj<{ task: Task }>(
        await post(`/api/docs/${docId}/threads/${threadId}/promote`, {
          workspaceId: wsId,
          title: 'Flip the ranking clause',
          assignee: 'human',
          needs: 'action',
          goal: G.g1a,
          body: 'Custom body wins over the draft.',
          dueAt: 1767000000000,
          links: [{ kind: 'doc', docId: 'related-doc' }],
        }),
      );
      expect(res.task.title).toBe('Flip the ranking clause');
      expect(res.task.assignee).toBe('human');
      expect(res.task.needs).toBe('action');
      expect(res.task.goal).toBe(G.g1a);
      expect(res.task.body).toBe('Custom body wins over the draft.');
      expect(res.task.dueAt).toBe(1767000000000);
      expect(res.task.links).toEqual([{ kind: 'doc', docId: 'related-doc' }]);
    });

    it('reports placement the same way the create routes do', async () => {
      // Promote is the third create path. An agent that learns to read
      // `placement` on two of three is being taught the field is unreliable —
      // and the goal semantics here are identical, so there is nothing to
      // justify the difference.
      const { wsId, G } = await seedWorkspace();
      const unplacedSeed = await seedThread();
      const unplaced = await jj<{
        placement: { placed: boolean; goals?: Array<{ id: string }> };
      }>(
        await post(`/api/docs/${unplacedSeed.docId}/threads/${unplacedSeed.threadId}/promote`, {
          workspaceId: wsId,
          author: AGENT,
        }),
      );
      expect(unplaced.placement.placed).toBe(false);
      expect((unplaced.placement.goals ?? []).length).toBeGreaterThan(0);

      // Positive control: the same call WITH a goal reports a placement and
      // drops the band list, so the assertions above measure something.
      const placedSeed = await seedThread();
      const placed = await jj<{ placement: { placed: boolean; goals?: unknown[] } }>(
        await post(`/api/docs/${placedSeed.docId}/threads/${placedSeed.threadId}/promote`, {
          workspaceId: wsId,
          author: AGENT,
          goal: G.g1,
        }),
      );
      expect(placed.placement.placed).toBe(true);
      expect(placed.placement.goals).toBeUndefined();
    });

    it('an omitted goal is a triage candidate; an explicit goal is a placement', async () => {
      const { wsId, G } = await seedWorkspace();
      await jj(
        await post(`/api/workspaces/${wsId}/attachments`, {
          agentId: 'agent-search-revamp',
          runtime: 'claude-code-local',
        }),
      );
      const a = await seedThread();
      const untriaged = await jj<{ task: Task }>(
        await post(`/api/docs/${a.docId}/threads/${a.threadId}/promote`, {
          workspaceId: wsId,
          author: AGENT,
        }),
      );
      expect(untriaged.task.goal).toBe('chores');
      expect(untriaged.task.triagePendingTs).toBeGreaterThan(0);

      const b = await seedThread();
      const placed = await jj<{ task: Task }>(
        await post(`/api/docs/${b.docId}/threads/${b.threadId}/promote`, {
          workspaceId: wsId,
          goal: G.g1,
          author: AGENT,
        }),
      );
      expect(placed.task.triagePendingTs).toBeUndefined();
    });

    it('404s an unknown thread, doc, or workspace; 400s a missing workspaceId', async () => {
      const { wsId } = await seedWorkspace();
      const { docId, threadId } = await seedThread();
      expect(
        (
          await post(`/api/docs/${docId}/threads/th-missing/promote`, {
            workspaceId: wsId,
            author: AGENT,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await post(`/api/docs/doc-missing/threads/${threadId}/promote`, {
            workspaceId: wsId,
            author: AGENT,
          })
        ).status,
      ).toBe(404);
      expect(
        (await post(`/api/docs/${docId}/threads/${threadId}/promote`, { workspaceId: 'w-missing' }))
          .status,
      ).toBe(404);
      expect((await post(`/api/docs/${docId}/threads/${threadId}/promote`, {})).status).toBe(400);
    });
  });

  // ── store-level: setTaskGoal ordering ─────────────────────────────────────

  describe('TaskStore.setTaskGoal ordering', () => {
    it('an empty target goal starts at order 1', async () => {
      const { wsId, G } = await seedWorkspace();
      const task = await seedTask(wsId, G.g1);
      const res = handle.tasks.setTaskGoal(task.id, G.g2, { actor: AGENT });
      expect(res.ok && res.task.order).toBe(1);
    });
  });
});
