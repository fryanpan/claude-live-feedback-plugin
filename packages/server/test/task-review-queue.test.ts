/**
 * A ticket's review items reach the queue, the count, and the projection —
 * driven through the REAL routes.
 *
 * The ticket's core complaint, restated as an assertion: a workspace whose only
 * content is one legacy decision task answers `GET /review-items` with ZERO
 * items, because a decision task used to BE a decision and the only surface
 * that knew about it was the board's own strip. One entity everywhere means the
 * same route ships it, in the same band, alongside a doc comment's declaration.
 *
 * Route-level on purpose: the route layer hand-copies fields into store calls
 * and is the one layer nothing type-checks; this repo has shipped "accepted it,
 * returned 200, discarded it" more than once. Fixtures are built through the
 * store only where no route exists yet.
 *
 * All fixtures synthetic — invented ids and copy throughout. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewPayload } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import type { Task } from '../src/tasks.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'known', color: '#2e7dd7' };
const AGENT = { id: 'agent-scheduler', name: 'Scheduler Agent', kind: 'known', color: '#888888' };

/** Decision-shaped: it asks something, which is the one thing the create gate
 *  enforces (`checkDecisionShape`). */
const DECISION_BODY =
  'Keep the disk cache or the memory one? Dropping disk frees 400MB and costs a cold start on every deploy. Blocked until answered: the storage cleanup.';

/** A well-formed declaration for the NEW path. Labels stay inside the review
 *  gate's 3-word / 28-char limit, which the legacy create path does not have. */
const REVIEW: ReviewPayload = {
  shape: 'decision',
  headline: 'Which cache do we keep?',
  why: 'Blocks the storage cleanup; both paths are built.',
  options: [
    { id: 'o-7f3a', label: 'Keep disk' },
    { id: 'o-4b2e', label: 'Keep memory' },
  ],
};

interface QueueRow {
  kind: string;
  band?: string;
  taskId?: string;
  reviewItemId?: string;
  docId?: string;
  threadId?: string;
  review?: ReviewPayload;
  title: string;
  ask: string;
  since: number;
}

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
    await post('/api/workspaces', { name: 'storage-cleanup', goal: 'Cut the storage bill.' }),
  );
  return workspace.id;
}

/** A LEGACY decision task: `needs: 'decision'` plus an embedded options array,
 *  exactly as every task on disk today carries one. Nothing new is written. */
async function seedDecision(workspaceId: string, title = 'keep disk or memory?'): Promise<Task> {
  const { task } = await jj<{ task: Task }>(
    await post(`/api/workspaces/${workspaceId}/tasks`, {
      title,
      assignee: 'Jordan',
      needs: 'decision',
      body: DECISION_BODY,
      options: [{ label: 'Keep the disk one' }, { label: 'Keep memory' }],
    }),
  );
  return task;
}

async function seedAction(workspaceId: string, title = 'sweep the cache dir'): Promise<Task> {
  const { task } = await jj<{ task: Task }>(
    await post(`/api/workspaces/${workspaceId}/tasks`, {
      title,
      assignee: 'Scheduler Agent',
      body: 'Agent can sweep the cache dir so that the disk stops filling up.',
    }),
  );
  return task;
}

async function queueRows(workspaceId: string): Promise<QueueRow[]> {
  const { items } = await jj<{ items: QueueRow[] }>(
    await fetch(`${base}/api/workspaces/${workspaceId}/review-items`),
  );
  return items;
}

async function briefLine(workspaceId: string): Promise<string> {
  const { brief } = await jj<{ brief: { markdown: string } }>(
    await fetch(`${base}/api/workspaces/${workspaceId}/home?user=Jordan`),
  );
  return brief.markdown;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'task-review-queue-'));
  handle = createServer({ port: 0, dataDir });
  base = `http://localhost:${handle.port}`;
});
afterEach(async () => {
  await handle.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /api/workspaces/:id/review-items — ticket-borne rows', () => {
  /**
   * The ticket's core complaint, as one assertion. Before this change the
   * answer was `[]`: the decision existed, the board's own strip drew it, and
   * the one route that answers "what is waiting on me" did not know about it.
   */
  it('ships a legacy decision task as a review item', async () => {
    const ws = await seedWorkspace();
    const task = await seedDecision(ws);
    const rows = await queueRows(ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'task-review',
      band: 'declared',
      taskId: task.id,
      reviewItemId: 'r-legacy',
      title: 'keep disk or memory?',
      // The headline is the ticket TITLE verbatim — an authored string, not a
      // clip of prose. Nothing is generated by the derivation.
      ask: 'keep disk or memory?',
    });
    expect(rows[0].review?.options?.map((o) => o.label)).toEqual([
      'Keep the disk one',
      'Keep memory',
    ]);
  });

  // An answered decision read as open is a queue that never empties, which is
  // the failure mode that makes a queue stop being read at all.
  it('drops the row once the decision is answered through the old route', async () => {
    const ws = await seedWorkspace();
    const task = await seedDecision(ws);
    expect(await queueRows(ws)).toHaveLength(1);
    await jj(
      await post(`/api/tasks/${task.id}/answer`, { text: 'Keep the disk one.', author: PERSON }),
    );
    expect(await queueRows(ws)).toEqual([]);
  });

  /**
   * The cardinality is the whole point. Three open questions on one ticket used
   * to collapse into at most one row, because a task held exactly one `options`
   * array — "at any point in time there might be multiple open decisions for a
   * ticket" had nowhere to live.
   */
  it('ships one row per OPEN item when a ticket holds three', async () => {
    const ws = await seedWorkspace();
    const task = await seedAction(ws);
    const ids: string[] = [];
    for (const headline of ['Which cache?', 'Which eviction rule?', 'Which retention?']) {
      const res = handle.tasks.addReviewItem(task.id, { ...REVIEW, headline }, { actor: AGENT });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      if (res.ok) ids.push(res.item.id);
    }
    const answered = ids[1] as string;
    const ans = handle.tasks.answerTaskReview(task.id, answered, 'Least-recently-used.', {
      actor: PERSON,
    });
    expect(ans.ok, JSON.stringify(ans)).toBe(true);

    // As a SET, not a sequence. All three were minted inside one millisecond,
    // so they tie on `since` and fall to the tie-break — which is the row's own
    // address, stable and total but deliberately not a filing order. WHICH rows
    // are open is the assertion; a same-millisecond ordering is not a promise
    // this queue makes.
    const rows = await queueRows(ws);
    expect(rows.map((r) => r.reviewItemId).sort()).toEqual([ids[0], ids[2]].sort());
    expect(rows.every((r) => r.kind === 'task-review' && r.taskId === task.id)).toBe(true);
  });

  /**
   * POSITIVE CONTROL — the thread half must be untouched. A collector that had
   * quietly replaced thread rows with ticket rows would satisfy every
   * assertion above and delete the queue this feature is joining.
   */
  it('still ships a task-discussion thread row beside the ticket row', async () => {
    const ws = await seedWorkspace();
    const task = await seedDecision(ws);
    await jj(
      await post(`/api/docs/task:${task.id}/threads`, {
        anchor: { kind: 'subject' },
        text: 'Jordan — is the cold start acceptable on every deploy?',
        author: AGENT,
      }),
    );
    const rows = await queueRows(ws);
    expect(rows.map((r) => r.kind).sort()).toEqual(['task-review', 'task-thread']);
  });
});

