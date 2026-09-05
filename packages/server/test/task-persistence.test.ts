/**
 * Unit coverage for the store's disk layer — sidecar read/write and the four
 * persistence-contract builders — driven through a fake `TaskPersistenceHost`,
 * per testing-standards rule 4 ("every new server module ships with a unit
 * test"). `task-events.test.ts`, `goal-seed.ts`-backed suites and friends
 * already cover the same behaviour end-to-end through a real `TaskStore`;
 * this file exists so persist/hydrate and the four adapters are checked
 * without booting a whole store.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type TaskPersistenceHost,
  agentPersistenceFor,
  goalPersistenceFor,
  hydrateTasksFromDisk,
  legacyTriageSidecarPaths,
  loadAttachmentsSidecar,
  persistAttachmentsSidecar,
  persistWorkspaceTasks,
  reviewItemPersistenceFor,
  tasksSidecarPath,
  workspacePersistenceFor,
} from '../src/task-persistence.ts';
import type {
  AgentAttachment,
  BoardWorkspace,
  GoalRow,
  Task,
  TaskStoreEvent,
  WorkspaceState,
} from '../src/tasks.ts';

const ACTOR = { id: 'known-bryan', name: 'Bryan', kind: 'person' };

function workspace(id: string, overrides?: Partial<BoardWorkspace>): BoardWorkspace {
  return {
    id,
    name: 'W',
    goals: [],
    docIds: [],
    ...overrides,
  } as BoardWorkspace;
}

function task(id: string, overrides?: Partial<Task>): Task {
  return {
    id,
    title: 'T',
    status: 'todo',
    goal: 'chores',
    createdAt: 1_000,
    ...overrides,
  } as unknown as Task;
}

function attachment(agentId: string): AgentAttachment {
  return {
    workspaceId: 'ws-1',
    agentId,
    runtime: 'claude-code-local',
    lastHeartbeat: 1_000,
    lastToolCallAt: 1_000,
    capabilities: [],
  };
}

/** A minimal `TaskPersistenceHost` backed by real in-memory Maps, so the
 *  persist/hydrate functions and the four `*For` builders can be driven
 *  directly. Every method that isn't the subject of a given test is a
 *  thin, honest stub over the same Maps. */
function fakeHost(dataDir: string): TaskPersistenceHost & {
  emitted: TaskStoreEvent[];
  scheduledSaves: string[];
  scheduledAttachmentSaves: string[];
} {
  const emitted: TaskStoreEvent[] = [];
  const scheduledSaves: string[] = [];
  const scheduledAttachmentSaves: string[] = [];
  const host: TaskPersistenceHost & {
    emitted: TaskStoreEvent[];
    scheduledSaves: string[];
    scheduledAttachmentSaves: string[];
  } = {
    dataDir,
    workspaces: new Map<string, WorkspaceState>(),
    taskIndex: new Map(),
    goalIndex: new Map(),
    saveTimers: new Map(),
    attachmentSaveTimers: new Map(),
    attachmentThresholds: {},
    voiceAckGraceMs: 90_000,
    commentAckGraceMs: 90_000,
    roster: undefined,
    agentStreamProbe: undefined,
    deliveryProbe: undefined,
    workspaceStore: {
      assignLead: () => {},
    } as unknown as TaskPersistenceHost['workspaceStore'],
    getTask: (taskId) => {
      for (const state of host.workspaces.values()) {
        const t = state.tasks.get(taskId);
        if (t) return t;
      }
      return undefined;
    },
    getGoalRow: (goalId) => {
      for (const state of host.workspaces.values()) {
        const row = state.goalRows.get(goalId);
        if (row) return row;
      }
      return undefined;
    },
    hasLiveLeadAttachment: () => false,
    listUntriaged: () => [],
    goalIdExists: (ws, goalId) => ws.goals.some((g) => g.id === goalId),
    syncGoalRows: () => {},
    scheduleSave: (workspaceId) => {
      scheduledSaves.push(workspaceId);
    },
    scheduleAttachmentsSave: (workspaceId) => {
      scheduledAttachmentSaves.push(workspaceId);
    },
    noteBodyEdited: () => true,
    renameTask: () => ({ ok: true }) as unknown as ReturnType<TaskPersistenceHost['renameTask']>,
    emit: (event) => {
      emitted.push(event);
    },
    emitted,
    scheduledSaves,
    scheduledAttachmentSaves,
  };
  return host;
}

