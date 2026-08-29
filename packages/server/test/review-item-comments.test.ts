/**
 * Doc-style commenting ON a review item, and the in-place revision that
 * answers it — through the REAL routes.
 *
 * The flow under test (approved on the mock, 2026-08-29): a person selects a
 * phrase in an item's detail and opens a thread anchored to it; the item
 * leaves their queue while it waits on the owner; the owner revises the item
 * in place (and replies on the thread); the item comes back marked revised
 * with the question and the thread beside it. Every assertion reads the
 * effect back through a SECOND request rather than trusting the body of the
 * call that made it — this repo has shipped "accepted it, returned 200,
 * discarded it" more than once.
 *
 * Fixtures are synthetic: invented ids, generic personas. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const DETAIL = 'A full pass reads the index once. A smaller cache makes it read twice.';
const DECISION = {
  shape: 'decision',
  headline: 'Cache size for the rebuild',
  detail: DETAIL,
  options: [
    { id: 'o-7f3a', label: 'Keep it', detail: 'costs 2GB of disk' },
    { id: 'o-4b2e', label: 'Halve it' },
  ],
};

/** The phrase a reader would select, with its offsets into DETAIL. */
const PHRASE = 'read twice';
const PHRASE_START = DETAIL.indexOf(PHRASE);
const PHRASE_END = PHRASE_START + PHRASE.length;

interface ReviewRow {
  kind: string;
  taskId?: string;
  reviewItemId?: string;
  state?: string;
  question?: string;
  threadId?: string;
  revisedAt?: number;
  revisedRange?: { start: number; end: number };
}
interface StoredItem {
  id: string;
  review: { headline: string; detail?: string; options?: Array<{ id: string; label: string }> };
  answer?: { text: string };
  infoRequests?: Array<{ text: string; by: string; threadId?: string; range?: unknown }>;
  revisions?: Array<{ at: number; by: string; headline: string; detail?: string }>;
}
interface ThreadShape {
  id: string;
  anchor: { kind: string; reviewItemId?: string; start?: number; end?: number };
  comments: Array<{ text: string; author: { name: string } }>;
}

