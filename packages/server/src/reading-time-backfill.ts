#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Event, activityLogPath } from './activity.ts';
import { taskIdOfBodyDoc } from './task-projection.ts';
import { type TaskReadingTime, TaskStore } from './tasks.ts';

/**
 * Roll up every task-scoped `read_session` already sitting in
 * `activity.jsonl` onto the task record it describes.
 *
 * This is deliberately NOT the kind of backfill `activity-backfill.ts`
 * declines to do. That file reconstructs comment-family events from `.ydoc`
 * snapshots — data that was never recorded as an event at all, and for
 * `read_session` / `doc_open` it says outright that reconstruction is
 * impossible (scroll wasn't tracked before the tracker existed, so there is
 * nothing in a `.ydoc` to recover it from).
 *
 * Here there is nothing to reconstruct either, for the opposite reason:
 * every `read_session` this script folds in was already LIVE-CAPTURED —
 * real interaction-bounded attention, recorded the moment it happened,
 * since #468 mounted the reading tracker on the task detail panel. It has
 * simply never been summed onto `Task.readingTime`, because that field did
 * not exist until this change. This script is the one-time catch-up for
 * whatever already landed in the log; `TaskStore.recordReadingTime` (wired
 * into the `POST /api/docs/:id/activity` route) takes over from there for
 * every session going forward.
 *
 * Idempotent by construction: each task's total is a FULL recompute from
 * the current log, never an added delta. Running this twice, or running it
 * after the live hook has already folded in some of the same sessions,
 * lands on the same number either way — the recompute already includes
 * them.
 *
 * A task with zero `read_session` events in the log is left untouched:
 * `readingTime` stays absent ("not measured yet"), never zero.
 *
 * Never touches `.ydoc` files or the live event stream — read-only over
 * `activity.jsonl`, writes only through `TaskStore.setReadingTime`.
 */

export interface ReadingTimeBackfillStats {
  linesScanned: number;
  readSessionsFolded: number;
  /** Tasks whose `readingTime` was (or, in a dry run, would be) set. */
  tasksTouched: number;
  /** read_session events whose task id no longer resolves — the task was
   *  since deleted. Not an error; the events describe a row that's gone. */
  tasksNotFound: number;
}

interface ParsedTotals {
  totals: Map<string, TaskReadingTime>;
  linesScanned: number;
  readSessionsFolded: number;
}

/** Pure (no writes) so it's unit-testable independent of a TaskStore. */
export function readingTimeTotalsFromLog(dataDir: string): ParsedTotals {
  const totals = new Map<string, TaskReadingTime>();
  let linesScanned = 0;
  let readSessionsFolded = 0;
  const path = activityLogPath(dataDir);
  if (!existsSync(path)) return { totals, linesScanned, readSessionsFolded };
  const raw = readFileSync(path, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    linesScanned++;
    let ev: Event;
    try {
      const parsed: unknown = JSON.parse(line);
      // A malformed line must never abort the whole rollup — that includes
      // syntactically valid JSON that isn't an event object (`null`, `42`,
      // an array), which would otherwise throw on `ev.type` below.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      ev = parsed as Event;
    } catch {
      continue;
    }
    if (ev.type !== 'read_session') continue;
    const docId = ev.doc?.docId;
    const taskId = typeof docId === 'string' ? taskIdOfBodyDoc(docId) : null;
    if (!taskId) continue;
    const durationMs = ev.payload?.durationMs;
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) continue;
    const seconds = Math.round(durationMs / 1000);
    if (seconds <= 0) continue;
    const tsMs = Date.parse(ev.ts);
    const prev = totals.get(taskId) ?? { totalSeconds: 0, sessionCount: 0, lastSessionAt: 0 };
    prev.totalSeconds += seconds;
    prev.sessionCount += 1;
    if (Number.isFinite(tsMs) && tsMs > prev.lastSessionAt) prev.lastSessionAt = tsMs;
    totals.set(taskId, prev);
    readSessionsFolded++;
  }
  return { totals, linesScanned, readSessionsFolded };
}

export interface ReadingTimeBackfillOptions {
  dataDir: string;
  /** When false, computes stats but writes nothing. Default true. */
  write?: boolean;
}

export function runReadingTimeBackfill(opts: ReadingTimeBackfillOptions): ReadingTimeBackfillStats {
  const { totals, linesScanned, readSessionsFolded } = readingTimeTotalsFromLog(opts.dataDir);
  const store = new TaskStore({ dataDir: opts.dataDir, debounceMs: 50 });
  let tasksTouched = 0;
  let tasksNotFound = 0;
  for (const [taskId, readingTime] of totals) {
    if (opts.write === false) {
      if (store.getTask(taskId)) tasksTouched++;
      else tasksNotFound++;
      continue;
    }
    const res = store.setReadingTime(taskId, readingTime);
    if (res.ok) tasksTouched++;
    else tasksNotFound++;
  }
  // `setReadingTime` saves through the store's debounced writer; flush
  // synchronously so a caller sees the totals on disk the moment this
  // returns, rather than racing an unref'd timer.
  store.stop();
  return { linesScanned, readSessionsFolded, tasksTouched, tasksNotFound };
}

// Standalone runnable: `bun run packages/server/src/reading-time-backfill.ts [dataDir]`
if (import.meta.main) {
  const dataDir = process.argv[2] ?? join(process.cwd(), 'data');
  const dryRun = process.argv.includes('--dry-run');
  const stats = runReadingTimeBackfill({ dataDir, write: !dryRun });
  console.log(
    JSON.stringify(
      {
        dataDir,
        dryRun,
        ...stats,
      },
      null,
      2,
    ),
  );
}
