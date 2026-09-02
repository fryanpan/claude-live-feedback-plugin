import {
  type Anchor,
  type ReviewAnswerUndone,
  type ReviewItemJudgement,
  type ReviewPayload,
  type Thread,
  type User,
  applyReviewRevision,
  contentKind,
  createThread,
  listThreads,
  prose,
  reinstateReview,
  reviewAnswered,
  reviewPayloadVersion,
  postReply as schemaPostReply,
  replaceAnchor as schemaReplaceAnchor,
  setStatus as schemaSetStatus,
  setCommentReview,
  withRevision,
  withdrawReview,
} from '@feedback/core';
/**
 * Comment threads on a doc: opening one, replying, resolving and reopening,
 * re-anchoring when the text under a thread moved, and the review payload a
 * thread can carry — answered, revised, judged, withdrawn, undone.
 *
 * Split out of `rooms.ts`, which keeps the room lifecycle and the event
 * plumbing this fires into. The review verbs come with the threads rather
 * than to a file of their own on purpose: a review IS a field on a thread
 * here, every one of them ends in the same `thread.replied` frame, and
 * separating them would put the payload's rules in one file and the thread
 * they are a property of in another.
 *
 * `DocThreadPersistence` is four members. Two lookups rather than one is
 * deliberate: some verbs resolve an alias and hydrate, and some deliberately
 * only touch a room that is ALREADY resident, because answering a review on
 * a doc nobody has open should not page it in.
 */
import * as Y from 'yjs';
import { classifyActor } from './activity.ts';
import type { ActivityType } from './activity.ts';
import type { DocRoom } from './rooms.ts';

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** Resolve / reopen actions come from the reviewer surface, which doesn't
 *  send an author in the body. Default to the known reviewer (Bryan, the
 *  doc owner) so the activity stream attributes them to a person. The route
 *  may override by passing an explicit author. */
const DEFAULT_REVIEWER: User = {
  id: 'known-bryan',
  name: 'Bryan',
  kind: 'known',
  color: '#2e7dd7',
};

/**
 * The standing answer on a declaration, packaged as the history entry an undo
 * (or a displacing re-answer) appends. ONE builder for both callers, so a
 * displaced answer can never be recorded differently from an undone one.
 * `answeredAt` falls back to 0 for a legacy option tap that predates the
 * stamp — the entry still records the words and the option.
 */
function displacedAnswer(prior: ReviewPayload, ts: number, by: string): ReviewAnswerUndone {
  return {
    answeredAt: prior.answeredAt ?? 0,
    ...(prior.answeredBy !== undefined ? { answeredBy: prior.answeredBy } : {}),
    ...(prior.answerText !== undefined ? { answerText: prior.answerText } : {}),
    ...(prior.answeredWith !== undefined ? { answeredWith: prior.answeredWith } : {}),
    undoneAt: ts,
    undoneBy: by,
  };
}

/** What a thread verb may reach in the store, and nothing else. */
export interface DocThreadPersistence {
  /** Resolve an alias and hydrate if needed — the normal door. */
  room(docId: string): DocRoom | undefined;
  /** Only a room that is ALREADY resident. Some verbs use this on purpose:
   *  acting on a review must not page in a doc nobody has open. */
  residentRoom(docId: string): DocRoom | undefined;
  /** Bump the room's sequence, schedule a summary and broadcast. */
  fireThreadEvent(
    room: DocRoom,
    event: 'thread.created' | 'thread.replied' | 'thread.resolved' | 'thread.reopened',
    thread: Thread,
    comment?: { id: string; author: User; text: string; ts: number },
    opts?: { generate?: boolean },
    actor?: User,
  ): void;
  recordActivity(
    room: DocRoom,
    type: ActivityType,
    author: User,
    threadId: string,
    opts: { text?: string; tsMs: number },
  ): void;
}

/** The thread verbs. One per `Rooms`, holding no state of its own. */
export class DocThreads {
  constructor(private readonly p: DocThreadPersistence) {}

