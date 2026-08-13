import { randomBytes } from 'node:crypto';
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
import { classifyActor } from './activity.ts';

/**
 * The hub task store: server-owned state for Workspace Hub workspaces and
 * their tasks (plan §3.2/§3.3).
 *
 * Words people write together live in CRDTs; facts the system is accountable
 * for — status, placement, who owns it — go through THIS gate. Every status
 * change lands here (`transition`), gets an append-only audit entry with the
 * actor's identity and kind, and carries whatever evidence the caller
 * attached. An evidence-less move to done/in-progress is allowed but flagged
 * (`unproven`) — flagging is easier to live with than blocking (§7.1); the
 * only hard stop is an `after` edge explicitly marked enforce.
 *
 * Persistence is a per-workspace JSON sidecar at
 * `<dataDir>/workspaces/<id>.tasks.json`, written on a short debounce after
 * changes settle — the same pattern as doc metadata. The sidecar is
 * authoritative on hydrate; the ydoc projection (a later commit) is a
 * read-only mirror of it, never a source.
 *
 * A hub Workspace is a NEW first-class entity: today's `workspaceId` on
 * DocMeta is only a grouping tag minted by folder binds / diff reviews.
 * `attachDoc` LINKS existing docs and reviews to a hub workspace — nothing
 * is migrated, and docs keep working at their current URLs.
 */

export type Ref =
  | { kind: 'doc'; docId: string }
  | { kind: 'thread'; docId: string; threadId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'diff'; workspaceId: string };

export interface WorkspaceSubgoal {
  id: string;
  title: string;
  dueAt?: number;
}

export interface WorkspaceGoal {
  id: string;
  title: string;
  dueAt?: number;
  /** ONE level max — deeper nesting kills the 5-second task (§3.2). */
  subgoals?: WorkspaceSubgoal[];
}

export interface HubWorkspace {
  /** Crypto-random and unguessable — URLs hang off it (§3.2). */
  id: string;
  name: string;
  /** The north-star statement triage judges against. Markdown. */
  goal: string;
  goalUpdatedAt: number;
  /** Ordered by priority — board sections ARE the goals. `chores` is a
   *  reserved out-of-band id, never present here (§3.2 edit contract). */
  goals: WorkspaceGoal[];
  /** Docs/reviews linked via attachDoc. Links, not membership — the docs'
   *  own metadata is untouched. */
  docIds: string[];
  createdAt: number;
}

export type TaskStatus = 'todo' | 'in-progress' | 'done';

const TASK_STATUSES: ReadonlySet<string> = new Set(['todo', 'in-progress', 'done']);

/** Reserved catch-all section id for no-goal work. Never in `goals[]`. */
export const CHORES_GOAL_ID = 'chores';

export interface TaskActor {
  id: string;
  name: string;
  kind: 'person' | 'agent';
}

export interface TaskEvidence {
  commit?: string;
  threadRef?: Ref;
}

