/**
 * `reading-time-backfill.ts` — the one-time catch-up that folds
 * already-live-captured `read_session` events (recorded since #468, before
 * `Task.readingTime` existed) onto the task records they describe.
 *
 * Two contracts under test:
 *  - `readingTimeTotalsFromLog` is a pure aggregation: sums clamped
 *    durationMs (as seconds) per task, ignores anything that isn't a
 *    task-scoped read_session, and never throws on a malformed line.
 *  - `runReadingTimeBackfill` is idempotent — a full recompute per task, so
 *    running it twice (or after the live hook already folded in some of the
 *    same events) lands on the same total rather than doubling it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activityLogPath } from '../src/activity.ts';
import { readingTimeTotalsFromLog, runReadingTimeBackfill } from '../src/reading-time-backfill.ts';
import { taskBodyDocId } from '../src/task-projection.ts';
import { TaskStore } from '../src/tasks.ts';

function writeLines(dataDir: string, lines: string[]): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(activityLogPath(dataDir), `${lines.join('\n')}\n`);
}

/** A minimally-shaped read_session line, the fields the aggregator reads. */
function readSessionLine(opts: {
  docId: string;
  durationMs: number;
  ts?: string;
  sessionId?: string;
}): string {
  return JSON.stringify({
    eventId: `ev-${opts.sessionId ?? Math.random()}`,
    ts: opts.ts ?? new Date().toISOString(),
    type: 'read_session',
    actor: 'person',
    actorId: 'known-jordan',
    actorName: 'Jordan',
    isOwner: false,
    doc: {
      docId: opts.docId,
      sourceUrl: null,
      relPath: null,
      title: null,
      kind: 'markdown',
      repo: { owner: 'x', name: 'y' },
      producedBy: { agentId: null, sessionId: null, cwd: null },
    },
    payload: {
      durationMs: opts.durationMs,
      sessionId: opts.sessionId ?? 's',
      interactionBounded: true,
    },
  });
}

describe('readingTimeTotalsFromLog', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'reading-time-log-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('is empty (no throw) when activity.jsonl does not exist', () => {
    const { totals, linesScanned, readSessionsFolded } = readingTimeTotalsFromLog(dataDir);
    expect(totals.size).toBe(0);
    expect(linesScanned).toBe(0);
    expect(readSessionsFolded).toBe(0);
  });

  it('sums durationMs (as rounded seconds) across sessions for the same task', () => {
    writeLines(dataDir, [
      readSessionLine({ docId: 'task:t-1', durationMs: 18_000, sessionId: 'a' }),
      readSessionLine({ docId: 'task:t-1', durationMs: 7_500, sessionId: 'b' }),
    ]);
    const { totals, readSessionsFolded } = readingTimeTotalsFromLog(dataDir);
    expect(readSessionsFolded).toBe(2);
    const rt = totals.get('t-1');
    expect(rt?.totalSeconds).toBe(18 + 8); // 7_500ms rounds up to 8s
    expect(rt?.sessionCount).toBe(2);
  });

  it('tracks the latest ts as lastSessionAt, regardless of file order', () => {
    const early = new Date('2026-08-01T00:00:00.000Z').toISOString();
    const late = new Date('2026-08-20T00:00:00.000Z').toISOString();
    writeLines(dataDir, [
      readSessionLine({ docId: 'task:t-1', durationMs: 5_000, ts: late, sessionId: 'late' }),
      readSessionLine({ docId: 'task:t-1', durationMs: 5_000, ts: early, sessionId: 'early' }),
    ]);
    const { totals } = readingTimeTotalsFromLog(dataDir);
    expect(totals.get('t-1')?.lastSessionAt).toBe(Date.parse(late));
  });

  it('ignores doc_open and other event types', () => {
    writeLines(dataDir, [
      JSON.stringify({
        ts: new Date().toISOString(),
        type: 'doc_open',
        doc: { docId: 'task:t-1' },
        payload: { sessionId: 'open' },
      }),
      JSON.stringify({
        ts: new Date().toISOString(),
        type: 'comment',
        doc: { docId: 'task:t-1' },
        payload: { text: 'hi' },
      }),
    ]);
    const { totals, readSessionsFolded } = readingTimeTotalsFromLog(dataDir);
    expect(readSessionsFolded).toBe(0);
    expect(totals.size).toBe(0);
  });

  it('ignores read_session events on non-task docs', () => {
    writeLines(dataDir, [readSessionLine({ docId: 'some-markdown-doc', durationMs: 10_000 })]);
    const { totals } = readingTimeTotalsFromLog(dataDir);
    expect(totals.size).toBe(0);
  });

  it('ignores a zero, negative or missing durationMs without throwing', () => {
    writeLines(dataDir, [
      readSessionLine({ docId: 'task:t-1', durationMs: 0, sessionId: 'z' }),
      readSessionLine({ docId: 'task:t-1', durationMs: -5, sessionId: 'n' }),
      JSON.stringify({
        ts: new Date().toISOString(),
        type: 'read_session',
        doc: { docId: 'task:t-1' },
        payload: { sessionId: 'missing' },
      }),
    ]);
    const { totals, readSessionsFolded } = readingTimeTotalsFromLog(dataDir);
    expect(readSessionsFolded).toBe(0);
    expect(totals.size).toBe(0);
  });

  it('skips a malformed line rather than aborting the whole scan', () => {
    writeLines(dataDir, [
      'not json at all {{{',
      readSessionLine({ docId: 'task:t-1', durationMs: 10_000, sessionId: 'good' }),
    ]);
    const { totals, readSessionsFolded } = readingTimeTotalsFromLog(dataDir);
    expect(readSessionsFolded).toBe(1);
    expect(totals.get('t-1')?.totalSeconds).toBe(10);
  });
});

