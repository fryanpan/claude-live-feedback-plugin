import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('creates a file-backed markdown doc and edits via find_and_replace', async () => {
    const file = join(dataDir, 'edit-test.md');
    writeFileSync(file, 'Hello, world!\n');
    const created = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'md-1', type: 'markdown', sourceUrl: file }),
    }).then((r) => j<{ attached: { ok: boolean; seeded?: boolean } }>(r));
    expect(created.attached?.ok).toBe(true);
    expect(created.attached?.seeded).toBe(true);

    const loaded = await fetch(`${base}/api/docs/md-1/content`).then((r) =>
      j<{ blocks: { text: string }[] }>(r),
    );
    expect(loaded.blocks[0]?.text).toBe('Hello, world!');

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

  it('rejects POST /api/docs for markdown without sourceUrl', async () => {
    const r = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'md-no-source', type: 'markdown' }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; hint?: string };
    expect(body.error).toBe('sourceUrl required');
    expect(body.hint).toContain('sourceUrl');
  });

  it('insert_blocks_at_anchor parses markdown into sibling blocks', async () => {
    const file = join(dataDir, 'blocks-at-anchor.md');
    writeFileSync(file, 'First paragraph.\n\nSecond paragraph.\n');
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'md-blocks', type: 'markdown', sourceUrl: file }),
    }).then((r) => j(r));

    const anchor = await fetch(`${base}/api/docs/md-blocks/agent_anchors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'First paragraph.' }),
    }).then((r) => j<{ anchorId: string }>(r));

    const res = await fetch(
      `${base}/api/docs/md-blocks/agent_anchors/${encodeURIComponent(anchor.anchorId)}/insert_blocks`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          markdown: '## New section\n\nA paragraph.\n\n| col1 | col2 |\n| --- | --- |\n| A | B |\n',
        }),
      },
    );
    expect(res.status).toBe(200);

    const content = await fetch(`${base}/api/docs/md-blocks/content`).then((r) =>
      j<{ blocks: { type: string | null; text: string; headingLevel?: number }[] }>(r),
    );
    // The inserted markdown should produce sibling blocks: heading, paragraph, table.
    // First paragraph is preserved; new blocks land between it and "Second paragraph."
    const types = content.blocks.map((b) => b.type);
    expect(types).toContain('heading');
    expect(types).toContain('table');
    const heading = content.blocks.find((b) => b.type === 'heading');
    expect(heading?.headingLevel).toBe(2);
    expect(heading?.text).toContain('New section');
    // Critical anti-regression: the first block must NOT swallow the inserted markdown.
    expect(content.blocks[0]?.text).toBe('First paragraph.');
  });

  it('docs created with the same setId share the set', async () => {
    const f1 = join(dataDir, 'set-a.md');
    const f2 = join(dataDir, 'set-b.md');
    const f3 = join(dataDir, 'other.md');
    writeFileSync(f1, '# A\n');
    writeFileSync(f2, '# B\n');
    writeFileSync(f3, '# Other\n');
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'set-a', type: 'markdown', sourceUrl: f1, setId: 's1' }),
    }).then((r) => j(r));
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'set-b', type: 'markdown', sourceUrl: f2, setId: 's1' }),
    }).then((r) => j(r));
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'other', type: 'markdown', sourceUrl: f3 }),
    }).then((r) => j(r));

    const list = await fetch(`${base}/api/docs`).then((r) =>
      j<{ docs: Array<{ docId: string; setId?: string }> }>(r),
    );
    const inSet = list.docs.filter((d) => d.setId === 's1').map((d) => d.docId);
    expect(inSet.sort()).toEqual(['set-a', 'set-b']);
    const lone = list.docs.find((d) => d.docId === 'other');
    expect(lone?.setId).toBeUndefined();
  });

  it('returns 404 for endpoints on a doc that does not exist', async () => {
    const r1 = await fetch(`${base}/api/docs/nonexistent/content`);
    expect(r1.status).toBe(404);
    const r2 = await fetch(`${base}/events/nonexistent`);
    expect(r2.status).toBe(404);
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
      const file = join(dataDir, 'hooked.md');
      writeFileSync(file, '# hooked\n');
      await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          docId: 'hooked-1',
          type: 'markdown',
          sourceUrl: file,
          webhookUrl,
        }),
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
