import { type Comment, type ReviewPayload, type Thread, pendingDeclaration } from '@feedback/core';

/**
 * Which comment threads have outgrown the balloon column.
 *
 * The margin is 300px wide. That is the right size for the comment it was
 * designed around — a sentence or two beside the line it points at — and the
 * wrong size for the two things that keep landing in it instead: a long
 * exchange, and a declared DECISION, whose card carries a kind chip, a
 * headline, a markdown body and a stack of option buttons. Both were already
 * being fought with a viewport clamp (`.lf-balloon-comment.expanded` caps its
 * height and scrolls inside itself), which keeps the card on screen but does
 * not give the words anywhere to go: an 80-character measure wrapped into a
 * 300px column is roughly six words a line.
 *
 * So above a threshold the thread stops expanding in place and opens in a wide
 * modal instead. The rules are deliberately two, not one:
 *
 * - **Length.** More than `LONG_THREAD_WORDS` of actual conversation.
 * - **A decision, at any length.** The options are buttons, and a button
 *   holding a 1–3 word label plus up to 50 words of detail cannot be read in a
 *   column narrower than the label. Length would not have caught it — a
 *   decision is often the SHORTEST thread on the doc.
 *
 * Pure and DOM-free on purpose: which threads promote is a rule, and the
 * viewport question ("is the modal the right treatment here at all") belongs to
 * the caller, which is the only thing that knows whether the mobile sheet is
 * already the surface.
 */

/**
 * The length above which a thread opens in the modal rather than in the
 * column. "~100 words" as specified; the comparison is strictly greater, so a
 * thread sitting exactly on it still expands in place.
 */
export const LONG_THREAD_WORDS = 100;

/** Words in a chunk of prose. Whitespace-separated, runs collapsed. */
function countWords(text: string | undefined): number {
  if (!text) return 0;
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Every word a declaration puts on the card.
 *
 * All of `why` / `lookFor` / `detail`, because `reviewItemBodyMarkdown` joins
 * all three into the one body the card renders — and the option labels and
 * their detail, because those are the rows that actually make a decision card
 * tall. `answerText` counts too: once answered, the record is part of what a
 * reader opens the thread to read.
 */
function reviewWords(review: ReviewPayload): number {
  let n =
    countWords(review.headline) +
    countWords(review.why) +
    countWords(review.lookFor) +
    countWords(review.detail) +
    countWords(review.answerText);
  for (const o of review.options ?? []) n += countWords(o.label) + countWords(o.detail);
  return n;
}

/**
 * How much there is to read in this thread, counting what the OPENED card
 * shows — every comment plus every declaration's prose.
 *
 * Not the generated summary: that is a condensation of words already counted
 * here, and it is what the card shows while FOLDED. Counting it would make a
 * thread's treatment change when a summary landed, which is a background
 * event the reader never asked for.
 */
export function threadWordCount(t: Thread): number {
  let n = 0;
  for (const c of t.comments ?? []) {
    n += countWords(c.text);
    if (c.review) n += reviewWords(c.review);
  }
  return n;
}

/** What the thread's decision, if it has one, is waiting for. */
export type ThreadDecisionState = 'none' | 'pending' | 'answered';

/**
 * Does this thread carry a decision, and is anyone still owed an answer?
 *
 * "Pending" is `pendingDeclaration`'s judgment and nothing looser — the one
 * rule the server's queue and the doc panel's reply box already share. Reading
 * it any other way would let the card say "decision needed" over an item no
 * queue is showing, which is the exact drift `pendingDeclaration` exists to
 * prevent.
 *
 * "Answered" therefore covers both of the ways an ask retires: somebody
 * answered it, and the thread was resolved with it still open. Both are
 * records rather than requests, and neither should be flagged as outstanding.
 */
export function threadDecision(t: Thread): ThreadDecisionState {
  const pending = pendingDeclaration<Comment>(t);
  if (pending?.review?.shape === 'decision') return 'pending';
  return (t.comments ?? []).some((c) => c.review?.shape === 'decision') ? 'answered' : 'none';
}

/**
 * Hard cap on the outcome the folded card quotes. CSS ellipsizes at the real
 * width, which is far narrower; this only stops a 5,000-character answer being
 * poured into the DOM for a one-line slot. Same reasoning, and roughly the
 * same size, as `DISCUSSION_MAX` in core's summary.
 */
export const OUTCOME_MAX = 120;

/**
 * What was decided, for a thread whose decision has been answered — `null`
 * when there is no decision, when one is still outstanding, or when the thread
 * was resolved with the ask still open (a record with no answer in it).
 *
 * The `answerText ?? tapped option's label` fallback is the same one the
 * answered record inside the card uses: an answer tapped before `answerText`
 * existed recorded only the option id, and that option's label is the verbatim
 * words it meant.
 */
export function decisionOutcome(t: Thread): string | null {
  if (threadDecision(t) !== 'answered') return null;
  // The LATEST answered decision. A thread can carry more than one, and the
  // newest is the one that is still true.
  const answered = (t.comments ?? []).filter(
    (c) => c.review?.shape === 'decision' && c.review.answeredAt !== undefined,
  );
  const review = answered[answered.length - 1]?.review;
  if (!review) return null;
  const text =
    review.answerText ?? review.options?.find((o) => o.id === review.answeredWith)?.label ?? '';
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return null;
  return one.length > OUTCOME_MAX ? `${one.slice(0, OUTCOME_MAX - 1)}…` : one;
}

/**
 * Should opening this thread open the modal instead of expanding the card?
 *
 * The caller still decides whether a modal is the right treatment for the
 * viewport it is on — below 1100px the answer is always no, because the
 * comment already opens as a full-width inline card with the sheet behind it.
 */
export function threadNeedsModal(t: Thread): boolean {
  return threadDecision(t) !== 'none' || threadWordCount(t) > LONG_THREAD_WORDS;
}
