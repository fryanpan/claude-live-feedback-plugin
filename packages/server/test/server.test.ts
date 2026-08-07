import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementAnchor, User } from '@feedback/core';
import { decideReconcile } from '../src/rooms.ts';
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

  it('serves a bound mockup HTML at /mockup/<docId> with reviewUrl in meta', async () => {
    // Reproduces a partner team's friction report: pre-bind_mock-serve, agents had to
    // symlink each new HTML into the plugin's demos/ to make the URL serve.
    // With the route the symlink dance disappears.
    const file = join(dataDir, 'served-mockup.html');
    writeFileSync(
      file,
      '<!doctype html><html><body><h1>Mock body</h1><claude-feedback-widget doc-id="mock-served-1"></claude-feedback-widget></body></html>',
    );
    const created = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'mock-served-1', type: 'mockup', sourceUrl: file }),
    }).then((r) =>
      j<{ meta: { docId: string; type: string; sourceUrl?: string; reviewUrl?: string } }>(r),
    );
    // The decorated meta should now carry a reviewUrl pointing at /mockup/.
    expect(created.meta.reviewUrl).toBeDefined();
    expect(created.meta.reviewUrl).toContain(`/mockup/${encodeURIComponent('mock-served-1')}`);

    // GET the served URL — should be the HTML body the agent wrote.
    const served = await fetch(`${base}/mockup/mock-served-1`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/html');
    const body = await served.text();
    expect(body).toContain('Mock body');
    expect(body).toContain('claude-feedback-widget');

    // `.html` suffix should also work — agents may share whichever form
    // feels natural.
    const servedSuffixed = await fetch(`${base}/mockup/mock-served-1.html`);
    expect(servedSuffixed.status).toBe(200);

    // Unbound docId → 404.
    const missing = await fetch(`${base}/mockup/never-bound`);
    expect(missing.status).toBe(404);
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

  it('keeps applying external edits across successive rename-based saves', async () => {
    // Editors — and Claude Code's own Edit tool — save via write-temp +
    // atomic rename, which replaces the file's inode. A file-level fs.watch
    // is inode-bound (kqueue/inotify) and goes deaf after the first rename
    // save, so only the FIRST external edit ever reaches the live doc
    // (deterministic; reproduced on Bun + Node). This guards the mtime-poll
    // watcher, which is immune to inode replacement. Each save below uses an
    // atomic rename, NOT an in-place write, to exercise that path.
    const file = join(dataDir, 'rearm-test.md');
    writeFileSync(file, 'one\n');
    await j(
      await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: 'rearm-1', type: 'markdown', sourceUrl: file }),
      }),
    );

    let saveSeq = 0;
    const renameSave = (content: string) => {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, content);
      renameSync(tmp, file);
      // Force a strictly-increasing mtime. The poll detects external edits by
      // mtime; rapid back-to-back saves can otherwise land in the same mtime
      // tick on a coarse temp filesystem, and the second save would be
      // invisible (flaky pre-fix: failed at "two" ~half the time). Real editor
      // saves are seconds apart, so distinct mtimes are realistic — this
      // removes the granularity race without bypassing the inode-survival path
      // the test exists to guard (a file-level fs.watch would go deaf after the
      // rename regardless of mtime).
      saveSeq += 1;
      const stamp = new Date(Date.now() + saveSeq * 1000);
      utimesSync(file, stamp, stamp);
    };
    const waitForBlock = async (want: string) => {
      // Generous budget: server polls every 500ms + 150ms debounce, and CI
      // runners are slow. Returns as soon as it matches.
      for (let i = 0; i < 80; i++) {
        const doc = await fetch(`${base}/api/docs/rearm-1/content`).then((r) =>
          j<{ blocks: { text: string }[] }>(r),
        );
        if (doc.blocks[0]?.text === want) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`first block never became ${JSON.stringify(want)}`);
    };

    // Each successive rename save must land — pre-fix only the first did.
    renameSave('two\n');
    await waitForBlock('two');
    renameSave('three\n');
    await waitForBlock('three');
    renameSave('four\n');
    await waitForBlock('four');
    // Internal poll budget is 80×100ms=8s; raise the per-test timeout above
    // Bun's 5s default so it can't trip under full-suite load.
  }, 15000);

  it('creates a thread via threads/by_find with shared anchor resolution', async () => {
    const file = join(dataDir, 'thread-by-find.md');
    writeFileSync(file, 'The cat sat on the mat.\n');
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'thread-by-find-1', type: 'markdown', sourceUrl: file }),
    }).then((r) => j(r));

    // Happy path: unique match resolves to an anchor and a thread is created.
    const created = await fetch(`${base}/api/docs/thread-by-find-1/threads/by_find`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: agent,
        text: 'Cats are nice. Worth a sentence about the rug, too.',
        find: 'cat',
      }),
    }).then((r) =>
      j<{
        thread: {
          id: string;
          anchor: {
            kind: string;
            startRel: number[];
            endRel: number[];
            snippet: { text: string };
          };
          comments: { text: string }[];
        };
      }>(r),
    );
    expect(created.thread.anchor.kind).toBe('text-range');
    expect(created.thread.anchor.snippet.text).toBe('cat');
    expect(created.thread.comments[0]?.text).toContain('Cats are nice');
    // Regression: startRel/endRel MUST serialize as JSON arrays, not as
    // numeric-keyed objects. Storing a Uint8Array in a plain object inside
    // a Y.Map encodes via JSON-stringify, producing `{"0":..,"1":..}` on
    // the way out — which breaks the client's `new Uint8Array(anchor.startRel)`
    // reconstruction (empty array, no iteration). Editor-created threads use
    // `Array.from(uint8array)` in packages/markdown-app/src/app.ts:976 and
    // round-trip cleanly. Agent path must match.
    expect(Array.isArray(created.thread.anchor.startRel)).toBe(true);
    expect(Array.isArray(created.thread.anchor.endRel)).toBe(true);
    expect(created.thread.anchor.startRel.length).toBeGreaterThan(0);
    expect(created.thread.anchor.endRel.length).toBeGreaterThan(0);

    // The new thread shows up in the same listing the editor uses.
    const list = await fetch(`${base}/api/docs/thread-by-find-1/threads`).then((r) =>
      j<{ threads: { id: string }[] }>(r),
    );
    expect(list.threads.map((t) => t.id)).toContain(created.thread.id);

    // Ambiguous match → 409 with candidates (same shape as find_and_replace).
    writeFileSync(file, 'cat cat cat\n');
    await fetch(`${base}/api/docs/thread-by-find-1/reparse_from_disk`, { method: 'POST' }).then(
      (r) => j(r),
    );
    const ambig = await fetch(`${base}/api/docs/thread-by-find-1/threads/by_find`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: agent, text: 'which cat?', find: 'cat' }),
    });
    expect(ambig.status).toBe(409);
    const ambigBody = (await ambig.json()) as {
      error: string;
      candidates?: Array<{ docOffset: number }>;
    };
    expect(ambigBody.error).toBe('ambiguous');
    expect(ambigBody.candidates).toHaveLength(3);

    // Rejects missing required fields.
    const bad = await fetch(`${base}/api/docs/thread-by-find-1/threads/by_find`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: agent, text: 'no find' }),
    });
    expect(bad.status).toBe(400);
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

  it('returns CORS headers to an allowed origin — and only the one that asked', async () => {
    // Used to be an unconditional `*` on every response, which let any page
    // the user visited read every doc. Now the origin is reflected, and only
    // when it's the server's own, a loopback dev server (the widget), or
    // explicitly configured. See middleware/browser-origin.ts.
    const res = await fetch(`${base}/api/docs`, {
      method: 'GET',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('returns no CORS headers to an unknown origin', async () => {
    const res = await fetch(`${base}/api/docs`, {
      method: 'GET',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('handles OPTIONS preflight', async () => {
    const res = await fetch(`${base}/api/docs`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:4321',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:4321');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('hydrates persisted docs into list_docs after a supervisor restart', async () => {
    const created = await j<{ docId: string }>(
      await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId: 'hydrate-test', type: 'mockup' }),
      }),
    );
    expect(created.docId).toBe('hydrate-test');
    // Yjs snapshot debounce + writeFileSync cycle. Poll until the file
    // appears rather than racing a fixed sleep.
    const ydocPath = join(dataDir, 'hydrate-test.ydoc');
    for (let i = 0; i < 30 && !existsSync(ydocPath); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(ydocPath)).toBe(true);

    // Spin up a second server pointed at the same dataDir — simulates a
    // bun --watch reload. The new instance starts with an empty rooms map
    // and must hydrate from disk so list_docs is accurate.
    const second = createServer({ port: 0, dataDir });
    try {
      const list = await j<{ docs: { docId: string }[] }>(
        await fetch(`http://localhost:${second.port}/api/docs`),
      );
      const ids = list.docs.map((d) => d.docId);
      expect(ids).toContain('hydrate-test');
    } finally {
      await second.stop();
    }
  });

  it('re-attaches file bindings after restart so disk write-back resumes (regression: 2026-05-09)', async () => {
    // Bug: hydrateFromDisk used to load Yjs state but skip attachFile, so
    // every supervisor restart left bound markdown docs with their listener
    // wiring missing — reads worked, observeDeep never fired, disk drifted
    // silently behind the live editor. Fix: hydrateFromDisk now auto-rebinds
    // any markdown doc whose sourceUrl points at an existing file.
    const mdPath = join(dataDir, 'rebind-test.md');
    writeFileSync(mdPath, '# initial\n');
    const created = await j<{ docId: string }>(
      await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          docId: 'rebind-test',
          type: 'markdown',
          sourceUrl: mdPath,
        }),
      }),
    );
    expect(created.docId).toBe('rebind-test');
    // Wait for initial Yjs persistence to disk.
    const ydocPath = join(dataDir, 'rebind-test.ydoc');
    for (let i = 0; i < 30 && !existsSync(ydocPath); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(ydocPath)).toBe(true);

    // Simulate a supervisor restart: spin up a second server on the same
    // dataDir without re-calling create_review_doc.
    const second = createServer({ port: 0, dataDir });
    try {
      // Trigger a Yjs mutation via find_and_replace. With the bug, the
      // observeDeep listener wouldn't be wired, so this would land in
      // memory but never reach disk.
      const fr = await fetch(
        `http://localhost:${second.port}/api/docs/rebind-test/find_and_replace`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ find: 'initial', replace: 'after-restart' }),
        },
      );
      expect(fr.status).toBe(200);
      // Wait for the debounced write-back (800ms + slack).
      for (let i = 0; i < 30; i++) {
        const md = readFileSync(mdPath, 'utf8');
        if (md.includes('after-restart')) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const md = readFileSync(mdPath, 'utf8');
      expect(md).toContain('after-restart');
    } finally {
      await second.stop();
    }
  });
});

