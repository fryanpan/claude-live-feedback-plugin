/**
 * Is this comment ASKING a person something, and if so, which words are the
 * question?
 *
 * Split out of `review-queue.ts` (A6), which is about ordering rows. This is
 * a pure text predicate with no queue concept in it: strings in, a span out.
 *
 * The detector and the extractor share ONE address pattern, and that is the
 * whole reason they live in one file. They were two hand-written regexes once
 * and immediately drifted — the extractor's copy had dropped the newline
 * branch, so a comment the detector accepted fell back to clipping from
 * character zero and cut off the very question the row existed to surface.
 * `extractAsk` calls `findAsk`; there is no second matcher to keep in step,
 * and adding one would re-open that bug.
 *
 * The measurements behind the rule — a question mark AND a direct address,
 * over all 86 agent comments on this project's board — are in `asksPerson`'s
 * note below, along with the recall it knowingly trades away.
 */

/** How much of the question rides along to the strip. Enough to recognise the
 *  ask; the thread itself is one tap away. */
const ASK_MAX = 200;

/**
 * A comment that names a person and asks them something gets more room, because
 * for this one the strip is not a label — it is the question. The board's own
 * fixture asks "(a) report … (b) refuse … or (c) auto-file …?" in 330
 * characters, and a 200-char clip cuts it mid-option, which relocates the
 * reading problem instead of solving it: the whole value of a decision on a
 * strip is that it is answerable without opening anything.
 */
const DIRECT_ASK_MAX = 420;

/**
 * Does this text ask one of `people` something — as opposed to thinking out
 * loud, which is what most agent prose containing a "?" is doing.
 *
 * The rule is a question mark AND a direct address: the person's name at the
 * start of a line or an emphasis run, followed by the punctuation an address
 * takes. Both halves are load-bearing, and both were measured over all 86 agent
 * comments on this project's board rather than reasoned about:
 *
 * - `?` alone fires on **19 of 86**. The sample is URL query strings
 *   (`…/workspaces/w-…?t=`), code (`` `in listUntriaged?` ``), optional
 *   chaining (`anchor.snippet?.`), section headings, and quoted UI copy. This
 *   is the "agent comments are full of rhetorical questions" the board's own
 *   task warned about, and it is why a bare interrogative rule is unusable.
 * - Address alone fires on 2 of 86.
 * - Both together fire on **1 of 86** — exactly the comment the fixture task
 *   names, and nothing else.
 *
 * **False negatives, measured: 2 of 3 real questions.** "when a person creates
 * a task from the board, who should own it by default?" and "Want a follow-up
 * PR that's purely typography?" are genuine asks that never name a person, and
 * this rule misses both. Since 2026-08-21 that miss costs the ROW — this
 * matcher is the inferred band's membership test, so a question it cannot see
 * does not surface at all. That trade was chosen with eyes open (an agent's
 * reply is not an ask): under the old rule those questions surfaced only as
 * two rows in a 60-row pile of status notes, which is not surfacing in any
 * sense that matters, and an agent that needs certainty has the declared path
 * — attach a Review Item and membership stops depending on prose at all. The
 * cost of the opposite failure is the thing the board cannot afford: a strip
 * padded with non-decisions is a strip nobody reads, and once nobody reads it
 * every real decision on it is lost too.
 *
 * `people` is who has actually spoken as a person in this workspace. A
 * workspace where nobody has yet answers no to everything — and since this
 * matcher became the inferred band's membership test, that means an empty
 * roster empties the inferred band entirely: no inferred row exists until a
 * person first speaks. Matching is exact and case-sensitive on the stored
 * name, so a short form ("Bryan" for a roster's "Bryan Chan") or a lowercase
 * address misses too, and the miss now costs the row rather than a label.
 * Both are accepted the same way the 2-of-3 recall trade above was: the
 * declared path does not depend on the roster or on prose, and it is the
 * escape hatch an agent uses when the ask must surface.
 */
export function asksPerson(text: string, people: Iterable<string>): boolean {
  return findAsk(text, people) !== null;
}

/**
 * Where the ask starts and where its question ends, or null if this is not one.
 *
 * ONE matcher, because the detector and the extractor have to agree about which
 * span they are talking about. Two hand-written regexes that must stay in step
 * is a bug generator, and it produced one immediately: the extractor's copy had
 * dropped the newline branch, so a comment the detector accepted could fall
 * back to clipping from character zero and cut the question off — the exact
 * failure this change exists to fix, one layer down.
 *
 * Three conditions, all necessary. The measurements behind them are in
 * `asksPerson`'s note above.
 *  1. A direct ADDRESS: the name at a line start or just inside an emphasis
 *     run, then the punctuation an address takes. The small leading allowance
 *     admits "**Bryan —**" and "OK Bryan:" while still refusing a name buried
 *     mid-sentence ("which is Bryan's call"), which is the distinction the
 *     whole rule turns on.
 *  2. The question comes AFTER the address and in the same paragraph. Asking
 *     merely that a "?" exist somewhere in the comment let a status note that
 *     happens to link `…/board?tab=open` be announced as a question.
 *  3. It is a SENTENCE-ending "?" — followed by whitespace or the end of the
 *     text. This is what separates a question from a URL query string,
 *     `anchor.snippet?.text`, and a "?" inside quoted or fenced copy, which is
 *     what nearly every false positive in the corpus turned out to be.
 */
