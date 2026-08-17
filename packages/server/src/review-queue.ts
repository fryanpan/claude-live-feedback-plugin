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
import type { Comment, Thread } from '@feedback/core';
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

export interface ReviewThreadItem {
  kind: 'task-thread' | 'doc-thread';
  docId: string;
  threadId: string;
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
  if (!text.includes('?')) return false;
  for (const name of people) {
    if (name.trim() === '') continue;
    // Name at a line start or just inside an emphasis run, then the
    // punctuation a direct address takes. The small leading allowance lets
    // "**Bryan —**" and "OK Bryan:" through without matching a name buried
    // mid-sentence ("which is Bryan's call"), which is the distinction the
    // whole rule turns on.
    const re = new RegExp(`(?:^|\\n|\\*\\*)[^\\n]{0,12}?\\b${escapeRe(name)}\\b\\s*[—:,-]`);
    if (re.test(text)) return true;
  }
  return false;
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
  const flat = text.replace(/\s+/g, ' ').trim();
  for (const name of people) {
    if (name.trim() === '') continue;
    const re = new RegExp(`(?:^|\\*\\*)[^\\n]{0,12}?\\b${escapeRe(name)}\\b\\s*[—:,-]`);
    const m = re.exec(flat);
    if (!m) continue;
    const from = flat.slice(m.index);
    const end = from.indexOf('?');
    // Through the end of the asking sentence; the options live between the
    // address and the "?" in every form this is written in.
    const cut = end >= 0 ? from.slice(0, end + 1) : from;
    return clip(cut, DIRECT_ASK_MAX);
  }
  return clip(text, DIRECT_ASK_MAX);
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
      // Newest ask wins when an agent asked twice — the later one is the one
      // still standing. Falling back to the run's newest comment keeps the
      // pre-existing behaviour for every thread that asks nothing.
      const asked = [...run].reverse().find((c) => asksPerson(c.text, people));
      const shown = asked ?? run[run.length - 1];
      items.push({
        kind,
        docId,
        threadId: thread.id,
        ...(taskId ? { taskId } : {}),
        title,
        ask: asked ? extractAsk(asked.text, people) : clip(shown.text),
        askedBy: shown.author.name,
        // The run's START. See the field's own note: this is the correction
        // that stops an agent's follow-ups from burying its own question.
        since: run[0].ts,
        direct: asked !== undefined,
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
  for (const docId of docIds) {
    for (const thread of source.threadsOf(docId)) {
      for (const c of thread.comments ?? []) {
        if (classifyActor(c.author) === 'person' && c.author.name) people.add(c.author.name);
      }
    }
  }
  return people;
}
