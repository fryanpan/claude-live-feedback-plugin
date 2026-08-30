/**
 * The networked half of the effort-estimate scorer.
 *
 * Every test here injects `fetchImpl`, so no test in this file can reach the
 * real API or need a key. The thing worth proving is the split `server.ts`
 * relies on: `haikuEffortEstimator()` returning `null` (no estimator at all)
 * is a different fact from a wired estimator returning `null` (an attempt
 * ran and produced nothing usable) — the caller treats the two differently.
 */

// `bun:test`, not `vitest`: vitest.config.ts EXCLUDES packages/server/test/**.
import { afterEach, describe, expect, it } from 'bun:test';
import { EFFORT_ESTIMATE_MODEL, haikuEffortEstimator } from '../src/effort-estimator.ts';

const TICKET = {
  title: 'Fix the flaky retry test',
  body: 'Fails 1 in 20 runs.',
  goal: 'Stabilize CI',
};

/** A fetch that records its calls and answers with a well-formed estimate. */
function fakeFetch(reply?: unknown) {
  const calls: string[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    calls.push(String(init?.body ?? ''));
    return new Response(
      JSON.stringify(
        reply ?? {
          content: [{ text: '{"handsOnSeconds": 900, "wallClockSeconds": 86400}' }],
        },
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const hadFlag = 'CW_EFFORT_ESTIMATE' in process.env;
const original = process.env.CW_EFFORT_ESTIMATE;
afterEach(() => {
  if (hadFlag && original !== undefined) process.env.CW_EFFORT_ESTIMATE = original;
  else Reflect.deleteProperty(process.env, 'CW_EFFORT_ESTIMATE');
});

describe('haikuEffortEstimator', () => {
  it('is null — no estimator at all — without a key, and makes no call', async () => {
    const { impl, calls } = fakeFetch();
    const estimator = haikuEffortEstimator({ apiKey: null, fetchImpl: impl });
    expect(estimator).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('CW_EFFORT_ESTIMATE=0 switches it off even with a key present', () => {
    process.env.CW_EFFORT_ESTIMATE = '0';
    const estimator = haikuEffortEstimator({ apiKey: 'k', fetchImpl: fakeFetch().impl });
    expect(estimator).toBeNull();
  });

  it('returns the parsed estimate, and never sends the key in the body', async () => {
    const { impl, calls } = fakeFetch();
    const estimator = haikuEffortEstimator({ apiKey: 'super-secret-key', fetchImpl: impl });
    expect(estimator).not.toBeNull();
    const out = await estimator?.({ prompt: 'Weigh review overhead heavily.', ticket: TICKET });
    expect(out).toEqual({ handsOnSeconds: 900, wallClockSeconds: 86400 });
    expect(calls[0]).not.toContain('super-secret-key');
    expect(calls[0]).toContain(EFFORT_ESTIMATE_MODEL);
    expect(calls[0]).toContain('Weigh review overhead heavily.');
    expect(calls[0]).toContain('Fix the flaky retry test');
  });

  // The positive control this feature was built under: a reply that carries
  // no usable estimate must come back null — a failed run, never a guess.
  it('returns null when the reply is not a usable estimate', async () => {
    const { impl } = fakeFetch({ content: [{ text: 'I cannot estimate this.' }] });
    const estimator = haikuEffortEstimator({ apiKey: 'k', fetchImpl: impl });
    expect(await estimator?.({ prompt: 'x', ticket: TICKET })).toBeNull();
  });

  it('returns null — not a throw — on an API error', async () => {
    const impl = (async () =>
      new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    const estimator = haikuEffortEstimator({ apiKey: 'k', fetchImpl: impl });
    expect(await estimator?.({ prompt: 'x', ticket: TICKET })).toBeNull();
  });

  it('returns null rather than throwing when the call itself blows up', async () => {
    const boom = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const estimator = haikuEffortEstimator({ apiKey: 'k', fetchImpl: boom });
    expect(await estimator?.({ prompt: 'x', ticket: TICKET })).toBeNull();

    const notJson = (async () =>
      new Response('<html>gateway timeout</html>', { status: 200 })) as unknown as typeof fetch;
    const estimator2 = haikuEffortEstimator({ apiKey: 'k', fetchImpl: notJson });
    expect(await estimator2?.({ prompt: 'x', ticket: TICKET })).toBeNull();
  });

  it('returns null on a timeout rather than hanging the caller', async () => {
    const hangs = (async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    }) as unknown as typeof fetch;
    const estimator = haikuEffortEstimator({ apiKey: 'k', fetchImpl: hangs, timeoutMs: 20 });
    expect(await estimator?.({ prompt: 'x', ticket: TICKET })).toBeNull();
  });

  it('ignores a generic ANTHROPIC_API_KEY — the dedicated entry is the consent', async () => {
    const { impl, calls } = fakeFetch();
    const prior = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'generic-key-from-the-launch-env';
    try {
      expect(haikuEffortEstimator({ apiKey: 'dedicated', fetchImpl: impl })).not.toBeNull();
      const estimator = haikuEffortEstimator({ apiKey: null, fetchImpl: impl });
      expect(estimator).toBeNull();
      expect(calls).toHaveLength(0);
    } finally {
      if (prior === undefined) Reflect.deleteProperty(process.env, 'ANTHROPIC_API_KEY');
      else process.env.ANTHROPIC_API_KEY = prior;
    }
  });
});