describe('decideReconcile — disk→doc conflict policy', () => {
  // A peer reported agent edits "clobbering" a human's unflushed edits on a
  // bound doc. The in-memory agent+human path is CRDT-safe (see ws.test.ts);
  // the real server-side data-loss vector is reconcileFromDisk, which used to
  // destructively replace the live fragment with disk content whenever an
  // external write diverged — even if the live doc held un-flushed edits of
  // its own. decideReconcile centralizes the policy: when an external change
  // collides with un-flushed live edits, keep the live edits (the editor is
  // the runtime source of truth) instead of clobbering them.

  it('no-ops when disk is unchanged since our last write', () => {
    expect(decideReconcile({ disk: 'a\n', lastWritten: 'a\n', currentSerialized: 'a\n' })).toBe(
      'in-sync',
    );
  });

  it('catches up bookkeeping when disk already equals the live serialization', () => {
    // e.g. the live doc was edited and its serialization happens to match disk.
    expect(decideReconcile({ disk: 'b\n', lastWritten: 'a\n', currentSerialized: 'b\n' })).toBe(
      'catch-up',
    );
  });

  it('applies the external edit when the live doc is clean (no un-flushed edits)', () => {
    // disk changed externally; live still matches what we last wrote → safe.
    expect(decideReconcile({ disk: 'b\n', lastWritten: 'a\n', currentSerialized: 'a\n' })).toBe(
      'apply',
    );
  });

  it('flags a conflict when an external edit collides with un-flushed live edits', () => {
    // disk changed externally (b) AND the live doc changed since our last
    // write (c). Clobbering would lose the human's in-progress work.
    expect(decideReconcile({ disk: 'b\n', lastWritten: 'a\n', currentSerialized: 'c\n' })).toBe(
      'conflict',
    );
  });

  it('treats a first-ever reconcile with no prior write as applicable', () => {
    expect(decideReconcile({ disk: 'b\n', lastWritten: undefined, currentSerialized: 'b\n' })).toBe(
      'catch-up',
    );
  });
});

