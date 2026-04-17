import { describe, expect, it, mock } from 'bun:test';
import { createWebhookDispatcher } from '../src/webhooks.ts';
import type { WebhookPayload } from '@feedback/core';

const samplePayload: WebhookPayload = {
  event: 'thread.created',
  docId: 'd1',
  threadId: 't1',
  thread: {
    id: 't1',
    status: 'open',
    anchor: {
      kind: 'element',
      fingerprint: {
        tag: 'BUTTON',
        stableAttrs: {},
        classes: [],
        text: 'x',
        path: 'BUTTON[0]',
        dataAttrs: {},
      },
      snippet: { text: 'x' },
    },
    commentCount: 1,
    lastActivity: 1,
    createdBy: { id: 'u', name: 'U', kind: 'anon', color: '#000' },
    comments: [{ id: 'c', author: { id: 'u', name: 'U', kind: 'anon', color: '#000' }, text: 'x', ts: 1 }],
  },
  doc: { docId: 'd1', type: 'markdown', createdAt: 1 },
  seq: 1,
};

describe('webhook dispatcher', () => {
  it('posts the payload as JSON', async () => {
    const fetchMock = mock(async () => new Response('ok', { status: 200 }));
    const d = createWebhookDispatcher({ fetchImpl: fetchMock as typeof fetch });
    await d.send('http://example/hook', samplePayload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init as RequestInit | undefined)?.method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.event).toBe('thread.created');
  });

  it('retries on 5xx', async () => {
    let n = 0;
    const fetchMock = mock(async () => {
      n++;
      return n < 2 ? new Response('err', { status: 503 }) : new Response('ok', { status: 200 });
    });
    const d = createWebhookDispatcher({ fetchImpl: fetchMock as typeof fetch, retries: 2 });
    await d.send('http://example/hook', samplePayload);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 4xx', async () => {
    const fetchMock = mock(async () => new Response('bad', { status: 400 }));
    const d = createWebhookDispatcher({ fetchImpl: fetchMock as typeof fetch, retries: 2 });
    await d.send('http://example/hook', samplePayload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('logs failures', async () => {
    const logs: unknown[] = [];
    const fetchMock = mock(async () => {
      throw new Error('net fail');
    });
    const d = createWebhookDispatcher({
      fetchImpl: fetchMock as typeof fetch,
      retries: 0,
      onLog: (e) => logs.push(e),
    });
    await d.send('http://example/hook', samplePayload);
    expect(logs).toHaveLength(1);
    expect((logs[0] as { ok: boolean }).ok).toBe(false);
  });
});
