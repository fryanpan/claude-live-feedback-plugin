/**
 * Cross-reference model (plan §3.2 Ref, §3.12 commit 4).
 *
 * Links are STORED on the task (`links: Ref[]` + `origin`); backlinks are
 * COMPUTED, never stored — so they can't drift. Thread→task and doc→task
 * surfacing decorates the existing doc/thread payloads with the §3.3
 * rule-2 chip shape (id, title, status, assignee — visitor-safe by design).
 *
 * Route tests go through the real HTTP routes (the groups lesson: the route
 * layer hand-copies fields and nothing type-checks it). Every absence
 * assertion has a positive control beside it.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementAnchor, User } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type Ref, type Task, TaskStore, taskChip } from '../src/tasks.ts';

const PERSON: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };

const fakeAnchor: ElementAnchor = {
  kind: 'element',
  fingerprint: {
    tag: 'BUTTON',
    stableAttrs: {},
    classes: [],
    text: 'Go',
    path: 'BUTTON[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'Go' },
};

describe('TaskStore cross-references (unit)', () => {
  let dataDir: string;
  let store: TaskStore;
  let wsId: string;

  const mkTask = (title: string, opts: Partial<Parameters<TaskStore['createTask']>[1]> = {}) => {
    const res = store.createTask(wsId, { title, goal: 'chores', ...opts });
    if (!res.ok) throw new Error(`createTask failed: ${res.error}`);
    return res.task;
  };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'xref-store-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    wsId = store.createWorkspace('xref-ws').id;
  });

  afterAll(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('linkRef / unlinkRef', () => {
    it('adds a ref, bumps updatedAt, and is idempotent on a duplicate', () => {
      const t = mkTask('linker');
      const before = t.updatedAt;
      const ref: Ref = { kind: 'doc', docId: 'spec-doc' };

      const added = store.linkRef(t.id, ref);
      if (!added.ok) throw new Error(added.error);
      expect(added.changed).toBe(true);
      expect(added.task.links).toEqual([ref]);
      expect(added.task.updatedAt).toBeGreaterThanOrEqual(before);

      const again = store.linkRef(t.id, { kind: 'doc', docId: 'spec-doc' });
      if (!again.ok) throw new Error(again.error);
      expect(again.changed).toBe(false);
      expect(again.task.links).toHaveLength(1);
    });

    it('removes a ref and reports changed:false for one that was never there', () => {
      const t = mkTask('unlinker', { links: [{ kind: 'doc', docId: 'a' }] });
      const removed = store.unlinkRef(t.id, { kind: 'doc', docId: 'a' });
      if (!removed.ok) throw new Error(removed.error);
      expect(removed.changed).toBe(true);
      expect(removed.task.links).toEqual([]);

      const absent = store.unlinkRef(t.id, { kind: 'doc', docId: 'a' });
      if (!absent.ok) throw new Error(absent.error);
      expect(absent.changed).toBe(false);
    });

    it('refuses a structurally bad ref, a self-ref, and an unknown task', () => {
      const t = mkTask('validator');
      expect(store.linkRef(t.id, { kind: 'doc' } as unknown as Ref)).toEqual({
        ok: false,
        error: 'bad-ref',
      });
      expect(store.linkRef(t.id, { kind: 'nope', docId: 'x' } as unknown as Ref)).toEqual({
        ok: false,
        error: 'bad-ref',
      });
      expect(store.linkRef(t.id, { kind: 'task', taskId: t.id })).toEqual({
        ok: false,
        error: 'self-ref',
      });
      expect(store.linkRef('t-ghost', { kind: 'doc', docId: 'x' })).toEqual({
        ok: false,
        error: 'not-found',
      });
      expect(store.unlinkRef('t-ghost', { kind: 'doc', docId: 'x' })).toEqual({
        ok: false,
        error: 'not-found',
      });
    });

    it('two threads refs differing only in threadId are distinct links', () => {
      const t = mkTask('two-threads');
      store.linkRef(t.id, { kind: 'thread', docId: 'd', threadId: 'th-1' });
      const second = store.linkRef(t.id, { kind: 'thread', docId: 'd', threadId: 'th-2' });
      if (!second.ok) throw new Error(second.error);
      expect(second.task.links).toHaveLength(2);
    });
  });

  describe('computed backlinks', () => {
    it('finds tasks referencing a task via links AND via origin — and only those', () => {
      const target = mkTask('the target');
      const viaLink = mkTask('links to target', {
        links: [{ kind: 'task', taskId: target.id }],
      });
      const viaOrigin = mkTask('promoted from target', {
        origin: { kind: 'task', taskId: target.id },
      });
      const bystander = mkTask('unrelated');

      const back = store.backlinksFor({ kind: 'task', taskId: target.id });
      const ids = back.map((t) => t.id);
      // Positive control first: both referencers are found…
      expect(ids).toContain(viaLink.id);
      expect(ids).toContain(viaOrigin.id);
      // …so the absence below is a real absence, not a broken probe.
      expect(ids).not.toContain(bystander.id);
      expect(ids).not.toContain(target.id);
    });

    it('doc-level surfacing includes thread refs INTO that doc; thread-level is exact', () => {
      const viaDoc = mkTask('cites the doc', { links: [{ kind: 'doc', docId: 'review-doc' }] });
      const viaThread = mkTask('born from a thread', {
        origin: { kind: 'thread', docId: 'review-doc', threadId: 'th-9' },
      });
      const otherDoc = mkTask('cites another doc', {
        links: [{ kind: 'doc', docId: 'other-doc' }],
      });

      const docRefs = store.tasksReferencingDoc('review-doc').map((t) => t.id);
      expect(docRefs).toContain(viaDoc.id);
      expect(docRefs).toContain(viaThread.id); // a thread ref IS about its doc
      expect(docRefs).not.toContain(otherDoc.id);

      const threadRefs = store.tasksReferencingThread('review-doc', 'th-9').map((t) => t.id);
      expect(threadRefs).toContain(viaThread.id); // positive control
      expect(threadRefs).not.toContain(viaDoc.id); // doc ref ≠ this thread
      const otherThread = store.tasksReferencingThread('review-doc', 'th-other');
      expect(otherThread).toHaveLength(0);
    });
  });

  describe('taskChip', () => {
    it('is EXACTLY the §3.3 rule-2 shape — id, title, status, assignee, nothing else', () => {
      const t = mkTask('chip me', { quote: 'private-ish words', body: 'long body' });
      expect(taskChip(t)).toEqual({
        id: t.id,
        title: 'chip me',
        status: 'todo',
        assignee: 'agent',
      });
    });
  });
});

describe('cross-reference routes + payload surfacing', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsId: string;
  /**
   * The MINTED id of the doc the caller asked to call `xref-notes`.
   *
   * A `Ref` addresses a doc, so it carries the address rather than the
   * readable name — two spellings of one doc must not surface as two docs.
   * The alias still routes: every `/api/docs/xref-notes/...` fetch below
   * reaches this same room.
   */
  let notesId: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const send = (method: string) => (path: string, body: unknown) =>
    local(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const post = send('POST');
  const del = send('DELETE');

  const mkTask = async (opts: Record<string, unknown>): Promise<Task> => {
    const r = await post(`/api/workspaces/${wsId}/tasks`, { assignee: 'human', ...opts });
    expect(r.status).toBe(200);
    return ((await r.json()) as { task: Task }).task;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'xref-routes-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const r = await post('/api/workspaces', { name: 'xref-route-ws', goal: 'Ship.' });
    wsId = ((await r.json()) as { workspace: { id: string } }).workspace.id;
    const mdPath = join(dataDir, 'notes.md');
    writeFileSync(mdPath, '# Notes\n\nBody.\n');
    const doc = await post('/api/docs', {
      docId: 'xref-notes',
      type: 'markdown',
      sourceUrl: mdPath,
    });
    notesId = ((await doc.json()) as { docId: string }).docId;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('POST/DELETE/GET /api/tasks/:id/links', () => {
    it('forwards the ref through the route and the stored effect is readable back', async () => {
      const t = await mkTask({ title: 'route linker' });
      const r = await post(`/api/tasks/${t.id}/links`, {
        ref: { kind: 'doc', docId: 'xref-notes' },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { ok: boolean; task: Task };
      expect(body.task.links).toEqual([{ kind: 'doc', docId: 'xref-notes' }]);

      // Read the stored effect back through the OTHER route (groups lesson).
      const listed = (await (await local(`/api/workspaces/${wsId}/tasks`)).json()) as {
        tasks: Task[];
      };
      expect(listed.tasks.find((x) => x.id === t.id)?.links).toEqual([
        { kind: 'doc', docId: 'xref-notes' },
      ]);
    });

    it('GET returns stored links plus COMPUTED backlink chips', async () => {
      const target = await mkTask({ title: 'link target' });
      const referrer = await mkTask({
        title: 'refers to target',
        links: [{ kind: 'task', taskId: target.id }],
      });

      const r = await local(`/api/tasks/${target.id}/links`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        taskId: string;
        links: Ref[];
        backlinks: Array<{ id: string; title: string; status: string; assignee: string }>;
      };
      expect(body.taskId).toBe(target.id);
      expect(body.backlinks).toEqual([
        { id: referrer.id, title: 'refers to target', status: 'todo', assignee: 'human' },
      ]);
    });

    it('DELETE unlinks (positive control: the link was there first)', async () => {
      const t = await mkTask({ title: 'route unlinker', links: [{ kind: 'doc', docId: 'a' }] });
      const before = (await (await local(`/api/tasks/${t.id}/links`)).json()) as { links: Ref[] };
      expect(before.links).toHaveLength(1); // positive control

      const r = await del(`/api/tasks/${t.id}/links`, { ref: { kind: 'doc', docId: 'a' } });
      expect(r.status).toBe(200);
      const after = (await (await local(`/api/tasks/${t.id}/links`)).json()) as { links: Ref[] };
      expect(after.links).toHaveLength(0);
    });

    it('400s a missing ref, 400s a bad ref, 404s an unknown task', async () => {
      const t = await mkTask({ title: 'route errors' });
      expect((await post(`/api/tasks/${t.id}/links`, {})).status).toBe(400);
      expect((await post(`/api/tasks/${t.id}/links`, { ref: { kind: 'doc' } })).status).toBe(400);
      expect(
        (await post('/api/tasks/t-ghost/links', { ref: { kind: 'doc', docId: 'x' } })).status,
      ).toBe(404);
      expect((await local('/api/tasks/t-ghost/links')).status).toBe(404);
    });

    it('a link change lands in the ws board room projection (no store event exists for it)', async () => {
      const t = await mkTask({ title: 'projected links' });
      await post(`/api/tasks/${t.id}/links`, { ref: { kind: 'doc', docId: 'xref-notes' } });

      const room = handle.rooms.get(`ws:${wsId}`);
      if (!room) throw new Error('ws room missing');
      const projected = room.ydoc.getMap('tasks').get(t.id) as { links?: Ref[] } | undefined;
      expect(projected?.links).toEqual([{ kind: 'doc', docId: 'xref-notes' }]);
    });
  });

  describe('doc→task surfacing in the doc payload', () => {
    it('GET /api/docs/:id carries chips for referencing tasks; an unreferenced doc has none', async () => {
      const t = await mkTask({
        title: 'about the notes doc',
        links: [{ kind: 'doc', docId: notesId }],
      });

      // Fetched through the readable ALIAS; the payload answers under the
      // minted id, and the chip surfaces because the two are one doc.
      const r = await local('/api/docs/xref-notes');
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        meta: { docId: string };
        tasks?: Array<{ id: string; title: string; status: string; assignee: string }>;
      };
      expect(body.meta.docId).toBe(notesId);
      // Positive control: the referenced doc surfaces the chip…
      expect(body.tasks?.some((c) => c.id === t.id && c.title === 'about the notes doc')).toBe(
        true,
      );

      // …so the untouched doc's missing field is a real absence.
      const otherPath = join(dataDir, 'other.md');
      writeFileSync(otherPath, '# Other\n');
      await post('/api/docs', { docId: 'xref-other', type: 'markdown', sourceUrl: otherPath });
      const clean = (await (await local('/api/docs/xref-other')).json()) as {
        tasks?: unknown;
      };
      expect(clean.tasks).toBeUndefined();
    });
  });

  describe('thread→task surfacing in thread payloads', () => {
    let threadId: string;
    let otherThreadId: string;
    let promoted: Task;

    beforeAll(async () => {
      const mk = async (text: string) => {
        const r = await post('/api/docs/xref-notes/threads', {
          author: PERSON,
          text,
          anchor: fakeAnchor,
        });
        expect(r.status).toBe(200);
        return ((await r.json()) as { thread: { id: string } }).thread.id;
      };
      threadId = await mk('promote this');
      otherThreadId = await mk('leave this one');
      promoted = await mkTask({
        title: 'promoted from thread',
        origin: { kind: 'thread', docId: notesId, threadId },
        quote: 'promote this',
      });
    });

    it('the threads list decorates the referenced thread — and ONLY it', async () => {
      const r = await local('/api/docs/xref-notes/threads');
      const { threads } = (await r.json()) as {
        threads: Array<{ id: string; tasks?: Array<{ id: string }> }>;
      };
      const decorated = threads.find((t) => t.id === threadId);
      const clean = threads.find((t) => t.id === otherThreadId);
      // Positive control first…
      expect(decorated?.tasks?.map((c) => c.id)).toEqual([promoted.id]);
      // …then the absence means something.
      expect(clean?.tasks).toBeUndefined();
    });

    it('the single-thread payload carries the same chips', async () => {
      const r = await local(`/api/docs/xref-notes/threads/${encodeURIComponent(threadId)}`);
      const { thread } = (await r.json()) as {
        thread: { tasks?: Array<{ id: string; status: string }> };
      };
      expect(thread.tasks?.[0]?.id).toBe(promoted.id);
      expect(thread.tasks?.[0]?.status).toBe('todo');
    });
  });
});
