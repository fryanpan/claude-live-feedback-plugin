/**
 * Generated thread summaries: the half that talks to the network.
 *
 * The prompt, the parsing and the "is this worth a call" rule live in
 * `@feedback/core/summary-prompt` and are pure. This file owns everything that
 * is not: the API key, the HTTP call, the debounce, and the promise that stops
 * three browsers on one doc from paying for the same summary three times.
 *
 * THIS IS THE SERVER'S ONLY OUTBOUND API ACCESS. Two consequences worth
 * keeping in mind when editing it:
 *
 *  - Comment text AND the anchored source line leave the machine — on a diff
 *    or code doc the anchor snippet is the code itself, not just prose.
 *    Approved 2026-08-10 for this purpose and no other. The account the key
 *    belongs to is a privacy boundary that nothing here enforces — see the
 *    design spec's note before widening what gets sent. Because of that, the
 *    key must be a DEDICATED one the operator chose to add: a generic
 *    `ANTHROPIC_API_KEY` sitting in the launch environment is not consent,
 *    and is deliberately not honoured (see `resolveKey`).
 *  - Every failure is non-fatal. An absent key, an offline machine, a 429, a
 *    reply that will not parse: all of them leave the deterministic card lines
 *    exactly where they were. Generation is an enhancement to a working card,
 *    never a dependency of one.
 */

import { summaryHash } from '@feedback/core';
import {
  type StoredSummary,
  buildRetryNudge,
  buildSummaryPrompt,
  findDeliveryClaim,
  needsCall,
  parseSummaryResponse,
} from '@feedback/core/summary-prompt';
import type { Thread } from '@feedback/core/types';
import { readKeychainPassword } from './share/keychain.ts';

/** Keychain service holding the key. Env override: LIVE_FEEDBACK_SUMMARY_API_KEY. */
export const KEYCHAIN_SERVICE = 'live-feedback-summary-api-key';
const MODEL = 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';
/** Long enough to coalesce a burst of edits, short enough to feel live. */
export const DEBOUNCE_MS = 3_000;
const MAX_TOKENS = 200;
/** A brief is a ~200-word page-top, not a card line — it needs more room
 *  than a thread summary, and its budget is still a hard cap. */
const BRIEF_MAX_TOKENS = 600;
const TIMEOUT_MS = 20_000;

export interface SummarizerOpts {
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected in tests so a debounce doesn't cost real seconds. */
  debounceMs?: number;
  /**
   * Supply a key directly instead of reading Keychain (tests).
   *
   * `null` means "there is no key" EXPLICITLY, and skips the lookup. Omitting
   * the field consults the Keychain, which on a machine that has the entry —
   * i.e. the one where this feature is configured — resolves, so a test that
   * wants the disabled state must ask for it rather than assume it.
   */
  apiKey?: string | null;
}

export interface ScheduleArgs {
  docId: string;
  threadId: string;
  /** Re-read at call time, not captured: the thread moves while we wait. */
  getThread: () => Thread | null;
  /** Persist the result. Called only on success. */
  apply: (summary: StoredSummary) => void;
}

/**
 * Resolve the API key once. Returns null when there is none, which is the
 * documented "feature off" state rather than an error.
 *
 * ONLY the dedicated entry counts — the Keychain service above, or its
 * `LIVE_FEEDBACK_SUMMARY_API_KEY` env override. It used to fall back to
 * `ANTHROPIC_API_KEY`, which is set in most Claude Code launch environments:
 * that turned an opt-in feature into one that switched itself on for every
 * peer who installed the plugin, shipping their review comments and anchored
 * source lines off-machine without anyone choosing it. Adding the dedicated
 * entry is the act of consent; a key that happens to be in the environment
 * for other reasons is not.
 */
function resolveKey(explicit?: string | null): string | null {
  if (explicit !== undefined) return explicit || null;
  try {
    return readKeychainPassword(KEYCHAIN_SERVICE);
  } catch {
    return null;
  }
}

/** Process-wide so the key hint / on notice appear once, not once per server. */
let warnedNoKey = false;
let announcedOn = false;

/** How a paced backfill waits between calls. Returned so `dispose()` can end
 *  the wait early — otherwise "stop" means "stop in up to `intervalMs`", and
 *  on a 15-minute drain that is a shutdown that hangs for minutes. */
interface Wait {
  done: Promise<void>;
  cancel: () => void;
}

