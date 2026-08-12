/**
 * The `summaryPendingTs` per-thread marker — how a browser learns a summary
 * generation was actually QUEUED for a thread.
 *
 * The client cannot see the server's Haiku call, so a card's "Generating
 * summary…" state has to be grounded in something the server wrote at
 * schedule time. A doc-wide "summaries on" flag was the first design and it
 * lied at both grains this file pins down: a key-less server must promise
 * nothing, and gated writes (share visitors pass `generate: false`, so
 * `scheduleSummary` is never reached) must not pend even on a server that
 * generates for everyone else.
 *
 * The marker lives in the thread's Yjs map because that is what every client
 * already syncs; asserting on the ydoc IS asserting on what a browser
 * receives. NOTHING HERE TOUCHES THE NETWORK — stub fetch, literal key, and
 * a debounce long enough that no generation ever fires mid-test.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementAnchor, Thread, User } from '@feedback/core';
import type * as Y from 'yjs';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ThreadSummarizer } from '../src/summarize.ts';

const bryan: User = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };

const anchor: ElementAnchor = {
  kind: 'element',
  fingerprint: {
    tag: 'CODE',
    stableAttrs: {},
    classes: [],
    text: 'some text',
    path: 'CODE[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: 'some text' },
};

const stubFetch = (async () =>
  new Response(
    JSON.stringify({ content: [{ type: 'text', text: '{"topic":"t","discussion":"d"}' }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as unknown as typeof fetch;

async function j<T>(res: Response): Promise<T> {
  expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
  return res.json() as Promise<T>;
}

async function seedThread(base: string, dataDir: string, docId: string): Promise<string> {
  const file = join(dataDir, `${docId}.md`);
  writeFileSync(file, '# Doc\n\nsome text\n');
  await j(
    await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId, type: 'markdown', sourceUrl: file }),
    }),
  );
  const { thread } = await j<{ thread: Thread }>(
    await fetch(`${base}/api/docs/${docId}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: bryan, text: 'why does this not bubble up?', anchor }),
    }),
  );
  return thread.id;
}

function markerOf(handle: ServerHandle, docId: string, threadId: string): unknown {
  const room = handle.rooms.get(docId);
  const threads = room?.ydoc.getMap('threads') as Y.Map<Y.Map<unknown>> | undefined;
  return threads?.get(threadId)?.get('summaryPendingTs');
}

describe('summaryPendingTs marker', () => {
  const priorEnv = process.env.LF_SUMMARIES;

  afterAll(() => {
    if (priorEnv === undefined) Reflect.deleteProperty(process.env, 'LF_SUMMARIES');
    else process.env.LF_SUMMARIES = priorEnv;
  });

  describe('with generation on', () => {
    let handle: ServerHandle;
    let dataDir: string;
    let base: string;
    let summarizer: ThreadSummarizer;

    beforeAll(() => {
      Reflect.deleteProperty(process.env, 'LF_SUMMARIES');
      dataDir = mkdtempSync(join(tmpdir(), 'feedback-summary-marker-on-'));
      summarizer = new ThreadSummarizer({
        apiKey: 'test-key-never-sent-anywhere',
        fetchImpl: stubFetch,
        // No generation may LAND mid-test; this file is about the marker.
        debounceMs: 10 * 60_000,
      });
      handle = createServer({ port: 0, dataDir, summarizer });
      base = `http://localhost:${handle.port}`;
    });

    afterAll(async () => {
      summarizer.dispose();
      await handle.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('stamps the queue time into the synced thread map when activity schedules one', async () => {
      const before = Date.now();
      const threadId = await seedThread(base, dataDir, 'marker-on');
      const ts = markerOf(handle, 'marker-on', threadId);
      expect(typeof ts).toBe('number');
      expect(ts as number).toBeGreaterThanOrEqual(before);
    });

    it('does NOT stamp for a gated write — visitor activity queues nothing', async () => {
      const threadId = await seedThread(base, dataDir, 'marker-gated');
      const room = handle.rooms.get('marker-gated');
      if (!room) throw new Error('room missing');
      const stampedAtCreate = markerOf(handle, 'marker-gated', threadId) as number;

      // The same gate the routes apply to share visitors (`generate: !visitor`).
      const res = await handle.rooms.postComment(
        'marker-gated',
        threadId,
        bryan,
        'a visitor said this',
        undefined,
        { generate: false },
      );
      expect(res).not.toBeNull();
      // Positive control above: the create DID stamp. The gated reply must not
      // move the marker — a card claiming "generating" here would promise a
      // summary nobody scheduled.
      expect(markerOf(handle, 'marker-gated', threadId)).toBe(stampedAtCreate);
    });
  });

  describe('with generation off (no key)', () => {
    let handle: ServerHandle;
    let dataDir: string;
    let base: string;
    let summarizer: ThreadSummarizer;

    beforeAll(() => {
      dataDir = mkdtempSync(join(tmpdir(), 'feedback-summary-marker-off-'));
      // apiKey: null is "no key" explicitly (omitting consults the Keychain,
      // which RESOLVES on the machine this feature runs on).
      summarizer = new ThreadSummarizer({ apiKey: null, fetchImpl: stubFetch });
      handle = createServer({ port: 0, dataDir, summarizer });
      base = `http://localhost:${handle.port}`;
    });

    afterAll(async () => {
      summarizer.dispose();
      await handle.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('never stamps — a client must not promise a summary that never comes', async () => {
      // Positive control: this summarizer really is off.
      expect(summarizer.enabled).toBe(false);
      const threadId = await seedThread(base, dataDir, 'marker-off');
      expect(markerOf(handle, 'marker-off', threadId)).toBeUndefined();
    });
  });
});
