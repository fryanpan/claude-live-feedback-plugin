/**
 * What is waiting on a PERSON, across every surface a workspace has.
 *
 * The board's decisions strip answers a narrower question — open decision
 * tasks — and everything else that genuinely needs Bryan has been invisible
 * from the board: an agent's question on a task discussion, a doc comment
 * nobody answered. Those are one act ("someone needs you") wearing three
 * surfaces, and splitting them across three places to look is what makes
 * coming back to the board mean scrolling a chat history instead.
 *
 * This module computes the rows: the two thread-shaped kinds, and — since a
 * ticket HAS review items rather than IS one — the rows hanging on tickets.
 * `reviewItemRows` is the whole queue in one order. The client's `reviewQueue`
 * (hub-model) still owns the PRIORITY rule that ranks a row against the board's
 * own task rows, which is what keeps that judgement in one pure, testable place
 * instead of split across the wire.
 *
 * The server owns this half for one reason: "is this comment an agent's" is
 * `classifyActor`'s judgement, and it must not be re-decided here. A second
 * notion of who counts as an agent is exactly the drift this codebase has
 * already been bitten by.
 */
import type {
  Comment,
  ReviewItemState,
  ReviewPayload,
  TaskReviewItem,
  Thread,
} from '@feedback/core';
import {
  decodeEntities,
  isReviewItemGated,
  latestThreadedQuestion,
  pendingDeclaration,
  reviewItemState,
  reviewPayloadRevision,
  reviewWithdrawn,
} from '@feedback/core';
import { classifyActor } from './activity.ts';

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
 * Which of the two lists this row belongs to.
 *
 * - `declared` — an agent attached a Review Item and said "this needs you".
 *   Everything here is something only a person can answer, because somebody
 *   had to write a headline to put it here.
 * - `unreplied` — an INFERRED ask: an open thread where an agent's unanswered
 *   comment directly asks a person something (`findAsk` found the question).
 *
 * This band used to be the old membership rule kept whole — every open thread
 * whose newest comment was an agent's — under a safety argument that "nothing
 * that surfaces today stops surfacing". Bryan reversed that argument
 * (2026-08-21): replying created a row and only resolving drained it, so the
 * safety net WAS the queue — 60 of its 61 rows were status notes nobody was
 * being asked to act on, and the real asks drowned. A row is an ask, not a
 * reply. Status notes emit nothing; the drain is automatic, because a
 * person's reply ends the unanswered run and an answer (or resolve) retires a
 * declaration — no agent has to remember to clean up after itself.
 */
export type ReviewBand = 'declared' | 'unreplied';

