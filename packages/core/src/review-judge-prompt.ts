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
export const REVIEW_JUDGE_PROMPT_VERSION = 3;

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
  /**
   * Every reason this same item has already been held for, oldest first.
   *
   * The judge is stateless — one call, one item, no history — and that is
   * what made the gate a wall rather than a check: an item that closed the
   * gap it was told about came back held for a different gap the judge could
   * have named the first time, round after round, until the filer gave up
   * and posted the ask as a plain comment (peer report, 2026-09-04).
   *
   * Handing the earlier reasons back is the whole fix on the judge's side.
   * It is not a licence to hold again: the instruction that goes with them
   * says the opposite — judge the words as they stand now, and a gap you did
   * not raise the first time is not a reason to hold the second.
   */
  priorHolds?: string[];
}

export interface ReviewJudgeVerdict {
  ok: boolean;
  /** One sentence naming the biggest gap (or, on `ok`, what carried it). */
  reason: string;
  /**
   * On a hold: the sentence the judge wants ADDED to the item, written out.
   *
   * A reason that names a category — "the detail lacks stakes", "no option
   * states its cost" — leaves the filer to guess what the words should be,
   * and a guess is what gets held next round. Naming the sentence turns a
   * verdict into an edit. Absent when the judge gave none, which is a hold
   * with a reason and no draft, not a refusal.
   */
  add?: string;
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
  const system: string[] = [
    'You judge whether a review item an AI agent filed for a human reader is good enough to put on that reader’s queue.',
    'Judge substance against the criteria below, not length or tone. When unsure, pass it: a held item costs the reader an answer they could have given.',
    'Reply with JSON only, on one line: {"ok": true|false, "reason": "<one sentence>", "add": "<one sentence>"}.',
    'When ok is false, the reason names the single biggest gap so the agent can fix it in one edit.',
    // A category is not an instruction. Held items came back round after
    // round because "the detail lacks stakes" left the filer guessing at the
    // words, and the guess was held for something else (2026-09-04).
    'When ok is false, "add" is the sentence you want ADDED to the item, written out in full as the item would carry it — not the name of a category and not an instruction about one. Write it in the reader’s words, ready to paste. Omit "add" only when no single sentence would close the gap.',
    // A judge that mis-states the item loses the agent a whole revision: it
    // fixes the fault it was told about and is held again for the real one.
    // Measured on the live board — an item whose detail read “see below” was
    // held for “The detail section is empty”, which is a different fault with
    // a different fix (UX review, 2026-08-29).
    'The reason must describe what the item ACTUALLY says. Never call a field empty or missing when it has content: name the words that are there and why they are not enough — a detail reading “see below” is present and says nothing, which is not the same fault as no detail at all.',
    // The same fault, one field along, and the one that produced the loop
    // this instruction was added for: an item was held eight times, and the
    // last hold asked for costs its options stated word for word. The costs
    // were in the prompt every time — proved end-to-end in
    // `review-judge-loop.test.ts` — so what was missing was this sentence.
    'An option’s detail IS its cost: the words after the dash on an option line are what choosing it costs or buys. Read them, and never say the options give no costs when their details name them — an option marked “(no cost given)” is the only one that has none.',
    '',
    'Criteria:',
    criteria.trim(),
  ];
  if (item.priorHolds && item.priorHolds.length > 0) {
    system.push(
      '',
      'You have already held this item, for the reasons listed under "Previously held for" below, and the filer has revised it since.',
      'Judge the words as they stand NOW. If those gaps are closed, say so and pass it.',
      'Do NOT hold it for a gap you did not raise the first time: a fresh reason on a revised item reads as a moving target, and the filer cannot aim at one.',
    );
  }
  const systemText = system.join('\n');
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
  if (item.priorHolds && item.priorHolds.length > 0) {
    lines.push('Previously held for:');
    for (const r of item.priorHolds) lines.push(`- ${r}`);
  }
  return { system: systemText, user: lines.join('\n') };
}

/**
 * Read the judge's reply. `null` when it is not a verdict — no JSON, no
 * boolean `ok` — which the caller treats exactly like a failed call: the
 * item passes through. A reply that half-parses must not become a hold.
 */
/**
 * One sentence as it is stored: whitespace collapsed, cut after the first
 * sentence, clipped at the ceiling. `''` for anything that is not a string
 * with words in it.
 *
 * The cut is not cosmetic. Every surface downstream builds a longer sentence
 * around this one — the hold message, the card's "Held: …", the admitted-
 * after-two-holds note — and a judge that answered with a paragraph put a
 * full stop in the middle of all of them. Asking for one sentence in the
 * prompt is not enforcement; this is.
 *
 * A terminator only ends the sentence when a SPACE or the end of the string
 * follows it, which is what keeps "v1.2" and "e.g. what is blocked" whole
 * — the common false cut, and the reason a bare `split('.')` is wrong here.
 * Text with no terminator at all is one sentence and is kept entire.
 */
function clipSentence(value: unknown): string {
  const text = (typeof value === 'string' ? value : '').trim().replace(/\s+/g, ' ');
  const first = firstSentence(text);
  return first.length > REVIEW_JUDGE_REASON_MAX
    ? `${first.slice(0, REVIEW_JUDGE_REASON_MAX - 1)}\u2026`
    : first;
}

/**
 * Abbreviations whose full stop is not a sentence end. Short list on purpose:
 * it only has to cover what a judge writing one sentence of English about a
 * review item actually types.
 */
const NOT_A_SENTENCE_END = new Set(['e.g.', 'i.e.', 'etc.', 'vs.', 'cf.', 'no.', 'fig.']);

/**
 * The first sentence of `text`, terminator included. See `clipSentence`.
 *
 * A cut needs THREE things, and each one is a false cut this function was
 * given a test for: a terminator, whitespace after it (so "v1.2" survives),
 * something that looks like the start of a new sentence after that (so
 * "e.g. what is blocked" survives), and a preceding word that is not a known
 * abbreviation (so "e.g. What is blocked" survives too). When no cut
 * qualifies, the whole string is one sentence — erring toward keeping words,
 * never toward mangling them.
 */
function firstSentence(text: string): string {
  const terminator = /[.?!\u2026]+(?=\s)/g;
  for (let m = terminator.exec(text); m !== null; m = terminator.exec(text)) {
    const cut = m.index + m[0].length;
    const rest = text.slice(cut).trimStart();
    // The terminator ends the whole string: no second sentence to drop.
    if (rest === '') return text;
    // What follows has to look like a sentence opening.
    if (!/^[A-Z0-9“"'(\[]/.test(rest)) continue;
    const word = text.slice(0, cut).split(' ').at(-1)?.toLowerCase() ?? '';
    if (NOT_A_SENTENCE_END.has(word)) continue;
    return text.slice(0, cut);
  }
  return text;
}

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
  const reason = clipSentence(rawReason);
  const add = clipSentence((parsed as { add?: unknown }).add);
  return { ok, reason, ...(add !== '' ? { add } : {}) };
}