describe('review-item comments and revisions', () => {
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
  async function seedTask(workspaceId: string): Promise<Task> {
    const { task } = await jj<{ task: Task }>(
      await post(`/api/workspaces/${workspaceId}/tasks`, {
        title: 'Rebuild the index nightly',
        assignee: 'Index Keeper',
        author: AGENT,
      }),
    );
    return task;
  }
  async function seedItem(taskId: string, review: unknown = DECISION): Promise<string> {
    const { item } = await jj<{ item: { id: string } }>(
      await post(`/api/tasks/${taskId}/review-items`, { review, author: AGENT }),
    );
    return item.id;
  }
  async function storedItem(workspaceId: string, taskId: string, itemId: string) {
    const { tasks } = await jj<{ tasks: Array<Task & { reviews?: StoredItem[] }> }>(
      await fetch(`${base}/api/workspaces/${workspaceId}/tasks`),
    );
    const item = tasks.find((t) => t.id === taskId)?.reviews?.find((r) => r.id === itemId);
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
  function anchorFor(reviewItemId: string, extra: Record<string, unknown> = {}) {
    return {
      kind: 'review-item',
      reviewItemId,
      snippet: { text: PHRASE },
      start: PHRASE_START,
      end: PHRASE_END,
      ...extra,
    };
  }
  async function ask(taskId: string, itemId: string, text = 'Twice per what — per night?') {
    const { thread } = await jj<{ thread: { id: string } }>(
      await post(`/api/docs/task:${taskId}/threads`, {
        anchor: anchorFor(itemId),
        text,
        author: PERSON,
      }),
    );
    return thread.id;
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'review-item-comments-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ── A thread anchored to a phrase of the item ──────────────────────────

  describe('commenting on a phrase of a review item', () => {
    it('records the thread on the item, and the item waits instead of queueing', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws);
      const itemId = await seedItem(task.id);
      // Presence first: the open item IS on the queue before the question.
      expect((await queueRows(ws, task.id)).map((r) => r.state)).toEqual(['open']);

      const threadId = await ask(task.id, itemId);

      // The thread is a real task thread carrying the anchor verbatim.
      const t = await thread(task.id, threadId);
      expect(t.anchor.kind).toBe('review-item');
      expect(t.anchor.reviewItemId).toBe(itemId);
      expect(t.anchor.start).toBe(PHRASE_START);
      expect(t.comments.map((c) => c.text)).toEqual(['Twice per what — per night?']);

      // The question lives in the item's existing request-more-info storage,
      // now pointing at the thread — one mechanism, not two.
      const item = await storedItem(ws, task.id, itemId);
      expect(item.answer).toBeUndefined();
      expect(item.infoRequests?.length).toBe(1);
      expect(item.infoRequests?.[0]?.text).toBe('Twice per what — per night?');
      expect(item.infoRequests?.[0]?.by).toBe('Jordan');
      expect(item.infoRequests?.[0]?.threadId).toBe(threadId);

      // Waiting on the owner: out of the reader's queue entirely — neither as
      // the item row nor as a thread row about the question they just asked.
      expect(await queueRows(ws, task.id)).toEqual([]);
    });

    it('resolves offsets from the snippet when the caller sends none', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws);
      const itemId = await seedItem(task.id);
      const { thread: created } = await jj<{ thread: { id: string } }>(
        await post(`/api/docs/task:${task.id}/threads`, {
          anchor: { kind: 'review-item', reviewItemId: itemId, snippet: { text: PHRASE } },
          text: 'Which twice?',
          author: PERSON,
        }),
      );
      const t = await thread(task.id, created.id);
      expect(t.anchor.start).toBe(PHRASE_START);
      expect(t.anchor.end).toBe(PHRASE_END);
    });

    it('400s a malformed anchor, naming the field, and writes nothing', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws);
      const itemId = await seedItem(task.id);
      const attempt = async (anchor: unknown) =>
        post(`/api/docs/task:${task.id}/threads`, { anchor, text: 'Hm?', author: PERSON });

      const noItem = await attempt({ kind: 'review-item', snippet: { text: PHRASE } });
      expect(noItem.status).toBe(400);
      expect(((await noItem.json()) as { error: string }).error).toContain('reviewItemId');

      const noSnippet = await attempt({ kind: 'review-item', reviewItemId: itemId });
      expect(noSnippet.status).toBe(400);
      expect(((await noSnippet.json()) as { error: string }).error).toContain('snippet');

      const backwards = await attempt(anchorFor(itemId, { start: PHRASE_END, end: PHRASE_START }));
      expect(backwards.status).toBe(400);

      // Offsets that do not spell the snippet in the item's current detail
      // would anchor a highlight to the wrong words.
      const drifted = await attempt(anchorFor(itemId, { start: 0, end: PHRASE.length }));
      expect(drifted.status).toBe(400);
      expect(((await drifted.json()) as { error: string }).error).toContain('detail');

      // Nothing above reached the item.
      expect((await storedItem(ws, task.id, itemId)).infoRequests).toBeUndefined();
      expect((await queueRows(ws, task.id)).map((r) => r.state)).toEqual(['open']);
    });

    it('404s an item the ticket does not carry, and 400s the anchor on a non-task doc', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws);
      await seedItem(task.id);
      const unknown = await post(`/api/docs/task:${task.id}/threads`, {
        anchor: anchorFor('r-nope'),
        text: 'Hm?',
        author: PERSON,
      });
      expect(unknown.status).toBe(404);

      const sourceUrl = join(dataDir, 'notes.md');
      writeFileSync(sourceUrl, `# Notes\n\n${DETAIL}\n`);
      await jj(await post('/api/docs', { docId: 'notes-abc1', sourceUrl }));
      const wrongDoc = await post('/api/docs/notes-abc1/threads', {
        anchor: anchorFor('r-abc1'),
        text: 'Hm?',
        author: PERSON,
      });
      expect(wrongDoc.status).toBe(400);
    });
  });

  // ── Revising the item in place ─────────────────────────────────────────

  describe('revising a review item', () => {
    it('rewrites the text, keeps the old words, replies on the thread, and re-queues as revised', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws);
      const itemId = await seedItem(task.id);
      const threadId = await ask(task.id, itemId);
      expect(await queueRows(ws, task.id)).toEqual([]);

      const revised = `${DETAIL.slice(0, PHRASE_START)}read twice per nightly run.`;
      const res = await jj<{ item: StoredItem; threadId?: string }>(
        await post(`/api/tasks/${task.id}/review-items/${itemId}/revise`, {
          detail: revised,
          reply: 'Per night — clarified in the item.',
          author: AGENT,
        }),
      );
      expect(res.threadId).toBe(threadId);

      const item = await storedItem(ws, task.id, itemId);
      expect(item.review.detail).toBe(revised);
      // Untouched fields survive a partial patch.
      expect(item.review.headline).toBe('Cache size for the rebuild');
      expect(item.review.options?.map((o) => o.id)).toEqual(['o-7f3a', 'o-4b2e']);
      // The previous words are history, not gone.
      expect(item.revisions?.length).toBe(1);
      expect(item.revisions?.[0]?.headline).toBe('Cache size for the rebuild');
      expect(item.revisions?.[0]?.detail).toBe(DETAIL);
      expect(item.revisions?.[0]?.by).toBe('Index Keeper');
      expect(item.revisions?.[0]?.at).toBeGreaterThan(0);

      // The reply landed on the anchored thread, after the question.
      const t = await thread(task.id, threadId);
      expect(t.comments.map((c) => c.text)).toEqual([
        'Twice per what — per night?',
        'Per night — clarified in the item.',
      ]);
      expect(t.comments[1]?.author.name).toBe('Index Keeper');

      // Back on the queue, marked, with the question and thread beside it.
      const rows = await queueRows(ws, task.id);
      expect(rows.length).toBe(1);
      const row = rows[0] as ReviewRow;
      expect(row.kind).toBe('task-review');
      expect(row.state).toBe('revised');
      expect(row.question).toBe('Twice per what — per night?');
      expect(row.threadId).toBe(threadId);
      expect(row.revisedAt).toBe(item.revisions?.[0]?.at as number);
      // The changed span, derived from the diff when the caller sent none:
      // the words inserted after "read twice", before the final full stop.
      expect(row.revisedRange).toEqual({ start: PHRASE_END, end: revised.length - 1 });
    });

    it('takes an explicit revised range over the derived one', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws);
      const itemId = await seedItem(task.id);
      await ask(task.id, itemId);
      await jj(
        await post(`/api/tasks/${task.id}/review-items/${itemId}/revise`, {
          detail: 'Reads twice per nightly run. A full pass reads the index once.',
          revisedRange: { start: 0, end: 5 },
          author: AGENT,
        }),
      );
      const [row] = await queueRows(ws, task.id);
      expect(row?.revisedRange).toEqual({ start: 0, end: 5 });
    });

    it('revises headline and options too, each revision stacking on the history', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws);
      const itemId = await seedItem(task.id);
      await jj(
        await post(`/api/tasks/${task.id}/review-items/${itemId}/revise`, {
          headline: 'Cache size for the nightly rebuild',
          author: AGENT,
        }),
      );
      await jj(
        await post(`/api/tasks/${task.id}/review-items/${itemId}/revise`, {
          options: [
            { id: 'o-7f3a', label: 'Keep it' },
            { id: 'o-4b2e', label: 'Halve it' },
            { id: 'o-1c9d', label: 'Drop it' },
          ],
          author: AGENT,
        }),
      );
      const item = await storedItem(ws, task.id, itemId);
      expect(item.review.headline).toBe('Cache size for the nightly rebuild');
      expect(item.review.options?.map((o) => o.label)).toEqual(['Keep it', 'Halve it', 'Drop it']);
      expect(item.revisions?.map((r) => r.headline)).toEqual([
        'Cache size for the rebuild',
        'Cache size for the nightly rebuild',
      ]);
      // No question was asked, so there is nothing to quote — but the badge
      // is honest: the words changed.
      const [row] = await queueRows(ws, task.id);
      expect(row?.state).toBe('revised');
      expect(row?.question).toBeUndefined();
    });

    it('refuses what it cannot do, and writes nothing when it refuses', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws);
      const itemId = await seedItem(task.id);

      expect(
        (
          await post('/api/tasks/t-nope/review-items/r-nope/revise', {
            headline: 'x',
            author: AGENT,
          })
        ).status,
      ).toBe(404);
      // Unknown item: 400, the same answer the sibling answer/more-info doors give.
      expect(
        (
          await post(`/api/tasks/${task.id}/review-items/r-nope/revise`, {
            headline: 'x',
            author: AGENT,
          })
        ).status,
      ).toBe(400);
      // Nothing to change is not a revision.
      expect(
        (await post(`/api/tasks/${task.id}/review-items/${itemId}/revise`, { author: AGENT }))
          .status,
      ).toBe(400);
      // A reply with no anchored thread to land on is not silently dropped.
      const orphanReply = await post(`/api/tasks/${task.id}/review-items/${itemId}/revise`, {
        detail: 'Reads twice.',
        reply: 'clarified',
        author: AGENT,
      });
      expect(orphanReply.status).toBe(400);
      // The payload gate is the shared one: an option nobody could pick is refused.
      expect(
        (
          await post(`/api/tasks/${task.id}/review-items/${itemId}/revise`, {
            options: [{ id: 'o-1', label: '' }],
            author: AGENT,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post(`/api/tasks/${task.id}/review-items/${itemId}/revise`, {
            headline: 'x',
          })
        ).status,
      ).toBe(400);

      const item = await storedItem(ws, task.id, itemId);
      expect(item.review.detail).toBe(DETAIL);
      expect(item.revisions).toBeUndefined();
      expect((await queueRows(ws, task.id)).map((r) => r.state)).toEqual(['open']);
    });

    it('refuses the derived legacy decision row — its words live on the ticket', async () => {
      const ws = await seedWorkspace();
      const { task } = await jj<{ task: Task }>(
        await post(`/api/workspaces/${ws}/tasks`, {
          title: 'Pick a retry budget',
          body: 'How many times should the poller retry? Three tries costs a minute per failure; once loses the row on a blip. Blocked: the poller rollout.',
          assignee: 'human',
          needs: 'decision',
          options: [{ label: 'Three' }, { label: 'Once' }],
          author: AGENT,
        }),
      );
      const res = await post(`/api/tasks/${task.id}/review-items/r-legacy/revise`, {
        headline: 'Pick a retry budget for the poller',
        author: AGENT,
      });
      expect(res.status).toBe(400);
    });

    it('a second question after a revision puts the item back to waiting', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws);
      const itemId = await seedItem(task.id);
      await ask(task.id, itemId);
      const revised = `${DETAIL.slice(0, PHRASE_START)}read twice per nightly run.`;
      await jj(
        await post(`/api/tasks/${task.id}/review-items/${itemId}/revise`, {
          detail: revised,
          author: AGENT,
        }),
      );
      expect((await queueRows(ws, task.id)).map((r) => r.state)).toEqual(['revised']);
      await jj(
        await post(`/api/docs/task:${task.id}/threads`, {
          anchor: {
            kind: 'review-item',
            reviewItemId: itemId,
            snippet: { text: 'nightly run' },
          },
          text: 'And on a manual run?',
          author: PERSON,
        }),
      );
      expect(await queueRows(ws, task.id)).toEqual([]);
    });
  });

  // ── POSITIVE CONTROL ───────────────────────────────────────────────────

  describe('answering', () => {
    it('still closes a revised item, exactly as it closes an untouched one', async () => {
      const ws = await seedWorkspace();
      const task = await seedTask(ws);
      const itemId = await seedItem(task.id);
      await ask(task.id, itemId);
      await jj(
        await post(`/api/tasks/${task.id}/review-items/${itemId}/revise`, {
          detail: 'Reads twice per nightly run.',
          author: AGENT,
        }),
      );
      await jj(
        await post(`/api/tasks/${task.id}/review-items/${itemId}/answer`, {
          text: 'Halve it',
          answeredWith: 'o-4b2e',
          author: PERSON,
        }),
      );
      const item = await storedItem(ws, task.id, itemId);
      expect(item.answer?.text).toBe('Halve it');
      // History survives the answer.
      expect(item.revisions?.length).toBe(1);
      expect(await queueRows(ws, task.id)).toEqual([]);
    });
  });
});