describe('delete_doc', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-del-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const mk = (docId: string) =>
    fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId, type: 'mockup', title: docId }),
    });
  const addThread = (docId: string) =>
    fetch(`${base}/api/docs/${docId}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: bryan, text: 'keep?', anchor: fakeAnchor }),
    });

  it('refuses to delete a doc with open threads (guardrail)', async () => {
    await mk('del-guard');
    await addThread('del-guard');
    const r = await fetch(`${base}/api/docs/del-guard`, { method: 'DELETE' });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string; openThreads: number };
    expect(body.error).toBe('has-open-threads');
    expect(body.openThreads).toBe(1);
    // still present
    const list = await fetch(`${base}/api/docs`).then(
      (r) => r.json() as Promise<{ docs: { docId: string }[] }>,
    );
    expect(list.docs.map((d) => d.docId)).toContain('del-guard');
  });

  it('deletes a doc with no open threads and removes its .ydoc', async () => {
    await mk('del-ok');
    // wait for the debounced persist (200ms) so we can prove the file is removed
    const ydocPath = join(dataDir, 'del-ok.ydoc');
    for (let i = 0; i < 20 && !existsSync(ydocPath); i++)
      await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(ydocPath)).toBe(true);

    const r = await fetch(`${base}/api/docs/del-ok`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    expect(existsSync(ydocPath)).toBe(false);

    const list = await fetch(`${base}/api/docs`).then(
      (r) => r.json() as Promise<{ docs: { docId: string }[] }>,
    );
    expect(list.docs.map((d) => d.docId)).not.toContain('del-ok');
    const g = await fetch(`${base}/api/docs/del-ok`);
    expect(g.status).toBe(404);
  });

  it('force-deletes a doc despite open threads', async () => {
    await mk('del-force');
    await addThread('del-force');
    const r = await fetch(`${base}/api/docs/del-force?force=true`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    const list = await fetch(`${base}/api/docs`).then(
      (r) => r.json() as Promise<{ docs: { docId: string }[] }>,
    );
    expect(list.docs.map((d) => d.docId)).not.toContain('del-force');
  });

  it('returns 404 when deleting a nonexistent doc', async () => {
    const r = await fetch(`${base}/api/docs/does-not-exist`, { method: 'DELETE' });
    expect(r.status).toBe(404);
  });
});

describe('doc owner + lastActivityAt', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-owner-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const getMeta = async (docId: string) => {
    const { docs } = (await fetch(`${base}/api/docs`).then((r) => r.json())) as {
      docs: { docId: string; owner?: string; lastActivityAt?: number; createdAt: number }[];
    };
    return docs.find((d) => d.docId === docId);
  };

  it('records the owner passed at creation and surfaces it in list_docs', async () => {
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'own-1', type: 'mockup', owner: '/Volumes/x/dev/agent-foo' }),
    });
    const meta = await getMeta('own-1');
    expect(meta?.owner).toBe('/Volumes/x/dev/agent-foo');
    expect(typeof meta?.lastActivityAt).toBe('number');
    expect(meta?.lastActivityAt).toBeGreaterThanOrEqual(meta!.createdAt - 1000);
  });

  it('advances lastActivityAt when the doc is edited', async () => {
    const file = join(dataDir, 'activity.md');
    writeFileSync(file, 'before\n');
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'act-1', type: 'markdown', sourceUrl: file }),
    });
    // let the create-time persist settle
    await new Promise((r) => setTimeout(r, 250));
    const before = (await getMeta('act-1'))!.lastActivityAt!;
    await new Promise((r) => setTimeout(r, 1100));
    await fetch(`${base}/api/docs/act-1/find_and_replace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ find: 'before', replace: 'after' }),
    });
    await new Promise((r) => setTimeout(r, 350)); // wait for the 200ms persist
    const after = (await getMeta('act-1'))!.lastActivityAt!;
    expect(after).toBeGreaterThan(before);
  });
});

