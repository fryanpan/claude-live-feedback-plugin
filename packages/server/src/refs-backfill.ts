/**
 * Mine the links people already wrote into structured refs — both directions.
 *
 * The linkage model after the 2026-08-31 rework: a doc's OWN prose carries
 * its ties (Bryan: "depend on links inside the doc — they're there already"),
 * and the task/goal side surfaces them as a Docs field. That field reads
 * `task.links` / `goal.links` doc refs — which exist automatically for rows
 * filed via `sourceDoc`, but not for anything older, and not for a link
 * somebody simply typed. This module closes both gaps:
 *
 *  - `scanDocRefs`: one doc's body → a doc ref on every task/goal its prose
 *    links. Run for every doc by the backfill, and for the settled doc by
 *    the content-revision hook, so hand-written links keep working forever.
 *  - `scanRowRefs`: one task/goal's body (and a task's stored url-kind refs)
 *    → structured doc refs for the docs it links.
 *  - `runRefsBackfill`: the sweep over everything, idempotent, with a
 *    `dryRun` that counts what WOULD land and writes nothing.
 *
 * Idempotent by the same identity the store uses (`refKey` after doc-id
 * canonicalization), so re-running creates nothing new. Origins are never
 * written — a source tie nobody recorded is not guessed at — and a ref that
 * origin already carries is not duplicated into `links`. Rows and docs where
 * nothing is recoverable stay unlinked.
 */

import { extractWorkspaceLinks, parseWorkspaceLink } from '@feedback/core';
import type { Rooms } from './rooms.ts';
import { taskIdOfBodyDoc } from './task-projection.ts';
import type { GoalRow, Ref, Task, TaskStore } from './tasks.ts';
import { isValidRef, refKey } from './tasks.ts';

export interface RefsBackfillStats {
  docsScanned: number;
  taskBodiesScanned: number;
  goalBodiesScanned: number;
  /** Doc refs landed on tasks (doc-side scan + task-body scan together). */
  taskRefsCreated: number;
  /** Doc refs landed on goals. */
  goalRefsCreated: number;
  /** Subset of taskRefsCreated that came from a stored url-kind ref. */
  urlRefsUpgraded: number;
  /** Desired refs that already existed (origin or links) — the idempotency
   *  count: a re-run reports everything here and creates nothing. */
  skippedExisting: number;
  workspacesTouched: string[];
}

interface Ctx {
  rooms: Rooms;
  tasks: TaskStore;
  dryRun: boolean;
  stats: RefsBackfillStats;
  touched: Set<string>;
}

/** Whether `refs` (or a doc/thread `origin`) already ties to `canonicalDocId`,
 *  under alias-insensitive identity. */
function hasDocTie(
  rooms: Rooms,
  canonicalDocId: string,
  refs: readonly Ref[] | undefined,
  origin?: unknown,
): boolean {
  if (isValidRef(origin) && (origin.kind === 'doc' || origin.kind === 'thread')) {
    if (rooms.resolveDocId(origin.docId) === canonicalDocId) return true;
  }
  const key = refKey({ kind: 'doc', docId: canonicalDocId });
  return (refs ?? []).some(
    (r) =>
      r.kind === 'doc' && (refKey(r) === key || rooms.resolveDocId(r.docId) === canonicalDocId),
  );
}

/** Land a doc ref on a task, honouring dryRun and the counters. */
function addTaskDocRef(ctx: Ctx, task: Task, canonicalDocId: string, fromUrlRef: boolean): void {
  if (hasDocTie(ctx.rooms, canonicalDocId, task.links, task.origin)) {
    ctx.stats.skippedExisting++;
    return;
  }
  if (!ctx.dryRun) {
    const res = ctx.tasks.linkRef(task.id, { kind: 'doc', docId: canonicalDocId });
    if (!res.ok || !res.changed) return; // raced or refused: not a create
  }
  ctx.stats.taskRefsCreated++;
  if (fromUrlRef) ctx.stats.urlRefsUpgraded++;
  ctx.touched.add(task.workspaceId);
}

/** Land a doc ref on a goal row, honouring dryRun and the counters. */
function addGoalDocRef(ctx: Ctx, goal: GoalRow, canonicalDocId: string): void {
  if (hasDocTie(ctx.rooms, canonicalDocId, goal.links)) {
    ctx.stats.skippedExisting++;
    return;
  }
  if (!ctx.dryRun) {
    const res = ctx.tasks.linkGoalRef(goal.id, { kind: 'doc', docId: canonicalDocId });
    if (!res.ok || !res.changed) return;
  }
  ctx.stats.goalRefsCreated++;
  ctx.touched.add(goal.workspaceId);
}

/** A docId a ref may point at, or null when it is not a real, linkable doc
 *  (missing, a task/goal body room, a projection room). Canonicalized. */
function linkableDocId(rooms: Rooms, docId: string): string | null {
  const canonical = rooms.resolveDocId(docId);
  if (taskIdOfBodyDoc(canonical) !== null) return null;
  if (canonical.startsWith('ws:')) return null;
  if (!rooms.docExists(canonical)) return null;
  return canonical;
}

/**
 * One DOC's prose → doc refs on the tasks and goals it links. The scanned
 * doc must be a real content doc (the caller filters); `docId` may be an
 * alias — refs are stored under the canonical id.
 */
