/**
 * The WRITE doors for a ticket's review items, through the REAL routes.
 *
 * `addReviewItem` / `answerTaskReview` / `requestMoreInfoOnReview` have been
 * reachable only from the store since they were written — a store method with
 * no route is a feature nothing outside this process can use, and the route
 * layer is the one layer nothing type-checks. This repo has shipped the
 * "accepted it, returned 200, discarded it" bug twice; that is why every
 * assertion here reads the effect back through a SECOND request rather than
 * trusting the response body of the call that made it.
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

/** A complete, gap-free decision payload — the positive control every
 *  refusal case is measured against. */
const FULL_DECISION = {
  shape: 'decision',
  headline: 'Cache size for the rebuild',
  why: 'The nightly rebuild stalls until this is settled.',
  lookFor: 'Whether the smaller cache still covers one full pass.',
  detail: 'A full pass reads the index once. A smaller cache makes it read twice.',
  options: [
    { id: 'o-7f3a', label: 'Keep it', detail: 'costs 2GB of disk' },
    { id: 'o-4b2e', label: 'Halve it' },
  ],
};

/** Valid, and therefore filed — but with nothing to open the card onto. */
const THIN_DECISION = {
  shape: 'decision',
  headline: 'Retry budget for the poller',
  why: 'Two agents are waiting on the answer.',
  options: [
    { id: 'o-9c11', label: 'Three tries' },
    { id: 'o-2d40', label: 'Give up once' },
  ],
};

interface ReviewRow {
  kind: string;
  taskId?: string;
  reviewItemId?: string;
  ask?: string;
}

