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

  it('seeds a doc and edits via find_and_replace', async () => {
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'md-1', type: 'markdown' }),
    });
    await fetch(`${base}/api/docs/md-1/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: 'Hello, world!' }),
    }).then((r) => j(r));

    const seeded = await fetch(`${base}/api/docs/md-1/content`).then((r) =>
      j<{ blocks: { text: string }[] }>(r),
    );
    expect(seeded.blocks[0]?.text).toBe('Hello, world!');

    await fetch(`${base}/api/docs/md-1/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'world', replace: 'Bryan' }),
    }).then((r) => j(r));

    const edited = await fetch(`${base}/api/docs/md-1/content`).then((r) =>
      j<{ blocks: { text: string }[] }>(r),
    );
    expect(edited.blocks[0]?.text).toBe('Hello, Bryan!');
  });

  it('POST /api/docs with sourceUrl auto-attaches and seeds from the file', async () => {
    const tmpFile = join(dataDir, 'auto-attach.md');
    require('node:fs').writeFileSync(tmpFile, '# File-loaded content\n\nFrom disk.\n');

    const create = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'md-auto', type: 'markdown', sourceUrl: tmpFile }),
    }).then((r) => j<{ attached: { ok: boolean; seeded?: boolean } }>(r));
    expect(create.attached?.ok).toBe(true);
    expect(create.attached?.seeded).toBe(true);

    const content = await fetch(`${base}/api/docs/md-auto/content`).then((r) =>
      j<{ blocks: { text: string }[] }>(r),
    );
    expect(content.blocks[0]?.text).toContain('File-loaded content');
  });

  it('seed_doc on a bound non-empty doc returns a diagnostic hint pointing at the path', async () => {
    const tmpFile = join(dataDir, 'hint-test.md');
    require('node:fs').writeFileSync(tmpFile, '# Existing content\n');
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'md-hint', type: 'markdown', sourceUrl: tmpFile }),
    }).then((r) => j(r));

    const res = await fetch(`${base}/api/docs/md-hint/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: 'Different content' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: string; hint?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('non-empty');
    expect(body.hint).toBeDefined();
    expect(body.hint).toContain(tmpFile);
    expect(body.hint).toContain('reparse_from_disk');
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
