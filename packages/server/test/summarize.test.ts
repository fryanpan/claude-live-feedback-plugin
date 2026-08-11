/**
 * The networked half of generated summaries.
 *
 * Every test here injects `fetchImpl`, so no test in this file can reach the
 * real API or need a key. The two things worth proving are that N changes cost
 * ONE call, and that every failure mode leaves the card's deterministic lines
 * alone rather than blanking them.
 */

// `bun:test`, not `vitest`: vitest.config.ts EXCLUDES packages/server/test/**,
// so this file is only ever run by `bun test`. Importing vitest here worked by
// accident and made the file read as if the vitest run covered it.
import { afterEach, describe, expect, it } from 'bun:test';
import { summaryHash } from '@feedback/core';
import type { StoredSummary } from '@feedback/core/summary-prompt';
import type { Thread, User } from '@feedback/core/types';
import { ThreadSummarizer } from '../src/summarize.ts';

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#111111' };

function thread(text = 'Agreed, fixing it now.'): Thread {
  return {
    id: 't1',
    status: 'open',
    anchor: { kind: 'element', fingerprint: 'x' as never, snippet: { text: 'catch (e) {}' } },
    createdBy: alice,
    commentCount: 2,
    lastActivity: 2,
    comments: [
      { id: 'c1', author: alice, text: 'The retry loop swallows the error.', ts: 1 },
      { id: 'c2', author: alice, text, ts: 2 },
    ],
  } as Thread;
}

