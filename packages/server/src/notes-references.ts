/**
 * The names a note may link: which of the board's tasks and docs this tick's
 * speech actually mentioned.
 *
 * WHY A SEARCH AND NOT A LIST. A note-taker links the ticket somebody just
 * named, and the way to do that is to know the board. But the board is
 * hundreds of rows, and handing all of them to every tick would cost more
 * prompt than the notes themselves — the compose prompt is already the
 * expensive half of a $0.84 meeting-hour. So the catalogue is assembled once
 * per meeting and SEARCHED per tick: only what was named this tick reaches
 * the prompt, with its URL, and the composer's job is to write the link
 * rather than to recognise the name.
 *
 * WHY PRECISION OVER RECALL. A link to the wrong ticket is worse than no
 * link: it is a claim, in the room's shared record, that this discussion was
 * about that work — and nobody rereading the notes can tell it was a guess.
 * A missed link costs a reader one search. So the matcher demands a
 * contiguous run of the title's own significant words, and generic
 * two-word overlaps ("meeting notes", "the board") are refused by the
 * coverage rule below rather than linked.
 *
 * The catalogue's SHAPE is the board's, not the transcript's: every entry
 * carries the URL the note will cite, so no later stage has to reconstruct
 * one from a title.
 */

/** One thing on the board a note may link to. */
export interface NoteReference {
  kind: 'task' | 'doc';
  title: string;
  /** Root-relative, like `taskCaptureUrl` and `docLookupUrl` — it survives
   *  being read under whatever host the server is reached on. */
  url: string;
  /** When this doc last carried a meeting, `YYYY-MM-DD`. Only docs have one,
   *  and only those that were meetings: dating a document would invent one. */
  when?: string;
}

/**
 * Words too common to identify anything. A title's match is judged on what
 * is left after these, so "the goal bar" is one significant word plus two
 * that every other row also has.
 */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'do',
  'for',
  'from',
  'has',
  'have',
  'how',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'so',
  'than',
  'that',
  'the',
  'their',
  'then',
  'there',
  'they',
  'this',
  'to',
  'up',
  'was',
  'we',
  'what',
  'when',
  'which',
  'who',
  'why',
  'with',
  'you',
  'your',
]);

/**
 * Text to comparable words: lowercase, punctuation gone, everything else
 * kept in order.
 *
 * Apostrophes are DROPPED rather than split on, so a transcript's "balloon's"
 * and a title's "balloons" are the same word. Digits stay: a version number
 * or a ticket number is one of the most identifying things a title has.
 */
export function referenceTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * A word reduced to the form it shares with how somebody would SAY it.
 *
 * A board writes "Export dialog forgets the chosen range" and the room says
 * "the export dialog's forgetting the chosen range" — same row, and not one
 * word of the middle matches. Plural, gerund and past tense are where written
 * titles and spoken sentences diverge almost every time, so they are folded
 * together and nothing else is.
 *
 * Deliberately crude, and safe to be: a wrong stem cannot invent a link on
 * its own, because a match still needs a RUN of stems in order and enough of
 * the title to cover it. Over-stemming costs precision at the margin;
 * under-stemming costs a link on every row whose verb was conjugated.
 */
export function stem(word: string): string {
  let out = word;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (!out.endsWith(suffix)) continue;
    const cut = out.slice(0, -suffix.length);
    if (cut.length < 3) continue;
    out = cut;
    break;
  }
  // "forgetting" − "ing" is "forgett", and the row says "forgets" → "forget".
  // English doubles the consonant before the suffix and nowhere else, so
  // collapsing a doubled final consonant rejoins the two spellings.
  if (out.length > 3 && out.at(-1) === out.at(-2) && !'aeiou'.includes(out.at(-1) ?? '')) {
    out = out.slice(0, -1);
  }
  return out;
}

/** The words of a title that could identify it, in the form they are
 *  compared in. */
