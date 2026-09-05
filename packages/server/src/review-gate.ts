/**
 * The review-item quality gate.
 *
 * ONE module because "judged, then announced, in that order" is the rule the
 * whole family exists to keep. A declaration can be filed on a TICKET or on a
 * COMMENT; both land in the same reader's queue, so both go through the same
 * judge, and a push whose title is the item's headline must never be sent for
 * an item that queue omits. `announceReviewItem` arrives in the context
 * rather than being called from the routes, so the ordering is the shape of
 * this file rather than a convention two callers have to remember.
 *
 * Lifted verbatim out of `createServer`. Every collaborator arrives in
 * `ReviewGateContext` rather than being captured from that closure,
 * following `task-routes-context.ts`.
 */
import {
  type ReviewItemJudgement,
  type ReviewPayload,
  type TaskReviewItem,
  type Thread,
  type User,
  isReviewItemHeld,
  isReviewPayloadHeld,
  judgeReasonClause,
  judgeReasonSentence,
  latestThreadedQuestion,
  locateReviewItemRange,
  readTaskReviewItem,
  reviewItemState,
  reviewPayloadVersion,
} from '@feedback/core';
import { taskDeepLink } from './home-brief.ts';
import type { ReviewJudge, ReviewJudgeVerdict } from './review-judge.ts';
import type { Rooms } from './rooms.ts';
import type { ThreadReviewGate } from './routes/docs.ts';
import type { ReviewGate } from './routes/task-routes-context.ts';
import type { SseHub } from './sse.ts';
import { REVIEW_ITEM_HELD_EVENT, type ReviewItemHeldFrame } from './stall-nudge.ts';
import type { TaskProjection } from './task-projection.ts';
import {
  LEGACY_REVIEW_ITEM_ID,
  type Task,
  type TaskStore,
  reviewItemVersion,
  wordsRevisionOf,
} from './tasks.ts';

/**
 * How many times the gate may hold ONE item before it admits it anyway.
 *
 * Two, because two is the most a check can ask for and still be a check: the
 * filer files, is told the gap, and fixes it. A third round is where a gate
 * stops being read as feedback — a peer whose decision item was held eight
 * times with a different reason each round gave up and posted the ask as a
 * plain comment, which is precisely the outcome the gate exists to prevent
 * (2026-09-04).
 *
 * The item is not silently waved through: it reaches the reader carrying the
 * gate's FIRST concern, which is the one thing the judge cannot have
 * contradicted later.
 */
export const REVIEW_GATE_MAX_HOLDS = 2;

/**
 * WHERE a held item lives, and therefore how its filer addresses the fix.
 *
 * Two surfaces file review items and both are gated, so the hold has to be
 * able to name either address. A hold whose message points at the wrong
 * verb is a dead end — the item sits off the queue, the stall loop
 * complains at five minutes, and the filer cannot comply — which is
 * exactly the objection that kept the thread path ungated until
 * `revise_review_item` grew its doc form.
 */
export type ReviewGateAddress =
  | { kind: 'task'; taskId: string; reviewItemId: string }
  | { kind: 'thread'; docId: string; threadId: string; commentId: string }
  // The ticket's OWN decision — a row that IS the question rather than one
  // carrying it. It has no item id to name (`legacyReviewItem` derives it
  // at read time under the fixed `r-legacy`, which is the same string on
  // every such ticket), so the address is the ticket, and
  // `revise_review_item` takes it with `reviewItemId` omitted — the shape
  // `answer_decision` has always used for the same row.
  | { kind: 'decision'; taskId: string };

/** The long-lived collaborators the gate reads. */
export interface ReviewGateContext {
  /** Doc rooms — a comment-borne declaration is judged and stamped on one. */
  rooms: Rooms;
  /** The hub store — the tickets, their items and the board's criteria. */
  taskStore: TaskStore;
  /** The ydoc projection, refreshed after a verdict the store does not emit. */
  taskProjection: TaskProjection;
  /** The event hub a held-item frame is pushed down. */
  sse: SseHub;

  /**
   * The one `ServerOptions` field this module reads.
   *
   * Structural on purpose, the way `WorkspaceRoutesContext` narrows its own:
   * naming `ServerOptions` here would make a collaborator import a type out
   * of server.ts, which imports this module back.
   */
  opts: { reviewJudge?: ReviewJudge };

  /** JSON response helper — status plus body, no CORS. */
  j: (status: number, body: unknown) => Response;