  async postComment(
    docId: string,
    threadId: string | null,
    author: User,
    text: string,
    anchor?: Anchor,
    /**
     * May this write spend the summary API key? Routes pass `false` for share
     * visitors: a public tunnel URL must not be able to run up a bill, and a
     * summary is not worth granting an outsider an outbound call. Defaults to
     * true so local editors and agents keep working unchanged.
     */
    opts?: {
      generate?: boolean;
      /**
       * The Review Item this comment DECLARES, if it declares one.
       *
       * Rides on the ordinary comment path rather than a store of its own,
       * which is what makes every existing mechanism apply to it for free:
       * threads already sync, anchor, resolve, watch and emit the events
       * agents listen to, and a person's reply already ends the unanswered
       * run — which is exactly how a review item leaves the queue.
       *
       * `postComment` is the one choke point all three reply paths funnel
       * through (browser REST, MCP `post_reply`, widget), so this is the
       * layer where the payload has to be accepted, not the routes above it.
       */
      review?: ReviewPayload;
    },
  ): Promise<Thread | null> {
    const room = this.p.room(docId);
    if (!room) return null;
    if (threadId == null) {
      if (!anchor) return null;
      const id = randomId();
      const t = createThread(room.ydoc, {
        threadId: id,
        anchor,
        createdBy: author,
        firstComment: { id: randomId(), text, ...(opts?.review ? { review: opts.review } : {}) },
      });
      this.p.fireThreadEvent(room, 'thread.created', t, undefined, opts);
      // Hash the activity event with the comment's PERSISTED ts (not a fresh
      // Date.now()), so a later backfill — which reconstructs this event from
      // the same stored ts — produces an IDENTICAL eventId and dedupes
      // instead of double-counting.
      this.p.recordActivity(room, 'comment', author, t.id, {
        text,
        tsMs: t.comments[0]?.ts ?? Date.now(),
      });
      return t;
    }
    const comment = schemaPostReply(room.ydoc, threadId, {
      id: randomId(),
      author,
      text,
      ...(opts?.review ? { review: opts.review } : {}),
    });
    if (!comment) return null;
    // A PERSON replying to a resolved thread is continuing the conversation,
    // so the thread reopens. It has to: the drawer's default "Open" tab drops
    // resolved threads entirely, so a reply that leaves the status alone is a
    // reply the reviewer can never see — reported, accurately from where he
    // sat, as "comments are going missing".
    //
    // An AGENT reply deliberately does NOT reopen. Agents post closing notes
    // ("done, removed it in <sha>") after a human resolves, and resurrecting
    // a thread the human just closed is its own bug. Same actor split the
    // activity log uses.
    const replied = this.getThread(docId, threadId);
    const reopened =
      replied?.status === 'resolved' && classifyActor(author) === 'person'
        ? schemaSetStatus(room.ydoc, threadId, 'open')
        : null;
    const thread = reopened ?? replied;
    if (thread) this.p.fireThreadEvent(room, 'thread.replied', thread, comment, opts);
    // Watchers that track open/resolved from the event stream would otherwise
    // hold 'resolved' for a thread that is open again. No separate activity
    // record: the reply below already logs this person's action, and a
    // synthetic 'reopen' would double-count it.
    if (reopened && thread) {
      // The replier's continuation is what reopened the thread, so the
      // reopen frame names them — same attribution the reply frame carries.
      this.p.fireThreadEvent(room, 'thread.reopened', thread, undefined, opts, author);
    }
    this.p.recordActivity(room, 'reply', author, threadId, { text, tsMs: comment.ts });
    return thread;
  }