export interface ReviewThreadItem {
  /**
   * Which container the thread hangs on.
   *
   * `goal-thread` is its own kind rather than a `task-thread` carrying a goal
   * id, because the two are opened differently — a task row opens the task
   * panel, a goal row opens the goal panel — and a client that cannot tell
   * them apart takes the reader nowhere. An OLD bundle that has never heard
   * of this kind falls through to its doc branch and opens
   * `/review/task:<goalId>`, which is the goal's real body room in the full
   * editor: a narrower landing than the panel, and a working one. Spelling it
   * `task-thread` instead would have handed those bundles a taskId that
   * resolves to no task, which is a click that silently does nothing.
   */
  kind: 'task-thread' | 'goal-thread' | 'doc-thread';
  band: ReviewBand;
  docId: string;
  threadId: string;
  /** The comment this row is about: the declaration if there is one, else the
   *  comment being quoted. Needed to stamp an answer back onto the item. */
  commentId: string;
  /** The declaration itself, present exactly when `band === 'declared'`. */
  review?: ReviewPayload;
  /** Present on a task discussion, and on a goal's — the board opens the ROW,
   *  not the doc, and `kind` says which panel that is. */
  taskId?: string;
  /** What the reader is being asked ABOUT: the task title, or the doc's label. */
  title: string;
  /** The question itself, clipped. The comment in the unanswered run that
   *  ASKS the reader something if there is one, else that run's newest. */
  ask: string;
  askedBy: string;
  /**
   * When the WAITING started — the first comment of the unanswered run, not
   * its newest.
   *
   * The band sorts oldest-first precisely so the thing at most risk of never
   * being answered comes up first. Reading the newest comment's timestamp
   * defeats that: every follow-up an agent posts on its own thread resets its
   * own clock and sinks its own unanswered question. Measured on this
   * project's board the day this changed, 20 of 42 open awaiting-a-person
   * threads were understating their wait, the two worst by 62.7h and 60.1h —
   * both had been waiting two and a half days and both sorted as if fresh.
   */
  since: number;
  /**
   * This row carries a question addressed to a person — an answer is being
   * waited on, not a status note read.
   *
   * True by construction since 2026-08-21: a declared row is direct because
   * somebody authored it, and an inferred row exists only because `findAsk`
   * found a direct question. The field stays on the wire because older
   * clients read it to rank and label. See `asksPerson` for the matcher and
   * for what it is measured to miss.
   */
  direct: boolean;
  /**
   * When the QUESTION was asked, present only when `direct`.
   *
   * Distinct from `since` on purpose, and the distinction is a truthfulness
   * one. `since` is the start of the whole unanswered run, which is the right
   * thing to RANK by; but an agent that posts status for three days and only
   * then asks has a run starting three days ago and a question twelve minutes
   * old. Attributing `since` to the asker made the row say "asked you 3 days
   * ago" about a question nobody had yet had a chance to see.
   */
  askedAt?: number;
  /**
   * On a DECLARED row whose words have been corrected: when, and which span
   * of the new detail changed.
   *
   * Same two fields the ticket row carries, read off the payload's own
   * `revisions` rather than a wrapper's — a doc-thread item has no wrapper.
   * They exist so the reader can tell a CORRECTION from a fresh ask. Without
   * them the only way to correct a doc-thread item was to raise a second one,
   * and the queue then showed two rows about one question with no way to see
   * which was which; showing the revision unmarked would keep that confusion
   * while removing the duplicate, which is half a fix.
   *
   * No `question` twin here: a ticket item records the reader's anchored
   * question in `infoRequests`, and a doc-thread item has no such record —
   * the conversation IS the thread this row already points at.
   */
  revisedAt?: number;
  revisedRange?: { start: number; end: number };
}

/**
 * One review item hanging on a TICKET rather than on a comment.
 *
 * Same band, same fields, same meaning as a declared thread row — the point of
 * the entity is that there is one spelling of "somebody needs you" — and it
 * differs only in what an answer is written against: a thread row addresses
 * `docId`/`threadId`/`commentId`, this one addresses `taskId`/`reviewItemId`.
 *
 * `band` is `declared` and `direct` is true by construction. Nothing infers a
 * ticket review item out of prose; somebody wrote a headline to put it here,
 * which is exactly what the declared band means.
 */
export interface ReviewTaskItem {
  kind: 'task-review';
  band: 'declared';
  taskId: string;
  /** Which row on the ticket — an answer is stamped back at this id. */
  reviewItemId: string;
  review: ReviewPayload;
  /** What the reader is being asked about: the TICKET's title. The question
   *  itself is `ask`, which is the item's own headline. */
  title: string;
  ask: string;
  askedBy: string;
  since: number;
  direct: true;
  askedAt: number;
  /**
   * `open` or `revised` — never `waiting`, which is exactly the state this
   * list omits: the reader asked on the item and it is the owner's turn. See
   * `reviewItemState`.
   */
  state: Exclude<ReviewItemState, 'waiting' | 'answered'>;
  /** On a revised row: when, what the reader had asked (the anchored
   *  thread's first comment), where that thread is, and which span of the
   *  new detail changed — everything the card needs to show "Revised". */
  revisedAt?: number;
  question?: string;
  threadId?: string;
  revisedRange?: { start: number; end: number };
}

/** A row of the queue, whatever it hangs on. */
export type ReviewItemRow = ReviewThreadItem | ReviewTaskItem;

