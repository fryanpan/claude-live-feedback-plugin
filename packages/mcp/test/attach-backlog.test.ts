/**
 * The respawn re-attach must not eat the backlog it drains.
 *
 * `ensureWatchesRestored` is the fourth attach site — the one a respawned
 * session runs on its own, with no tool response for the backlog to ride.
 * Before `deliverAttachBacklog`, the server drained voice rows destructively
 * and marked comment rows emitted into a response body nobody read: the
 * session the queue had been waiting for arrived, and the arrival itself ate
 * the delivery. This pins the module's contract: emit as a channel event,
 * ack a comment row only AFTER its emit succeeded, never ack what was not
 * delivered, and render voice with the same `applied` wording the heartbeat
 * drain uses.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'vitest';
import { deliverAttachBacklog } from '../src/attach-backlog.ts';

const WS = 'ws-respawn';

function harness(opts?: { failEmitFor?: string; failAck?: boolean }) {
  const calls: Array<{ kind: 'emit' | 'ack'; event?: string; payload?: unknown; rowId?: string }> =
    [];
  const deps = {
    emit: async (event: string, payload: Record<string, unknown>): Promise<void> => {
      if (opts?.failEmitFor !== undefined && payload.commentQueueId === opts.failEmitFor) {
        throw new Error('notification channel down');
      }
      calls.push({ kind: 'emit', event, payload });
    },
    ackComment: async (rowId: string): Promise<void> => {
      if (opts?.failAck) throw new Error('server unreachable');
      calls.push({ kind: 'ack', rowId });
    },
  };
  return { calls, deps };
}

const commentRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  docId: 'plan-doc',
  threadId: 'th-1',
  event: 'thread.replied',
  author: { id: 'known-reviewer', name: 'Reviewer' },
  text: 'Tighten this paragraph.',
  ts: 1700,
  payload: {
    event: 'thread.replied',
    docId: 'plan-doc',
    threadId: 'th-1',
    comment: {
      author: { id: 'known-reviewer', name: 'Reviewer' },
      text: 'Tighten this.',
      ts: 1700,
    },
  },
  ...overrides,
});

describe('deliverAttachBacklog — comment rows', () => {
  it('replays the original payload, stamped with workspaceId and the row id, then acks — in that order', async () => {
    const { calls, deps } = harness();
    const res = await deliverAttachBacklog(WS, { queuedComments: [commentRow('cq-1')] }, deps);

    expect(res.comments).toBe(1);
    expect(calls.map((c) => c.kind)).toEqual(['emit', 'ack']);
    const emitted = calls[0]?.payload as Record<string, unknown>;
    // The late delivery reads exactly like the live frame would have —
    // original payload plus the durable-row bookkeeping on top.
    expect(emitted).toMatchObject({
      event: 'thread.replied',
      docId: 'plan-doc',
      workspaceId: WS,
      commentQueueId: 'cq-1',
    });
    expect(calls[1]?.rowId).toBe('cq-1');
  });

  it('a row without a replay payload is rebuilt from its own fields, not dropped', async () => {
    const { calls, deps } = harness();
    const res = await deliverAttachBacklog(
      WS,
      { queuedComments: [commentRow('cq-2', { payload: undefined })] },
      deps,
    );
    expect(res.comments).toBe(1);
    const emitted = calls[0]?.payload as Record<string, unknown>;
    expect(emitted).toMatchObject({
      event: 'thread.replied',
      docId: 'plan-doc',
      threadId: 'th-1',
      comment: { author: { name: 'Reviewer' }, text: 'Tighten this paragraph.' },
      commentQueueId: 'cq-2',
    });
  });

  it('a row whose emit failed is NOT acked — the queue keeps it for the grace-window redelivery', async () => {
    // The ordering rule this module exists for: an ack sent around a failed
    // emit clears the durable copy on the strength of an intent.
    const { calls, deps } = harness({ failEmitFor: 'cq-bad' });
    const res = await deliverAttachBacklog(
      WS,
      { queuedComments: [commentRow('cq-bad'), commentRow('cq-good')] },
      deps,
    );
    expect(res.comments).toBe(1);
    expect(calls.filter((c) => c.kind === 'ack').map((c) => c.rowId)).toEqual(['cq-good']);
    // POSITIVE CONTROL: the later row still went out — one bad row does not
    // dam the queue behind it.
    expect(calls.some((c) => c.kind === 'emit')).toBe(true);
  });

  it('a failed ack neither throws nor un-delivers — late and duplicated beats silently dropped', async () => {
    const { calls, deps } = harness({ failAck: true });
    const res = await deliverAttachBacklog(WS, { queuedComments: [commentRow('cq-3')] }, deps);
    expect(res.comments).toBe(1);
    expect(calls.map((c) => c.kind)).toEqual(['emit']);
  });

  it('a row it cannot render (no id, or no event anywhere) is skipped without an ack', async () => {
    const { calls, deps } = harness();
    const res = await deliverAttachBacklog(
      WS,
      {
        queuedComments: [
          commentRow('cq-4', { id: undefined }),
          commentRow('cq-5', { event: undefined, payload: undefined }),
        ],
      },
      deps,
    );
    expect(res.comments).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe('deliverAttachBacklog — voice rows', () => {
  it('renders each utterance as a voice.request with the heartbeat drain’s own wording', async () => {
    const { calls, deps } = harness();
    const res = await deliverAttachBacklog(
      WS,
      {
        queuedVoice: [
          { transcript: 'make the second goal the top one', ts: 12 },
          {
            transcript: 'mark the login task done',
            ts: 13,
            applied: 'moved t-1 to done',
            actor: { id: 'known-reviewer', name: 'Reviewer' },
          },
        ],
      },
      deps,
    );
    expect(res.voice).toBe(2);
    expect(calls.every((c) => c.kind === 'emit' && c.event === 'voice.request')).toBe(true);
    expect(calls[0]?.payload).toMatchObject({
      route: 'agent',
      transcript: 'make the second goal the top one',
      ack: 'Delivered from the queue.',
      workspaceId: WS,
    });
    // The `applied` note survives — it is what stops an agent redoing what
    // the fast path already did on the speaker's behalf.
    expect(calls[1]?.payload).toMatchObject({
      ack: 'Delivered from the queue. Already applied: moved t-1 to done',
      actor: { name: 'Reviewer' },
    });
  });

  it('a voice row without a transcript is skipped; voice rows are never acked', async () => {
    const { calls, deps } = harness();
    const res = await deliverAttachBacklog(WS, { queuedVoice: [{ ts: 9 }] }, deps);
    expect(res.voice).toBe(0);
    expect(calls).toEqual([]);
  });
});