  /**
   * Answer a Review Item: post the person's words as a reply, and record
   * which option they came from.
   *
   * **The answer IS the reply** — the words a person answered with are a
   * comment, there is no second answer store, and this still reopens a
   * resolved thread and still emits the events watching agents receive.
   *
   * What this no longer leans on is "a person spoke" as the RECORD that it
   * happened. That reading held only while every person's comment in the
   * thread was an answer, and the task panel's single composer made that
   * false: it aims an ordinary remark at the newest comment's thread, so a
   * line of small talk retired an unanswered decision and took its card with
   * it. So the answer is stamped onto the declaration (`answeredAt`, plus
   * `answeredWith` when the words came from an option) and the queue reads
   * that. One field, written in one place, so the two spellings this comment
   * used to warn about still cannot disagree.
   *
   * `optionId` is provenance only, mirroring `answer_decision`'s split: `text`
   * is always the verbatim answer, and the id merely records which candidate
   * the words came from. A typed answer carries no id and is not a lesser
   * answer.
   *
   * Refuses an unknown option rather than recording a dangling id — the card
   * renders the label by looking the id up, so a stale one would render as a
   * blank choice on a decision that reads as answered.
   *
   * `onlyIfUnanswered` makes the write CONDITIONAL on the item still being
   * pending, re-checked here rather than by the caller. Answering twice is
   * legitimate for a person who changed their mind — that is the unconditional
   * default, and the displaced answer becomes history. It is not legitimate for
   * a reply that was folded into an answer only because the item looked open
   * when the request was read: that caller's whole claim is "nobody has
   * answered this", and it must lose the race rather than overwrite the winner.
   * The caller then posts the words as an ordinary comment, which is what they
   * were.
   */
  async answerReviewItem(
    docId: string,
    threadId: string,
    commentId: string,
    author: User,
    text: string,
    optionId?: string,
    opts?: { generate?: boolean; onlyIfUnanswered?: boolean },
  ): Promise<{ ok: true; thread: Thread } | { ok: false; error: string }> {
    const room = this.p.room(docId);
    if (!room) return { ok: false, error: 'no-doc' };
    const thread = this.getThread(docId, threadId);
    const target = thread?.comments.find((c) => c.id === commentId);
    if (!target?.review) return { ok: false, error: 'not-a-review-item' };
    if (optionId !== undefined && !target.review.options?.some((o) => o.id === optionId)) {
      return { ok: false, error: `unknown option '${optionId}'` };
    }
    // Read in the same synchronous stretch as the write below, so nothing can
    // land between the check and the stamp. The caller's own read is not enough
    // — it is one `await` away from being stale, and this is the layer that
    // knows what is stored.
    if (opts?.onlyIfUnanswered && reviewAnswered(target.review)) {
      return { ok: false, error: 'already-answered' };
    }
    // Stamped BEFORE the reply so the payload is already current when
    // `thread.replied` reaches a watching agent — otherwise the event that
    // says "answered" carries a card that still says "unanswered".
    const prior = target.review;
    const ts = Date.now();
    // A second answer landing over a standing one is a race, not a rewrite
    // request — two browsers both showing the same card, the slower tap
    // arriving after the faster one recorded. Last write stands, but the
    // displaced record moves to `answerHistory` exactly as an undo would move
    // it: overwriting IS a withdrawal, performed by the overwriting actor,
    // and a hard delete is the loss that field exists to prevent. Mirrors
    // `answerDecision` in tasks.ts.
    const history: ReviewAnswerUndone[] | undefined = reviewAnswered(prior)
      ? [...(prior.answerHistory ?? []), displacedAnswer(prior, ts, author.name)]
      : prior.answerHistory;
    // Rest-destructured rather than deleted: the payload is stored as a plain
    // value in the ydoc, and an absent key is the only honest spelling of
    // "unanswered" there.
    const {
      answeredAt: _at,
      answeredWith: _with,
      answeredBy: _by,
      answerText: _txt,
      ...cleared
    } = prior;
    setCommentReview(room.ydoc, threadId, commentId, {
      ...cleared,
      ...(history && history.length > 0 ? { answerHistory: history } : {}),
      // Every answer, tapped or typed. `answeredWith` cannot carry this on its
      // own — it is absent on a typed answer — and an item with no stamp at
      // all is one the queue would go on offering after it was answered.
      answeredAt: ts,
      // The record's face: "Answered by <who>: <words>" is rendered from the
      // declaration, not from re-deriving which reply was the answer, so it
      // has to survive a reload on the payload itself.
      answeredBy: author.name,
      answerText: text,
      ...(optionId !== undefined ? { answeredWith: optionId } : {}),
    });
    const replied = await this.postComment(docId, threadId, author, text, undefined, opts);
    return replied ? { ok: true, thread: replied } : { ok: false, error: 'reply-failed' };
  }

