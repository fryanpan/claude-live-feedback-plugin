/**
 * A ticket HAS review items — 0..n of them, several possibly open at once —
 * and the one decision it used to BE reads as one without being rewritten.
 *
 * Two halves, and the second is the reason the first is safe. `addReviewItem`
 * / `listReviewItems` / `answerTaskReview` are the new spelling; the legacy
 * `needs: 'decision'` + `options` + `answer` spelling is NEVER touched, only
 * DERIVED from at read time. Nothing migrates on disk, so nothing can be lost
 * by a migration that ran twice or half-way.
 *
 * All fixtures are synthetic — invented ids and generic personas. The repo is
 * public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewPayload, TaskReviewItem } from '@feedback/core';
import { TaskStore, type TaskStoreEvent } from '../src/tasks.ts';

const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'known' };
const AGENT = { id: 'agent-scheduler', name: 'Scheduler Agent', kind: 'known' };

/** A body that clears the legacy decision-shape gate, so a test about review
 *  items is not accidentally a test about that gate. */
const SHAPED = [
  'Do we ship the walkthrough on by default, or behind a flag?',
  '',
  'A flag buys confidence and costs a second code path nobody remembers to',
  'delete.',
  '',
  'Blocked until answered: the board strip and the mobile pass.',
].join('\n');

/** A well-formed review payload — the writer's gate is exercised elsewhere. */
function payload(over: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    shape: 'decision',
    headline: 'Which cache do we keep?',
    detail: 'Both caches answer the same reads; keeping both doubles the invalidation paths.',
    options: [
      // 1–3 words each: the shared gate refuses a longer button face.
      { id: 'o-7f3a', label: 'Keep disk' },
      { id: 'o-4b2e', label: 'Keep memory' },
    ],
    ...over,
  };
}

