/**
 * How a workspace's north-star goal is DISPLAYED.
 *
 * The goal is a paragraph or three of prose — the thing every triage decision
 * is judged against — and it is rendered in the board's goal strip, in every
 * task's "Triaged against" row, and anywhere else a surface names what the
 * work is for. At full length it is the single largest thing on the board: on
 * a 430px phone the goal card alone measured 517px tall and pushed the first
 * task row 1018px down the page.
 *
 * So surfaces show a summary of ≤20 words and keep the full text one tap away.
 *
 * The one rule this module exists to enforce: **the displayed summary can
 * never say something the goal doesn't.** Two consequences, both deliberate:
 *
 * 1. The floor is a DETERMINISTIC clip of the goal's own opening words. It
 *    needs no network, no API key, and no attached agent — a board renders
 *    its goal correctly on a laptop with the wifi off. Nothing here calls a
 *    model, and nothing here can fail.
 * 2. A stored summary — written by a person editing the goal, or by an agent
 *    that compressed it — WINS when it is present, but only while it still
 *    describes the current goal. It carries the hash of the goal text it was
 *    written against; the moment the goal changes, the hash stops matching
 *    and every surface falls back to the clip. A summary describing a
 *    replaced goal is exactly the misrepresentation the ≤20 words are there
 *    to avoid, and the fallback is one-directional: it can only ever show
 *    MORE of the goal's own words, never fewer and never someone else's.
 */

/** The budget from the task: a goal displays in twenty words or fewer. */
export const GOAL_SUMMARY_MAX_WORDS = 20;

/**
 * A short summary somebody wrote down for a specific goal text.
 *
 * `goalHash` is not bookkeeping — it is the whole safety story. Without it a
 * summary outlives the sentence it summarized, silently.
 */
export interface StoredGoalSummary {
  /** The ≤20-word line. Empty/whitespace counts as absent, never as a
   *  compliant answer — an empty summary trivially satisfies a word budget
   *  while telling the reader nothing. */
  text: string;
  /** `goalTextHash` of the goal this line was written against. */
  goalHash: string;
  ts: number;
}

export type GoalDisplaySource = 'stored' | 'clip' | 'empty';

export interface GoalDisplay {
  /** What the surface renders inline. ≤20 words, always. */
  summary: string;
  /** The goal verbatim, for the expanded view (still markdown). */
  full: string;
  /** Is there more to see? Drives the expand affordance — false means the
   *  summary IS the goal and a "show more" control would reveal nothing. */
  truncated: boolean;
  source: GoalDisplaySource;
}

/** Words as a reader counts them. */
export function wordCount(s: string): number {
  const t = s.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

/**
 * Markdown source → the text a reader sees, on one line.
 *
 * The goal strip renders markdown; a clip is plain text in a `textContent`,
 * so leaving the syntax in would put `**` and `](http://…` on the most-viewed
 * line of the board.
 */
function toPlainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]{0,3}(?:[-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first sentence of `plain`, or null when it has no terminator. */
function firstSentence(plain: string): string | null {
  const m = plain.match(/^.*?[.!?](?=\s|$)/);
  return m ? m[0] : null;
}

/**
 * A ≤`maxWords` clip of the goal's OWN opening words — nothing invented,
 * nothing reordered, no model involved.
 *
 * Prefers a sentence boundary when the first sentence fits, because a clip
 * that ends where the author ended reads like a sentence rather than a
 * truncation. Falls back to the word budget, and only then adds an ellipsis:
 * a mid-sentence cut needs the mark, a full sentence does not — and the
 * expand affordance is what actually says "there is more".
 */
export function clipGoal(goal: string, maxWords = GOAL_SUMMARY_MAX_WORDS): string {
  const plain = toPlainText(goal);
  if (plain === '') return '';
  if (wordCount(plain) <= maxWords) return plain;

  const sentence = firstSentence(plain);
  if (sentence && wordCount(sentence) <= maxWords && sentence.length < plain.length) {
    return sentence;
  }
  const clipped = plain.split(/\s+/).slice(0, maxWords).join(' ');
  return `${clipped.replace(/[.,;:]+$/, '')}…`;
}

/**
 * FNV-1a over the goal text — the same cheap, stable digest the thread
 * summaries key on. Only ever compared for equality; nothing depends on it
 * being cryptographic.
 */
export function goalTextHash(goal: string): string {
  const input = goal.trim().normalize('NFC');
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * What a surface should show for this goal right now.
 *
 * Every caller renders `summary` and, when `truncated`, offers a control that
 * reveals `full`. No caller decides for itself whether a stored summary is
 * usable — that judgement lives here, once.
 */
export function goalDisplay(goal: string, storedSummary?: StoredGoalSummary): GoalDisplay {
  const plain = toPlainText(goal);
  if (plain === '') return { summary: '', full: goal, truncated: false, source: 'empty' };

  const clip = clipGoal(goal);
  const storedText = storedSummary?.text?.trim() ?? '';
  const usable = storedText !== '' && storedSummary?.goalHash === goalTextHash(goal);
  if (!usable) return { summary: clip, full: goal, truncated: clip !== plain, source: 'clip' };

  // A stored line is still held to the budget. Whoever wrote it — a person in
  // a hurry, a model that ignored the instruction — does not get to make the
  // board's most-viewed line arbitrarily long.
  const summary =
    wordCount(storedText) <= GOAL_SUMMARY_MAX_WORDS
      ? storedText
      : clipGoal(storedText, GOAL_SUMMARY_MAX_WORDS);
  return { summary, full: goal, truncated: summary !== plain, source: 'stored' };
}
