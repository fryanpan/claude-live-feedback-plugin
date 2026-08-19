/**
 * POST /api/docs/:docId/threads/:threadId/summary, over real HTTP.
 *
 * This file exists because of a failure mode this repo has hit before: a route
 * hand-copies fields between the HTTP body and the rooms call, so a value can
 * be accepted, answered with 200, and silently dropped — and a unit test that
 * calls `rooms.applyThreadSummary` directly never sees it. Everything here
 * therefore goes through `fetch` against a real `createServer({ port: 0 })`,
 * and every claim about what got stored is re-read with a fresh GET rather
 * than taken from the POST's own response body.
 *
 * NOTHING HERE TOUCHES THE NETWORK. The summarizer is injected with a stub
 * `fetch` and a literal test key, so the suite neither reaches
 * api.anthropic.com nor depends on whether the machine running it happens to
 * have a key in its Keychain. `calls` is asserted on directly: "no summary was
 * generated" is only meaningful if we can also show the stub gets called when
 * generation IS on.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ElementAnchor,
  NO_REPLIES_TEXT,
  type Thread,
  type User,
  summaryHash,
  threadLines,
} from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { ThreadSummarizer } from '../src/summarize.ts';

const bryan: User = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };
const agent: User = { id: 'known-agent', name: 'Agent', kind: 'known', color: '#e36f1e' };

/** The anchored text every thread below hangs off; also the deterministic topic. */
const SNIPPET = 'the retry loop swallows the error';

/**
 * An element anchor rather than a text-range one: `TextRangeAnchor` carries
 * serialized `Y.RelativePosition` bytes that would have to be faked, and
 * nothing in this file depends on the anchor resolving to a position. What it
 * does depend on is `snippet.text`, which is what `anchorText` — and therefore
 * both the deterministic topic line and `summaryHash` — actually reads.
 */
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

/** What the model would have replied, for the next stubbed call. */
let nextReply =
  '{"topic": "retry loop swallows the error", "discussion": "agreed, real bug, fix not started"}';
/** Every request the stub saw. The positive control for "nothing was called". */
let calls: string[] = [];

/** Runs while the "model" is thinking, so a test can move the thread mid-call. */
let duringCall: (() => Promise<void>) | null = null;

const stubFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  calls.push(String(init?.body ?? ''));
  if (duringCall) await duringCall();
  return new Response(JSON.stringify({ content: [{ type: 'text', text: nextReply }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as unknown as typeof fetch;

describe('POST /api/docs/:docId/threads/:threadId/summary', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let summarizer: ThreadSummarizer;
  const priorEnv = process.env.LF_SUMMARIES;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'feedback-summary-route-'));
    summarizer = new ThreadSummarizer({
      // A literal, so the constructor never consults Keychain or
      // ANTHROPIC_API_KEY. It is only ever handed to `stubFetch`.
      apiKey: 'test-key-never-sent-anywhere',
      fetchImpl: stubFetch,
      // The scheduled (debounced) path must never fire during this file: every
      // assertion here is about the ON-DEMAND route, and a background write
      // landing mid-test would make the "no summary yet" checks flaky. The
      // kill switch below is the real guard; this is belt and braces.
      debounceMs: 10 * 60_000,
    });
    handle = createServer({ port: 0, dataDir, summarizer });
    base = `http://localhost:${handle.port}`;
  });

  afterAll(async () => {
    summarizer.dispose();
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
    // A real delete, not `= undefined` — that stores the STRING "undefined",
    // which is not '0', so generation would read as ENABLED for whatever runs
    // next. Reflect keeps biome's noDelete rule happy without reintroducing it.
    if (priorEnv === undefined) Reflect.deleteProperty(process.env, 'LF_SUMMARIES');
    else process.env.LF_SUMMARIES = priorEnv;
  });

  beforeEach(() => {
    calls = [];
    duringCall = null;
    // Default OFF: doc/thread/reply setup must not schedule generation, so a
    // test that later asserts "no summary is stored yet" is asserting about
    // its own POST and nothing else. Each test opts in explicitly.
    process.env.LF_SUMMARIES = '0';
  });

  async function j<T>(res: Response): Promise<T> {
    expect(res.ok, `${res.status} ${await res.clone().text()}`).toBe(true);
    return res.json() as Promise<T>;
  }

  /** Create a doc + a thread, plus optional replies. Returns the thread id. */
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
        body: JSON.stringify({
          author: bryan,
          text: 'why does this not bubble up?',
          anchor,
        }),
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

  /** Re-read the thread over HTTP. Never trust the mutating call's own echo. */
  async function getThread(docId: string, threadId: string): Promise<Thread> {
    const { thread } = await j<{ thread: Thread }>(
      await fetch(`${base}/api/docs/${docId}/threads/${threadId}`),
    );
    return thread;
  }

  function postSummary(docId: string, threadId: string, body?: unknown): Promise<Response> {
    return fetch(`${base}/api/docs/${docId}/threads/${threadId}/summary`, {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  }

  it('answers from the stored summary instead of paying twice for the same thread', async () => {
    const docId = 'sum-cached';
    const threadId = await seed(docId, ['agreed — real bug, fix not started']);
    process.env.LF_SUMMARIES = '1';
    nextReply = '{"topic": "swallowed retry error", "discussion": "agreed, not fixed"}';

    // Positive control: the first call really does generate.
    expect((await postSummary(docId, threadId)).status).toBe(200);
    expect(calls.length).toBe(1);

    // The thread has not moved, so a second ask is the same two lines. An
    // agent that retries this route used to bill on every attempt.
    const again = await postSummary(docId, threadId);
    expect(again.status).toBe(200);
    const body = (await again.json()) as { cached?: boolean; summary: { topic: string } };
    expect(body.cached).toBe(true);
    expect(body.summary.topic).toBe('swallowed retry error');
    expect(calls.length).toBe(1);

    // force:true is the escape hatch — "that line is wrong, do it again".
    nextReply = '{"topic": "second attempt at the topic", "discussion": "still not fixed"}';
    const forced = await postSummary(docId, threadId, { force: true });
    expect(forced.status).toBe(200);
    expect(calls.length).toBe(2);
    expect((await getThread(docId, threadId)).summary?.topic).toBe('second attempt at the topic');
  });

  it('503s with a how-to-enable hint when generation is switched off', async () => {
    const docId = 'sum-off';
    const threadId = await seed(docId, ['yes, real bug — not fixed yet']);

    // POSITIVE CONTROL for every absence below: with generation ON, this exact
    // URL succeeds, the stub is called, and a summary lands. So a 503 later is
    // the feature being off, not a typo in the path or a missing thread.
    process.env.LF_SUMMARIES = '1';
    const okRes = await postSummary(docId, threadId);
    expect(okRes.status).toBe(200);
    expect(calls.length).toBe(1);
    expect((await getThread(docId, threadId)).summary).toBeDefined();

    // Now the real assertion.
    calls = [];
    process.env.LF_SUMMARIES = '0';
    const res = await postSummary(docId, threadId);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; detail?: string };
    expect(body.error).toBe('summaries disabled');
    // "Helpful" means it names the switch AND how to add a key — a bare
    // "disabled" leaves the operator with nowhere to go.
    expect(body.detail).toContain('CW_SUMMARIES=1');
    expect(body.detail).toContain('live-feedback-summary-api-key');
    // The disabled path must short-circuit BEFORE the call, not after it.
    expect(calls.length).toBe(0);
  });

  it('404s on an unknown thread even while generation is on', async () => {
    const docId = 'sum-404';
    const threadId = await seed(docId, ['a reply']);
    process.env.LF_SUMMARIES = '1';

    // Positive control: the real id on this doc works.
    expect((await postSummary(docId, threadId)).status).toBe(200);

    const res = await postSummary(docId, 'no-such-thread');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('thread not found');
  });

  it('stores the generated summary on the thread, and a later GET returns it', async () => {
    const docId = 'sum-store';
    const threadId = await seed(docId, ['agreed — real bug, fix not started']);

    // The probe can see thread state at all (presence), and there is no
    // summary yet (the absence this test is about).
    const before = await getThread(docId, threadId);
    expect(before.comments.length).toBe(2);
    expect(before.summary).toBeUndefined();

    process.env.LF_SUMMARIES = '1';
    nextReply =
      '{"topic": "retry loop swallows the error", "discussion": "agreed, real bug, fix not started"}';
    const res = await postSummary(docId, threadId);
    expect(res.status).toBe(200);
    const posted = (await res.json()) as {
      thread: Thread;
      summary: { topic: string; discussion: string; hash: string };
    };
    expect(posted.summary.topic).toBe('retry loop swallows the error');

    // THE POINT OF THE FILE: re-read through a separate request. If the route
    // generated a summary and forgot to hand it to `rooms.applyThreadSummary`,
    // the POST body above would still look perfect and this would be empty.
    const after = await getThread(docId, threadId);
    expect(after.summary).toBeDefined();
    expect(after.summary?.topic).toBe('retry loop swallows the error');
    expect(after.summary?.discussion).toBe('agreed, real bug, fix not started');
    // The stored hash must fingerprint the thread it describes, or
    // `threadLines` will ignore it forever.
    expect(after.summary?.hash).toBe(summaryHash(after));
  });

  it('changes what threadLines() renders for that thread', async () => {
    const docId = 'sum-lines';
    const lastReply = 'I can reproduce it on the second retry only';
    const threadId = await seed(docId, [lastReply]);

    // Baseline: the deterministic lines, derived from the anchor snippet and
    // the last reply. Asserted so the "after" values are shown to be a change,
    // not a coincidence.
    const before = await getThread(docId, threadId);
    const linesBefore = threadLines(before);
    expect(linesBefore.topic).toBe(SNIPPET);
    expect(linesBefore.discussion).toBe(lastReply);
    expect(linesBefore.discussionKind).toBe('replies');

    process.env.LF_SUMMARIES = '1';
    nextReply =
      '{"topic": "error swallowed on second retry", "discussion": "reproduced; not fixed"}';
    expect((await postSummary(docId, threadId)).status).toBe(200);

    const after = await getThread(docId, threadId);
    const linesAfter = threadLines(after);
    expect(linesAfter.topic).toBe('error swallowed on second retry');
    expect(linesAfter.discussion).toBe('reproduced; not fixed');
    expect(linesAfter.discussionKind).toBe('replies');
    // Both lines genuinely moved.
    expect(linesAfter.topic).not.toBe(linesBefore.topic);
    expect(linesAfter.discussion).not.toBe(linesBefore.discussion);
  });

  it('refuses to store a summary for a thread that moved during the call', async () => {
    const docId = 'sum-raced';
    const threadId = await seed(docId, ['the first reply']);
    process.env.LF_SUMMARIES = '1';

    // A reply lands while the model is thinking. The summary that comes back
    // describes the OLD state: storing it would (a) report success for
    // something `threadLines` ignores forever, because the stored hash no
    // longer matches, and (b) be able to overwrite a VALID summary that the
    // scheduled path had already landed for the new state — with nothing
    // scheduled to repair it.
    duringCall = async () => {
      await j(
        await fetch(`${base}/api/docs/${docId}/threads/${threadId}/comments`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ author: agent, text: 'a second reply, mid-flight' }),
        }),
      );
    };
    const res = await postSummary(docId, threadId);
    expect(calls.length).toBe(1); // the call really did happen
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(
      'thread changed during generation',
    );

    const after = await getThread(docId, threadId);
    expect(after.comments.length).toBe(3); // the reply really did land
    expect(after.summary).toBeUndefined();

    // POSITIVE CONTROL: with nothing racing it, the same call stores fine —
    // so the 409 above is the guard, not a broken route.
    duringCall = null;
    expect((await postSummary(docId, threadId)).status).toBe(200);
    expect((await getThread(docId, threadId)).summary).toBeDefined();
  });

  it('never invents a discussion for a thread with no replies', async () => {
    const docId = 'sum-noreply';
    const threadId = await seed(docId); // no replies

    const before = await getThread(docId, threadId);
    expect(before.comments.length).toBe(1);
    expect(threadLines(before).discussion).toBe(NO_REPLIES_TEXT);

    process.env.LF_SUMMARIES = '1';
    // A model that ignores the "return an empty discussion" instruction is the
    // case that matters: the seam, not the prompt, is what has to hold.
    nextReply = '{"topic": "swallowed retry error", "discussion": "team agreed to ship the fix"}';
    expect((await postSummary(docId, threadId)).status).toBe(200);

    const after = await getThread(docId, threadId);
    // Positive control: generation really did land on this thread...
    expect(after.summary?.discussion).toBe('team agreed to ship the fix');
    const lines = threadLines(after);
    // ...and the topic line took the generated value...
    expect(lines.topic).toBe('swallowed retry error');
    // ...but the discussion line still refuses to report a conversation that
    // has not happened.
    expect(lines.discussion).toBe(NO_REPLIES_TEXT);
    expect(lines.discussionKind).toBe('none');
  });
});
