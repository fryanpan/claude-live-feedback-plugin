/**
 * The effort-estimate scorer's network half: ask Haiku for hands-on and
 * wall-clock seconds from a ticket's title, description and goal.
 *
 * The prompt and the parser are pure and live in
 * `@feedback/core/effort-estimate-prompt`; this file owns the key, the HTTP
 * call and the timeout — the same split, and largely the same rules, as
 * `review-judge.ts`:
 *
 *  - **The key is the dedicated summary key**, read through `resolveKeyFrom`
 *    with the same Keychain services and the same `CW_SUMMARY_API_KEY`
 *    override. The consent that key represents (2026-08-10) covers
 *    workspace content leaving the machine for a card; a ticket's title and
 *    description going to the same endpoint for the same reason is the same
 *    class of content, so no second key and no second act of consent are
 *    asked for.
 *  - **A caller-visible split between "no estimator" and "no estimate".**
 *    `haikuEffortEstimator` answers `null` — no estimator at all — when
 *    there is no key or scoring is switched off, so `server.ts` can leave a
 *    row untouched exactly as it would if scoring had never been wired in.
 *    A wired estimator's `null` (a timeout, a non-2xx, a reply that will not
 *    parse) is a DIFFERENT thing: an attempt ran and produced nothing
 *    usable, which the caller records as a failed run — unlike the review
 *    gate, an estimate that could not be produced is new information the
 *    row did not have before, never a pass-through.
 *  - **One call per trigger, no retries.** The next edit gets its own
 *    attempt; a failed run is superseded the moment the ticket's words
 *    change again.
 *
 * `createServer` takes the estimator as an option with NO default — the
 * same seam rule as the summarizer and the review judge: nothing that
 * merely spins a server up (every test, every embedded use) can reach the
 * network. `bin.ts` constructs the real one.
 */

import {
  type EffortEstimateTicket,
  type EffortEstimateVerdict,
  buildEffortEstimatePrompt,
  parseEffortEstimateResponse,
} from '@feedback/core/effort-estimate-prompt';
import { readRenamedEnv } from '@feedback/core/env-names';
import { readKeychainPassword } from './share/keychain.ts';
import { resolveKeyFrom } from './summarize.ts';

export type { EffortEstimateVerdict } from '@feedback/core/effort-estimate-prompt';

export interface EffortEstimatorInput {
  /** The workspace's own tuning text — the owner's words, or the default. */
  prompt: string;
  ticket: EffortEstimateTicket;
}

/**
 * The seam. `null` means "no usable estimate" — a down endpoint, a bad key
 * at call time, a reply that will not parse — and the caller records that
 * as a `failed` run on the ticket. A thrown error is treated identically by
 * the caller, so an implementation may do either.
 */
export type EffortEstimator = (
  input: EffortEstimatorInput,
) => Promise<EffortEstimateVerdict | null>;

/** Recorded on every estimate this module produces, so a stored number can
 *  be told which generation of scoring made it. */
export const EFFORT_ESTIMATE_MODEL = 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_TOKENS = 200;
/**
 * Generous relative to the review judge's 8 seconds, and deliberately so:
 * this call runs entirely in the BACKGROUND, off a store event, never
 * inside a route an edit is waiting on (see the fire-and-forget wiring in
 * `server.ts`) — a slower answer costs nothing but a later estimate.
 */
export const EFFORT_ESTIMATE_TIMEOUT_MS = 20_000;

export interface HaikuEffortEstimatorOpts {
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Supply a key directly instead of reading Keychain (tests). `null` is
   *  "there is no key", explicitly. */
  apiKey?: string | null;
  timeoutMs?: number;
}

/** Process-wide, so each cause is named once and not once per ticket. */
const warned = new Set<string>();
function warnOnce(cause: string, line: string): void {
  if (warned.has(cause)) return;
  warned.add(cause);
  console.error(line);
}

/** Is scoring switched on at all? `CW_EFFORT_ESTIMATE=0` is the kill switch. */
export function effortEstimateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readRenamedEnv(env, 'CW_EFFORT_ESTIMATE') !== '0';
}

/**
 * The real estimator, or `null` when there is no key or scoring is off — so
 * `bin.ts` can say which and `createServer` gets no estimator at all rather
 * than one that fails every call.
 */
export function haikuEffortEstimator(opts: HaikuEffortEstimatorOpts = {}): EffortEstimator | null {
  if (!effortEstimateEnabled()) return null;
  const key = resolveKeyFrom(opts.apiKey, readKeychainPassword);
  if (!key) return null;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? EFFORT_ESTIMATE_TIMEOUT_MS;
  return async (input) => {
    const { system, user } = buildEffortEstimatePrompt(input.prompt, input.ticket);
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
          model: EFFORT_ESTIMATE_MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages: [{ role: 'user', content: user }],
        }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        // The body may carry a rate-limit reason; the KEY must never be logged.
        warnOnce(`http-${res.status}`, `[effort-estimate] HTTP ${res.status}; rows marked failed`);
        return null;
      }
      const body = (await res.json()) as { content?: Array<{ text?: string }> };
      const text = body.content?.map((b) => b.text ?? '').join('') ?? '';
      const verdict = parseEffortEstimateResponse(text);
      if (!verdict) {
        warnOnce(
          'unparseable',
          '[effort-estimate] reply was not a usable estimate; row marked failed',
        );
      }
      return verdict;
    } catch (err) {
      warnOnce(
        'call-failed',
        `[effort-estimate] call failed (${err instanceof Error ? err.message : String(err)}); rows marked failed`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
