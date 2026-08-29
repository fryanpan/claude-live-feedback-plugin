/**
 * The OWNER hears a comment on their review item — and hears WHICH item.
 *
 * A review item's doc-style comment (commit 1 of this feature) is a thread on
 * the task's body doc, `task:<taskId>`, so it rides the channels an agent
 * working that task already holds: the doc's own `/events/<docId>` stream
 * (auto-watch / `watch_doc`) and the workspace stream every attached agent
 * holds. What was missing is the item: a frame that names the doc and the
 * thread but not the review item sends the agent to `list_threads` to learn
 * which of its items to revise. The anchor carries `reviewItemId`, and the
 * frame now also says it at the top level, so a consumer that reads only
 * top-level fields still knows.
 *
 * Both controls are here on purpose. Without the positive one, "the frame
 * carries the id" and "the stream delivers at all" are the same assertion;
 * without the negative one, a fan-out that broadcasts every frame to every
 * stream passes the positive case and pages every agent on the box.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { taskBodyDocId } from '../src/task-projection.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
const AGENT = { id: 'agent-index-keeper', name: 'Index Keeper', kind: 'known', color: '#888888' };

const DETAIL = 'A full pass reads the index once. A smaller cache makes it read twice.';
const PHRASE = 'read twice';
const REVIEW = {
  shape: 'decision',
  headline: 'Cache size for the rebuild',
  detail: DETAIL,
  options: [
    { id: 'o-7f3a', label: 'Keep it' },
    { id: 'o-4b2e', label: 'Halve it' },
  ],
};

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

interface Frame {
  event: string;
  docId?: string;
  threadId?: string;
  reviewItemId?: string;
  thread?: { anchor?: { kind?: string; reviewItemId?: string } };
  comment?: { text?: string };
}

/** Read an SSE stream until stop(), keeping every `event:` + `data:` pair. */
function listen(res: Response): { frames: Frame[]; stop: () => void } {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let pending = '';
  void (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const line of decoder.decode(value).split('\n')) {
          if (line.startsWith('event: ')) pending = line.slice('event: '.length).trim();
          if (line.startsWith('data: ')) {
            try {
              const p = JSON.parse(line.slice('data: '.length)) as Omit<Frame, 'event'>;
              frames.push({ ...p, event: pending });
            } catch {}
          }
        }
      }
    } catch {}
  })();
  return {
    frames,
    stop: () => {
      stopped = true;
      void reader.cancel().catch(() => {});
    },
  };
}