/** A timer that never holds the process open, so a paced backfill cannot keep
 *  a server (or a test runner) alive waiting for its next tick. */
function wait(ms: number): Wait {
  let cancel = () => {};
  const done = new Promise<void>((resolve) => {
    const t = setTimeout(() => resolve(), ms);
    t.unref?.();
    cancel = () => {
      clearTimeout(t);
      resolve();
    };
  });
  return { done, cancel };
}

export class ThreadSummarizer {
  private readonly key: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly debounceMs: number;
  /** Pending debounce timer per doc+thread. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** In-flight call per doc+thread — the dedup that makes N browsers cost 1. */
  private readonly inflight = new Map<string, Promise<void>>();
  /** A change that landed while a call was in flight; re-run once it lands. */
  private readonly dirty = new Set<string>();
  /** True while a backfill is draining; cleared by dispose() to stop it. */
  private backfilling = false;
  /** Ends the current pacing wait early, so a stop takes effect at once. */
  private cancelWait: (() => void) | null = null;

  constructor(opts: SummarizerOpts = {}) {
    this.key = resolveKey(opts.apiKey);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  }

  /** Is generation switched on at all? `LF_SUMMARIES=0` is the kill switch. */
  get enabled(): boolean {
    return process.env.LF_SUMMARIES !== '0' && this.key !== null;
  }