describe('task-persistence: sidecar paths', () => {
  it('tasksSidecarPath and legacyTriageSidecarPaths name the real on-disk paths', () => {
    expect(tasksSidecarPath('/data', 'ws-1')).toBe(join('/data', 'workspaces', 'ws-1.tasks.json'));
    expect(legacyTriageSidecarPaths('/data', 'ws-1')).toEqual([
      join('/data', 'workspaces', 'ws-1.retriage.json'),
      join('/data', 'workspaces', 'ws-1.bucket.json'),
      join('/data', 'workspaces', 'ws-1.taskreviews.json'),
    ]);
  });
});

describe('task-persistence: persist / load round trip', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup() {
    const dataDir = mkdtempSync(join(tmpdir(), 'task-persistence-'));
    dirs.push(dataDir);
    const host = fakeHost(dataDir);
    return { dataDir, host };
  }

  it('persistWorkspaceTasks writes tasks and goal rows, and cleans up the tmp file', () => {
    const { dataDir, host } = setup();
    const goalRow: GoalRow = {
      id: 'g-1',
      workspaceId: 'ws-1',
      kind: 'goal',
      title: 'Goal',
      order: 0,
      status: 'todo',
      transitions: [],
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    host.workspaces.set('ws-1', {
      workspace: workspace('ws-1'),
      tasks: new Map([['t-1', task('t-1')]]),
      goalRows: new Map([['g-1', goalRow]]),
      attachments: new Map(),
    });

    persistWorkspaceTasks(host, 'ws-1');

    const path = tasksSidecarPath(dataDir, 'ws-1');
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.workspace.id).toBe('ws-1');
    expect(written.tasks.map((t: Task) => t.id)).toEqual(['t-1']);
    expect(written.goalRows.map((r: GoalRow) => r.id)).toEqual(['g-1']);
  });

  it('persistWorkspaceTasks is a no-op for an unknown workspace', () => {
    const { dataDir, host } = setup();
    persistWorkspaceTasks(host, 'ws-missing');
    expect(existsSync(tasksSidecarPath(dataDir, 'ws-missing'))).toBe(false);
  });

  it('persistAttachmentsSidecar writes when non-empty and removes the file when empty', () => {
    const { dataDir, host } = setup();
    host.workspaces.set('ws-1', {
      workspace: workspace('ws-1'),
      tasks: new Map(),
      goalRows: new Map(),
      attachments: new Map([['agent-1', attachment('agent-1')]]),
    });
    persistAttachmentsSidecar(host, 'ws-1');
    const state = host.workspaces.get('ws-1');
    if (!state) throw new Error('unreachable');
    const path = tasksSidecarPath(dataDir, 'ws-1').replace('.tasks.json', '.attachments.json');
    expect(existsSync(path)).toBe(true);

    state.attachments.clear();
    persistAttachmentsSidecar(host, 'ws-1');
    expect(existsSync(path)).toBe(false);
  });

  it('loadAttachmentsSidecar round-trips what persistAttachmentsSidecar wrote, and skips bad-runtime rows', () => {
    const { dataDir, host } = setup();
    host.workspaces.set('ws-1', {
      workspace: workspace('ws-1'),
      tasks: new Map(),
      goalRows: new Map(),
      attachments: new Map([['agent-1', attachment('agent-1')]]),
    });
    persistAttachmentsSidecar(host, 'ws-1');

    const loaded = loadAttachmentsSidecar(host, 'ws-1');
    expect(Array.from(loaded.keys())).toEqual(['agent-1']);
    expect(loaded.get('agent-1')?.workspaceId).toBe('ws-1');

    // A hand-corrupted sidecar with a bad runtime for one row is skipped,
    // not fatal.
    const path = tasksSidecarPath(dataDir, 'ws-1').replace('.tasks.json', '.attachments.json');
    writeFileSync(
      path,
      JSON.stringify({
        attachments: [
          { agentId: 'agent-1', runtime: 'not-a-real-runtime', workspaceId: 'ws-1' },
          { agentId: 'agent-2', runtime: 'webhook', workspaceId: 'ws-1' },
        ],
      }),
    );
    const loaded2 = loadAttachmentsSidecar(host, 'ws-1');
    expect(Array.from(loaded2.keys())).toEqual(['agent-2']);
  });

  it('loadAttachmentsSidecar returns empty for a missing file', () => {
    const { host } = setup();
    expect(loadAttachmentsSidecar(host, 'ws-none').size).toBe(0);
  });
});