describe('the Home queue count', () => {
  /**
   * POSITIVE CONTROL, stated as arithmetic rather than as a literal: for a
   * workspace of legacy decision tasks the new total has to equal what the OLD
   * expression (`needs === 'decision' && !answer`, counted over open tasks)
   * returned. The derived row is open exactly when the task is unanswered, so
   * the two agree by construction — this pins that they do.
   */
  it('counts a legacy-decision workspace exactly as the old expression did', async () => {
    const ws = await seedWorkspace();
    await seedDecision(ws, 'keep disk or memory?');
    await seedDecision(ws, 'evict by age or by size?');
    const third = await seedDecision(ws, 'retain for a week or a month?');
    await jj(await post(`/api/tasks/${third.id}/answer`, { text: 'A week.', author: PERSON }));

    const { tasks } = await jj<{ tasks: Task[] }>(
      await fetch(`${base}/api/workspaces/${ws}/tasks`),
    );
    const oldTerm = tasks.filter(
      (t) => t.status !== 'done' && t.needs === 'decision' && !t.answer,
    ).length;
    expect(oldTerm).toBe(2);
    expect(await queueRows(ws)).toHaveLength(oldTerm);
  });

  /**
   * …and the count really did move. A ticket that is NOT a decision, holding
   * two open review items, contributed ZERO to the old expression — so the
   * deterministic brief said the queue was empty while two questions sat on it.
   */
  it('says the queue is non-empty for a non-decision ticket holding review items', async () => {
    const ws = await seedWorkspace();
    const task = await seedAction(ws);
    expect(await briefLine(ws)).toContain('Nothing is queued for your review right now.');
    for (const headline of ['Which cache?', 'Which eviction rule?']) {
      expect(
        handle.tasks.addReviewItem(task.id, { ...REVIEW, headline }, { actor: AGENT }).ok,
      ).toBe(true);
    }
    expect(await briefLine(ws)).toContain('What needs your review is queued below.');
  });
});

describe('the board projection', () => {
  /**
   * The browser reads the board off the ydoc projection and nothing else, so a
   * field only the store can see is the store-has-it/surface-can't-show-it bug
   * this codebase keeps re-deriving. `options` and `answer` keep projecting —
   * nothing is replaced, nothing is purged.
   */
  it('projects `reviews` beside `options` and `answer`', async () => {
    const ws = await seedWorkspace();
    const decision = await seedDecision(ws);
    await jj(
      await post(`/api/tasks/${decision.id}/answer`, { text: 'Keep disk.', author: PERSON }),
    );
    const action = await seedAction(ws);
    const added = handle.tasks.addReviewItem(action.id, REVIEW, { actor: AGENT });
    expect(added.ok).toBe(true);
    handle.projection.refresh(ws);

    const room = handle.rooms.get(`ws:${ws}`);
    if (!room) throw new Error('no board room');
    const map = room.ydoc.getMap('tasks');
    const projectedDecision = map.get(decision.id) as Record<string, unknown>;
    const projectedAction = map.get(action.id) as Record<string, unknown>;

    // Unchanged: the legacy fields still project, on the legacy task.
    expect(Array.isArray(projectedDecision.options)).toBe(true);
    expect((projectedDecision.answer as { text: string }).text).toBe('Keep disk.');
    expect(projectedDecision.reviews).toBeUndefined();

    // New: the sidecar rows reach the browser.
    const reviews = projectedAction.reviews as Array<{ id: string; review: ReviewPayload }>;
    expect(reviews).toHaveLength(1);
    expect(reviews[0].review.headline).toBe(REVIEW.headline);
  });
});
