/**
 * What the quality gate does when the judge cannot answer, and what a crash
 * mid-judge leaves on disk.
 *
 * Both are about the same rule: fail-open is for an item nobody has judged,
 * never for one already held. A failure that admitted a held item made every
 * hold clearable by revising until a call timed out, and a recovery that
 * dropped the hold history reset the cap the loop fix depends on.
 *
 * The judge is a STUB throughout; all fixtures are invented.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from '../src/server.ts';
import {
  COSTS_IN_OPTIONS,
  FILER,
  type Held,
  type JudgeHarness,
  contradictoryJudge,
  startJudgeHarness,
} from './review-judge-harness.ts';

describe('the review-item gate when the judge is unreliable', () => {
  let h: JudgeHarness;
  const jj = <T>(res: Response | Promise<Response>) => h.jj<T>(res);
  const post = (path: string, body?: unknown) => h.post(path, body);
  const board = () => h.board();

  beforeEach(() => {
    h = startJudgeHarness();
  });
  afterEach(async () => {
    await h.stop();
  });

  describe('a judge that cannot answer', () => {
    it('leaves a held item held rather than admitting it on a failed call', async () => {
      const { taskId } = await board();
      h.judge = async () => ({ ok: false, reason: 'The detail does not say what waits on this.' });
      const filed = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items`, {
          author: FILER,
          review: COSTS_IN_OPTIONS,
        }),
      );
      const itemId = filed.item?.id as string;
      const heldAt = filed.item?.judge?.at;
      // The revision lands while the judge is unreadable — a truncated
      // reply, a timeout, a non-2xx. Admitting here would mean a filer
      // could clear any hold by revising until a call failed.
      h.judge = async () => null;
      const out = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items/${itemId}/revise`, {
          author: FILER,
          detail: 'A different blurb that does not close the gap either.',
        }),
      );
      expect(out.held).toBe(true);
      expect(out.item?.judge?.verdict).toBe('held');
      expect(out.item?.judge?.reason).toBe('The detail does not say what waits on this.');
      expect(out.message).toContain('could not answer');
      // The hold's own clock does not restart, or a failing judge would
      // keep the stall monitor from ever complaining about it.
      expect(out.item?.judge?.at).toBe(heldAt as number);
      // And the failed call is not a hold: it did not happen.
      expect(out.item?.judge?.heldFor).toHaveLength(1);
    });

    it('still passes an item nobody has held — the fail-open rule is intact', async () => {
      const { taskId } = await board();
      h.judge = async () => null;
      const out = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items`, {
          author: FILER,
          review: COSTS_IN_OPTIONS,
        }),
      );
      expect(out.held ?? false).toBe(false);
      expect(out.item?.judge?.verdict).toBe('unavailable');
    });

    it('does the same when the judge throws', async () => {
      const { taskId } = await board();
      h.judge = async () => ({ ok: false, reason: 'The detail does not say what waits on this.' });
      const filed = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items`, {
          author: FILER,
          review: COSTS_IN_OPTIONS,
        }),
      );
      const itemId = filed.item?.id as string;
      h.judge = async () => {
        throw new Error('judge exploded');
      };
      const out = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items/${itemId}/revise`, {
          author: FILER,
          detail: 'A different blurb that does not close the gap either.',
        }),
      );
      expect(out.held).toBe(true);
      expect(out.item?.judge?.verdict).toBe('held');
    });
  });

  describe('a server death mid-judge', () => {
    it('leaves the hold history intact, so the cap is not reset by a crash', async () => {
      const { workspaceId, taskId } = await board();
      h.judge = contradictoryJudge();
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
      await h.handle.stop();
      const file = join(h.dataDir, 'workspaces', `${workspaceId}.tasks.json`);
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
      h.handle = createServer({ port: 0, dataDir: h.dataDir, heldReviewItemMs: 0 });
      const listed = (await (
        await fetch(`http://localhost:${h.handle.port}/api/workspaces/${workspaceId}/tasks`)
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
});