describe('task-persistence: hydrateTasksFromDisk', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup() {
    const dataDir = mkdtempSync(join(tmpdir(), 'task-persistence-hydrate-'));
    dirs.push(dataDir);
    const host = fakeHost(dataDir);
    return { dataDir, host };
  }

  it('is a no-op when the workspaces dir does not exist', () => {
    const { host } = setup();
    expect(() => hydrateTasksFromDisk(host)).not.toThrow();
    expect(host.workspaces.size).toBe(0);
  });

  it('loads a written sidecar back into workspaces, taskIndex and goalIndex', () => {
    const { host } = setup();
    host.workspaces.set('ws-1', {
      workspace: workspace('ws-1'),
      tasks: new Map([['t-1', task('t-1', { status: 'done' })]]),
      goalRows: new Map(),
      attachments: new Map(),
    });
    persistWorkspaceTasks(host, 'ws-1');

    const fresh = fakeHost(host.dataDir);
    hydrateTasksFromDisk(fresh);

    expect(fresh.workspaces.has('ws-1')).toBe(true);
    expect(fresh.taskIndex.get('t-1')).toBe('ws-1');
    expect(fresh.workspaces.get('ws-1')?.tasks.get('t-1')?.status).toBe('done');
  });

  it('flattens nested goals it finds on a legacy sidecar', () => {
    const { dataDir } = setup();
    const dir = join(dataDir, 'workspaces');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'ws-1.tasks.json'),
      JSON.stringify({
        workspace: {
          id: 'ws-1',
          name: 'W',
          goals: [
            {
              id: 'g-parent',
              title: 'Parent',
              subgoals: [{ id: 'g-child', title: 'Child' }],
            },
          ],
          docIds: [],
        },
        tasks: [],
        goalRows: [],
      }),
    );
    const fresh = fakeHost(dataDir);
    hydrateTasksFromDisk(fresh);
    const goals = fresh.workspaces.get('ws-1')?.workspace.goals ?? [];
    expect(goals.map((g) => g.id)).toEqual(['g-parent', 'g-child']);
  });

  it('backfills unplacedSince for an old chores task that predates the field', () => {
    const { dataDir } = setup();
    const dir = join(dataDir, 'workspaces');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'ws-1.tasks.json'),
      JSON.stringify({
        workspace: { id: 'ws-1', name: 'W', goals: [], docIds: [] },
        tasks: [{ id: 't-old', title: 'T', status: 'todo', goal: 'chores', createdAt: 5_000 }],
        goalRows: [],
      }),
    );
    const fresh = fakeHost(dataDir);
    hydrateTasksFromDisk(fresh);
    const t = fresh.workspaces.get('ws-1')?.tasks.get('t-old');
    expect(t?.unplacedSince).toBe(5_000);
  });

  it('resolves a pending judge verdict left by a mid-flight process death', () => {
    const { dataDir } = setup();
    const dir = join(dataDir, 'workspaces');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'ws-1.tasks.json'),
      JSON.stringify({
        workspace: { id: 'ws-1', name: 'W', goals: [], docIds: [] },
        tasks: [
          {
            id: 't-1',
            title: 'T',
            status: 'todo',
            goal: 'chores',
            createdAt: 1_000,
            unplacedSince: 1_000,
            reviews: [{ judge: { at: 1_000, verdict: 'pending' } }],
          },
        ],
        goalRows: [],
      }),
    );
    const fresh = fakeHost(dataDir);
    hydrateTasksFromDisk(fresh);
    const t = fresh.workspaces.get('ws-1')?.tasks.get('t-1');
    expect(t?.reviews?.[0]?.judge).toMatchObject({ verdict: 'unavailable' });
  });

  it('skips a sidecar with no workspace instead of throwing', () => {
    const { dataDir, host } = setup();
    const dir = join(dataDir, 'workspaces');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ws-bad.tasks.json'), JSON.stringify({ tasks: [] }));
    expect(() => hydrateTasksFromDisk(host)).not.toThrow();
    expect(host.workspaces.size).toBe(0);
  });
});