export interface TaskTransition {
  ts: number;
  from: TaskStatus;
  to: TaskStatus;
  by: TaskActor;
  note?: string;
  evidence?: TaskEvidence;
  /** Agent-reported cost at done. */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface Task {
  /** `t-<crypto-random>`. */
  id: string;
  workspaceId: string;
  title: string;
  /** Markdown snapshot of the description. The live CRDT body room
   *  (`task:<taskId>`) arrives with the projection commit; this snapshot is
   *  for search/export and never re-seeds a live fragment (§3.3). */
  body?: string;
  /** 'human' | 'agent' | any named identity. Agent-decided by default. */
  assignee: string;
  /** Only meaningful when the assignee is a human. */
  needs?: 'action' | 'decision';
  /** Goal or subgoal id; `chores` is the catch-all. */
  goal: string;
  /** Fractional sort key — always room to insert between two tasks. */
  order: number;
  status: TaskStatus;
  /** Task ids this depends on — "don't start yet" is a dependency, not a
   *  status (§3.3, no held status). */
  after: string[];
  /** Subset of `after` whose edges hard-block transitions (opt-in per edge —
   *  a blanket refusal rule would block legitimate work). */
  afterEnforce?: string[];
  dueAt?: number;
  links: Ref[];
  /** The thread/doc this was promoted from. */
  origin?: Ref;
  /** The human's verbatim words at promotion or creation. */
  quote?: string;
  /** Decisions keep the verbatim answer. */
  answer?: { text: string; by: string; ts: number };
  /** Which goal (id + its text at the time) produced this placement. */
  triagedAgainst?: { goalId: string; goal: string; ts: number };
  /** Stamped by triage at placement time; keyed to the ACTION's damage. */
  riskTier?: 'green' | 'yellow' | 'red';
  /** Append-only audit trail. */
  transitions: TaskTransition[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateTaskOpts {
  title: string;
  body?: string;
  assignee?: string;
  needs?: 'action' | 'decision';
  goal?: string;
  order?: number;
  after?: string[];
  afterEnforce?: string[];
  dueAt?: number;
  links?: Ref[];
  origin?: Ref;
  quote?: string;
}

/** An open dependency reported by the transition gate. `enforce: true` means
 *  the edge refused the transition; otherwise it's a warning that lands in
 *  the caller's context at exactly the moment it matters (§3.3). */
export interface TransitionBlocker {
  taskId: string;
  title: string;
  status: TaskStatus;
  needs?: 'action' | 'decision';
  enforce: boolean;
  message: string;
}

export type TransitionResult =
  | { ok: true; task: Task; blockers: TransitionBlocker[]; unproven: boolean }
  | {
      ok: false;
      error: 'not-found' | 'bad-status' | 'same-status' | 'blocked';
      blockers?: TransitionBlocker[];
    };

export type CreateTaskResult =
  | { ok: true; task: Task }
  | { ok: false; error: 'workspace-not-found' | 'unknown-goal' | 'unknown-after' };

export interface ListTasksFilter {
  goal?: string;
  status?: TaskStatus;
  assignee?: string;
  needs?: 'action' | 'decision';
}

interface WorkspaceState {
  workspace: HubWorkspace;
  tasks: Map<string, Task>;
}

/** Where a workspace's sidecar lives. Exported so tests assert the real
 *  contract path rather than a re-implementation of it. */
export function tasksSidecarPath(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'workspaces', `${workspaceId}.tasks.json`);
}

function cryptoId(prefix: string): string {
  // 9 random bytes → 12 base64url chars. URL-safe, filename-safe, and every
  // char is legal in a docId (the future `task:<id>` body rooms need that).
  return `${prefix}-${randomBytes(9).toString('base64url')}`;
}

export class TaskStore {
  private workspaces = new Map<string, WorkspaceState>();
  private taskIndex = new Map<string, string>(); // taskId → workspaceId
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private dataDir: string;
  private debounceMs: number;

  constructor(opts: { dataDir: string; debounceMs?: number }) {
    this.dataDir = opts.dataDir;
    this.debounceMs = opts.debounceMs ?? 200;
    this.hydrateFromDisk();
  }

  // ── Workspaces ───────────────────────────────────────────────────────────

  createWorkspace(name: string, goal?: string): HubWorkspace {
    const now = Date.now();
    const workspace: HubWorkspace = {
      id: cryptoId('w'),
      name,
      goal: goal ?? '',
      goalUpdatedAt: now,
      goals: [],
      docIds: [],
      createdAt: now,
    };
    this.workspaces.set(workspace.id, { workspace, tasks: new Map() });
    this.scheduleSave(workspace.id);
    return workspace;
  }

  getWorkspace(id: string): HubWorkspace | undefined {
    return this.workspaces.get(id)?.workspace;
  }

  listWorkspaces(): HubWorkspace[] {
    return Array.from(this.workspaces.values()).map((s) => s.workspace);
  }

  /** Link an existing doc or review to a hub workspace. A link only — the
   *  doc's own metadata and URLs are untouched (nothing is migrated). */
  attachDoc(
    workspaceId: string,
    docId: string,
  ): { ok: true } | { ok: false; error: 'workspace-not-found' } {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    if (!state.workspace.docIds.includes(docId)) {
      state.workspace.docIds.push(docId);
      this.scheduleSave(workspaceId);
    }
    return { ok: true };
  }

  // ── Tasks ────────────────────────────────────────────────────────────────

  createTask(workspaceId: string, opts: CreateTaskOpts): CreateTaskResult {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };

    const goal = opts.goal ?? CHORES_GOAL_ID;
    if (!this.goalIdExists(state.workspace, goal)) {
      return { ok: false, error: 'unknown-goal' };
    }
    // Dangling `after` edges would silently never block (the gate skips ids
    // it can't resolve), so refuse them at creation where the caller can fix
    // the reference.
    const after = opts.after ?? [];
    for (const dep of after) {
      if (!state.tasks.has(dep)) return { ok: false, error: 'unknown-after' };
    }

    const now = Date.now();
    const inGoal = Array.from(state.tasks.values()).filter((t) => t.goal === goal);
    const order = opts.order ?? Math.max(0, ...inGoal.map((t) => t.order)) + 1;
    const task: Task = {
      id: cryptoId('t'),
      workspaceId,
      title: opts.title,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      assignee: opts.assignee ?? 'agent',
      ...(opts.needs !== undefined ? { needs: opts.needs } : {}),
      goal,
      order,
      status: 'todo',
      after,
      ...(opts.afterEnforce?.length ? { afterEnforce: opts.afterEnforce } : {}),
      ...(opts.dueAt !== undefined ? { dueAt: opts.dueAt } : {}),
      links: opts.links ?? [],
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.quote !== undefined ? { quote: opts.quote } : {}),
      transitions: [],
      createdAt: now,
      updatedAt: now,
    };
    state.tasks.set(task.id, task);
    this.taskIndex.set(task.id, workspaceId);
    this.scheduleSave(workspaceId);
    return { ok: true, task };
  }

