/**
 * The quality gate on a ticket that IS the decision — the store half.
 *
 * A `needs: 'decision'` row reaches the reader's queue through the DERIVED
 * `r-legacy` item, which `legacyReviewItem` rebuilds on every read and which
 * therefore has nowhere of its own to carry a verdict. So the verdict lives
 * on the task (`decisionJudge`) and the version it is about is the row's
 * `wordsRevision`, not a count of revisions.
 *
 * What is asserted here is that pair of choices behaving like the ticket-item
 * gate it has to match: a hold gating the derived row, a verdict that
 * outlived the words it read being refused, an answered decision closed to
 * both, and a revision that moves the ticket's own words.
 *
 * All fixtures are synthetic — invented names and generic personas. The repo
 * is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isReviewItemGated, isReviewItemHeld } from '@feedback/core';
import { LEGACY_REVIEW_ITEM_ID, type Task, TaskStore, wordsRevisionOf } from '../src/tasks.ts';

const FILER = { id: 'agent-index-keeper', name: 'Index Keeper', kind: 'agent' };
const PERSON = { id: 'known-jordan', name: 'Jordan', kind: 'person' };

/** A body the create door's deterministic shape check accepts — a different
 *  gate from the judge, and one that refuses the row outright. */
const BODY =
  'Which cache size should the nightly rebuild use? At stake: a full pass reads the index once, and halving it adds an hour. Blocked until answered: the rollout.';