  /**
   * Note a thread changed. Debounced, deduped, and silent when disabled — the
   * caller never has to check whether generation is on.
   */
  schedule(args: ScheduleArgs): void {
    if (!this.enabled) {
      if (!warnedNoKey && process.env.LF_SUMMARIES !== '0') {
        warnedNoKey = true;
        console.log(
          '[summarize] no API key; thread summaries stay deterministic. ' +
            `Add one with: security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w`,
        );
      }
      return;
    }
    const key = `${args.docId}\u0000${args.threadId}`;
    // A call is already out for this thread: don't start a second one, just
    // remember that what it is about to store is already out of date.
    if (this.inflight.has(key)) {
      this.dirty.add(key);
      return;
    }
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.run(key, args);
    }, this.debounceMs);
    // Never hold the process open for a summary.
    timer.unref?.();
    this.timers.set(key, timer);
  }

  /**
   * Generate for one thread and store the result, or do nothing at all.
   *
   * Shared by the debounced path and the backfill so the two cannot drift:
   * both must skip an up-to-date thread, both must re-check the hash after
   * the call, and both must swallow their own failures.
   *
   * Returns true only when a summary was actually stored — the backfill
   * counts those to report what it did.
   */
  private async generateAndApply(args: ScheduleArgs): Promise<boolean> {
    try {
      const thread = args.getThread();
      if (!thread || !needsCall(thread, thread.summary)) return false;
      const summary = await this.generate(thread);
      if (!summary) return false;
      // Re-read before storing: the thread may have changed during the
      // call, and writing a summary whose hash no longer matches would
      // store something `threadLines` is going to ignore anyway.
      const now = args.getThread();
      if (!now || summaryHash(now) !== summary.hash) return false;
      args.apply(summary);
      return true;
    } catch (err) {
      console.error('[summarize] failed:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  private async run(key: string, args: ScheduleArgs): Promise<void> {
    const task = this.generateAndApply(args).then(() => undefined);
    this.inflight.set(key, task);
    await task;
    this.inflight.delete(key);
    if (this.dirty.delete(key)) this.schedule(args);
  }

  /**
   * One call, no debounce. This is what the REST route and the MCP tool use,
   * where the caller has asked for a summary NOW and is waiting for it.
   *
   * Unconditional by design — it does NOT consult `needsCall`. This is the
   * primitive that spends a call; deciding whether one is worth spending
   * belongs to the caller, because the two callers want opposite defaults:
   * the scheduled path and the backfill skip an up-to-date thread
   * (`generateAndApply`), while the on-demand route has to be able to honour
   * an explicit "that line is wrong, do it again". The route asks `needsCall`
   * itself and only reaches here when the answer is yes or `force` was set.
   *
   * Returns null when generation is off or anything at all goes wrong.
   */
  async generate(thread: Thread): Promise<StoredSummary | null> {
    if (!this.enabled || !this.key) return null;
    // The mirror image of the no-key hint, and the more important half: the
    // operator used to see output only in the case where NOTHING is
    // transmitted, and silence in the case where everything is.
    //
    // It lives HERE, not in `schedule()`, because the backfill reaches the
    // network without going through the debounced path — so the single
    // largest transmission this feature ever makes was the one that printed
    // no disclosure at all.
    if (!announcedOn) {
      announcedOn = true;
      console.log(
        '[summarize] thread summaries ON: comment text and the anchored line ' +
          'are sent to api.anthropic.com. Turn off with LF_SUMMARIES=0.',
      );
    }
    // Hash the state we are about to describe, BEFORE the call, so a reply
    // that lands mid-flight invalidates this summary instead of being
    // silently attributed to it.
    const hash = summaryHash(thread);
    const { system, user } = buildSummaryPrompt(thread);

    const first = await this.post(system, [{ role: 'user', content: user }]);
    if (first === null) return null;
    const parsed = parseSummaryResponse(first);
    if (!parsed) return null;

    // The card shows a summary line IN FULL now — display truncation is gone
    // — so an overrun reaches the reader verbatim. One corrective follow-up
    // (with the conversation so far, so the model shortens ITS answer rather
    // than starting over) recovers most overruns; if the retry is still long
    // or fails, the first answer ships whole. Never truncate here: a
    // complete 15-word line beats a chopped 12-word one.
    const hasReplies = thread.comments.length > 1;
    const firstClaim = findDeliveryClaim(parsed);
    const nudge = buildRetryNudge(parsed, { hasReplies });
    if (nudge) {
      const retry = await this.post(system, [
        { role: 'user', content: user },
        { role: 'assistant', content: first },
        { role: 'user', content: nudge },
      ]);
      const reparsed = retry === null ? null : parseSummaryResponse(retry);
      if (reparsed && !buildRetryNudge(reparsed, { hasReplies })) {
        // A shortened answer must still be an ANSWER. A retry that empties a
        // line the first answer had filled is a deletion, not a rewrite, and
        // an empty line costs zero words — so it would pass the budget check
        // above and take a good line off the card. Keep whichever answer has
        // the line.
        const keepsTopic = parsed.topic === '' || reparsed.topic !== '';
        const keepsDiscussion = parsed.discussion === '' || reparsed.discussion !== '';
        if (keepsTopic && keepsDiscussion) return { ...reparsed, hash };
      }
      // An over-long first answer SHIPS as the fallback below, because a
      // complete 15-word line beats a chopped 12-word one. A first answer that
      // asserted delivery status must not: shipping it is shipping the false
      // claim the guard exists to stop, and it is compact and confident, which
      // is exactly what makes it believed. So the precedence inverts here.
      if (firstClaim) {
        // An answer that is merely over budget but makes no delivery claim is
        // better than one that is compact and wrong — length is a display
        // annoyance, a false "PR merged" is a lie on the board.
        const clean =
          reparsed &&
          !findDeliveryClaim(reparsed) &&
          (parsed.discussion === '' || reparsed.discussion !== '');
        if (clean && reparsed) return { ...reparsed, hash };
        // Both answers asserted delivery status. Store nothing: `threadLines`
        // then keeps the deterministic lines, which are quoted from the thread
        // and therefore cannot contradict it. Worse writing, never a false
        // shipping claim.
        console.error(`[summarize] dropped a summary asserting delivery status: "${firstClaim}"`);
        return null;
      }
    }
    return { ...parsed, hash };
  }

  /**
   * The Home pane's "What's New?" brief — one call, the caller's prompt.
   *
   * Lives on this class rather than in `home-brief.ts` so the brief rides
   * the SAME seam and the same consent as thread summaries: the only real
   * summarizer is constructed in `bin.ts`, the key is the dedicated
   * Keychain entry, and every test / staging server that omits the
   * summarizer (or passes `apiKey: null`) cannot reach the network. What
   * leaves the machine here is the workspace's event digest (task titles,
   * actor names, event types) plus the reader's own instructions — the same
   * class of content as the comment text already approved for this key.
   *
   * Returns the raw reply text, or null when generation is off or anything
   * fails; the caller (`home-brief.ts`'s `acceptBrief`) decides whether the
   * reply is usable, and the deterministic brief stands otherwise.
   */
  async generateHomeBrief(prompt: { system: string; user: string }): Promise<string | null> {
    if (!this.enabled || !this.key) return null;
    if (!announcedOn) {
      announcedOn = true;
      console.log(
        '[summarize] thread summaries ON: comment text and the anchored line ' +
          'are sent to api.anthropic.com. Turn off with LF_SUMMARIES=0.',
      );
    }
    return await this.post(
      prompt.system,
      [{ role: 'user', content: prompt.user }],
      BRIEF_MAX_TOKENS,
    );
  }

  /**
   * One HTTP round trip: messages in, raw reply text out, null on ANY
   * failure. The key stays in the header, never the logs.
   */
  private async post(
    system: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    maxTokens: number = MAX_TOKENS,
  ): Promise<string | null> {
    if (!this.key) return null;
    const ctl = new AbortController();
    const timeout = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages }),
        signal: ctl.signal,
      });
      if (!res.ok) {
        // Body may carry a rate-limit reason; the KEY must never be logged.
        console.error(`[summarize] HTTP ${res.status}`);
        return null;
      }
      const body = (await res.json()) as { content?: Array<{ text?: string }> };
      return body.content?.map((b) => b.text ?? '').join('') ?? '';
    } catch (err) {
      // "Returns null on anything at all going wrong" has to include the
      // things that THROW: an offline machine, the 20s abort above, a 200
      // with a body that is not JSON. Without this the on-demand route —
      // which awaits this bare — answered a 500 with a stack trace instead
      // of its documented 503, and the scheduled path's own catch made the
      // gap invisible.
      console.error('[summarize] call failed:', err instanceof Error ? err.message : err);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Summarize a backlog of threads slowly, one at a time.
   *
   * Existing threads never change, so the debounced path would never touch
   * them: without this, a doc written before generation shipped keeps its raw
   * `catch (e) {}` topic line forever, and the feature looks broken on exactly
   * the docs that motivated it.
   *
   * Paced rather than parallel on purpose. The interval is derived from the
   * work — `windowMs / pending` — so the whole backlog lands in about
   * `windowMs` however big it is, instead of a burst that trips a rate limit
   * and spends the key as fast as the API will take it. One call is in flight
   * at a time.
   *
   * Idempotent: `generateAndApply` skips any thread whose stored summary is
   * current, so an interrupted backfill resumes where it stopped and a repeat
   * run costs nothing. Live edits win — a thread already being generated for
   * by the debounced path is skipped rather than duplicated.
   *
   * ONE AT A TIME per summarizer. `backfilling` and `cancelWait` are single
   * fields, so two overlapping drains would corrupt each other: the first to
   * finish clears the flag and truncates the other mid-queue, and clearing the
   * shared canceller loses the other's wait — reinstating exactly the
   * shutdown-hangs-for-one-interval failure the cancellable wait exists to
   * prevent. A second call while one is draining is a no-op, and since the
   * sweep is idempotent, "run it again after this one" costs nothing.
   */
  async backfill(
    tasks: ScheduleArgs[],
    opts: {
      windowMs?: number;
      minIntervalMs?: number;
      onProgress?: (done: number, total: number) => void;
    } = {},
  ): Promise<{ attempted: number; stored: number }> {
    if (!this.enabled || tasks.length === 0) return { attempted: 0, stored: 0 };
    if (this.backfilling) return { attempted: 0, stored: 0 };
    const windowMs = opts.windowMs ?? 15 * 60 * 1000;
    const minIntervalMs = opts.minIntervalMs ?? 250;
    const intervalMs = Math.max(minIntervalMs, Math.floor(windowMs / tasks.length));
    this.backfilling = true;
    let attempted = 0;
    let stored = 0;
    for (const [i, args] of tasks.entries()) {
      // dispose() during a 15-minute drain: stop, don't finish the queue.
      if (!this.backfilling) break;
      const key = `${args.docId}\u0000${args.threadId}`;
      // Someone is actively editing this thread and the live path already has
      // it. Leave it to them — their summary will be the fresher one.
      if (this.inflight.has(key)) continue;
      attempted++;
      if (await this.generateAndApply(args)) stored++;
      opts.onProgress?.(attempted, tasks.length);
      // N tasks need N-1 gaps. Waiting after the LAST one delays nothing but
      // the result and the "backfill done" line — by a whole interval, which
      // at the default window is minutes of apparently-still-running silence.
      if (!this.backfilling || i === tasks.length - 1) break;
      const w = wait(intervalMs);
      this.cancelWait = w.cancel;
      await w.done;
      this.cancelWait = null;
    }
    this.backfilling = false;
    this.cancelWait = null;
    return { attempted, stored };
  }

  /** Drop pending work. Called on shutdown and between tests. */
  dispose(): void {
    this.backfilling = false;
    this.cancelWait?.();
    this.cancelWait = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.dirty.clear();
  }
}
