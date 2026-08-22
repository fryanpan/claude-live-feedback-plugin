/**
 * Archiving a task — the SOFT delete, and the only removal a board offers.
 *
 * The project rule is that user content is never hard-deleted, and a task had
 * no reversible removal at all: the row either stayed on the board forever or
 * a caller destroyed it. Archiving is the third answer. Three fields land on
 * the row (`archivedAt` / `archivedBy` / `archiveReason`), the id survives, the
 * task's body room and its comment threads keep resolving, and nothing moves
 * on disk — so `unarchive` is a field clear rather than a restore from
 * anywhere.
 *
 * Two contracts under test, and the second is the one that can rot quietly:
 *
 *  - the store's own verbs (fields, events, idempotence, the reason cap);
 *  - the LISTING narrowing, asserted in BOTH directions everywhere it applies.
 *    A hidden-by-default filter that also hides an unarchived row is a board
 *    that has lost work, and it would pass every test that only ever checked
 *    the hiding half.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { TaskStore, type TaskStoreEvent, eventsLogPath } from '../src/tasks.ts';
import type { Task } from '../src/tasks.ts';

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known', color: '#888888' };

function readAudit(dataDir: string, workspaceId: string): Array<Record<string, unknown>> {
  const path = eventsLogPath(dataDir, workspaceId);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('archiving a task (store)', () => {
  let dataDir: string;
  let store: TaskStore;
  let events: TaskStoreEvent[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-archive-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    events = [];
    store.onEvent((e) => events.push(e));
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function seed(title = 'Wire the index'): { wsId: string; task: Task } {
    const ws = store.createWorkspace('search-revamp');
    const res = store.createTask(ws.id, { title });
    if (!res.ok) throw new Error('create failed');
    events.length = 0;
    return { wsId: ws.id, task: res.task };
  }

  it('stamps the three fields and leaves the row where it was', () => {
    const { task } = seed();
    const res = store.archiveTask(task.id, { actor: PERSON, reason: 'duplicate of the index row' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(true);
    expect(res.task.archivedAt).toBeGreaterThan(0);
    expect(res.task.archivedBy).toBe('Bryan');
    expect(res.task.archiveReason).toBe('duplicate of the index row');
    // Nothing about the row MOVED. Archiving is not a status and not a
    // regroup — the whole point is that a restore has nothing to undo.
    expect(res.task.status).toBe(task.status);
    expect(res.task.goal).toBe(task.goal);
    expect(res.task.order).toBe(task.order);
    // And the id still resolves, which is what keeps links and the task's
    // body room working while it is archived.
    expect(store.getTask(task.id)?.id).toBe(task.id);
  });

  it('emits task.archived with who and why, and appends it to the audit log', () => {
    const { wsId, task } = seed();
    store.archiveTask(task.id, { actor: PERSON, reason: 'not doing this' });
    expect(events).toHaveLength(1);
    const e = events[0];
    if (e?.type !== 'task.archived') throw new Error(`expected task.archived, got ${e?.type}`);
    expect(e.taskId).toBe(task.id);
    expect(e.workspaceId).toBe(wsId);
    expect(e.reason).toBe('not doing this');
    expect(e.actor.name).toBe('Bryan');
    expect(e.actor.kind).toBe('person');
    const audit = readAudit(dataDir, wsId).filter((r) => r.event === 'task.archived');
    expect(audit).toHaveLength(1);
    expect(audit[0]?.reason).toBe('not doing this');
  });

  it('unarchive clears all three fields and emits task.restored', () => {
    const { task } = seed();
    store.archiveTask(task.id, { actor: AGENT, reason: 'obsolete' });
    events.length = 0;
    const res = store.unarchiveTask(task.id, { actor: PERSON });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(true);
    expect(res.task.archivedAt).toBeUndefined();
    expect(res.task.archivedBy).toBeUndefined();
    expect(res.task.archiveReason).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('task.restored');
  });

  it('re-archiving an archived row changes nothing and emits nothing', () => {
    const { task } = seed();
    const first = store.archiveTask(task.id, { actor: PERSON });
    expect(first.ok && first.changed).toBe(true);
    events.length = 0;
    const again = store.archiveTask(task.id, { actor: PERSON });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.changed).toBe(false);
    expect(events).toHaveLength(0);
    // Positive control: the same listener sees the restore.
    expect(store.unarchiveTask(task.id, { actor: PERSON }).ok).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('restoring a row that was never archived emits nothing', () => {
    const { task } = seed();
    const res = store.unarchiveTask(task.id, { actor: PERSON });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changed).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('404s an unknown task on both verbs', () => {
    seed();
    expect(store.archiveTask('t-nope', { actor: PERSON }).ok).toBe(false);
    expect(store.unarchiveTask('t-nope', { actor: PERSON }).ok).toBe(false);
  });

  it('caps and trims the reason, and drops an empty one entirely', () => {
    const { task } = seed();
    const long = 'x'.repeat(400);
    store.archiveTask(task.id, { actor: PERSON, reason: `  ${long}  ` });
    expect(store.getTask(task.id)?.archiveReason?.length).toBe(200);
    store.unarchiveTask(task.id, { actor: PERSON });
    store.archiveTask(task.id, { actor: PERSON, reason: '   ' });
    expect(store.getTask(task.id)?.archiveReason).toBeUndefined();
  });

  describe('listTasks narrowing — both directions', () => {
    it('hides an archived row by default and shows it with includeArchived', () => {
      const { wsId, task } = seed();
      const other = store.createTask(wsId, { title: 'Cut page weight' });
      if (!other.ok) throw new Error('create failed');
      store.archiveTask(task.id, { actor: PERSON });

      const visible = store.listTasks(wsId).map((t) => t.id);
      expect(visible).not.toContain(task.id);
      // Positive control: the OTHER row is still listed, so the filter is
      // narrowing rather than emptying.
      expect(visible).toContain(other.task.id);

      const all = store.listTasks(wsId, { includeArchived: true }).map((t) => t.id);
      expect(all).toContain(task.id);
      expect(all).toContain(other.task.id);
    });

    it('a restored row comes back to the default listing', () => {
      const { wsId, task } = seed();
      store.archiveTask(task.id, { actor: PERSON });
      expect(store.listTasks(wsId).map((t) => t.id)).not.toContain(task.id);
      store.unarchiveTask(task.id, { actor: PERSON });
      expect(store.listTasks(wsId).map((t) => t.id)).toContain(task.id);
    });

    it('an archived row leaves the untriaged sweep', () => {
      const ws = store.createWorkspace('search-revamp');
      const res = store.createTask(ws.id, { title: 'Nobody has placed this' });
      if (!res.ok) throw new Error('create failed');
      expect(store.listUntriaged(ws.id).map((t) => t.id)).toContain(res.task.id);
      store.archiveTask(res.task.id, { actor: PERSON });
      expect(store.listUntriaged(ws.id).map((t) => t.id)).not.toContain(res.task.id);
    });

    it('survives a restart — the fields are on the sidecar, not in memory', () => {
      const { wsId, task } = seed();
      store.archiveTask(task.id, { actor: PERSON, reason: 'duplicate' });
      store.stop();
      const reopened = new TaskStore({ dataDir, debounceMs: 5 });
      try {
        expect(reopened.getTask(task.id)?.archivedAt).toBeGreaterThan(0);
        expect(reopened.getTask(task.id)?.archiveReason).toBe('duplicate');
        expect(reopened.listTasks(wsId).map((t) => t.id)).not.toContain(task.id);
        expect(reopened.listTasks(wsId, { includeArchived: true }).map((t) => t.id)).toContain(
          task.id,
        );
      } finally {
        reopened.stop();
      }
    });
  });
});

describe('archive + restore routes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsId: string;

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

  const makeTask = async (title: string): Promise<Task> => {
    const r = await post(`/api/workspaces/${wsId}/tasks`, { author: AGENT, title });
    return ((await r.json()) as { task: Task }).task;
  };

  const listIds = async (query = ''): Promise<string[]> => {
    const r = await local(`/api/workspaces/${wsId}/tasks${query}`);
    const { tasks } = (await r.json()) as { tasks: Task[] };
    return tasks.map((t) => t.id);
  };

  const nextIds = async (query = ''): Promise<string[]> => {
    const r = await local(`/api/workspaces/${wsId}/next${query}`);
    const { tasks } = (await r.json()) as { tasks: Array<{ id: string }> };
    return tasks.map((t) => t.id);
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-archive-routes-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const r = await post('/api/workspaces', { name: 'search-revamp' });
    wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('400s without an author on both routes', async () => {
    const task = await makeTask('Needs an author');
    expect((await post(`/api/tasks/${task.id}/archive`, { reason: 'x' })).status).toBe(400);
    expect((await post(`/api/tasks/${task.id}/restore`, {})).status).toBe(400);
    // Positive control: with an author the same call lands.
    expect((await post(`/api/tasks/${task.id}/archive`, { author: PERSON })).status).toBe(200);
  });

  it('404s an unknown task', async () => {
    expect((await post('/api/tasks/t-nope/archive', { author: PERSON })).status).toBe(404);
    expect((await post('/api/tasks/t-nope/restore', { author: PERSON })).status).toBe(404);
  });

  it('archives with a reason and reads the stamps back', async () => {
    const task = await makeTask('Archive me');
    const r = await post(`/api/tasks/${task.id}/archive`, {
      author: PERSON,
      reason: 'duplicate of the index row',
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { task: Task; changed: boolean };
    expect(body.changed).toBe(true);
    expect(body.task.archivedBy).toBe('Bryan');
    expect(body.task.archiveReason).toBe('duplicate of the index row');
    expect(body.task.archivedAt).toBeGreaterThan(0);
  });

  it('drops the row from the task list and from the queue, both directions', async () => {
    const gone = await makeTask('Archive this one');
    const kept = await makeTask('Keep this one');
    await post(`/api/tasks/${gone.id}/archive`, { author: PERSON });

    const listed = await listIds();
    expect(listed).not.toContain(gone.id);
    expect(listed).toContain(kept.id); // positive control

    const queued = await nextIds();
    expect(queued).not.toContain(gone.id);
    expect(queued).toContain(kept.id); // positive control

    // …and the flag reaches both, so the narrowing stays undoable by a caller.
    expect(await listIds('?includeArchived=true')).toContain(gone.id);
    expect(await nextIds('?includeArchived=true')).toContain(gone.id);

    // Restore, and it is back in both without the flag.
    const back = await post(`/api/tasks/${gone.id}/restore`, { author: PERSON });
    expect(back.status).toBe(200);
    const restored = (await back.json()) as { task: Task };
    expect(restored.task.archivedAt).toBeUndefined();
    expect(restored.task.archivedBy).toBeUndefined();
    expect(await listIds()).toContain(gone.id);
    expect(await nextIds()).toContain(gone.id);
  });

  it('an archived row keeps its body doc and its threads resolving', async () => {
    const task = await makeTask('Still readable');
    await post(`/api/tasks/${task.id}/archive`, { author: PERSON, reason: 'obsolete' });
    // The task's own body room — the surface every comment thread hangs off.
    const doc = await local(`/api/docs/task:${task.id}`);
    expect(doc.status).toBe(200);
  });
});
