/**
 * The review-item quality gate, through the real routes.
 *
 * Bryan, 2026-08-29: *"Don't refuse, but let's have a criteria for what makes
 * a good review item. Something we can change in the settings. It's a natural
 * language prompt. If the review item an agent adds is not good enough, make
 * the item pending. Let the agent know they should edit it. And include this
 * in the stall monitor. If a review item's been unacceptable for more than 5
 * minutes. Complain."*
 *
 * The judge is a STUB throughout — never the real API. What is asserted is
 * everything around it: which words reach it, what a hold does to the queue,
 * what a revision undoes, who gets woken, and what the stall loop says.
 *
 * All fixtures are synthetic — invented names and generic personas. The repo
 * is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_REVIEW_ITEM_CRITERIA } from '@feedback/core/review-judge-prompt';
import type { ReviewJudgeInput, ReviewJudgeVerdict } from '../src/review-judge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { REVIEW_ITEM_HELD_EVENT, STALL_EVENT } from '../src/stall-nudge.ts';
import { projectTask } from '../src/task-projection.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
const FILER = { id: 'agent-index-keeper', name: 'Index Keeper', kind: 'agent' };

/** A complete decision — the positive control a hold is measured against. */
const GOOD = {
  shape: 'decision',
  headline: 'Cache size for the nightly rebuild',
  detail:
    'A full pass reads the index once. Halving the cache makes it read twice and adds an hour.',
  options: [
    { id: 'o-7f3a', label: 'Keep it', detail: 'costs 2GB of disk' },
    { id: 'o-4b2e', label: 'Halve it', detail: 'adds an hour nightly' },
  ],
};
/** Valid at the door, and exactly what the gate is for. */
const BAD = {
  shape: 'decision' as const,
  headline: 'ri-77 cfg?',
  options: [
    { id: 'o-1', label: 'A' },
    { id: 'o-2', label: 'B' },
  ],
};

type Frame = { event: string; data?: Record<string, unknown> };

