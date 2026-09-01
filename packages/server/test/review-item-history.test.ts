/**
 * An answered review item is HISTORY, not garbage: it stays on the ticket
 * with its answer, and the audit trail shows it being raised before it shows
 * it being answered.
 *
 * Bryan, 2026-09-01: *"Review items disappear and I can't find them any
 * more."* The store never dropped them — the client had no renderer for an
 * answered ticket-borne item — but the trail also had no "asked" row, so the
 * Activity tab showed an answer to nothing. Both halves are pinned here.
 *
 * All fixtures are synthetic — invented ids and generic personas. The repo is
 * public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewPayload } from '@feedback/core';
import { TaskStore, type TaskStoreEvent } from '../src/tasks.ts';

const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'known' };
const AGENT = { id: 'agent-scheduler', name: 'Scheduler Agent', kind: 'known' };

function payload(over: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    shape: 'decision',
    headline: 'Which cache do we keep?',
    detail: 'Both caches answer the same reads; keeping both doubles the invalidation paths.',
    options: [
      { id: 'o-7f3a', label: 'Keep disk' },
      { id: 'o-4b2e', label: 'Keep memory' },
    ],
    ...over,
  };
}

describe('an answered review item stays in the ticket history', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'review-item-history-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const seed = () => {
    const ws = store.createWorkspace('ws');
    const res = store.createTask(ws.id, { title: 'Cache cleanup', assignee: 'agent' });
    if (!res.ok) throw new Error(`create failed: ${res.error}`);
    return { ws, task: res.task };
  };

  it('raising an item emits review_item.added naming the ask, before any answer', () => {
    const { task } = seed();
    const seen: TaskStoreEvent[] = [];
    const off = store.onEvent((e) => seen.push(e));
    const added = store.addReviewItem(task.id, payload(), { actor: AGENT });
    off();
    if (!added.ok) throw new Error('add failed');
    const ev = seen.find((e) => e.type === 'review_item.added');
    expect(ev).toBeDefined();
    if (ev?.type !== 'review_item.added') return;
    expect(ev.taskId).toBe(task.id);
    expect(ev.reviewItemId).toBe(added.item.id);
    expect(ev.headline).toBe('Which cache do we keep?');
    expect(ev.shape).toBe('decision');
    expect(ev.actor.name).toBe('Scheduler Agent');
    // Control: nothing was answered, so no answer row rides along with it.
    expect(seen.some((e) => e.type === 'decision.answered')).toBe(false);
  });

  it('the audit log carries the ask and then the answer, in that order', () => {
    const { ws, task } = seed();
    const added = store.addReviewItem(task.id, payload(), { actor: AGENT });
    if (!added.ok) throw new Error('add failed');
    const answered = store.answerTaskReview(task.id, added.item.id, 'Keep disk', {
      actor: PERSON,
      answeredWith: 'o-7f3a',
    });
    expect(answered.ok).toBe(true);
    // The audit is appended at the emit choke point, synchronously.
    const wsDir = join(dataDir, 'workspaces');
    const log = readdirSync(wsDir).find((f) => f === `${ws.id}.events.jsonl`);
    expect(log).toBeDefined();
    const rows = readFileSync(join(wsDir, log ?? ''), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { event?: string; type?: string; reviewItemId?: string });
    const kinds = rows
      .filter((r) => r.reviewItemId === added.item.id)
      .map((r) => r.event ?? r.type);
    expect(kinds).toEqual(['review_item.added', 'decision.answered']);
  });

  it('after the answer the item is still on the task, carrying the answer, who and when', () => {
    const { task } = seed();
    const added = store.addReviewItem(task.id, payload(), { actor: AGENT });
    if (!added.ok) throw new Error('add failed');
    const before = Date.now();
    store.answerTaskReview(task.id, added.item.id, 'Keep disk', {
      actor: PERSON,
      answeredWith: 'o-7f3a',
    });
    // The stored row — what the workspace tasks projection ships as
    // `task.reviews` — still lists it, answered.
    const stored = store.getTask(task.id)?.reviews?.find((r) => r.id === added.item.id);
    expect(stored).toBeDefined();
    expect(stored?.review.headline).toBe('Which cache do we keep?');
    expect(stored?.answer?.text).toBe('Keep disk');
    expect(stored?.answer?.by).toBe('Reviewer');
    expect(stored?.answer?.answeredWith).toBe('o-7f3a');
    expect(stored?.answer?.ts ?? 0).toBeGreaterThanOrEqual(before);
    // And the item list reads it as answered rather than dropping it.
    const listed = store.listReviewItems(task.id).find((r) => r.id === added.item.id);
    expect(listed?.answer?.text).toBe('Keep disk');
  });
});