describe('task review-item routes', () => {
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
  async function getTasks(workspaceId: string): Promise<Task[]> {
    const { tasks } = await jj<{ tasks: Task[] }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/tasks`),
    );
    return tasks;
  }
  async function queueRows(workspaceId: string): Promise<ReviewRow[]> {
    const { items } = await jj<{ items: ReviewRow[] }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/review-items`),
    );
    return items;
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-review-item-routes-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ── POST /api/tasks/:taskId/review-items ────────────────────────────────

  describe('attaching a review item to a ticket', () => {
    it('200s and the item reaches the workspace review queue', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      // Presence first: an ordinary ticket contributes nothing to the queue,
      // so the row asserted below can only have come from this call.
      expect((await queueRows(wsId)).some((r) => r.taskId === task.id)).toBe(false);

      const created = await jj<{ item: { id: string }; reviewAdvice?: string }>(
        await post(`/api/tasks/${task.id}/review-items`, {
          review: FULL_DECISION,
          author: AGENT,
        }),
      );
      expect(created.item.id.length).toBeGreaterThan(0);
      // A gap-free payload earns no advice — the channel is not chatter.
      expect(created.reviewAdvice).toBeUndefined();

      const row = (await queueRows(wsId)).find((r) => r.taskId === task.id);
      expect(row?.kind).toBe('task-review');
      expect(row?.reviewItemId).toBe(created.item.id);
      expect(row?.ask).toBe('Cache size for the rebuild');
    });

    it('holds several open items on one ticket, each its own row', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      const first = await jj<{ item: { id: string } }>(
        await post(`/api/tasks/${task.id}/review-items`, { review: FULL_DECISION, author: AGENT }),
      );
      const second = await jj<{ item: { id: string } }>(
        await post(`/api/tasks/${task.id}/review-items`, { review: THIN_DECISION, author: AGENT }),
      );
      const ids = (await queueRows(wsId))
        .filter((r) => r.taskId === task.id)
        .map((r) => r.reviewItemId);
      // A set, not a sequence: two items minted inside one millisecond tie on
      // `since` and fall to the id tie-break, so filing order is not a promise.
      expect(new Set(ids)).toEqual(new Set([first.item.id, second.item.id]));
    });

    it('400s a payload with no `why` and quotes the writer the field back', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      const { why: _dropped, ...noWhy } = FULL_DECISION;
      const r = await post(`/api/tasks/${task.id}/review-items`, {
        review: noWhy,
        author: AGENT,
      });
      expect(r.status).toBe(400);
      const body = (await r.json()) as { error: string; message?: string };
      expect(body.error).toBe('bad-review');
      expect(body.message ?? '').toContain('review.why');
      // …and nothing was filed.
      expect((await queueRows(wsId)).some((r2) => r2.taskId === task.id)).toBe(false);
    });

    it('200s a thin-but-valid payload and names lookFor in reviewAdvice', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      const created = await jj<{ item: { id: string }; reviewAdvice?: string }>(
        await post(`/api/tasks/${task.id}/review-items`, { review: THIN_DECISION, author: AGENT }),
      );
      expect(created.reviewAdvice ?? '').toContain('lookFor');
      // Advice is not a refusal: the item is on the queue all the same.
      expect((await queueRows(wsId)).some((r) => r.reviewItemId === created.item.id)).toBe(true);
    });

    it('404s an unknown ticket and 400s a missing author or missing review', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      expect(
        (await post('/api/tasks/t-missing/review-items', { review: FULL_DECISION, author: AGENT }))
          .status,
      ).toBe(404);
      expect(
        (await post(`/api/tasks/${task.id}/review-items`, { review: FULL_DECISION })).status,
      ).toBe(400);
      expect((await post(`/api/tasks/${task.id}/review-items`, { author: AGENT })).status).toBe(
        400,
      );
    });
  });

  // ── POST /api/tasks/:taskId/review-items/:reviewItemId/answer ───────────

  describe('answering one review item', () => {
    it('records the words and the option it came from, and clears the row', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      const created = await jj<{ item: { id: string } }>(
        await post(`/api/tasks/${task.id}/review-items`, { review: FULL_DECISION, author: AGENT }),
      );
      await jj(
        await post(`/api/tasks/${task.id}/review-items/${created.item.id}/answer`, {
          text: 'Halve it',
          answeredWith: 'o-4b2e',
          author: PERSON,
        }),
      );
      const stored = (await getTasks(wsId)).find((t) => t.id === task.id);
      const item = stored?.reviews?.find((r) => r.id === created.item.id);
      expect(item?.answer?.text).toBe('Halve it');
      expect(item?.answer?.answeredWith).toBe('o-4b2e');
      // Answered means gone from the queue — that is what makes it a queue.
      expect((await queueRows(wsId)).some((r) => r.reviewItemId === created.item.id)).toBe(false);
    });

    it('leaves a sibling item open when one is answered', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      const first = await jj<{ item: { id: string } }>(
        await post(`/api/tasks/${task.id}/review-items`, { review: FULL_DECISION, author: AGENT }),
      );
      const second = await jj<{ item: { id: string } }>(
        await post(`/api/tasks/${task.id}/review-items`, { review: THIN_DECISION, author: AGENT }),
      );
      await jj(
        await post(`/api/tasks/${task.id}/review-items/${first.item.id}/answer`, {
          text: 'Keep it',
          author: PERSON,
        }),
      );
      const open = (await queueRows(wsId))
        .filter((r) => r.taskId === task.id)
        .map((r) => r.reviewItemId);
      expect(open).toEqual([second.item.id]);
    });

    it('400s an answeredWith the item does not carry, and writes nothing', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      const created = await jj<{ item: { id: string } }>(
        await post(`/api/tasks/${task.id}/review-items`, { review: FULL_DECISION, author: AGENT }),
      );
      const r = await post(`/api/tasks/${task.id}/review-items/${created.item.id}/answer`, {
        text: 'Halve it',
        answeredWith: 'o-ghost',
        author: PERSON,
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('unknown-option');
      const stored = (await getTasks(wsId)).find((t) => t.id === task.id);
      expect(stored?.reviews?.find((x) => x.id === created.item.id)?.answer).toBeUndefined();
    });

    it('404s an unknown ticket, 400s an unknown item and a missing text', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      const created = await jj<{ item: { id: string } }>(
        await post(`/api/tasks/${task.id}/review-items`, { review: FULL_DECISION, author: AGENT }),
      );
      expect(
        (
          await post('/api/tasks/t-missing/review-items/r-ghost/answer', {
            text: 'x',
            author: PERSON,
          })
        ).status,
      ).toBe(404);
      const ghost = await post(`/api/tasks/${task.id}/review-items/r-ghost/answer`, {
        text: 'x',
        author: PERSON,
      });
      expect(ghost.status).toBe(400);
      expect(((await ghost.json()) as { error: string }).error).toBe('unknown-review-item');
      expect(
        (
          await post(`/api/tasks/${task.id}/review-items/${created.item.id}/answer`, {
            author: PERSON,
          })
        ).status,
      ).toBe(400);
    });
  });

  // ── POST /api/tasks/:taskId/review-items/:reviewItemId/more-info ────────

  describe('asking one review item for more context', () => {
    it('records the question and leaves the item open and counted', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      const created = await jj<{ item: { id: string } }>(
        await post(`/api/tasks/${task.id}/review-items`, { review: FULL_DECISION, author: AGENT }),
      );
      await jj(
        await post(`/api/tasks/${task.id}/review-items/${created.item.id}/more-info`, {
          question: 'what does the second pass cost?',
          author: PERSON,
        }),
      );
      const stored = (await getTasks(wsId)).find((t) => t.id === task.id);
      const item = stored?.reviews?.find((x) => x.id === created.item.id);
      expect(item?.infoRequests?.map((q) => q.text)).toEqual(['what does the second pass cost?']);
      expect(item?.answer).toBeUndefined();
      expect((await queueRows(wsId)).some((r) => r.reviewItemId === created.item.id)).toBe(true);
    });

    it('404s an unknown ticket and 400s a missing question or author', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      const created = await jj<{ item: { id: string } }>(
        await post(`/api/tasks/${task.id}/review-items`, { review: FULL_DECISION, author: AGENT }),
      );
      const at = `/api/tasks/${task.id}/review-items/${created.item.id}/more-info`;
      expect(
        (
          await post('/api/tasks/t-missing/review-items/r-ghost/more-info', {
            question: 'x',
            author: PERSON,
          })
        ).status,
      ).toBe(404);
      expect((await post(at, { author: PERSON })).status).toBe(400);
      expect((await post(at, { question: 'x' })).status).toBe(400);
    });
  });

  // ── `review` on a create body ───────────────────────────────────────────

  describe('filing a blurbed review item with the ticket, in one call', () => {
    it('creates the ticket and the item together', async () => {
      const wsId = await seedWorkspace();
      const { task } = await jj<{ task: Task; reviewAdvice?: string }>(
        await post(`/api/workspaces/${wsId}/tasks`, {
          title: 'Rebuild the index nightly',
          assignee: 'Index Keeper',
          author: AGENT,
          review: FULL_DECISION,
        }),
      );
      const row = (await queueRows(wsId)).find((r) => r.taskId === task.id);
      expect(row?.kind).toBe('task-review');
      expect(row?.ask).toBe('Cache size for the rebuild');
      const stored = (await getTasks(wsId)).find((t) => t.id === task.id);
      expect(stored?.reviews?.length).toBe(1);
    });

    it('carries reviewAdvice back for a thin one', async () => {
      const wsId = await seedWorkspace();
      const created = await jj<{ task: Task; reviewAdvice?: string }>(
        await post(`/api/workspaces/${wsId}/tasks`, {
          title: 'Tune the poller',
          assignee: 'Index Keeper',
          author: AGENT,
          review: THIN_DECISION,
        }),
      );
      expect(created.reviewAdvice ?? '').toContain('lookFor');
    });

    it('refuses the whole create on a malformed review — an option nobody was offered is not a partial success', async () => {
      const wsId = await seedWorkspace();
      const r = await post(`/api/workspaces/${wsId}/tasks`, {
        title: 'Tune the poller',
        assignee: 'Index Keeper',
        author: AGENT,
        review: { shape: 'decision', headline: 'Retry budget' },
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toBe('bad-review');
      expect((await getTasks(wsId)).some((t) => t.title === 'Tune the poller')).toBe(false);
    });

    it('files it through the batch door too, rather than accepting and discarding', async () => {
      const wsId = await seedWorkspace();
      const { tasks } = await jj<{ tasks: Task[]; failures: unknown[] }>(
        await post(`/api/workspaces/${wsId}/tasks/batch`, {
          author: AGENT,
          tasks: [
            {
              title: 'Rebuild the index nightly',
              assignee: 'Index Keeper',
              review: FULL_DECISION,
            },
          ],
        }),
      );
      const filed = tasks[0];
      expect(filed).toBeDefined();
      const row = (await queueRows(wsId)).find((r) => r.taskId === filed?.id);
      expect(row?.ask).toBe('Cache size for the rebuild');
    });

    // POSITIVE CONTROL: the create body without `review` is untouched.
    it('leaves a create carrying no review exactly as it was', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      const stored = (await getTasks(wsId)).find((t) => t.id === task.id);
      expect(stored?.reviews).toBeUndefined();
      expect((await queueRows(wsId)).some((r) => r.taskId === task.id)).toBe(false);
    });
  });
});
