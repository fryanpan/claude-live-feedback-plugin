/**
 * The Home brief's networked half, through the summarizer's seam.
 *
 * Every test injects `fetchImpl`; nothing here can reach the real API or
 * needs a key. What matters: a disabled summarizer answers null WITHOUT a
 * call (the seam property the whole feature leans on), an enabled one sends
 * the caller's prompt with the brief's own token budget, and any failure
 * grounds to null so the deterministic brief stands.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { ThreadSummarizer } from '../src/summarize.ts';

const hadFlag = 'LF_SUMMARIES' in process.env;
const original = process.env.LF_SUMMARIES;
afterEach(() => {
  if (hadFlag && original !== undefined) process.env.LF_SUMMARIES = original;
  else Reflect.deleteProperty(process.env, 'LF_SUMMARIES');
});

function fakeFetch(
  status = 200,
  text = '**Finished:** the retry rewrite landed.',
  stopReason: string | undefined = 'end_turn',
) {
  const calls: string[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    calls.push(String(init?.body ?? ''));
    return new Response(JSON.stringify({ content: [{ text }], stop_reason: stopReason }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const prompt = { system: 'You write briefs. INSTRUCTIONS.', user: 'Events: none. Write it.' };

describe('ThreadSummarizer.generateHomeBrief', () => {
  it('disabled (no key) answers null and never calls fetch', async () => {
    const { impl, calls } = fakeFetch();
    const s = new ThreadSummarizer({ apiKey: null, fetchImpl: impl });
    expect(await s.generateHomeBrief(prompt)).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('LF_SUMMARIES=0 is the same kill switch as thread summaries', async () => {
    process.env.LF_SUMMARIES = '0';
    const { impl, calls } = fakeFetch();
    const s = new ThreadSummarizer({ apiKey: 'test-key', fetchImpl: impl });
    expect(await s.generateHomeBrief(prompt)).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('sends the prompt with the brief token budget and returns the reply text', async () => {
    const { impl, calls } = fakeFetch();
    const s = new ThreadSummarizer({ apiKey: 'test-key', fetchImpl: impl });
    const out = await s.generateHomeBrief(prompt);
    expect(out).toBe('**Finished:** the retry rewrite landed.');
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0] ?? '{}');
    expect(body.system).toContain('INSTRUCTIONS');
    expect(body.messages).toEqual([{ role: 'user', content: prompt.user }]);
    // A brief is a page-top, not a card line — it gets more room than the
    // 200-token thread summary, and the room is still a hard cap. 600 was
    // measured too small in production: a link-heavy 89-word brief hit the
    // ceiling and shipped cut mid-URL (see the truncation test below).
    expect(body.max_tokens).toBe(1200);
  });

  it('a reply the API cut at max_tokens grounds to null — a half-written brief is not a brief', async () => {
    // Reproduced in production 2026-08-18: the stored brief for one reader
    // ended `[Comment draft persistence](/workspaces/<id>?task=t-` — 1,273
    // characters, cut inside a URL, because `stop_reason` was never read and
    // the text was under acceptBrief's 4,000-character ceiling.
    const cut = '**Finished:** the retry rewrite landed, see [the task](/workspaces/ws-1?task=t-';
    const { impl, calls } = fakeFetch(200, cut, 'max_tokens');
    const s = new ThreadSummarizer({ apiKey: 'test-key', fetchImpl: impl });
    expect(await s.generateHomeBrief(prompt)).toBeNull();
    // Positive control: the call really happened and really returned text,
    // so the null above is a refusal and not a fetch that never ran.
    expect(calls.length).toBe(1);
  });

  it('the same text with a normal stop reason IS returned (the refusal is about truncation, not content)', async () => {
    const cut = '**Finished:** the retry rewrite landed, see [the task](/workspaces/ws-1?task=t-';
    const { impl } = fakeFetch(200, cut, 'end_turn');
    const s = new ThreadSummarizer({ apiKey: 'test-key', fetchImpl: impl });
    expect(await s.generateHomeBrief(prompt)).toBe(cut);
  });

  it('a reply with no stop_reason at all is returned, not refused', async () => {
    // Absence must not read as truncation: only the API saying `max_tokens`
    // is evidence of a cut, and a refusal costs the reader their brief.
    const { impl } = fakeFetch(200, '**Finished:** the retry rewrite landed.', undefined);
    const s = new ThreadSummarizer({ apiKey: 'test-key', fetchImpl: impl });
    expect(await s.generateHomeBrief(prompt)).toBe('**Finished:** the retry rewrite landed.');
  });

  it('an HTTP failure grounds to null (the deterministic brief stands)', async () => {
    const { impl } = fakeFetch(429);
    const s = new ThreadSummarizer({ apiKey: 'test-key', fetchImpl: impl });
    expect(await s.generateHomeBrief(prompt)).toBeNull();
  });

  it('a thrown fetch grounds to null too', async () => {
    const impl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const s = new ThreadSummarizer({ apiKey: 'test-key', fetchImpl: impl });
    expect(await s.generateHomeBrief(prompt)).toBeNull();
  });
});
