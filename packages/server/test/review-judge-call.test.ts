/**
 * The judge's network half — the request it sends and what it does with a
 * reply it cannot read. The API is never called: `fetchImpl` is a stub and
 * the key is injected.
 *
 * All fixtures are invented; the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { REVIEW_JUDGE_REASON_MAX } from '@feedback/core/review-judge-prompt';
import { haikuReviewJudge } from '../src/review-judge.ts';

/** The longest reply the parser will keep in full: both fields at the
 *  ceiling, plus the JSON around them. */
const MAXIMAL_REPLY = JSON.stringify({
  ok: false,
  reason: 'x'.repeat(REVIEW_JUDGE_REASON_MAX),
  add: 'y'.repeat(REVIEW_JUDGE_REASON_MAX),
});

function stubFetch(reply: string, sent: { body?: Record<string, unknown> }) {
  return (async (_url: string, init?: { body?: string }) => {
    sent.body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
    return new Response(JSON.stringify({ content: [{ text: reply }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('the judge asks for enough tokens to answer', () => {
  it('budgets past a maximal reply — both fields at the ceiling', async () => {
    const sent: { body?: Record<string, unknown> } = {};
    const judge = haikuReviewJudge({
      apiKey: 'test-key',
      fetchImpl: stubFetch('{"ok":true}', sent),
    });
    await judge?.({ criteria: 'be clear', item: { headline: 'Which cache size' } });
    const max = sent.body?.max_tokens as number;
    // A maximal reply is 633 characters. English runs about 4 characters to
    // the token and punctuation-dense JSON can reach 1.5, so the worst case
    // is ~422 tokens — and the model may overshoot the ceiling before the
    // parser clips it, in which case truncation costs the whole verdict.
    expect(max).toBeGreaterThanOrEqual(Math.ceil((MAXIMAL_REPLY.length / 1.5) * 2));
  });

  it('reads a maximal reply back in full', async () => {
    const sent: { body?: Record<string, unknown> } = {};
    const judge = haikuReviewJudge({
      apiKey: 'test-key',
      fetchImpl: stubFetch(MAXIMAL_REPLY, sent),
    });
    const out = await judge?.({ criteria: 'be clear', item: { headline: 'Which cache size' } });
    expect(out?.reason).toHaveLength(REVIEW_JUDGE_REASON_MAX);
    expect(out?.add).toHaveLength(REVIEW_JUDGE_REASON_MAX);
  });

  it('a reply truncated mid-JSON is null — not a half-read verdict', async () => {
    const sent: { body?: Record<string, unknown> } = {};
    const judge = haikuReviewJudge({
      apiKey: 'test-key',
      fetchImpl: stubFetch(MAXIMAL_REPLY.slice(0, 200), sent),
    });
    expect(await judge?.({ criteria: 'be clear', item: { headline: 'x' } })).toBeNull();
  });
});