  /**
   * Rewrite a review item raised on a DOC THREAD, keeping what it said before.
   *
   * The doc-side twin of `TaskStore.reviseReviewItem`, and deliberately thin:
   * `applyReviewRevision` in core decides what a revision is, so the two
   * surfaces cannot come to disagree about which patches are legal or where
   * the changed span fell. What differs is only where the history is filed —
   * a ticket item keeps it on its wrapper, and a doc-thread item has no
   * wrapper, so `withRevision` puts it on the payload.
   *
   * Before this existed the only way to correct a doc-thread ask was to raise
   * a second one, which left the reader's queue carrying two items about one
   * question with the older, wronger one still reading as live. That is the
   * failure this method removes.
   *
   * Addressed by `(docId, threadId, commentId)` — the identity the queue
   * already uses for a doc-thread row, and the one `setCommentReview` already
   * mutates by. Nothing new had to be minted.
   */
  reviseCommentReview(
    docId: string,
    threadId: string,
    commentId: string,
    patch: { headline?: unknown; detail?: unknown; options?: unknown },
    opts: { actor: User; revisedRange?: { start: number; end: number } },
  ):
    | { ok: true; review: ReviewPayload; thread: Thread }
    | { ok: false; error: string; message?: string } {
    const room = this.p.residentRoom(docId);
    if (!room) return { ok: false, error: 'no-doc' };
    const thread = this.getThread(docId, threadId);
    const target = thread?.comments.find((c) => c.id === commentId);
    if (!target?.review) return { ok: false, error: 'not-a-review-item' };
    // Read and write in one synchronous stretch, the reason `answerReview`
    // gives: the caller's read is an await away from being stale, and this is
    // the layer that knows what is stored.
    const applied = applyReviewRevision(target.review, patch, {
      by: opts.actor.name,
      at: Date.now(),
      ...(opts.revisedRange ? { revisedRange: opts.revisedRange } : {}),
      // No `threadId` stamp: on a task the field names the thread that ASKED,
      // somewhere other than the item. Here the item IS on the thread, so
      // recording it would say nothing and read as a cross-reference.
    });
    if (!applied.ok) {
      return {
        ok: false,
        error: applied.error,
        ...(applied.message !== undefined ? { message: applied.message } : {}),
      };
    }
    const review = withRevision(applied.next, applied.previous);
    if (!setCommentReview(room.ydoc, threadId, commentId, review)) {
      // The comment went between the read and the write — a race, not an
      // error the caller did anything to cause.
      return { ok: false, error: 'not-a-review-item' };
    }
    const after = this.getThread(docId, threadId);
    return after ? { ok: true, review, thread: after } : { ok: false, error: 'not-a-review-item' };
  }

