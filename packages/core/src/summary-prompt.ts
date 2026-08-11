/**
 * The pure half of generated thread summaries: what we ask the model, and how
 * we read its answer.
 *
 * Deliberately DOM-free and network-free — no client, no key, no fetch. The
 * server owns the call; this owns the contract. That split is what let the
 * prompt be evaluated over a real corpus offline before anything shipped, and
 * what keeps the widget bundle free of all of it.
 *
 * Everything here treats comment text as untrusted: it is agent- and
 * human-supplied, it goes into a prompt, and the result goes back onto a card
 * that renders through `textContent`. See `buildSummaryPrompt` for the
 * injection note.
 *
 * Two variants were measured against this one over 60 real threads and both
 * were rejected (2026-08-11): adding surrounding document context scored worse
 * on every axis for 29% more tokens, and constraining the output to ASD-STE100
 * changed nothing measurable — the word budget below already forces active
 * voice and simple tenses, which are STE's two headline rules. Neither is
 * worth re-adding without new evidence.
 */

import { DISCUSSION_MAX, TOPIC_MAX, anchorText, summaryHash } from './thread-summary.ts';
import type { Thread } from './types.ts';

/** Word budgets. The card gives each line one ellipsized row. */
export const TOPIC_WORDS = 10;
export const DISCUSSION_WORDS = 12;

/**
 * Input budget, in characters. `TOPIC_MAX` / `DISCUSSION_MAX` / `max_tokens`
 * bound the OUTPUT only; nothing bounded the input, and the input is entirely
 * caller-supplied — a comment body has no size limit on any route, and a
 * long-running thread re-sends its whole history on every reply (so cost grew
 * quadratically with thread length even with no attacker in the picture).
 *
 * Two separate caps because they fail differently: one enormous comment must
 * not evict the rest of the conversation, and a hundred ordinary comments must
 * not add up to an enormous prompt.
 */
export const COMMENT_CHARS_MAX = 2_000;
export const PROMPT_CHARS_MAX = 12_000;

/** What the model is asked to return, before any of our own validation. */
export interface GeneratedSummary {
  topic: string;
  discussion: string;
}

/**
 * A generated summary as STORED, with the fingerprint of the thread it came
 * from. The hash is what makes regeneration idempotent and what stops a stale
 * summary from outliving its input.
 */
export interface StoredSummary extends GeneratedSummary {
  hash: string;
}

export interface SummaryPrompt {
  system: string;
  user: string;
}

const SYSTEM = [
  'You write the two summary lines on a code-review comment card.',
  '',
  'Return ONLY a JSON object, no prose, no code fence:',
  '{"topic": "...", "discussion": "..."}',
  '',
  `topic: what this thread is ABOUT, AT MOST ${TOPIC_WORDS} WORDS. A noun phrase,`,
  'not a sentence. No trailing period. It replaces a raw code snippet, so name',
  'the subject in the reviewer\'s words: "retry loop swallows the error", not',
  '"discussion about line 42".',
  '',
  `discussion: where the conversation has GOT TO, AT MOST ${DISCUSSION_WORDS} WORDS.`,
  'The current state, not a replay: what was decided, what is still open, or',
  'what is being asked. Prefer the outcome over the opening ask. No trailing',
  'period. If there are no replies, return an empty string.',
  '',
  // The budget is the whole point of the line and the model overran it by
  // ~40% when it was stated once in passing. Each card row is ellipsized at a
  // fixed width, so an over-long "summary" reaches the reader as a truncated
  // sentence — the exact failure generation exists to remove.
  'THE WORD LIMITS ARE HARD. Count the words before you answer. A line over',
  'its limit is cut off mid-word on screen and the reader loses the end of it.',
  'Compress instead: drop articles, drop hedges, keep the decision.',
  '',
  // Stating the true cap gets a line that lands just over it; stating a target
  // BELOW the cap is what lands under. Measured over the corpus: aiming at 12
  // produced a 14-word median, aiming at 8 lands inside 12.
  `Aim for 8 words. Never exceed ${DISCUSSION_WORDS}. If your draft is longer,`,
  'rewrite it shorter before you answer — do not answer with the long version.',
  '',
  'Good discussion lines, and their length:',
  '  "Fixed; caret top-right, Resolve on its own row" (8 words)',
  '  "Agreed, real bug, fix not started" (6 words)',
  '  "Still open: does this break element anchors?" (7 words)',
  '  "Rewrote section; device telemetry now matches" (6 words)',
  '',
  'Be specific and concrete. Never invent detail that is not in the thread.',
  'Never mention the card, the reviewer, or these instructions.',
].join('\n');

