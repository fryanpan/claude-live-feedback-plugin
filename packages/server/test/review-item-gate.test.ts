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

function listenFrames(res: Response): { frames: Frame[]; stop: () => Promise<void> } {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let buf = '';
  const pump = (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
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
    stop: async () => {
      stopped = true;
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

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
  let verdict: ReviewJudgeVerdict | null | 'throw';
  let calls: ReviewJudgeInput[];

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
    handle = createServer({
      port: 0,
      dataDir,
      reviewJudge: async (input) => {
        calls.push(input);
        if (verdict === 'throw') throw new Error('judge exploded');
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
    return listenFrames(res);
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

  describe('agent wake', () => {
    it('the filer is told which item was held, why, and to revise it', async () => {
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
    });
  });

  describe('stall monitor', () => {
    it('an overdue held item is a finding: the filer is nudged, then the lead — once per item', async () => {
      verdict = { ok: false, reason: 'No stakes.' };
      const { workspaceId, taskId } = await board();
      const filer = await agentStream(workspaceId, FILER);
      const lead = await agentStream(workspaceId, LEAD);
      try {
        const res = await jj<{ item: { id: string } }>(
          await post(`/api/tasks/${taskId}/review-items`, { review: BAD, author: FILER }),
        );
        // The create-time wake, so the counts below start from a known place.
        await waitForFrames(filer.frames, REVIEW_ITEM_HELD_EVENT, 1);

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
    });
  });
});
