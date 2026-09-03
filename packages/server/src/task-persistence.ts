/**
 * The store's disk layer: where each per-workspace sidecar lives, reading
 * and writing the two that hold live state (`<id>.tasks.json`,
 * `<id>.attachments.json`), and the four small "seen through a contract"
 * objects that wire `ReviewItemStore` / `GoalStore` / `AgentStore` /
 * `WorkspaceStore` to the fields those sidecars back.
 *
 * Split out of `tasks.ts` — persist/hydrate and the wiring around them were
 * a layer below the store's own verbs, not a fifth responsibility beside
 * them. Every function here takes an explicit `store` parameter typed to
 * exactly what it reads or writes, the same seam `WorkspaceStore` / `GoalStore`
 * / `AgentStore` already use, so `TaskStore`'s own methods — themselves now
 * thin forwarders onto these functions — keep their signatures and no
 * caller outside this file and `tasks.ts` has to change.
 *
 * `TaskPersistenceHost` is the union of what every function below needs;
 * `TaskStore` satisfies it structurally once the fields and methods below
 * are no longer `private`. It is intentionally one interface rather than
 * one per function — every member is still named for the function(s) that
 * read it, and the alternative (four or five overlapping interfaces) would
 * have `TaskStore` implementing near-duplicates of the same shape.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Task, TaskStatus } from '@feedback/core/task-wire';
import type { ReviewItemPersistence } from './review-items/persistence.ts';
import {
  type AgentStorePersistence,
  type AgentStreamProbe,
  type AttachmentThresholds,
  type DeliveryProbe,
  attachmentsSidecarPath,
  commentQueuePath,
  voiceQueuePath,
} from './task-agents.ts';
import { eventsLogPath } from './task-event-bus.ts';
import { CHORES_GOAL_ID, type GoalStorePersistence } from './task-goals.ts';
import { type NestedGoalInput, flattenNestedGoals, isAttachmentRuntime } from './task-helpers.ts';
import type {
  AgentAttachment,
  AgentRoster,
  GoalRow,
  HubWorkspace,
  RenameTaskResult,
  TaskStoreEvent,
  WorkspaceState,
} from './tasks.ts';
import type { WorkspaceStore, WorkspaceStorePersistence } from './workspace-store.ts';

/** Where a workspace's sidecar lives. Exported so tests assert the real
 *  contract path rather than a re-implementation of it. */
export function tasksSidecarPath(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'workspaces', `${workspaceId}.tasks.json`);
}

/**
 * Sidecars the REMOVED triage-request flow used to queue undelivered asks in:
 * the workspace-level north-star re-triage (`.retriage.json`), the "a band
 * appeared, re-look at the bucket" ask (`.bucket.json`), and the lead's
 * task-review queue (`.taskreviews.json`).
 *
 * Nothing reads or writes any of them any more — the lead is woken by the
 * events that already reach it, so there is no bespoke ask to park. They
 * survive as names only so `deleteWorkspace` keeps sweeping the files up: a
 * board deleted after this change would otherwise leave sidecars behind that
 * nothing on the box can reach or explain. Deleting queue bookkeeping is not
 * a soft-delete concern (CLAUDE.md: "the rule is about user content and
 * history"); these files hold neither.
 */
export function legacyTriageSidecarPaths(dataDir: string, workspaceId: string): string[] {
  const dir = join(dataDir, 'workspaces');
  return [
    join(dir, `${workspaceId}.retriage.json`),
    join(dir, `${workspaceId}.bucket.json`),
    join(dir, `${workspaceId}.taskreviews.json`),
  ];
}

/** What every function in this file may reach on the store. Every row
 *  handed back is LIVE — the same `Map`s `TaskStore` itself reads and
 *  writes, not a copy. */
export interface TaskPersistenceHost {
  dataDir: string;
  workspaces: Map<string, WorkspaceState>;
  taskIndex: Map<string, string>;
  goalIndex: Map<string, string>;
  saveTimers: Map<string, ReturnType<typeof setTimeout>>;
  attachmentSaveTimers: Map<string, ReturnType<typeof setTimeout>>;
  attachmentThresholds: AttachmentThresholds;
  voiceAckGraceMs: number;
  commentAckGraceMs: number;
  roster: AgentRoster | undefined;
  agentStreamProbe: AgentStreamProbe | undefined;
  deliveryProbe: DeliveryProbe | undefined;
  workspaceStore: WorkspaceStore;
  getTask(taskId: string): Task | undefined;
  getGoalRow(goalId: string): GoalRow | undefined;
  hasLiveLeadAttachment(workspaceId: string): boolean;
  listUntriaged(workspaceId: string): Task[];
  goalIdExists(workspace: HubWorkspace, goalId: string): boolean;
  /** Re-derive the workspace's goal rows after the band list changed. */
  syncGoalRows(state: WorkspaceState, mintStatus: TaskStatus): void;
  scheduleSave(workspaceId: string): void;
  scheduleAttachmentsSave(workspaceId: string): void;
  noteBodyEdited(
    taskId: string,
    opts: {
      actor: { id: string; name: string; kind?: string };
      title?: string;
      reason?: string;
    },
  ): boolean;
  renameTask(
    taskId: string,
    title: string,
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): RenameTaskResult;
  emit(event: TaskStoreEvent): void;
}