export interface ReviewTaskRef {
  id: string;
  title: string;
  bodyDocId: string;
  /** A finished task's discussion is not a queue item — answering it changes
   *  nothing, and the board's problem is too much competing for attention. */
  done?: boolean;
  /**
   * The ticket's review items, 0..n, as the store reads them back — INCLUDING
   * the row derived from a legacy `needs: 'decision'` task.
   *
   * Passed in rather than read here on purpose: which rows a ticket has (and
   * whether a legacy decision derives one) is the store's rule, and a second
   * copy of it in the queue would be free to disagree about what is open.
   */
  reviews?: TaskReviewItem[];
}

export interface ReviewDocRef {
  docId: string;
  title: string;
}

export interface ThreadSource {
  /** A doc's threads, or `[]` when its room isn't loaded. A room that has
   *  never been opened has no threads either way, so absence and emptiness
   *  are the same answer here. */
  threadsOf(docId: string): Thread[];
  /**
   * A doc's threads REGARDLESS of status, for working out who the people are.
   *
   * Separate from `threadsOf` because the caller filters that one to open
   * threads — correct for "what is waiting", wrong for "who is a person here".
   * With one source, resolving an unrelated thread on a different task removed
   * its author from the roster and silently flipped a live question from "asked
   * you" back to "posted". Falls back to `threadsOf` so an existing caller
   * keeps working; the fallback narrows the roster, it cannot widen it.
   */
  allThreadsOf?(docId: string): Thread[];
}

/**
 * The comment that is waiting for a person, or null if none is.
 *
 * "The newest word is an agent's" is the signal, and a person speaking is the
 * ONLY thing that clears it — there is no dismissed flag, because a second
 * piece of state saying "handled" would immediately disagree with the first.
 *
 * It over-includes by design: an agent's closing note with nothing to answer
 * still reads as waiting. That over-inclusion is why this predicate no longer
 * decides queue membership (see `ReviewBand`) — and with that gone, nothing
 * in production calls it: the queue reads `unansweredRun` directly, and the
 * reply-reopen rule has its own person predicate in `task-owner.ts`. It stays
 * exported as the one-line, test-pinned statement of the wait signal itself.
 */
export function awaitingPerson(thread: Thread): Comment | null {
  const run = unansweredRun(thread);
  return run.length === 0 ? null : run[run.length - 1];
}

/**
 * Every comment since a person last spoke, oldest first — the whole stretch of
 * the conversation that is waiting, rather than only its last line.
 *
 * Non-empty if and only if the newest comment is an agent's — exactly
 * `awaitingPerson`'s test, and the function is unchanged.
 *
 * What the run DECIDES has narrowed twice since it was written. First a
 * declared item became admissible past the run's end (`pendingDeclaration`),
 * so the queue could hold a question a person had already spoken under. Then
 * (2026-08-21) the run stopped being a membership test at all: a non-empty
 * run no longer puts a thread on the queue unless it contains a direct ask.
 * The run still picks which comment an inferred row quotes and which
 * timestamp is the wait's start, and it still backs `awaitingPerson` — which
 * has no production callers left of its own.
 */
export function unansweredRun(thread: Thread): Comment[] {
  if (thread.status !== 'open') return [];
  // By time, not by array position. Comment order in the Yjs array is
  // insertion order, and a CRDT merges concurrent inserts by position rather
  // than by clock — so "the last element" answers a question about array
  // layout, not about who spoke last. Ties keep the later element.
  const byTime = [...(thread.comments ?? [])].sort((a, b) => a.ts - b.ts);
  const run: Comment[] = [];
  for (let i = byTime.length - 1; i >= 0; i -= 1) {
    const c = byTime[i];
    if (classifyActor(c.author) !== 'agent') break;
    run.unshift(c);
  }
  return run;
}

