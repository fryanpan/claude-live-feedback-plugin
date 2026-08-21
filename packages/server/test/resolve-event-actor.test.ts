/**
 * A `thread.resolved` / `thread.reopened` broadcast names the RESOLVING
 * caller, not the thread's creator.
 *
 * Measured in the field: 17 resolves by one session each emitted a
 * `thread.resolved` frame with no actor at all, so the MCP channel renderer
 * fell back to `thread.comments[0].author` — the CREATOR — and attributed the
 * last comment's text to them. `thread.replied` on the same threads
 * attributed correctly, because the reply path passes the comment (and with
 * it the author) into the broadcast. The fix is the same seam: resolve and
 * reopen pass the acting author, and the frame carries it as `actor`.
 *
 * Everything goes through the HTTP routes the browser and MCP actually post
 * to, and the frames are read off the doc's real SSE stream — the channel a
 * watching agent consumes.
 *
 * All fixtures synthetic; port 0; no production server is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Thread, User } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';

const creator: User = { id: 'known-casey', name: 'Casey', kind: 'known', color: '#2e7dd7' };
const resolver: User = { id: 'agent-fix-bot', name: 'Fix Bot', kind: 'known', color: '#888' };

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/** Read an SSE stream, collecting parsed `data:` payloads. */
function listenData(res: Response): { frames: Array<Record<string, unknown>>; stop: () => void } {
  const frames: Array<Record<string, unknown>> = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  void (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        for (const line of decoder.decode(value).split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            frames.push(JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
          } catch {}
        }
      }
    } catch {}
  })();
  return {
    frames,
    stop: () => {
      stopped = true;
      void reader.cancel().catch(() => {});
    },
  };
}

describe('resolve/reopen broadcast actor', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let srcDir: string;
  let base: string;

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { host: `localhost:${handle.port}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { host: `localhost:${handle.port}` } });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'resolve-actor-'));
    srcDir = mkdtempSync(join(tmpdir(), 'resolve-actor-src-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  async function seedThread(docId: string): Promise<string> {
    const path = join(srcDir, `${docId}.md`);
    writeFileSync(path, `# ${docId}\n\nBody.\n`);
    await post('/api/docs', { docId, sourceUrl: path, title: docId });
    const res = await post(`/api/docs/${docId}/threads`, {
      author: creator,
      text: 'please drop this paragraph',
      anchor: { kind: 'subject' },
    });
    const { thread } = (await res.json()) as { thread: Thread };
    return thread.id;
  }

  it('thread.resolved carries the resolver as actor, not the creator, and no comment', async () => {
    const threadId = await seedThread('doc-resolve');
    const stream = await get('/events/doc-resolve');
    const on = listenData(stream);
    await settle(150);

    await post(`/api/docs/doc-resolve/threads/${threadId}/resolve`, { author: resolver });
    await settle();
    on.stop();

    const frame = on.frames.find((f) => f.event === 'thread.resolved');
    expect(frame).toBeDefined();
    const actor = frame?.actor as User | undefined;
    // The whole bug: with no actor on the frame, the renderer's only
    // fallback is comments[0].author — the creator.
    expect(actor?.name).toBe(resolver.name);
    expect(actor?.id).toBe(resolver.id);
    expect(actor?.name).not.toBe(creator.name);
    // A resolve is a status change, not speech — nothing on the frame may
    // invite attributing comment text to the resolver.
    expect(frame?.comment).toBeUndefined();
  });

  it('thread.reopened carries the reopening caller as actor', async () => {
    const threadId = await seedThread('doc-reopen');
    await post(`/api/docs/doc-reopen/threads/${threadId}/resolve`, { author: creator });

    const stream = await get('/events/doc-reopen');
    const on = listenData(stream);
    await settle(150);

    await post(`/api/docs/doc-reopen/threads/${threadId}/reopen`, { author: resolver });
    await settle();
    on.stop();

    const frame = on.frames.find((f) => f.event === 'thread.reopened');
    expect(frame).toBeDefined();
    expect((frame?.actor as User | undefined)?.name).toBe(resolver.name);
  });

  // POSITIVE CONTROL — the reply path was always attributed correctly; the
  // fix must not disturb it, and this proves the stream/probe sees authors
  // at all (so the assertions above are not passing on an empty stream).
  it('thread.replied still carries the replying author on the comment', async () => {
    const threadId = await seedThread('doc-reply');
    const stream = await get('/events/doc-reply');
    const on = listenData(stream);
    await settle(150);

    await post(`/api/docs/doc-reply/threads/${threadId}/comments`, {
      author: resolver,
      text: 'done, removed it',
    });
    await settle();
    on.stop();

    const frame = on.frames.find((f) => f.event === 'thread.replied');
    const comment = frame?.comment as { author?: User; text?: string } | undefined;
    expect(comment?.author?.name).toBe(resolver.name);
    expect(comment?.text).toBe('done, removed it');
  });
});
