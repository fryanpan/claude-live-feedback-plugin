/**
 * The review-item quality gate's pure half: the default criteria, the prompt
 * built from them, and the parser for the judge's reply.
 *
 * Pure for the same reason `summary-prompt.ts` is — the network half lives in
 * the server (`review-judge.ts`), so the wording of the ask and the shape of
 * the answer can be asserted without a key or a socket.
 *
 * Bryan, 2026-08-29, on the task thread that asked for this: *"Don't refuse,
 * but let's have a criteria for what makes a good review item. Something we
 * can change in the settings. It's a natural language prompt."* The criteria
 * are therefore TEXT a workspace owner edits, not a rule table in code; this
 * file only supplies the default and the frame around it.
 */

import type { ReviewOption } from './review-item.ts';

/** Bumped when the frame around the criteria changes, so a stored verdict
 *  can be told from one made under an older ask. */
export const REVIEW_JUDGE_PROMPT_VERSION = 1;

/**
 * What a workspace judges its review items against until somebody edits it.
 *
 * Written for the READER of a card — a person on a phone with nothing else
 * open — because that is who a review item exists for. Every clause is a
 * thing measured missing on the live board: headlines in the agent's own
 * vocabulary, details that said what was done rather than what is at stake,
 * options with no costs, bare ids the reader had to go and look up.
 */
export const DEFAULT_REVIEW_ITEM_CRITERIA = [
  'A good review item can be answered from the card alone, on a phone, without opening anything else.',
  '- The headline names the decision or the thing to look at, in the reader’s own words — not the agent’s internal name for it.',
  '- The detail gives the stakes (what waits on this, what it changes) and says exactly what to look at.',
  '- On a decision, each option says what choosing it costs — time, risk, or what it rules out.',
  '- Links are inline on the words they explain, never bare URLs or “see below”.',
  '- No raw ids and no acronyms without expansion: a ticket id, a doc id, a commit hash or a team-only abbreviation is something the reader would have to look up.',
].join('\n');

export interface ReviewJudgeItem {
  headline: string;
  detail?: string;
  options?: ReviewOption[];
}

export interface ReviewJudgeVerdict {
  ok: boolean;
  /** One sentence naming the biggest gap (or, on `ok`, what carried it). */
  reason: string;
}

/** The longest reason stored or shown. A judge that writes an essay is
 *  clipped rather than refused — the verdict is the load-bearing half. */
export const REVIEW_JUDGE_REASON_MAX = 300;

/**
 * The two halves of the call. The criteria go in the SYSTEM turn verbatim,
 * so what the owner wrote is what the judge reads; the item is laid out as
 * labelled fields so a missing detail reads as missing rather than as a
 * short paragraph.
 */
export function buildReviewJudgePrompt(
  criteria: string,
  item: ReviewJudgeItem,
): { system: string; user: string } {
  const system = [
    'You judge whether a review item an AI agent filed for a human reader is good enough to put on that reader’s queue.',
    'Judge substance against the criteria below, not length or tone. When unsure, pass it: a held item costs the reader an answer they could have given.',
    'Reply with JSON only, on one line: {"ok": true|false, "reason": "<one sentence>"}.',
    'When ok is false, the reason names the single biggest gap so the agent can fix it in one edit.',
    '',
    'Criteria:',
    criteria.trim(),
  ].join('\n');
  const lines = [`Headline: ${item.headline}`];
  lines.push(`Detail: ${item.detail?.trim() ? item.detail.trim() : '(none)'}`);
  if (item.options && item.options.length > 0) {
    lines.push('Options:');
    for (const o of item.options) {
      lines.push(
        `- ${o.label}${o.detail?.trim() ? ` — ${o.detail.trim()}` : ' — (no cost given)'}`,
      );
    }
  }
  return { system, user: lines.join('\n') };
}

/**
 * Read the judge's reply. `null` when it is not a verdict — no JSON, no
 * boolean `ok` — which the caller treats exactly like a failed call: the
 * item passes through. A reply that half-parses must not become a hold.
 */
export function parseReviewJudgeResponse(text: string): ReviewJudgeVerdict | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const ok = (parsed as { ok?: unknown }).ok;
  if (typeof ok !== 'boolean') return null;
  const rawReason = (parsed as { reason?: unknown }).reason;
  const reason = (typeof rawReason === 'string' ? rawReason : '').trim().replace(/\s+/g, ' ');
  return {
    ok,
    reason:
      reason.length > REVIEW_JUDGE_REASON_MAX
        ? `${reason.slice(0, REVIEW_JUDGE_REASON_MAX - 1)}…`
        : reason,
  };
}
