/**
 * `rooms.backfillSummaries()` — the one-shot sweep over threads that already
 * existed when generation shipped.
 *
 * Tested through a real server and re-read over HTTP for the same reason
 * `summary-route.test.ts` is: the sweep walks rooms, builds the per-thread
 * `apply` closure, and persists — three hand-written steps between "a summary
 * was generated" and "a card shows it", none of which a unit test on
 * `ThreadSummarizer.backfill` can see. The pacing itself is covered in
 * `summarize.test.ts`; what this file proves is that the wiring reaches disk.
 *
 * NOTHING HERE TOUCHES THE NETWORK — the summarizer gets a stub `fetch` and a
 * literal key.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElementAnchor, type Thread, type User, summaryHash } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ThreadSummarizer } from '../src/summarize.ts';

const bryan: User = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };
const agent: User = { id: 'known-agent', name: 'Agent', kind: 'known', color: '#e36f1e' };

const SNIPPET = 'the retry loop swallows the error';
const anchor: ElementAnchor = {
  kind: 'element',
  fingerprint: {
    tag: 'CODE',
    stableAttrs: {},
    classes: [],
    text: SNIPPET,
    path: 'CODE[0] > BODY[0]',
    dataAttrs: {},
  },
  snippet: { text: SNIPPET },
};

let calls: string[] = [];
const stubFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  calls.push(String(init?.body ?? ''));
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: '{"topic": "swallowed retry error", "discussion": "open"}' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}) as unknown as typeof fetch;

describe('rooms.backfillSummaries', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let summarizer: ThreadSummarizer;
  const priorEnv = process.env.LF_SUMMARIES;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-summary-backfill-'));
    summarizer = new ThreadSummarizer({
      apiKey: 'test-key-never-sent-anywhere',
      fetchImpl: stubFetch,
      // The debounced path must never fire here: this file is about the sweep,
      // and a scheduled write landing mid-test would forge its results.
      debounceMs: 10 * 60_000,
    });
    handle = createServer({ port: 0, dataDir, summarizer });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    summarizer.dispose();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    if (priorEnv === undefined) Reflect.deleteProperty(process.env, 'LF_SUMMARIES');
    else process.env.LF_SUMMARIES = priorEnv;
  });

  beforeEach(() => {
    calls = [];
    // Seeding must not generate anything — every summary in this file has to
    // come from the sweep, or the assertions are about the wrong code path.
    process.env.LF_SUMMARIES = '0';
  });

  async function j<T>(res: Response): Promise<T> {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  }

  async function seed(docId: string, replies: string[] = []): Promise<string> {
    const file = join(dataDir, `${docId}.md`);
    writeFileSync(file, `# Doc\n\n${SNIPPET}\n`);
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
    for (const text of replies) {
      await j(
        await fetch(`${base}/api/docs/${docId}/threads/${thread.id}/comments`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ author: agent, text }),
        }),
      );
    }
    return thread.id;
  }

  async function getThread(docId: string, threadId: string): Promise<Thread> {
    const { thread } = await j<{ thread: Thread }>(
      await fetch(`${base}/api/docs/${docId}/threads/${threadId}`),
    );
    return thread;
  }

  /** The sweep runs in the background; wait for it rather than guessing. */
  async function settle(want: number): Promise<void> {
    for (let i = 0; i < 200 && calls.length < want; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // One more tick so the last call's `apply` has run.
    await new Promise((r) => setTimeout(r, 20));
  }

  it('summarizes every pre-existing thread across docs, and persists it', async () => {
    const docA = 'bf-a';
    const docB = 'bf-b';
    const tA = await seed(docA, ['agreed, real bug']);
    const tB = await seed(docB, ['still open']);

    // The probe can see thread state, and there are no summaries yet.
    expect((await getThread(docA, tA)).summary).toBeUndefined();
    expect((await getThread(docB, tB)).summary).toBeUndefined();

    process.env.LF_SUMMARIES = '1';
    const { queued } = handle.rooms.backfillSummaries({ windowMs: 0 });
    // Other docs from other tests in this file may be resident; what matters
    // is that these two are in the sweep.
    expect(queued).toBeGreaterThanOrEqual(2);
    await settle(queued);

    for (const [docId, threadId] of [
      [docA, tA],
      [docB, tB],
    ] as const) {
      const t = await getThread(docId, threadId);
      expect(t.summary?.topic).toBe('swallowed retry error');
      // The stored hash must fingerprint the thread it describes, or
      // `threadLines` ignores it forever and the sweep bought nothing.
      expect(t.summary?.hash).toBe(summaryHash(t));
    }
  });

  it('costs nothing on a second run — an interrupted sweep can just be re-run', async () => {
    const docId = 'bf-repeat';
    const threadId = await seed(docId, ['agreed, real bug']);
    process.env.LF_SUMMARIES = '1';

    const first = handle.rooms.backfillSummaries({ windowMs: 0 });
    await settle(first.queued);
    expect((await getThread(docId, threadId)).summary).toBeDefined();
    expect(calls.length).toBeGreaterThan(0); // positive control for the zero below

    calls = [];
    const second = handle.rooms.backfillSummaries({ windowMs: 0 });
    expect(second.queued).toBe(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(0);
  });

  it('includes resolved threads, and says how many of the bill they are', async () => {
    // Their cards still render both lines in the all-threads panel and the
    // outdated-comments flow. But an operator agreeing to spend on "N
    // threads" should be told what the N is made of, not handed one opaque
    // total dominated by months of resolved history.
    const docId = 'bf-resolved';
    const threadId = await seed(docId, ['agreed, real bug']);
    await j(
      await fetch(`${base}/api/docs/${docId}/threads/${threadId}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    // Positive control on the setup: it really is resolved and unsummarized.
    const before = await getThread(docId, threadId);
    expect(before.status).toBe('resolved');
    expect(before.summary).toBeUndefined();

    process.env.LF_SUMMARIES = '1';
    const { queued, open, resolved } = handle.rooms.backfillSummaries({ windowMs: 0 });
    expect(resolved).toBeGreaterThanOrEqual(1);
    expect(open + resolved).toBe(queued);
    await settle(queued);
    expect((await getThread(docId, threadId)).summary).toBeDefined();
  });

  it('queues nothing while generation is switched off', async () => {
    const docId = 'bf-off';
    const threadId = await seed(docId, ['agreed, real bug']);

    // Off — the state `beforeEach` left us in.
    expect(handle.rooms.backfillSummaries({ windowMs: 0 })).toEqual({
      queued: 0,
      open: 0,
      resolved: 0,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(0);
    expect((await getThread(docId, threadId)).summary).toBeUndefined();

    // POSITIVE CONTROL: the very same thread IS queued once generation is on,
    // so the zero above is the switch and not an empty room map.
    process.env.LF_SUMMARIES = '1';
    const { queued } = handle.rooms.backfillSummaries({ windowMs: 0 });
    expect(queued).toBeGreaterThanOrEqual(1);
    await settle(queued);
    expect((await getThread(docId, threadId)).summary).toBeDefined();
  });
});
