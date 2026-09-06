/**
 * The soft delete: taking a row off the board reversibly, and putting it
 * back. Tasks and goal bands both, because the band's archive CASCADES onto
 * the tasks standing under it — one gesture, one batch id, one restore that
 * brings back exactly what it removed.
 *
 * Split out of `tasks.ts` with the other four verb families. It is its own
 * file rather than part of `task-lifecycle.ts` because an archive is
 * deliberately NOT a status: it writes three fields and emits, it never goes
 * through the transition gate, and the never-hard-delete rule the whole
 * project runs on (CLAUDE.md) is stated by exactly these five verbs. It
 * reaches back into `task-lifecycle.ts` for `announceUnblocked`, which is
 * the one thing an archive shares with a close: whatever the row was gating
 * comes free and has to say so.
 */
import type { Task, TaskActor } from '@feedback/core/task-wire';
import { classifyActor } from './actor-identity.ts';
import { cryptoId, isArchived } from './task-fields.ts';
import { announceUnblocked } from './task-lifecycle.ts';
import type {
  ArchiveGoalResult,
  GoalRow,
  SetAssigneeResult,
  TaskArchivedEvent,
  TaskRestoredEvent,
  TaskUnblockedEvent,
  WorkspaceState,
} from './tasks.ts';

/**
 * The three rows this file announces.
 *
 * Narrower than `TaskStoreEvent` on purpose, the same reasoning as
 * `GoalStoreEvent`. Assignable INTO `TaskStoreEvent`.
 */
export type TaskArchiveEvent = TaskArchivedEvent | TaskRestoredEvent | TaskUnblockedEvent;

/** What an archive verb may reach in the store. Every row handed back is
 *  LIVE — mutated in place, then handed to `scheduleSave`. */
export interface TaskArchivePersistence {
  state(workspaceId: string): WorkspaceState | undefined;
  getTask(taskId: string): Task | undefined;
  getGoalRow(goalId: string): GoalRow | undefined;
  scheduleSave(workspaceId: string): void;
  emit(event: TaskArchiveEvent): void;
}

/** How long a park or archive reason may run. A reason is a line on a chip and
 *  a line in the audit trail, not a place to restate the ticket. */
const REASON_MAX = 200;

/** Trimmed, capped, and `undefined` when there is nothing left — so an empty
 *  string never becomes a reason the board renders as a blank chip title. */
function normalizeReason(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim().slice(0, REASON_MAX).trim();
  return text === '' ? undefined : text;
}

/** Reversible removal, for a task and for a band. One per `TaskStore`,
 *  holding no state of its own. */
export class TaskArchiveStore {
  constructor(private readonly p: TaskArchivePersistence) {}

