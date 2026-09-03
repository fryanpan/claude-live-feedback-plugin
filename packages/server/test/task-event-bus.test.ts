/**
 * Unit coverage for `TaskEventBus` in isolation from `TaskStore` — driven
 * through a fake `TaskEventBusPersistence`, per testing-standards rule 4
 * ("every new server module ships with a unit test"). `task-events.test.ts`
 * already covers the same behaviour end-to-end through a real `TaskStore`;
 * this file exists so the bus's own contract — audit-then-observed-work-then
 * -listeners ordering, and the observed-work name matching — is checked
 * without booting a store.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TaskEventBus,
  type TaskEventBusPersistence,
  eventsLogPath,
} from '../src/task-event-bus.ts';
import type { AgentAttachment, TaskStoreEvent } from '../src/tasks.ts';

const ACTOR = { id: 'known-bryan', name: 'Bryan', kind: 'person' };

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

function renamedEvent(overrides?: Partial<TaskStoreEvent>): TaskStoreEvent {
  return {
    type: 'workspace.renamed',
    workspaceId: 'ws-1',
    oldName: 'Old',
    name: 'New',
    actor: ACTOR,
    ts: 1_000,
    ...overrides,
  } as TaskStoreEvent;
}

function readAudit(dataDir: string, workspaceId: string): Array<Record<string, unknown>> {
  const path = eventsLogPath(dataDir, workspaceId);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('TaskEventBus', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(opts?: {
    attachments?: Map<string, AgentAttachment>;
  }) {
    const dataDir = mkdtempSync(join(tmpdir(), 'task-event-bus-'));
    dirs.push(dataDir);
    const observedCalls: Array<{ workspaceId: string; agentId: string; at?: number }> = [];
    const p: TaskEventBusPersistence = {
      dataDir: () => dataDir,
      attachmentsFor: (workspaceId) =>
        workspaceId === 'ws-1' ? (opts?.attachments ?? new Map()) : undefined,
      noteAgentToolCall: (workspaceId, agentId, at) => {
        observedCalls.push({ workspaceId, agentId, at });
        return true;
      },
    };
    return { bus: new TaskEventBus(p), dataDir, observedCalls };
  }

  it('eventsLogPath names the per-workspace audit file', () => {
    expect(eventsLogPath('/data', 'ws-1')).toBe(join('/data', 'workspaces', 'ws-1.events.jsonl'));
  });

  it('emit appends to the audit log at the real path', () => {
    const { bus, dataDir } = setup();
    bus.emit(renamedEvent());
    const rows = readAudit(dataDir, 'ws-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'workspace.renamed', workspaceId: 'ws-1', name: 'New' });
  });

  it('emit fans out to every subscribed listener, and unsubscribe stops delivery', () => {
    const { bus } = setup();
    const seenA: TaskStoreEvent[] = [];
    const seenB: TaskStoreEvent[] = [];
    const unsubA = bus.onEvent((e) => seenA.push(e));
    bus.onEvent((e) => seenB.push(e));
    bus.emit(renamedEvent());
    unsubA();
    bus.emit(renamedEvent({ name: 'Newer' }));
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(2);
  });

  it('a listener that throws does not stop the audit log or the other listeners', () => {
    const { bus, dataDir } = setup();
    const seen: TaskStoreEvent[] = [];
    bus.onEvent(() => {
      throw new Error('boom');
    });
    bus.onEvent((e) => seen.push(e));
    expect(() => bus.emit(renamedEvent())).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(readAudit(dataDir, 'ws-1')).toHaveLength(1);
  });

  it('emit orders side effects: audit append, then observed-work, then listener fan-out', () => {
    const { bus, dataDir, observedCalls } = setup({
      attachments: new Map([['agent-bryan', attachment('agent-bryan')]]),
    });
    const order: string[] = [];
    // Asserted from INSIDE the listener: by the time it runs, the audit file
    // and the observed-work note must already exist. Asserting after `emit`
    // returns would pass for any order, since the whole body is synchronous.
    bus.onEvent(() => {
      order.push('listener');
      expect(existsSync(eventsLogPath(dataDir, 'ws-1'))).toBe(true);
      expect(observedCalls).toHaveLength(1);
    });
    bus.emit(renamedEvent());
    expect(order).toEqual(['listener']);
  });

  it('noteObservedWork matches the actor against every attachment-id spelling', () => {
    const { bus, observedCalls } = setup({
      attachments: new Map([['agent-bryan', attachment('agent-bryan')]]),
    });
    bus.emit(renamedEvent({ actor: { id: 'bryan', name: 'Bryan', kind: 'person' } }));
    expect(observedCalls).toHaveLength(1);
    expect(observedCalls[0]).toMatchObject({ workspaceId: 'ws-1', agentId: 'agent-bryan' });
  });

  it('noteObservedWork is a no-op for agent.* events, unknown actors, and no attachments', () => {
    const { bus, observedCalls } = setup({
      attachments: new Map([['agent-bryan', attachment('agent-bryan')]]),
    });
    bus.emit({
      type: 'agent.attached',
      workspaceId: 'ws-1',
      actor: ACTOR,
      ts: 1_000,
    } as unknown as TaskStoreEvent);
    bus.emit(renamedEvent({ actor: { id: 'nobody', name: 'Nobody', kind: 'person' } }));
    expect(observedCalls).toHaveLength(0);

    const { bus: bus2, observedCalls: calls2 } = setup({ attachments: new Map() });
    bus2.emit(renamedEvent());
    expect(calls2).toHaveLength(0);
  });
});