  /**
   * Record the quality gate's verdict on a review item raised on a COMMENT.
   *
   * The doc-side twin of `TaskStore.recordReviewJudgement`, with the same two
   * conditional writes and for the same reasons — a judge call is an await,
   * and the words it was about can move underneath it:
   *
   *  - `forVersion` is the payload's revision count as it stood when the
   *    judge was asked. A revision that landed meanwhile makes this verdict
   *    stale; the revision's own call is the one that stands.
   *  - `forPendingAt` is the `pending` stamp this caller placed before it
   *    asked. Only its own stamp may be replaced — otherwise a slow verdict
   *    could re-hold an item somebody had already released, which changes no
   *    words and so slips past `forVersion` alone.
   *
   * An ANSWERED item is refused outright: a person has acted on those words,
   * and a hold placed after the fact would take an answered question off a
   * queue it has already left.
   *
   * Read and written in one synchronous stretch, the reason `answerReview`
   * gives — the caller's read is an await away from being stale, and this is
   * the layer that knows what is stored.
   */
  judgeCommentReview(
    docId: string,
    threadId: string,
    commentId: string,
    judgement: ReviewItemJudgement,
    opts: { forVersion?: number; forPendingAt?: number } = {},
  ):
    | { ok: true; review: ReviewPayload; thread: Thread }
    | { ok: false; error: 'no-doc' | 'not-a-review-item' | 'answered' | 'stale' } {
    const room = this.p.residentRoom(docId);
    if (!room) return { ok: false, error: 'no-doc' };
    const thread = this.getThread(docId, threadId);
    const target = thread?.comments.find((c) => c.id === commentId);
    if (!target?.review) return { ok: false, error: 'not-a-review-item' };
    const current = target.review;
    if (reviewAnswered(current)) return { ok: false, error: 'answered' };
    if (opts.forVersion !== undefined && reviewPayloadVersion(current) !== opts.forVersion) {
      return { ok: false, error: 'stale' };
    }
    if (
      opts.forPendingAt !== undefined &&
      (current.judge?.verdict !== 'pending' || current.judge.at !== opts.forPendingAt)
    ) {
      return { ok: false, error: 'stale' };
    }
    const review: ReviewPayload = {
      ...current,
      judge: { at: judgement.at, verdict: judgement.verdict, reason: judgement.reason },
    };
    if (!setCommentReview(room.ydoc, threadId, commentId, review)) {
      // The comment went between the read and the write — a race, not an
      // error the caller did anything to cause.
      return { ok: false, error: 'not-a-review-item' };
    }
    const after = this.getThread(docId, threadId);
    return after ? { ok: true, review, thread: after } : { ok: false, error: 'not-a-review-item' };
  }

  /**
   * Take back a review item raised on a doc thread — the asker's own exit.
   *
   * Thin for the reason `reviseCommentReview` is thin: what a withdrawal IS,
   * and which ones are refused, is core's (`withdrawReview`). This layer only
   * knows where the payload lives and how to write it back inside one
   * synchronous stretch.
   *
   * It deliberately does NOT touch the thread. That is the whole point of the
   * verb: `resolve_thread` is thread-scoped, so retiring one ask by resolving
   * its thread takes every sibling ask down with it. Here the thread stays
   * open and its other declarations stay answerable — `pendingDeclaration`
   * steps over the withdrawn one and falls through to whichever ask is still
   * standing.
   *
   * ANY agent in the workspace may withdraw an item, not only the one whose
   * name is on it, and `withdrawnBy` records who did. Two reasons, and the
   * first is the stronger: a workspace is a shared view, so its resources are
   * everyone's, and the sibling verb one step from here (`reviseCommentReview`)
   * already lets an agent REWRITE another's ask — a narrower rule on the
   * gentler of the two operations would be a fence with no field behind it.
   * The second is the case that produced this verb: the agent left holding a
   * stale ask is often not the one that filed it (a peer that has since
   * exited, or a lead cleaning up by hand), and an ownership check would lock
   * exactly that agent out of the cleanup.
   */
  withdrawCommentReview(
    docId: string,
    threadId: string,
    commentId: string,
    opts: { actor: User; reason?: string; undo?: boolean },
  ):
    | { ok: true; review: ReviewPayload; thread: Thread }
    | { ok: false; error: string; message?: string } {
    const room = this.p.residentRoom(docId);
    if (!room) return { ok: false, error: 'no-doc' };
    const thread = this.getThread(docId, threadId);
    const target = thread?.comments.find((c) => c.id === commentId);
    if (!target?.review) return { ok: false, error: 'not-a-review-item' };
    const at = Date.now();
    const applied = opts.undo
      ? reinstateReview(target.review, { by: opts.actor.name, at })
      : withdrawReview(target.review, {
          by: opts.actor.name,
          at,
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        });
    if (!applied.ok) return { ok: false, error: applied.error, message: applied.message };
    if (!setCommentReview(room.ydoc, threadId, commentId, applied.next)) {
      // The comment went between the read and the write — a race, not an
      // error the caller did anything to cause.
      return { ok: false, error: 'not-a-review-item' };
    }
    const after = this.getThread(docId, threadId);
    return after
      ? { ok: true, review: applied.next, thread: after }
      : { ok: false, error: 'not-a-review-item' };
  }

