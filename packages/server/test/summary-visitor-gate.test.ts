/**
 * "A share visitor must never trigger generation" — proved on every route a
 * visitor can actually reach, not just the two that were remembered.
 *
 * The gate started life on the comment routes only. That protected nothing:
 * `resolve`, `reopen` and `threads/by_find` are all inside a visitor's scope
 * (`docSubrouteAllowed` allows everything under `threads/` bar three surgery
 * verbs), every one of them is a thread CHANGE, and every thread change
 * schedules a summary. A visitor posts a comment (no call, correctly), clicks
 * Resolve, and the host's key pays for a prompt containing the visitor's own
 * text. `by_find` was worse still: the visitor's body is the WHOLE prompt and
 * no pre-existing thread is needed.
 *
 * NOTHING HERE TOUCHES THE NETWORK — the summarizer is injected with a stub
 * `fetch` and a literal key. `calls` is the observable, and every "no call"
 * assertion is preceded by a positive control showing the same route DOES call
 * when the request is local.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementAnchor, Thread, User } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { SHARE_COOKIE } from '../src/share/link-session.ts';
import { ThreadSummarizer } from '../src/summarize.ts';

const PUBLIC_HOST = 'feedback.example.com';
const bryan: User = { id: 'known-bryan', name: 'Bryan', kind: 'known', color: '#2e7dd7' };
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
  return new Response(JSON.stringify({ content: [{ text: '{"topic":"t","discussion":"d"}' }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as unknown as typeof fetch;

describe('share visitors never spend the summary API key', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let summarizer: ThreadSummarizer;
  let cookie: string;
  const priorEnv = process.env.LF_SUMMARIES;
  const DOC = 'gate-doc';

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  const visitor = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      redirect: 'manual',
      ...init,
      headers: {
        host: PUBLIC_HOST,
        cookie: `${SHARE_COOKIE}=${cookie}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  /** Settle past the (tiny) debounce so a scheduled call would have landed. */
  const settle = () => new Promise((r) => setTimeout(r, 80));

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'summary-gate-'));
    summarizer = new ThreadSummarizer({
      apiKey: 'test-key-never-sent-anywhere',
      fetchImpl: stubFetch,
      debounceMs: 5,
    });
    handle = createServer({
      port: 0,
      dataDir,
      summarizer,
      share: { config: { publicHostname: PUBLIC_HOST } },
    });
    base = `http://localhost:${handle.port}`;

    const file = join(dataDir, `${DOC}.md`);
    writeFileSync(file, `# Doc\n\n${SNIPPET}\n\nA second paragraph to find.\n`);
    await local('/api/docs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: DOC, type: 'markdown', sourceUrl: file }),
    });

    const mk = await local('/api/share/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: DOC, label: 'external review' }),
    });
    expect(mk.status).toBe(200);
    const { share } = (await mk.json()) as { share: { slug: string } };
    const redeemed = await fetch(`${base}/s/${share.slug}`, {
      redirect: 'manual',
      headers: { host: PUBLIC_HOST },
    });
    expect(redeemed.status).toBe(302);
    cookie = (redeemed.headers.get('set-cookie') ?? '').match(
      new RegExp(`${SHARE_COOKIE}=([^;]+)`),
    )?.[1] as string;
    expect(cookie).toBeTruthy();
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
    process.env.LF_SUMMARIES = '1';
  });

  /** A fresh thread, created LOCALLY with generation off, so each test starts
   *  from "no summary stored, no call spent". */
  async function seedThread(text: string): Promise<string> {
    process.env.LF_SUMMARIES = '0';
    const r = await local(`/api/docs/${DOC}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: bryan, text, anchor }),
    });
    const { thread } = (await r.json()) as { thread: Thread };
    await settle();
    process.env.LF_SUMMARIES = '1';
    calls = [];
    return thread.id;
  }

  it('POST /resolve — a visitor click does not, a local click does', async () => {
    const visitorThread = await seedThread('visitor will resolve this one');
    const vr = await visitor(`/api/docs/${DOC}/threads/${visitorThread}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    // The route really is in a visitor's scope — if this 403'd, the absence
    // below would be about routing, not about the gate.
    expect(vr.status).toBe(200);
    await settle();
    expect(calls).toHaveLength(0);

    // POSITIVE CONTROL: the identical route, requested locally, DOES generate.
    const localThread = await seedThread('local user will resolve this one');
    const lr = await local(`/api/docs/${DOC}/threads/${localThread}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(lr.status).toBe(200);
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('POST /reopen — same gate', async () => {
    // Resolve it with generation OFF, so the thread reaches the reopen with no
    // stored summary. (Resolving with generation on would store one, and a
    // reopen moves no comment and no anchor — the hash would still match and
    // `needsCall` would be false for a reason that has nothing to do with the
    // gate. That is exactly how a vacuous version of this test passes.)
    const threadId = await seedThread('visitor will reopen this one');
    process.env.LF_SUMMARIES = '0';
    await local(`/api/docs/${DOC}/threads/${threadId}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await settle();
    process.env.LF_SUMMARIES = '1';
    calls = [];

    const vr = await visitor(`/api/docs/${DOC}/threads/${threadId}/reopen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(vr.status).toBe(200);
    await settle();
    expect(calls).toHaveLength(0);

    // POSITIVE CONTROL: the same route locally, from the same state, calls.
    const other = await seedThread('local user will reopen this one');
    process.env.LF_SUMMARIES = '0';
    await local(`/api/docs/${DOC}/threads/${other}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await settle();
    process.env.LF_SUMMARIES = '1';
    calls = [];
    const lr = await local(`/api/docs/${DOC}/threads/${other}/reopen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(lr.status).toBe(200);
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('POST /threads/by_find — the visitor cannot make their own text the prompt', async () => {
    const vr = await visitor(`/api/docs/${DOC}/threads/by_find`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: bryan,
        find: 'A second paragraph',
        text: 'ATTACKER-CONTROLLED-PROMPT-BODY',
      }),
    });
    expect(vr.status).toBe(200);
    await settle();
    expect(calls).toHaveLength(0);

    // POSITIVE CONTROL: locally, the same call generates — and the body that
    // would have gone out is exactly the caller's text.
    const lr = await local(`/api/docs/${DOC}/threads/by_find`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        author: bryan,
        find: 'A second paragraph',
        text: 'LOCAL-PROMPT-BODY',
      }),
    });
    expect(lr.status).toBe(200);
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('LOCAL-PROMPT-BODY');
  });

  it('POST /comments — the gate that was already there still holds', async () => {
    const threadId = await seedThread('visitor will reply to this one');
    const vr = await visitor(`/api/docs/${DOC}/threads/${threadId}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: bryan, text: 'a visitor reply' }),
    });
    expect(vr.status).toBe(200);
    await settle();
    expect(calls).toHaveLength(0);
  });
});
