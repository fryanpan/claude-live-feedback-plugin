/**
 * A task body is a live Yjs room (`task:<taskId>`), so the generic doc
 * mutation routes can reach it by docId convention — skipping the write-once
 * `quote` preservation and the `task.body_edited` audit row that
 * `update_task_body` runs. That made a rewrite through `set_doc_content`
 * destroy the original capture with nothing preserved and nothing recorded,
 * while every surface reported success.
 *
 * EVERY refusal here is paired with a positive control in the same file:
 * `update_task_body` still preserves and still emits, threads still work on
 * the same doc, and `set_doc_content` still works on an ordinary doc. Without
 * those, "the route said no" would be indistinguishable from "the fixture was
 * broken" — and a guard that refuses everything would pass a refusal-only
 * suite.
 *
 * All fixtures synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';

const AGENT = { id: 'agent-probe', name: 'Probe Agent', kind: 'known', color: '#888888' };
const CAPTURE = 'the exact words somebody captured, which must survive a rewrite';
const REWRITE = 'a completely different description that replaces the capture';

describe('task body docs refuse programmatic whole-body rewrites', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let workspaceId: string;

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

  /** Create one synthetic task whose body IS the captured utterance. */
  const newTask = async (title: string): Promise<string> => {
    const r = await post(`/api/workspaces/${workspaceId}/tasks/batch`, {
      tasks: [{ title, body: CAPTURE, assignee: AGENT.name }],
      author: AGENT,
    });
    const { tasks } = (await r.json()) as { tasks: Task[] };
    return tasks[0]!.id;
  };

  const readTask = async (taskId: string): Promise<Task> => {
    const r = await local(`/api/workspaces/${workspaceId}/tasks`);
    const { tasks } = (await r.json()) as { tasks: Task[] };
    return tasks.find((t) => t.id === taskId)!;
  };

  /** The durable audit log the activity feed renders from. */
  const bodyEditedCount = (taskId: string): number => {
    const file = join(dataDir, 'workspaces', `${workspaceId}.events.jsonl`);
    if (!existsSync(file)) return 0;
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { event?: string; taskId?: string })
      .filter((e) => e.event === 'task.body_edited' && e.taskId === taskId).length;
  };

  /** The projection snapshot is debounced; wait for the body to settle. */
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 1200));
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'taskbody-data-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    const r = await post('/api/workspaces', { name: 'guard-probe', author: AGENT });
    const { workspace } = (await r.json()) as { workspace: { id: string } };
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses set_doc_content on a task body doc and names update_task_body', async () => {
    const taskId = await newTask('row-set-doc-content');
    const r = await post(`/api/docs/task:${taskId}/content`, { markdown: REWRITE });

    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string; message: string; taskId: string };
    expect(body.error).toBe('task-body-doc');
    // The refusal has to name the way out, or it just moves the dead end.
    expect(body.message).toContain('update_task_body');
    expect(body.taskId).toBe(taskId);

    // And it wrote nothing: the capture is still there.
    await settle();
    const task = await readTask(taskId);
    expect(task.body?.trim()).toBe(CAPTURE);
  });

  it('refuses the block-deletion routes, which could empty a body outright', async () => {
    const taskId = await newTask('row-delete-blocks');
    const r = await post(`/api/docs/task:${taskId}/delete_blocks_in_range`, {
      startFind: 'the exact words',
      endFind: 'a rewrite',
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toBe('task-body-doc');

    await settle();
    const task = await readTask(taskId);
    // `update_task_body` refuses an empty body outright; this route reached
    // the same end state through the side door before the guard existed.
    expect(task.body?.trim()).toBe(CAPTURE);
  });

  it('refuses resolve_all, whose accept half rewrites the doc from the request body', async () => {
    // The guard runs before any route reads a body, so `action: 'accept'` and
    // `action: 'reject'` are the same string to it. Refusing both is the only
    // call it can make from where it stands.
    const taskId = await newTask('row-resolve-all');
    for (const action of ['accept', 'reject'] as const) {
      const r = await post(`/api/docs/task:${taskId}/suggestions/resolve_all`, { action });
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toBe('task-body-doc');
    }
    await settle();
    expect((await readTask(taskId)).body?.trim()).toBe(CAPTURE);
  });

  it('refuses POST /api/docs for a task body docId, which would bind it to a file', async () => {
    // A different route entirely — above the doc-route block the guard sits
    // in — and it reaches the same room: `attachFile` would seed an empty body
    // from a file on disk and wire write-back both ways.
    const taskId = await newTask('row-create-doc');
    const file = join(dataDir, 'hijack.md');
    writeFileSync(file, '# Not this task\n\nContent from somewhere else.\n');

    const r = await post('/api/docs', {
      docId: `task:${taskId}`,
      type: 'markdown',
      sourceUrl: file,
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string; message: string; taskId: string };
    expect(body.error).toBe('task-body-doc');
    expect(body.message).toContain('update_task_body');
    expect(body.taskId).toBe(taskId);

    await settle();
    const task = await readTask(taskId);
    expect(task.body?.trim()).toBe(CAPTURE);
    expect(task.body).not.toContain('somewhere else');
  });

  it('still allows DELETE of the body ROOM, which does not cost the captured words', async () => {
    // The most destructive-looking call here is deliberately untouched: the
    // description lives in the task store, not in the room, so deleting the
    // room costs its comment threads and nothing else. Guarding it would have
    // broken the documented recreate-a-missing-body-room recovery for a
    // preservation problem it does not have.
    const taskId = await newTask('row-delete-doc');
    const r = await local(`/api/docs/task:${taskId}`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    // The words are still there, which is the whole reason this stays open.
    expect((await readTask(taskId)).body?.trim()).toBe(CAPTURE);
  });

  // ── Positive controls ────────────────────────────────────────────────
  //
  // Everything above asserts an absence. These prove the fixture can produce
  // the presence, on the same doc kind, in the same run.

  it('POSITIVE CONTROL: update_task_body still preserves the capture and emits', async () => {
    const taskId = await newTask('row-update-task-body');
    const before = await readTask(taskId);
    expect(before.quote).toBeUndefined();

    const r = await post(`/api/tasks/${taskId}/body`, { markdown: REWRITE, author: AGENT });
    expect(r.status).toBe(200);

    await settle();
    const task = await readTask(taskId);
    expect(task.body?.trim()).toBe(REWRITE);
    // The words that were there are held somewhere.
    expect(task.quote).toBe(CAPTURE);
    expect(bodyEditedCount(taskId)).toBe(1);
  });

  it('POSITIVE CONTROL: threads still work on a task body doc', async () => {
    const taskId = await newTask('row-threads-still-work');
    const r = await post(`/api/docs/task:${taskId}/threads`, {
      author: AGENT,
      text: 'discussing this task, which is what a task body doc is for',
      // A whole-doc thread, which is exactly how a task is discussed.
      anchor: { kind: 'subject' },
    });
    expect(r.status).toBe(200);
    const { thread } = (await r.json()) as { thread: { id: string } };
    expect(thread.id.length).toBeGreaterThan(0);
  });

  it('POSITIVE CONTROL: an orphaned comment on a task body can still be re-anchored', async () => {
    // The guard's message promises comments and anchors are unaffected. A
    // comment whose anchor broke is repaired through this route and no other,
    // so refusing it would make the promise false in exactly the case that
    // matters — the one where somebody already lost their place.
    const taskId = await newTask('row-reanchor');
    const created = await post(`/api/docs/task:${taskId}/threads`, {
      author: AGENT,
      text: 'a comment whose anchor will need repairing',
      anchor: { kind: 'subject' },
    });
    expect(created.status).toBe(200);
    const { thread } = (await created.json()) as { thread: { id: string } };

    const r = await post(`/api/docs/task:${taskId}/threads/${thread.id}/reanchor`, {
      anchor: { kind: 'subject' },
    });
    expect(r.status).toBe(200);
  });

  it('POSITIVE CONTROL: set_doc_content still works on an ordinary doc', async () => {
    // Every markdown doc is file-backed, so the doc has to have a file.
    const file = join(dataDir, 'ordinary.md');
    writeFileSync(file, '# Heading\n\nOriginal body.\n');
    const created = await post('/api/docs', {
      docId: 'ordinary-doc',
      type: 'markdown',
      sourceUrl: file,
    });
    expect(created.status).toBe(200);

    const r = await post('/api/docs/ordinary-doc/content', {
      markdown: '# Heading\n\nRewritten body.\n',
    });
    // The guard is scoped to `task:` docs; an ordinary doc must be untouched
    // by it. This is what stops "refuse everything" from passing the suite.
    expect(r.status).toBe(200);
  });
});
