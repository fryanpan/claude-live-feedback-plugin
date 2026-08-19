/**
 * Every broadcast carries an id that is the same on each channel and never
 * repeats — including across a restart.
 *
 * WHY THIS EXISTS. A subscriber holding two channels that both carry one
 * broadcast has to collapse the copies, and until now the only thing it could
 * key on was `seq`. `seq` is a counter on the IN-MEMORY room: `getOrCreate`
 * builds every room with `seq: 0` (hydrated ones included — nothing writes it
 * to the `.ydoc`), so a deploy, a `bun --watch` reload, or a
 * `delete_workspace` + re-create hands out `seq: 1` again for a genuinely new
 * comment. The MCP child outlives all of those — it lives for the whole
 * Claude Code session — so a key built from `seq` made the first comments
 * after every restart indistinguishable from duplicates, and the dedup
 * swallowed them. Silently. Which is the failure class this branch exists to
 * end, so it must not be the failure the branch introduces.
 *
 * The last test is the one that actually proves the property, and it needs
 * two PROCESSES: within one process a counter alone looks unique, and the
 * whole question is what happens when the process restarts.
 *
 * All fixtures synthetic; port 0; no production server is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootNonce, newEventId } from '../src/event-id.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };
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

describe('broadcast event ids', () => {
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
    dataDir = mkdtempSync(join(tmpdir(), 'event-id-'));
    srcDir = mkdtempSync(join(tmpdir(), 'event-id-src-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('stamps the SAME eid on both channels of one broadcast, and a new one per event', async () => {
    const w = await post('/api/workspaces', { name: 'Event Id Board', goal: 'Ship it.' });
    const { workspace } = (await w.json()) as { workspace: { id: string } };
    const path = join(srcDir, 'doc-one.md');
    writeFileSync(path, '# doc-one\n\nBody.\n');
    await post('/api/docs', {
      docId: 'doc-one',
      sourceUrl: path,
      title: 'doc-one',
      hubWorkspaceId: workspace.id,
    });

    const docStream = await get('/events/doc-one');
    const boardStream = await get(`/events/workspace/${encodeURIComponent(workspace.id)}`);
    const onDoc = listenData(docStream);
    const onBoard = listenData(boardStream);
    await settle(150);

    const comment = (text: string) =>
      post('/api/docs/doc-one/threads', { author: PERSON, text, anchor: { kind: 'subject' } });
    await comment('First.');
    await settle();
    await comment('Second.');
    await settle();
    onDoc.stop();
    onBoard.stop();

    const docEids = onDoc.frames.filter((f) => f.event === 'thread.created').map((f) => f.eid);
    const boardEids = onBoard.frames.filter((f) => f.event === 'thread.created').map((f) => f.eid);
    expect(docEids.length).toBe(2);
    expect(docEids.every((e) => typeof e === 'string' && e.length > 0)).toBe(true);
    // The identity a two-channel subscriber collapses on: one broadcast, one
    // id, both streams.
    expect(boardEids).toEqual(docEids);
    // POSITIVE CONTROL — and two real comments are two different ids, or the
    // "unique id" is a constant and the dedup built on it eats everything.
    expect(docEids[0]).not.toBe(docEids[1]);
  });

  it('is unique within a process even across rooms', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(newEventId());
    expect(ids.size).toBe(1000);
  });

  /**
   * THE RESTART PROOF. `seq` fails precisely here and nothing inside one
   * process can show it, so this spawns two children and compares the nonce
   * each one generates. If these ever agreed, an id from before a deploy
   * could collide with one minted after it, and the MCP dedup would drop a
   * real comment.
   */
  it('mints a different boot nonce in a different process', async () => {
    const script = `import { bootNonce } from '${join(import.meta.dir, '../src/event-id.ts')}';\nconsole.log(bootNonce());`;
    const run = async () => {
      const proc = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out.trim();
    };
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
    // POSITIVE CONTROL on the probe itself: this process has a nonce of the
    // same shape, so "they differ" is not being read off two empty strings.
    expect(bootNonce()).toMatch(/^[0-9a-f]{8}$/);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });
});