export function findAsk(
  text: string,
  people: Iterable<string>,
): { index: number; end: number } | null {
  const src = normalizeForAsk(text);
  // Nothing without a "?" can be a question, and this is the common case by a
  // wide margin. It also bounds the cost below: the paragraph index and the
  // per-match scanning only ever run on text that could still qualify.
  if (!src.includes('?')) return null;
  // Every paragraph break, computed ONCE. Doing `indexOf('\n\n', m.index)` per
  // match re-scans to the end of the text on every miss, which is quadratic in
  // comment length — measured at 49ms for a 188KB comment, on a path that runs
  // per person, per comment, on every strip refresh.
  const breaks: number[] = [];
  for (let i = src.indexOf('\n\n'); i >= 0; i = src.indexOf('\n\n', i + 1)) breaks.push(i);

  // An address inside `inline code` is a quoted example, not this comment
  // addressing anybody — and anchoring on one drags the quoted run into the
  // extracted ask, which is how the strip ends up showing a row of fragments.
  const code = codeSpans(src);
  for (const name of people) {
    if (name.trim() === '') continue;
    const re = new RegExp(`(?:^|\\n|\\*\\*)[^\\n]{0,12}?\\b${escapeRe(name)}\\b\\s*[—:,-]`, 'g');
    for (let m = re.exec(src); m !== null; m = re.exec(src)) {
      // Where the NAME is, not where the match starts. The match may begin at
      // a line start well outside the code span that quotes the address —
      // testing `m.index` let `Fixture: \`Jordan: ship now?\` — worth it?`
      // anchor on the quoted address and count a later prose "?" as its own.
      const nameAt = m.index + m[0].indexOf(name);
      if (code.some(([a, b]) => nameAt >= a && nameAt < b)) continue;
      // The paragraph the address opens; a "?" past a blank line belongs to
      // something else that happens to be further down the same comment.
      const para = breaks.find((b) => b > m.index) ?? -1;
      const scope = para >= 0 ? src.slice(m.index, para) : src.slice(m.index);
      const q = sentenceQuestion(scope);
      if (q >= 0) return { index: m.index, end: m.index + q + 1 };
    }
  }
  return null;
}

/**
 * CRLF folded to LF, because every anchor in this matcher is newline-shaped.
 * A `\r\n\r\n` paragraph break does not match `\n\n`, so on CRLF text the
 * paragraph scope ran to the end of the comment and a question two paragraphs
 * below an unrelated address counted as that address's own — precisely the
 * false positive the paragraph rule exists to prevent.
 *
 * Idempotent, so `findAsk` and `extractAsk` can both apply it and still agree
 * about what an index means.
 */
function normalizeForAsk(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n/g, '\n') : text;
}

/**
 * Index of the last character of the first sentence-ending "?" in `s`, or -1.
 *
 * "Sentence-ending" means the "?" is followed by whitespace or the end of the
 * text — which is what separates prose from a query string (`?tab=open`) and
 * from optional chaining (`snippet?.text`). But markdown routinely puts a
 * CLOSING marker in between: `**Bryan — ship now?**`, `"…now?"`, `(or later?)`,
 * `` `foo?` ``. Requiring whitespace immediately after the "?" rejected 7 of 9
 * realistic endings, including the bold form these comments almost always use
 * — so an agent's bolded question fell back to a clip of the report above it.
 * Closers are skipped before the test, never instead of it: `?tab=open` and
 * `snippet?.text` are still rejected, because `t` and `.` are not closers.
 */
const ASK_CLOSERS = new Set(['*', '`', '"', "'", '_', ')', ']', '}', '”', '’']);
function sentenceQuestion(s: string): number {
  const code = codeSpans(s);
  for (let i = s.indexOf('?'); i >= 0; i = s.indexOf('?', i + 1)) {
    // A "?" inside `inline code` is quoted copy, not this comment's question.
    // Allowing closers re-admitted that class: measured on the live board it
    // matched a comment quoting example questions back, and the extracted ask
    // rendered as a run of fragments. One-directional, like the rest of this
    // rule — it can only decline to promote.
    if (code.some(([a, b]) => i >= a && i < b)) continue;
    let j = i + 1;
    while (j < s.length && ASK_CLOSERS.has(s[j] as string)) j += 1;
    const next = s[j];
    if (next === undefined || /\s/.test(next)) return j - 1;
  }
  return -1;
}

/** `[start, end)` of every inline code span, by backtick runs. */
function codeSpans(s: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let open = -1;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '`') continue;
    let n = i;
    while (n < s.length && s[n] === '`') n += 1;
    if (open < 0) open = n;
    else {
      spans.push([open, i]);
      open = -1;
    }
    i = n - 1;
  }
  return spans;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clip(text: string, max = ASK_MAX): string {
  const flat = stripEmphasis(text.replace(/\s+/g, ' ').trim());
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The strip renders this as `textContent`, so `**` arrives as two asterisks.
 * Agent comments here are written in markdown and almost always open with a
 * bold sentence, which is why the un-stripped line reads `**PR #169 is open…`.
 * Extracting mid-emphasis also leaves an unmatched marker, so a slice cannot
 * simply be trusted to be balanced.
 */
function stripEmphasis(text: string): string {
  return text.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

/**
 * The question, not the paragraph it arrived in.
 *
 * A direct ask is typically the LAST thing in a long comment — the agent
 * reports what it built, then asks. Clipping from character zero therefore
 * shows the report and cuts before the question, which is the failure this
 * whole change is about wearing a different hat. So for a direct ask the clip
 * starts at the address itself and runs to the end of the sentence that carries
 * the "?", which is where the options were written.
 */
export function extractAsk(text: string, people: Iterable<string>): string {
  // Sliced from the ORIGINAL text, before whitespace is flattened, because the
  // match is anchored on line starts. Flattening first destroys the newlines
  // the anchor is made of, which is how the previous copy of this regex
  // silently stopped finding one of the three forms it claimed to accept.
  const src = normalizeForAsk(text);
  const at = findAsk(src, people);
  return clip(at ? src.slice(at.index, at.end) : src, DIRECT_ASK_MAX);
}