  /**
   * Take a thread answer back — the way back from a one-tap act that used to
   * be permanent, mirroring `withdrawAnswer` on the legacy decision task.
   *
   * SOFT delete, per the project rule: the four answer stamps move into the
   * payload's `answerHistory` with who undid them and when, rather than being
   * dropped. The reply comment stays in the thread — undo takes back the
   * STAMP, not the conversation; the words a person posted are user content
   * either way.
   *
   * Un-stamping is the whole mechanism of "Undo reopens it everywhere": every
   * queue (Home, the task panel, the doc surface) derives "waiting on you"
   * from `reviewAnswered` on the declaration, so clearing the stamps re-offers
   * the item on every surface with no second state to sync.
   *
   * Refuses when there is nothing to take back rather than succeeding
   * vacuously: two readers racing the same undo must not both be told they
   * took something back.
   */
  undoReviewItemAnswer(
    docId: string,
    threadId: string,
    commentId: string,
    author: User,
    opts?: { generate?: boolean },
  ): { ok: true; thread: Thread } | { ok: false; error: string } {
    const room = this.p.room(docId);
    if (!room) return { ok: false, error: 'no-doc' };
    const thread = this.getThread(docId, threadId);
    const target = thread?.comments.find((c) => c.id === commentId);
    if (!target?.review) return { ok: false, error: 'not-a-review-item' };
    const prior = target.review;
    if (!reviewAnswered(prior)) return { ok: false, error: 'not-answered' };
    // Rest-destructured for the same reason as in `answerReviewItem`: an
    // absent key, not an undefined value, is what "unanswered" looks like in
    // the stored payload.
    const {
      answeredAt: _at,
      answeredWith: _with,
      answeredBy: _by,
      answerText: _txt,
      ...cleared
    } = prior;
    setCommentReview(room.ydoc, threadId, commentId, {
      ...cleared,
      answerHistory: [
        ...(prior.answerHistory ?? []),
        displacedAnswer(prior, Date.now(), author.name),
      ],
    });
    const updated = this.getThread(docId, threadId);
    if (!updated) return { ok: false, error: 'no-doc' };
    // The same funnel every thread change goes through, so watching agents
    // and open browsers learn the card is unanswered again. `thread.replied`
    // rather than a new event name on purpose: the four existing names are
    // the entire vocabulary every deployed client repaints on, and an undo
    // announced under a fifth would reach nobody until every session
    // restarted. No comment payload — nothing was said, a stamp was removed;
    // the updated thread carries the truth.
    this.p.fireThreadEvent(room, 'thread.replied', updated, undefined, opts);
    return { ok: true, thread: updated };
  }