describe('review items on a task', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-review-items-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const seedDecision = (options?: Array<{ label: string; detail?: string }>) => {
    const ws = store.createWorkspace('ws');
    const res = store.createTask(ws.id, {
      title: 'Walkthrough rollout',
      assignee: 'human',
      needs: 'decision',
      body: SHAPED,
      ...(options ? { options } : {}),
    });
    if (!res.ok) throw new Error(`create failed: ${res.error}`);
    return res.task;
  };

  // ── the legacy decision reads as one review item ─────────────────────────

  describe('a legacy decision task derives exactly one review item', () => {
    it('reports one row whose headline is the TITLE and whose options keep the minted ids', () => {
      const task = seedDecision([{ label: 'On by default' }, { label: 'Behind a flag' }]);
      const items = store.listReviewItems(task.id);
      expect(items).toHaveLength(1);
      const item = items[0];
      if (!item) return;
      expect(item.id).toBe('r-legacy');
      expect(item.review.shape).toBe('decision');
      expect(item.review.headline).toBe('Walkthrough rollout');
      expect(item.review.detail).toBe(SHAPED);
      // The SAME ids the store minted — re-minting would orphan every
      // `answer.optionId` already recorded against them.
      expect(item.review.options?.map((o) => o.id)).toEqual(task.options?.map((o) => o.id));
      expect(item.review.options?.map((o) => o.label)).toEqual(['On by default', 'Behind a flag']);
      expect(item.answer).toBeUndefined();
    });

    it('carries the legacy answer across, so an answered decision is not read as open', () => {
      const task = seedDecision([{ label: 'On by default' }, { label: 'Behind a flag' }]);
      const picked = task.options?.[1];
      if (!picked) throw new Error('no option');
      store.answerDecision(task.id, picked.label, { actor: PERSON, optionId: picked.id });
      const item = store.listReviewItems(task.id)[0];
      expect(item?.answer?.text).toBe('Behind a flag');
      expect(item?.answer?.answeredWith).toBe(picked.id);
      expect(item?.answer?.by).toBe('Reviewer');
    });

    it('carries legacy info requests across without closing the item', () => {
      const task = seedDecision();
      store.requestMoreInfo(task.id, 'what breaks if we flag it?', { actor: PERSON });
      const item = store.listReviewItems(task.id)[0];
      expect(item?.infoRequests?.map((r) => r.text)).toEqual(['what breaks if we flag it?']);
      expect(item?.answer).toBeUndefined();
    });

    it('POSITIVE CONTROL: an action task yields zero review items', () => {
      const ws = store.createWorkspace('ws');
      const t = store.createTask(ws.id, { title: 'Open the PR', needs: 'action' });
      if (!t.ok) throw new Error('create failed');
      expect(store.listReviewItems(t.task.id)).toEqual([]);
    });

    it('POSITIVE CONTROL: the derivation writes NOTHING back to the task', () => {
      const task = seedDecision([{ label: 'On by default' }, { label: 'Behind a flag' }]);
      store.listReviewItems(task.id);
      store.listReviewItems(task.id);
      expect(store.getTask(task.id)?.reviews).toBeUndefined();
    });

    it('reports nothing for a task that does not exist', () => {
      expect(store.listReviewItems('t-ghost')).toEqual([]);
    });
  });

  // ── 0..n real rows ───────────────────────────────────────────────────────

  describe('addReviewItem puts several open items on one ticket', () => {
    /**
     * The derived row is NOT suppressed by real ones.
     *
     * It was, briefly, on the reasoning that showing the ticket title back as
     * a question duplicates work already done. That reasoning was wrong in the
     * one direction that matters: the legacy decision is a SEPARATE open
     * question from the rows somebody added later, and suppressing it made an
     * unanswered decision drop out of `listReviewItems` — and therefore out of
     * `GET /review-items` — the moment anybody filed a second question on the
     * same ticket. An open question that disappears from the one route that
     * answers "what is waiting on me" is the failure this entity exists to fix.
     */
    it('holds two open items at once BESIDE the still-open derived row', () => {
      const task = seedDecision([{ label: 'On by default' }, { label: 'Behind a flag' }]);
      const first = store.addReviewItem(task.id, payload({ headline: 'Which cache do we keep?' }), {
        actor: AGENT,
      });
      const second = store.addReviewItem(
        task.id,
        payload({ headline: 'Do we backfill the old rows?' }),
        { actor: AGENT },
      );
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.item.id).not.toBe(second.item.id);
      expect(first.item.id.startsWith('r-')).toBe(true);
      expect(first.item.createdBy).toBe('Scheduler Agent');

      const items = store.listReviewItems(task.id);
      // The derived row is the OLDEST question on the ticket, so it leads.
      expect(items.map((i) => i.review.headline)).toEqual([
        'Walkthrough rollout',
        'Which cache do we keep?',
        'Do we backfill the old rows?',
      ]);
      expect(items.some((i) => i.id === 'r-legacy')).toBe(true);
      expect(items.every((i) => i.answer === undefined)).toBe(true);
    });

    /**
     * …and the derived row goes away for the ONE reason it should: the legacy
     * decision was answered. Keyed on the answer rather than on "does a stored
     * row exist", because those two facts are about different questions.
     */
    it('drops the derived row once the legacy decision is answered, keeping the real ones', () => {
      const task = seedDecision([{ label: 'On by default' }, { label: 'Behind a flag' }]);
      const added = store.addReviewItem(task.id, payload(), { actor: AGENT });
      if (!added.ok) throw new Error('add failed');
      expect(store.listReviewItems(task.id).some((i) => i.id === 'r-legacy')).toBe(true);

      store.answerDecision(task.id, 'Behind a flag', { actor: PERSON });
      const items = store.listReviewItems(task.id);
      // Still listed, now CLOSED — nothing is purged, the row just stops
      // counting as open.
      expect(items.find((i) => i.id === 'r-legacy')?.answer?.text).toBe('Behind a flag');
      expect(items.find((i) => i.id === added.item.id)?.answer).toBeUndefined();
    });

    /**
     * A ticket that was never a decision derives nothing, however many rows it
     * holds. POSITIVE CONTROL for the un-suppression above: lifting the guard
     * must not start inventing a question out of an ordinary ticket's title.
     */
    it('derives no row for a needs:action ticket that holds real review items', () => {
      const ws = store.createWorkspace('ws');
      const res = store.createTask(ws.id, { title: 'Sweep the cache dir', assignee: 'agent' });
      if (!res.ok) throw new Error('create failed');
      store.addReviewItem(res.task.id, payload(), { actor: AGENT });
      expect(store.listReviewItems(res.task.id).some((i) => i.id === 'r-legacy')).toBe(false);
      expect(store.listReviewItems(res.task.id)).toHaveLength(1);
    });

    /**
     * A row that no longer reads — written by another version, or blanked by a
     * hand edit or a half-written sidecar — drops out of the list, and takes
     * NOTHING else with it. This used to be decided from the RAW array length
     * while the list was built from the READABLE rows, so a ticket whose only
     * stored row was corrupt answered with an empty list: the stored row and
     * the still-open legacy decision both invisible at once.
     */
    it('hides only the unreadable row, never the legacy decision behind it', () => {
      const task = seedDecision([{ label: 'On by default' }, { label: 'Behind a flag' }]);
      const live = store.getTask(task.id);
      if (!live) throw new Error('no task');
      // Deliberately not through `addReviewItem` — the gate would refuse this,
      // which is the point: it models a row that reached disk another way.
      live.reviews = [{ id: 'r-corrupt' } as unknown as TaskReviewItem];

      const items = store.listReviewItems(task.id);
      expect(items.map((i) => i.id)).toEqual(['r-legacy']);
      // Nothing was purged: the unreadable row is still on the task.
      expect(store.getTask(task.id)?.reviews).toHaveLength(1);
    });

    it('answering the first leaves the second open', () => {
      const task = seedDecision();
      const first = store.addReviewItem(task.id, payload(), { actor: AGENT });
      const second = store.addReviewItem(task.id, payload({ headline: 'Second question' }), {
        actor: AGENT,
      });
      if (!first.ok || !second.ok) throw new Error('add failed');

      const res = store.answerTaskReview(task.id, first.item.id, 'Keep the disk one', {
        actor: PERSON,
        answeredWith: 'o-7f3a',
      });
      expect(res.ok).toBe(true);
      const items = store.listReviewItems(task.id);
      expect(items.find((i) => i.id === first.item.id)?.answer?.text).toBe('Keep the disk one');
      expect(items.find((i) => i.id === first.item.id)?.answer?.answeredWith).toBe('o-7f3a');
      expect(items.find((i) => i.id === second.item.id)?.answer).toBeUndefined();
      // The legacy answer path is untouched by an answer to a ROW.
      expect(store.getTask(task.id)?.answer).toBeUndefined();
    });

    it('refuses a payload the shared gate refuses — one checker, not a second gate', () => {
      const task = seedDecision();
      const res = store.addReviewItem(
        task.id,
        { shape: 'decision', detail: 'No headline here' } as unknown as ReviewPayload,
        {
          actor: AGENT,
        },
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toBe('bad-review');
      expect(res.message).toContain('review.headline is required');
    });

    it('returns the gate GAPS as advice on a thin but acceptable item', () => {
      const task = seedDecision();
      const thin = payload();
      thin.detail = undefined;
      const res = store.addReviewItem(task.id, thin, { actor: AGENT });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.advice).toContain('review.detail is missing');
    });

    it('refuses on a task that does not exist', () => {
      const res = store.addReviewItem('t-ghost', payload(), { actor: AGENT });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('not-found');
    });
  });

  // ── answering a row ──────────────────────────────────────────────────────

  describe('answerTaskReview', () => {
    /**
     * Answering twice is legal — a person changes their mind, a retry lands,
     * two people reach for the same row — and the earlier VERBATIM words are
     * user content. Soft, not hard: the superseded answer moves to
     * `priorAnswers` instead of being written over and lost with nothing
     * anywhere reporting it.
     */
    it('keeps a superseded answer instead of overwriting it away', () => {
      const task = seedDecision();
      const added = store.addReviewItem(task.id, payload(), { actor: AGENT });
      if (!added.ok) throw new Error('add failed');

      store.answerTaskReview(task.id, added.item.id, 'Keep disk', {
        actor: PERSON,
        answeredWith: 'o-7f3a',
      });
      const second = store.answerTaskReview(task.id, added.item.id, 'Keep memory', {
        actor: AGENT,
        answeredWith: 'o-4b2e',
      });
      expect(second.ok, JSON.stringify(second)).toBe(true);

      const item = store.listReviewItems(task.id).find((i) => i.id === added.item.id);
      expect(item?.answer?.text).toBe('Keep memory');
      expect(item?.answer?.answeredWith).toBe('o-4b2e');
      expect(item?.priorAnswers?.map((a) => a.text)).toEqual(['Keep disk']);
      expect(item?.priorAnswers?.[0]?.answeredWith).toBe('o-7f3a');
      expect(item?.priorAnswers?.[0]?.by).toBe('Reviewer');
    });

    it('records no priorAnswers on a first answer', () => {
      // POSITIVE CONTROL: the history is created by a SECOND answer, not by
      // every answer — an always-present empty array would be noise on every
      // row in the projection.
      const task = seedDecision();
      const added = store.addReviewItem(task.id, payload(), { actor: AGENT });
      if (!added.ok) throw new Error('add failed');
      store.answerTaskReview(task.id, added.item.id, 'Keep disk', { actor: PERSON });
      expect(
        store.listReviewItems(task.id).find((i) => i.id === added.item.id)?.priorAnswers,
      ).toBeUndefined();
    });

    it('refuses an unknown reviewItemId', () => {
      const task = seedDecision();
      store.addReviewItem(task.id, payload(), { actor: AGENT });
      const res = store.answerTaskReview(task.id, 'r-ghost', 'anything', { actor: PERSON });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('unknown-review-item');
    });

    it('refuses an answeredWith that belongs to a DIFFERENT row', () => {
      const task = seedDecision();
      const first = store.addReviewItem(task.id, payload(), { actor: AGENT });
      const second = store.addReviewItem(
        task.id,
        payload({
          headline: 'Second question',
          options: [
            { id: 'o-9c11', label: 'Ship it' },
            { id: 'o-2d40', label: 'Hold it' },
          ],
        }),
        { actor: AGENT },
      );
      if (!first.ok || !second.ok) throw new Error('add failed');
      const res = store.answerTaskReview(task.id, first.item.id, 'Ship it', {
        actor: PERSON,
        answeredWith: 'o-9c11',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('unknown-option');
      expect(store.listReviewItems(task.id).find((i) => i.id === first.item.id)?.answer).toBe(
        undefined,
      );
    });

    it('emits decision.answered carrying the reviewItemId', () => {
      const task = seedDecision();
      const added = store.addReviewItem(task.id, payload(), { actor: AGENT });
      if (!added.ok) throw new Error('add failed');
      const seen: TaskStoreEvent[] = [];
      const off = store.onEvent((e) => seen.push(e));
      store.answerTaskReview(task.id, added.item.id, 'Keep the disk one', { actor: PERSON });
      off();
      const ev = seen.find((e) => e.type === 'decision.answered');
      expect(ev).toBeDefined();
      if (ev?.type !== 'decision.answered') return;
      expect(ev.answer).toBe('Keep the disk one');
      expect(ev.reviewItemId).toBe(added.item.id);
      expect(ev.taskId).toBe(task.id);
    });
  });

  // ── the legacy row answers through the UNTOUCHED path ────────────────────

  describe("POSITIVE CONTROL: answering 'r-legacy' delegates to answerDecision", () => {
    it('produces the same task.answer as answerDecision does for the same input', () => {
      const viaLegacy = seedDecision([{ label: 'On by default' }, { label: 'Behind a flag' }]);
      const viaDirect = seedDecision([{ label: 'On by default' }, { label: 'Behind a flag' }]);
      const pickA = viaLegacy.options?.[1];
      const pickB = viaDirect.options?.[1];
      if (!pickA || !pickB) throw new Error('no option');

      store.answerTaskReview(viaLegacy.id, 'r-legacy', pickA.label, {
        actor: PERSON,
        answeredWith: pickA.id,
      });
      store.answerDecision(viaDirect.id, pickB.label, { actor: PERSON, optionId: pickB.id });

      const a = store.getTask(viaLegacy.id)?.answer;
      const b = store.getTask(viaDirect.id)?.answer;
      expect(a).toBeDefined();
      // Same shape, same keys, same values — only the option id and the clock
      // differ, and both of those are per-task by construction.
      expect({ ...a, ts: 0, optionId: 'x' }).toEqual({ ...b, ts: 0, optionId: 'x' });
      expect(a?.optionId).toBe(pickA.id);
    });

    it('emits the same decision.answered payload, with NO reviewItemId on it', () => {
      const task = seedDecision([{ label: 'On by default' }, { label: 'Behind a flag' }]);
      const picked = task.options?.[0];
      if (!picked) throw new Error('no option');
      const seen: TaskStoreEvent[] = [];
      const off = store.onEvent((e) => seen.push(e));
      store.answerTaskReview(task.id, 'r-legacy', picked.label, {
        actor: PERSON,
        answeredWith: picked.id,
      });
      off();
      const ev = seen.find((e) => e.type === 'decision.answered');
      expect(ev).toBeDefined();
      if (ev?.type !== 'decision.answered') return;
      expect(ev.answer).toBe('On by default');
      expect(ev.optionId).toBe(picked.id);
      expect(ev.reviewItemId).toBeUndefined();
    });

    it('refuses an answeredWith the legacy decision does not carry', () => {
      const task = seedDecision([{ label: 'On by default' }, { label: 'Behind a flag' }]);
      const res = store.answerTaskReview(task.id, 'r-legacy', 'Behind a flag', {
        actor: PERSON,
        answeredWith: 'o-ghost',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('unknown-option');
    });

    /**
     * Reader and writer agree because they share `legacyReviewItem`: while the
     * reader still LISTS the derived row, the writer still ACCEPTS an answer
     * at it. The inverse — a row nothing lists that still takes answers, or a
     * listed row that 400s — is what sharing the rule prevents.
     */
    it("keeps resolving 'r-legacy' while the decision is open, even beside real rows", () => {
      const task = seedDecision();
      store.addReviewItem(task.id, payload(), { actor: AGENT });
      const res = store.answerTaskReview(task.id, 'r-legacy', 'Behind a flag', { actor: PERSON });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      expect(store.getTask(task.id)?.answer?.text).toBe('Behind a flag');
    });

    it("refuses 'r-legacy' on a ticket that is not a decision at all", () => {
      const ws = store.createWorkspace('ws');
      const created = store.createTask(ws.id, { title: 'Sweep the cache dir', assignee: 'agent' });
      if (!created.ok) throw new Error('create failed');
      const res = store.answerTaskReview(created.task.id, 'r-legacy', 'anything', {
        actor: PERSON,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('unknown-review-item');
    });
  });

  // ── "tell me more" survives the unification ──────────────────────────────

  describe('requestMoreInfoOnReview', () => {
    it('leaves the item OPEN and unanswered', () => {
      const task = seedDecision();
      const added = store.addReviewItem(task.id, payload(), { actor: AGENT });
      if (!added.ok) throw new Error('add failed');
      const res = store.requestMoreInfoOnReview(task.id, added.item.id, 'what does peak mean?', {
        actor: PERSON,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.item.infoRequests?.map((r) => r.text)).toEqual(['what does peak mean?']);
      expect(res.item.infoRequests?.[0]?.by).toBe('Reviewer');
      expect(res.item.answer).toBeUndefined();
      expect(store.listReviewItems(task.id).find((i) => i.id === added.item.id)?.answer).toBe(
        undefined,
      );
    });

    it('appends rather than replaces', () => {
      const task = seedDecision();
      const added = store.addReviewItem(task.id, payload(), { actor: AGENT });
      if (!added.ok) throw new Error('add failed');
      store.requestMoreInfoOnReview(task.id, added.item.id, 'first', { actor: PERSON });
      store.requestMoreInfoOnReview(task.id, added.item.id, 'second', { actor: PERSON });
      const item = store.listReviewItems(task.id).find((i) => i.id === added.item.id);
      expect(item?.infoRequests?.map((r) => r.text)).toEqual(['first', 'second']);
    });

    it("delegates 'r-legacy' to the untouched requestMoreInfo", () => {
      const task = seedDecision();
      const res = store.requestMoreInfoOnReview(task.id, 'r-legacy', 'what breaks?', {
        actor: PERSON,
      });
      expect(res.ok).toBe(true);
      expect(store.getTask(task.id)?.infoRequests?.map((r) => r.text)).toEqual(['what breaks?']);
    });

    it('refuses an unknown reviewItemId', () => {
      const task = seedDecision();
      const res = store.requestMoreInfoOnReview(task.id, 'r-ghost', 'why?', { actor: PERSON });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('unknown-review-item');
    });
  });

  // ── persistence ──────────────────────────────────────────────────────────

  it('review items survive a save/hydrate round-trip', () => {
    const task = seedDecision();
    const added = store.addReviewItem(task.id, payload(), { actor: AGENT });
    if (!added.ok) throw new Error('add failed');
    store.answerTaskReview(task.id, added.item.id, 'Keep the disk one', {
      actor: PERSON,
      answeredWith: 'o-7f3a',
    });
    const open = store.addReviewItem(task.id, payload({ headline: 'Still open here' }), {
      actor: AGENT,
    });
    if (!open.ok) throw new Error('add failed');
    store.requestMoreInfoOnReview(task.id, open.item.id, 'which peak?', { actor: PERSON });
    store.flush();

    const reloaded = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      const items = reloaded.listReviewItems(task.id);
      // The derived row leads (it is the ticket's oldest question) and the
      // STORED rows follow in filing order — the part that had to survive the
      // round-trip, since nothing writes them but `persist()` itself.
      expect(items.map((i) => i.id)).toEqual(['r-legacy', added.item.id, open.item.id]);
      const answered = items.find((i) => i.id === added.item.id);
      const stillOpen = items.find((i) => i.id === open.item.id);
      expect(answered?.answer?.text).toBe('Keep the disk one');
      expect(answered?.answer?.answeredWith).toBe('o-7f3a');
      expect(stillOpen?.answer).toBeUndefined();
      expect(stillOpen?.infoRequests?.map((r) => r.text)).toEqual(['which peak?']);
      expect(stillOpen?.review.options?.map((o) => o.id)).toEqual(['o-7f3a', 'o-4b2e']);
    } finally {
      reloaded.stop();
    }
  });
});
