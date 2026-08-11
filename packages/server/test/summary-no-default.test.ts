/**
 * `createServer` must not build a summarizer of its own.
 *
 * It used to: `opts.summarizer ?? new ThreadSummarizer()`, which resolves the
 * real key and the real global `fetch`. Every server test that creates a
 * thread therefore fired a live, billed api.anthropic.com call three seconds
 * later carrying its fixture comment text — 21 of them across one
 * `bun run test:server`, with the suite green throughout, because the
 * scheduled path is fire-and-forget and nothing awaits it.
 *
 * This file is the regression test for that, and it is the one place in the
 * suite that patches `globalThis.fetch`: the whole point is to observe what a
 * DEFAULT-constructed summarizer would reach for. The patch intercepts
 * api.anthropic.com and answers it locally — no request leaves the machine
 * here either, even when the assertion is that one was attempted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementAnchor, User } from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { DEBOUNCE_MS, ThreadSummarizer } from '../src/summarize.ts';

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

/** Every api.anthropic.com request attempted through the global fetch. */
let outbound: string[] = [];
const realFetch = globalThis.fetch;

describe('createServer builds no summarizer of its own', () => {
  let dataDir: string;
  const priorKey = process.env.LIVE_FEEDBACK_SUMMARY_API_KEY;
  const priorFlag = process.env.LF_SUMMARIES;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'summary-no-default-'));
    // A key that resolves on ANY machine, so this test is not quietly vacuous
    // on a box (or a CI runner) that happens to have no Keychain entry — which
    // is exactly the state that hid the original bug from CI.
    process.env.LIVE_FEEDBACK_SUMMARY_API_KEY = 'test-key-never-sent-anywhere';
    process.env.LF_SUMMARIES = '1';
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(typeof input === 'string' ? input : ((input as Request)?.url ?? input));
      if (url.includes('api.anthropic.com')) {
        outbound.push(String(init?.body ?? ''));
        return new Response(
          JSON.stringify({ content: [{ text: '{"topic":"t","discussion":"d"}' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return realFetch(input as never, init);
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    rmSync(dataDir, { recursive: true, force: true });
    if (priorKey === undefined)
      Reflect.deleteProperty(process.env, 'LIVE_FEEDBACK_SUMMARY_API_KEY');
    else process.env.LIVE_FEEDBACK_SUMMARY_API_KEY = priorKey;
    if (priorFlag === undefined) Reflect.deleteProperty(process.env, 'LF_SUMMARIES');
    else process.env.LF_SUMMARIES = priorFlag;
  });

  /** Create a doc + one thread on a running server. */
  async function seed(handle: ServerHandle, docId: string): Promise<void> {
    const base = `http://localhost:${handle.port}`;
    const file = join(dataDir, `${docId}.md`);
    writeFileSync(file, `# Doc\n\n${SNIPPET}\n`);
    await realFetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId, type: 'markdown', sourceUrl: file }),
    });
    const r = await realFetch(`${base}/api/docs/${docId}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ author: bryan, text: 'a fixture comment body', anchor }),
    });
    expect(r.status).toBe(200);
  }

  it('POSITIVE CONTROL: an injected summarizer with no fetchImpl does reach the global fetch', async () => {
    outbound = [];
    // No `fetchImpl` and no `apiKey` — resolved exactly the way the old
    // default did. If this records nothing, the interception below proves
    // nothing either.
    const summarizer = new ThreadSummarizer({ debounceMs: 5 });
    expect(summarizer.enabled).toBe(true);
    const handle = createServer({ port: 0, dataDir, summarizer });
    await seed(handle, 'ctl-doc');
    await new Promise((r) => setTimeout(r, 200));
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toContain('a fixture comment body');
    summarizer.dispose();
    await handle.stop();
  });

  it('makes no outbound call when no summarizer is supplied', async () => {
    outbound = [];
    const handle = createServer({ port: 0, dataDir });
    await seed(handle, 'nodefault-doc');
    // Past the REAL debounce: the old default used it, so a shorter wait would
    // report a clean run for a call that was merely still pending.
    await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 500));
    expect(outbound).toHaveLength(0);
    await handle.stop();
  }, 20_000);
});