/**
 * "Which declaration is pending" — `pendingDeclaration` — now lives in
 * `@feedback/core` (re-exported below), because the doc panel needs the SAME
 * answer this queue gives: for one release the browser kept its own copy of
 * the rule (raw array order, buried asks resurrected, thread status ignored)
 * and could offer an Answer composer for an item this queue had retired.
 * One copy, imported by both halves, is what stops that drifting back.
 *
 * The rule's own rationale — newest declaration wins, ts order not array
 * order, resolved threads retire their asks — is documented on the function
 * in core. What stays HERE is the half about this queue: the widening past
 * `unansweredRun` (a declared ask survives "one sec, reading it") is
 * deliberately NOT extended to the inferred band. A thread whose newest
 * comment is a status note has no author's claim that anything is being
 * asked, and adjacency is the only signal there is; keeping those past a
 * person's reply would put every finished conversation on the board back on
 * the strip, which is the failure the declared band exists to undo.
 */
export { pendingDeclaration };

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

/**
 * Row TITLES are plain text by the time they leave this module — `ask` is
 * deliberately untouched, being comment prose where a literal `&amp;` (say,
 * inside a code span) is the author's content.
 *
 * The decoder itself lives in `@feedback/core` because this is not the only
 * door a title leaves by: the BOARD's titles reach the browser through
 * `projectTask`, and the browser assembles its own review rows for decision
 * tasks straight off those. One implementation, applied at each door exactly
 * once — decoding twice would collapse a caller's deliberate `&amp;amp;`.
 */

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
function extractAsk(text: string, people: Iterable<string>): string {
  // Sliced from the ORIGINAL text, before whitespace is flattened, because the
  // match is anchored on line starts. Flattening first destroys the newlines
  // the anchor is made of, which is how the previous copy of this regex
  // silently stopped finding one of the three forms it claimed to accept.
  const src = normalizeForAsk(text);
  const at = findAsk(src, people);
  return clip(at ? src.slice(at.index, at.end) : src, DIRECT_ASK_MAX);
}

/**
 * Every open thread across a workspace's tasks and docs that is ASKING a
 * person something — a pending declaration, or an unanswered agent comment
 * with a direct question in it — oldest first: the thing that has been
 * waiting longest is the one most at risk of never being answered at all.
 *
 * A thread whose unanswered run asks nothing is a status note and emits no
 * row (Bryan, 2026-08-21 — see `ReviewBand`).
 */
