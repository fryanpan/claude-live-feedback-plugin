/**
 * You can discuss a task.
 *
 * A task body already lives in its own `task:<taskId>` doc room, so the whole
 * thread machinery applies unchanged — except that BOTH write paths demanded
 * something to point at (`POST /threads` required an anchor, `by_find`
 * required a find string), and a freshly created task's description is empty.
 * So the one surface in the product where a person most wants to push back
 * was the one surface with no way to comment.
 *
 * These go through the real routes: `postComment` is reachable three ways and
 * the route is the layer nothing type-checks.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { taskBodyDocId } from '../src/task-projection.ts';

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };

type ThreadPayload = {
  thread: { id: string; anchor: { kind: string }; comments: Array<{ text: string }> };
};

describe('task discussion', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } });

  async function makeTask(title: string): Promise<string> {
    const w = await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship it.' });
    const { workspace } = (await w.json()) as { workspace: { id: string } };
    const r = await post(`/api/workspaces/${workspace.id}/tasks`, { title });
    expect(r.status).toBe(200);
    const { task } = (await r.json()) as { task: { id: string } };
    return task.id;
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-discussion-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('opens a thread on a task whose description is still empty', async () => {
    const taskId = await makeTask('Wire the index');
    const docId = taskBodyDocId(taskId);

    const r = await post(`/api/docs/${encodeURIComponent(docId)}/threads`, {
      author: PERSON,
      text: 'Is this still the plan after the retriage?',
      anchor: { kind: 'subject' },
    });
    expect(r.status).toBe(200);
    const { thread } = (await r.json()) as ThreadPayload;
    expect(thread.anchor.kind).toBe('subject');
    expect(thread.comments[0]?.text).toBe('Is this still the plan after the retriage?');

    // And it is READABLE — a thread that exists only in the store is the
    // failure this surface is meant to avoid.
    const list = await get(`/api/docs/${encodeURIComponent(docId)}/threads`);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      threads: Array<{ id: string; anchor: { kind: string } }>;
    };
    expect(listed.threads.map((t) => t.id)).toContain(thread.id);
    expect(listed.threads.find((t) => t.id === thread.id)?.anchor.kind).toBe('subject');
  });

  // Positive control for the test above: the route did not simply stop
  // caring what it was handed.
  it('POSITIVE CONTROL: the route still refuses a thread with no anchor at all', async () => {
    const taskId = await makeTask('Wire the index');
    const r = await post(`/api/docs/${encodeURIComponent(taskBodyDocId(taskId))}/threads`, {
      author: PERSON,
      text: 'no anchor here',
    });
    expect(r.status).toBe(400);
  });

  it('a reply lands on the subject thread and it stays a subject thread', async () => {
    const taskId = await makeTask('Wire the index');
    const docId = taskBodyDocId(taskId);
    const created = await post(`/api/docs/${encodeURIComponent(docId)}/threads`, {
      author: PERSON,
      text: 'Why is this above the API work?',
      anchor: { kind: 'subject' },
    });
    const { thread } = (await created.json()) as ThreadPayload;

    const reply = await post(
      `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(thread.id)}/comments`,
      { author: PERSON, text: 'Because the index unblocks two others.' },
    );
    expect(reply.status).toBe(200);

    const list = await get(`/api/docs/${encodeURIComponent(docId)}/threads`);
    const listed = (await list.json()) as {
      threads: Array<{ id: string; anchor: { kind: string }; comments: unknown[] }>;
    };
    const found = listed.threads.find((t) => t.id === thread.id);
    expect(found?.comments).toHaveLength(2);
    expect(found?.anchor.kind).toBe('subject');
  });
});
