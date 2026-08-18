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

import { anchorText, summaryHash } from './thread-summary.ts';
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
 *
 * `promptVersion` is the OTHER input a summary is derived from. The hash
 * covers the thread; nothing covered the instructions, so a summary written
 * under a prompt that has since been corrected stayed current forever — the
 * 2026-08-17 delivery-claim rule reached zero of the ~900 summaries already
 * on disk, because every one of them still matched its thread. Absent means
 * "before this field existed" (version 1). See `needsCall`.
 */
export interface StoredSummary extends GeneratedSummary {
  hash: string;
  promptVersion?: number;
}

/**
 * Bump when a change to SYSTEM (or to how the answer is read) is meant to
 * reach summaries that already exist. `needsCall` treats a stored summary
 * from an older version as needing a call, so the next backfill rewrites it;
 * the client keeps showing the old line until the new one lands. Nothing
 * fires on its own — the backfill is still opt-in per start (`bin.ts`).
 *
 *   1  everything before the field existed
 *   2  2026-08-18: mood rules (proposal ≠ decision, in-flight ≠ done,
 *      newest comment wins, polarity, actor) after a 927-summary review
 */
export const SUMMARY_PROMPT_VERSION = 2;

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
  // The examples used to be three completed states and one open question, and
  // the model learnt the lesson: it wrote "Done" / "Agreed" / "Fixed" over
  // threads that only proposed, asked, or planned. Measured over 927 stored
  // summaries (2026-08-18): the largest error class by far was a proposal,
  // plan, request, or in-flight step reported as done or agreed — 24 of the
  // 43 lines a reviewer flagged. Inversions were 5, stale state 5. So the
  // examples now show the moods the thread actually comes in.
  'Good discussion lines, and their length:',
  '  "Fixed; caret top-right, Resolve on its own row" (8 words)',
  '  "Proposes separate writing type; awaiting your call" (7 words)',
  '  "Still open: does this break element anchors?" (7 words)',
  '  "Retitle planned, not applied yet; PR still open" (8 words)',
  '  "Earlier fix retracted; doc numbers stand" (6 words)',
  '',
  'Be specific and concrete. Never invent detail that is not in the thread.',
  'Never mention the card, the reviewer, or these instructions.',
  '',
  // The rules below each name a measured error class from the same review.
  // They are stated as substitutions ("say X instead"), not prohibitions,
  // because a rule phrased only as "never say Y" is satisfied by a blank line.
  'STATE THE MOOD THE THREAD IS IN. Only what the thread ESTABLISHES, in the',
  'mood it establishes it:',
  '- A proposal, recommendation, or plan is NOT a decision or a done deed.',
  '  "I\'d add X — want me to?" is "Proposes adding X; awaiting go-ahead", never',
  '  "Agreed to add X" or "Added X".',
  '- Future or in-flight work is NOT done. "I\'ll retitle §2", "running now",',
  '  "PR is up" are "Retitle planned", "Verification run in flight", "PR open',
  '  for review" — never "Fixed", "Verified", "Done".',
  '- An unanswered question IS the state. If the newest comment asks someone',
  '  something or offers to do something, name that open ask.',
  '- The NEWEST comment wins. A later comment that corrects, retracts, or',
  '  supersedes an earlier one defines the state; do not report the older one.',
  '- Keep polarity exactly: not / un- / never, over / under, before / after,',
  '  pre- / post-, open / closed. A flipped word is the worst error you can',
  "  make. When unsure, reuse the thread's own word.",
  '- Keep the actor. An agent recommending is not the human deciding; an ask',
  '  relayed to someone else is not work done here.',
  '',
  // The one class of claim a summary can get SPECIFICALLY and CHECKABLY wrong,
  // and the one the board already knows the answer to without asking a model.
  // See `findDeliveryClaim` for why this is a claim rule, not a word ban.
  'DELIVERY STATUS IS NOT YOURS TO STATE. Never say that work merged, shipped,',
  'landed, was deployed, or was released. The card shows delivery status from',
  "the board's own record — the task status, the evidence commit, the PR link —",
  'so a guess from you can only agree with it or contradict it.',
  '',
  'Say what the THREAD establishes instead: what was decided, what was',
  'verified, what was disclosed, or what is still open. That is more useful to',
  'the reader than a status they already have.',
  '  Instead of "PR merged, CI green": "Verified empty on prod; guards',
  '  mutation-tested" (7 words)',
  '  Instead of "Shipped; anchors now stable": "Anchors stable under reindent;',
  '  blank-line case still open" (8 words)',
].join('\n');

