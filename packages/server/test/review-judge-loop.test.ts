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
import { mkdtempSync, rmSync } from 'node:fs';
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
  item?: { id: string; judge?: { verdict: string; reason: string; heldFor?: string[] } };
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

  describe('costs stated only in the options', () => {
    it('is not held for missing costs — the option details reach the judge', async () => {
      const { taskId } = await board();
      const out = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items`, { author: FILER, review: COSTS_IN_OPTIONS }),
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
        await post(`/api/tasks/${taskId}/review-items`, { author: FILER, review: COSTS_IN_OPTIONS }),
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