export function reviewThreadItems(args: {
  tasks: ReviewTaskRef[];
  /**
   * The board's goal rows, whose discussions queue exactly like a task's.
   *
   * Optional so every existing caller keeps compiling and keeps its current
   * output: a caller that passes no goals produces the identical list it
   * produced before. A goal declared done is skipped by the same rule a done
   * task is — answering a finished band's question changes nothing.
   */
  goals?: ReviewTaskRef[];
  docs: ReviewDocRef[];
  source: ThreadSource;
}): ReviewThreadItem[] {
  const goals = args.goals ?? [];
  const docIds = [
    ...args.tasks.filter((t) => !t.done).map((t) => t.bodyDocId),
    ...goals.filter((g) => !g.done).map((g) => g.bodyDocId),
    ...args.docs.map((d) => d.docId),
  ];
  const people = knownPeople(docIds, args.source);

  const items: ReviewThreadItem[] = [];
  const collect = (
    kind: ReviewThreadItem['kind'],
    docId: string,
    rawTitle: string,
    taskId?: string,
  ) => {
    // Both bands share one title, so it is normalized once at the door.
    const title = decodeEntities(rawTitle);
    for (const thread of args.source.threadsOf(docId)) {
      const run = unansweredRun(thread);
      // A DECLARATION beats every heuristic below it, and the newest one wins
      // for the same reason the newest ask does: it is the one still standing.
      // Asked over the whole thread rather than over the run, so a person
      // talking in the thread cannot retire a question nobody answered.
      const declaring = pendingDeclaration(thread);
      if (run.length === 0 && declaring === null) continue;

      if (declaring?.review) {
        // A correction to the words, if there has been one. `since` is
        // deliberately NOT reset by it: the reader has been waiting on this
        // question since it was asked, and a revision is the asker getting
        // the question right rather than a new wait starting.
        const revised = reviewPayloadRevision(declaring.review);
        items.push({
          kind,
          band: 'declared',
          docId,
          threadId: thread.id,
          commentId: declaring.id,
          review: declaring.review,
          ...(revised ? { revisedAt: revised.at } : {}),
          ...(revised?.revisedRange ? { revisedRange: revised.revisedRange } : {}),
          ...(taskId ? { taskId } : {}),
          title,
          // The headline IS the row title — an authored line rather than a
          // clip of prose, which is the entire fix for "titles are random
          // detailed text". No `clip` call: the length was enforced at the
          // door, so anything arriving over it is legacy and should be seen
          // rather than silently cut.
          ask: declaring.review.headline,
          askedBy: declaring.author.name,
          // The DECLARATION's timestamp, not the run's start. For an inferred
          // row `since` has to be the run's start or an agent's follow-ups
          // reset its own clock; a declaration cannot be reset that way,
          // because a later comment does not become the declaration. So this
          // is both starvation-safe and more truthful — an agent that posted
          // status for three days and only then declared has been waiting on
          // an answer for minutes, not days.
          since: declaring.ts,
          direct: true,
          askedAt: declaring.ts,
        });
        continue;
      }

      // Newest ask wins when an agent asked twice — the later one is the one
      // still standing. No ask, no row: a run of status prose used to fall
      // back to quoting its newest comment, which is exactly "replying
      // creates a row", and it filled 60 of the queue's 61 rows.
      const asked = [...run].reverse().find((c) => asksPerson(c.text, people));
      if (asked === undefined) continue;
      items.push({
        kind,
        band: 'unreplied',
        docId,
        threadId: thread.id,
        commentId: asked.id,
        ...(taskId ? { taskId } : {}),
        title,
        ask: extractAsk(asked.text, people),
        askedBy: asked.author.name,
        // The run's START. See the field's own note: this is the correction
        // that stops an agent's follow-ups from burying its own question.
        since: run[0].ts,
        direct: true,
        askedAt: asked.ts,
      });
    }
  };

  for (const task of args.tasks) {
    if (task.done) continue;
    collect('task-thread', task.bodyDocId, task.title, task.id);
  }
  for (const goal of goals) {
    if (goal.done) continue;
    collect('goal-thread', goal.bodyDocId, goal.title, goal.id);
  }
  for (const doc of args.docs) collect('doc-thread', doc.docId, doc.title);

  return items.sort((a, b) => a.since - b.since || a.threadId.localeCompare(b.threadId));
}

/**
 * Every OPEN review item hanging on a ticket, as queue rows.
 *
 * The cardinality is the change this exists for. A decision task used to BE a
 * decision — one `needs: 'decision'` flag and one embedded `options` array — so
 * the ticket title had to double as the question and a second open question had
 * nowhere to go. Bryan, 2026-08-18: *"at any point in time there might be
 * multiple open decisions for a ticket."* One ticket therefore contributes as
 * many rows as it has open items, not at most one.
 *
 * OPEN is `isReviewItemOpen`, which is `answer === undefined` and nothing else.
 * An info request is a question asked BACK — the item is still waiting on a
 * person, so it stays. A second "handled" flag would be free to disagree with
 * the answer that already states the fact.
 *
 * Done tickets are skipped for the same reason their discussions are: answering
 * a finished ticket's question changes nothing, and the board's problem is too
 * much competing for attention.
 */