/** `store`, seen through the review-item contract and nothing more. */
export function reviewItemPersistenceFor(store: TaskPersistenceHost): ReviewItemPersistence {
  return {
    getTask: (taskId) => store.getTask(taskId),
    listTasksIn: (workspaceId) => store.workspaces.get(workspaceId)?.tasks.values() ?? [],
    listWorkspaceIds: () => store.workspaces.keys(),
    getWorkspaceRecord: (workspaceId) => store.workspaces.get(workspaceId)?.workspace,
    save: (workspaceId) => store.scheduleSave(workspaceId),
    emit: (event) => store.emit(event),
    now: () => Date.now(),
    noteBodyEdited: (taskId, opts) => store.noteBodyEdited(taskId, opts),
    renameTask: (taskId, title, opts) => store.renameTask(taskId, title, opts),
  };
}

/** `store`, seen through the goal-band contract. */
export function goalPersistenceFor(store: TaskPersistenceHost): GoalStorePersistence {
  return {
    state: (workspaceId) => store.workspaces.get(workspaceId),
    states: () => store.workspaces.values(),
    getTask: (taskId) => store.getTask(taskId),
    goalIdExists: (workspace, goalId) => store.goalIdExists(workspace, goalId),
    syncGoalRows: (state, mintStatus) => store.syncGoalRows(state, mintStatus),
    scheduleSave: (workspaceId) => store.scheduleSave(workspaceId),
    emit: (event) => store.emit(event),
  };
}

/** `store`, seen through the agent-attachment contract. The probes'
 *  defaults are folded in here so `task-agents.ts` never restates them. */
export function agentPersistenceFor(store: TaskPersistenceHost): AgentStorePersistence {
  return {
    dataDir: () => store.dataDir,
    state: (workspaceId) => store.workspaces.get(workspaceId),
    states: () => store.workspaces.values(),
    hasWorkspace: (workspaceId) => store.workspaces.has(workspaceId),
    get thresholds() {
      return store.attachmentThresholds;
    },
    get voiceAckGraceMs() {
      return store.voiceAckGraceMs;
    },
    get commentAckGraceMs() {
      return store.commentAckGraceMs;
    },
    roster: () => store.roster,
    agentStreamProbe: (workspaceId, agentId) =>
      store.agentStreamProbe?.(workspaceId, agentId) ?? false,
    deliveryProbe: (workspaceId) => store.deliveryProbe?.(workspaceId) ?? true,
    saveAttachments: (workspaceId) => store.scheduleAttachmentsSave(workspaceId),
    listUntriaged: (workspaceId) => store.listUntriaged(workspaceId),
    assignLead: (state, leadAgentId, actor, ts) =>
      store.workspaceStore.assignLead(state, leadAgentId, actor, ts),
    emit: (event) => store.emit(event),
  };
}

/** `store`, seen through the board-registry contract. Same shape as the
 *  review-item seam above: a named list of rows and writers, not a `store`
 *  that reaches the whole thing untyped. */