describe('runReadingTimeBackfill', () => {
  let dataDir: string;
  let store: TaskStore;
  let taskId: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'reading-time-backfill-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    const ws = store.createWorkspace('launch-board');
    const created = store.createTask(ws.id, { title: 'Read this ticket' });
    if (!created.ok) throw new Error('create failed');
    taskId = created.task.id;
    store.stop();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('folds real log events onto the matching task and leaves an unmentioned task untouched', () => {
    const created2 = new TaskStore({ dataDir, debounceMs: 5 });
    const ws2 = created2.createWorkspace('other-board');
    const untouched = created2.createTask(ws2.id, { title: 'Never opened' });
    if (!untouched.ok) throw new Error('create failed');
    created2.stop();

    writeLines(dataDir, [readSessionLine({ docId: taskBodyDocId(taskId), durationMs: 42_000 })]);

    const stats = runReadingTimeBackfill({ dataDir });
    expect(stats.readSessionsFolded).toBe(1);
    expect(stats.tasksTouched).toBe(1);
    expect(stats.tasksNotFound).toBe(0);

    const rehydrated = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      expect(rehydrated.getTask(taskId)?.readingTime).toEqual({
        totalSeconds: 42,
        sessionCount: 1,
        lastSessionAt: expect.any(Number),
      });
      // The task nothing in the log mentions stays absent, not zero.
      expect(rehydrated.getTask(untouched.task.id)?.readingTime).toBeUndefined();
    } finally {
      rehydrated.stop();
    }
  });

  it('is idempotent: running it twice lands on the same total, never doubled', async () => {
    writeLines(dataDir, [
      readSessionLine({ docId: taskBodyDocId(taskId), durationMs: 20_000, sessionId: 'a' }),
      readSessionLine({ docId: taskBodyDocId(taskId), durationMs: 10_000, sessionId: 'b' }),
    ]);
    runReadingTimeBackfill({ dataDir });
    runReadingTimeBackfill({ dataDir });

    const rehydrated = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      expect(rehydrated.getTask(taskId)?.readingTime?.totalSeconds).toBe(30);
      expect(rehydrated.getTask(taskId)?.readingTime?.sessionCount).toBe(2);
    } finally {
      rehydrated.stop();
    }
  });

  it('recomputing after the live hook already folded in the same events does not double-count', () => {
    const live = new TaskStore({ dataDir, debounceMs: 5 });
    live.recordReadingTime(taskId, 20); // as the live POST hook would
    live.stop();

    // The very same session, now also sitting in the log (as it would be:
    // the live hook and the log append happen from the same POST).
    writeLines(dataDir, [readSessionLine({ docId: taskBodyDocId(taskId), durationMs: 20_000 })]);
    runReadingTimeBackfill({ dataDir });

    const rehydrated = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      // Still 20, not 40 — the backfill recomputes from the log rather than
      // adding to whatever the live hook already wrote.
      expect(rehydrated.getTask(taskId)?.readingTime?.totalSeconds).toBe(20);
    } finally {
      rehydrated.stop();
    }
  });

  it('a read_session for a since-deleted task counts as not-found, never throws', () => {
    writeLines(dataDir, [readSessionLine({ docId: 'task:t-gone', durationMs: 5_000 })]);
    const stats = runReadingTimeBackfill({ dataDir });
    expect(stats.tasksNotFound).toBe(1);
    expect(stats.tasksTouched).toBe(0);
  });

  it('a dry run (write:false) reports what would change without writing anything', () => {
    writeLines(dataDir, [readSessionLine({ docId: taskBodyDocId(taskId), durationMs: 15_000 })]);
    const stats = runReadingTimeBackfill({ dataDir, write: false });
    expect(stats.tasksTouched).toBe(1);
    const rehydrated = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      expect(rehydrated.getTask(taskId)?.readingTime).toBeUndefined();
    } finally {
      rehydrated.stop();
    }
  });
});