  /**
   * Take a row off the board, reversibly — the SOFT delete, and the only
   * removal this store offers a task.
   *
   * Three fields and one event. Nothing moves, nothing is rewritten, and the
   * id keeps resolving through `getTask`, which is what lets the task's body
   * doc, its comment threads and every `after` edge pointing at it go on
   * working while it is gone from the lanes. `unarchiveTask` clears the same
   * three fields, so a restore has nothing to reconstruct and no half-state to
   * crash in.
   *
   * Idempotent by construction: archiving an archived row reports
   * `changed: false` and emits nothing, the same rule `setDueAt` and
   * `parkTask` follow. A re-send that produced an audit row would put a line
   * in the trail for a decision nobody made twice. Note what this costs — a
   * reason cannot be EDITED by re-archiving; restore and archive again, which
   * is honest, because the second reason is a second decision.
   */
  archiveTask(
    taskId: string,
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): SetAssigneeResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (isArchived(task)) return { ok: true, task, changed: false };
    const ts = Date.now();
    const reason = normalizeReason(opts.reason);
    // Same reading as the transition path, taken before the write: a row that
    // was already `done` was gating nothing, so archiving it frees nobody.
    const wasOpenBlocker = task.status !== 'done';
    task.archivedAt = ts;
    task.archivedBy = opts.actor.name;
    task.archiveReason = reason;
    task.updatedAt = ts;
    this.p.scheduleSave(task.workspaceId);
    this.p.emit({
      type: 'task.archived',
      workspaceId: task.workspaceId,
      taskId: task.id,
      title: task.title,
      ...(reason !== undefined ? { reason } : {}),
      actor: { id: opts.actor.id, name: opts.actor.name, kind: classifyActor(opts.actor) },
      ts,
    });
    // An archive takes the row out of `openBlockers` exactly as finally as a
    // close does, so whatever it was holding comes free and has to say so.
    announceUnblocked(
      this.p,
      task,
      { id: opts.actor.id, name: opts.actor.name, kind: classifyActor(opts.actor) },
      ts,
      wasOpenBlocker,
    );
    return { ok: true, task, changed: true };
  }

  /** Put an archived row back. The undo half, and the reason the archive is
   *  safe to reach for: everything it did was three field writes. */
  unarchiveTask(
    taskId: string,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): SetAssigneeResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (!isArchived(task)) return { ok: true, task, changed: false };
    const ts = Date.now();
    // The reason is read BEFORE it is cleared — the restored event carries it
    // so the pair reads as one story in the trail.
    const reason = task.archiveReason;
    // Assignment rather than `delete` (biome noDelete); JSON.stringify drops
    // an undefined from the sidecar, which is what keeps a row that was never
    // archived free of the keys entirely.
    task.archivedAt = undefined;
    task.archivedBy = undefined;
    task.archiveReason = undefined;
    // The cascade marker goes with them. A row put back by hand is no longer
    // part of the band's archive, so restoring that band later must not claim
    // it a second time — and archiving the band again re-stamps it anyway.
    task.archivedWithGoal = undefined;
    task.updatedAt = ts;
    this.p.scheduleSave(task.workspaceId);
    this.p.emit({
      type: 'task.restored',
      workspaceId: task.workspaceId,
      taskId: task.id,
      title: task.title,
      ...(reason !== undefined ? { reason } : {}),
      actor: { id: opts.actor.id, name: opts.actor.name, kind: classifyActor(opts.actor) },
      ts,
    });
    return { ok: true, task, changed: true };
  }

  /**
   * Every row a goal's archive would take with it: the band itself, and every
   * task standing under it that is not already archived.
   *
   * Public because the CONFIRMATION needs it before the write. "Archive this
   * goal and its 14 tasks?" is the whole point of the dialog — the blast
   * radius is the part a reader cannot see from a band header — and a count
   * the client derived for itself would be a second implementation of this
   * walk, free to disagree with the one that actually runs.
   *
   * Already-archived rows are deliberately absent: the cascade does not touch
   * them, so counting them would promise a removal that does not happen, and
   * — worse — the restore would then bring back a row somebody had put away
   * on its own.
   *
   * What the board shows under the band is what goes — nothing off it.
   */
  goalCascade(goalId: string): { taskIds: string[] } {
    const empty = { taskIds: [] };
    const row = this.p.getGoalRow(goalId);
    if (!row) return empty;
    const state = this.p.state(row.workspaceId);
    if (!state) return empty;
    const taskIds = Array.from(state.tasks.values())
      .filter((t) => t.goal === goalId && !isArchived(t))
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
      .map((t) => t.id);
    return { taskIds };
  }

  /**
   * Take a BAND off the board, reversibly, with everything standing under it.
   *
   * The cascade is the decision (Bryan, 2026-08-30: archiving a goal archives
   * its tasks too). The alternative — archive the band and leave its tasks
   * behind — either strands them under a header nobody can see or silently
   * dumps them into Backlog, and both are a bigger surprise than the one the
   * reader asked for. Soft on every row it touches, so the whole gesture is
   * still nothing but field writes, and `unarchiveGoal` is still a field
   * clear.
   *
   * Each cascaded row is stamped with `archivedWithGoal`, which is what makes
   * the restore exact rather than a guess from `task.goal` — see the field.
   *
   * Events: the band's own `task.archived` carries `kind: 'goal'`, the
   * `batchId` and the task count; every member carries `partOf: batchId`. The
   * trail therefore reads as one decision with its consequences attached
   * rather than as fifteen unexplained removals, and a per-row feed still
   * gets the line it needs. Same shape `workspace.goals_changed` already uses
   * for the moves a goal-list edit fans out.
   *
   * Idempotent, like `archiveTask`: re-archiving an archived band reports
   * `changed: false`, writes nothing and emits nothing.
   */
  archiveGoal(
    goalId: string,
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): ArchiveGoalResult {
    const goal = this.p.getGoalRow(goalId);
    if (!goal) return { ok: false, error: 'not-found' };
    if (isArchived(goal)) return { ok: true, goal, changed: false, taskIds: [] };
    const { taskIds } = this.goalCascade(goalId);
    const ts = Date.now();
    const reason = normalizeReason(opts.reason);
    const by: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    const batchId = cryptoId('ga');

    const stamp = (row: { archivedAt?: number; archivedBy?: string; updatedAt: number }): void => {
      row.archivedAt = ts;
      row.archivedBy = by.name;
      row.updatedAt = ts;
    };
    stamp(goal);
    goal.archiveReason = reason;

    for (const id of taskIds) {
      const task = this.p.getTask(id);
      if (!task) continue;
      stamp(task);
      task.archiveReason = reason;
      task.archivedWithGoal = goalId;
    }
    this.p.scheduleSave(goal.workspaceId);

    this.p.emit({
      type: 'task.archived',
      workspaceId: goal.workspaceId,
      taskId: goal.id,
      kind: 'goal',
      title: goal.title,
      ...(reason !== undefined ? { reason } : {}),
      batchId,
      cascadeTasks: taskIds.length,
      actor: by,
      ts,
    });
    for (const id of taskIds) {
      const row = this.p.getTask(id);
      if (!row) continue;
      this.p.emit({
        type: 'task.archived',
        workspaceId: goal.workspaceId,
        taskId: id,
        title: row.title,
        ...(reason !== undefined ? { reason } : {}),
        partOf: batchId,
        actor: by,
        ts,
      });
    }
    return { ok: true, goal, changed: true, taskIds };
  }

  /**
   * Put an archived band back, with exactly the rows its archive removed.
   *
   * "Exactly" is `archivedWithGoal`: a row somebody archived on its own before
   * the band went is not part of this restore and stays where they put it.
   * That asymmetry is the reason the marker exists at all — see the field.
   */
  unarchiveGoal(
    goalId: string,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): ArchiveGoalResult {
    const goal = this.p.getGoalRow(goalId);
    if (!goal) return { ok: false, error: 'not-found' };
    if (!isArchived(goal)) return { ok: true, goal, changed: false, taskIds: [] };
    const state = this.p.state(goal.workspaceId);
    if (!state) return { ok: false, error: 'not-found' };
    const ts = Date.now();
    // Read before it is cleared, so the pair reads as one story in the trail.
    const reason = goal.archiveReason;
    const by: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    const batchId = cryptoId('ga');

    const clear = (row: {
      archivedAt?: number;
      archivedBy?: string;
      archiveReason?: string;
      archivedWithGoal?: string;
      updatedAt: number;
    }): void => {
      // Assignment rather than `delete` (biome noDelete); JSON.stringify drops
      // an undefined-valued key, so the sidecar comes back without it.
      row.archivedAt = undefined;
      row.archivedBy = undefined;
      row.archiveReason = undefined;
      // Only a TASK carries this; a goal row has no `archivedWithGoal` of its
      // own, so the clear is a no-op on the band itself.
      row.archivedWithGoal = undefined;
      row.updatedAt = ts;
    };
    clear(goal);

    const taskIds: string[] = [];
    for (const task of state.tasks.values()) {
      if (task.archivedWithGoal !== goalId) continue;
      taskIds.push(task.id);
      clear(task);
    }
    this.p.scheduleSave(goal.workspaceId);

    this.p.emit({
      type: 'task.restored',
      workspaceId: goal.workspaceId,
      taskId: goal.id,
      kind: 'goal',
      title: goal.title,
      ...(reason !== undefined ? { reason } : {}),
      batchId,
      cascadeTasks: taskIds.length,
      actor: by,
      ts,
    });
    for (const id of taskIds) {
      const row = this.p.getTask(id);
      if (!row) continue;
      this.p.emit({
        type: 'task.restored',
        workspaceId: goal.workspaceId,
        taskId: id,
        title: row.title,
        ...(reason !== undefined ? { reason } : {}),
        partOf: batchId,
        actor: by,
        ts,
      });
    }
    return { ok: true, goal, changed: true, taskIds };
  }
}