export function workspacePersistenceFor(store: TaskPersistenceHost): WorkspaceStorePersistence {
  return {
    state: (workspaceId) => store.workspaces.get(workspaceId),
    states: () => store.workspaces.values(),
    register: (workspaceId, state) => {
      store.workspaces.set(workspaceId, state);
    },
    forget: (workspaceId) => {
      store.workspaces.delete(workspaceId);
    },
    forgetRows: (taskIds, goalIds) => {
      for (const taskId of taskIds) store.taskIndex.delete(taskId);
      for (const goalId of goalIds) store.goalIndex.delete(goalId);
    },
    scheduleSave: (workspaceId) => store.scheduleSave(workspaceId),
    scheduleAttachmentsSave: (workspaceId) => store.scheduleAttachmentsSave(workspaceId),
    cancelPendingSaves: (workspaceId) => {
      const pending = store.saveTimers.get(workspaceId);
      if (pending) clearTimeout(pending);
      store.saveTimers.delete(workspaceId);
      const pendingAttachments = store.attachmentSaveTimers.get(workspaceId);
      if (pendingAttachments) clearTimeout(pendingAttachments);
      store.attachmentSaveTimers.delete(workspaceId);
      return { tasks: pending !== undefined, attachments: pendingAttachments !== undefined };
    },
    removeTasksSidecar: (workspaceId) => {
      try {
        rmSync(tasksSidecarPath(store.dataDir, workspaceId), { force: true });
        return true;
      } catch (err) {
        console.error(`[tasks] failed to remove the tasks sidecar for ${workspaceId}:`, err);
        return false;
      }
    },
    removeSidecars: (workspaceId) => {
      // The list is every OTHER per-workspace path this file exports; a new
      // sidecar belongs here the day it is added, or it becomes a file
      // nothing can reach.
      for (const path of [
        attachmentsSidecarPath(store.dataDir, workspaceId),
        eventsLogPath(store.dataDir, workspaceId),
        voiceQueuePath(store.dataDir, workspaceId),
        commentQueuePath(store.dataDir, workspaceId),
        ...legacyTriageSidecarPaths(store.dataDir, workspaceId),
      ]) {
        try {
          rmSync(path, { force: true });
        } catch (err) {
          console.error(`[tasks] failed to remove ${path}:`, err);
        }
      }
    },
    getTask: (taskId) => store.getTask(taskId),
    getGoalRow: (goalId) => store.getGoalRow(goalId),
    hasLiveLeadAttachment: (workspaceId) => store.hasLiveLeadAttachment(workspaceId),
    emit: (event) => store.emit(event),
  };
}

/** Write a workspace's task-row sidecar (`persist`). Write-then-rename so a
 *  crash mid-write can't leave a torn sidecar — the sidecar is authoritative
 *  on hydrate, so a torn one loses the whole board. */
export function persistWorkspaceTasks(store: TaskPersistenceHost, workspaceId: string): void {
  const state = store.workspaces.get(workspaceId);
  if (!state) return;
  const dir = join(store.dataDir, 'workspaces');
  const path = tasksSidecarPath(store.dataDir, workspaceId);
  const tmp = `${path}.tmp`;
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload = {
      workspace: state.workspace,
      tasks: Array.from(state.tasks.values()),
      // A key of its own rather than rows mixed into `tasks`: a reader that
      // has not heard of goal rows gets exactly the task list it expects,
      // and `workspace.goals[]` above stays on disk as the rollback path.
      goalRows: Array.from(state.goalRows.values()),
    };
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (err) {
    console.error(`[tasks] failed to persist workspace ${workspaceId}:`, err);
    try {
      rmSync(tmp, { force: true });
    } catch {}
  }
}

/** Attachments get their own sidecar so heartbeat churn never rewrites the
 *  task data. Empty registry → the file is removed (private-meta pattern:
 *  nothing sensitive left on disk when nothing is attached). */
export function persistAttachmentsSidecar(store: TaskPersistenceHost, workspaceId: string): void {
  const state = store.workspaces.get(workspaceId);
  if (!state) return;
  const dir = join(store.dataDir, 'workspaces');
  const path = attachmentsSidecarPath(store.dataDir, workspaceId);
  const tmp = `${path}.tmp`;
  try {
    if (state.attachments.size === 0) {
      rmSync(path, { force: true });
      return;
    }
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload = { attachments: Array.from(state.attachments.values()) };
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (err) {
    console.error(`[tasks] failed to persist attachments for ${workspaceId}:`, err);
    try {
      rmSync(tmp, { force: true });
    } catch {}
  }
}

/** Load a workspace's attachments sidecar. Records hydrate with their old
 *  clocks — a stale lastHeartbeat honestly reads as `away` until the agent
 *  heartbeats again; we never reset it to look alive. */
export function loadAttachmentsSidecar(
  store: TaskPersistenceHost,
  workspaceId: string,
): Map<string, AgentAttachment> {
  const out = new Map<string, AgentAttachment>();
  const path = attachmentsSidecarPath(store.dataDir, workspaceId);
  if (!existsSync(path)) return out;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      attachments?: AgentAttachment[];
    };
    for (const att of parsed.attachments ?? []) {
      if (typeof att?.agentId !== 'string' || !isAttachmentRuntime(att.runtime)) continue;
      out.set(att.agentId, { ...att, workspaceId });
    }
  } catch (err) {
    // A corrupt sidecar loses the attachments, never the workspace.
    console.error(`[tasks] unreadable attachments sidecar for ${workspaceId} — skipped:`, err);
  }
  return out;
}

/** Load every workspace sidecar on disk into `store` — the constructor's
 *  hydrate step, including the migrations a sidecar written before a given
 *  field or shape existed still needs. */