describe('read-only code docs', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-code-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const content = async (docId: string) =>
    fetch(`${base}/api/docs/${docId}/content`).then(
      (r) =>
        r.json() as Promise<{ plainText: string; blocks: { type: string | null; text: string }[] }>,
    );

  it('binds a source file read-only and serves its raw text', async () => {
    const file = join(dataDir, 'sample.ts');
    writeFileSync(file, 'const x: number = 1;\n');
    const r = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'code-1', type: 'code', sourceUrl: file }),
    });
    const body = (await r.json()) as { meta: { type: string; reviewUrl?: string } };
    expect(body.meta.type).toBe('code');
    expect(body.meta.reviewUrl).toContain('/review/code-1');
    const c = await content('code-1');
    expect(c.plainText).toBe('const x: number = 1;\n');
    expect(c.blocks[0]?.type).toBe('code');
  });

  it('reconciles an external edit into the code doc (no write-back)', async () => {
    const file = join(dataDir, 'live.ts');
    writeFileSync(file, 'first\n');
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'code-2', type: 'code', sourceUrl: file }),
    });
    expect((await content('code-2')).plainText).toBe('first\n');
    // external edit via atomic rename + forced distinct mtime (see rearm test)
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, 'second edited\n');
    renameSync(tmp, file);
    const stamp = new Date(Date.now() + 1000);
    utimesSync(file, stamp, stamp);
    for (let i = 0; i < 80; i++) {
      if ((await content('code-2')).plainText === 'second edited\n') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await content('code-2')).plainText).toBe('second edited\n');
    // disk is NOT rewritten by LF (read-only): file content unchanged by server
    expect(readFileSync(file, 'utf8')).toBe('second edited\n');
  }, 15000);
});
