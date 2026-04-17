import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementAnchor, User } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';

const bryan: User = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };
const agent: User = { id: 'known-agent', name: 'Agent', kind: 'known', color: '#e36f1e' };

const fakeAnchor: ElementAnchor = {
  kind: 'element',
  fingerprint: {
    tag: 'BUTTON',
    stableAttrs: {},
    classes: [],
    text: 'Go',
    path: 'BUTTON[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'Go' },
};

describe('server REST', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-test-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function j<T>(res: Response): Promise<T> {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  }

  it('creates a doc via POST /api/docs', async () => {
    const r = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'unit-1', type: 'mockup', title: 'Mock Test' }),
    });
    const { meta } = await j<{ meta: { docId: string; type: string; title?: string } }>(r);
    expect(meta.docId).toBe('unit-1');
    expect(meta.type).toBe('mockup');
    expect(meta.title).toBe('Mock Test');
  });

  it('lists docs', async () => {
    const r = await fetch(`${base}/api/docs`);
    const { docs } = await j<{ docs: { docId: string }[] }>(r);
    expect(docs.map((d) => d.docId)).toContain('unit-1');
  });

  it('rejects bad docId', async () => {
    const r = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'bad id with spaces' }),
    });
    expect(r.status).toBe(400);
  });

  it('creates and fetches a thread', async () => {
    const created = await fetch(`${base}/api/docs/unit-1/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: bryan, text: 'first comment', anchor: fakeAnchor }),
    }).then((r) => j<{ thread: { id: string; comments: { text: string }[] } }>(r));
    expect(created.thread.comments[0]?.text).toBe('first comment');

    const list = await fetch(`${base}/api/docs/unit-1/threads`).then((r) =>
      j<{ threads: { id: string }[] }>(r),
    );
    expect(list.threads.map((t) => t.id)).toContain(created.thread.id);

    const one = await fetch(
      `${base}/api/docs/unit-1/threads/${encodeURIComponent(created.thread.id)}`,
    ).then((r) => j<{ thread: { comments: { text: string }[] } }>(r));
    expect(one.thread.comments).toHaveLength(1);
  });

  it('posts a reply and filters by status', async () => {
    const created = await fetch(`${base}/api/docs/unit-1/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: bryan, text: 'pls fix', anchor: fakeAnchor }),
    }).then((r) => j<{ thread: { id: string } }>(r));

    await fetch(`${base}/api/docs/unit-1/threads/${created.thread.id}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: agent, text: 'on it' }),
    }).then((r) => j(r));

    await fetch(`${base}/api/docs/unit-1/threads/${created.thread.id}/resolve`, {
      method: 'POST',
    }).then((r) => j(r));

    const resolved = await fetch(`${base}/api/docs/unit-1/threads?status=resolved`).then((r) =>
      j<{ threads: { id: string; status: string; commentCount: number }[] }>(r),
    );
    const match = resolved.threads.find((t) => t.id === created.thread.id);
    expect(match?.status).toBe('resolved');
    expect(match?.commentCount).toBe(2);

    const openOnly = await fetch(`${base}/api/docs/unit-1/threads?status=open`).then((r) =>
      j<{ threads: { id: string }[] }>(r),
    );
    expect(openOnly.threads.find((t) => t.id === created.thread.id)).toBeUndefined();
  });

  it('pushes an edit and reads back content', async () => {
    // create a markdown doc for edits
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'md-1', type: 'markdown' }),
    });
    const edit1 = await fetch(`${base}/api/docs/md-1/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ start: 0, end: 0, replacement: 'Hello, world!' }),
    }).then((r) => j<{ ok: boolean; content: string }>(r));
    expect(edit1.content).toBe('Hello, world!');

    const edit2 = await fetch(`${base}/api/docs/md-1/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ start: 7, end: 12, replacement: 'Bryan' }),
    }).then((r) => j<{ ok: boolean; content: string }>(r));
    expect(edit2.content).toBe('Hello, Bryan!');
  });

  it('fires webhooks when configured', async () => {
    // spin up a tiny sink
    const sink = Bun.serve({
      port: 0,
      async fetch(req) {
        hits.push(await req.json());
        return new Response('ok');
      },
    });
    const hits: unknown[] = [];
    try {
      const webhookUrl = `http://localhost:${sink.port}/hook`;
      await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: 'hooked-1', type: 'markdown', webhookUrl }),
      });
      await fetch(`${base}/api/docs/hooked-1/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: bryan, text: 'hook me', anchor: fakeAnchor }),
      });
      // webhooks fire async — poll briefly
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && hits.length === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(hits.length).toBeGreaterThan(0);
      const payload = hits[0] as { event: string; docId: string };
      expect(payload.event).toBe('thread.created');
      expect(payload.docId).toBe('hooked-1');
    } finally {
      sink.stop();
    }
  });
});
