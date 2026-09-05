/**
 * `/events/agent/<agentId>` end to end, through a real server.
 *
 * `sse-mux.test.ts` drives the fan-out against a bare `SseHub`; this file
 * proves the ROUTE is wired to the things it has to be wired to — the durable
 * watch store, its change hook, and the identity refusals — because every one
 * of those was a separate wire and a silent stream is what a broken one looks
 * like.
 *
 * The load-bearing case is the last one: a doc watched AFTER the stream is
 * open must start delivering without a reconnect. A fix that needed a
 * reconnect per watch would be the socket storm it replaces, wearing a hat.
 *
 * All fixtures synthetic; port 0; no production server is touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { waitFor } from './wait-for.ts';

const PERSON = { id: 'known-reviewer', name: 'Reviewer', kind: 'known', color: '#2e7dd7' };
const AGENT = 'agent-mira';

type Frame = { event: string; data: Record<string, unknown> };

function listen(res: Response): { frames: Frame[]; stop: () => void } {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let buf = '';
  void (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          if (raw.startsWith(':')) continue;
          const f: Frame = { event: 'message', data: {} };
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) f.event = line.slice(6).trim();
            else if (line.startsWith('data:')) f.data = JSON.parse(line.slice(5).trim());
          }
          frames.push(f);
        }
      }
    } catch {
      // Cancelled with a read in flight; the frames collected still stand.
    }
  })();
  return {
    frames,
    stop: () => {
      stopped = true;
      void reader.cancel();
    },
  };
}

describe('GET /events/agent/<agentId>', () => {
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

  /**
   * Create a doc and answer its CANONICAL id.
   *
   * The alias is what a caller watches by; the watches route stores the
   * canonical id (a durable watch is matched against board membership, so a
   * key held as an alias would leave a board looking unwatched). The mux
   * therefore tags frames with the canonical key, and the client treats that
   * tag as an opaque cursor key rather than trying to map it back — which is
   * exactly why these expectations name the canonical id.
   */
  const makeDoc = async (alias: string): Promise<string> => {
    const path = join(srcDir, `${alias}.md`);
    writeFileSync(path, `# ${alias}\n\nBody.\n`);
    const res = await post('/api/docs', { docId: alias, sourceUrl: path, title: alias });
    return ((await res.json()) as { docId: string }).docId;
  };
  const comment = (docId: string, text: string) =>
    post(`/api/docs/${docId}/threads`, { author: PERSON, text, anchor: { kind: 'subject' } });

  /** Canonical ids of the two fixture docs, resolved per test. */
  let one: string;
  let two: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'sse-mux-route-'));
    srcDir = mkdtempSync(join(tmpdir(), 'sse-mux-route-src-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
    one = await makeDoc('doc-one');
    two = await makeDoc('doc-two');
  });

  afterEach(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  it('refuses the shared identity, whose set is every anonymous session at once', async () => {
    const res = await get('/events/agent/known-agent');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe('shared-identity');
  });

  it('delivers both watched docs on one connection, tagged by key', async () => {
    await post(`/api/agents/${AGENT}/watches`, { add: [one, two], name: 'Mira' });
    const stream = await get(`/events/agent/${AGENT}`);
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    const feed = listen(stream);

    await comment('doc-one', 'On the first doc.');
    await comment('doc-two', 'On the second doc.');
    await waitFor(() => feed.frames.filter((f) => f.event === 'thread.created').length === 2);

    const created = feed.frames.filter((f) => f.event === 'thread.created');
    expect(created.map((f) => f.data.watchKey).sort()).toEqual([one, two].sort());
    feed.stop();
  });

  it('picks up a doc watched after the stream opened, with no reconnect', async () => {
    await post(`/api/agents/${AGENT}/watches`, { add: [one], name: 'Mira' });
    const feed = listen(await get(`/events/agent/${AGENT}`));

    await comment('doc-two', 'Before the watch — nobody is listening on this key.');
    await comment('doc-one', 'On the watched doc.');
    await waitFor(() => feed.frames.some((f) => f.data.watchKey === one));
    expect(feed.frames.some((f) => f.data.watchKey === two)).toBe(false);

    // The same connection, still open, learns about the new key.
    await post(`/api/agents/${AGENT}/watches`, { add: [two] });
    await comment('doc-two', 'After the watch.');
    await waitFor(() => feed.frames.some((f) => f.data.watchKey === two));

    const onTwo = feed.frames.filter((f) => f.data.watchKey === two);
    expect(onTwo.map((f) => f.data.event)).toEqual(['thread.created']);
    feed.stop();
  });

  it('stops delivering a key the moment it is unwatched', async () => {
    await post(`/api/agents/${AGENT}/watches`, { add: [one, two], name: 'Mira' });
    const feed = listen(await get(`/events/agent/${AGENT}`));
    await comment('doc-one', 'Still watched.');
    await waitFor(() => feed.frames.some((f) => f.data.watchKey === one));

    await post(`/api/agents/${AGENT}/watches`, { remove: [two] });
    await comment('doc-two', 'After the unwatch.');
    // A positive control on the SAME stream, so "nothing arrived" cannot be
    // a dead connection reporting silence.
    await comment('doc-one', 'Positive control.');
    await waitFor(() => feed.frames.filter((f) => f.data.watchKey === one).length === 2);

    expect(feed.frames.some((f) => f.data.watchKey === two)).toBe(false);
    feed.stop();
  });

  it('leaves the per-key routes exactly as they were', async () => {
    // The rollout depends on this: a session still running the previous
    // bundle keeps its own streams while the new one uses the mux.
    const feed = listen(await get('/events/doc-one'));
    await comment('doc-one', 'Old route.');
    await waitFor(() => feed.frames.some((f) => f.event === 'thread.created'));
    // No key tag on the old route — its stream IS the key.
    expect(feed.frames[0]?.data.watchKey).toBeUndefined();
    feed.stop();
  });
});
