/**
 * Hub workspace + task routes, driven through the real route table.
 *
 * The route layer hand-copies body fields and nothing type-checks it — a
 * field that isn't forwarded is silently discarded while the request still
 * returns 200 (the `groups` lesson). So every parameter these routes accept
 * is asserted end-to-end here: send it over HTTP, read the stored effect
 * back over HTTP.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task, TaskStoreEvent, TriageRequest } from '../src/tasks.ts';

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known', color: '#888888' };

describe('hub workspace + task routes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let folder: string;
  let base: string;

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

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'taskr-data-'));
    folder = mkdtempSync(join(tmpdir(), 'taskr-folder-'));
    writeFileSync(join(folder, 'README.md'), '# Entry\n\nRead me.\n');
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    for (const d of [dataDir, folder]) rmSync(d, { recursive: true, force: true });
  });

  describe('POST /api/workspaces (hub create)', () => {
    it('creates a hub workspace from name + goal and GET reads it back', async () => {
      const r = await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship the search.' });
      expect(r.status).toBe(200);
      const { workspace } = (await r.json()) as {
        workspace: { id: string; name: string; goal: string };
      };
      expect(workspace.name).toBe('search-revamp');
      expect(workspace.goal).toBe('Ship the search.');
      expect(workspace.id.length).toBeGreaterThanOrEqual(10);

      const got = await local(`/api/workspaces/${workspace.id}`);
      expect(got.status).toBe(200);
      const body = (await got.json()) as { workspace: { name: string; goal: string } };
      expect(body.workspace.name).toBe('search-revamp');
      expect(body.workspace.goal).toBe('Ship the search.');
    });

    it('still binds a folder when folderPath is given (the legacy shape is untouched)', async () => {
      const r = await post('/api/workspaces', { folderPath: folder });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { workspaceId: string };
      expect(body.workspaceId.length).toBeGreaterThan(0);
    });

    it('400s when neither name nor folderPath is present', async () => {
      const r = await post('/api/workspaces', {});
      expect(r.status).toBe(400);
    });

    it('404s a GET for an unknown workspace id', async () => {
      const r = await local('/api/workspaces/w-nope');
      expect(r.status).toBe(404);
    });
  });

  describe('POST /api/workspaces/:id/docs (attach_doc)', () => {
    it('attaches an existing doc; the workspace lists it; nothing is migrated', async () => {
      const mdPath = join(dataDir, 'plan.md');
      writeFileSync(mdPath, '# Plan\n\nBody.\n');
      await post('/api/docs', { docId: 'hub-plan-doc', type: 'markdown', sourceUrl: mdPath });

      const ws = (await (await post('/api/workspaces', { name: 'attach-ws' })).json()) as {
        workspace: { id: string };
      };
      const r = await post(`/api/workspaces/${ws.workspace.id}/docs`, { docId: 'hub-plan-doc' });
      expect(r.status).toBe(200);

      const got = (await (await local(`/api/workspaces/${ws.workspace.id}`)).json()) as {
        workspace: { docIds: string[] };
      };
      expect(got.workspace.docIds).toEqual(['hub-plan-doc']);
      // The doc itself keeps working at its current URL — no migration.
      const doc = await local('/api/docs/hub-plan-doc');
      expect(doc.status).toBe(200);
      const meta = (await doc.json()) as { meta: { workspaceId?: string } };
      expect(meta.meta.workspaceId).toBeUndefined();
    });

    it('attaches an existing review (legacy grouping workspace) by its id', async () => {
      const bind = await post('/api/workspaces', { folderPath: folder });
      const reviewId = ((await bind.json()) as { workspaceId: string }).workspaceId;
      const ws = (await (await post('/api/workspaces', { name: 'attach-review-ws' })).json()) as {
        workspace: { id: string };
      };
      const r = await post(`/api/workspaces/${ws.workspace.id}/docs`, { docId: reviewId });
      expect(r.status).toBe(200);
    });

    it('404s an unknown doc and an unknown workspace', async () => {
      const ws = (await (await post('/api/workspaces', { name: 'attach-404-ws' })).json()) as {
        workspace: { id: string };
      };
      const noDoc = await post(`/api/workspaces/${ws.workspace.id}/docs`, { docId: 'no-such' });
      expect(noDoc.status).toBe(404);
      const noWs = await post('/api/workspaces/w-nope/docs', { docId: 'hub-plan-doc' });
      expect(noWs.status).toBe(404);
    });

    it('400s a missing docId', async () => {
      const ws = (await (await post('/api/workspaces', { name: 'attach-400-ws' })).json()) as {
        workspace: { id: string };
      };
      const r = await post(`/api/workspaces/${ws.workspace.id}/docs`, {});
      expect(r.status).toBe(400);
    });
  });

  describe('task create + list routes', () => {
    let wsId: string;

    beforeAll(async () => {
      const r = await post('/api/workspaces', { name: 'task-ws', goal: 'Ship.' });
      wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
    });

    it('forwards EVERY create param through the route (the groups lesson)', async () => {
      const r = await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'Pick the palette',
        assignee: 'human',
        needs: 'decision',
        quote: 'which of these two?',
        links: [{ kind: 'doc', docId: 'hub-plan-doc' }],
        origin: { kind: 'thread', docId: 'hub-plan-doc', threadId: 'th-1' },
        dueAt: 1770000000000,
        body: 'Two candidates attached.',
        order: 7,
      });
      expect(r.status).toBe(200);
      const { task } = (await r.json()) as { task: Task };
      expect(task.title).toBe('Pick the palette');
      expect(task.assignee).toBe('human');
      expect(task.needs).toBe('decision');
      expect(task.quote).toBe('which of these two?');
      expect(task.links).toEqual([{ kind: 'doc', docId: 'hub-plan-doc' }]);
      expect(task.origin).toEqual({ kind: 'thread', docId: 'hub-plan-doc', threadId: 'th-1' });
      expect(task.dueAt).toBe(1770000000000);
      expect(task.body).toBe('Two candidates attached.');
      expect(task.order).toBe(7);

      // Read the stored effect back through the OTHER route, not the response.
      const listed = (await (await local(`/api/workspaces/${wsId}/tasks`)).json()) as {
        tasks: Task[];
      };
      const stored = listed.tasks.find((t) => t.id === task.id);
      expect(stored?.quote).toBe('which of these two?');
      expect(stored?.needs).toBe('decision');
      expect(stored?.dueAt).toBe(1770000000000);
    });

    it('forwards after + afterEnforce (proved by the transition refusing)', async () => {
      const gate = (await (
        await post(`/api/workspaces/${wsId}/tasks`, { title: 'your go', needs: 'decision' })
      ).json()) as { task: Task };
      const work = (await (
        await post(`/api/workspaces/${wsId}/tasks`, {
          title: 'Open the PR',
          after: [gate.task.id],
          afterEnforce: [gate.task.id],
        })
      ).json()) as { task: Task };

      const refused = await post(`/api/tasks/${work.task.id}/transition`, {
        to: 'in-progress',
        author: AGENT,
      });
      expect(refused.status).toBe(409);
      const body = (await refused.json()) as {
        error: string;
        blockers: Array<{ taskId: string; enforce: boolean; message: string }>;
      };
      expect(body.error).toBe('blocked');
      expect(body.blockers[0]?.taskId).toBe(gate.task.id);
      expect(body.blockers[0]?.enforce).toBe(true);

      // Positive control: complete the gate and the same call succeeds.
      await post(`/api/tasks/${gate.task.id}/transition`, { to: 'done', author: PERSON });
      const allowed = await post(`/api/tasks/${work.task.id}/transition`, {
        to: 'in-progress',
        author: AGENT,
      });
      expect(allowed.status).toBe(200);
    });

    it('filters the list by status via query params', async () => {
      const r = await local(`/api/workspaces/${wsId}/tasks?status=done`);
      expect(r.status).toBe(200);
      const { tasks } = (await r.json()) as { tasks: Task[] };
      expect(tasks.length).toBeGreaterThan(0);
      for (const t of tasks) expect(t.status).toBe('done');
    });

    it('400s a missing title and 404s an unknown workspace', async () => {
      const noTitle = await post(`/api/workspaces/${wsId}/tasks`, {});
      expect(noTitle.status).toBe(400);
      const noWs = await post('/api/workspaces/w-nope/tasks', { title: 'x' });
      expect(noWs.status).toBe(404);
    });
  });

  describe('POST /api/tasks/:id/transition', () => {
    let wsId: string;

    beforeAll(async () => {
      const r = await post('/api/workspaces', { name: 'transition-ws' });
      wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
    });

    const mkTask = async (title: string): Promise<Task> => {
      const r = await post(`/api/workspaces/${wsId}/tasks`, { title });
      return ((await r.json()) as { task: Task }).task;
    };

    it('attributes the actor through the route: person vs agent', async () => {
      const t = await mkTask('attributed');
      const r = await post(`/api/tasks/${t.id}/transition`, {
        to: 'in-progress',
        author: PERSON,
        note: 'kicking off',
      });
      expect(r.status).toBe(200);
      const { task } = (await r.json()) as { task: Task };
      expect(task.transitions[0]?.by).toEqual({
        id: 'known-bryan',
        name: 'Bryan',
        kind: 'person',
      });
      expect(task.transitions[0]?.note).toBe('kicking off');

      const r2 = await post(`/api/tasks/${t.id}/transition`, { to: 'done', author: AGENT });
      const done = ((await r2.json()) as { task: Task }).task;
      expect(done.transitions[1]?.by.kind).toBe('agent');
    });

    it('stamps evidence + usage through the route and reads back via list', async () => {
      const t = await mkTask('evidenced');
      const r = await post(`/api/tasks/${t.id}/transition`, {
        to: 'done',
        author: AGENT,
        evidence: {
          commit: 'abc1234',
          threadRef: { kind: 'thread', docId: 'hub-plan-doc', threadId: 'th-2' },
        },
        usage: { inputTokens: 900, outputTokens: 120 },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { task: Task; unproven: boolean };
      expect(body.unproven).toBe(false);

      const listed = (await (await local(`/api/workspaces/${wsId}/tasks`)).json()) as {
        tasks: Task[];
      };
      const stored = listed.tasks.find((x) => x.id === t.id);
      expect(stored?.transitions[0]?.evidence?.commit).toBe('abc1234');
      expect(stored?.transitions[0]?.evidence?.threadRef).toEqual({
        kind: 'thread',
        docId: 'hub-plan-doc',
        threadId: 'th-2',
      });
      expect(stored?.transitions[0]?.usage).toEqual({ inputTokens: 900, outputTokens: 120 });
    });

    it('flags an evidence-less done as unproven but still applies it', async () => {
      const t = await mkTask('unproven');
      const r = await post(`/api/tasks/${t.id}/transition`, { to: 'done', author: AGENT });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { task: Task; unproven: boolean };
      expect(body.unproven).toBe(true);
      expect(body.task.status).toBe('done');
    });

    it('400s a bad target status, 400s a missing author, 404s an unknown task', async () => {
      const t = await mkTask('errors');
      const bad = await post(`/api/tasks/${t.id}/transition`, { to: 'held', author: AGENT });
      expect(bad.status).toBe(400);
      const noAuthor = await post(`/api/tasks/${t.id}/transition`, { to: 'done' });
      expect(noAuthor.status).toBe(400);
      const missing = await post('/api/tasks/t-ghost/transition', { to: 'done', author: AGENT });
      expect(missing.status).toBe(404);
    });
  });

  describe('PUT /api/workspaces/:id/goal', () => {
    let wsId: string;

    beforeAll(async () => {
      const r = await post('/api/workspaces', { name: 'goal-ws', goal: 'Original goal.' });
      wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
    });

    const put = (path: string, body: unknown) =>
      local(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('forwards goal + author through the route: the goal changes and the event carries the attributed actor', async () => {
      const events: TaskStoreEvent[] = [];
      const off = handle.tasks.onEvent((e) => events.push(e));
      try {
        const r = await put(`/api/workspaces/${wsId}/goal`, {
          goal: 'Revised goal.',
          author: PERSON,
        });
        expect(r.status).toBe(200);
        const body = (await r.json()) as {
          workspace: { goal: string };
          changed: boolean;
          retriage: { requested: boolean; taskIds: string[] };
        };
        expect(body.changed).toBe(true);
        expect(body.workspace.goal).toBe('Revised goal.');
        expect(body.retriage.requested).toBe(false); // no live attachment here

        // Read the stored effect back over HTTP (the groups lesson).
        const got = await local(`/api/workspaces/${wsId}`);
        const stored = (await got.json()) as { workspace: { goal: string } };
        expect(stored.workspace.goal).toBe('Revised goal.');

        // The author param was forwarded, not dropped: the emitted event
        // names the actor and classifies them.
        expect(events).toHaveLength(1);
        const e = events[0];
        // Narrow the union — the assertion is the same, the throw carries it.
        if (e?.type !== 'workspace.goal_updated') {
          throw new Error(`expected workspace.goal_updated, got ${e?.type}`);
        }
        expect(e.actor).toEqual({ id: 'known-bryan', name: 'Bryan', kind: 'person' });
        expect(e.oldGoal).toBe('Original goal.');
        expect(e.newGoal).toBe('Revised goal.');
      } finally {
        off();
      }
    });

    it('a goal edit through the route reaches a live attachment as a re-triage of open tasks', async () => {
      const tr = await post(`/api/workspaces/${wsId}/tasks`, { title: 'open task' });
      const task = ((await tr.json()) as { task: Task }).task;

      const requests: TriageRequest[] = [];
      handle.tasks.setTriageDelivery((req) => {
        requests.push(req);
        return true;
      });
      try {
        const r = await put(`/api/workspaces/${wsId}/goal`, {
          goal: 'Re-triage everything.',
          author: PERSON,
        });
        expect(r.status).toBe(200);
        const body = (await r.json()) as { retriage: { requested: boolean; taskIds: string[] } };
        expect(body.retriage.requested).toBe(true);
        expect(body.retriage.taskIds).toContain(task.id);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.kind).toBe('goal-retriage');
      } finally {
        handle.tasks.setTriageDelivery(undefined);
      }
    });

    it('400s a missing goal, 400s a missing author, 404s an unknown workspace', async () => {
      const noGoal = await put(`/api/workspaces/${wsId}/goal`, { author: PERSON });
      expect(noGoal.status).toBe(400);
      const noAuthor = await put(`/api/workspaces/${wsId}/goal`, { goal: 'x' });
      expect(noAuthor.status).toBe(400);
      const noWs = await put('/api/workspaces/w-nope/goal', { goal: 'x', author: PERSON });
      expect(noWs.status).toBe(404);
    });
  });

  describe('persistence through the server handle', () => {
    it('a created workspace survives into a fresh server on the same dataDir', async () => {
      const r = await post('/api/workspaces', { name: 'durable-ws', goal: 'Persist.' });
      const wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
      await post(`/api/workspaces/${wsId}/tasks`, { title: 'survives' });
      handle.tasks.flush();

      const second = createServer({ port: 0, dataDir });
      try {
        const got = await fetch(`http://localhost:${second.port}/api/workspaces/${wsId}/tasks`, {
          headers: { host: `localhost:${second.port}` },
        });
        expect(got.status).toBe(200);
        const { tasks } = (await got.json()) as { tasks: Task[] };
        expect(tasks.map((t) => t.title)).toEqual(['survives']);
      } finally {
        await second.stop();
      }
    });
  });
});