  /**
   * Agent-side thread creation. Mirrors the user-side editor flow
   * (editor → POST /api/docs/<id>/threads with a pre-built Anchor) but
   * accepts `find`+context the same way `find_and_replace` does — the
   * agent doesn't have a cursor to anchor against, so it specifies the
   * text range by its visible content. Once the anchor is built, the
   * write path is identical: `postComment(docId, null, ...)` fires
   * `thread.created` on the same channel the editor uses, so widgets
   * see the new thread instantly.
   */
  async createThreadByFind(
    docId: string,
    opts: {
      find: string;
      contextBefore?: string;
      contextAfter?: string;
      occurrence?: number;
    },
    author: User,
    text: string,
    /**
     * Forwarded verbatim to both `postComment` calls below. Share visitors
     * can reach this route, and the text they post becomes the WHOLE prompt
     * — the worst of the gate's holes, because it needs no pre-existing
     * thread. Defaults to generating, like every other local caller.
     */
    writeOpts?: { generate?: boolean; review?: ReviewPayload },
  ): Promise<
    | { ok: true; thread: Thread }
    | {
        ok: false;
        error: 'no-match' | 'cross-node' | 'ambiguous' | 'no-doc';
        candidates?: Array<{ docOffset: number; preview: string }>;
      }
  > {
    const room = this.p.room(docId);
    if (!room) return { ok: false, error: 'no-doc' };
    // Code/diff docs are flat text in the `content` Y.Text — the prose
    // resolver below would walk an empty fragment and always miss. Find the
    // text directly and snap the anchor to whole lines, matching the code
    // surface's own selection convention.
    if (contentKind(room.meta.type) === 'flat') {
      const content = room.ydoc.getText('content');
      const hay = content.toString();
      const before = opts.contextBefore ?? '';
      const after = opts.contextAfter ?? '';
      const needle = before + opts.find + after;
      const hits: number[] = [];
      for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) hits.push(i);
      if (hits.length === 0) return { ok: false, error: 'no-match' };
      let hit: number | undefined;
      if (opts.occurrence != null) {
        hit = hits[opts.occurrence - 1];
        if (hit === undefined) return { ok: false, error: 'no-match' };
      } else if (hits.length > 1) {
        return {
          ok: false,
          error: 'ambiguous',
          candidates: hits.slice(0, 5).map((docOffset) => ({
            docOffset,
            preview: hay.slice(Math.max(0, docOffset - 30), docOffset + needle.length + 30),
          })),
        };
      } else {
        hit = hits[0] as number;
      }
      const from = hit + before.length;
      const to = from + opts.find.length;
      const lineStart = hay.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
      const nl = hay.indexOf('\n', Math.max(to - 1, lineStart));
      const lineEnd = nl === -1 ? hay.length : nl + 1;
      const enc = (offset: number) =>
        Array.from(
          Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(content, offset)),
        ) as unknown as Uint8Array;
      const anchor: Anchor = {
        kind: 'text-range',
        startRel: enc(lineStart),
        endRel: enc(lineEnd),
        snippet: { text: hay.slice(lineStart, lineEnd).slice(0, 120) },
      };
      const thread = await this.postComment(docId, null, author, text, anchor, writeOpts);
      if (!thread) return { ok: false, error: 'no-doc' };
      return { ok: true, thread };
    }
    const resolved = prose.resolveTextRangeFromFind(room.ydoc, opts);
    if (!resolved.ok) {
      if (resolved.error === 'ambiguous') {
        return { ok: false, error: 'ambiguous', candidates: resolved.candidates };
      }
      return { ok: false, error: resolved.error };
    }
    // Yjs's encodeAny silently JSON-stringifies a Uint8Array inside a plain
    // object — it becomes { "0": ..., "1": ... } on the way out, with no
    // .length and no iteration, so `new Uint8Array(anchor.startRel)` on the
    // client produces an empty array. Anchor resolution then returns null,
    // the editor renders no decoration, and clicks miss entirely. The editor
    // serializes the same way it sends over JSON: as a number[]. Match it.
    // See packages/markdown-app/src/app.ts:976 (`Array.from(selection.start)`).
    // `Anchor.startRel`/`endRel` is typed as Uint8Array, but the editor's
    // own thread-create path (`packages/markdown-app/src/app.ts:976`)
    // sends a number[] — and that's what survives Yjs's encoder cleanly
    // inside a plain object. A Uint8Array nested in a plain object gets
    // JSON-stringified to `{"0":2,"1":251,...}` on the way out, with no
    // .length and no iteration, so `new Uint8Array(anchor.startRel)` on
    // the client produces an empty array and decorations stop rendering.
    // Match the editor's wire shape. The `unknown` double-cast is the
    // accepted way to thread a number[] through a Uint8Array-typed slot
    // without `as any`.
    const startRelArr = Array.from(resolved.startRel) as unknown as Uint8Array;
    const endRelArr = Array.from(resolved.endRel) as unknown as Uint8Array;
    const anchor: Anchor = {
      kind: 'text-range',
      startRel: startRelArr,
      endRel: endRelArr,
      snippet: { text: resolved.snippetText },
    };
    const thread = await this.postComment(docId, null, author, text, anchor, writeOpts);
    if (!thread) return { ok: false, error: 'no-doc' };
    return { ok: true, thread };
  }

  /**
   * `opts.generate` is the same visitor gate `postComment` carries, and it is
   * here for the same reason: a resolve is a thread CHANGE, so it schedules a
   * summary, so a share visitor clicking Resolve would otherwise spend the
   * host's API key on a prompt containing their own comment text. Gating only
   * the comment routes gated nothing — every visitor comment moves
   * `summaryHash`, and the next Resolve click cashes it in.
   */
  resolve(
    docId: string,
    threadId: string,
    author?: User,
    opts?: { generate?: boolean },
  ): Thread | null {
    const room = this.p.room(docId);
    if (!room) return null;
    const t = schemaSetStatus(room.ydoc, threadId, 'resolved');
    if (t) {
      // The frame names WHO resolved. Without it, 17 resolves in the field
      // were each attributed to the thread's creator by the channel
      // renderer's comments[0] fallback. Same default recordActivity uses.
      this.p.fireThreadEvent(
        room,
        'thread.resolved',
        t,
        undefined,
        opts,
        author ?? DEFAULT_REVIEWER,
      );
      this.p.recordActivity(room, 'resolve', author ?? DEFAULT_REVIEWER, threadId, {
        tsMs: Date.now(),
      });
    }
    return t;
  }

  /** See `resolve` — `opts.generate` is the same visitor gate. */
  reopen(
    docId: string,
    threadId: string,
    author?: User,
    opts?: { generate?: boolean },
  ): Thread | null {
    const room = this.p.room(docId);
    if (!room) return null;
    const t = schemaSetStatus(room.ydoc, threadId, 'open');
    if (t) {
      // See resolve above — the reopen frame names who reopened.
      this.p.fireThreadEvent(
        room,
        'thread.reopened',
        t,
        undefined,
        opts,
        author ?? DEFAULT_REVIEWER,
      );
      this.p.recordActivity(room, 'reopen', author ?? DEFAULT_REVIEWER, threadId, {
        tsMs: Date.now(),
      });
    }
    return t;
  }

  reanchor(docId: string, threadId: string, anchor: Anchor): Thread | null {
    const room = this.p.room(docId);
    if (!room) return null;
    return schemaReplaceAnchor(room.ydoc, threadId, anchor);
  }

  listThreads(docId: string, filter?: { status?: 'open' | 'resolved' }): Thread[] {
    const room = this.p.room(docId);
    if (!room) return [];
    const all = listThreads(room.ydoc);
    return filter?.status ? all.filter((t) => t.status === filter.status) : all;
  }

  getThread(docId: string, threadId: string): Thread | null {
    const room = this.p.room(docId);
    if (!room) return null;
    return listThreads(room.ydoc).find((t) => t.id === threadId) ?? null;
  }

  /**
   * Append a comment-family activity event (comment / reply / resolve /
   * reopen) for a successful thread action. Both person and agent actions are
   * recorded — agent events carry actor:'agent' so the Weekly Review agent can
   * filter them, but person events are never dropped. Best-effort: any failure
   * is swallowed so activity capture can't break the action it observes.
   */
}
