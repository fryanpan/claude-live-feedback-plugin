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
import { taskBodyDocId, workspaceRoomId } from '../src/task-projection.ts';

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

/** Read an SSE stream until stop(), collecting event names. */
function listen(res: Response): { events: string[]; stop: () => void } {
  const events: string[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  void (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const line of decoder.decode(value).split('\n')) {
          if (line.startsWith('event: ')) events.push(line.slice('event: '.length).trim());
        }
      }
    } catch {}
  })();
  return {
    events,
    stop: () => {
      stopped = true;
      void reader.cancel().catch(() => {});
    },
  };
}

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

  async function makeTaskIn(title: string): Promise<{ taskId: string; workspaceId: string }> {
    const w = await post('/api/workspaces', { name: 'search-revamp', goal: 'Ship it.' });
    const { workspace } = (await w.json()) as { workspace: { id: string } };
    const r = await post(`/api/workspaces/${workspace.id}/tasks`, { author: PERSON, title });
    expect(r.status).toBe(200);
    const { task } = (await r.json()) as { task: { id: string } };
    return { taskId: task.id, workspaceId: workspace.id };
  }

  async function makeTask(title: string): Promise<string> {
    return (await makeTaskIn(title)).taskId;
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
  /**
   * A comment nobody can see from the board is a comment nobody reads. The
   * row has to say a discussion exists, or the only way to find one is to
   * open every task.
   */
  it('the board projection counts the discussion', async () => {
    const { taskId, workspaceId } = await makeTaskIn('Wire the index');
    const docId = taskBodyDocId(taskId);
    const room = handle.rooms.get(workspaceRoomId(workspaceId));
    if (!room) throw new Error('ws room missing');
    const projected = () => room.ydoc.getMap('tasks').get(taskId) as { commentCount?: number };

    expect(projected().commentCount ?? 0).toBe(0);

    const created = await post(`/api/docs/${encodeURIComponent(docId)}/threads`, {
      author: PERSON,
      text: 'Is this still the plan?',
      anchor: { kind: 'subject' },
    });
    const { thread } = (await created.json()) as ThreadPayload;
    expect(projected().commentCount).toBe(1);

    await post(
      `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(thread.id)}/comments`,
      { author: PERSON, text: 'It is.' },
    );
    expect(projected().commentCount).toBe(2);
  });

  /**
   * And the agent has to HEAR it. An agent working a board watches the
   * workspace channel, not each task's body doc — so a comment that only
   * fans out on the doc's own stream reaches nobody who is working.
   */
  it('a task comment reaches the workspace channel', async () => {
    const { taskId, workspaceId } = await makeTaskIn('Wire the index');
    const stream = await fetch(`${base}/events/workspace/${encodeURIComponent(workspaceId)}`, {
      headers: { host: `localhost:${handle.port}` },
    });
    expect(stream.status).toBe(200);
    const heard = listen(stream);

    // Positive control: this channel is live and delivering — without it,
    // "the comment arrived" and "the stream works at all" are the same
    // assertion, and an empty list would prove nothing.
    await post(`/api/tasks/${taskId}/transition`, { to: 'in-progress', author: PERSON });
    await settle();
    expect(heard.events).toContain('task.transitioned');

    await post(`/api/docs/${encodeURIComponent(taskBodyDocId(taskId))}/threads`, {
      author: PERSON,
      text: 'Is this still the plan?',
      anchor: { kind: 'subject' },
    });
    await settle();
    heard.stop();
    expect(heard.events).toContain('thread.created');
  });
});