/**
 * Words that assert a change reached somewhere real.
 *
 * `\b` at the front is doing real work: "unmerged" and "undeployed" have no
 * word boundary before `merged`, so they never match and need no hedge entry.
 */
const DELIVERY_WORDS = /\b(merged|shipped|landed|deployed|released)\b/gi;

/**
 * Auxiliaries and filler between a hedge and the claim, stripped from the
 * right so "has not BEEN merged" reads as the negation it is.
 */
const FILLER =
  /(?:\s+(?:been|being|be|get|gets|got|yet|actually|ever|it|this|that|is|are|was|were|to|has|have|had|will|would|could|should))+\s*$/i;

/** A word immediately before the claim that stops it being an assertion. */
const HEDGE =
  /\b(not|never|no|nor|without|before|until|unless|once|when|after|if|whether|pending|awaiting|await|awaits|blocks|blocking|needs|ready|cannot)\s*$/i;

/**
 * What follows the claim when it is about merging a base branch INTO the work
 * rather than about the work being delivered. "Merged main first, then
 * allocate" is a true, useful sentence and not a delivery claim.
 */
const INTO_BRANCH = /^\s+(main|master|origin|upstream)\b/i;

/**
 * The delivery-status assertion in a generated summary, or null.
 *
 * WHY THIS IS A CLAIM RULE AND NOT A WORD BAN. Suppressing every sentence with
 * a status word in it would gut the summaries, and a summary that omits the
 * outcome of a long thread is its own failure. What is forbidden is narrow:
 * asserting, as accomplished fact, that the work MERGED / SHIPPED / LANDED /
 * DEPLOYED / RELEASED. Everything else the thread establishes — what was
 * decided, verified, disclosed, or left open — is untouched, and the model is
 * still required to say it: the nudge below asks for a REPLACEMENT, not a
 * deletion, because a rule phrased only as a prohibition is satisfied by
 * saying nothing.
 *
 * The board owns delivery status: the task's own state, `evidence.commit`, the
 * PR link. A generated line can only agree with that or contradict it, and the
 * contradiction is the expensive direction — a summary exists so nobody has to
 * open the thread, so a false "PR merged" is believed exactly where it is
 * least likely to be caught. Observed 2026-08-17 on a thread whose first reply
 * opens "PR open and CI green — not merged, task not transitioned"; re-running
 * the same prompt over the same comments reproduced it in 8 of 20 draws.
 *
 * DELIBERATELY ONE-DIRECTIONAL. A false positive costs one corrective call and
 * a rephrase; at worst the card keeps its deterministic lines, which are
 * quoted from the thread and so cannot contradict it. A false negative ships
 * the false claim. So this leans toward flagging.
 */
export function findDeliveryClaim(s: GeneratedSummary): string | null {
  return scanForDeliveryClaim(s.topic) ?? scanForDeliveryClaim(s.discussion);
}

function scanForDeliveryClaim(text: string): string | null {
  for (const m of text.matchAll(DELIVERY_WORDS)) {
    const at = m.index ?? 0;
    if (INTO_BRANCH.test(text.slice(at + m[0].length))) continue;
    const before = text.slice(0, at).replace(FILLER, '');
    if (HEDGE.test(before)) continue;
    return m[0];
  }
  return null;
}

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
  const topic = clean(o.topic);
  // A blank topic is not a summary; a blank discussion is the no-replies case.
  if (!topic) return null;
  return { topic, discussion: clean(o.discussion) };
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

/*
 * There is deliberately NO character clamp on a generated line.
 *
 * There used to be one, capping the topic at 80 chars and the discussion at
 * 120 with an appended "…". It was a second truncation point, and the wrong
 * one: the card rows are `overflow: hidden; text-overflow: ellipsis;
 * white-space: nowrap`, so the browser already ellipsizes at the REAL width
 * of the row — which is far narrower than 120 characters and varies by
 * surface and viewport. A line cut at 120 arrived pre-truncated with a
 * literal ellipsis in its stored text, and then got ellipsized again on
 * screen. Measured on the first production corpus: 3% of lines carried our
 * "…", none of which needed it more than the 18% that ran long without it.
 *
 * The card cannot grow either way — `nowrap` guarantees one row — and the
 * output is bounded by `max_tokens` on the call, so nothing here is holding
 * back an unbounded string. The word limits in the prompt are the real
 * mechanism; the browser is the backstop.
 *
 * `TOPIC_MAX` / `DISCUSSION_MAX` still bound the DETERMINISTIC lines in
 * `thread-summary.ts`, where the input is a raw comment that really can be
 * 5,000 characters of prose poured into a one-line slot.
 */

