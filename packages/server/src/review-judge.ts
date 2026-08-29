/**
 * The review-item quality gate's network half: ask Haiku whether an item
 * meets the workspace's criteria.
 *
 * The prompt and the parser are pure and live in
 * `@feedback/core/review-judge-prompt`; this file owns the key, the HTTP call
 * and the timeout — the same split, and the same rules, as `summarize.ts`:
 *
 *  - **The key is the dedicated summary key**, read through `resolveKeyFrom`
 *    with the same Keychain services and the same `CW_SUMMARY_API_KEY`
 *    override. The consent that key represents (2026-08-10) covers comment
 *    text leaving the machine for a card; a review item's headline, detail
 *    and options are the same class of workspace content going to the same
 *    endpoint, so no second key and no second act of consent are asked for.
 *    A generic `ANTHROPIC_API_KEY` is deliberately not honoured, for the
 *    reason `summarize.ts` gives at length.
 *  - **Every failure is a pass.** No key, a timeout, a non-2xx, a reply that
 *    will not parse — all return `null`, and the caller records the item as
 *    judged `unavailable` and lets it through. Bryan's rule (2026-08-29):
 *    don't refuse; never block on the judge being down. Logged ONCE per
 *    process per cause, so an outage costs a line and not a log.
 *  - **One call per create or revise, no retries.** The item is on the
 *    ticket either way; a second call would spend money to delay a verdict
 *    the filer can trigger again by revising.
 *
 * `createServer` takes the judge as an option with NO default — the seam rule
 * the summarizer set: nothing that merely spins a server up (every test,
 * every embedded use) can reach the network. `bin.ts` constructs the real one.
 */

import { readRenamedEnv } from '@feedback/core/env-names';
import {
  type ReviewJudgeItem,
  type ReviewJudgeVerdict,
  buildReviewJudgePrompt,
  parseReviewJudgeResponse,
} from '@feedback/core/review-judge-prompt';
import { readKeychainPassword } from './share/keychain.ts';
import { resolveKeyFrom } from './summarize.ts';

export type { ReviewJudgeVerdict } from '@feedback/core/review-judge-prompt';

export interface ReviewJudgeInput {
  /** The workspace's criteria — the owner's text or the default. */
  criteria: string;
  item: ReviewJudgeItem;
}

/**
 * The seam. `null` means "could not judge" and is a pass-through; a thrown
 * error is treated identically by the caller, so an implementation may do
 * either. Never returns a hold it is not sure of — see the prompt.
 */
export type ReviewJudge = (input: ReviewJudgeInput) => Promise<ReviewJudgeVerdict | null>;

const MODEL = 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_TOKENS = 200;
/** Short: this call sits INSIDE a filing route the agent is waiting on. A
 *  judge that takes longer than this is treated as down for this item. */
export const REVIEW_JUDGE_TIMEOUT_MS = 8_000;

export interface HaikuReviewJudgeOpts {
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Supply a key directly instead of reading Keychain (tests). `null` is
   *  "there is no key", explicitly. */
  apiKey?: string | null;
  timeoutMs?: number;
}

/** Process-wide, so each cause is named once and not once per filing. */
const warned = new Set<string>();
function warnOnce(cause: string, line: string): void {
  if (warned.has(cause)) return;
  warned.add(cause);
  console.error(line);
}

/** Is the gate switched on at all? `CW_REVIEW_GATE=0` is the kill switch. */
export function reviewGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readRenamedEnv(env, 'CW_REVIEW_GATE') !== '0';
}

/**
 * The real judge, or `null` when there is no key or the gate is off — so
 * `bin.ts` can say which and `createServer` gets no judge at all rather than
 * one that fails every call.
 */
export function haikuReviewJudge(opts: HaikuReviewJudgeOpts = {}): ReviewJudge | null {
  if (!reviewGateEnabled()) return null;
  const key = resolveKeyFrom(opts.apiKey, readKeychainPassword);
  if (!key) return null;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? REVIEW_JUDGE_TIMEOUT_MS;
  return async (input) => {
    const { system, user } = buildReviewJudgePrompt(input.criteria, input.item);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        // The body may carry a rate-limit reason; the KEY must never be logged.
        warnOnce(`http-${res.status}`, `[review-gate] HTTP ${res.status}; items pass through`);
        return null;
      }
      const body = (await res.json()) as { content?: Array<{ text?: string }> };
      const text = body.content?.map((b) => b.text ?? '').join('') ?? '';
      const verdict = parseReviewJudgeResponse(text);
      if (!verdict) warnOnce('unparseable', '[review-gate] reply was not a verdict; item passed');
      return verdict;
    } catch (err) {
      warnOnce(
        'call-failed',
        `[review-gate] call failed (${err instanceof Error ? err.message : String(err)}); items pass through`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