export function scanDocRefs(ctx: Ctx, docId: string): void {
  const canonical = ctx.rooms.resolveDocId(docId);
  const body = ctx.rooms.readMarkdownBody(canonical);
  if (body === null) return;
  ctx.stats.docsScanned++;
  for (const { link } of extractWorkspaceLinks(body)) {
    let rowId: string | null = null;
    if (link.kind === 'task') rowId = link.taskId;
    else if (link.kind === 'goal') rowId = link.goalId;
    else if (link.kind === 'doc' || link.kind === 'mockup') {
      // A task's body room is addressed as `task:<id>` — a link to it is a
      // link to the row.
      rowId = taskIdOfBodyDoc(ctx.rooms.resolveDocId(link.docId));
    }
    if (rowId === null) continue;
    const task = ctx.tasks.getTask(rowId);
    if (task) {
      addTaskDocRef(ctx, task, canonical, false);
      continue;
    }
    const goal = ctx.tasks.getGoalRow(rowId);
    if (goal) addGoalDocRef(ctx, goal, canonical);
    // A link to a row that does not exist: nothing recoverable, stays as is.
  }
}

/** The doc/mockup links in one markdown body, as canonical linkable ids. */
function docLinksIn(rooms: Rooms, body: string): string[] {
  const out: string[] = [];
  for (const { link } of extractWorkspaceLinks(body)) {
    if (link.kind !== 'doc' && link.kind !== 'mockup') continue;
    const id = linkableDocId(rooms, link.docId);
    if (id !== null && !out.includes(id)) out.push(id);
  }
  return out;
}

/** One TASK: its body's doc links, plus its stored url-kind refs that are
 *  really doc addresses, → structured doc refs on the task. */
function scanTaskRefs(ctx: Ctx, task: Task): void {
  ctx.stats.taskBodiesScanned++;
  for (const id of docLinksIn(ctx.rooms, task.body ?? '')) addTaskDocRef(ctx, task, id, false);
  for (const ref of task.links) {
    if (ref.kind !== 'url') continue;
    const link = parseWorkspaceLink(ref.url);
    if (!link || (link.kind !== 'doc' && link.kind !== 'mockup')) continue;
    const id = linkableDocId(ctx.rooms, link.docId);
    if (id !== null) addTaskDocRef(ctx, task, id, true);
  }
}

/** One GOAL: its body's doc links → doc refs on the goal row. */
function scanGoalRefs(ctx: Ctx, goal: GoalRow): void {
  ctx.stats.goalBodiesScanned++;
  for (const id of docLinksIn(ctx.rooms, goal.body ?? '')) addGoalDocRef(ctx, goal, id);
}

/** Doc ids worth scanning: real content docs, not body/projection rooms. */
function scannableDocIds(rooms: Rooms): string[] {
  return rooms
    .list()
    .map((m) => m.docId)
    .filter((id) => taskIdOfBodyDoc(id) === null && !id.startsWith('ws:'));
}

/**
 * The full sweep: every doc's prose, every task and goal body, every stored
 * url ref. Safe to re-run (second run: zero creates, everything in
 * `skippedExisting`). The caller refreshes the projection for
 * `workspacesTouched` — link writes emit no store event.
 */
export function runRefsBackfill(opts: {
  rooms: Rooms;
  tasks: TaskStore;
  dryRun: boolean;
}): RefsBackfillStats {
  const ctx: Ctx = {
    rooms: opts.rooms,
    tasks: opts.tasks,
    dryRun: opts.dryRun,
    touched: new Set(),
    stats: {
      docsScanned: 0,
      taskBodiesScanned: 0,
      goalBodiesScanned: 0,
      taskRefsCreated: 0,
      goalRefsCreated: 0,
      urlRefsUpgraded: 0,
      skippedExisting: 0,
      workspacesTouched: [],
    },
  };
  for (const docId of scannableDocIds(opts.rooms)) scanDocRefs(ctx, docId);
  for (const ws of opts.tasks.listWorkspaces()) {
    // Archived rows too: "backfill all past tasks" includes the ones the
    // board has moved past — their panel still opens.
    for (const task of opts.tasks.listTasks(ws.id, { includeArchived: true }))
      scanTaskRefs(ctx, task);
    for (const goal of opts.tasks.listGoalRows(ws.id)) scanGoalRefs(ctx, goal);
  }
  ctx.stats.workspacesTouched = [...ctx.touched].sort();
  return ctx.stats;
}

/**
 * The live half: one settled doc, scanned the way the backfill would. Wired
 * to the content-revision hook so a link somebody writes into a doc TODAY
 * becomes a ref without anyone remembering a second call. Returns the
 * workspaces whose rows changed, for the caller's projection refresh.
 */
export function scanSettledDocRefs(rooms: Rooms, tasks: TaskStore, docId: string): Set<string> {
  const canonical = rooms.resolveDocId(docId);
  if (taskIdOfBodyDoc(canonical) !== null || canonical.startsWith('ws:')) return new Set();
  const ctx: Ctx = {
    rooms,
    tasks,
    dryRun: false,
    touched: new Set(),
    stats: {
      docsScanned: 0,
      taskBodiesScanned: 0,
      goalBodiesScanned: 0,
      taskRefsCreated: 0,
      goalRefsCreated: 0,
      urlRefsUpgraded: 0,
      skippedExisting: 0,
      workspacesTouched: [],
    },
  };
  scanDocRefs(ctx, canonical);
  return ctx.touched;
}
