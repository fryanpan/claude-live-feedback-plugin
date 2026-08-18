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
 * This module computes the two thread-shaped kinds. Decisions stay where they
 * are — the client already holds every task — and the ORDERING of the merged
 * queue is the client's (`reviewQueue` in hub-model), which is what keeps the
 * priority rule in one pure, testable place instead of split across the wire.
 *
 * The server owns this half for one reason: "is this comment an agent's" is
 * `classifyActor`'s judgement, and it must not be re-decided here. A second
 * notion of who counts as an agent is exactly the drift this codebase has
 * already been bitten by.
 */
import type { Comment, ReviewPayload, Thread } from '@feedback/core';
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
 * Which of the two lists this row belongs to, and it is the whole point of
 * the change.
 *
 * - `declared` — an agent attached a Review Item and said "this needs you".
 *   This is the queue. Everything on it is something only a person can answer,
 *   because somebody had to write a headline to put it here.
 * - `unreplied` — the OLD membership rule, unchanged: an open thread whose
 *   newest comment is an agent's. That is what a finished exchange looks like,
 *   which is why it stopped being the queue.
 *
 * `unreplied` is kept, and kept visible, on purpose. A declared queue is only
 * as good as the agents filling it, and if they stop filing, an inferred queue
 * that had silently been deleted would leave questions sitting unasked behind
 * a surface that looks healthy. So nothing that surfaces today stops
 * surfacing — the set of threads is identical, the rows only sort into two
 * lists — and the reader can see whether the new path is being used at all.
 */
export type ReviewBand = 'declared' | 'unreplied';

export interface ReviewThreadItem {
  kind: 'task-thread' | 'doc-thread';
  band: ReviewBand;
  docId: string;
  threadId: string;
  /** The comment this row is about: the declaration if there is one, else the
   *  comment being quoted. Needed to stamp an answer back onto the item. */
  commentId: string;
  /** The declaration itself, present exactly when `band === 'declared'`. */
  review?: ReviewPayload;
  /** Present on a task discussion — the board opens the task, not the doc. */
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
   * This run contains a question addressed to a person by name — somebody is
   * waiting on an ANSWER, not reading a status note.
   *
   * Deliberately a rank-and-label signal rather than a filter. See
   * `asksPerson` for the rule and for what it is measured to miss.
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
}

export interface ReviewTaskRef {
  id: string;
  title: string;
  bodyDocId: string;
  /** A finished task's discussion is not a queue item — answering it changes
   *  nothing, and the board's problem is too much competing for attention. */
  done?: boolean;
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
 * still reads as waiting. That is the safe direction — a queue showing one
 * item too many costs a glance, one hiding a question costs the question.
 */
export function awaitingPerson(thread: Thread): Comment | null {
  const run = unansweredRun(thread);
  return run.length === 0 ? null : run[run.length - 1];
}

/**
 * Every comment since a person last spoke, oldest first — the whole stretch of
 * the conversation that is waiting, rather than only its last line.
 *
 * Membership is EXACTLY `awaitingPerson`'s: the run is non-empty if and only if
 * the newest comment is an agent's, which is what that predicate returned. That
 * equivalence is the safety property of this whole change — the set of threads
 * on the strip cannot move, so nothing that surfaces today can stop surfacing.
 * Only which comment is quoted, and which timestamp is called the wait, change.
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
 * PR that's purely typography?" are genuine asks that never name Bryan, and
 * this rule misses both. That is the direction chosen on purpose, because it is
 * the recoverable one: a missed question still appears on the strip exactly as
 * it does today — membership is untouched — it merely forfeits the promotion.
 * The cost of the opposite failure is the thing the board cannot afford: a
 * strip padded with non-decisions is a strip nobody reads, and once nobody
 * reads it every real decision on it is lost too.
 *
 * `people` is who has actually spoken as a person in this workspace. A
 * workspace where nobody has yet answers no to everything, and the strip
 * behaves exactly as it did before this existed.
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
 * Every open thread across a workspace's tasks and docs whose newest comment
 * is an agent's, oldest first — the thing that has been waiting longest is the
 * one most at risk of never being answered at all.
 */
export function reviewThreadItems(args: {
  tasks: ReviewTaskRef[];
  docs: ReviewDocRef[];
  source: ThreadSource;
}): ReviewThreadItem[] {
  const docIds = [
    ...args.tasks.filter((t) => !t.done).map((t) => t.bodyDocId),
    ...args.docs.map((d) => d.docId),
  ];
  const people = knownPeople(docIds, args.source);

  const items: ReviewThreadItem[] = [];
  const collect = (
    kind: ReviewThreadItem['kind'],
    docId: string,
    title: string,
    taskId?: string,
  ) => {
    for (const thread of args.source.threadsOf(docId)) {
      const run = unansweredRun(thread);
      if (run.length === 0) continue;

      // A DECLARATION beats every heuristic below it, and the newest one wins
      // for the same reason the newest ask does: it is the one still standing.
      const declaring = [...run].reverse().find((c) => c.review !== undefined);
      if (declaring?.review) {
        items.push({
          kind,
          band: 'declared',
          docId,
          threadId: thread.id,
          commentId: declaring.id,
          review: declaring.review,
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
      // still standing. Falling back to the run's newest comment keeps the
      // pre-existing behaviour for every thread that asks nothing.
      const asked = [...run].reverse().find((c) => asksPerson(c.text, people));
      const shown = asked ?? run[run.length - 1];
      items.push({
        kind,
        band: 'unreplied',
        docId,
        threadId: thread.id,
        commentId: shown.id,
        ...(taskId ? { taskId } : {}),
        title,
        ask: asked ? extractAsk(asked.text, people) : clip(shown.text),
        askedBy: shown.author.name,
        // The run's START. See the field's own note: this is the correction
        // that stops an agent's follow-ups from burying its own question.
        since: run[0].ts,
        direct: asked !== undefined,
        ...(asked ? { askedAt: asked.ts } : {}),
      });
    }
  };

  for (const task of args.tasks) {
    if (task.done) continue;
    collect('task-thread', task.bodyDocId, task.title, task.id);
  }
  for (const doc of args.docs) collect('doc-thread', doc.docId, doc.title);

  return items.sort((a, b) => a.since - b.since || a.threadId.localeCompare(b.threadId));
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
function knownPeople(docIds: Iterable<string>, source: ThreadSource): Set<string> {
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
