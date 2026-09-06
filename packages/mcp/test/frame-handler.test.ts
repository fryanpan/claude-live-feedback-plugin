/**
 * A raw SSE frame in, at most one channel message and one receipt out.
 *
 * The ordering this module keeps is the whole reason it exists, and none of
 * it could be driven while it lived in `mcp.ts` — a file that starts an MCP
 * server on import. `createFrameHandler` takes the notification sink, the
 * renderer, the HTTP client and the dedup predicate as arguments, so a test
 * can feed it wire text and read what came out.
 *
 * All fixtures synthetic; nothing here opens a socket.
 */
import { describe, expect, it } from 'vitest';
import { type FrameHandlerDeps, createFrameHandler } from '../src/frame-handler.ts';

const FIXED_MS = Date.UTC(2026, 8, 3, 12, 0, 0);

type Emitted = { event: string; payload: unknown };
type Sent = { method: string; path: string; body: unknown };

function harness(over: Partial<FrameHandlerDeps> = {}) {
  const notified: unknown[] = [];
  const emitted: Emitted[] = [];
  const sent: Sent[] = [];
  const handle = createFrameHandler({
    notify: async (n) => {
      notified.push(n.params);
    },
    emitChannelMessage: async (event, payload) => {
      emitted.push({ event, payload });
    },
    http: async (method, path, body) => {
      sent.push({ method, path, body });
      return {};
    },
    shouldForward: () => true,
    now: () => FIXED_MS,
    ...over,
  });
  return { notified, emitted, sent, handle };
}

/** One SSE frame as it arrives on the wire, minus the blank-line terminator
 *  the loop has already stripped. */
function frame(event: string, data: unknown, id?: string): string {
  return [...(id ? [`id: ${id}`] : []), `event: ${event}`, `data: ${JSON.stringify(data)}`].join(
    '\n',
  );
}

describe('a data frame becomes exactly one channel message', () => {
  it('forwards the event name and the parsed payload', async () => {
    const { emitted, handle } = harness();
    await handle(frame('thread.replied', { docId: 'plan', threadId: 't1' }));
    expect(emitted).toEqual([
      { event: 'thread.replied', payload: { docId: 'plan', threadId: 't1' } },
    ]);
  });

  it('joins a payload split across several data lines', async () => {
    const { emitted, handle } = harness();
    await handle('event: thread.replied\ndata: {"docId":\ndata: "plan"}');
    expect(emitted).toEqual([{ event: 'thread.replied', payload: { docId: 'plan' } }]);
  });

  it('defaults to the message event when the frame names none', async () => {
    const { emitted, handle } = harness({ shouldForward: () => true });
    await handle('data: {"docId":"plan"}');
    expect(emitted[0]?.event).toBe('message');
  });
});

describe('a frame that says nothing is dropped without throwing', () => {
  it.each([
    ['a keepalive comment', ': ok'],
    ['an id line with no data', 'id: 7\nevent: thread.replied'],
    ['an empty frame', ''],
  ])('drops %s', async (_name, raw) => {
    const { notified, emitted, sent, handle } = harness();
    await expect(handle(raw)).resolves.toBeUndefined();
    expect([notified.length, emitted.length, sent.length]).toEqual([0, 0, 0]);
  });

  it('drops a frame whose data is not JSON', async () => {
    const { notified, emitted, sent, handle } = harness();
    await expect(handle('event: thread.replied\ndata: {not json')).resolves.toBeUndefined();
    expect([notified.length, emitted.length, sent.length]).toEqual([0, 0, 0]);
  });
});

describe('the gates run in the order that keeps them meaningful', () => {
  it('never offers a non-channel event to the dedup', async () => {
    const asked: string[] = [];
    const { emitted, handle } = harness({
      shouldForward: (event) => {
        asked.push(event);
        return true;
      },
    });
    // A word-rate frame: high volume, and never a channel message.
    await handle(frame('meeting.words', { docId: 'plan', text: 'hello' }));
    expect(asked).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('emits nothing when the dedup has already delivered this event', async () => {
    const { emitted, handle } = harness({ shouldForward: () => false });
    await handle(frame('thread.replied', { docId: 'plan', eid: 'e1' }));
    expect(emitted).toEqual([]);
  });

  it('still sends the receipt for a duplicate the session never sees', async () => {
    const { emitted, sent, handle } = harness({ shouldForward: () => false });
    await handle(
      frame('thread.replied', { docId: 'plan', workspaceId: 'w1', commentQueueId: 'c1' }),
    );
    expect(emitted).toEqual([]);
    expect(sent).toEqual([
      { method: 'POST', path: '/workspaces/w1/comment-queue/c1/ack', body: {} },
    ]);
  });
});

describe('the comment receipt follows the frame it acknowledges', () => {
  it('emits first, then acks', async () => {
    const order: string[] = [];
    const { handle } = harness({
      emitChannelMessage: async () => {
        order.push('emit');
      },
      http: async () => {
        order.push('ack');
        return {};
      },
    });
    await handle(
      frame('thread.created', { docId: 'plan', workspaceId: 'w1', commentQueueId: 'c1' }),
    );
    expect(order).toEqual(['emit', 'ack']);
  });

  it('sends no receipt for a frame carrying no queue row', async () => {
    const { sent, handle } = harness();
    await handle(frame('thread.created', { docId: 'plan', workspaceId: 'w1' }));
    expect(sent).toEqual([]);
  });

  it('leaves the row on the queue when the receipt fails', async () => {
    const { emitted, handle } = harness({
      http: async () => {
        throw new Error('server down');
      },
    });
    await expect(
      handle(frame('thread.created', { docId: 'plan', workspaceId: 'w1', commentQueueId: 'c1' })),
    ).resolves.toBeUndefined();
    expect(emitted).toHaveLength(1);
  });
});

describe('a replay gap is its own line, not a garbled comment', () => {
  it('names the channel and tells the agent to refetch', async () => {
    const { notified, emitted, sent, handle } = harness();
    await handle(frame('replay.gap', { docId: 'plan' }));
    expect(emitted).toEqual([]);
    expect(sent).toEqual([]);
    expect(notified).toHaveLength(1);
    const params = notified[0] as {
      content: string;
      meta: Record<string, unknown>;
      sent_at: string;
    };
    expect(params.content).toContain('[replay.gap] events on plan');
    expect(params.content).toContain('refetch state');
    expect(params.meta).toEqual({ event: 'replay.gap', doc_id: 'plan' });
    expect(params.sent_at).toBe(new Date(FIXED_MS).toISOString());
  });

  it('says "a watched channel" when the gap names no doc', async () => {
    const { notified, handle } = harness();
    await handle(frame('replay.gap', {}));
    expect((notified[0] as { content: string }).content).toContain('a watched channel');
    expect((notified[0] as { meta: Record<string, unknown> }).meta).toEqual({
      event: 'replay.gap',
    });
  });
});
