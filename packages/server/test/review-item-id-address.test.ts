/**
 * `reviewItemId` as a UNIVERSAL address (Bryan, 2026-08-31: "make sure all
 * review items have unique reviewItemId values and that the tools all work
 * with reviewItemId").
 *
 * Three doors, one vocabulary:
 *
 * - every queue row NAMES its item's id — the minted `r-…` a ticket item has
 *   always had, and the derived `rt-…` a doc-thread item never had until now;
 * - `GET /api/review-items/:id` says WHERE a bare id lives, which is what
 *   lets a tool addressed by id alone find the item without the caller
 *   carrying the containing task or doc around;
 * - `POST /api/tasks/:id/review-items/:id/withdraw` is the exit the ticket
 *   surface lacked — the measured symptom that raised this ticket was a
 *   duplicate ticket-form decision whose only way off the reader's queue was
 *   being revised into something else.
 *
 * Every effect is read back through a SECOND request rather than trusted from
 * the response of the call that made it — this repo has shipped "accepted it,
 * returned 200, discarded it" twice.
 *
 * All fixtures are synthetic — invented ids and generic personas. The repo is
 * public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TaskReviewItem, threadReviewItemId } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';

const AGENT = {
  id: 'agent-index-keeper',
  name: 'Index Keeper',
  kind: 'known',
  color: '#888888',
};
const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };

const DECISION = {
  shape: 'decision',
  headline: 'Cache size for the rebuild',
  detail: 'A full pass reads the index once. A smaller cache makes it read twice.',
  options: [
    { id: 'o-7f3a', label: 'Keep it', detail: 'costs 2GB of disk' },
    { id: 'o-4b2e', label: 'Halve it' },
  ],
};

interface ReviewRow {
  kind: string;
  taskId?: string;
  docId?: string;
  threadId?: string;
  commentId?: string;
  reviewItemId?: string;
  ask?: string;
}

describe('reviewItemId as a universal address', () => {
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
      await post('/workspaces', { name: 'index-rebuild', goal: 'Rebuild the index nightly.' }),
    );
    return workspace.id;
  }
  async function seedTask(workspaceId: string): Promise<Task> {
    const { task } = await jj<{ task: Task }>(
      await post(`/workspaces/${workspaceId}/tasks`, {
        title: 'Rebuild the index nightly',
        assignee: 'Index Keeper',
        author: AGENT,
      }),
    );
    return task;
  }
  async function seedItem(taskId: string): Promise<{ id: string }> {
    const { item } = await jj<{ item: { id: string } }>(
      await post(`/api/tasks/${taskId}/review-items`, { review: DECISION, author: AGENT }),
    );
    return item;
  }
  async function taskNow(workspaceId: string, taskId: string): Promise<Task> {
    const { tasks } = await jj<{ tasks: Task[] }>(
      await fetch(`${base}/workspaces/${workspaceId}/tasks?format=json`),
    );
    const task = tasks.find((t) => t.id === taskId);
    expect(task, 'the ticket should still be there').toBeTruthy();
    return task as Task;
  }
  async function queueRows(workspaceId: string): Promise<ReviewRow[]> {
    const { items } = await jj<{ items: ReviewRow[] }>(
      await fetch(`${base}/workspaces/${workspaceId}/review-items`),
    );
    return items;
  }
  /** A doc attached to the workspace, with one declared review item on a
   *  thread. Returns the item's full doc-thread address. */
  async function seedThreadItem(
    workspaceId: string,
  ): Promise<{ docId: string; threadId: string; commentId: string }> {
    const slug = `notes-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const file = join(dataDir, `${slug}.md`);
    writeFileSync(file, '# Mockup notes\n\nThe phone layout holds together.\n');
    const created = await jj<{ docId: string }>(
      await post('/api/docs', { docId: slug, type: 'markdown', sourceUrl: file }),
    );
    await jj(await post(`/workspaces/${workspaceId}/docs`, { docId: created.docId }));
    const opened = await jj<{ thread: { id: string; comments: Array<{ id: string }> } }>(
      await post(`/api/docs/${created.docId}/threads/by_find`, {
        find: 'The phone layout holds together.',
        text: 'Checked this at 430px.',
        author: AGENT,
        review: {
          shape: 'review',
          review_type: 'question',
          headline: 'Does the phone layout need the call to action moved?',
          detail: 'At 430px the call to action falls below the fold.',
        },
      }),
    );
    return {
      docId: created.docId,
      threadId: opened.thread.id,
      commentId: opened.thread.comments[0].id,
    };
  }

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'review-item-id-address-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ── every queue row names its item's id ─────────────────────────────────

  describe('queue rows carry reviewItemId', () => {
    it('a ticket row carries the minted id; a doc-thread row the derived one', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      const item = await seedItem(task.id);
      const address = await seedThreadItem(wsId);

      const rows = await queueRows(wsId);
      const ticketRow = rows.find((r) => r.taskId === task.id);
      expect(ticketRow?.reviewItemId).toBe(item.id);

      const threadRow = rows.find((r) => r.docId === address.docId);
      expect(threadRow?.kind).toBe('doc-thread');
      // Derived, not minted: the same triple always answers to the same id,
      // so no stored doc had to be rewritten to give old items an identity.
      expect(threadRow?.reviewItemId).toBe(
        threadReviewItemId(address.docId, address.threadId, address.commentId),
      );
    });
  });

  // ── GET /api/review-items/:id — where does this id live? ────────────────

  describe('resolving a bare reviewItemId', () => {
    it('finds a ticket item by its minted id', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      const item = await seedItem(task.id);
      const res = await jj<{ kind: string; taskId: string; workspaceId: string }>(
        await fetch(`${base}/api/review-items/${encodeURIComponent(item.id)}`),
      );
      expect(res.kind).toBe('task-item');
      expect(res.taskId).toBe(task.id);
      expect(res.workspaceId).toBe(wsId);
    });

    it('decodes a derived id back to its doc-thread address', async () => {
      const wsId = await seedWorkspace();
      const address = await seedThreadItem(wsId);
      const id = threadReviewItemId(address.docId, address.threadId, address.commentId);
      const res = await jj<{
        kind: string;
        docId: string;
        threadId: string;
        commentId: string;
        workspaceId?: string;
      }>(await fetch(`${base}/api/review-items/${encodeURIComponent(id)}`));
      expect(res.kind).toBe('doc-thread');
      expect(res.docId).toBe(address.docId);
      expect(res.threadId).toBe(address.threadId);
      expect(res.commentId).toBe(address.commentId);
      expect(res.workspaceId).toBe(wsId);
    });

    it('404s a derived id whose comment carries no review — decodable is a claim, not a fact', async () => {
      const wsId = await seedWorkspace();
      const address = await seedThreadItem(wsId);
      const forged = threadReviewItemId(address.docId, address.threadId, 'c-never-existed');
      const res = await fetch(`${base}/api/review-items/${encodeURIComponent(forged)}`);
      expect(res.status).toBe(404);
    });

    it('refuses r-legacy by name — it is on every legacy-decision ticket at once', async () => {
      const res = await fetch(`${base}/api/review-items/r-legacy`);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('ambiguous');
    });

    it('404s an id nothing minted', async () => {
      const res = await fetch(`${base}/api/review-items/r-neverminted00`);
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/tasks/:taskId/review-items/:id/withdraw ───────────────────

  describe('withdrawing a ticket-borne review item', () => {
    it('marks it withdrawn with the reason, off the queue, still on the ticket', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      const item = await seedItem(task.id);
      expect((await queueRows(wsId)).some((r) => r.reviewItemId === item.id)).toBe(true);

      await jj(
        await post(`/api/tasks/${task.id}/review-items/${item.id}/withdraw`, {
          author: AGENT,
          reason: 'Duplicate of the tunnel decision above.',
        }),
      );

      // Off the reader's queue…
      expect((await queueRows(wsId)).some((r) => r.reviewItemId === item.id)).toBe(false);
      // …but NOT deleted: the ticket still holds the words, stamped withdrawn
      // with the reason beside them.
      const after = await taskNow(wsId, task.id);
      const held = after.reviews?.find((r: TaskReviewItem) => r.id === item.id);
      expect(held, 'the withdrawn item should still be on the ticket').toBeTruthy();
      expect(held?.review.withdrawnAt).toBeGreaterThan(0);
      expect(held?.review.withdrawnBy).toBe(AGENT.name);
      expect(held?.review.withdrawnReason).toBe('Duplicate of the tunnel decision above.');
    });

    it('undo puts the ask back in front of the reader', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      const item = await seedItem(task.id);
      await jj(
        await post(`/api/tasks/${task.id}/review-items/${item.id}/withdraw`, { author: AGENT }),
      );
      expect((await queueRows(wsId)).some((r) => r.reviewItemId === item.id)).toBe(false);

      await jj(
        await post(`/api/tasks/${task.id}/review-items/${item.id}/withdraw/undo`, {
          author: AGENT,
        }),
      );
      expect((await queueRows(wsId)).some((r) => r.reviewItemId === item.id)).toBe(true);
      const after = await taskNow(wsId, task.id);
      const restored = after.reviews?.find((r: TaskReviewItem) => r.id === item.id);
      expect(restored?.review.withdrawnAt).toBeUndefined();
    });

    it('409s an answered item — withdrawing it would retract an answer somebody gave', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      const item = await seedItem(task.id);
      await jj(
        await post(`/api/tasks/${task.id}/review-items/${item.id}/answer`, {
          text: 'Keep it',
          answeredWith: 'o-7f3a',
          author: PERSON,
        }),
      );
      const res = await post(`/api/tasks/${task.id}/review-items/${item.id}/withdraw`, {
        author: AGENT,
        reason: 'Too late.',
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('answered');
      // The answer survived the attempt.
      const after = await taskNow(wsId, task.id);
      const kept = after.reviews?.find((r: TaskReviewItem) => r.id === item.id);
      expect(kept?.answer?.text).toBe('Keep it');
    });

    it("refuses r-legacy — the ticket's own decision has no stored item to stamp", async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      const res = await post(`/api/tasks/${task.id}/review-items/r-legacy/withdraw`, {
        author: AGENT,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('not-withdrawable');
    });

    it('404s an item the ticket does not hold', async () => {
      const wsId = await seedWorkspace();
      const task = await seedTask(wsId);
      const res = await post(`/api/tasks/${task.id}/review-items/r-neverminted00/withdraw`, {
        author: AGENT,
      });
      expect(res.status).toBe(404);
    });
  });
});
