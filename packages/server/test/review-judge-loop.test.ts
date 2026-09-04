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
 * What a judge FAILURE does — and what a crash mid-judge leaves behind — is
 * next door in `review-judge-recovery.test.ts`. The harness is shared.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  CONTRADICTORY_REASONS,
  COSTS_IN_OPTIONS,
  FILER,
  type Held,
  type JudgeHarness,
  contradictoryJudge,
  startJudgeHarness,
} from './review-judge-harness.ts';

describe('the review-item hold loop', () => {
  let h: JudgeHarness;
  let calls: JudgeHarness['calls'];
  const jj = <T>(res: Response | Promise<Response>) => h.jj<T>(res);
  const post = (path: string, body?: unknown) => h.post(path, body);
  const board = () => h.board();

  beforeEach(() => {
    h = startJudgeHarness();
    calls = h.calls;
  });
  afterEach(async () => {
    await h.stop();
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

  describe('what a hold can and cannot be spent on', () => {
    it('refuses a revision that changes nothing, so a no-op cannot burn a round', async () => {
      const { taskId } = await board();
      h.judge = contradictoryJudge();
      const filed = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items`, {
          author: FILER,
          review: COSTS_IN_OPTIONS,
        }),
      );
      const itemId = filed.item?.id as string;
      const before = calls.length;
      const res = await post(`/api/tasks/${taskId}/review-items/${itemId}/revise`, {
        author: FILER,
        headline: COSTS_IN_OPTIONS.headline,
        detail: COSTS_IN_OPTIONS.detail,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('no-change');
      // The judge was never asked, so the round was never spent.
      expect(calls.length).toBe(before);
    });

    it('resets the count when the filer withdraws the item and puts it back', async () => {
      const { taskId } = await board();
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
          detail: 'A second blurb.',
        }),
      );
      await jj(
        await post(`/api/tasks/${taskId}/review-items/${itemId}/withdraw`, { author: FILER }),
      );
      const back = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items/${itemId}/withdraw/undo`, { author: FILER }),
      );
      expect(back.item?.judge?.heldFor ?? []).toHaveLength(0);
      // A re-filed ask gets its two rounds back rather than being admitted
      // on the next hold.
      const next = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items/${itemId}/revise`, {
          author: FILER,
          detail: 'A third blurb, filed afresh.',
        }),
      );
      expect(next.held).toBe(true);
      expect(next.item?.judge?.heldFor).toHaveLength(1);
    });

    it('judges a post-admission change once more, and admits it if held again', async () => {
      const { taskId } = await board();
      h.judge = contradictoryJudge();
      const filed = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items`, {
          author: FILER,
          review: COSTS_IN_OPTIONS,
        }),
      );
      const itemId = filed.item?.id as string;
      const first = filed.heldReason as string;
      for (const detail of ['A second blurb.', 'A third blurb.']) {
        await jj(
          await post(`/api/tasks/${taskId}/review-items/${itemId}/revise`, {
            author: FILER,
            detail,
          }),
        );
      }
      const before = calls.length;
      const after = await jj<Held>(
        await post(`/api/tasks/${taskId}/review-items/${itemId}/revise`, {
          author: FILER,
          detail: 'A fourth blurb, written after the item was admitted.',
        }),
      );
      // Changed content IS judged again — admission is not a licence to
      // rewrite the item into anything unread.
      expect(calls.length).toBe(before + 1);
      // And it stays admitted, with the standing concern rather than the
      // judge's newest one.
      expect(after.held ?? false).toBe(false);
      expect(after.item?.judge?.reason).toContain(first.replace(/\.$/, ''));
    });
  });

  describe('a hold names the sentence it wants added', () => {
    const ADD = 'Nothing ships until the cache size is picked.';

    it('quotes that sentence in the message the filer is handed', async () => {
      const { taskId } = await board();
      h.judge = async () => ({
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
      h.judge = async () => ({
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
      h.judge = async () => ({ ok: false, reason: 'The detail never says what waits on this.' });
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
      h.judge = contradictoryJudge();
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
      h.judge = contradictoryJudge();
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
        await fetch(`${h.base}/api/workspaces/${workspaceId}/review-items`),
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
        CONTRADICTORY_REASONS[0],
        CONTRADICTORY_REASONS[1],
      ]);
    });

    it('shows the judge every reason it has already held this item for', async () => {
      const { taskId, itemId } = await heldTwice();
      expect(calls[0]?.item.priorHolds ?? []).toEqual([]);
      expect(calls[1]?.item.priorHolds).toEqual([CONTRADICTORY_REASONS[0]]);
      await jj(
        await post(`/api/tasks/${taskId}/review-items/${itemId}/revise`, {
          author: FILER,
          detail: 'Picking a size unblocks the rollout, which is otherwise stopped.',
        }),
      );
      expect(calls[2]?.item.priorHolds).toHaveLength(2);
    });
  });
});