export function taskReviewItems(tasks: ReviewTaskRef[]): ReviewTaskItem[] {
  const rows: ReviewTaskItem[] = [];
  for (const task of tasks) {
    if (task.done) continue;
    for (const item of task.reviews ?? []) {
      // HELD by the quality gate — filed, on the ticket, and not yet fit to
      // put in front of the reader — or still being judged. Its filer was
      // (or is about to be) told; until a verdict passes it the row does not
      // exist here — which is exactly what "not on the queue" has to mean
      // for the brief's count, the strip and the walkthrough, all of which
      // read this one list.
      if (isReviewItemGated(item)) continue;
      // WITHDRAWN by its asker. The write door for this is the doc-thread
      // route today — a ticket item has a per-item id and can already be
      // retired one at a time, which is the asymmetry the doc side lacked —
      // but the stamp lives on the shared payload and a peer can sync one
      // here. Reading it on both surfaces costs a line and means no queue can
      // carry an ask its author has taken back.
      if (reviewWithdrawn(item.review)) continue;
      const state = reviewItemState(item);
      // Answered is closed; waiting is the OWNER's turn — the reader asked on
      // it and has nothing to do until the words come back revised.
      if (state === 'answered' || state === 'waiting') continue;
      const revision = state === 'revised' ? item.revisions?.at(-1) : undefined;
      const question = revision ? latestThreadedQuestion(item) : undefined;
      rows.push({
        kind: 'task-review',
        band: 'declared',
        taskId: task.id,
        reviewItemId: item.id,
        review: item.review,
        state,
        ...(revision ? { revisedAt: revision.at } : {}),
        ...(question ? { question: question.text, threadId: question.threadId } : {}),
        ...(revision?.revisedRange ? { revisedRange: revision.revisedRange } : {}),
        // Same normalization as thread rows — see `decodeEntities`.
        title: decodeEntities(task.title),
        // The headline IS the row title, exactly as on a declared thread row —
        // an authored line rather than a clip of prose. No `clip` call: the
        // length was enforced at the door, so anything arriving over it is
        // legacy and should be seen rather than silently cut.
        ask: item.review.headline,
        askedBy: item.createdBy,
        since: item.createdAt,
        direct: true,
        askedAt: item.createdAt,
      });
    }
  }
  return rows;
}

/**
 * The whole queue: thread-borne rows and ticket-borne rows, one order.
 *
 * ONE function rather than two lists a caller concatenates, because the
 * ORDERING is the thing that must not be duplicated. The band sorts oldest-first
 * precisely so the item at most risk of never being answered comes up first
 * (see `since`), and a caller that merged two separately-sorted lists would
 * silently get two queues stapled together instead.
 *
 * The tie-break is the row's own address, so it is total across kinds: a thread
 * row breaks on `threadId` exactly as it always did — which is what keeps a
 * thread-only workspace's output identical to `reviewThreadItems`' — and a
 * ticket row breaks on `taskId:reviewItemId`, since the derived legacy id
 * (`r-legacy`) is deliberately the same string on every legacy ticket.
 */
export function reviewItemRows(args: {
  tasks: ReviewTaskRef[];
  /** The board's goal rows — their discussions queue, their `reviews` do not:
   *  `add_review_item` is a TASK verb and a goal row carries no such array. */
  goals?: ReviewTaskRef[];
  docs: ReviewDocRef[];
  source: ThreadSource;
}): ReviewItemRow[] {
  const rows: ReviewItemRow[] = [...reviewThreadItems(args), ...taskReviewItems(args.tasks)];
  return rows.sort((a, b) => a.since - b.since || rowKey(a).localeCompare(rowKey(b)));
}

function rowKey(row: ReviewItemRow): string {
  return row.kind === 'task-review' ? `${row.taskId}:${row.reviewItemId}` : row.threadId;
}

/**
 * The names that count as a person to address, taken from who has actually
 * spoken as one in this workspace.
 *
 * Deliberately derived rather than configured: a roster someone has to maintain
 * is a roster that goes stale, and the failure would be silent — an agent
 * addressing a real teammate whose name nobody added reads exactly like an
 * agent addressing nobody. `classifyActor` draws the line, so this cannot
 * disagree with the reply-reopen rule about who is a person.
 */
export function knownPeople(docIds: Iterable<string>, source: ThreadSource): Set<string> {
  const people = new Set<string>();
  const add = (u: { name?: string } | undefined) => {
    if (u && classifyActor(u as Parameters<typeof classifyActor>[0]) === 'person' && u.name)
      people.add(u.name);
  };
  const threadsFor = source.allThreadsOf?.bind(source) ?? source.threadsOf.bind(source);
  for (const docId of docIds) {
    for (const thread of threadsFor(docId)) {
      // A person who opened a thread is a person even if every comment on it is
      // an agent's — which is the shape of "person asks, agent answers at
      // length" and so exactly the thread an agent is most likely to ask back on.
      add(thread.createdBy);
      for (const c of thread.comments ?? []) add(c.author);
    }
  }
  return people;
}
