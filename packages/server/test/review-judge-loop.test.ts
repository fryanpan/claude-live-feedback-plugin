/**
 * The hold loop — what stops the quality gate asking, round after round, for
 * something the item already says.
 *
 * Reported by a peer on 2026-09-04: one decision item was held eight times
 * with contradictory reasons, and the last hold asked for costs the options
 * stated verbatim. The peer's reading was that option `detail` fields were
 * dropped before the judge saw them. The first describe block below is the
 * control for that reading, driven through the REAL prompt builder: it holds
 * only when the costs are genuinely absent from the words the model reads.
 *
 * The judge is a STUB throughout — never the real API. All fixtures are
 * invented; the repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReviewJudgePrompt } from '@feedback/core/review-judge-prompt';
import type { ReviewJudge, ReviewJudgeInput } from '../src/review-judge.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };
const LEAD = { id: 'agent-cartographer', name: 'Cartographer', kind: 'agent' };
const FILER = { id: 'agent-index-keeper', name: 'Index Keeper', kind: 'agent' };

/** A decision whose costs live ONLY in the option details — the shape the
 *  peer filed, and the one the gate kept asking for costs on. */
const COSTS_IN_OPTIONS = {
  shape: 'decision' as const,
  headline: 'Which cache size for the nightly rebuild',
  detail: 'The rebuild runs at 02:00 and has to finish before the morning sync.',
  options: [
    { id: 'o-1', label: 'Keep it', detail: 'costs 2GB of disk and no extra time' },
    { id: 'o-2', label: 'Halve it', detail: 'frees 1GB but adds an hour to every night' },
  ],
};

/**
 * A judge that holds for missing costs EXACTLY when the costs are missing
 * from the words it was given.
 *
 * It reads the user turn the real builder produces, not the input object, so
 * anything between the filing route and the model that drops an option detail
 * turns this into a hold. That is what makes it a control rather than a
 * restatement of the code under test.
 */
const costReadingJudge: ReviewJudge = async (input: ReviewJudgeInput) => {
  const { user } = buildReviewJudgePrompt(input.criteria, input.item);
  const stated = (input.item.options ?? [])
    .map((o) => o.detail?.trim())
    .filter((d): d is string => !!d);
  const unread = stated.filter((cost) => !user.includes(cost));
  return unread.length > 0 || stated.length === 0
    ? { ok: false, reason: 'No option says what choosing it costs.' }
    : { ok: true, reason: 'Every option names what choosing it costs.' };
};

interface Held {
  held?: boolean;
  heldReason?: string;
  message?: string;
  item?: {
    id: string;
    judge?: { verdict: string; reason: string; heldFor?: string[]; add?: string };
  };
}