  /** This server's externally reachable origin, as links are minted from. */
  externalBaseUrl: () => string;
  /** Where a thread opens, or undefined when it has no reachable URL. */
  threadUrl: (docId: string, isVisitor: boolean) => string | undefined;
  /** The board a doc belongs to, or null when none holds it. */
  resolveWorkspaceForDoc: (docId: string) => string | null;
  /** Tell every enrolled device an item landed — see push-announce.ts. It
   *  arrives here, and is called from here, so a held item cannot be
   *  announced by a caller that forgot to ask the gate first. */
  announceReviewItem: (input: {
    ask: string;
    context: string;
    askedBy: string;
    url: string | undefined;
    key: string;
  }) => void;
}

/**
 * Build the gate once per server.
 *
 * `warnedJudgeThrew` lives inside, so a thrown judge is named once per server
 * rather than once per item — which is what it was as a `let` in the
 * `createServer` closure.
 */
export function createReviewGate(ctx: ReviewGateContext) {
  const {
    rooms,
    taskStore,
    taskProjection,
    sse,
    opts,
    j,
    externalBaseUrl,
    threadUrl,
    resolveWorkspaceForDoc,
    announceReviewItem,
  } = ctx;
  /** Where a comment-borne review item opens. A task discussion opens the
   *  TICKET — the board reveals the thread from its own state — while a doc
   *  thread opens the doc at the comment rather than at its top. */
  function reviewThreadLink(docId: string, threadId: string): string | undefined {
    const base = threadUrl(docId, false);
    if (!base) return undefined;
    if (docId.startsWith('task:')) return base;
    return `${base}?thread=${encodeURIComponent(threadId)}`;
  }

  /** What the reader is being asked ABOUT: the ticket's title for a task
   *  discussion, the doc's label otherwise. Same choice `reviewThreadItems`
   *  makes when it builds the queue row. */
  function reviewThreadContext(docId: string): string {
    if (docId.startsWith('task:')) {
      const task = taskStore.getTask(docId.slice('task:'.length));
      if (task) return task.title;
    }
    return rooms.peekMeta(docId)?.title ?? 'A document';
  }

  /** One spelling of "a declaration just landed on a comment", for the three
   *  routes that can carry one. */
  function announceThreadReview(
    docId: string,
    threadId: string,
    review: ReviewPayload,
    author: User,
  ): void {
    announceReviewItem({
      ask: review.headline,
      context: reviewThreadContext(docId),
      askedBy: author.name,
      url: reviewThreadLink(docId, threadId),
      key: `${docId}:${threadId}`,
    });
  }

  /**
   * The comment a just-written declaration landed on.
   *
   * The write routes hand back the whole THREAD, not the comment, so the id
   * the gate addresses has to be recovered from it. Newest-first and matched
   * on the payload's own identity — a thread can already carry other
   * declarations, and holding the wrong one would take somebody else's live
   * ask off the queue.
   */
  function commentBearing(thread: Thread, review: ReviewPayload): string | undefined {
    for (let i = thread.comments.length - 1; i >= 0; i--) {
      const c = thread.comments[i];
      if (c?.review === review || (c?.review && c.review.headline === review.headline)) {
        return c.id;
      }
    }
    return undefined;
  }

  /**
   * The hold on a declaration, read back off what is STORED.
   *
   * For the deduplicated request, which never ran the filing closure and so
   * holds no gate of its own while the first request's verdict is already on
   * the comment. Answering that request without `held` would tell a retrying
   * client its filing was accepted and leave it waiting on a reader who
   * cannot see the item (codex review). Both callers await the same closure,
   * so by the time this runs the verdict is recorded.
   *
   * `undefined` for anything that is not a live hold — no declaration, no
   * recoverable comment, a verdict that passed.
   */
  function recordedThreadHold(
    docId: string,
    thread: Thread,
    review: ReviewPayload | undefined,
  ): ThreadReviewGate | undefined {
    if (!review) return undefined;
    const commentId = commentBearing(thread, review);
    if (commentId === undefined) return undefined;
    const stored = thread.comments.find((c) => c.id === commentId)?.review;
    if (!stored || !isReviewPayloadHeld(stored) || stored.judge === undefined) return undefined;
    const reason = stored.judge.reason;
    return {
      held: true,
      review: stored,
      reason,
      message: heldMessage({ kind: 'thread', docId, threadId: thread.id, commentId }, reason),
    };
  }

  /**
   * File a comment-borne declaration through the gate, then announce it only
   * if it passed.
   *
   * ONE funnel for the routes that can write one — `create_thread`,
   * `threads/by_find`, `post_reply` — because "judged, then announced, in
   * that order" is the rule that keeps a held item off every surface at
   * once. A push whose title is the item's headline says "here is something
   * to review"; sending it for an item the reader's queue omits is the exact
   * lie the gate exists to prevent.
   *
   * A comment whose id cannot be recovered is announced unjudged, which is
   * the same fail-open answer every other judge failure gets.
   */
  async function gateThreadDeclaration(
    docId: string,
    thread: Thread,
    review: ReviewPayload,
    author: User,
  ): Promise<ThreadReviewGate> {
    const commentId = commentBearing(thread, review);
    if (commentId === undefined) {
      announceThreadReview(docId, thread.id, review, author);
      return { held: false, review };
    }
    const gate = await judgeThreadReview(docId, thread.id, commentId, review, author);
    if (!gate.held) announceThreadReview(docId, thread.id, gate.review, author);
    return gate;
  }

  /** The same, for a declaration that hangs on a TICKET rather than a
   *  comment. Both land in the reviewer's queue, so both are announced. */
  function announceTaskReview(task: Task, item: TaskReviewItem, author: User): void {
    announceReviewItem({
      ask: item.review.headline,
      context: task.title,
      askedBy: author.name,
      url: `${externalBaseUrl()}${taskDeepLink(task.workspaceId, task.id)}`,
      key: `${task.id}:${item.id}`,
    });
  }

  /** The paste-ready call that ends a hold, per surface. One spelling, used by
   *  the tool result, the filer's wake and the stall report alike — three
   *  copies of an address is how one of them ends up naming a verb that
   *  refuses. */
  function reviseCallFor(address: ReviewGateAddress): string {
    switch (address.kind) {
      case 'task':
        return `revise_review_item(taskId="${address.taskId}", reviewItemId="${address.reviewItemId}")`;
      case 'decision':
        return `revise_review_item(taskId="${address.taskId}")`;
      default:
        return `revise_review_item(docId="${address.docId}", threadId="${address.threadId}", commentId="${address.commentId}")`;
    }
  }

  /**
   * The one sentence a reader is given about an item the gate stopped
   * holding — never a fresh reason.
   *
   * It quotes the FIRST hold, deliberately. That reason is the only one in
   * the history the judge cannot have contradicted with a later one, and
   * repeating it is what makes "we stopped holding this" a statement about a
   * standing concern rather than a fourth opinion.
   */
  function admittedReason(heldFor: string[]): string {
    // The clause form — the judge's own words with the trailing full stop
    // taken off, so the sentence built around them has exactly one.
    const first = judgeReasonClause(heldFor[0] ?? '');
    if (first === '') return `Admitted to the queue after ${REVIEW_GATE_MAX_HOLDS} holds.`;
    return `Admitted to the queue after ${REVIEW_GATE_MAX_HOLDS} holds; the standing concern is unchanged — ${first}.`;
  }

  /** What a filing route says when the gate held the item. Points at the
   *  fix rather than only at the verdict: the filer's next act is one call. */
  function heldMessage(
    address: ReviewGateAddress,
    reason: string,
    add?: string,
    /** How many holds this item now carries, THIS one included. */
    holds = 0,
  ): string {
    // At the cap, "it reaches the queue when it passes" stops being the whole
    // truth — the next revision reaches the reader whether it passes or not.
    // Saying so is the difference between a filer making one more edit and a
    // filer bracing for a fourth round and giving up instead.
    const last = holds >= REVIEW_GATE_MAX_HOLDS;
    return (
      `Held off the reader's queue — ${judgeReasonSentence(reason)} ` +
      // The draft, when the judge wrote one. A hold that names the words is
      // one edit away from passing; a hold that names a category is a guess.
      (add ? `Add this sentence: “${add}” ` : '') +
      `It is on the ${address.kind === 'thread' ? 'thread' : 'ticket'}; revise it with ${reviseCallFor(address)}. ` +
      (last
        ? 'This is the last hold: the next revision goes to the reader either way.'
        : 'Every revision is judged again, and the item reaches the queue when it passes.')
    );
  }

  /** Process-wide: a judge that throws is named once, not once per filing. */
  let warnedJudgeThrew = false;

  /**
   * One review item as the gate needs to see and write it — the seam that
   * lets a TICKET item and a COMMENT-borne one run the same gate.
   *
   * It exists because "gated" must not become two rules. The gate shipped for
   * the ticket form alone, and the fleet rule tells every peer to file asks
   * with `create_thread(review=…)` — so the documented path reached the
   * reader's queue with the judge called zero times, and the confidence the
   * gate produced was confidence it had not earned. A second implementation
   * for the second surface would have re-created that gap one drift at a
   * time; this way there is one order of operations, one failure policy, and
   * one shape of hold, and a route only says where the words live.
   *
   * `T` is the surface's own row — a `TaskReviewItem` or a bare
   * `ReviewPayload` — so a caller gets back the thing it already holds.
   */
  interface ReviewGateTarget<T> {
    workspaceId: string;
    /** How the filer addresses the fix. See `ReviewGateAddress`. */
    address: ReviewGateAddress;
    /** The ticket's or the doc's name — what the wake calls the thing the
     *  item hangs on. */
    title: string;
    /** The row as it stands NOW, re-read from the store. `undefined` means it
     *  has gone. */
    current: () => T | undefined;
    words: (row: T) => ReviewPayload;
    version: (row: T) => number;
    held: (row: T) => boolean;
    judgement: (row: T) => ReviewItemJudgement | undefined;
    /** Conditionally stamp a verdict — refuses on `stale`, on an answered
     *  row, and on a row that has gone. */
    record: (
      judgement: ReviewItemJudgement,
      opts: { forVersion?: number; forPendingAt?: number },
    ) => { ok: true; row: T } | { ok: false };
    /** Whatever the surface must do once a verdict is durable — refresh the
     *  projection, broadcast, both. Called only on a write that landed. */
    settled: (row: T) => void;
  }

  type GateOutcome<T> =
    | { held: false; row: T }
    | { held: true; row: T; reason: string; message: string };

  /**
   * Put a filed or revised review item through the quality gate — the ONE
   * implementation, whichever surface the item was filed on.
   *
   * ONE call, no retries, and every failure is a pass: no judge configured,
   * a judge that answers `null`, a judge that throws — the item goes through
   * and the record says `unavailable` (Bryan, 2026-08-29: don't refuse; never
   * block on the judge being down). A hold records the verdict on the item,
   * keeps it off the queue (`review-queue.ts` skips a gated row on either
   * surface), and wakes the FILER — addressed, the way `review_answered`
   * wakes the lead — with which item, why, and the exact call that lifts it.
   * The lead is not told here: an item held for five minutes reaches the lead
   * through the stall loop.
   *
   * Returns the row as recorded, so a route hands back the verdict it just
   * made rather than the pre-judgement row.
   */
  async function runReviewGate<T>(
    target: ReviewGateTarget<T>,
    row: T,
    author: { id: string; name: string; kind?: string },
  ): Promise<GateOutcome<T>> {
    const judge = opts.reviewJudge;
    const criteria = taskStore.reviewItemCriteria(target.workspaceId);
    if (!judge || !criteria) {
      // Gate off. An UNHELD item is left unjudged, as before the gate
      // existed. A held one — held by a judge that has since been turned
      // off or lost its key — is released on this revision, or it would
      // stay off the reader's queue with nothing left that could clear it
      // (codex review).
      if (!target.held(row)) return { held: false, row };
      const released = target.record(
        { at: Date.now(), verdict: 'unavailable', reason: 'the judge is off' },
        {},
      );
      if (released.ok) target.settled(released.row);
      return { held: false, row: released.ok ? released.row : row };
    }
    // The words this verdict will be about. A revision landing while the
    // judge is out gets its own call; this one's verdict must not be
    // stamped onto words it never read (codex review).
    const forVersion = target.version(row);
    // Every reason this item has been held for already. Read off the ROW, so
    // it survives the revision that produced this call: the gate is a check
    // and not a wall precisely because this number stops growing.
    const priorJudgement = target.judgement(row);
    const heldFor = priorJudgement?.heldFor ?? [];
    // Off the queue from THIS moment, not from the verdict: the item is
    // already in the store, and the seconds the judge takes were seconds the
    // reader could see — and answer — an item about to be held (codex
    // review). `pending` is what the queue reads meanwhile; the ticket says
    // nothing about it.
    const pendingAt = Date.now();
    target.record(
      {
        at: pendingAt,
        verdict: 'pending',
        reason: 'being judged',
        ...(heldFor.length > 0 ? { heldFor } : {}),
      },
      { forVersion },
    );
    const words = target.words(row);
    let verdict: ReviewJudgeVerdict | null = null;
    try {
      verdict = await judge({
        criteria: criteria.value,
        item: {
          headline: words.headline,
          ...(words.detail !== undefined ? { detail: words.detail } : {}),
          ...(words.options !== undefined ? { options: words.options } : {}),
          ...(heldFor.length > 0 ? { priorHolds: heldFor } : {}),
        },
      });
    } catch (err) {
      if (!warnedJudgeThrew) {
        warnedJudgeThrew = true;
        console.error(
          '[review-gate] judge threw; items pass through:',
          err instanceof Error ? err.message : err,
        );
      }
      verdict = null;
    }
    const at = Date.now();
    const carried = heldFor.length > 0 ? { heldFor } : {};
    /**
     * A judge that could not answer must not ADMIT a held item.
     *
     * Fail-open is Bryan's rule and it stands: an item nobody has judged
     * goes through when the judge is down. But an item already HELD is a
     * different fact, and releasing it on a failed call made every hold
     * clearable by revising until a call timed out or a reply truncated.
     * So a failure keeps the standing verdict, stamp and history exactly as
     * they were — the hold's own clock does not restart either, or a judge
     * failing repeatedly would hide the item from the stall monitor forever.
     */
    const restoredHold =
      verdict === null && priorJudgement?.verdict === 'held' ? priorJudgement : undefined;
    // The cap. A third hold is not placed: the item goes to the reader with
    // the concern the gate has been making all along, and the reader decides
    // whether it is answerable. Two rounds is a check; a third is the wall
    // the peer walked into, and a gate that can refuse forever is a gate
    // agents route around.
    const admitAfterHolds =
      verdict !== null && !verdict.ok && heldFor.length >= REVIEW_GATE_MAX_HOLDS;
    const judgement: ReviewItemJudgement =
      restoredHold !== undefined
        ? { ...restoredHold }
        : verdict === null
          ? {
              at,
              verdict: 'unavailable' as const,
              reason: 'the judge could not answer',
              ...carried,
            }
          : admitAfterHolds
            ? { at, verdict: 'ok' as const, reason: admittedReason(heldFor), ...carried }
            : verdict.ok
              ? { at, verdict: 'ok' as const, reason: verdict.reason, ...carried }
              : {
                  at,
                  verdict: 'held' as const,
                  reason: verdict.reason,
                  heldFor: [...heldFor, verdict.reason],
                  ...(verdict.add !== undefined ? { add: verdict.add } : {}),
                };
    const recorded = target.record(judgement, {
      forVersion,
      // Also refused if the reader overruled the gate while we were out: a
      // release does not change the item's words, so the version still
      // matches and only the pending stamp tells us the row moved under us
      // (codex review).
      forPendingAt: pendingAt,
    });
    // A row the store would not stamp (answered under us, revised under us,
    // or the derived legacy row) is left exactly as it was. For a stale
    // verdict the revision's own judgement is the one that stands — so the
    // gate state handed back is read off the row as it is NOW, which may be
    // a hold the newer call just placed (codex review): saying "passed"
    // here would announce to the reader an item the queue still omits.
    if (!recorded.ok) {
      const current = target.current();
      if (current !== undefined && target.held(current)) {
        const reason = target.judgement(current)?.reason ?? '';
        return {
          held: true,
          row: current,
          reason,
          message: heldMessage(
            target.address,
            reason,
            target.judgement(current)?.add,
            target.judgement(current)?.heldFor?.length ?? 0,
          ),
        };
      }
      return { held: false, row: current ?? row };
    }
    // The projection carries `judge`, so the card can say "Held: …".
    target.settled(recorded.row);
    if (judgement.verdict !== 'held') return { held: false, row: recorded.row };
    const address = target.address;
    const frame: ReviewItemHeldFrame = {
      event: REVIEW_ITEM_HELD_EVENT,
      workspaceId: target.workspaceId,
      ...(address.kind === 'thread'
        ? { docId: address.docId, threadId: address.threadId, commentId: address.commentId }
        : { taskId: address.taskId }),
      revise: reviseCallFor(address),
      title: target.title,
      reviewItemId:
        address.kind === 'task'
          ? address.reviewItemId
          : address.kind === 'decision'
            ? LEGACY_REVIEW_ITEM_ID
            : address.commentId,
      headline: words.headline,
      reason: judgement.reason,
      ts: at,
    };
    sse.sendToAgent(`ws~${target.workspaceId}`, author.id, { ...frame });
    return {
      held: true,
      row: recorded.row,
      reason: judgement.reason,
      message:
        // A restored hold is not a new verdict on the new words, and saying
        // so is the difference between "you did not fix it" and "nobody
        // looked". The filer's next act is the same call either way.
        (restoredHold
          ? 'The judge could not answer, so this stays held on its standing verdict. '
          : '') +
        heldMessage(address, judgement.reason, judgement.add, judgement.heldFor?.length ?? 0),
    };
  }

  /**
   * The gate for an item filed on a TICKET — `add_review_item`, a `review`
   * on `create_tasks`, and every `revise_review_item` that follows.
   */
  async function judgeReviewItem(
    task: Task,
    item: TaskReviewItem,
    author: { id: string; name: string; kind?: string },
  ): Promise<ReviewGate> {
    const out = await runReviewGate<TaskReviewItem>(
      {
        workspaceId: task.workspaceId,
        address: { kind: 'task', taskId: task.id, reviewItemId: item.id },
        title: task.title,
        current: () => {
          const raw = taskStore.getTask(task.id)?.reviews?.find((r) => r.id === item.id);
          return raw ? readTaskReviewItem(raw) : undefined;
        },
        words: (row) => row.review,
        version: (row) => reviewItemVersion(row),
        held: (row) => isReviewItemHeld(row),
        judgement: (row) => row.judge,
        record: (judgement, o) => {
          const res = taskStore.recordReviewJudgement(task.id, item.id, judgement, {
            actor: author,
            ...(o.forVersion !== undefined ? { forVersion: o.forVersion } : {}),
            ...(o.forPendingAt !== undefined ? { forPendingAt: o.forPendingAt } : {}),
          });
          return res.ok ? { ok: true, row: res.item } : { ok: false };
        },
        settled: () => taskProjection.ensureWorkspace(task.workspaceId),
      },
      item,
      author,
    );
    return out.held
      ? { held: true, item: out.row, reason: out.reason, message: out.message }
      : { held: false, item: out.row };
  }

  /**
   * The gate for a ticket that IS the decision — `needs: 'decision'` with the
   * question in its own title and body, filed by `create_tasks` (single or
   * batch) and rewritten by every door that moves those words.
   *
   * The third surface, and the one the ticket for this work was written
   * about: a decision ticket reaches the reader's queue as the derived
   * `r-legacy` row, so before this it was the one filing path that put a row
   * in front of Bryan with the judge never called.
   *
   * Identical to the other two in everything a filer can observe — same
   * judge, same criteria, same fail-open policy, same `held` / `heldReason` /
   * `message`, same `workspace.review_item_held` wake. Two things differ, and
   * both follow from the row having no item of its own:
   *
   *  - the address is the TICKET (`revise_review_item(taskId=…)`), because
   *    there is no `reviewItemId` — minting one would make the ticket's own
   *    decision a second, competing row beside itself;
   *  - the version is `wordsRevisionOf`, not a count of revisions, because
   *    the words being judged are the row's own and every writer of them
   *    (the title route, the body route, this revise door) already moves it.
   */
  async function judgeTaskDecision(
    task: Task,
    author: { id: string; name: string; kind?: string },
  ): Promise<ReviewGate | undefined> {
    const derived = taskStore.listReviewItems(task.id).find((r) => r.id === LEGACY_REVIEW_ITEM_ID);
    // Not a decision — no derived row, so nothing is on the queue to hold.
    // `undefined` rather than a synthesised pass, so a caller cannot report
    // "judged and fine" about a ticket the judge was never asked about.
    if (!derived) return undefined;
    const out = await runReviewGate<TaskReviewItem>(
      {
        workspaceId: task.workspaceId,
        address: { kind: 'decision', taskId: task.id },
        title: task.title,
        current: () =>
          taskStore.listReviewItems(task.id).find((r) => r.id === LEGACY_REVIEW_ITEM_ID),
        words: (row) => row.review,
        version: () => wordsRevisionOf(taskStore.getTask(task.id) ?? task),
        held: (row) => isReviewItemHeld(row),
        judgement: (row) => row.judge,
        record: (judgement, o) => {
          const res = taskStore.recordDecisionJudgement(task.id, judgement, {
            actor: author,
            ...(o.forVersion !== undefined ? { forVersion: o.forVersion } : {}),
            ...(o.forPendingAt !== undefined ? { forPendingAt: o.forPendingAt } : {}),
          });
          return res.ok ? { ok: true, row: res.item } : { ok: false };
        },
        settled: () => taskProjection.ensureWorkspace(task.workspaceId),
      },
      derived,
      author,
    );
    return out.held
      ? { held: true, item: out.row, reason: out.reason, message: out.message }
      : { held: false, item: out.row };
  }

  /**
   * The gate for an item filed as a `review` payload ON A COMMENT —
   * `create_thread`, `threads/by_find`, `post_reply`, and the doc form of
   * `revise_review_item`.
   *
   * Identical to the ticket form in every respect a filer can observe: the
   * same judge, the same criteria, the same fail-open policy, the same
   * `held` / `heldReason` / `message` on the result, and the same
   * `workspace.review_item_held` wake. What differs is only the address the
   * hold names — `revise_review_item(docId=…, threadId=…, commentId=…)`,
   * which is why this could not be gated until that form existed.
   *
   * The item is addressed by `(docId, threadId, commentId)`, the identity the
   * queue already keys a doc-thread row on.
   */
  async function judgeThreadReview(
    docId: string,
    threadId: string,
    commentId: string,
    review: ReviewPayload,
    author: User,
  ): Promise<ThreadReviewGate> {
    const workspaceId = resolveWorkspaceForDoc(docId);
    // A doc no board claims has no criteria to judge against and no queue to
    // be held off. Passing it through is the same answer "gate off" gives.
    if (!workspaceId) return { held: false, review };
    const out = await runReviewGate<ReviewPayload>(
      {
        workspaceId,
        address: { kind: 'thread', docId, threadId, commentId },
        title: reviewThreadContext(docId),
        current: () =>
          rooms.getThread(docId, threadId)?.comments.find((c) => c.id === commentId)?.review,
        words: (row) => row,
        version: (row) => reviewPayloadVersion(row),
        held: (row) => isReviewPayloadHeld(row),
        judgement: (row) => row.judge,
        record: (judgement, o) => {
          const res = rooms.judgeCommentReview(docId, threadId, commentId, judgement, o);
          return res.ok ? { ok: true, row: res.review } : { ok: false };
        },
        // Nothing to project: the payload lives in the doc's own CRDT, and
        // `setCommentReview` has already broadcast it to everyone in the room.
        settled: () => {},
      },
      review,
      author,
    );
    return out.held
      ? { held: true, review: out.row, reason: out.reason, message: out.message }
      : { held: false, review: out.row };
  }

  /**
   * One create can put TWO things through the gate: the ticket's own decision
   * and a `review` payload filed with it. Both are judged — never one instead
   * of the other — and this is how both are reported through a response shape
   * that carries a single hold.
   *
   * The explicitly filed item leads, because it is the thing the caller wrote
   * a payload for. A second hold is not dropped: its own paste-ready call is
   * appended, so a caller that fixes only what the first sentence names is
   * still told the row has not arrived.
   */
  function mergedHold(
    filed: ReviewGate | undefined,
    decision: ReviewGate | undefined,
  ): ReviewGate | undefined {
    if (!filed?.held) return decision?.held ? decision : (filed ?? decision);
    if (!decision?.held) return filed;
    return {
      ...filed,
      message: `${filed.message} The ticket's own decision is held as well: ${decision.message}`,
    };
  }

  /**
   * Re-judge a ticket's own decision after its WORDS moved.
   *
   * The decision's words are the row's title, body and options, so every
   * door that rewrites those is a revision of it — `rewrite_task` most of
   * all. Without this a filer who fixed a held decision the obvious way
   * would leave the stale verdict standing and the row off the queue
   * forever: the hold is keyed on the item, and nothing else would ever ask
   * the judge again. That is the dead end the whole gate is written to avoid,
   * arriving through a different door.
   *
   * A no-op on a row that is not a decision. Announces the row exactly when
   * this edit is what released it, the same rule the revise door follows.
   */
  async function regateDecisionWords(taskId: string, author: User): Promise<void> {
    const task = taskStore.getTask(taskId);
    if (!task || task.needs !== 'decision') return;
    const wasHeld = taskStore
      .listReviewItems(taskId)
      .some((r) => r.id === LEGACY_REVIEW_ITEM_ID && isReviewItemHeld(r));
    const gate = await judgeTaskDecision(task, author);
    if (wasHeld && gate && !gate.held) announceTaskReview(task, gate.item, author);
  }

  /** The response fields a filing route adds when the gate held the item. */
  function heldFields(gate: ReviewGate | ThreadReviewGate | undefined): Record<string, unknown> {
    return gate?.held ? { held: true, heldReason: gate.reason, message: gate.message } : {};
  }

  /**
   * A person's QUESTION typed where an answer goes, turned into the ask it
   * is: a thread on the task doc anchored to the item, recorded on the item
   * WITH that thread — which is what takes the item off the reader's queue
   * (`reviewItemState` reads a threaded question as `waiting`) until the
   * owner revises it. ONE implementation for the two answer routes — the
   * review-item route and the task's own `/answer` — so a question typed
   * into a stored item's card and one typed into the ticket's own decision
   * card make the same thread and leave the queue by the same rule. `item`
   * may be the derived `r-legacy` row: its `id` addresses it on the store,
   * and its `detail` is the task body.
   *
   * The caller has already refused an ANSWERED item, which it can see on its
   * own row; everything else about the conversion is here.
   */
  async function askBackOnItem(
    task: Task,
    item: TaskReviewItem,
    text: string,
    author: User,
    visitor: boolean,
  ): Promise<Response> {
    // One open question at a time, the anchored ask's own rule: a second
    // would orphan the first, because revise only answers the newest
    // threaded question (`latestThreadedQuestion`).
    if (reviewItemState(item) === 'waiting') {
      const openThreadId = latestThreadedQuestion(item)?.threadId;
      const owner = item.createdBy.trim() || 'the owner';
      return j(409, {
        error: 'waiting',
        message: `Already waiting on ${owner} — add to the open thread instead`,
        ...(openThreadId !== undefined ? { threadId: openThreadId } : {}),
      });
    }
    // The question becomes a real thread on the item, exactly as a
    // phrase-anchored ask does — the thread is where the owner replies, and
    // what the card opens onto. It is about the WHOLE item, so the anchor
    // quotes the headline (offsets only if those words happen to sit
    // uniquely in the detail) and the recorded question carries no range:
    // there is no phrase to mark.
    const headlineRange = locateReviewItemRange(item.review.detail, {
      text: item.review.headline,
    });
    const created = await rooms.postComment(
      taskProjection.ensureBodyRoom(task),
      null,
      author,
      text,
      {
        kind: 'review-item',
        reviewItemId: item.id,
        snippet: { text: item.review.headline },
        ...(headlineRange?.start !== undefined && headlineRange?.end !== undefined
          ? { start: headlineRange.start, end: headlineRange.end }
          : {}),
      },
      { generate: !visitor },
    );
    if (!created) return j(500, { error: 'could not create thread' });
    // Re-checked in the same synchronous stretch as the record — the
    // `onlyIfUnanswered` discipline the fold path uses. The waiting check
    // above is a claim about a moment before the thread write's await, and
    // two readers can both pass it; recording both would bury the first
    // question where revise can never answer it (`latestThreadedQuestion`
    // reads only the newest). The loser is refused like any late asker; its
    // thread stays on the item as an ordinary comment — the reader's words
    // are user content, and this project does not delete those to tidy a
    // race (codex review).
    const now = taskStore.listReviewItems(task.id).find((r) => r.id === item.id);
    if (now && reviewItemState(now) === 'answered') {
      return j(409, {
        error: 'answered',
        message:
          'this item was answered while your question was being posted — it stands as a comment on the item; undo the answer first, or ask on the item’s thread',
      });
    }
    if (now && reviewItemState(now) === 'waiting') {
      const openThreadId = latestThreadedQuestion(now)?.threadId;
      const owner = now.createdBy.trim() || 'the owner';
      return j(409, {
        error: 'waiting',
        message: `Already waiting on ${owner} — your question was posted as a comment on the item; add to the open thread instead`,
        ...(openThreadId !== undefined ? { threadId: openThreadId } : {}),
      });
    }
    const asked = taskStore.requestMoreInfoOnReview(task.id, item.id, text, {
      actor: author,
      threadId: created.id,
    });
    if (!asked.ok) return j(asked.error === 'not-found' ? 404 : 400, asked);
    taskProjection.ensureWorkspace(asked.task.workspaceId);
    return j(200, {
      asked: true,
      task: asked.task,
      item: asked.item,
      threadId: created.id,
    });
  }
  return {
    announceTaskReview,
    announceThreadReview,
    recordedThreadHold,
    gateThreadDeclaration,
    reviseCallFor,
    judgeReviewItem,
    judgeTaskDecision,
    judgeThreadReview,
    mergedHold,
    regateDecisionWords,
    heldFields,
    askBackOnItem,
  };
}