/** A fetch that records its calls and answers with a well-formed summary. */
function fakeFetch(reply?: unknown) {
  const calls: string[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    calls.push(String(init?.body ?? ''));
    return new Response(
      JSON.stringify(
        reply ?? {
          content: [{ text: '{"topic":"Retry loop swallows errors","discussion":"Fix underway"}' }],
        },
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const hadFlag = 'LF_SUMMARIES' in process.env;
const original = process.env.LF_SUMMARIES;
afterEach(() => {
  // `process.env.X = undefined` stores the STRING "undefined", which is not
  // '0' and so silently leaves generation ENABLED for every later test. Hence
  // a real property delete — via Reflect so biome's noDelete rule, whose
  // suggested fix is exactly the `= undefined` bug above, stays satisfied.
  if (hadFlag && original !== undefined) process.env.LF_SUMMARIES = original;
  else Reflect.deleteProperty(process.env, 'LF_SUMMARIES');
});

describe('ThreadSummarizer.generate', () => {
  it('returns the parsed lines stamped with the hash of what it summarized', async () => {
    const { impl } = fakeFetch();
    const s = new ThreadSummarizer({ apiKey: 'test-key', fetchImpl: impl });
    const t = thread();
    const out = await s.generate(t);
    expect(out).toEqual({
      topic: 'Retry loop swallows errors',
      discussion: 'Fix underway',
      hash: summaryHash(t),
    });
  });

  it('never sends the API key in the request body', async () => {
    const { impl, calls } = fakeFetch();
    const s = new ThreadSummarizer({ apiKey: 'super-secret-key', fetchImpl: impl });
    await s.generate(thread());
    expect(calls[0]).not.toContain('super-secret-key');
  });

  it('returns null — not a throw, not a blank summary — on an API error', async () => {
    const impl = (async () =>
      new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    expect(await s.generate(thread())).toBeNull();
  });

  it('returns null when the reply cannot be parsed', async () => {
    const { impl } = fakeFetch({ content: [{ text: 'I cannot do that' }] });
    const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    expect(await s.generate(thread())).toBeNull();
  });

  it('is disabled without a key, and makes no call at all', async () => {
    const { impl, calls } = fakeFetch();
    // `apiKey: null` is "no key" explicitly. Omitting the field consults the
    // Keychain — which RESOLVES on the machine where this feature is actually
    // configured, so the old `if (!s.enabled) { ... }` wrapper meant this test
    // asserted nothing exactly where it mattered most.
    const s = new ThreadSummarizer({ apiKey: null, fetchImpl: impl });
    expect(s.enabled).toBe(false);
    expect(await s.generate(thread())).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('ignores a generic ANTHROPIC_API_KEY — the dedicated entry is the consent', async () => {
    const { impl, calls } = fakeFetch();
    const prior = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'generic-key-from-the-launch-env';
    try {
      // Positive control: the summarizer DOES turn on for a key it should
      // honour, so the assertion below is about the source of the key and not
      // about some unrelated reason generation is off.
      expect(new ThreadSummarizer({ apiKey: 'dedicated', fetchImpl: impl }).enabled).toBe(true);

      // No dedicated key: an ANTHROPIC_API_KEY in the environment must not
      // switch an off-machine send on for someone who never opted in.
      const s = new ThreadSummarizer({ apiKey: null, fetchImpl: impl });
      expect(s.enabled).toBe(false);
      expect(await s.generate(thread())).toBeNull();
      expect(calls).toHaveLength(0);
    } finally {
      if (prior === undefined) Reflect.deleteProperty(process.env, 'ANTHROPIC_API_KEY');
      else process.env.ANTHROPIC_API_KEY = prior;
    }
  });

  it('returns null rather than throwing when the call itself blows up', async () => {
    // Offline, aborted, or a 200 whose body is not JSON. The on-demand route
    // awaits `generate` bare, so a throw here surfaces as a 500 with a stack
    // trace instead of the documented 503.
    const boom = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: boom });
    expect(await s.generate(thread())).toBeNull();

    const notJson = (async () =>
      new Response('<html>gateway timeout</html>', { status: 200 })) as unknown as typeof fetch;
    const s2 = new ThreadSummarizer({ apiKey: 'k', fetchImpl: notJson });
    expect(await s2.generate(thread())).toBeNull();
  });

  it('LF_SUMMARIES=0 switches it off even with a key present', async () => {
    const { impl, calls } = fakeFetch();
    process.env.LF_SUMMARIES = '0';
    const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    expect(s.enabled).toBe(false);
    expect(await s.generate(thread())).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('ThreadSummarizer.generate — word budget retry', () => {
  /** A fetch whose Nth call answers with the Nth reply text (last repeats). */
  function sequencedFetch(replies: string[]) {
    const calls: string[] = [];
    const impl = (async (_url: string, init?: RequestInit) => {
      calls.push(String(init?.body ?? ''));
      const text = replies[Math.min(calls.length - 1, replies.length - 1)];
      return new Response(JSON.stringify({ content: [{ text }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  const LONG =
    'The first answer runs long because it explains every detail of the fix in far too many words';
  const over = `{"topic":"Retry loop swallows errors","discussion":"${LONG}"}`;
  const short = '{"topic":"Retry loop swallows errors","discussion":"Fix underway now"}';

  it('does not retry a within-budget answer', async () => {
    const { impl, calls } = sequencedFetch([short]);
    const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const out = await s.generate(thread());
    expect(out?.discussion).toBe('Fix underway now');
    expect(calls).toHaveLength(1);
  });

  it('retries ONCE on an over-budget line and stores the compliant retry', async () => {
    const { impl, calls } = sequencedFetch([over, short]);
    const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const t = thread();
    const out = await s.generate(t);
    expect(calls).toHaveLength(2);
    // The retry request must carry the conversation so far, not restart it.
    expect(calls[1]).toContain(LONG.slice(0, 30));
    expect(out).toEqual({
      topic: 'Retry loop swallows errors',
      discussion: 'Fix underway now',
      hash: summaryHash(t),
    });
  });

  it('keeps the FULL first answer when the retry is still over — never truncates', async () => {
    const { impl, calls } = sequencedFetch([over, over]);
    const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const out = await s.generate(thread());
    expect(calls).toHaveLength(2); // one retry, not a loop
    expect(out?.discussion).toBe(LONG); // full text, no '…', no word chop
  });

  it('keeps the first answer when the retry fails outright', async () => {
    const calls: string[] = [];
    const impl = (async (_url: string, init?: RequestInit) => {
      calls.push(String(init?.body ?? ''));
      if (calls.length === 1)
        return new Response(JSON.stringify({ content: [{ text: over }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      return new Response('rate limited', { status: 429 });
    }) as unknown as typeof fetch;
    const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const out = await s.generate(thread());
    expect(calls).toHaveLength(2);
    expect(out?.discussion).toBe(LONG);
  });
});

describe('ThreadSummarizer.schedule', () => {
  let s: ThreadSummarizer;
  afterEach(() => s?.dispose());

  it('coalesces a burst into ONE call — three browsers must not cost three', async () => {
    const { impl, calls } = fakeFetch();
    s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl, debounceMs: 5 });
    const applied: unknown[] = [];
    const args = {
      docId: 'd1',
      threadId: 't1',
      getThread: () => thread(),
      apply: (x: unknown) => applied.push(x),
    };
    s.schedule(args);
    s.schedule(args);
    s.schedule(args);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toHaveLength(1);
    expect(applied).toHaveLength(1);
  });

  it('does not store a summary for a thread that changed during the call', async () => {
    // The reply lands while the model is thinking. Storing the summary anyway
    // would attribute a sentence about the old state to the new thread.
    let current = thread('Agreed, fixing it now.');
    const impl = (async () => {
      current = thread('Actually this is a duplicate, closing.');
      return new Response(
        JSON.stringify({
          content: [{ text: '{"topic":"Retry loop","discussion":"Fix underway"}' }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl, debounceMs: 1 });
    const applied: unknown[] = [];
    s.schedule({
      docId: 'd1',
      threadId: 't1',
      getThread: () => current,
      apply: (x) => applied.push(x),
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(applied).toHaveLength(0);
  });

  it('skips a thread whose stored summary is already current', async () => {
    const { impl, calls } = fakeFetch();
    s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl, debounceMs: 1 });
    const t = thread();
    const withSummary = {
      ...t,
      summary: { topic: 'a', discussion: 'b', hash: summaryHash(t) },
    } as Thread;
    s.schedule({
      docId: 'd1',
      threadId: 't1',
      getThread: () => withSummary,
      apply: () => {},
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toHaveLength(0);
  });

  it('does nothing, quietly, when generation is switched off', async () => {
    const { impl, calls } = fakeFetch();
    process.env.LF_SUMMARIES = '0';
    s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl, debounceMs: 1 });
    s.schedule({ docId: 'd', threadId: 't', getThread: () => thread(), apply: () => {} });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(0);
  });
});

describe('ThreadSummarizer.backfill', () => {
  let s: ThreadSummarizer;
  afterEach(() => s?.dispose());

  /** N tasks over independent threads, each recording what it stored. */
  function tasks(n: number, stored: StoredSummary[] = []) {
    return Array.from({ length: n }, (_, i) => ({
      docId: 'd1',
      threadId: `t${i}`,
      getThread: () => thread(`Reply number ${i}`),
      apply: (x: StoredSummary) => stored.push(x),
    }));
  }

  it('drains the whole backlog, one call per thread', async () => {
    const { impl, calls } = fakeFetch();
    s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const applied: StoredSummary[] = [];
    const res = await s.backfill(tasks(4, applied), { windowMs: 0, minIntervalMs: 0 });
    expect(calls).toHaveLength(4);
    expect(applied).toHaveLength(4);
    expect(res).toEqual({ attempted: 4, stored: 4 });
  });

  it('runs one call at a time — a backlog must not become a burst', async () => {
    // The whole reason it is paced. A parallel drain of hundreds of threads
    // trips the rate limit and spends the key as fast as the API will take it.
    let open = 0;
    let peak = 0;
    const impl = (async () => {
      open++;
      peak = Math.max(peak, open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
      return new Response(
        JSON.stringify({ content: [{ text: '{"topic":"T","discussion":"D"}' }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    await s.backfill(tasks(5), { windowMs: 0, minIntervalMs: 0 });
    expect(peak).toBe(1);
  });

  it('paces itself across the window it was given', async () => {
    const { impl, calls } = fakeFetch();
    s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const start = Date.now();
    // 4 tasks over 200ms → a 50ms gap BETWEEN calls, three of them.
    await s.backfill(tasks(4), { windowMs: 200, minIntervalMs: 0 });
    const elapsed = Date.now() - start;
    expect(calls).toHaveLength(4);
    // Positive control on the clock: an unpaced drain of the same 4 tasks
    // finishes in single-digit ms, so this bound really is measuring pacing.
    expect(elapsed).toBeGreaterThanOrEqual(120);
    // And it does NOT wait after the last call. A trailing gap would delay
    // the result — and the "backfill done" line — by a whole interval, which
    // at the real 15-minute window is minutes of silence that looks like a
    // drain still running.
    expect(elapsed).toBeLessThan(200);
  });

  it('ignores a second drain while one is running', async () => {
    // `backfilling` and `cancelWait` are single fields. Two overlapping
    // drains corrupt each other: whichever finishes first clears the flag and
    // truncates the other mid-queue, and clearing the shared canceller loses
    // the other's wait — which is the shutdown-hangs-for-an-interval bug the
    // cancellable wait exists to prevent.
    const { impl, calls } = fakeFetch();
    s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const first = s.backfill(tasks(3), { windowMs: 60, minIntervalMs: 0 });
    const second = await s.backfill(tasks(3), { windowMs: 60, minIntervalMs: 0 });
    expect(second).toEqual({ attempted: 0, stored: 0 });
    // The first drain is untouched by the second's arrival and completes in
    // full — the positive control that makes the zero above meaningful.
    expect(await first).toEqual({ attempted: 3, stored: 3 });
    expect(calls).toHaveLength(3);

    // And once it is done, a later drain runs normally: this is a no-op, not
    // a latch that switches backfilling off for good.
    const later = await s.backfill(tasks(2), { windowMs: 0, minIntervalMs: 0 });
    expect(later.attempted).toBe(2);
  });

  it('spends nothing on threads whose stored summary is already current', async () => {
    const { impl, calls } = fakeFetch();
    s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const t = thread();
    const done = { ...t, summary: { topic: 'a', discussion: 'b', hash: summaryHash(t) } } as Thread;
    // Positive control first: the SAME thread without its summary does cost a
    // call, so the zero below is about the stored summary and nothing else.
    await s.backfill([{ docId: 'd', threadId: 't', getThread: () => t, apply: () => {} }], {
      windowMs: 0,
      minIntervalMs: 0,
    });
    expect(calls).toHaveLength(1);

    const res = await s.backfill(
      [{ docId: 'd', threadId: 't', getThread: () => done, apply: () => {} }],
      { windowMs: 0, minIntervalMs: 0 },
    );
    expect(calls).toHaveLength(1);
    expect(res).toEqual({ attempted: 1, stored: 0 });
  });

  it('leaves a thread the live path is already generating for to the live path', async () => {
    // Both would store the same kind of line, but the debounced one is reading
    // the newer thread — and paying twice for one card is the point.
    let calls = 0;
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const impl = (async () => {
      calls++;
      await held; // the scheduled call is still out while the backfill runs
      return new Response(
        JSON.stringify({ content: [{ text: '{"topic":"T","discussion":"D"}' }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl, debounceMs: 0 });
    const args = { docId: 'd1', threadId: 't1', getThread: () => thread(), apply: () => {} };
    s.schedule(args);
    // Let the debounce fire so the call is genuinely in flight, not queued.
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(1); // positive control: it really is in flight

    const res = await s.backfill([args], { windowMs: 0, minIntervalMs: 0 });
    expect(res).toEqual({ attempted: 0, stored: 0 });
    expect(calls).toBe(1); // the scheduled one, not a second
    release();
  });

  it('does nothing when generation is off', async () => {
    const { impl, calls } = fakeFetch();
    process.env.LF_SUMMARIES = '0';
    s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    expect(await s.backfill(tasks(3), { windowMs: 0, minIntervalMs: 0 })).toEqual({
      attempted: 0,
      stored: 0,
    });
    expect(calls).toHaveLength(0);
  });

  it('stops mid-drain on dispose, and stops WAITING too', async () => {
    // A 10-minute window over 3 threads is a 200s gap between calls. If
    // dispose only flipped a flag, shutdown would block for one whole gap
    // before the loop noticed — so the wait itself has to be cancellable.
    const { impl, calls } = fakeFetch();
    s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const drain = s.backfill(tasks(3), { windowMs: 10 * 60_000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1); // first call went out
    const t0 = Date.now();
    s.dispose();
    expect(await drain).toEqual({ attempted: 1, stored: 1 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(calls).toHaveLength(1); // and no more went out after it
  });
});