export function hydrateTasksFromDisk(store: TaskPersistenceHost): void {
  const dir = join(store.dataDir, 'workspaces');
  if (!existsSync(dir)) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.error('[tasks] failed to read workspaces dir:', err);
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.tasks.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as {
        workspace?: HubWorkspace;
        tasks?: Task[];
        goalRows?: GoalRow[];
      };
      const workspace = parsed.workspace;
      if (!workspace || typeof workspace.id !== 'string') {
        console.error(`[tasks] sidecar ${entry} has no workspace — skipped`);
        continue;
      }
      // Boards written before subgoals were removed still hold them, and
      // every reader below this line looks at `goals` alone. Without this
      // the nested bands would simply not exist after the deploy — their
      // tasks reading as unknown-goal work, and the next goal-list edit
      // stranding them for real. Flattened HERE, at the one door a stored
      // list comes through, rather than in each reader.
      workspace.goals = flattenNestedGoals((workspace.goals ?? []) as readonly NestedGoalInput[]);
      const tasks = new Map<string, Task>();
      for (const task of parsed.tasks ?? []) {
        if (typeof task?.id !== 'string') continue;
        // `unplacedSince` is deliberately NOT cleared here — see the field.
        // But every task written before it existed lacks it, and the sweep
        // now keys on it, so a writer-only fix would empty the bucket for
        // the entire existing board at the deploy. Reproduce the membership
        // rule the old predicate used (Backlog + open + never placed) and
        // date it from `createdAt`, the only honest timestamp available.
        //
        // It over-includes a legacy explicit `goal: 'chores'` create, and
        // it has to: that distinction was never recorded, so there is
        // nothing on disk to read it from. Over-including asks about one
        // extra task; under-including silently drops real ones.
        if (
          task.unplacedSince === undefined &&
          task.goal === CHORES_GOAL_ID &&
          task.status !== 'done' &&
          task.triagedAgainst === undefined
        ) {
          task.unplacedSince = task.createdAt;
        }
        // A judge call that was out when the last process died never
        // came back. The item must not stay off the queue for it: a
        // verdict nobody will deliver is a judge failure, and those pass.
        for (const item of task.reviews ?? []) {
          if (item?.judge?.verdict === 'pending') {
            item.judge = {
              at: item.judge.at,
              verdict: 'unavailable',
              reason: 'the server restarted before the judge answered',
            };
          }
        }
        tasks.set(task.id, task);
        store.taskIndex.set(task.id, workspace.id);
      }
      const goalRows = new Map<string, GoalRow>();
      // Goals archived as somebody ELSE's cascade member — the shape a
      // subgoal's archive left behind, and the second half of the same
      // migration. A goal row no longer carries `archivedWithGoal` at all,
      // so the stored key is read once here and cleared.
      const cascadedGoals = new Set<string>();
      for (const row of parsed.goalRows ?? []) {
        if (typeof row?.id !== 'string') continue;
        const legacy = row as { archivedWithGoal?: string };
        if (legacy.archivedWithGoal !== undefined) {
          cascadedGoals.add(row.id);
          legacy.archivedWithGoal = undefined;
        }
        goalRows.set(row.id, row);
        store.goalIndex.set(row.id, workspace.id);
      }
      // Its tasks were stamped with the PARENT's id, which is what made the
      // pair restore together. Flattened, that band restores on its own —
      // and would come back empty, its work still archived, while restoring
      // the old parent revived those tasks under a band that is still off
      // the board. Re-point them at the band they actually sit in, so
      // either restore is the whole of one decision again.
      if (cascadedGoals.size > 0) {
        for (const task of parsed.tasks ?? []) {
          if (task?.archivedWithGoal === undefined) continue;
          if (cascadedGoals.has(task.goal)) task.archivedWithGoal = task.goal;
        }
      }
      store.workspaces.set(workspace.id, {
        workspace,
        tasks,
        goalRows,
        attachments: loadAttachmentsSidecar(store, workspace.id),
      });
      // The migration, and it is lazy on purpose: every board on disk today
      // has `goals` and no `goalRows`, so the rows are minted the first time
      // that board is read back. Re-running it is safe by construction — the
      // reconcile refreshes only what the goal LIST owns.
      const state = store.workspaces.get(workspace.id);
      // `todo`, NOT the create default: this is the migration, and every
      // band on an existing board was agreed to long before goal rows
      // existed. Minting these `triage` would halt dispatch fleet-wide on
      // the first read after deploy.
      if (state) store.syncGoalRows(state, 'todo');
    } catch (err) {
      // A corrupt sidecar loses that one workspace, never the server.
      console.error(`[tasks] unreadable sidecar ${entry} — skipped:`, err);
    }
  }
}
