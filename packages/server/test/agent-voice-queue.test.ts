/**
 * Unit coverage for `AgentVoiceQueue` in isolation from `AgentStore` —
 * driven through a fake `AgentStorePersistence`, per testing-standards rule
 * 4 ("every new server module ships with a unit test"). `voice-durability.ts`
 * and friends already cover the same behaviour end-to-end through a real
 * `TaskStore`; this file exists so the queue's own contract is checked
 * without booting a server.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentVoiceQueue,
  type QueuedVoiceRequest,
  voiceQueuePath,
} from '../src/agent-voice-queue.ts';
import type { AgentStoreEvent } from '../src/task-agents.ts';
import { fakePersistence } from './fake-agent-store-persistence.ts';

describe('AgentVoiceQueue', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(opts?: { voiceAckGraceMs?: number; knownWorkspaces?: string[] }) {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-voice-queue-'));
    dirs.push(dataDir);
    const events: AgentStoreEvent[] = [];
    const p = fakePersistence({
      dataDir,
      knownWorkspaces: opts?.knownWorkspaces ?? ['ws-1'],
      voiceAckGraceMs: opts?.voiceAckGraceMs ?? 90_000,
      onEmit: (e) => events.push(e),
    });
    return { queue: new AgentVoiceQueue(p), dataDir, events };
  }

  it('queues a request and hands back an id that names the row', () => {
    const { queue } = setup();
    const id = queue.queueVoiceRequest('ws-1', {
      transcript: 'move the ticket up',
      actor: { id: 'u-1', name: 'Reviewer' },
    });
    expect(typeof id).toBe('string');
    expect(queue.listQueuedVoice('ws-1').map((q) => q.id)).toEqual([id as string]);
  });

  it('refuses to queue or record for a workspace it does not know', () => {
    const { queue, events } = setup();
    expect(
      queue.queueVoiceRequest('ws-unknown', { transcript: 'x', actor: { id: 'u', name: 'U' } }),
    ).toBe(false);
    expect(
      queue.recordVoiceRequest('ws-unknown', {
        transcript: 'x',
        route: 'agent',
        ack: 'ack',
        actor: { id: 'u', name: 'U' },
      }),
    ).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('recordVoiceRequest emits a voice.request row for a known workspace', () => {
    const { queue, events } = setup();
    const ok = queue.recordVoiceRequest('ws-1', {
      transcript: 'ship it',
      route: 'agent',
      ack: 'Sent.',
      actor: { id: 'u-1', name: 'Reviewer' },
    });
    expect(ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'voice.request',
      workspaceId: 'ws-1',
      transcript: 'ship it',
    });
  });

  it('persists the queue at the documented sidecar path', () => {
    const { queue, dataDir } = setup();
    queue.queueVoiceRequest('ws-1', { transcript: 'x', actor: { id: 'u', name: 'U' } });
    const path = voiceQueuePath(dataDir, 'ws-1');
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { queue: QueuedVoiceRequest[] };
    expect(parsed.queue).toHaveLength(1);
  });

  it('ackVoiceRequest removes exactly the named row and reports unknown ids as false', () => {
    const { queue } = setup();
    const id = queue.queueVoiceRequest('ws-1', { transcript: 'x', actor: { id: 'u', name: 'U' } });
    expect(queue.ackVoiceRequest('ws-1', 'not-a-real-id')).toBe(false);
    expect(queue.ackVoiceRequest('ws-1', id as string)).toBe(true);
    expect(queue.listQueuedVoice('ws-1')).toEqual([]);
  });

  it('markVoiceEmitted stamps emittedAt on the named row only', () => {
    const { queue } = setup();
    const id = queue.queueVoiceRequest('ws-1', {
      transcript: 'a',
      actor: { id: 'u', name: 'U' },
    }) as string;
    const other = queue.queueVoiceRequest('ws-1', {
      transcript: 'b',
      actor: { id: 'u', name: 'U' },
    }) as string;
    expect(queue.markVoiceEmitted('ws-1', id)).toBe(true);
    const rows = queue.listQueuedVoice('ws-1');
    expect(rows.find((r) => r.id === id)?.emittedAt).toBeTypeOf('number');
    expect(rows.find((r) => r.id === other)?.emittedAt).toBeUndefined();
  });

  it('drainVoiceQueue withholds a row still inside its grace window', () => {
    const { queue } = setup({ voiceAckGraceMs: 90_000 });
    const id = queue.queueVoiceRequest('ws-1', {
      transcript: 'x',
      actor: { id: 'u', name: 'U' },
    }) as string;
    queue.markVoiceEmitted('ws-1', id);
    const handedOver = queue.drainVoiceQueue('ws-1');
    expect(handedOver).toEqual([]);
    // The row is still on the books, waiting out the grace window.
    expect(queue.listQueuedVoice('ws-1').map((r) => r.id)).toEqual([id]);
  });

  it('drainVoiceQueue hands over a row once its grace window has passed', () => {
    const { queue, dataDir } = setup({ voiceAckGraceMs: 1 });
    const path = voiceQueuePath(dataDir, 'ws-1');
    const row: QueuedVoiceRequest = {
      id: 'vq-old',
      transcript: 'stale',
      actor: { id: 'u', name: 'U', kind: 'person' },
      emittedAt: Date.now() - 60_000,
      ts: Date.now() - 60_000,
    };
    mkdirSync(join(dataDir, 'workspaces'), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ queue: [row] })}\n`);
    const handedOver = queue.drainVoiceQueue('ws-1');
    expect(handedOver.map((r) => r.id)).toEqual(['vq-old']);
  });

  it('drainVoiceQueue with freshProcess bypasses the grace window entirely', () => {
    const { queue } = setup({ voiceAckGraceMs: 90_000 });
    const id = queue.queueVoiceRequest('ws-1', {
      transcript: 'x',
      actor: { id: 'u', name: 'U' },
    }) as string;
    queue.markVoiceEmitted('ws-1', id);
    const handedOver = queue.drainVoiceQueue('ws-1', { freshProcess: true });
    expect(handedOver.map((r) => r.id)).toEqual([id]);
  });
});