function listenFrames(res: Response): {
  frames: Frame[];
  /** Resolves on the stream's first bytes — see `agentStream`. */
  open: Promise<void>;
  stop: () => Promise<void>;
} {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let buf = '';
  let opened!: () => void;
  const open = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const pump = (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        opened();
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          const frame: Frame = { event: 'message' };
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) frame.event = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              try {
                frame.data = JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>;
              } catch {}
            }
          }
          if (frame.event !== 'message') frames.push(frame);
        }
      }
    } catch {}
  })();
  return {
    frames,
    open,
    stop: async () => {
      stopped = true;
      opened();
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** SSE frames are pushed, not polled for, so this returns the moment the
 *  nth arrives. The deadline matters only when one never does — and it must
 *  stay well under the timeout of the test that calls it, or a missing frame
 *  is reported as "this test took too long" instead of as the miss it is.
 *  Tests that wait on frames pass `SSE_TEST_TIMEOUT_MS` for that reason. */
const SSE_TEST_TIMEOUT_MS = 30_000;

async function waitForFrames(frames: Frame[], event: string, n: number, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = frames.filter((f) => f.event === event);
    if (got.length >= n || Date.now() > deadline) return got;
    await settle(20);
  }
}

interface QueueRow {
  kind: string;
  taskId?: string;
  reviewItemId?: string;
  askedAt?: number;
  since?: number;
}

describe('the review-item quality gate', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  /** What the stub answers next. `null` is "the judge could not answer";
   *  `'throw'` is the judge blowing up. */
  let verdict: ReviewJudgeVerdict | null | 'throw' | 'defer';
  let calls: ReviewJudgeInput[];
  /** Judge calls parked by `'defer'`, released by the test in its own order. */
  let parked: Array<(v: ReviewJudgeVerdict | null) => void>;

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
  const put = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (path: string) => fetch(`${base}${path}`);

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'review-gate-'));
    verdict = { ok: true, reason: 'fine' };
    calls = [];
    parked = [];
    handle = createServer({
      port: 0,
      dataDir,
      reviewJudge: async (input) => {
        calls.push(input);
        if (verdict === 'throw') throw new Error('judge exploded');
        if (verdict === 'defer') return new Promise((resolve) => parked.push(resolve));
        return verdict;
      },
      // Held items are overdue the instant the loop reads them — the 5-minute
      // wall clock is pinned in the unit test next door.
      heldReviewItemMs: 0,
      stallNudgeQuietMs: 60 * 60_000,
    });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function board(): Promise<{ workspaceId: string; taskId: string }> {
    const { workspace } = await jj<{ workspace: { id: string } }>(
      await post('/api/workspaces', { name: 'index-rebuild', leadAgentId: LEAD.id }),
    );
    const { task } = await jj<{ task: { id: string } }>(
      await post(`/api/workspaces/${workspace.id}/tasks`, {
        title: 'Rebuild the index nightly',
        body: 'Agent can rebuild the index so that search stays fresh.',
        assignee: FILER.name,
        assigneeKind: 'agent',
        author: FILER,
      }),
    );
    await jj(
      await post(`/api/tasks/${task.id}/transition`, {
        to: 'todo',
        author: PERSON,
        workspaceId: workspace.id,
      }),
    );
    return { workspaceId: workspace.id, taskId: task.id };
  }

  async function queue(workspaceId: string): Promise<QueueRow[]> {
    const { items } = await jj<{ items: QueueRow[] }>(
      await get(`/api/workspaces/${workspaceId}/review-items`),
    );
    return items.filter((i) => i.kind === 'task-review');
  }

  async function agentStream(workspaceId: string, agent: { id: string }) {
    await jj(
      await post(`/api/workspaces/${workspaceId}/attachments`, {
        agentId: agent.id,
        runtime: 'claude-code-local',
      }),
    );
    const res = await fetch(
      `${base}/events/workspace/${workspaceId}?agentId=${encodeURIComponent(agent.id)}`,
      { headers: { accept: 'text/event-stream' } },
    );
    const stream = listenFrames(res);
    // `fetch` resolves on the response HEADERS, and the hub registers this
    // stream's sink inside the body's `start()` — which enqueues its `:ok`
    // preamble in the same synchronous block. So the first BYTES are proof
    // the sink is registered, and headers alone are not: without this await,
    // a wake aimed at an agent whose stream had not landed yet was dropped,
    // and the loop that owes it does not tick again for a minute.
    await stream.open;
    return stream;
  }

  describe('settings — the criteria are a workspace prompt', () => {
    it('reads the default until somebody writes, and round-trips a write', async () => {
      const { workspaceId } = await board();
      const before = await jj<{ reviewItemCriteria: { value: string; isDefault: boolean } }>(
        await get(`/api/workspaces/${workspaceId}/settings`),
      );
      expect(before.reviewItemCriteria.isDefault).toBe(true);
      expect(before.reviewItemCriteria.value).toBe(DEFAULT_REVIEW_ITEM_CRITERIA);

      await jj(
        await put(`/api/workspaces/${workspaceId}/settings`, {
          reviewItemCriteria: 'Every headline is a question.',
          author: PERSON,
        }),
      );
      const after = await jj<{ reviewItemCriteria: { value: string; isDefault: boolean } }>(
        await get(`/api/workspaces/${workspaceId}/settings`),
      );
      expect(after.reviewItemCriteria).toMatchObject({
        value: 'Every headline is a question.',
        isDefault: false,
      });
      // The workspace payload carries it too, so get_workspace can show it.
      const { workspace } = await jj<{ workspace: { reviewItemCriteria?: string } }>(
        await get(`/api/workspaces/${workspaceId}`),
      );
      expect(workspace.reviewItemCriteria).toBe('Every headline is a question.');
    });

    it('a null write returns the board to the default', async () => {
      const { workspaceId } = await board();
      await jj(
        await put(`/api/workspaces/${workspaceId}/settings`, {
          reviewItemCriteria: 'custom',
          author: PERSON,
        }),
      );
      await jj(
        await put(`/api/workspaces/${workspaceId}/settings`, {
          reviewItemCriteria: null,
          author: PERSON,
        }),
      );
      const after = await jj<{ reviewItemCriteria: { isDefault: boolean } }>(
        await get(`/api/workspaces/${workspaceId}/settings`),
      );
      expect(after.reviewItemCriteria.isDefault).toBe(true);
    });

    it('refuses a non-string criteria and an unknown board', async () => {
      const { workspaceId } = await board();
      const bad = await put(`/api/workspaces/${workspaceId}/settings`, {
        reviewItemCriteria: 42,
        author: PERSON,
      });
      expect(bad.status).toBe(400);
      const missing = await get('/api/workspaces/w-nope/settings');
      expect(missing.status).toBe(404);
    });

    it('the changed prompt is what the judge is asked with', async () => {
      const { workspaceId, taskId } = await board();
      await jj(await post(`/api/tasks/${taskId}/review-items`, { review: GOOD, author: FILER }));
      expect(calls.at(-1)?.criteria).toBe(DEFAULT_REVIEW_ITEM_CRITERIA);
      await jj(
        await put(`/api/workspaces/${workspaceId}/settings`, {
          reviewItemCriteria: 'Every headline is a question.',
          author: PERSON,
        }),
      );
      await jj(await post(`/api/tasks/${taskId}/review-items`, { review: GOOD, author: FILER }));
      expect(calls.at(-1)?.criteria).toBe('Every headline is a question.');
      expect(calls.at(-1)?.item.headline).toBe(GOOD.headline);
    });
  });

  describe('judge + pending', () => {
    it('a good item passes and is on the queue (positive control)', async () => {
      const { workspaceId, taskId } = await board();
      const res = await jj<{ item: { id: string; judge?: { verdict: string } }; held?: boolean }>(
        await post(`/api/tasks/${taskId}/review-items`, { review: GOOD, author: FILER }),
      );
      expect(res.held).toBeUndefined();
      expect(res.item.judge?.verdict).toBe('ok');
      expect(calls).toHaveLength(1);
      const rows = await queue(workspaceId);
      expect(rows.map((r) => r.reviewItemId)).toEqual([res.item.id]);
    });

    it('a bad item is held with the reason, off the queue, and on the task', async () => {
      verdict = { ok: false, reason: 'The headline is a ticket id, not a decision.' };
      const { workspaceId, taskId } = await board();
      const res = await jj<{
        item: { id: string; judge?: { verdict: string; reason: string; at: number } };
        held?: boolean;
        heldReason?: string;
        message?: string;
      }>(await post(`/api/tasks/${taskId}/review-items`, { review: BAD, author: FILER }));
      expect(res.held).toBe(true);
      expect(res.heldReason).toBe('The headline is a ticket id, not a decision.');
      // The filer is pointed at the fix, not just told no.
      expect(res.message).toContain('revise_review_item');
      expect(res.item.judge?.verdict).toBe('held');
      expect(res.item.judge?.at).toBeGreaterThan(0);

      expect(await queue(workspaceId)).toEqual([]);
      // Still on the ticket, verdict and reason readable there.
      const { tasks } = await jj<{
        tasks: Array<{
          id: string;
          reviews?: Array<{ id: string; judge?: { verdict: string; reason: string } }>;
        }>;
      }>(await get(`/api/workspaces/${workspaceId}/tasks`));
      const stored = tasks.find((t) => t.id === taskId)?.reviews?.find((r) => r.id === res.item.id);
      expect(stored?.judge).toMatchObject({
        verdict: 'held',
        reason: 'The headline is a ticket id, not a decision.',
      });
    });

    // The filer's agent id is store-only, like every actor id (§3.3): the
    // board projection carries the verdict and the display name, never
    // the id. Asserted on `projectTask` directly, which is the one door the
    // `ws:<id>` room reads through.
    it('the projection carries the verdict and drops the filer’s id', () => {
      const projected = projectTask({
        id: 't-1',
        workspaceId: 'w-1',
        title: 'Rebuild the index nightly',
        assignee: FILER.name,
        goal: 'chores',
        order: 1,
        status: 'todo',
        after: [],
        links: [],
        transitions: [],
        createdAt: 1,
        updatedAt: 1,
        reviews: [
          {
            id: 'ri-1',
            review: BAD,
            createdAt: 1,
            createdBy: FILER.name,
            judge: { at: 2, verdict: 'held', reason: 'No stakes named.' },
            filedBy: { id: FILER.id, name: FILER.name, kind: 'agent' },
          },
        ],
      }) as { reviews?: Array<Record<string, unknown>> };
      const row = projected.reviews?.[0];
      expect(row?.judge).toEqual({ at: 2, verdict: 'held', reason: 'No stakes named.' });
      expect(row).not.toHaveProperty('filedBy');
      expect(JSON.stringify(projected)).not.toContain(FILER.id);
    });

    it('a judge that cannot answer, or throws, passes the item through', async () => {
      const { workspaceId, taskId } = await board();
      verdict = null;
      const a = await jj<{ item: { id: string; judge?: { verdict: string } }; held?: boolean }>(
        await post(`/api/tasks/${taskId}/review-items`, { review: BAD, author: FILER }),
      );
      expect(a.held).toBeUndefined();
      expect(a.item.judge?.verdict).toBe('unavailable');
      verdict = 'throw';
      const b = await jj<{ item: { id: string; judge?: { verdict: string } }; held?: boolean }>(
        await post(`/api/tasks/${taskId}/review-items`, { review: BAD, author: FILER }),
      );
      expect(b.held).toBeUndefined();
      expect(b.item.judge?.verdict).toBe('unavailable');
      // One call each — no retry beyond the one.
      expect(calls).toHaveLength(2);
      const rows = await queue(workspaceId);
      expect(rows.map((r) => r.reviewItemId).sort()).toEqual([a.item.id, b.item.id].sort());
    });

    it('a review filed WITH the ticket goes through the same gate', async () => {
      verdict = { ok: false, reason: 'No stakes.' };
      const { workspaceId } = await board();
      const res = await jj<{ task: { id: string }; held?: boolean; heldReason?: string }>(
        await post(`/api/workspaces/${workspaceId}/tasks`, {
          title: 'Pick the eviction policy',
          body: 'Agent can pick a policy so that the cache stays warm.',
          review: BAD,
          author: FILER,
        }),
      );
      expect(res.held).toBe(true);
      expect(res.heldReason).toBe('No stakes.');
      expect(await queue(workspaceId)).toEqual([]);
    });

    // Found by codex review, fourth pass: for the seconds the judge took,
    // the item was on the queue — and answerable — before the hold landed.
    it('an item is off the queue from the moment it is filed, while the judge is out', async () => {
      verdict = 'defer';
      const { workspaceId, taskId } = await board();
      const filing = post(`/api/tasks/${taskId}/review-items`, { review: BAD, author: FILER });
      while (parked.length < 1) await settle(10);
      expect(await queue(workspaceId)).toEqual([]);
      const { tasks } = await jj<{
        tasks: Array<{ id: string; reviews?: Array<{ id: string; judge?: { verdict: string } }> }>;
      }>(await get(`/api/workspaces/${workspaceId}/tasks`));
      expect(tasks.find((t) => t.id === taskId)?.reviews?.[0]?.judge?.verdict).toBe('pending');
      // The control: the verdict arriving is what puts it on the queue.
      parked[0]?.({ ok: true, reason: 'fine' });
      const filed = await jj<{ item: { id: string } }>(await filing);
      expect((await queue(workspaceId)).map((r) => r.reviewItemId)).toEqual([filed.item.id]);
    });

    it('a judge call the last process never got back from passes the item at boot', async () => {
      verdict = 'defer';
      const { workspaceId, taskId } = await board();
      const filing = post(`/api/tasks/${taskId}/review-items`, { review: BAD, author: FILER });
      while (parked.length < 1) await settle(10);
      // The process dies with the call out: stop() flushes the store with
      // `pending` on disk, and the parked judge never answers.
      await handle.stop();
      handle = createServer({ port: 0, dataDir, heldReviewItemMs: 0 });
      base = `http://localhost:${handle.port}`;
      const { tasks } = await jj<{
        tasks: Array<{ id: string; reviews?: Array<{ id: string; judge?: { verdict: string } }> }>;
      }>(await get(`/api/workspaces/${workspaceId}/tasks`));
      const row = tasks.find((t) => t.id === taskId)?.reviews?.[0];
      expect(row?.judge?.verdict).toBe('unavailable');
      expect((await queue(workspaceId)).map((r) => r.reviewItemId)).toEqual([row?.id]);
      parked[0]?.({ ok: false, reason: 'too late' });
      await filing.catch(() => undefined);
    });

    // Found by codex review: two judge calls in flight for one item — the
    // filing's and a revision's — can finish in either order, and the
    // earlier one used to stamp its verdict onto words it never read.
    it('a verdict that outlives the words it judged is dropped; the revision’s own stands', async () => {
      verdict = 'defer';
      const { workspaceId, taskId } = await board();
      const filing = post(`/api/tasks/${taskId}/review-items`, { review: BAD, author: FILER });
      // The route is awaiting the judge; the item already exists in the
      // store, so a revision can land on it now.
      while (parked.length < 1) await settle(10);
      const { tasks } = await jj<{ tasks: Array<{ id: string; reviews?: Array<{ id: string }> }> }>(
        await get(`/api/workspaces/${workspaceId}/tasks`),
      );
      const itemId = tasks.find((t) => t.id === taskId)?.reviews?.[0]?.id;
      expect(itemId).toBeTruthy();
      const revising = post(`/api/tasks/${taskId}/review-items/${itemId}/revise`, {
        ...GOOD,
        author: FILER,
      });
      while (parked.length < 2) await settle(10);
      // The revision's judge answers first: ok. Then the ORIGINAL filing's
      // judge comes back holding — about words that are gone.
      parked[1]?.({ ok: true, reason: 'fine' });
      const revised = await jj<{ held?: boolean }>(await revising);
      expect(revised.held).toBeUndefined();
      parked[0]?.({ ok: false, reason: 'The headline is a ticket id.' });
      const filed = await jj<{ held?: boolean; item: { judge?: { verdict: string } } }>(
        await filing,
      );
      // The stale verdict is not applied — not to the row, not to the
      // response, and the item is on the queue.
      expect(filed.held).toBeUndefined();
      expect(filed.item.judge?.verdict).toBe('ok');
      expect((await queue(workspaceId)).map((r) => r.reviewItemId)).toEqual([itemId]);
    });

    // Found by codex review, second pass: the stale branch always said
    // "passed", even when the newer call had just HELD the item.
    it('a stale verdict does not un-say a hold the newer call just placed', async () => {
      verdict = 'defer';
      const { workspaceId, taskId } = await board();
      const filing = post(`/api/tasks/${taskId}/review-items`, { review: BAD, author: FILER });
      while (parked.length < 1) await settle(10);
      const { tasks } = await jj<{ tasks: Array<{ id: string; reviews?: Array<{ id: string }> }> }>(
        await get(`/api/workspaces/${workspaceId}/tasks`),
      );
      const itemId = tasks.find((t) => t.id === taskId)?.reviews?.[0]?.id;
      const revising = post(`/api/tasks/${taskId}/review-items/${itemId}/revise`, {
        ...BAD,
        headline: 'cfg ri-78?',
        author: FILER,
      });
      while (parked.length < 2) await settle(10);
      parked[1]?.({ ok: false, reason: 'Still a ticket id.' });
      const revised = await jj<{ held?: boolean; heldReason?: string }>(await revising);
      expect(revised.held).toBe(true);
      parked[0]?.({ ok: true, reason: 'fine' });
      const filed = await jj<{ held?: boolean; heldReason?: string }>(await filing);
      // The filing's response reports the hold that stands, with its reason.
      expect(filed.held).toBe(true);
      expect(filed.heldReason).toBe('Still a ticket id.');
      expect(await queue(workspaceId)).toEqual([]);
    });

    // Found by codex review, second pass: with the judge turned off, a
    // revision of an item held earlier returned the held row unchanged —
    // off the queue forever, with nothing left that could clear it.
    it('with the judge off, revising a held item releases it', async () => {
      verdict = { ok: false, reason: 'No stakes.' };
      const { workspaceId, taskId } = await board();
      const filed = await jj<{ item: { id: string } }>(
        await post(`/api/tasks/${taskId}/review-items`, { review: BAD, author: FILER }),
      );
      expect(await queue(workspaceId)).toEqual([]);
      // The same data, a server with no judge: the key was removed.
      await handle.stop();
      handle = createServer({ port: 0, dataDir, heldReviewItemMs: 0 });
      base = `http://localhost:${handle.port}`;
      const revised = await jj<{ held?: boolean; item: { judge?: { verdict: string } } }>(
        await post(`/api/tasks/${taskId}/review-items/${filed.item.id}/revise`, {
          ...GOOD,
          author: FILER,
        }),
      );
      expect(revised.held).toBeUndefined();
      expect(revised.item.judge?.verdict).toBe('unavailable');
      expect((await queue(workspaceId)).map((r) => r.reviewItemId)).toEqual([filed.item.id]);
      // The control: an item never held is left unjudged with the gate off.
      const fresh = await jj<{ item: { judge?: unknown } }>(
        await post(`/api/tasks/${taskId}/review-items`, { review: GOOD, author: FILER }),
      );
      expect(fresh.item.judge).toBeUndefined();
    });

    it('a revision re-judges; ok clears the hold and keeps the original filing time', async () => {
      verdict = { ok: false, reason: 'No stakes.' };
      const { workspaceId, taskId } = await board();
      const filed = await jj<{ item: { id: string; createdAt: number } }>(
        await post(`/api/tasks/${taskId}/review-items`, { review: BAD, author: FILER }),
      );
      expect(await queue(workspaceId)).toEqual([]);

      // Still bad after the first revision: stays held, reason updated.
      verdict = { ok: false, reason: 'Options have no costs.' };
      await settle(5);
      const again = await jj<{
        held?: boolean;
        heldReason?: string;
        item: { judge?: { reason: string } };
      }>(
        await post(`/api/tasks/${taskId}/review-items/${filed.item.id}/revise`, {
          headline: 'Which cache size for the nightly rebuild?',
          author: FILER,
        }),
      );
      expect(again.held).toBe(true);
      expect(again.heldReason).toBe('Options have no costs.');
      expect(await queue(workspaceId)).toEqual([]);

      verdict = { ok: true, reason: 'Clear now.' };
      const cleared = await jj<{ held?: boolean; item: { judge?: { verdict: string } } }>(
        await post(`/api/tasks/${taskId}/review-items/${filed.item.id}/revise`, {
          detail: 'A full pass reads the index once; halving the cache adds an hour nightly.',
          author: FILER,
        }),
      );
      expect(cleared.held).toBeUndefined();
      expect(cleared.item.judge?.verdict).toBe('ok');
      const rows = await queue(workspaceId);
      expect(rows.map((r) => r.reviewItemId)).toEqual([filed.item.id]);
      // The queue ranks by when it was FILED, not when it was finally let in.
      expect(rows[0]?.askedAt).toBe(filed.item.createdAt);
      expect(calls).toHaveLength(3);
    });
  });

  describe('a batch that files reviews with its rows', () => {
    /** A batch row carrying a review, with a distinct headline per index so
     *  the holds can be matched back to the rows that sent them. */
    const row = (n: number) => ({
      title: `Rebuild shard ${n}`,
      body: 'Agent can rebuild a shard so that search stays fresh.',
      assignee: FILER.name,
      assigneeKind: 'agent',
      review: { ...BAD, headline: `shard ${n} cfg?` },
    });

    async function batchBoard(): Promise<string> {
      const { workspace } = await jj<{ workspace: { id: string } }>(
        await post('/api/workspaces', { name: 'index-rebuild', leadAgentId: LEAD.id }),
      );
      return workspace.id;
    }

    // Found by codex review, fifth pass: the batch used to await the judge
    // inside the row loop, so a hundred rows against a judge timing out at
    // eight seconds held the request for thirteen minutes. Parking every
    // call proves they are in flight together — in series, `parked` could
    // never reach two.
    it('puts its rows in front of the judge together, not one after the next', async () => {
      verdict = 'defer';
      const workspaceId = await batchBoard();
      const sent = post(`/api/workspaces/${workspaceId}/tasks/batch`, {
        tasks: [row(1), row(2), row(3)],
        author: FILER,
      });
      const deadline = Date.now() + 5_000;
      while (parked.length < 3 && Date.now() < deadline) await settle(10);
      expect(parked).toHaveLength(3);

      // Answered out of order, on purpose: the reply still reports the hold
      // against the row that filed it.
      parked[1]?.({ ok: false, reason: 'No stakes.' });
      parked[2]?.({ ok: true, reason: 'Fine.' });
      parked[0]?.({ ok: false, reason: 'No stakes.' });
      const res = await jj<{
        tasks: Array<{ id: string; title: string }>;
        held?: Array<{ taskId: string; heldReason: string; message: string }>;
      }>(await sent);
      const titleOf = (taskId: string) => res.tasks.find((t) => t.id === taskId)?.title;
      expect((res.held ?? []).map((h) => titleOf(h.taskId))).toEqual([
        'Rebuild shard 1',
        'Rebuild shard 2',
      ]);
      expect(res.held?.[0]?.heldReason).toBe('No stakes.');

      // The control: the row the judge passed is on the queue, and the two
      // it held are not.
      expect((await queue(workspaceId)).length).toBe(1);
    });

    it('reports no holds when the judge passes every row (control)', async () => {
      verdict = { ok: true, reason: 'Fine.' };
      const workspaceId = await batchBoard();
      const res = await jj<{ tasks: Array<{ id: string }>; held?: unknown[] }>(
        await post(`/api/workspaces/${workspaceId}/tasks/batch`, {
          tasks: [row(1), row(2)],
          author: FILER,
        }),
      );
      expect(res.tasks).toHaveLength(2);
      expect(res.held).toBeUndefined();
      expect((await queue(workspaceId)).length).toBe(2);
    });
  });

  describe('the reader overruling the gate', () => {
    // The UX review found 0 interactive elements in the held note against 2
    // in the answerable card beside it: if the judge was wrong, the reader
    // could do nothing but wait for an agent to reword the question.
    it('releasing a held item puts it on the queue, and says who', async () => {
      verdict = { ok: false, reason: 'No stakes.' };
      const { workspaceId, taskId } = await board();
      const { item } = await jj<{ item: { id: string } }>(
        await post(`/api/tasks/${taskId}/review-items`, { review: BAD, author: FILER }),
      );
      expect(await queue(workspaceId)).toEqual([]);

      const released = await jj<{
        released: boolean;
        item: { judge?: { verdict: string; reason: string } };
      }>(await post(`/api/tasks/${taskId}/review-items/${item.id}/release`, { author: PERSON }));
      expect(released.released).toBe(true);
      expect(released.item.judge?.verdict).toBe('ok');
      expect(released.item.judge?.reason).toContain(PERSON.name);
      expect((await queue(workspaceId)).map((r) => r.reviewItemId)).toEqual([item.id]);
    });

    // Found by codex review, third pass: a release does not change the
    // item's WORDS, so the version check alone still matched when the judge
    // came back — and its `held` overwrote the release, taking the item off
    // the queue seconds after the reader had been told it was on.
    it('a release issued while the judge is out survives its late verdict', async () => {
      verdict = 'defer';
      const { workspaceId, taskId } = await board();
      const filing = post(`/api/tasks/${taskId}/review-items`, { review: BAD, author: FILER });
      while (parked.length < 1) await settle(10);
      const { tasks } = await jj<{ tasks: Array<{ id: string; reviews?: Array<{ id: string }> }> }>(
        await get(`/api/workspaces/${workspaceId}/tasks`),
      );
      const itemId = tasks.find((t) => t.id === taskId)?.reviews?.[0]?.id as string;
      // The control: while the judge is out the item is off the queue, so the
      // release below is what puts it there and not the filing.
      expect(await queue(workspaceId)).toEqual([]);

      const released = await jj<{ released: boolean }>(
        await post(`/api/tasks/${taskId}/review-items/${itemId}/release`, { author: PERSON }),
      );
      expect(released.released).toBe(true);
      expect((await queue(workspaceId)).map((r) => r.reviewItemId)).toEqual([itemId]);

      // Now the judge answers, and it wants the item held.
      parked[0]?.({ ok: false, reason: 'No stakes.' });
      const filed = await jj<{ held?: boolean }>(await filing);
      // Nobody is told to go and revise something the reader already asked for.
      expect(filed.held ?? false).toBe(false);
      expect((await queue(workspaceId)).map((r) => r.reviewItemId)).toEqual([itemId]);
      const seen = await jj<{
        tasks: Array<{
          id: string;
          reviews?: Array<{ judge?: { verdict: string; reason: string } }>;
        }>;
      }>(await get(`/api/workspaces/${workspaceId}/tasks`));
      const judge = seen.tasks.find((t) => t.id === taskId)?.reviews?.[0]?.judge;
      expect(judge?.verdict).toBe('ok');
      expect(judge?.reason).toContain(PERSON.name);
    });

    it('is a no-op success on an item nothing is holding — two taps is not an error', async () => {
      verdict = { ok: true, reason: 'Fine.' };
      const { workspaceId, taskId } = await board();
      const { item } = await jj<{ item: { id: string } }>(
        await post(`/api/tasks/${taskId}/review-items`, { review: GOOD, author: FILER }),
      );
      const res = await jj<{ released: boolean }>(
        await post(`/api/tasks/${taskId}/review-items/${item.id}/release`, { author: PERSON }),
      );
      expect(res.released).toBe(false);
      // The control: it was already answerable, and still is.
      expect((await queue(workspaceId)).map((r) => r.reviewItemId)).toEqual([item.id]);
    });

    it('refuses an unknown item and a body with no author', async () => {
      verdict = { ok: false, reason: 'No stakes.' };
      const { taskId } = await board();
      expect(
        (await post(`/api/tasks/${taskId}/review-items/ri-nope/release`, { author: PERSON }))
          .status,
      ).toBe(404);
      const { item } = await jj<{ item: { id: string } }>(
        await post(`/api/tasks/${taskId}/review-items`, { review: BAD, author: FILER }),
      );
      expect((await post(`/api/tasks/${taskId}/review-items/${item.id}/release`, {})).status).toBe(
        400,
      );
    });

    it('a released item that its filer then revises is judged again', async () => {
      verdict = { ok: false, reason: 'No stakes.' };
      const { workspaceId, taskId } = await board();
      const { item } = await jj<{ item: { id: string } }>(
        await post(`/api/tasks/${taskId}/review-items`, { review: BAD, author: FILER }),
      );
      await jj(
        await post(`/api/tasks/${taskId}/review-items/${item.id}/release`, { author: PERSON }),
      );
      expect((await queue(workspaceId)).length).toBe(1);
      // The gate is not disarmed by a release — the next revision goes past
      // the judge like any other, and a still-bad one is held again.
      await jj(
        await post(`/api/tasks/${taskId}/review-items/${item.id}/revise`, {
          headline: 'ri-77 cfg still?',
          author: FILER,
        }),
      );
      expect(await queue(workspaceId)).toEqual([]);
    });
  });

  describe('agent wake', () => {
    it(
      'the filer is told which item was held, why, and to revise it',
      async () => {
        verdict = { ok: false, reason: 'The headline is a ticket id.' };
        const { workspaceId, taskId } = await board();
        const filer = await agentStream(workspaceId, FILER);
        const lead = await agentStream(workspaceId, LEAD);
        try {
          const res = await jj<{ item: { id: string } }>(
            await post(`/api/tasks/${taskId}/review-items`, { review: BAD, author: FILER }),
          );
          const [frame] = await waitForFrames(filer.frames, REVIEW_ITEM_HELD_EVENT, 1);
          expect(frame?.data).toMatchObject({
            workspaceId,
            taskId,
            reviewItemId: res.item.id,
            reason: 'The headline is a ticket id.',
            title: 'Rebuild the index nightly',
          });
          // Addressed to the filer alone: the lead is not woken over an item
          // that is not theirs to fix.
          await settle(150);
          expect(lead.frames.filter((f) => f.event === REVIEW_ITEM_HELD_EVENT)).toEqual([]);
        } finally {
          await filer.stop();
          await lead.stop();
        }
      },
      SSE_TEST_TIMEOUT_MS,
    );
  });

  describe('stall monitor', () => {
    it(
      'an overdue held item is a finding: the filer is nudged, then the lead — once per item',
      async () => {
        verdict = { ok: false, reason: 'No stakes.' };
        const { workspaceId, taskId } = await board();
        const filer = await agentStream(workspaceId, FILER);
        const lead = await agentStream(workspaceId, LEAD);
        try {
          const res = await jj<{ item: { id: string; judge?: { at: number } } }>(
            await post(`/api/tasks/${taskId}/review-items`, { review: BAD, author: FILER }),
          );
          // The create-time wake, so the counts below start from a known place.
          await waitForFrames(filer.frames, REVIEW_ITEM_HELD_EVENT, 1);

          // The window here is zero, and `overdueHeldItems` wants age > window
          // — so the hold is a finding only once the clock has actually moved
          // past the millisecond the judge stamped it in. Ticking inside that
          // same millisecond finds nothing, and the single tick below would
          // then wait out its whole deadline for a frame nobody was ever going
          // to send. One millisecond of real time makes the precondition true
          // and keeps it true; this is not a tuned timeout.
          const stampedAt = res.item.judge?.at;
          expect(stampedAt).toBeGreaterThan(0); // never vacuous: an absent stamp fails here
          await settle(5);
          expect(Date.now()).toBeGreaterThan(stampedAt as number);

          handle.nudgeStalls();
          const [stall] = await waitForFrames(lead.frames, STALL_EVENT, 1);
          expect(stall?.data).toMatchObject({
            workspaceId,
            stalledCount: 0,
            taskId,
          });
          const held = stall?.data?.heldItems as Array<Record<string, unknown>>;
          expect(held).toHaveLength(1);
          expect(held[0]).toMatchObject({
            id: taskId,
            reviewItemId: res.item.id,
            reason: 'No stakes.',
            filedBy: FILER.name,
          });
          const nudges = await waitForFrames(filer.frames, REVIEW_ITEM_HELD_EVENT, 2);
          expect(nudges).toHaveLength(2);
          expect(nudges[1]?.data).toMatchObject({ reviewItemId: res.item.id, overdue: true });

          // A second pass says nothing new to anybody.
          handle.nudgeStalls();
          await settle(200);
          expect(lead.frames.filter((f) => f.event === STALL_EVENT)).toHaveLength(1);
          expect(filer.frames.filter((f) => f.event === REVIEW_ITEM_HELD_EVENT)).toHaveLength(2);

          // Revising it away clears the finding; the board falls silent.
          verdict = { ok: true, reason: 'Clear.' };
          await jj(
            await post(`/api/tasks/${taskId}/review-items/${res.item.id}/revise`, {
              detail: 'Stakes: the nightly window.',
              author: FILER,
            }),
          );
          handle.nudgeStalls();
          await settle(200);
          expect(lead.frames.filter((f) => f.event === STALL_EVENT)).toHaveLength(1);
        } finally {
          await filer.stop();
          await lead.stop();
        }
      },
      SSE_TEST_TIMEOUT_MS,
    );
  });
});
