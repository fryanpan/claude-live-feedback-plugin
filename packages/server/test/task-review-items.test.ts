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
import type { ReviewPayload } from '@feedback/core';
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
    why: 'The rollout is blocked until one of them goes.',
    lookFor: 'Whether the memory ceiling still holds at peak.',
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
    it('holds two open items at once and suppresses the derived row', () => {
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
      expect(items.map((i) => i.review.headline)).toEqual([
        'Which cache do we keep?',
        'Do we backfill the old rows?',
      ]);
      expect(items.some((i) => i.id === 'r-legacy')).toBe(false);
      expect(items.every((i) => i.answer === undefined)).toBe(true);
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
        { shape: 'decision', headline: 'No why here' },
        {
          actor: AGENT,
        },
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toBe('bad-review');
      expect(res.message).toContain('review.why is required');
    });

    it('returns the gate GAPS as advice on a thin but acceptable item', () => {
      const task = seedDecision();
      const thin = payload();
      thin.lookFor = undefined;
      thin.detail = undefined;
      const res = store.addReviewItem(task.id, thin, { actor: AGENT });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.advice).toContain('review.lookFor is missing');
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

    it("stops resolving 'r-legacy' once real rows exist, since nothing lists it", () => {
      const task = seedDecision();
      store.addReviewItem(task.id, payload(), { actor: AGENT });
      const res = store.answerTaskReview(task.id, 'r-legacy', 'anything', { actor: PERSON });
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
      const item = store.listReviewItems(task.id)[0];
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
      expect(items.map((i) => i.id)).toEqual([added.item.id, open.item.id]);
      expect(items[0]?.answer?.text).toBe('Keep the disk one');
      expect(items[0]?.answer?.answeredWith).toBe('o-7f3a');
      expect(items[1]?.answer).toBeUndefined();
      expect(items[1]?.infoRequests?.map((r) => r.text)).toEqual(['which peak?']);
      expect(items[1]?.review.options?.map((o) => o.id)).toEqual(['o-7f3a', 'o-4b2e']);
    } finally {
      reloaded.stop();
    }
  });
});