describe('the gate on a ticket that IS the decision', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'decision-gate-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function decisionTask(): Task {
    const ws = store.createWorkspace('index-rebuild');
    const res = store.createTask(ws.id, {
      title: 'ri-77 cfg?',
      body: BODY,
      assignee: 'Jordan',
      needs: 'decision',
      options: [{ label: 'Keep it' }, { label: 'Halve it' }],
      actor: FILER,
    });
    if (!res.ok) throw new Error(`fixture task was not created: ${res.error}`);
    return res.task;
  }

  const derived = (taskId: string) =>
    store.listReviewItems(taskId).find((r) => r.id === LEGACY_REVIEW_ITEM_ID);

  it('gates the derived row on exactly the verdicts a ticket item is gated on', () => {
    const task = decisionTask();
    expect(isReviewItemGated(derived(task.id)!)).toBe(false);

    const held = store.recordDecisionJudgement(
      task.id,
      { at: Date.now(), verdict: 'held', reason: 'no stakes named' },
      { actor: FILER },
    );
    expect(held.ok).toBe(true);
    expect(isReviewItemHeld(derived(task.id)!)).toBe(true);
    expect(isReviewItemGated(derived(task.id)!)).toBe(true);

    // `pending` is gated too — the seconds the judge takes are seconds the
    // reader must not be able to answer an item about to be held.
    store.recordDecisionJudgement(
      task.id,
      { at: Date.now(), verdict: 'pending', reason: 'being judged' },
      { actor: FILER },
    );
    expect(isReviewItemGated(derived(task.id)!)).toBe(true);

    // Every passing verdict lets it through, the judge failing included.
    for (const verdict of ['ok', 'unavailable'] as const) {
      store.recordDecisionJudgement(
        task.id,
        { at: Date.now(), verdict, reason: 'fine' },
        { actor: FILER },
      );
      expect(isReviewItemGated(derived(task.id)!)).toBe(false);
    }
  });

  it('refuses a verdict about words that have since moved', () => {
    const task = decisionTask();
    const captured = wordsRevisionOf(task);
    // The filer fixes the row while the judge is out.
    store.renameTask(task.id, 'Which cache size should the nightly rebuild use?', {
      actor: FILER,
    });
    const late = store.recordDecisionJudgement(
      task.id,
      { at: Date.now(), verdict: 'held', reason: 'no stakes named' },
      { actor: FILER, forVersion: captured },
    );
    expect(late).toEqual({ ok: false, error: 'stale' });
    // And the row is NOT held by a verdict that never read these words.
    expect(isReviewItemGated(derived(task.id)!)).toBe(false);
  });

  it('refuses a verdict that lost its own pending stamp', () => {
    const task = decisionTask();
    const pendingAt = Date.now();
    store.recordDecisionJudgement(
      task.id,
      { at: pendingAt, verdict: 'pending', reason: 'being judged' },
      { actor: FILER },
    );
    // Somebody else wrote a verdict while this caller was out — theirs is the
    // newer fact, and a release does not move `wordsRevision`, so the pending
    // stamp is the only thing that can tell.
    store.recordDecisionJudgement(
      task.id,
      { at: Date.now(), verdict: 'ok', reason: 'released' },
      { actor: PERSON },
    );
    const late = store.recordDecisionJudgement(
      task.id,
      { at: Date.now(), verdict: 'held', reason: 'no stakes named' },
      { actor: FILER, forPendingAt: pendingAt },
    );
    expect(late).toEqual({ ok: false, error: 'stale' });
    expect(isReviewItemGated(derived(task.id)!)).toBe(false);
  });

  it('never holds an ANSWERED decision — the answer closed it', () => {
    const task = decisionTask();
    store.answerDecision(task.id, 'Keep it as it is.', { actor: PERSON });
    const late = store.recordDecisionJudgement(
      task.id,
      { at: Date.now(), verdict: 'held', reason: 'no stakes named' },
      { actor: FILER },
    );
    expect(late).toEqual({ ok: false, error: 'answered' });
  });

  it('reports a held decision to the stall monitor under the derived id', () => {
    const task = decisionTask();
    store.recordDecisionJudgement(
      task.id,
      { at: 1_000, verdict: 'held', reason: 'no stakes named' },
      { actor: FILER },
    );
    const held = store.heldReviewItems(task.workspaceId);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      taskId: task.id,
      reviewItemId: LEGACY_REVIEW_ITEM_ID,
      reason: 'no stakes named',
      heldAt: 1_000,
      // The filer's AGENT id, which is what an addressed wake needs and what
      // the display name on the row cannot supply.
      filerAgentId: FILER.id,
    });
  });

  it('revises the decision by moving the ticket’s own words, and makes the old verdict stale', () => {
    const task = decisionTask();
    store.recordDecisionJudgement(
      task.id,
      { at: Date.now(), verdict: 'held', reason: 'no stakes named' },
      { actor: FILER },
    );
    const before = wordsRevisionOf(store.getTask(task.id)!);

    const res = store.reviseTaskDecision(
      task.id,
      { headline: 'Which cache size should the nightly rebuild use?' },
      { actor: FILER },
    );
    expect(res.ok).toBe(true);
    const after = store.getTask(task.id)!;
    // The headline IS the title. No second row was minted to hold it.
    expect(after.title).toBe('Which cache size should the nightly rebuild use?');
    expect(after.reviews ?? []).toEqual([]);
    // And the counter moved, so the verdict about the old words is refusable.
    expect(wordsRevisionOf(after)).toBeGreaterThan(before);
    expect(
      store.recordDecisionJudgement(
        task.id,
        { at: Date.now(), verdict: 'held', reason: 'no stakes named' },
        { actor: FILER, forVersion: before },
      ),
    ).toEqual({ ok: false, error: 'stale' });
  });

  it('refuses a revision that would leave the row in a shape the create door rejects', () => {
    const task = decisionTask();
    // A body with no question in it — the same refusal `create_tasks` gives,
    // so a revision cannot land a decision nobody can decide from.
    const res = store.reviseTaskDecision(
      task.id,
      { detail: 'We looked at the cache and it seemed fine.' },
      { actor: FILER },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('bad-review');
    expect(store.getTask(task.id)?.body).toBe(BODY);
  });

  it('refuses an empty patch and a ticket that is not a decision', () => {
    const task = decisionTask();
    expect(store.reviseTaskDecision(task.id, {}, { actor: FILER })).toEqual({
      ok: false,
      error: 'empty-patch',
    });
    const plain = store.createTask(task.workspaceId, {
      title: 'Rebuild the index nightly',
      assignee: 'Index Keeper',
      actor: FILER,
    });
    if (!plain.ok) throw new Error('fixture task was not created');
    const res = store.reviseTaskDecision(plain.task.id, { headline: 'Anything' }, { actor: FILER });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('not-a-decision');
  });
});
