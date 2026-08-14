/**
 * POST /api/tasks/:id/body — rewrite a task's description after creation.
 *
 * The reported bug ("a task body is immutable, PATCH and PUT both 404") is
 * half true: the body is a live `task:<id>` doc room, so `set_doc_content`
 * on that docId already rewrote it. What was missing is everything AROUND
 * that — a named route an agent can find, the body room existing on a
 * workspace nobody has touched since the last restart, a snapshot the caller
 * can read back immediately, and an attributed row in the audit log. Each of
 * those is asserted here, because each of them failing looks like "the
 * rewrite didn't work" from the outside.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listThreads, prose } from '@feedback/core';
import type { User } from '@feedback/core';

import { type ServerHandle, createServer } from '../src/server.ts';
import { taskBodyDocId } from '../src/task-projection.ts';
import type { Task, TaskStoreEvent } from '../src/tasks.ts';

const PERSON: User = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
const AGENT: User = {
  id: 'agent-search-revamp',
  name: 'Search Revamp',
  kind: 'known',
  color: '#888888',
};

describe('POST /api/tasks/:id/body', () => {
  let handle: ServerHandle | undefined;
  let dataDir: string | undefined;
  let base = '';

  const start = async (dir: string): Promise<ServerHandle> => {
    const h = await createServer({ port: 0, dataDir: dir });
    base = `http://127.0.0.1:${h.port}`;
    return h;
  };

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

  /** A workspace with one task carrying a deliberately thin body. */
  async function seed(opts: { body?: string } = {}): Promise<{ workspaceId: string; task: Task }> {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-task-body-'));
    handle = await start(dataDir);
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship search v2.' }),
    );
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${workspace.id}/tasks`, {
        author: AGENT,
        title: 'tune the ranking',
        goal: 'chores',
        body: opts.body ?? 'thin.',
      }),
    );
    return { workspaceId: workspace.id, task };
  }

  /** A task filed with no body at all — the thin task this feature is for. */
  async function seedBodyless(): Promise<{ workspaceId: string; task: Task }> {
    dataDir = mkdtempSync(join(tmpdir(), 'lf-task-body-'));
    handle = await start(dataDir);
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship search v2.' }),
    );
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${workspace.id}/tasks`, {
        author: AGENT,
        title: 'filed in a hurry',
        goal: 'chores',
      }),
    );
    return { workspaceId: workspace.id, task };
  }

  const readTask = async (workspaceId: string, taskId: string): Promise<Task> => {
    const { tasks } = await jj<{ tasks: Task[] }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/tasks`),
    );
    const found = tasks.find((t) => t.id === taskId);
    expect(found).toBeDefined();
    return found as Task;
  };

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it('rewrites the body and the caller can read it back immediately', async () => {
    const { workspaceId, task } = await seed();
    // Positive control: the thin body is what's there before the rewrite.
    expect((await readTask(workspaceId, task.id)).body).toContain('thin.');

    const markdown = '## Why\n\nThe ranking clause is stale.\n\nDone when: it is not.';
    await jj(await post(`/api/tasks/${task.id}/body`, { markdown, author: AGENT }));

    // Read back with no delay — the snapshot the board and next_tasks serve
    // is debounced, so a route that only nudges it would hand the caller the
    // pre-rewrite body and read as a failed write.
    expect((await readTask(workspaceId, task.id)).body).toContain('The ranking clause is stale.');

    // ...and the live doc room, which is what a reader on the board sees.
    const doc = await jj<{ plainText: string }>(
      await fetch(`${base}/api/docs/${encodeURIComponent(taskBodyDocId(task.id))}/content`),
    );
    expect(doc.plainText).toContain('Done when: it is not.');
    expect(doc.plainText).not.toContain('thin.');
  });

  it('records who rewrote it', async () => {
    const { task } = await seed();
    const events: TaskStoreEvent[] = [];
    const off = handle?.tasks.onEvent((e) => events.push(e));
    try {
      await jj(await post(`/api/tasks/${task.id}/body`, { markdown: 'rewritten.', author: AGENT }));
    } finally {
      off?.();
    }
    const row = events.find((e) => e.type === 'task.body_edited');
    expect(row).toBeDefined();
    expect(row?.taskId).toBe(task.id);
    expect(row?.actor.name).toBe('Search Revamp');
    expect(row?.actor.kind).toBe('agent');
  });

  it('classifies a person the same way every other mutation does', async () => {
    const { task } = await seed();
    const events: TaskStoreEvent[] = [];
    const off = handle?.tasks.onEvent((e) => events.push(e));
    try {
      await jj(
        await post(`/api/tasks/${task.id}/body`, {
          markdown: 'a person wrote this.',
          author: PERSON,
        }),
      );
    } finally {
      off?.();
    }
    expect(events.find((e) => e.type === 'task.body_edited')?.actor.kind).toBe('person');
  });

  it('keeps comment threads anchored to blocks the rewrite left alone', async () => {
    const { task } = await seed({ body: 'Keep this paragraph.\n\nReplace this one.' });
    const docId = taskBodyDocId(task.id);
    // by_find, not /threads: the latter takes the anchor verbatim, and a
    // hand-written text-range with no encoded rel positions is not an
    // anchor — it plants something that only fails later, inside the
    // re-anchor sweep, as an async crash attributed to whatever test is
    // running by then.
    const { thread } = await jj<{ thread: { id: string } }>(
      await post(`/api/docs/${encodeURIComponent(docId)}/threads/by_find`, {
        author: PERSON,
        text: 'why?',
        find: 'Keep this paragraph.',
      }),
    );

    await jj(
      await post(`/api/tasks/${task.id}/body`, {
        markdown: 'Keep this paragraph.\n\nA different second paragraph.',
        author: AGENT,
      }),
    );

    // "Did the anchor survive" is not a field on the thread — nothing sets
    // `orphaned` on this route, so reading it would assert undefined both
    // ways. Resolve the stored RelativePosition against the live doc, which
    // is what the editor itself does.
    const resolves = (): boolean => {
      const room = handle?.rooms.get(docId);
      const stored = room ? listThreads(room.ydoc).find((t) => t.id === thread.id) : undefined;
      const anchor = stored?.anchor as { startRel?: Uint8Array } | undefined;
      if (!room || !anchor?.startRel) return false;
      return prose.resolveRelativePosition(room.ydoc, anchor.startRel) !== null;
    };
    expect(resolves()).toBe(true);

    // Control: the check can come out the other way. Wipe the paragraph the
    // thread is anchored to — and leave no snippet for the re-anchor sweep
    // to find — and it stops resolving. So "survived" above means the block
    // diff spared that block, not that this check always says yes.
    await jj(
      await post(`/api/tasks/${task.id}/body`, {
        markdown: 'Nothing of the original remains.',
        author: AGENT,
      }),
    );
    expect(resolves()).toBe(false);
  });

  it('refuses to blank a body, and says why rather than 200-ing', async () => {
    const { workspaceId, task } = await seed();
    const res = await post(`/api/tasks/${task.id}/body`, { markdown: '   ', author: AGENT });
    // 400, NOT 404: with no route at all every request here 404s, so a bare
    // `res.ok === false` would pass before a line of this feature existed.
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('empty');
    // The body it refused to wipe is still there.
    expect((await readTask(workspaceId, task.id)).body).toContain('thin.');
  });

  it('404s on a task that does not exist', async () => {
    // Non-vacuous because the first test drives the same route to 200 on a
    // real id — this asserts the route can tell the two apart.
    await seed();
    const res = await post('/api/tasks/t-nope/body', { markdown: 'hello.', author: AGENT });
    expect(res.status).toBe(404);
  });

  it('survives a restart on a task filed with no body at all', async () => {
    const { workspaceId, task } = await seedBodyless();
    await handle?.stop();
    handle = await start(dataDir as string);

    await jj(
      await post(`/api/tasks/${task.id}/body`, { markdown: 'written cold.', author: AGENT }),
    );
    expect((await readTask(workspaceId, task.id)).body).toContain('written cold.');
  });

  it('recreates a body room that was deleted out from under the task', async () => {
    // Body rooms are created lazily, and `delete_doc` on one is a call any
    // agent can make. A rewrite aimed straight at the doc then comes back
    // 'not-found' — which reads as "no such task", when the task is fine and
    // only its room is missing. The route recreates the room rather than
    // relying on the startup sweep that happens to re-arm every other case.
    const { workspaceId, task } = await seed();
    const docId = taskBodyDocId(task.id);
    const del = await fetch(`${base}/api/docs/${encodeURIComponent(docId)}`, { method: 'DELETE' });
    expect(del.ok).toBe(true);
    // Positive control: the room really is gone.
    expect((await fetch(`${base}/api/docs/${encodeURIComponent(docId)}/content`)).status).toBe(404);

    await jj(
      await post(`/api/tasks/${task.id}/body`, { markdown: 'back from nothing.', author: AGENT }),
    );
    expect((await readTask(workspaceId, task.id)).body).toContain('back from nothing.');
  });
});
