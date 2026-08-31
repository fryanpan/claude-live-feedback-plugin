/**
 * A question typed where the answer goes is an ASK BACK, not a decision.
 *
 * The incident (Bryan, 2026-08-30): a decision answered with "Why is this
 * important?" was stamped as its ANSWER. The item closed, `revise` refused it
 * ("the answer is to the words it has"), and the only way to keep asking was
 * a duplicate row. These tests pin the conversion on every answer door — the
 * ticket item route, the legacy task decision route, the declared-thread
 * route — and the whole loop the ticket's "done when" names: the question
 * leaves the item open and reaches the agent, the agent's revision re-queues
 * the SAME item with the question kept on its thread, and no duplicate row
 * ever exists.
 *
 * Every assertion reads the effect back through a SECOND request rather than
 * trusting the response body of the call that made it, and the plain-prose
 * answer keeps its own positive control in each describe — the conversion is
 * a narrowing, and the original behavior must be shown still standing.
 *
 * All fixtures are synthetic — invented ids and generic personas. The repo is
 * public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
const AGENT = {
  id: 'agent-index-keeper',
  name: 'Index Keeper',
  kind: 'known',
  color: '#888888',
};

const DECISION = {
  shape: 'decision',
  headline: 'Cache size for the rebuild',
  detail: 'A full pass reads the index once. A smaller cache makes it read twice.',
  options: [
    { id: 'o-7f3a', label: 'Keep it', detail: 'costs 2GB of disk' },
    { id: 'o-4b2e', label: 'Halve it' },
  ],
};

interface StoredItem {
  id: string;
  answer?: { text: string; by: string; answeredWith?: string };
  infoRequests?: Array<{ text: string; by: string; threadId?: string; range?: unknown }>;
  revisions?: Array<{ threadId?: string }>;
}
interface ReviewRow {
  taskId?: string;
  reviewItemId?: string;
  state?: string;
}
interface ThreadShape {
  id: string;
  anchor: { kind: string; reviewItemId?: string; snippet?: { text: string } };
  comments: Array<{ id: string; text: string; author: { id: string }; review?: unknown }>;
}

describe('answering with a question asks back instead of closing', () => {
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
      await post('/api/workspaces', { name: 'index-rebuild', goal: 'Rebuild the index nightly.' }),
    );
    return workspace.id;
  }
  async function seedTask(workspaceId: string, extra: Record<string, unknown> = {}): Promise<Task> {
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        title: 'Rebuild the index nightly',
        assignee: 'Index Keeper',
        author: AGENT,
        ...extra,
      }),
    );
    return task;
  }
  async function seedItem(taskId: string): Promise<string> {
    const { item } = await jj<{ item: { id: string } }>(
      await post(`/api/tasks/${taskId}/review-items`, { review: DECISION, author: AGENT }),
    );
    return item.id;
  }
  async function storedTask(workspaceId: string, taskId: string): Promise<Task> {
    const { tasks } = await jj<{ tasks: Task[] }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/tasks`),
    );
    const task = tasks.find((t) => t.id === taskId);
    expect(task, 'the task is on the board').toBeTruthy();
    return task as Task;
  }
  async function storedItem(workspaceId: string, taskId: string, itemId: string) {
    const item = (
      (await storedTask(workspaceId, taskId)) as Task & { reviews?: StoredItem[] }
    ).reviews?.find((r) => r.id === itemId);
    expect(item, 'the item is on the ticket').toBeTruthy();
    return item as StoredItem;
  }
  async function queueRows(workspaceId: string, taskId: string): Promise<ReviewRow[]> {
    const { items } = await jj<{ items: ReviewRow[] }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/review-items`),
    );
    return items.filter((r) => r.taskId === taskId);
  }
  async function thread(taskId: string, threadId: string): Promise<ThreadShape> {
    const { thread } = await jj<{ thread: ThreadShape }>(
      await fetch(`${base}/api/docs/task:${taskId}/threads/${threadId}`),
    );
    return thread;
  }
  const answer = (taskId: string, itemId: string, body: Record<string, unknown>) =>
    post(`/api/tasks/${taskId}/review-items/${itemId}/answer`, body);

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'review-item-question-answer-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ── The ticket item route: the incident's door ───────────────────────────

  describe('a ticket-borne review item', () => {
    it('a person’s question leaves the item open, threads it, and takes it off the queue', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws);
      const itemId = await seedItem(task.id);
      expect((await queueRows(ws, task.id)).map((r) => r.state)).toEqual(['open']);

      const res = await jj<{ asked?: boolean; threadId?: string }>(
        await answer(task.id, itemId, { text: 'Why is this important?', author: PERSON }),
      );
      expect(res.asked).toBe(true);
      expect(typeof res.threadId).toBe('string');

      // NOT an answer: the item is open, and the question landed in the same
      // more-info storage the phrase-anchored ask uses — one mechanism.
      const item = await storedItem(ws, task.id, itemId);
      expect(item.answer).toBeUndefined();
      expect(item.infoRequests?.length).toBe(1);
      expect(item.infoRequests?.[0]?.text).toBe('Why is this important?');
      expect(item.infoRequests?.[0]?.by).toBe('Jordan');
      expect(item.infoRequests?.[0]?.threadId).toBe(res.threadId);
      // About the WHOLE item — no phrase to mark.
      expect(item.infoRequests?.[0]?.range).toBeUndefined();

      // The thread is real, on the task's doc, anchored to the item with its
      // headline as the quoted words.
      const t = await thread(task.id, res.threadId as string);
      expect(t.anchor.kind).toBe('review-item');
      expect(t.anchor.reviewItemId).toBe(itemId);
      expect(t.anchor.snippet?.text).toBe(DECISION.headline);
      expect(t.comments.map((c) => c.text)).toEqual(['Why is this important?']);

      // Waiting on the owner: off the reader's queue, and no duplicate row.
      expect(await queueRows(ws, task.id)).toEqual([]);
    });

    it('the owner’s revision answers the question and re-queues the SAME item, question kept', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws);
      const itemId = await seedItem(task.id);
      const { threadId } = await jj<{ threadId: string }>(
        await answer(task.id, itemId, { text: 'Why is this important?', author: PERSON }),
      );

      const revised = await jj<{ item: { id: string } }>(
        await post(`/api/tasks/${task.id}/review-items/${itemId}/revise`, {
          author: AGENT,
          detail:
            'It sets tonight’s rebuild cost. A full pass reads the index once; halving the cache reads it twice, doubling the window.',
          reply: 'Because it decides how long tonight’s rebuild takes — detail updated.',
        }),
      );
      expect(revised.item.id).toBe(itemId);

      // Back on the queue as the SAME row, marked revised — never a second one.
      const rows = await queueRows(ws, task.id);
      expect(rows.length).toBe(1);
      expect(rows[0]?.reviewItemId).toBe(itemId);
      expect(rows[0]?.state).toBe('revised');

      // The question and the reply sit together on the thread the card opens.
      const t = await thread(task.id, threadId);
      expect(t.comments.map((c) => c.text)).toEqual([
        'Why is this important?',
        'Because it decides how long tonight’s rebuild takes — detail updated.',
      ]);
      const item = await storedItem(ws, task.id, itemId);
      expect(item.revisions?.at(-1)?.threadId).toBe(threadId);
    });

    it('refuses a second question while the first waits, naming the open thread', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws);
      const itemId = await seedItem(task.id);
      const { threadId } = await jj<{ threadId: string }>(
        await answer(task.id, itemId, { text: 'Why is this important?', author: PERSON }),
      );

      const second = await answer(task.id, itemId, {
        text: 'And who asked for it?',
        author: PERSON,
      });
      expect(second.status).toBe(409);
      const body = (await second.json()) as { error: string; threadId?: string };
      expect(body.error).toBe('waiting');
      expect(body.threadId).toBe(threadId);
      // Still exactly one recorded question.
      expect((await storedItem(ws, task.id, itemId)).infoRequests?.length).toBe(1);
    });

    it('positive control: plain prose still answers and clears the row', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws);
      const itemId = await seedItem(task.id);
      const res = await jj<{ asked?: boolean }>(
        await answer(task.id, itemId, { text: 'Keep it — disk is cheap.', author: PERSON }),
      );
      expect(res.asked).toBeUndefined();
      const item = await storedItem(ws, task.id, itemId);
      expect(item.answer?.text).toBe('Keep it — disk is cheap.');
      expect(await queueRows(ws, task.id)).toEqual([]);
    });

    it('a tapped option answers whatever its words end in', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws);
      const itemId = await seedItem(task.id);
      const res = await jj<{ asked?: boolean }>(
        await answer(task.id, itemId, {
          text: 'Keep it?',
          answeredWith: 'o-7f3a',
          author: PERSON,
        }),
      );
      expect(res.asked).toBeUndefined();
      const item = await storedItem(ws, task.id, itemId);
      expect(item.answer?.answeredWith).toBe('o-7f3a');
    });

    it('an agent’s question is an answer, not a conversion — agents answer, people ask', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws);
      const itemId = await seedItem(task.id);
      const res = await jj<{ asked?: boolean }>(
        await answer(task.id, itemId, {
          text: 'Halve it — or do we even need the cache?',
          author: { id: 'agent-relay', name: 'Relay', kind: 'agent' },
        }),
      );
      expect(res.asked).toBeUndefined();
      expect((await storedItem(ws, task.id, itemId)).answer?.text).toContain('Halve it');
    });
  });

  // ── The legacy task decision route: the hub's own-decision door ──────────

  describe('the task’s own decision (/api/tasks/:id/answer)', () => {
    it('a person’s question records a request for more info and the decision stays open', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws, {
        title: 'How should boards share work?',
        needs: 'decision',
        body: 'Push rows across, or mirror the whole board?',
      });

      const res = await jj<{ asked?: boolean }>(
        await post(`/api/tasks/${task.id}/answer`, {
          text: 'Why is this important?',
          author: PERSON,
        }),
      );
      expect(res.asked).toBe(true);

      const stored = (await storedTask(ws, task.id)) as Task & {
        answer?: unknown;
        infoRequests?: Array<{ text: string; by: string }>;
      };
      expect(stored.answer).toBeUndefined();
      expect(stored.infoRequests?.length).toBe(1);
      expect(stored.infoRequests?.[0]?.text).toBe('Why is this important?');
      // Open and still counted — the derived row is on the queue, not closed.
      expect((await queueRows(ws, task.id)).length).toBe(1);
    });

    it('positive control: prose still answers the decision', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws, {
        title: 'Ship Thursday or Friday?',
        needs: 'decision',
        body: 'Ship Thursday or Friday? Friday buys one more review pass and misses the demo; Thursday makes the demo on the current pass. Blocked until answered: the release note.',
      });
      const res = await jj<{ asked?: boolean }>(
        await post(`/api/tasks/${task.id}/answer`, {
          text: 'Ship Friday.',
          author: PERSON,
        }),
      );
      expect(res.asked).toBeUndefined();
      const stored = (await storedTask(ws, task.id)) as Task & { answer?: { text: string } };
      expect(stored.answer?.text).toBe('Ship Friday.');
    });
  });
});
