/**
 * A fake store for the five row-verb modules, so each can be driven without
 * booting a `TaskStore` — testing-standards rule 4.
 *
 * It is one object rather than five because the five persistence contracts
 * overlap almost entirely (`state` / `getTask` / `getGoalRow` /
 * `scheduleSave` / `emit`), and because a test that wants to check the
 * archive's effect on a dependant needs the lifecycle's view of the same
 * rows. Each module is still constructed against its OWN interface, so a
 * member a module has no business reaching stays out of reach of that
 * module's type.
 *
 * All fixtures are synthetic. The repo is public.
 */
import type { Task, TaskStatus } from '@feedback/core/task-wire';
import { isReservedGoalId } from '../src/task-goals.ts';
import type {
  BoardWorkspace,
  GoalRow,
  TaskStoreEvent,
  TransitionResult,
  WorkspaceState,
} from '../src/tasks.ts';

export const WS = 'ws-1';
export const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'person' };
export const AGENT = { id: 'a-builder', name: 'Builder', kind: 'agent' };

export function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    workspaceId: WS,
    title: 'A row',
    assignee: 'Builder',
    goal: 'g-1',
    order: 1,
    status: 'todo',
    after: [],
    links: [],
    transitions: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

export function makeGoalRow(overrides: Partial<GoalRow> & { id: string }): GoalRow {
  return {
    workspaceId: WS,
    kind: 'goal',
    title: 'A band',
    goal: overrides.id,
    order: 1,
    status: 'todo',
    after: [],
    links: [],
    transitions: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    assignee: 'Builder',
    ...overrides,
  } as GoalRow;
}

export function makeWorkspace(overrides?: Partial<BoardWorkspace>): BoardWorkspace {
  return {
    id: WS,
    name: 'Board',
    goals: [{ id: 'g-1', title: 'First goal' }],
    docIds: [],
    ...overrides,
  } as BoardWorkspace;
}

/** Everything the five verb modules can reach, plus the recording a test
 *  reads back: which workspaces were saved, and what was emitted. */
export class FakeStore {
  readonly states = new Map<string, WorkspaceState>();
  readonly saved: string[] = [];
  /** Every emitted row. The five modules each emit a narrowed slice of
   *  `TaskStoreEvent`, and all five are assignable into it. */
  readonly events: TaskStoreEvent[] = [];
  readonly transitioned: Array<{ taskId: string; to: string }> = [];
  docRevisions = new Map<string, number>();
  rosterIds = new Map<string, string>();

  constructor(workspace: BoardWorkspace = makeWorkspace()) {
    this.states.set(workspace.id, {
      workspace,
      tasks: new Map(),
      goalRows: new Map(),
      attachments: new Map(),
    });
  }

  addTask(task: Task): Task {
    this.states.get(task.workspaceId)?.tasks.set(task.id, task);
    return task;
  }

  addGoalRow(row: GoalRow): GoalRow {
    this.states.get(row.workspaceId)?.goalRows.set(row.id, row);
    return row;
  }

  state(workspaceId: string): WorkspaceState | undefined {
    return this.states.get(workspaceId);
  }

  statesIter(): Iterable<WorkspaceState> {
    return this.states.values();
  }

  getTask(taskId: string): Task | undefined {
    for (const s of this.states.values()) {
      const t = s.tasks.get(taskId);
      if (t) return t;
    }
    return undefined;
  }

  getGoalRow(goalId: string): GoalRow | undefined {
    for (const s of this.states.values()) {
      const g = s.goalRows.get(goalId);
      if (g) return g;
    }
    return undefined;
  }

  /** The same reading `TaskStore` takes: a reserved band always exists. */
  goalIdExists(workspace: BoardWorkspace, goalId: string): boolean {
    if (isReservedGoalId(goalId)) return true;
    return workspace.goals.some((g) => g.id === goalId);
  }

  rosterIdFor(assignee: string): string | undefined {
    return this.rosterIds.get(assignee);
  }

  docRevisionFor(docId: string): number | undefined {
    return this.docRevisions.get(docId);
  }

  registerTask(taskId: string, workspaceId: string): void {
    this.index.set(taskId, workspaceId);
  }

  readonly index = new Map<string, string>();

  scheduleSave(workspaceId: string): void {
    this.saved.push(workspaceId);
  }

  emit(event: TaskStoreEvent): void {
    this.events.push(event);
  }

  /** The status gate, as `task-links.ts` reaches it — recorded rather than
   *  run, so a plan release can be checked without a lifecycle store. */
  transition(taskId: string, to: 'todo', _opts: unknown): TransitionResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    this.transitioned.push({ taskId, to });
    task.status = to as TaskStatus;
    return { ok: true, task, blockers: [] };
  }

  /** Every emitted row of one type, as plain records — a test asserts on
   *  the fields it names, not on the union arm. */
  eventsOfType(type: string): Array<Record<string, unknown>> {
    return this.events.filter((e) => e.type === type) as unknown as Array<Record<string, unknown>>;
  }
}