  getTask(taskId: string): Task | undefined {
    const wsId = this.taskIndex.get(taskId);
    if (!wsId) return undefined;
    return this.workspaces.get(wsId)?.tasks.get(taskId);
  }

  listTasks(workspaceId: string, filter?: ListTasksFilter): Task[] {
    const state = this.workspaces.get(workspaceId);
    if (!state) return [];
    let tasks = Array.from(state.tasks.values());
    if (filter?.goal !== undefined) tasks = tasks.filter((t) => t.goal === filter.goal);
    if (filter?.status !== undefined) tasks = tasks.filter((t) => t.status === filter.status);
    if (filter?.assignee !== undefined) tasks = tasks.filter((t) => t.assignee === filter.assignee);
    if (filter?.needs !== undefined) tasks = tasks.filter((t) => t.needs === filter.needs);
    return tasks.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  /**
   * The single gate for status changes (§3.10). Every change is attributed
   * (`classifyActor` decides person vs agent — the same line the reply-reopens
   * rule draws, reused rather than reinvented) and appended to the task's
   * audit trail with whatever evidence was supplied.
   *
   * Gate semantics, in order:
   *  - unknown task / unknown status / no-op same-status → validation errors.
   *  - moving FORWARD (to in-progress or done) consults `after`: open
   *    dependencies come back as `blockers` in the result; an edge marked
   *    enforce refuses outright. Moving back to todo never consults the gate
   *    (undoing work must not be blockable).
   *  - `unproven` marks a forward move that attached no evidence: allowed,
   *    flagged, never refused (§7.1 — the worst this can do is draw attention
   *    to something that turned out to be fine).
   */
  transition(
    taskId: string,
    to: TaskStatus,
    opts: {
      actor: { id: string; name: string; kind?: string };
      note?: string;
      evidence?: TaskEvidence;
      usage?: { inputTokens: number; outputTokens: number };
    },
  ): TransitionResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (!TASK_STATUSES.has(to)) return { ok: false, error: 'bad-status' };
    if (task.status === to) return { ok: false, error: 'same-status' };

    const forward = to === 'in-progress' || to === 'done';
    const blockers = forward ? this.openBlockers(task) : [];
    const enforced = blockers.filter((b) => b.enforce);
    if (enforced.length > 0) {
      return { ok: false, error: 'blocked', blockers };
    }

    const by: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    const entry: TaskTransition = {
      ts: Date.now(),
      from: task.status,
      to,
      by,
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}),
      ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
    };
    task.transitions.push(entry);
    task.status = to;
    task.updatedAt = entry.ts;
    this.scheduleSave(task.workspaceId);

    const unproven = forward && opts.evidence === undefined;
    return { ok: true, task, blockers, unproven };
  }

  /** Open (not-done) dependencies of a task, described so the message can
   *  land verbatim in an agent's context: "blocked by open decision t-x:
   *  'your go'". A dangling id (dep task deleted) can't gate — skipped. */
  private openBlockers(task: Task): TransitionBlocker[] {
    const enforce = new Set(task.afterEnforce ?? []);
    const out: TransitionBlocker[] = [];
    for (const depId of task.after) {
      const dep = this.getTask(depId);
      if (!dep || dep.status === 'done') continue;
      const noun = dep.needs === 'decision' ? 'decision' : 'task';
      out.push({
        taskId: dep.id,
        title: dep.title,
        status: dep.status,
        ...(dep.needs !== undefined ? { needs: dep.needs } : {}),
        enforce: enforce.has(depId),
        message: `blocked by open ${noun} ${dep.id}: '${dep.title}'`,
      });
    }
    return out;
  }

  private goalIdExists(workspace: HubWorkspace, goalId: string): boolean {
    if (goalId === CHORES_GOAL_ID) return true;
    return workspace.goals.some(
      (g) => g.id === goalId || (g.subgoals ?? []).some((s) => s.id === goalId),
    );
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /** Flush every pending debounced write synchronously (tests, shutdown). */
  flush(): void {
    for (const [workspaceId, timer] of this.saveTimers) {
      clearTimeout(timer);
      this.persist(workspaceId);
    }
    this.saveTimers.clear();
  }

  /** Flush and stop — after this the store schedules nothing. */
  stop(): void {
    this.flush();
  }

  private scheduleSave(workspaceId: string): void {
    const prev = this.saveTimers.get(workspaceId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.saveTimers.delete(workspaceId);
      this.persist(workspaceId);
    }, this.debounceMs);
    // Never hold the process (or a test runner) open.
    timer.unref?.();
    this.saveTimers.set(workspaceId, timer);
  }

  private persist(workspaceId: string): void {
    const state = this.workspaces.get(workspaceId);
    if (!state) return;
    const dir = join(this.dataDir, 'workspaces');
    const path = tasksSidecarPath(this.dataDir, workspaceId);
    const tmp = `${path}.tmp`;
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const payload = {
        workspace: state.workspace,
        tasks: Array.from(state.tasks.values()),
      };
      // Write-then-rename so a crash mid-write can't leave a torn sidecar —
      // the sidecar is authoritative on hydrate, so a torn one loses the
      // whole board.
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
      renameSync(tmp, path);
    } catch (err) {
      console.error(`[tasks] failed to persist workspace ${workspaceId}:`, err);
      try {
        rmSync(tmp, { force: true });
      } catch {}
    }
  }

  private hydrateFromDisk(): void {
    const dir = join(this.dataDir, 'workspaces');
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
        };
        const workspace = parsed.workspace;
        if (!workspace || typeof workspace.id !== 'string') {
          console.error(`[tasks] sidecar ${entry} has no workspace — skipped`);
          continue;
        }
        const tasks = new Map<string, Task>();
        for (const task of parsed.tasks ?? []) {
          if (typeof task?.id !== 'string') continue;
          tasks.set(task.id, task);
          this.taskIndex.set(task.id, workspace.id);
        }
        this.workspaces.set(workspace.id, { workspace, tasks });
      } catch (err) {
        // A corrupt sidecar loses that one workspace, never the server.
        console.error(`[tasks] unreadable sidecar ${entry} — skipped:`, err);
      }
    }
  }
}