describe('the owner hears a comment on their review item', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const jj = async <T>(res: Response): Promise<T> => {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  };
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const stream = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    expect(res.status, `${path} → ${res.status}`).toBe(200);
    return listen(res);
  };

  async function seed(
    name: string,
  ): Promise<{ workspaceId: string; taskId: string; itemId: string }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name, goal: 'Rebuild the index nightly.' }),
    );
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/api/workspaces/${workspace.id}/tasks`, {
        title: 'Rebuild the index nightly',
        assignee: AGENT.name,
        author: AGENT,
      }),
    );
    const { item } = await jj<{ item: { id: string } }>(
      await post(`/api/tasks/${task.id}/review-items`, { review: REVIEW, author: AGENT }),
    );
    return { workspaceId: workspace.id, taskId: task.id, itemId: item.id };
  }

  const askOnItem = async (taskId: string, itemId: string, text: string) =>
    jj<{ thread: { id: string } }>(
      await post(`/api/docs/${encodeURIComponent(taskBodyDocId(taskId))}/threads`, {
        anchor: { kind: 'review-item', reviewItemId: itemId, snippet: { text: PHRASE } },
        text,
        author: PERSON,
      }),
    );

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'review-item-comment-events-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('POSITIVE CONTROL: a plain task-thread comment still reaches both streams, naming no item', async () => {
    const { workspaceId, taskId } = await seed('index-rebuild');
    const onDoc = await stream(`/events/${encodeURIComponent(taskBodyDocId(taskId))}`);
    const onBoard = await stream(`/events/workspace/${encodeURIComponent(workspaceId)}`);

    await jj(
      await post(`/api/docs/${encodeURIComponent(taskBodyDocId(taskId))}/threads`, {
        anchor: { kind: 'subject' },
        text: 'Is this still the plan?',
        author: PERSON,
      }),
    );
    await settle();
    onDoc.stop();
    onBoard.stop();

    for (const heard of [onDoc, onBoard]) {
      const created = heard.frames.filter((f) => f.event === 'thread.created');
      expect(created).toHaveLength(1);
      expect(created[0]?.docId).toBe(taskBodyDocId(taskId));
      expect(created[0]?.reviewItemId).toBeUndefined();
    }
  });

  it('a comment anchored to a review item names the item on the frame — on the doc stream and the workspace stream', async () => {
    const { workspaceId, taskId, itemId } = await seed('index-rebuild');
    const onDoc = await stream(`/events/${encodeURIComponent(taskBodyDocId(taskId))}`);
    const onBoard = await stream(`/events/workspace/${encodeURIComponent(workspaceId)}`);

    const { thread } = await askOnItem(taskId, itemId, 'Twice per what — per night?');
    await settle();

    for (const heard of [onDoc, onBoard]) {
      const created = heard.frames.filter((f) => f.event === 'thread.created');
      expect(created).toHaveLength(1);
      expect(created[0]?.threadId).toBe(thread.id);
      // Top level, so a consumer reading only the frame's own fields has it…
      expect(created[0]?.reviewItemId).toBe(itemId);
      // …and on the anchor, where the thread itself records it.
      expect(created[0]?.thread?.anchor?.kind).toBe('review-item');
      expect(created[0]?.thread?.anchor?.reviewItemId).toBe(itemId);
    }

    // The reply the owner posts back, and any follow-up on the same thread,
    // keep naming the item — the thread does not stop being about it.
    await jj(
      await post(
        `/api/docs/${encodeURIComponent(taskBodyDocId(taskId))}/threads/${thread.id}/comments`,
        { text: 'Per night — one pass per rebuild.', author: AGENT },
      ),
    );
    await settle();
    onDoc.stop();
    onBoard.stop();

    for (const heard of [onDoc, onBoard]) {
      const replied = heard.frames.filter((f) => f.event === 'thread.replied');
      expect(replied).toHaveLength(1);
      expect(replied[0]?.threadId).toBe(thread.id);
      expect(replied[0]?.reviewItemId).toBe(itemId);
      expect(replied[0]?.comment?.text).toBe('Per night — one pass per rebuild.');
    }
  });

  it("NEGATIVE CONTROL: a comment on an unrelated task's item reaches neither of this task's streams", async () => {
    const mine = await seed('index-rebuild');
    const theirs = await seed('search-revamp');
    const onDoc = await stream(`/events/${encodeURIComponent(taskBodyDocId(mine.taskId))}`);
    const onBoard = await stream(`/events/workspace/${encodeURIComponent(mine.workspaceId)}`);

    await askOnItem(theirs.taskId, theirs.itemId, 'Which cache?');
    await settle();
    onDoc.stop();
    onBoard.stop();

    for (const heard of [onDoc, onBoard]) {
      expect(heard.frames.filter((f) => f.event.startsWith('thread.'))).toHaveLength(0);
      expect(heard.frames.some((f) => f.reviewItemId === theirs.itemId)).toBe(false);
    }
  });

  it('a sibling task on the same board is heard on the board stream but never claims this item', async () => {
    // The workspace stream is board-wide by design — an attached agent hears
    // every task's threads there. What must not happen is the frame naming
    // the wrong item, which is the failure a shared `reviewItemId` slot in
    // the fan-out would produce.
    const mine = await seed('index-rebuild');
    const { task: sibling } = await jj<{ task: { id: string } }>(
      await post(`/api/workspaces/${mine.workspaceId}/tasks`, {
        title: 'Warm the cache',
        assignee: AGENT.name,
        author: AGENT,
      }),
    );
    const { item: siblingItem } = await jj<{ item: { id: string } }>(
      await post(`/api/tasks/${sibling.id}/review-items`, { review: REVIEW, author: AGENT }),
    );
    const onDoc = await stream(`/events/${encodeURIComponent(taskBodyDocId(mine.taskId))}`);
    const onBoard = await stream(`/events/workspace/${encodeURIComponent(mine.workspaceId)}`);

    await askOnItem(sibling.id, siblingItem.id, 'Warm it how?');
    await settle();
    onDoc.stop();
    onBoard.stop();

    expect(onDoc.frames.filter((f) => f.event.startsWith('thread.'))).toHaveLength(0);
    const created = onBoard.frames.filter((f) => f.event === 'thread.created');
    expect(created).toHaveLength(1);
    expect(created[0]?.docId).toBe(taskBodyDocId(sibling.id));
    expect(created[0]?.reviewItemId).toBe(siblingItem.id);
    expect(created[0]?.reviewItemId).not.toBe(mine.itemId);
  });
});