describe('the review-item hold loop', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  /** Swapped per test. Defaults to the cost-reading control. */
  let judge: ReviewJudge;
  const calls: ReviewJudgeInput[] = [];

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

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'judge-loop-'));
    calls.length = 0;
    judge = costReadingJudge;
    handle = createServer({
      port: 0,
      dataDir,
      reviewJudge: async (input) => {
        calls.push(input);
        return judge(input);
      },
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

  /** A judge that never passes anything and never repeats itself — the
   *  behaviour the peer met eight times over. */
  function contradictoryJudge(): ReviewJudge {
    const reasons = [
      'The detail does not say what waits on this.',
      'The headline is not in the reader’s own words.',
      'No option says what choosing it costs.',
      'The links are not inline on the words they explain.',
    ];
    let n = 0;
    return async () => ({ ok: false, reason: reasons[n++ % reasons.length] as string });
  }

  describe('a server death mid-judge', () => {
    it('leaves the hold history intact, so the cap is not reset by a crash', async () => {
      const { workspaceId, taskId } = await board();
      judge = contradictoryJudge();
      const filed = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items`, {
          author: FILER,
          review: COSTS_IN_OPTIONS,
        }),
      );
      const itemId = filed.item?.id as string;
      await jj(
        await post(`/api/tasks/${taskId}/review-items/${itemId}/revise`, {
          author: FILER,
          detail: 'The rollout waits on this: nothing ships until the size is picked.',
        }),
      );
      // The state a process death mid-judge leaves on disk: a `pending`
      // stamp nobody will ever replace, on top of two real holds. The
      // sidecar is written on shutdown, so the server goes down first.
      await handle.stop();
      const file = join(dataDir, 'workspaces', `${workspaceId}.tasks.json`);
      const disk = JSON.parse(readFileSync(file, 'utf8')) as {
        tasks: Array<{
          id: string;
          reviews?: Array<{ id: string; judge?: Record<string, unknown> }>;
        }>;
      };
      const stored = disk.tasks
        .find((t) => t.id === taskId)
        ?.reviews?.find((r) => r.id === itemId) as { judge?: Record<string, unknown> };
      expect(stored.judge?.heldFor).toHaveLength(2);
      stored.judge = { ...stored.judge, verdict: 'pending', reason: 'being judged' };
      writeFileSync(file, JSON.stringify(disk));

      // Boot a second server on the same data dir — the recovery path.
      // `afterEach` stops whatever `handle` names, so it names this one now.
      handle = createServer({ port: 0, dataDir, heldReviewItemMs: 0 });
      const listed = (await (
        await fetch(`http://localhost:${handle.port}/api/workspaces/${workspaceId}/tasks`)
      ).json()) as {
        tasks: Array<{
          id: string;
          reviews?: Array<{ id: string; judge?: { verdict: string; heldFor?: string[] } }>;
        }>;
      };
      const back = listed.tasks.find((t) => t.id === taskId)?.reviews?.find((r) => r.id === itemId);
      expect(back?.judge?.verdict).toBe('unavailable');
      expect(back?.judge?.heldFor).toHaveLength(2);
    });
  });

  describe('a hold names the sentence it wants added', () => {
    const ADD = 'Nothing ships until the cache size is picked.';

    it('quotes that sentence in the message the filer is handed', async () => {
      const { taskId } = await board();
      judge = async () => ({
        ok: false,
        reason: 'The detail never says what waits on this.',
        add: ADD,
      });
      const filed = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items`, {
          author: FILER,
          review: COSTS_IN_OPTIONS,
        }),
      );
      expect(filed.held).toBe(true);
      expect(filed.message).toContain(ADD);
      // The address still has to be there — a sentence to add is no use
      // without the call that applies it.
      expect(filed.message).toContain('revise_review_item');
    });

    it('keeps it on the item, so the ticket and the wake say the same thing', async () => {
      const { taskId } = await board();
      judge = async () => ({
        ok: false,
        reason: 'The detail never says what waits on this.',
        add: ADD,
      });
      const filed = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items`, {
          author: FILER,
          review: COSTS_IN_OPTIONS,
        }),
      );
      expect(filed.item?.judge?.add).toBe(ADD);
    });

    it('says nothing extra when the judge offered no sentence — the control', async () => {
      const { taskId } = await board();
      judge = async () => ({ ok: false, reason: 'The detail never says what waits on this.' });
      const filed = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items`, {
          author: FILER,
          review: COSTS_IN_OPTIONS,
        }),
      );
      expect(filed.message).toContain('The detail never says what waits on this');
      expect(filed.message).not.toContain('Add this sentence');
      expect(filed.item?.judge?.add).toBeUndefined();
    });
  });

  describe('after two holds the gate stops holding', () => {
    async function heldTwice(): Promise<{
      workspaceId: string;
      taskId: string;
      itemId: string;
      first: string;
      second: Held;
    }> {
      const { workspaceId, taskId } = await board();
      judge = contradictoryJudge();
      const filed = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items`, {
          author: FILER,
          review: COSTS_IN_OPTIONS,
        }),
      );
      expect(filed.held).toBe(true);
      const itemId = filed.item?.id as string;
      const first = filed.heldReason as string;
      const second = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items/${itemId}/revise`, {
          author: FILER,
          detail: 'The rollout waits on this: nothing ships until the size is picked.',
        }),
      );
      expect(second.held).toBe(true);
      return { workspaceId, taskId, itemId, first, second };
    }

    it('says on the LAST hold that it is the last one', async () => {
      const { second } = await heldTwice();
      // The promise the earlier message made — "the item reaches the queue
      // when it passes" — stops being the whole truth at the cap, and a
      // filer told otherwise is a filer bracing for a fourth round.
      expect(second.message).toContain('last hold');
      expect(second.message).not.toContain('reaches the queue when it passes');
    });

    it('does not say that on the first hold — the control', async () => {
      const { taskId } = await board();
      judge = contradictoryJudge();
      const filed = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items`, {
          author: FILER,
          review: COSTS_IN_OPTIONS,
        }),
      );
      expect(filed.message).toContain('reaches the queue when it passes');
      expect(filed.message).not.toContain('last hold');
    });

    it('accepts the third revision instead of holding it a third time', async () => {
      const { taskId, itemId } = await heldTwice();
      const third = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items/${itemId}/revise`, {
          author: FILER,
          detail: 'Picking a size unblocks the rollout, which is otherwise stopped.',
        }),
      );
      expect(third.held ?? false).toBe(false);
      expect(third.item?.judge?.verdict).toBe('ok');
    });

    it('puts the item on the reader’s queue rather than leaving it in limbo', async () => {
      const { workspaceId, taskId, itemId } = await heldTwice();
      await jj(
        await post(`/api/tasks/${taskId}/review-items/${itemId}/revise`, {
          author: FILER,
          detail: 'Picking a size unblocks the rollout, which is otherwise stopped.',
        }),
      );
      const { items } = await jj<{ items: Array<{ reviewItemId?: string }> }>(
        await fetch(`${base}/api/workspaces/${workspaceId}/review-items`),
      );
      expect(items.some((i) => i.reviewItemId === itemId)).toBe(true);
    });

    it('tells the reader why in ONE sentence, and it is the standing concern rather than a fresh one', async () => {
      const { taskId, itemId, first } = await heldTwice();
      const third = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items/${itemId}/revise`, {
          author: FILER,
          detail: 'Picking a size unblocks the rollout, which is otherwise stopped.',
        }),
      );
      const reason = third.item?.judge?.reason as string;
      // The FIRST hold's words, not a fourth invention — that is what
      // "never a fresh contradictory reason" means.
      expect(reason).toContain(first.replace(/\.$/, ''));
      // One sentence, enforced where it is produced rather than counted
      // here: a verdict is cut to its first sentence on the way in, so the
      // sentence built around it has exactly one terminator.
      expect(reason.match(/[.?!]\s+\S/)).toBeNull();
    });

    it('counts the holds on the item itself, so the cap outlives this request', async () => {
      const { second } = await heldTwice();
      expect(second.item?.judge?.heldFor).toEqual([
        'The detail does not say what waits on this.',
        'The headline is not in the reader’s own words.',
      ]);
    });

    it('shows the judge every reason it has already held this item for', async () => {
      const { taskId, itemId } = await heldTwice();
      expect(calls[0]?.item.priorHolds ?? []).toEqual([]);
      expect(calls[1]?.item.priorHolds).toEqual(['The detail does not say what waits on this.']);
      await jj(
        await post(`/api/tasks/${taskId}/review-items/${itemId}/revise`, {
          author: FILER,
          detail: 'Picking a size unblocks the rollout, which is otherwise stopped.',
        }),
      );
      expect(calls[2]?.item.priorHolds).toHaveLength(2);
    });
  });

  describe('costs stated only in the options', () => {
    it('is not held for missing costs — the option details reach the judge', async () => {
      const { taskId } = await board();
      const out = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items`, {
          author: FILER,
          review: COSTS_IN_OPTIONS,
        }),
      );
      expect(out.held ?? false).toBe(false);
      expect(calls[0]?.item.options?.map((o) => o.detail)).toEqual([
        'costs 2GB of disk and no extra time',
        'frees 1GB but adds an hour to every night',
      ]);
    });

    it('the control still holds when the options genuinely state no cost', async () => {
      const { taskId } = await board();
      const out = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items`, {
          author: FILER,
          review: {
            ...COSTS_IN_OPTIONS,
            options: [
              { id: 'o-1', label: 'Keep it' },
              { id: 'o-2', label: 'Halve it' },
            ],
          },
        }),
      );
      expect(out.held).toBe(true);
      expect(out.heldReason).toContain('costs');
    });

    it('keeps the costs in front of the judge across a revision that leaves the options alone', async () => {
      const { taskId } = await board();
      const filed = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items`, {
          author: FILER,
          review: COSTS_IN_OPTIONS,
        }),
      );
      const itemId = filed.item?.id as string;
      const out = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items/${itemId}/revise`, {
          author: FILER,
          headline: 'Which cache size the nightly rebuild should use',
          detail: 'The rollout waits on this: nothing ships until the size is picked.',
        }),
      );
      expect(out.held ?? false).toBe(false);
      expect(calls.at(-1)?.item.options?.map((o) => o.detail)).toEqual([
        'costs 2GB of disk and no extra time',
        'frees 1GB but adds an hour to every night',
      ]);
    });
  });
});
