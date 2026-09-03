/**
 * Unit coverage for `AgentCommentQueue` in isolation from `AgentStore` —
 * driven through a fake `AgentStorePersistence`, per testing-standards rule
 * 4. `comment-durability.test.ts` already covers the same behaviour
 * end-to-end through a real `TaskStore`; this file exists so the queue's own
 * contract is checked without booting a server.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentCommentQueue,
  MAX_QUEUED_COMMENTS,
  type QueuedComment,
  commentQueuePath,
} from '../src/agent-comment-queue.ts';
import { fakePersistence } from './fake-agent-store-persistence.ts';

describe('AgentCommentQueue', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function setup(opts?: { commentAckGraceMs?: number }) {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-comment-queue-'));
    dirs.push(dataDir);
    const p = fakePersistence({
      dataDir,
      knownWorkspaces: ['ws-1'],
      commentAckGraceMs: opts?.commentAckGraceMs ?? 90_000,
    });
    return { queue: new AgentCommentQueue(p), dataDir };
  }

  const item = {
    agentId: 'agent-a',
    docId: 'doc-1',
    event: 'thread.created',
    author: { id: 'u-1', name: 'Reviewer' },
    text: 'left a comment',
  };

  it('queues a comment and hands back an id that names the row', () => {
    const { queue } = setup();
    const id = queue.queueComment('ws-1', item);
    expect(typeof id).toBe('string');
    expect(queue.listQueuedComments('ws-1').map((q) => q.id)).toEqual([id as string]);
  });

  it('refuses to queue for a workspace it does not know', () => {
    const { queue } = setup();
    expect(queue.queueComment('ws-unknown', item)).toBe(false);
  });

  it('persists the queue at the documented sidecar path', () => {
    const { queue, dataDir } = setup();
    queue.queueComment('ws-1', item);
    const path = commentQueuePath(dataDir, 'ws-1');
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { queue: QueuedComment[] };
    expect(parsed.queue).toHaveLength(1);
  });

  it('ackComment removes exactly the named row and reports unknown ids as false', () => {
    const { queue } = setup();
    const id = queue.queueComment('ws-1', item) as string;
    expect(queue.ackComment('ws-1', 'not-a-real-id')).toBe(false);
    expect(queue.ackComment('ws-1', id)).toBe(true);
    expect(queue.listQueuedComments('ws-1')).toEqual([]);
  });

  it('markCommentEmitted / clearCommentEmitted round-trip the emittedAt mark', () => {
    const { queue } = setup();
    const id = queue.queueComment('ws-1', item) as string;
    expect(queue.markCommentEmitted('ws-1', id)).toBe(true);
    expect(queue.listQueuedComments('ws-1')[0]?.emittedAt).toBeTypeOf('number');
    expect(queue.clearCommentEmitted('ws-1', id)).toBe(true);
    expect(queue.listQueuedComments('ws-1')[0]?.emittedAt).toBeUndefined();
    // A row with no emittedAt at all is a no-op, not an error.
    expect(queue.clearCommentEmitted('ws-1', id)).toBe(false);
  });

  it('the MAX_QUEUED_COMMENTS cap is per addressee, not shared across the file', () => {
    const { queue } = setup();
    for (let i = 0; i < MAX_QUEUED_COMMENTS + 5; i++) {
      queue.queueComment('ws-1', { ...item, agentId: 'agent-a', text: `a-${i}` });
    }
    queue.queueComment('ws-1', { ...item, agentId: 'agent-b', text: 'b-only' });
    const all = queue.listQueuedComments('ws-1');
    expect(all.filter((q) => q.agentId === 'agent-a')).toHaveLength(MAX_QUEUED_COMMENTS);
    // agent-b's single row survived the cap that trimmed agent-a's backlog.
    expect(all.filter((q) => q.agentId === 'agent-b')).toHaveLength(1);
    // The oldest agent-a rows were the ones dropped.
    const kept = all.filter((q) => q.agentId === 'agent-a').map((q) => q.text);
    expect(kept[0]).toBe('a-5');
  });

  it('takeDeliverableComments hands over only rows addressed to this agent', () => {
    const { queue } = setup();
    queue.queueComment('ws-1', { ...item, agentId: 'agent-a' });
    queue.queueComment('ws-1', { ...item, agentId: 'agent-b' });
    const handedOver = queue.takeDeliverableComments('ws-1', 'agent-a');
    expect(handedOver).toHaveLength(1);
    expect(handedOver[0]?.agentId).toBe('agent-a');
  });

  it('takeDeliverableComments withholds a row still inside its grace window, but does not remove it', () => {
    const { queue } = setup({ commentAckGraceMs: 90_000 });
    const id = queue.queueComment('ws-1', item) as string;
    queue.markCommentEmitted('ws-1', id);
    const handedOver = queue.takeDeliverableComments('ws-1', item.agentId);
    expect(handedOver).toEqual([]);
    expect(queue.listQueuedComments('ws-1').map((q) => q.id)).toEqual([id]);
  });

  it('takeDeliverableComments hands over a row once its grace window has passed', () => {
    const { queue, dataDir } = setup({ commentAckGraceMs: 1 });
    const path = commentQueuePath(dataDir, 'ws-1');
    const row: QueuedComment = {
      id: 'cq-old',
      agentId: 'agent-a',
      docId: 'doc-1',
      event: 'thread.created',
      author: { id: 'u-1', name: 'Reviewer' },
      text: 'stale',
      emittedAt: Date.now() - 60_000,
      ts: Date.now() - 60_000,
    };
    mkdirSync(join(dataDir, 'workspaces'), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ queue: [row] })}\n`);
    const handedOver = queue.takeDeliverableComments('ws-1', 'agent-a');
    expect(handedOver.map((r) => r.id)).toEqual(['cq-old']);
  });

  it('takeDeliverableComments with freshProcess bypasses the grace window entirely', () => {
    const { queue } = setup({ commentAckGraceMs: 90_000 });
    const id = queue.queueComment('ws-1', item) as string;
    queue.markCommentEmitted('ws-1', id);
    const handedOver = queue.takeDeliverableComments('ws-1', item.agentId, { freshProcess: true });
    expect(handedOver.map((r) => r.id)).toEqual([id]);
  });
});
