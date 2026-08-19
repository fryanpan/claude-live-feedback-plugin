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
import { SUMMARY_PROMPT_VERSION, type StoredSummary } from '@feedback/core/summary-prompt';
import type { Thread, User } from '@feedback/core/types';
import {
  KEYCHAIN_SERVICE,
  KEYCHAIN_SERVICE_LEGACY,
  ThreadSummarizer,
  resolveKeyFrom,
} from '../src/summarize.ts';

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
    // The stamp is asserted as a VALUE here rather than allowed through by a
    // loose matcher: it is the other half of what makes a stored summary
    // re-checkable, and `needsCall` regenerates the whole corpus without it.
    expect(out).toEqual({
      topic: 'Retry loop swallows errors',
      discussion: 'Fix underway',
      hash: summaryHash(t),
      promptVersion: SUMMARY_PROMPT_VERSION,
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

  it('CW_SUMMARIES=0 switches it off even with a key present', async () => {
    const { impl, calls } = fakeFetch();
    process.env.CW_SUMMARIES = '0';
    try {
      const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
      expect(s.enabled).toBe(false);
      expect(await s.generate(thread())).toBeNull();
      expect(calls).toHaveLength(0);
    } finally {
      Reflect.deleteProperty(process.env, 'CW_SUMMARIES');
    }
  });

  // Kept on the PRE-RENAME spelling on purpose: this is the only thing that
  // asserts an off-switch already set in a launchd plist or a shell profile
  // still switches the feature off. A launch environment is the one input the
  // rename cannot restart on somebody's behalf, and the failure would be a
  // server that starts sending comment text off-machine for an operator who
  // had turned that off.
  it('the pre-rename LF_SUMMARIES=0 still switches it off', async () => {
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
      promptVersion: SUMMARY_PROMPT_VERSION,
    });
  });

  it('keeps the FULL first answer when the retry is still over — never truncates', async () => {
    const { impl, calls } = sequencedFetch([over, over]);
    const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const out = await s.generate(thread());
    expect(calls).toHaveLength(2); // one retry, not a loop
    expect(out?.discussion).toBe(LONG); // full text, no '…', no word chop
  });

  /*
   * A blank line costs zero words, so it satisfies the very budget the retry
   * was sent to satisfy. Production, 2026-08-12: a thread with a real reply
   * ended up stored with `discussion: ""` and a CURRENT hash, so the card fell
   * back to the raw latest comment — the verbatim-snippet card generation
   * exists to replace — and the matching hash meant nothing ever retried it.
   */
  const emptyDiscussion = '{"topic":"Retry loop swallows errors","discussion":""}';

  it('does not let a retry DELETE the discussion line it was asked to shorten', async () => {
    const { impl, calls } = sequencedFetch([over, emptyDiscussion]);
    const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const out = await s.generate(thread());
    expect(calls).toHaveLength(2);
    // The long-but-real first answer beats a blank "compliant" one.
    expect(out?.discussion).toBe(LONG);
  });

  it('retries an EMPTY discussion on a thread that has replies', async () => {
    const { impl, calls } = sequencedFetch([emptyDiscussion, short]);
    const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const out = await s.generate(thread());
    expect(calls).toHaveLength(2);
    expect(calls[1]?.toLowerCase()).toContain('empty');
    expect(out?.discussion).toBe('Fix underway now');
  });

  it('does NOT retry an empty discussion when the thread has no replies', async () => {
    // Positive control for the case above: the same blank answer is correct
    // here, and must not cost a second call.
    const { impl, calls } = sequencedFetch([emptyDiscussion]);
    const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const opening = thread();
    opening.comments = opening.comments.slice(0, 1);
    opening.commentCount = 1;
    const out = await s.generate(opening);
    expect(calls).toHaveLength(1);
    expect(out?.discussion).toBe('');
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

/*
 * A summary that CONTRADICTS its thread about shipping state.
 *
 * Observed on this repo's own board 2026-08-17: a thread whose first reply
 * opens "PR open and CI green — not merged, task not transitioned" carried the
 * stored line "PR merged, CI green; lint caught disabled guard tests missed".
 * Re-running the same prompt over the same comments reproduced it in 8 of 20
 * draws, so it is a rate, not a one-off.
 *
 * This is the one failure in the family that MANUFACTURES a specific, checkable
 * falsehood rather than omitting something, and it is the line a person reads
 * INSTEAD of the thread — so it is believed exactly where it is least likely to
 * be checked. Which is why the precedence here inverts the word-budget rule
 * above: an over-long first answer ships as the fallback, a first answer that
 * asserts delivery status never does.
 */
describe('ThreadSummarizer.generate — delivery-status claims', () => {
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

  /** The thread from the board, opening words of each comment verbatim. */
  function shareThread(): Thread {
    return {
      id: 'e7fw6bj76qp7',
      status: 'open',
      anchor: { kind: 'subject' },
      createdBy: alice,
      commentCount: 2,
      lastActivity: 2,
      comments: [
        {
          id: 'c1',
          author: alice,
          text: 'Live share state, measured — nothing to wind down. Verified before touching any code, with positive controls.',
          ts: 1,
        },
        {
          id: 'c2',
          author: alice,
          text: 'PR open and CI green — not merged, task not transitioned. Four gates on the merged tree; all 12 CI checks pass. A mutation-test artifact survived in server.ts and biome flagged it as a constant condition.',
          ts: 2,
        },
      ],
    } as Thread;
  }

  /** The stored line, verbatim. It is 10 words, so no budget rule touches it. */
  const inverted =
    '{"topic":"Removing per-doc sharing; mutation artifact caught by lint",' +
    '"discussion":"PR merged, CI green; lint caught disabled guard tests missed"}';
  const truthful =
    '{"topic":"Removing per-doc sharing; mutation artifact caught by lint",' +
    '"discussion":"Verified empty on prod; lint caught a disabled guard"}';

  it('does not store a summary saying the PR merged when the thread says it did not', async () => {
    const { impl } = sequencedFetch([inverted, truthful]);
    const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const out = await s.generate(shareThread());
    expect(out?.discussion).not.toContain('merged');
    expect(out?.discussion).toBe('Verified empty on prod; lint caught a disabled guard');
  });

  it('asks again exactly once, carrying the offending answer into the retry', async () => {
    const { impl, calls } = sequencedFetch([inverted, truthful]);
    const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    await s.generate(shareThread());
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('PR merged, CI green');
    // The nudge must say what the replacement has to CONTAIN. Phrased purely
    // as a prohibition it is satisfied by a blank line, which is how the word
    // cap shipped a summary-deleting retry once already.
    expect(calls[1]).toContain('Do not simply delete');
  });

  it('stores NOTHING when the retry asserts it too — the card keeps its true lines', async () => {
    const { impl, calls } = sequencedFetch([inverted, inverted]);
    const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const out = await s.generate(shareThread());
    expect(calls).toHaveLength(2); // one retry, not a loop
    expect(out).toBeNull();
  });

  it('prefers an over-long answer with no claim to a compact one with a claim', async () => {
    // Length is a display annoyance; a false "PR merged" is a lie on the board.
    const longClean =
      '{"topic":"Removing per-doc sharing","discussion":"Verified empty on prod ' +
      'with positive controls and the guards mutation tested one by one"}';
    const { impl } = sequencedFetch([inverted, longClean]);
    const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const out = await s.generate(shareThread());
    expect(out?.discussion).toContain('Verified empty on prod');
  });

  /*
   * POSITIVE CONTROL. Every assertion above is an absence — no "merged", or no
   * summary at all — and an absence proves nothing until the same pipeline is
   * shown to store something. Same thread, same summarizer, one line changed
   * in the answer.
   */
  it('stores a claim-free answer on the same thread, in ONE call', async () => {
    const { impl, calls } = sequencedFetch([truthful]);
    const s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const t = shareThread();
    const out = await s.generate(t);
    expect(calls).toHaveLength(1);
    expect(out).toEqual({
      topic: 'Removing per-doc sharing; mutation artifact caught by lint',
      discussion: 'Verified empty on prod; lint caught a disabled guard',
      hash: summaryHash(t),
      promptVersion: SUMMARY_PROMPT_VERSION,
    });
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
      summary: {
        topic: 'a',
        discussion: 'b',
        hash: summaryHash(t),
        promptVersion: SUMMARY_PROMPT_VERSION,
      },
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

  /*
   * The twin of the case above, and the reason the stamp exists at all: the
   * thread has NOT moved, so the hash still matches and every pre-version
   * check said "already summarized". What makes it stale is the instructions
   * it was written under. Version 1 is the whole pre-stamp corpus, so this
   * fixture keeps meaning what it says at every future bump.
   */
  it('calls again for a current thread whose summary predates this prompt', async () => {
    const { impl, calls } = fakeFetch();
    s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl, debounceMs: 1 });
    const t = thread();
    const oldPrompt = {
      ...t,
      summary: { topic: 'a', discussion: 'b', hash: summaryHash(t), promptVersion: 1 },
    } as Thread;
    const applied: StoredSummary[] = [];
    s.schedule({
      docId: 'd1',
      threadId: 't1',
      getThread: () => oldPrompt,
      apply: (x) => applied.push(x),
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toHaveLength(1);
    // And what it writes back carries the CURRENT stamp, so the same thread
    // does not come round again on the next backfill.
    expect(applied[0]?.promptVersion).toBe(SUMMARY_PROMPT_VERSION);
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
    const done = {
      ...t,
      summary: {
        topic: 'a',
        discussion: 'b',
        hash: summaryHash(t),
        promptVersion: SUMMARY_PROMPT_VERSION,
      },
    } as Thread;
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

  /*
   * This is the operation the prompt version was added FOR: an opt-in backfill
   * that reaches summaries the hash says are fine. Asserted as `stored: 1` and
   * not merely as a call, because a summarizer that spends the call and then
   * declines to write it back would leave the corpus exactly where it was.
   */
  it('DOES spend on a current thread whose summary came from an older prompt', async () => {
    const { impl, calls } = fakeFetch();
    s = new ThreadSummarizer({ apiKey: 'k', fetchImpl: impl });
    const t = thread();
    const oldPrompt = {
      ...t,
      summary: { topic: 'a', discussion: 'b', hash: summaryHash(t), promptVersion: 1 },
    } as Thread;
    const applied: StoredSummary[] = [];
    const res = await s.backfill(
      [{ docId: 'd', threadId: 't', getThread: () => oldPrompt, apply: (x) => applied.push(x) }],
      { windowMs: 0, minIntervalMs: 0 },
    );
    expect(calls).toHaveLength(1);
    expect(res).toEqual({ attempted: 1, stored: 1 });
    expect(applied[0]?.promptVersion).toBe(SUMMARY_PROMPT_VERSION);
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

/**
 * The keychain half of the rename. `scripts/migrate-rename.ts` deliberately
 * does not move this entry — copying a keychain item means reading the secret
 * out and writing it back — so the ONLY thing keeping summaries alive across
 * the flag day is that the reader tries the old service name second. Nothing
 * else asserts that, and its failure is silent: summaries simply stop, which
 * reads as the feature having been switched off.
 */
describe('resolveKeyFrom — which keychain service the key comes from', () => {
  /** Records every lookup, so the ORDER is observable and not just the result. */
  function keychain(entries: Record<string, string>) {
    const asked: string[] = [];
    const read = (service: string): string | null => {
      asked.push(service);
      const hit = entries[service];
      // `security` exits non-zero on a missing item, and `readKeychainPassword`
      // throws — so the fake has to throw too, or the loop is never tested
      // against the shape it actually meets.
      if (hit === undefined) throw new Error(`no item for ${service}`);
      return hit;
    };
    return { read, asked };
  }

  it('prefers the current service name', () => {
    const k = keychain({ [KEYCHAIN_SERVICE]: 'new-key', [KEYCHAIN_SERVICE_LEGACY]: 'old-key' });
    expect(resolveKeyFrom(undefined, k.read)).toBe('new-key');
    // It stopped at the first hit rather than reading both and picking.
    expect(k.asked).toEqual([KEYCHAIN_SERVICE]);
  });

  it('falls back to the pre-rename service when the current one is empty', () => {
    const k = keychain({ [KEYCHAIN_SERVICE_LEGACY]: 'old-key' });
    expect(resolveKeyFrom(undefined, k.read)).toBe('old-key');
    expect(k.asked).toEqual([KEYCHAIN_SERVICE, KEYCHAIN_SERVICE_LEGACY]);
  });

  it('is null when neither name holds anything — the documented "off" state', () => {
    const k = keychain({});
    expect(resolveKeyFrom(undefined, k.read)).toBeNull();
    // The positive controls above are what make this absence mean something:
    // the same fake DOES return a key when one is planted.
    expect(k.asked).toEqual([KEYCHAIN_SERVICE, KEYCHAIN_SERVICE_LEGACY]);
  });

  it('an explicit key short-circuits both lookups', () => {
    const k = keychain({ [KEYCHAIN_SERVICE]: 'new-key' });
    expect(resolveKeyFrom('given', k.read)).toBe('given');
    expect(resolveKeyFrom(null, k.read)).toBeNull();
    expect(k.asked).toEqual([]);
  });
});