describe('task-persistence: the four *For persistence-contract builders', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup() {
    const dataDir = mkdtempSync(join(tmpdir(), 'task-persistence-adapters-'));
    dirs.push(dataDir);
    const host = fakeHost(dataDir);
    host.workspaces.set('ws-1', {
      workspace: workspace('ws-1'),
      tasks: new Map([['t-1', task('t-1')]]),
      goalRows: new Map(),
      attachments: new Map(),
    });
    return { dataDir, host };
  }

  it('reviewItemPersistenceFor delegates reads and writes onto the host', () => {
    const { host } = setup();
    const p = reviewItemPersistenceFor(host);
    expect(p.getTask('t-1')?.id).toBe('t-1');
    expect(Array.from(p.listTasksIn('ws-1'))).toHaveLength(1);
    expect(Array.from(p.listWorkspaceIds())).toEqual(['ws-1']);
    p.save('ws-1');
    expect(host.scheduledSaves).toEqual(['ws-1']);
    p.emit({
      type: 'workspace.renamed',
      workspaceId: 'ws-1',
      oldName: 'a',
      name: 'b',
      actor: ACTOR,
      ts: 1,
    } as unknown as Parameters<typeof p.emit>[0]);
    expect(host.emitted).toHaveLength(1);
  });

  it('goalPersistenceFor delegates onto the host, including goalIdExists', () => {
    const { host } = setup();
    host.workspaces.get('ws-1')!.workspace.goals = [{ id: 'g-1', title: 'Goal' }];
    const p = goalPersistenceFor(host);
    expect(p.getTask('t-1')?.id).toBe('t-1');
    expect(p.goalIdExists(host.workspaces.get('ws-1')!.workspace, 'g-1')).toBe(true);
    expect(p.goalIdExists(host.workspaces.get('ws-1')!.workspace, 'g-missing')).toBe(false);
  });

  it('agentPersistenceFor reads thresholds/grace windows live off the host, not snapshotted', () => {
    const { host } = setup();
    const p = agentPersistenceFor(host);
    expect(p.voiceAckGraceMs).toBe(90_000);
    host.voiceAckGraceMs = 5_000;
    expect(p.voiceAckGraceMs).toBe(5_000);
    p.saveAttachments('ws-1');
    expect(host.scheduledAttachmentSaves).toEqual(['ws-1']);
  });

  it('workspacePersistenceFor register/forget mutate the same workspaces map the host reads', () => {
    const { host } = setup();
    const p = workspacePersistenceFor(host);
    const newState: WorkspaceState = {
      workspace: workspace('ws-2'),
      tasks: new Map(),
      goalRows: new Map(),
      attachments: new Map(),
    };
    p.register('ws-2', newState);
    expect(host.workspaces.get('ws-2')).toBe(newState);
    p.forget('ws-2');
    expect(host.workspaces.has('ws-2')).toBe(false);
  });

  it('workspacePersistenceFor.cancelPendingSaves clears timers and reports what was pending', () => {
    const { host } = setup();
    const p = workspacePersistenceFor(host);
    const timer = setTimeout(() => {}, 100_000);
    host.saveTimers.set('ws-1', timer);
    const result = p.cancelPendingSaves('ws-1');
    expect(result).toEqual({ tasks: true, attachments: false });
    expect(host.saveTimers.has('ws-1')).toBe(false);
  });

  it('workspacePersistenceFor.removeTasksSidecar removes the real sidecar file', () => {
    const { dataDir, host } = setup();
    persistWorkspaceTasks(host, 'ws-1');
    const path = tasksSidecarPath(dataDir, 'ws-1');
    expect(existsSync(path)).toBe(true);
    const p = workspacePersistenceFor(host);
    expect(p.removeTasksSidecar('ws-1')).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});