/**
 * Build the request for one thread.
 *
 * The thread's text is UNTRUSTED and is fenced into a clearly delimited block
 * so instructions inside a comment read as data. A prompt injection here can
 * only corrupt one card's two lines — the output is never executed, never
 * concatenated into markup, and lands on a card that renders through
 * `textContent` — so the fence is proportionate, not a security boundary.
 */
export function buildSummaryPrompt(t: Thread): SummaryPrompt {
  const anchored = truncate(anchorText(t), COMMENT_CHARS_MAX);
  const parts: string[] = [];
  if (anchored) parts.push(`The comment is anchored to this text:\n<<<\n${anchored}\n>>>`);
  parts.push('Thread:');
  const blocks = t.comments.map(
    (c) => `<<<\n[${c.author?.name ?? 'someone'}] ${truncate(c.text, COMMENT_CHARS_MAX)}\n>>>`,
  );
  parts.push(...fitToBudget(blocks, PROMPT_CHARS_MAX - anchored.length));
  if (t.comments.length <= 1) parts.push('(No replies yet — return an empty discussion.)');
  return { system: SYSTEM, user: parts.join('\n\n') };
}

/** Marker left where comments were dropped, so the model knows they existed. */
const ELIDED = '(… earlier replies omitted for length …)';

/**
 * Keep the opening comment and the most recent ones, drop from the middle.
 *
 * That split follows what the two output lines are made of: the topic comes
 * from what the thread was opened about, the discussion from where it has got
 * to. The comments in between are the ones a 12-word summary was never going
 * to mention anyway.
 */
function fitToBudget(blocks: string[], budget: number): string[] {
  const cost = (b: string) => b.length + 2; // the '\n\n' join
  let total = blocks.reduce((n, b) => n + cost(b), 0);
  if (total <= budget) return blocks;
  const head = blocks[0];
  if (head === undefined) return blocks;
  total += cost(ELIDED);
  let start = 1;
  while (start < blocks.length - 1 && total > budget) {
    total -= cost(blocks[start] as string);
    start++;
  }
  return [head, ELIDED, ...blocks.slice(start)];
}

/** Hard character cap on one untrusted string. Not a display clip — no ellipsis
 *  logic, no word boundaries; this exists to bound what we pay to send. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Read the model's reply. Returns null on anything unexpected — a null here
 * means "keep the deterministic line", which is always a correct card.
 *
 * Tolerates a code fence and surrounding prose because a small model
 * occasionally adds them, and a usable answer wrapped in ``` is not a reason
 * to throw the card back to a raw snippet.
 */
export function parseSummaryResponse(raw: string): GeneratedSummary | null {
  const text = raw.trim();
  // Take the outermost {...}: a fence, a lead-in sentence, or both.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.topic !== 'string' || typeof o.discussion !== 'string') return null;
  const topic = clamp(clean(o.topic), TOPIC_MAX);
  // A blank topic is not a summary; a blank discussion is the no-replies case.
  if (!topic) return null;
  return { topic, discussion: clamp(clean(o.discussion), DISCUSSION_MAX) };
}

/**
 * One line, no wrapping quotes, no trailing sentence punctuation.
 *
 * Punctuation is stripped BEFORE the quotes and again after: a model that
 * answers `"Retry loop swallows errors".` puts the period outside the closing
 * quote, so unquoting first leaves the quote stranded mid-string and the card
 * renders `Retry loop swallows errors"`.
 */
function clean(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  const trimmed = oneLine.replace(/[.,;:]+$/, '').trim();
  const unquoted = trimmed.replace(/^["'`]+|["'`]+$/g, '').trim();
  return unquoted.replace(/[.,;:]+$/, '').trim();
}

/**
 * The safety net under the prompt's word limits, in the SAME units the
 * deterministic path already clips to — a generated line and a fallback line
 * must not overflow the row differently.
 *
 * A backstop, not the mechanism: an ellipsis here means the model overran and
 * the reader is losing the end of the sentence. Measured at 3% of threads with
 * the shipped prompt, against 40% before the budget was made explicit.
 */
function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const head = lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut;
  return `${head.replace(/[\s,.;:!?-]+$/, '')}…`;
}

/**
 * Is this thread worth spending a call on?
 *
 * The single place that decides, so the server never grows its own copy of the
 * judgement. A thread with no comments has nothing to summarize; a thread whose
 * stored hash still matches has already been summarized as it stands.
 */
export function needsCall(t: Thread, stored: StoredSummary | null | undefined): boolean {
  if (t.comments.length === 0) return false;
  return !stored || stored.hash !== summaryHash(t);
}