function significant(tokens: readonly string[]): string[] {
  return tokens.filter((t) => !STOPWORDS.has(t)).map(stem);
}

/**
 * The longest run of `needle`'s words that appears CONTIGUOUSLY, in order,
 * inside `haystack` — measured in the needle's own significant words, with
 * the haystack's stopwords skipped over.
 *
 * Skipping stopwords in the haystack is what lets speech match a title: a
 * person says "the balloons on the goal bar" where the row reads "Balloons
 * on the goal bar", and the words between the ones that matter are exactly
 * what varies between how a thing is written and how it is said.
 */
export function longestRun(needle: readonly string[], haystack: readonly string[]): number {
  const words = significant(haystack);
  if (needle.length === 0 || words.length === 0) return 0;
  let best = 0;
  for (let start = 0; start < words.length; start++) {
    for (let from = 0; from < needle.length; from++) {
      let run = 0;
      while (
        from + run < needle.length &&
        start + run < words.length &&
        needle[from + run] === words[start + run]
      ) {
        run++;
      }
      if (run > best) best = run;
    }
  }
  return best;
}

/**
 * Enough of the title to be sure it is the title.
 *
 * TWO WORDS ARE NOT ENOUGH ON THEIR OWN. Any two rows on a board about the
 * same product share a pair — "meeting notes", "review item", "goal bar" —
 * and a matcher that linked on a pair would put a citation on half the
 * bullets in the meeting. So a run of two must also be most of what the
 * title has to say (half its significant words); a run of three or more is
 * distinctive enough by itself however long the title is.
 *
 * A ONE-WORD title matches on that word alone only when it is long enough to
 * be a name rather than a noun — a product, a person, a codename.
 */
export function namesReference(reference: NoteReference, spoken: readonly string[]): boolean {
  const title = significant(referenceTokens(reference.title));
  if (title.length === 0) return false;
  if (title.length === 1) {
    const word = title[0]!;
    // Stemmed on both sides, like every other comparison here: a one-word row
    // called "Balloons" is named by somebody saying "balloon".
    return word.length >= 8 && spoken.some((t) => stem(t) === word);
  }
  const run = longestRun(title, spoken);
  if (run >= 3) return true;
  return run === 2 && run / title.length >= 0.5;
}

/**
 * How many links one tick may carry.
 *
 * A tick is a few sentences; a tick that named six different tickets is
 * either a stand-up reading a list or a matcher misfiring, and in both cases
 * six citations in one bullet is not what a note-taker writes. The cap is on
 * the PROMPT as much as on the notes: it is what keeps this feature's cost
 * bounded by the tick rather than by the size of the board.
 */
export const MAX_TICK_REFERENCES = 4;

/**
 * The catalogue entries this tick's speech named, best first.
 *
 * "Best" is the longest run of the title's own words, so when a board holds
 * both "Goal bar" and "Goal bar remainder" and somebody said the second,
 * the second wins. Ties keep catalogue order, which is the board's.
 */
export function matchReferences(
  spokenText: string,
  catalogue: readonly NoteReference[],
  opts: { limit?: number } = {},
): NoteReference[] {
  const spoken = referenceTokens(spokenText);
  if (spoken.length === 0) return [];
  const scored: Array<{ reference: NoteReference; run: number; at: number }> = [];
  for (let at = 0; at < catalogue.length; at++) {
    const reference = catalogue[at]!;
    if (!namesReference(reference, spoken)) continue;
    scored.push({
      reference,
      run: longestRun(significant(referenceTokens(reference.title)), spoken),
      at,
    });
  }
  scored.sort((a, b) => b.run - a.run || a.at - b.at);
  return scored.slice(0, opts.limit ?? MAX_TICK_REFERENCES).map((s) => s.reference);
}

/**
 * `YYYY-MM-DD` for a doc that carried a meeting — the same spelling
 * `lookupWhen` produces, because the two end up side by side in the notes and
 * a reader should not be able to tell which stage wrote which.
 */
export function referenceDate(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