/** Words as the budget counts them: whitespace-separated tokens. */
export function wordCount(s: string): number {
  const t = s.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

/**
 * The corrective follow-up for an answer that does not fit the card, or null
 * when it does. Also the acceptance test for a retry's answer.
 *
 * Three failure modes. The first two are opposite directions of one budget;
 * the third is about TRUTH rather than length, and its caller treats it
 * differently — see `generate` in the server's summarize.ts, where an
 * over-long first answer ships as the fallback and a delivery claim never
 * does.
 *
 * OVER BUDGET. The display side stopped truncating entirely (the card wraps
 * the full line), so the word budgets in the prompt are the ONLY thing keeping
 * a card compact — and the model overruns them on ~18% of threads. One
 * follow-up naming the actual overrun gets most of those back inside the
 * limit; an answer that is still long after that ships in full, because a
 * complete 15-word line beats a chopped 12-word one ("cap where possible").
 *
 * EMPTY ON A REPLIED THREAD. A blank discussion is the legitimate no-replies
 * answer, and it costs 0 words — so it also passes any budget check. On a
 * thread that HAS replies it is not an answer at all: `threadLines` falls back
 * to the raw latest comment, i.e. exactly the verbatim-snippet card generation
 * exists to replace. Seen in production 2026-08-12 with a current hash, so it
 * persisted rather than being retried. Asking once is cheap because it only
 * fires on this rare shape.
 *
 * ASSERTS DELIVERY STATUS. The board owns whether work merged or shipped; a
 * generated guess can only agree with it or contradict it, and the
 * contradiction is believed precisely because a summary exists so nobody has
 * to open the thread. See `findDeliveryClaim` for why the rule is narrow, and
 * why the nudge asks for a substitution rather than a deletion.
 */
export function buildRetryNudge(s: GeneratedSummary, opts: { hasReplies: boolean }): string | null {
  const t = wordCount(s.topic);
  const d = wordCount(s.discussion);
  const emptyButShouldNotBe = opts.hasReplies && d === 0;
  const claim = findDeliveryClaim(s);
  if (t <= TOPIC_WORDS && d <= DISCUSSION_WORDS && !emptyButShouldNotBe && !claim) return null;
  const parts: string[] = [];
  if (t > TOPIC_WORDS) parts.push(`Your topic is ${t} words; the limit is ${TOPIC_WORDS}.`);
  if (d > DISCUSSION_WORDS)
    parts.push(`Your discussion is ${d} words; the limit is ${DISCUSSION_WORDS}.`);
  if (emptyButShouldNotBe) {
    parts.push(
      'Your discussion is empty, but this thread HAS replies. Say where the ' +
        'conversation has got to — what was decided, what is still open, or ' +
        'what is being asked.',
    );
  }
  if (claim) {
    // Phrased as a SUBSTITUTION, not a prohibition. "Do not claim the work
    // merged" is an upper bound and is satisfied by a line that says nothing
    // — the same shape as the word cap that a blank answer once satisfied.
    // So the nudge names what the replacement must CONTAIN.
    parts.push(
      `You state delivery status ("${claim}"). The card already shows delivery ` +
        "status from the board's own record — the task state, the evidence " +
        'commit, the PR link — so never assert that work merged, shipped, ' +
        'landed, was deployed, or was released. Replace that claim with what ' +
        'the thread itself establishes: what was decided, what was verified, ' +
        'what was disclosed, or what is still open. Do not simply delete the ' +
        'claim — the line must still say where the conversation has got to.',
    );
  }
  parts.push('Rewrite to fit the limits. Answer with the same JSON shape and nothing else.');
  return parts.join(' ');
}

/**
 * Is this thread worth spending a call on?
 *
 * The single place that decides, so the server never grows its own copy of the
 * judgement. A thread with no comments has nothing to summarize; a thread whose
 * stored hash still matches has already been summarized as it stands — unless
 * it was summarized under an OLDER prompt than this build carries, in which
 * case the next backfill should redo it (see `SUMMARY_PROMPT_VERSION`).
 *
 * "Older", not "different": a summary written by a newer build than this one
 * is not stale, and a rollback must not spend a call putting the old prompt's
 * answer back.
 */
export function needsCall(t: Thread, stored: StoredSummary | null | undefined): boolean {
  if (t.comments.length === 0) return false;
  if (!stored || stored.hash !== summaryHash(t)) return true;
  return (stored.promptVersion ?? 1) < SUMMARY_PROMPT_VERSION;
}
