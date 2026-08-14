/**
 * Every task on the board belongs to somebody, and the API is where that is
 * enforced — through the REAL routes, because the route layer hand-copies
 * body fields into the store call and is the one layer nothing type-checks.
 *
 * The store's old default was `assignee: opts.assignee ?? 'agent'`, so a
 * creation that named nobody produced a task owned by the generic word
 * "agent": indistinguishable from every other unowned task, and invisible to
 * `next_tasks?assignee=<me>`. The rule now: an identity is resolved from the
 * caller (its author) when the create doesn't name one, and a create that
 * still resolves to the generic value is refused.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { GENERIC_ASSIGNEE, resolveAssignee } from '../src/task-owner.ts';
import type { Task } from '../src/tasks.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known', color: '#888888' };

describe('resolveAssignee (pure)', () => {
  it('prefers an explicitly named assignee over the caller', () => {
    expect(resolveAssignee('Jordan', AGENT)).toBe('Jordan');
  });

  it('falls back to the caller when the create names nobody', () => {
    expect(resolveAssignee(undefined, AGENT)).toBe('Search Revamp');
    expect(resolveAssignee('   ', AGENT)).toBe('Search Revamp');
  });

  it('treats the generic word as naming nobody, whichever side it comes from', () => {
    expect(resolveAssignee(GENERIC_ASSIGNEE, AGENT)).toBe('Search Revamp');
    expect(resolveAssignee(GENERIC_ASSIGNEE, undefined)).toBeNull();
    expect(resolveAssignee(undefined, { name: GENERIC_ASSIGNEE })).toBeNull();
    expect(resolveAssignee(undefined, undefined)).toBeNull();
  });

  it("keeps 'human' — it says a person owns this, which is an answer", () => {
    expect(resolveAssignee('human', undefined)).toBe('human');
  });
});

describe('task creation records a real owner', () => {
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

  async function seedWorkspace(): Promise<string> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship search v2.' }),
    );
    return workspace.id;
  }
  async function getTasks(workspaceId: string): Promise<Task[]> {
    const { tasks } = await jj<{ tasks: Task[] }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/tasks`),
    );
    return tasks;
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-owner-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('POST /api/workspaces/<id>/tasks', () => {
    it('records the calling agent as the owner when the create names nobody', async () => {
      const wsId = await seedWorkspace();
      const { task } = await jj<{ task: Task }>(
        await post(`/api/workspaces/${wsId}/tasks`, { title: 'Rebuild the index', author: AGENT }),
      );
      // Read the stored effect back, not the response of the call that made it.
      const stored = (await getTasks(wsId)).find((t) => t.id === task.id);
      expect(stored?.assignee).toBe('Search Revamp');
    });

    it('lets an explicit assignee win over the caller', async () => {
      const wsId = await seedWorkspace();
      const { task } = await jj<{ task: Task }>(
        await post(`/api/workspaces/${wsId}/tasks`, {
          title: 'Write the launch note',
          assignee: 'Jordan',
          author: AGENT,
        }),
      );
      expect((await getTasks(wsId)).find((t) => t.id === task.id)?.assignee).toBe('Jordan');
    });

    it('refuses a create that names nobody and has no caller identity', async () => {
      const wsId = await seedWorkspace();
      const r = await post(`/api/workspaces/${wsId}/tasks`, { title: 'Nobody owns me' });
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: string; message?: string };
      expect(body.error).toBe('assignee-required');
      // The refusal has to say how to satisfy it, or it just blocks the caller.
      expect(body.message).toContain('FEEDBACK_AGENT_NAME');
      // …and nothing was created.
      expect((await getTasks(wsId)).some((t) => t.title === 'Nobody owns me')).toBe(false);
    });

    it('refuses the generic word itself — it is not an identity', async () => {
      const wsId = await seedWorkspace();
      const r = await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'Some agent, any agent',
        assignee: GENERIC_ASSIGNEE,
      });
      expect(r.status).toBe(400);
      // Positive control: the same create with a name lands, so the refusal is
      // the generic value and not a broken route.
      const ok = await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'Some agent, any agent',
        assignee: 'Search Revamp',
      });
      expect(ok.status).toBe(200);
    });
  });

  describe('promote (thread → task)', () => {
    async function seedThread(docId: string): Promise<string> {
      const file = join(dataDir, `${docId}.md`);
      writeFileSync(file, '# Doc\n\nthe ranking clause\n');
      await jj(await post('/api/docs', { docId, type: 'markdown', sourceUrl: file }));
      const { thread } = await jj<{ thread: { id: string } }>(
        await post(`/api/docs/${docId}/threads`, {
          author: PERSON,
          text: 'This should be a task.',
          anchor: {
            kind: 'element',
            fingerprint: { tag: 'P', classes: [], text: 'the ranking clause', index: 0 },
            snippet: { text: 'the ranking clause' },
          },
        }),
      );
      return thread.id;
    }

    it('records the promoter as the owner', async () => {
      const wsId = await seedWorkspace();
      const threadId = await seedThread('promote-owned');
      const { task } = await jj<{ task: Task }>(
        await post(`/api/docs/promote-owned/threads/${threadId}/promote`, {
          workspaceId: wsId,
          author: AGENT,
        }),
      );
      expect((await getTasks(wsId)).find((t) => t.id === task.id)?.assignee).toBe('Search Revamp');
    });

    it('refuses a promote with no owner and no promoter', async () => {
      const wsId = await seedWorkspace();
      const threadId = await seedThread('promote-unowned');
      const r = await post(`/api/docs/promote-unowned/threads/${threadId}/promote`, {
        workspaceId: wsId,
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('assignee-required');
    });
  });

  describe('import (tracker markdown)', () => {
    it('gives every row without an owner to the importer', async () => {
      const wsId = await seedWorkspace();
      const path = join(dataDir, 'tracker.md');
      writeFileSync(
        path,
        [
          '# Search revamp',
          '',
          '## Ship search v2.',
          '',
          '| Task                  | Status | Owner  |',
          '| --------------------- | ------ | ------ |',
          '| Rebuild the index     | todo   |        |',
          '| Write the launch note | todo   | Jordan |',
          '',
        ].join('\n'),
      );
      await jj(
        await post(`/api/workspaces/${wsId}/import-tasks`, { path, apply: true, author: AGENT }),
      );
      const tasks = await getTasks(wsId);
      expect(tasks.find((t) => t.title === 'Rebuild the index')?.assignee).toBe('Search Revamp');
      // Positive control: a row that DOES name an owner keeps it.
      expect(tasks.find((t) => t.title === 'Write the launch note')?.assignee).toBe('Jordan');
    });

    it('refuses the whole import when the importer itself is anonymous', async () => {
      const wsId = await seedWorkspace();
      const path = join(dataDir, 'anon-tracker.md');
      writeFileSync(
        path,
        [
          '# Search revamp',
          '',
          '## Ship search v2.',
          '',
          '| Task              | Status |',
          '| ----------------- | ------ |',
          '| Rebuild the index | todo   |',
          '',
        ].join('\n'),
      );
      const anon = { id: 'known-agent', name: GENERIC_ASSIGNEE, kind: 'known' };
      const r = await post(`/api/workspaces/${wsId}/import-tasks`, {
        path,
        apply: true,
        author: anon,
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('assignee-required');
      // Nothing landed — an import is all-or-nothing on this gate.
      expect(await getTasks(wsId)).toHaveLength(0);
      // The dry run is still allowed: it creates nothing, so refusing it would
      // only hide the mapping from someone about to fix their launch env.
      const dry = await post(`/api/workspaces/${wsId}/import-tasks`, { path, author: anon });
      expect(dry.status).toBe(200);
      // Positive control: a named importer applies the same file.
      const named = await post(`/api/workspaces/${wsId}/import-tasks`, {
        path,
        apply: true,
        author: AGENT,
      });
      expect(named.status).toBe(200);
    });

    it('lets an anonymous importer through when every row names its own owner', async () => {
      const wsId = await seedWorkspace();
      const path = join(dataDir, 'owned-tracker.md');
      writeFileSync(
        path,
        [
          '# Search revamp',
          '',
          '## Ship search v2.',
          '',
          '| Task                  | Status | Owner  |',
          '| --------------------- | ------ | ------ |',
          '| Rebuild the index     | todo   | Jordan |',
          '| Write the launch note | todo   | human  |',
          '',
        ].join('\n'),
      );
      const r = await post(`/api/workspaces/${wsId}/import-tasks`, {
        path,
        apply: true,
        author: { id: 'known-agent', name: GENERIC_ASSIGNEE, kind: 'known' },
      });
      // The importer's own name is only ever a fallback — nothing needed it.
      expect(r.status).toBe(200);
      const tasks = await getTasks(wsId);
      expect(tasks.find((t) => t.title === 'Rebuild the index')?.assignee).toBe('Jordan');
      expect(tasks.find((t) => t.title === 'Write the launch note')?.assignee).toBe('human');
    });
  });
});
