/**
 * A Review Item — the thing an agent DECLARES when it needs a person, as
 * opposed to the thing a server INFERS from prose.
 *
 * The queue this replaces asked "is the newest comment an agent's", which is
 * exactly what a finished exchange looks like: a person comments, an agent
 * fixes it, the agent replies "Done — shipped in #226", and nobody types
 * again. So the queue accumulated one permanent row per thing the agents got
 * RIGHT. Measured on this project's board 2026-08-18: 105 rows, 0 of them
 * decisions, 6 containing a question, 62 opening with a closing verb, and 93
 * of the 105 row TITLES clipped mid-sentence at the 200-character boundary
 * because the title was the agent's status note rather than anything written
 * to be a title.
 *
 * The detector is not the problem and a better one will not help — `asksPerson`
 * was carefully measured and its own header records the result (fires on 1 of
 * 86 real comments, misses 2 of 3 genuine questions). The problem is that the
 * agent knows perfectly well whether it is asking or reporting and has no way
 * to say so. This is that way.
 *
 * Pure and dependency-free on purpose: the MCP tool, the REST route and the
 * browser all check the same rule, and a second copy of a limit is how the
 * card ends up rendering something the API swore it had refused.
 */

/**
 * Two shapes, not three.
 *
 * Bryan named three — a structured decision; a brief review of a short piece
 * of text or mockup; a request to go review some links — and then said of the
 * last two: *"The last two are roughly the same thing."* He also gave them one
 * spec: a markdown summary under 150 words, inline links where needed, and one
 * open-ended markdown answer. So they differ in what the author puts in the
 * summary (an excerpt, or a link), not in anything this module, the API or the
 * card would do differently.
 *
 * Splitting them anyway would add a discriminator that changes no behaviour —
 * a second spelling of one value, which this codebase has already been bitten
 * by (see "A second spelling for the same value makes accidental duplicates
 * reachable" in docs/process/learnings.md). If a mockup later needs its own
 * embed, that is an additive field on `review`, not a third shape.
 */
export type ReviewShape = 'decision' | 'review';

export interface ReviewOption {
  /** Stable within the payload. Records WHICH candidate an answer came from;
   *  the answer itself is always the verbatim words, never the id. */
  id: string;
  /** Bold 1–3 words, per the spec. This is the button face. */
  label: string;
  /** Up to 50 words of markdown — what picking this one costs. */
  detail?: string;
}

/**
 * The payload an agent attaches to a comment.
 *
 * A TITLE AND A DETAIL, and nothing else. This carried two more authored
 * fields — a required `why` (line 2 of the row) and an advisory `lookFor`
 * ("what to review for") — from the first cut until 2026-08-25. Bryan, having
 * asked for their removal twice: *"I asked to get rid of this. It imposes a
 * structure that's too rigid and leaves not enough room to manouevwd. Title
 * and detail is enough."*
 *
 * The structure was the defect, not the length of it. Three prescribed slots
 * told every author how an ask had to be SHAPED before they knew what it was,
 * and the card then rendered all three as one markdown body anyway (see
 * `reviewItemBodyMarkdown`) — so the split bought the reader nothing and cost
 * the writer a form to fill in.
 *
 * The words already written under the old shape are not lost, and old callers
 * are not refused: `readReviewPayload` folds a legacy `why` / `lookFor` into
 * `detail`, on the write path and the read path alike.
 */
export interface ReviewPayload {
  shape: ReviewShape;
  /** The row title: what needs review. */
  headline: string;
  /**
   * The body — the ask's real context, markdown, inline links included. Aim
   * for ~50 words on a `decision` (context before the options), ~150 on a
   * `review`; both are targets, not gates, and only the sanity ceiling
   * (`REVIEW_LIMITS.detailMaxWords`) refuses. One field because it plays one
   * role; the card renders all of it, so the words here and the words the
   * reader sees are the same words.
   */
  detail?: string;
  /** `decision` only, at least two — a "choice" of one is a statement. */
  options?: ReviewOption[];
  /**
   * The option id a person's answer came from, stamped when they answered by
   * tapping rather than typing. Provenance only: the answer is the reply, and
   * the reply carries the words. Absent on a typed answer, which is not a
   * lesser answer.
   */
  answeredWith?: string;
  /**
   * When a person answered — stamped for EVERY answer, tapped or typed.
   *
   * This is what makes "answered" a fact about the item rather than a guess
   * about the conversation around it. The queue used to infer it from
   * adjacency ("a person spoke last"), which meant any remark in the thread
   * retired an unanswered question: the task panel's single composer derives
   * its destination as the newest comment's thread, so one line of "reading
   * this now" into a task an agent had just asked about deleted the card,
   * options and all, permanently and across a reload.
   *
   * `answeredWith` could not carry this on its own — it is absent on a typed
   * answer, and a typed answer is not a lesser answer. Both are read as
   * answered (see `reviewAnswered`), so an item answered by tapping before
   * this field existed stays answered.
   */
  answeredAt?: number;
  /**
   * Display name of who answered — the record's face. "Answered by you: …"
   * has to survive a reload, and the reply comment alone cannot carry it:
   * the reply is one comment among many, and nothing marks it as THE answer
   * once a follow-up lands under it. No actor ids in projected state, so
   * this is the name, same as every other `by` in this module.
   */
  answeredBy?: string;
  /** The verbatim words of the answer, duplicated from the reply comment so
   *  the record renders without re-deriving which reply was the answer. */
  answerText?: string;
  /**
   * Answers that were UNDONE (or displaced by a later answer), oldest first —
   * the soft-delete half of the stamps above, mirroring the task decision's
   * `answerHistory`. An undo moves the four answer fields here rather than
   * dropping them: the words are user content, and this project does not
   * hard-delete user content. Nothing reads this to decide anything —
   * `reviewAnswered` still reads only the live stamps — which is what keeps
   * the record cheap to keep.
   */
  answerHistory?: ReviewAnswerUndone[];
  /**
   * What this item said BEFORE each revision, oldest first — the same record
   * `TaskReviewItem.revisions` keeps, in the same type, for the same reason.
   *
   * It lives on the PAYLOAD as well as on the task-side wrapper because a
   * review item raised on a DOC THREAD is a bare payload on a comment: it has
   * no wrapper to hang history on, so before this field the only way to
   * correct a doc-thread ask was to file a second one, leaving the reader's
   * queue carrying two items about one question with the older, wronger one
   * still reading as live. The superseded words are user content the reader
   * may already have read, so they are kept, never overwritten.
   *
   * A task-side item stores its history on the wrapper, not here — one
   * spelling per surface, and `reviewPayloadRevision` reads whichever the
   * caller holds.
   */
  revisions?: ReviewItemRevision[];
  /**
   * When the ASKER took this item back, and who. A withdrawn item is retired
   * without anybody having answered it.
   *
   * This is the one move an agent had no way to make. An ask that turns out
   * to be wrong can be revised (`applyReviewRevision`), and an ask a person
   * settles is answered — but an ask that should never have been asked, or
   * that a later ask replaced, had only two exits: fabricate an answer the
   * reader never gave, or resolve the whole thread and take every other ask
   * on it down with it. Measured on a real doc thread 2026-08-29: two asks on
   * one thread, the stale one unreachable, and the correct numbers left in a
   * plain comment underneath because neither exit was honest.
   *
   * Soft, like everything else here: the words stay, verbatim and readable,
   * because a reader may already have read them. Only the item's standing
   * changes — `pendingDeclaration` steps over it, the queue stops carrying
   * it, and the doc renders it as retracted rather than as a live question.
   * `reinstateReview` puts it back.
   */
  withdrawnAt?: number;
  /** Display name of who withdrew it. No actor ids in projected state. */
  withdrawnBy?: string;
  /**
   * One line on WHY, shown with the retracted item. Optional, and worth
   * writing: the reader is looking at an ask they may have been about to
   * answer, and "superseded by the item below" is the difference between a
   * disappearance and a correction.
   */
  withdrawnReason?: string;
}

/** One undone answer: the stamps as they stood, plus who took them back and
 *  when. `answeredAt` is 0 for a legacy tap that predates the stamp. */
export interface ReviewAnswerUndone {
  answeredAt: number;
  answeredBy?: string;
  answerText?: string;
  answeredWith?: string;
  undoneAt: number;
  undoneBy: string;
}

/**
 * Has a person answered this item?
 *
 * One predicate, because the queue, the card and any future surface must not
 * each decide it — and because the two stamps mean the same thing arriving by
 * two routes: `answeredAt` on every answer since it existed, `answeredWith`
 * alone on an option tapped before it did.
 */
export function reviewAnswered(review: ReviewPayload): boolean {
  return review.answeredAt !== undefined || review.answeredWith !== undefined;
}

/**
 * Has the ASKER taken this item back?
 *
 * The counterpart to `reviewAnswered`, and separate from it on purpose: both
 * retire an item, and which one happened is exactly what the reader needs to
 * see. An answered item records a decision; a withdrawn one records that no
 * decision was ever needed. Collapsing them into one "closed" flag would make
 * the queue's history unable to tell "you settled this" from "we retracted
 * this", which is the difference between work done and work undone.
 */
export function reviewWithdrawn(review: ReviewPayload): boolean {
  return review.withdrawnAt !== undefined;
}

/**
 * Legacy authored text, folded into one body — `why`, then `lookFor`, then
 * `detail`, blank-line separated, empty parts omitted.
 *
 * This WAS the card's composition step: the payload carried three authored
 * fields and every surface joined them here so none could render a part the
 * others dropped. Now that the payload carries one, the join has one job left,
 * and it is a migration rather than a layout: text an OLD caller sends and
 * text already sitting in a `.ydoc` arrives under the retired names, and both
 * have to come out as words the reader sees. `readReviewPayload` is the only
 * caller — one funnel, so a folded read and a folded write cannot disagree.
 *
 * The order is the order the card used to render them in, so a stored item
 * reads today exactly as it read yesterday.
 */
function foldLegacyBody(why: unknown, lookFor: unknown, detail: unknown): string | undefined {
  const body = [why, lookFor, detail]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part !== '')
    .join('\n\n');
  return body === '' ? undefined : body;
}

/**
 * The item's ONE body, as markdown.
 *
 * Now just `detail` — every payload reaching a renderer has been through
 * `readReviewPayload`, which folded any legacy `why`/`lookFor` into it. Kept
 * as a named function rather than inlined because THREE surfaces show the same
 * item (Home's walkthrough, the task panel, the doc thread) and "what the body
 * is" is exactly the thing they must not each decide for themselves.
 */
export function reviewItemBodyMarkdown(review: Pick<ReviewPayload, 'detail'>): string {
  return review.detail?.trim() ?? '';
}

/**
 * The declaration on this thread that nobody has answered, or null.
 *
 * ONE rule, read by every surface. The server's queue (review-queue.ts) and
 * the doc panel's reply box (threads.ts) each need to answer "which item is
 * pending on this thread", and for one release they answered it differently —
 * the doc panel scanned raw array order, skipped answered declarations to
 * find buried ones, and ignored thread status, so it could render a full
 * Answer composer for an item Home had already retired. Answering it stamped
 * a comment no queue was offering. Both halves import this now; a second
 * copy of the rule is how they drift again.
 *
 * The rule itself, unchanged from the server's:
 *
 * - The NEWEST declaration decides, and only it. An agent that asks again
 *   has moved on from what it asked before, so an older unanswered payload
 *   buried under a newer answered one is history rather than a live question.
 * - By time, not by array position. Comment order in a Yjs array is a CRDT's
 *   merge order, not a clock — "the last element" answers a question about
 *   array layout, not about who spoke last.
 * - A withdrawn declaration is stepped over, not stopped at. The newest ask
 *   decides only while it stands; one the asker took back has no claim on the
 *   thread, so the search continues underneath it.
 * - A non-open thread has nothing pending: an authored ask is retired by an
 *   ANSWER (`reviewAnswered`), by its ASKER withdrawing it
 *   (`reviewWithdrawn`), or by its thread being resolved, and by nothing
 *   else.
 *
 * `null` means "nothing here to answer" — an ordinary thread, a retired one,
 * or one whose newest ask is settled — and the caller posts a plain comment.
 * That is the honest fallback rather than a default target: inventing one
 * would let a remark stamp an answer nobody gave.
 *
 * Generic over the comment shape (rather than importing `Comment`) so this
 * module stays pure and dependency-free — the MCP tool, the REST route and
 * the browser all check the same rule.
 */
export function pendingDeclaration<C extends { ts: number; review?: ReviewPayload }>(thread: {
  status: string;
  comments?: ReadonlyArray<C>;
}): C | null {
  if (thread.status !== 'open') return null;
  const byTime = [...(thread.comments ?? [])].sort((a, b) => a.ts - b.ts);
  for (let i = byTime.length - 1; i >= 0; i -= 1) {
    const c = byTime[i];
    if (c?.review === undefined) continue;
    // A withdrawn ask supersedes nothing — it was taken back, so the thread
    // falls through to whatever it was asking before. This is the only way an
    // older ask can come back into view, and it is deliberate: it is what
    // lets an agent that filed a correction as a SECOND item on the thread
    // clean up after itself, withdrawing the stale one and leaving the live
    // one answerable, without resolving the thread they share.
    if (reviewWithdrawn(c.review)) continue;
    return reviewAnswered(c.review) ? null : c;
  }
  return null;
}

/**
 * Is this person's plain reply the ASK's answer, and which option did it come
 * from?
 *
 * The gap this closes was measured on this project's own stored docs: 152
 * comment-borne declarations, 123 of them answered, and 12 unanswered ones
 * with a person's reply sitting directly underneath. The answer path is not
 * unused and a better queue would not help — three surfaces render an Answer
 * composer and route to the answer endpoint, and every OTHER door a reply can
 * come through (a task panel's discussion composer, a widget, an agent
 * relaying words, an older bundle) posts a plain comment. On those doors a
 * person answers in their own words and the row stays queued behind them.
 *
 * So the reply is read as the answer — but only where reading it that way
 * cannot INVENT one:
 *
 * - **Nothing offered → the words are the answer.** An open question has no
 *   vocabulary of its own; prose is the only shape its answer can take, and a
 *   person who typed prose under it has answered it.
 * - **Options offered → only the label answers.** A decision's options ARE
 *   the answer's vocabulary, and prose under one is as often a question back
 *   ("is there a reason to trigger it?") as a pick. Guessing which option
 *   prose meant is the regression this codebase already shipped once, when
 *   "a person spoke" was itself the record of an answer and one line of small
 *   talk retired a decision and took its card with it. Typing the label is
 *   still a pick, because that is how a person picks with no buttons in front
 *   of them — a phone keyboard, a widget, an agent passing the words along.
 *
 * Trimmed and case-folded, and nothing looser. Anything fuzzier is the
 * inference the second rule exists to refuse. Measured against the 12: this
 * captures the 4 with no options, and leaves the 8 prose answers on decisions
 * where they are — visible, unanswered, and a decision for the owner rather
 * than a guess by the server.
 *
 * `null` means "this reply answered nothing" and the caller posts an ordinary
 * comment. `{}` — an answer that picked no option — is not a lesser answer;
 * see `answeredWith`.
 */
export function answerFromReply(review: ReviewPayload, text: string): { optionId?: string } | null {
  const words = text.trim();
  if (words === '') return null;
  // Keyed on what was OFFERED rather than on `shape`, because the options are
  // what a reader saw and could have typed back. A `decision` that carries
  // none offers no vocabulary, so prose is the only answer it could ever get.
  const options = review.options ?? [];
  if (options.length === 0) return {};
  // EXACTLY one, never the first of several. Trimming and case-folding is what
  // lets a person type a label back, and it is also what can make two DIFFERENT
  // options ("Yes" and " yes ") indistinguishable from the words typed. Taking
  // the first would stamp a coin toss as the reader's answer, on the one field
  // they cannot see is wrong. Zero matches and two matches are the same state
  // here — nothing was picked — and the words stay a comment on an item the
  // reader can still answer.
  const wanted = words.toLowerCase();
  const matches = options.filter((o) => o.label.trim().toLowerCase() === wanted);
  const picked = matches.length === 1 ? matches[0] : undefined;
  return picked ? { optionId: picked.id } : null;
}

/** A question asked back AT a review item instead of answering it. The item
 *  stays open and stays counted — that is the whole point of it being its own
 *  thing rather than an answer carrying a flag. */
export interface ReviewInfoRequest {
  text: string;
  /** Display name. No actor ids in projected state. */
  by: string;
  ts: number;
  /**
   * The thread the question was asked ON, when it was asked doc-style — by
   * selecting a phrase of the item and commenting on it (2026-08-29). The
   * question is then the thread's first comment, the owner answers by
   * replying there and revising the item, and this id is how the card finds
   * that conversation. Absent on a question typed into the old "tell me
   * more" box, which had no thread.
   */
  threadId?: string;
  /** The phrase the question was about, with its offsets into `detail` as
   *  it read at the time. Present exactly when `threadId` is. */
  range?: ReviewItemRange;
}

/** A phrase of an item's `detail`: the words, and where they were. Offsets
 *  are absent when the words could not be located uniquely. */
export interface ReviewItemRange {
  text: string;
  start?: number;
  end?: number;
}

/**
 * One SUPERSEDED reading of the item — what it said before a revision.
 *
 * Kept on the item rather than overwritten, for the same reason answers are:
 * the words were user content, and a reader who asked "what changed?" has to
 * be able to see. `threadId` names the question this revision answered when
 * there was one; `revisedRange` says where in the NEW text the change landed,
 * so the card can highlight it.
 */
export interface ReviewItemRevision {
  at: number;
  /** Display name of who revised. */
  by: string;
  /** The PREVIOUS text, verbatim. */
  headline: string;
  detail?: string;
  options?: ReviewOption[];
  threadId?: string;
  revisedRange?: { start: number; end: number };
}

/**
 * Compute one revision of a review item: what the new words are, and what the
 * old ones were.
 *
 * PURE, and shared by both surfaces on purpose. A ticket-borne item revises
 * through `TaskStore.reviseReviewItem`; a doc-thread item revises through the
 * doc route, and it arrived second. Writing "what a revision is" twice is how
 * the two would come to disagree about which patches are legal, where the
 * changed span is, or whether an answered item may be rewritten — so the
 * decision lives here once and each caller only decides WHERE to store the
 * result.
 *
 * Returns the new payload and the superseded reading. It deliberately does
 * NOT file `previous` anywhere: a task item keeps its history on the wrapper
 * (`TaskReviewItem.revisions`), a doc-thread item on the payload itself
 * (`ReviewPayload.revisions`, via `withRevision`), and only the caller knows
 * which it holds.
 */
export type ReviseReviewResult =
  | {
      ok: true;
      next: ReviewPayload;
      previous: ReviewItemRevision;
      /** The quality gate's gaps in the NEW words — the caller turns these
       *  into advice (`reviewGapAdvice`). Returned rather than re-derived, so
       *  the words that were judged are the words that were stored. */
      gaps: ReviewCheck['gaps'];
    }
  | {
      ok: false;
      error: 'answered' | 'withdrawn' | 'empty-patch' | 'bad-review' | 'bad-range';
      message?: string;
    };

export function applyReviewRevision(
  current: ReviewPayload,
  patch: { headline?: unknown; detail?: unknown; options?: unknown },
  opts: {
    by: string;
    at: number;
    revisedRange?: { start: number; end: number };
    threadId?: string;
  },
): ReviseReviewResult {
  // An answered item is not revised: the answer is an answer to the words it
  // had, and rewriting them under it leaves a reply to text nobody can see.
  //
  // This reads the PAYLOAD's own answer stamps, which is the whole story for
  // a doc-thread item. A ticket-borne one records its answer on the wrapper
  // instead (`TaskReviewItem.answer`), so that caller checks there as well —
  // this is not the only gate, and it is not meant to be.
  if (reviewAnswered(current)) {
    return {
      ok: false,
      error: 'answered',
      message:
        'this review item is already answered — the answer is to the words it has; raise a new item instead of rewriting these',
    };
  }
  // A withdrawn item is not revised either, for the mirror-image reason: its
  // words were retracted, and rewriting retracted words leaves the reader a
  // correction to something nobody is being asked about. Reinstate it first
  // (`reinstateReview`) if the ask is live again, or file a new one.
  if (reviewWithdrawn(current)) {
    return {
      ok: false,
      error: 'withdrawn',
      message: 'this review item was withdrawn — reinstate it before revising, or raise a new item',
    };
  }
  const touches = (['headline', 'detail', 'options'] as const).filter(
    (k) => patch[k] !== undefined,
  );
  if (touches.length === 0) return { ok: false, error: 'empty-patch' };

  const merged: Record<string, unknown> = { ...current };
  for (const k of touches) merged[k] = patch[k];
  const check = checkReviewPayload(merged);
  if (!check.ok) return { ok: false, error: 'bad-review', message: reviewPayloadMessage(check) };
  const next = readReviewPayload(merged);
  if (!next) return { ok: false, error: 'bad-review', message: reviewPayloadMessage(check) };

  // An explicit range is offsets into the NEW detail; one that runs past it
  // would be served to the queue as-is and highlight to the end of whatever
  // text is there. The derived range is bounded by construction.
  const detailLength = (next.detail ?? '').length;
  if (opts.revisedRange && opts.revisedRange.end > detailLength) {
    return {
      ok: false,
      error: 'bad-range',
      message: `revisedRange ${opts.revisedRange.start}\u2013${opts.revisedRange.end} runs past the new detail (${detailLength} characters)`,
    };
  }
  const range =
    opts.revisedRange ??
    (next.detail !== current.detail
      ? changedRange(current.detail ?? '', next.detail ?? '')
      : undefined);
  const previous: ReviewItemRevision = {
    at: opts.at,
    by: opts.by,
    headline: current.headline,
    ...(current.detail !== undefined ? { detail: current.detail } : {}),
    ...(current.options !== undefined ? { options: current.options } : {}),
    ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
    ...(range !== undefined ? { revisedRange: range } : {}),
  };
  return { ok: true, next, previous, gaps: check.gaps };
}

/** File a superseded reading onto the payload that carries its own history —
 *  the doc-thread half of `applyReviewRevision`. Appends, never replaces. */
export function withRevision(next: ReviewPayload, previous: ReviewItemRevision): ReviewPayload {
  return { ...next, revisions: [...(next.revisions ?? []), previous] };
}

/**
 * Take an item back, or put it back — the asker's own exit from its own ask.
 *
 * PURE and shared, for the same reason `applyReviewRevision` is: what
 * "withdrawn" means must not be decided twice. The doc route holds the only
 * write door today (a doc-thread item is a bare payload on a comment, which
 * is where the gap was measured), but every surface READS the stamp through
 * `reviewWithdrawn`, so the rule cannot be surface-local.
 *
 * The authored words are never touched by either direction. A withdrawal is a
 * change of standing, not a deletion: `headline`, `detail` and `options` read
 * afterwards exactly as they read before, which is what makes this a soft
 * retirement rather than an erasure of text a person may already have read.
 *
 * Refusals, both of them about not lying to the reader:
 *
 * - **answered** — a settled item is the record of a decision somebody made.
 *   Retracting it would take their answer off the board along with the
 *   question, and the asker does not get to un-ask something already
 *   answered. Undo the answer first if it was a mistake.
 * - **already-withdrawn / not-withdrawn** — a no-op, refused rather than
 *   silently accepted so a caller cannot overwrite the original `withdrawnAt`
 *   (and with it the record of when the reader stopped being asked) by
 *   repeating itself.
 */
export type WithdrawReviewResult =
  | { ok: true; next: ReviewPayload }
  | { ok: false; error: 'answered' | 'already-withdrawn' | 'not-withdrawn'; message: string };

export function withdrawReview(
  current: ReviewPayload,
  opts: { by: string; at: number; reason?: string },
): WithdrawReviewResult {
  if (reviewAnswered(current)) {
    return {
      ok: false,
      error: 'answered',
      message:
        'this review item is already answered — withdrawing it would retract an answer somebody gave; undo the answer first if it was a mistake',
    };
  }
  if (reviewWithdrawn(current)) {
    return {
      ok: false,
      error: 'already-withdrawn',
      message: 'this review item is already withdrawn',
    };
  }
  const reason = opts.reason?.trim();
  return {
    ok: true,
    next: {
      ...current,
      withdrawnAt: opts.at,
      withdrawnBy: opts.by,
      ...(reason !== undefined && reason !== '' ? { withdrawnReason: reason } : {}),
    },
  };
}

/**
 * Put a withdrawn item back in front of the reader.
 *
 * Clears the three stamps and nothing else. They are state rather than
 * content — the item's words never went anywhere — so dropping them loses no
 * authored text; the `withdrawnReason` goes with them because a reason for a
 * withdrawal that has been undone describes nothing that is still true.
 */
export function reinstateReview(
  current: ReviewPayload,
  _opts?: { by: string; at: number },
): WithdrawReviewResult {
  if (!reviewWithdrawn(current)) {
    return { ok: false, error: 'not-withdrawn', message: 'this review item is not withdrawn' };
  }
  const { withdrawnAt: _a, withdrawnBy: _b, withdrawnReason: _c, ...rest } = current;
  return { ok: true, next: rest };
}

/**
 * The reading this payload superseded most recently, or undefined if its
 * words have never changed (or it is closed, where "revised" is not the thing
 * the reader needs to see — the answer is).
 *
 * The payload-level twin of the `revisions?.at(-1)` the task queue reads. It
 * is what lets a doc-thread row say Revised and highlight the changed span
 * instead of arriving as an indistinguishable second ask.
 */
export function reviewPayloadRevision(review: ReviewPayload): ReviewItemRevision | undefined {
  if (reviewAnswered(review)) return undefined;
  return review.revisions?.at(-1);
}

/**
 * Where an item stands with the person it is waiting on.
 *
 *  - `open`     — nothing asked back; it is on the queue.
 *  - `waiting`  — a question was asked on it and the owner has not revised
 *                 since; it is OFF the queue, waiting on the owner.
 *  - `revised`  — the owner revised the words (after a question, or just
 *                 because); it is back on the queue, marked.
 *  - `answered` — closed.
 *
 * DERIVED, never stored, for the reason `isReviewItemOpen` gives: a status
 * field is a second spelling of facts the item already carries, free to
 * disagree with them. Here the facts are the thread each revision was made
 * against and the two clocks: a revision stamped with the latest question's
 * thread answers it, and so does one made strictly after it. The stamp
 * decides first because the clocks can TIE — a revision and the next
 * question in the same millisecond, measured four runs in five at the route
 * level — and a tie read by the clocks alone put the item back on the queue
 * with its new question unanswered.
 */
export type ReviewItemState = 'open' | 'waiting' | 'revised' | 'answered';

export function reviewItemState(item: TaskReviewItem): ReviewItemState {
  if (item.answer) return 'answered';
  const question = latestThreadedQuestion(item);
  const revision = item.revisions?.at(-1);
  if (question) {
    const answered =
      revision !== undefined &&
      (revision.threadId === question.threadId || revision.at > question.ts);
    if (!answered) return 'waiting';
  }
  if (revision) return 'revised';
  return 'open';
}

/** The newest question asked doc-style on the item, if any. */
export function latestThreadedQuestion(item: TaskReviewItem): ReviewInfoRequest | undefined {
  const reqs = item.infoRequests ?? [];
  for (let i = reqs.length - 1; i >= 0; i--) {
    const r = reqs[i];
    if (r?.threadId) return r;
  }
  return undefined;
}

/**
 * The span of `after` that differs from `before` — common prefix and suffix
 * trimmed — or undefined when nothing did. What the card highlights as the
 * revised phrase when the reviser did not say.
 */
export function changedRange(
  before: string,
  after: string,
): { start: number; end: number } | undefined {
  if (before === after) return undefined;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < max - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return { start, end: after.length - tail };
}

/**
 * Locate a phrase in the item's detail: the caller's offsets when they spell
 * the phrase, else the phrase's unique occurrence, else nothing (the snippet
 * still says what was meant). `null` means the caller's offsets are WRONG —
 * they point at other words — which is a refusal, not a fallback: a
 * highlight on the wrong phrase is worse than none.
 */
export function locateReviewItemRange(
  detail: string | undefined,
  range: { text: string; start?: number; end?: number },
): ReviewItemRange | null {
  const text = detail ?? '';
  if (range.start !== undefined && range.end !== undefined) {
    if (text.slice(range.start, range.end) !== range.text) return null;
    return { text: range.text, start: range.start, end: range.end };
  }
  const first = text.indexOf(range.text);
  if (first < 0 || text.indexOf(range.text, first + 1) >= 0) return { text: range.text };
  return { text: range.text, start: first, end: first + range.text.length };
}

/**
 * One review item ATTACHED to something — today a ticket.
 *
 * The cardinality is the change. A decision task used to BE a decision: one
 * `needs: 'decision'` flag and one embedded `options` array, so the ticket
 * title had to double as the question and a second open question had nowhere
 * to go. Bryan, 2026-08-18: *"For decisions, the ticket title is not the
 * decision. A decision is a part of a ticket, and there should be a decision
 * blurb above the options. And over time, there may be more than one decision
 * associated with a ticket. In fact, at any point in time there might be
 * multiple open decisions for a ticket."*
 *
 * So a ticket HAS review items, 0..n, several possibly open at once, and each
 * one carries its own blurb — `review.headline` and `review.why` — above its
 * own `review.options`. The row is the entity; the ticket is what it hangs on.
 *
 * `review` is the same `ReviewPayload` a comment-borne declaration carries, on
 * purpose: two spellings of one concept is what this replaces, and a second
 * copy of the limits is how a card renders something the API swore it refused.
 */
/**
 * The VERBATIM words of an answer, plus which option they came from.
 *
 * Named rather than inlined because a superseded answer is the SAME thing as
 * the current one — it stopped being current, it did not stop being an answer
 * somebody wrote — and two shapes for that would be free to disagree.
 */
export interface ReviewItemAnswer {
  text: string;
  /** Display name. No actor ids in projected state. */
  by: string;
  ts: number;
  /** WHICH option the words came from, when one was tapped. Provenance, never
   *  the answer itself, which is why a typed answer carries none. */
  answeredWith?: string;
}

export interface TaskReviewItem {
  /** Stable within the thing it hangs on. Minted by the writer. */
  id: string;
  /** The blurb and the options — the whole declaration, one spelling. */
  review: ReviewPayload;
  createdAt: number;
  /** Display name of whoever raised it. */
  createdBy: string;
  /**
   * The VERBATIM words of the answer. `answeredWith` records WHICH option the
   * words came from when one was tapped — provenance, never the answer itself,
   * which is why it is optional on an answer that was typed.
   *
   * Its presence is what closes the item; see `isReviewItemOpen`.
   */
  answer?: ReviewItemAnswer;
  /**
   * Answers this one SUPERSEDED, oldest first.
   *
   * Answering twice is legal — a person changes their mind, a retry lands, two
   * people reach for the same row — but the words already recorded are user
   * content, and this project does not hard-delete user content. Overwriting
   * `answer` in place is a destructive edit nothing anywhere reports; moving
   * the old one here makes the same act reversible. Absent while there are
   * none, like every other optional field on this row.
   */
  priorAnswers?: ReviewItemAnswer[];
  /** "Tell me more", in order. Absent rather than empty while there are none. */
  infoRequests?: ReviewInfoRequest[];
  /** What the item said BEFORE each revision, oldest first. Absent while
   *  the words have never changed. See `ReviewItemRevision`. */
  revisions?: ReviewItemRevision[];
  /**
   * The quality gate's verdict on the CURRENT words — see
   * `ReviewItemJudgement`. Absent on an item filed before the gate existed,
   * or on a board with no judge configured; both read as "not held".
   */
  judge?: ReviewItemJudgement;
}

/**
 * What the quality gate said about the item's current words, and when.
 *
 * `held` is the one verdict that changes anything: the item stays on the
 * ticket and off the reader's queue until a revision is judged again. `ok`
 * is the ordinary case. `unavailable` records that the judge was asked and
 * could not answer — no key, a timeout, an unparseable reply — and the item
 * went through; it is kept so a later reader can tell "passed" from "never
 * judged" (Bryan's rule, 2026-08-29: don't refuse, and never block on the
 * judge being down).
 *
 * Recorded ON the item rather than derived, unlike `isReviewItemOpen`'s
 * facts, because it is the output of a call that cannot be re-run for free —
 * a second spelling would be a second call.
 */
export interface ReviewItemJudgement {
  /** When the verdict was made. The hold's clock: the stall monitor ages a
   *  held item from here. */
  at: number;
  verdict: ReviewJudgeVerdictKind;
  /** The judge's one sentence — on a hold, the gap to fix. May be empty. */
  reason: string;
}

/**
 * `pending` is the judge's call still out: stamped before the item is
 * exposed, so an item the judge is about to hold never flashes onto the
 * queue for the seconds the call takes. The server replaces it with the
 * verdict, and turns a `pending` it finds on disk at boot into
 * `unavailable` — a call that never came back is a pass, like any other
 * judge failure.
 */
export type ReviewJudgeVerdictKind = 'ok' | 'held' | 'unavailable' | 'pending';

const JUDGE_VERDICTS: ReadonlySet<string> = new Set(['ok', 'held', 'unavailable', 'pending']);

/**
 * Is this item HELD by the quality gate — filed, on the ticket, but kept off
 * the reader's queue until its filer revises it?
 *
 * An answered item is never held, whatever the verdict says: the answer is
 * the fact that closes an item (`isReviewItemOpen`), and a hold on a closed
 * item would be a second opinion about words somebody has already acted on.
 */
export function isReviewItemHeld(item: TaskReviewItem): boolean {
  return item.answer === undefined && item.judge?.verdict === 'held';
}

/**
 * The judge's reason as a CLAUSE — no trailing full stops — for the surfaces
 * that carry on the sentence after it ("… — the agent has been asked to
 * revise it").
 *
 * The judge writes a sentence, and every caller that appended to one produced
 * doubled punctuation: the ticket note read "…rather than 'see below'. — the
 * agent has been asked…" and the filer's channel line read "…'see below'..
 * It has been held for 4m" (UX review, 2026-08-29). Only full stops are
 * stripped: a reason that ends in a question mark or an ellipsis is quoted as
 * it was written.
 */
export function judgeReasonClause(reason: string): string {
  return reason.trim().replace(/\.+$/, '').trimEnd();
}

/**
 * The judge's reason as its own SENTENCE — exactly one terminal mark — for
 * the surfaces that stop after it. `?`, `!` and `…` are left alone; anything
 * else gains a full stop, so a reason and the sentence after it never run
 * together either.
 */
export function judgeReasonSentence(reason: string): string {
  const clause = judgeReasonClause(reason);
  if (clause === '') return '';
  return /[?!…]$/.test(clause) ? clause : `${clause}.`;
}

/**
 * Is this item OFF the reader's queue because of the quality gate — held,
 * or still being judged? The queue asks this one; the ticket's "Held: …"
 * note asks `isReviewItemHeld`, because there is nothing to say about an
 * item whose verdict is seconds away.
 */
export function isReviewItemGated(item: TaskReviewItem): boolean {
  if (item.answer !== undefined) return false;
  const verdict = item.judge?.verdict;
  return verdict === 'held' || verdict === 'pending';
}

/**
 * Is this item still waiting on a person?
 *
 * Deliberately `answer === undefined` and nothing else. An info request is a
 * question asked back, not an answer, so an item with three of them is still
 * open — and a separate `status` field would be a second spelling of a fact
 * the answer already states, free to disagree with it.
 */
export function isReviewItemOpen(item: TaskReviewItem): boolean {
  return item.answer === undefined;
}

/**
 * Every limit in one place, exported so a card can show a counter that
 * cannot disagree with the gate.
 *
 * The unit mix is a rule, not an accident: **characters for the one-line row
 * field, words for bodies.** A row field's budget tracks RENDERED WIDTH — how
 * much fits one line on a phone — and width is a property of characters. A
 * body's budget tracks READING EFFORT, which is a property of words; the card
 * wraps, so width never enters into it.
 *
 * `why` (90) and `lookFor` (90) were removed with the fields themselves on
 * 2026-08-25. A published budget for a field that no longer exists is a rule
 * an author can still read and still obey.
 */
export const REVIEW_LIMITS = {
  /**
   * ~1 line at 430px/16px, where a line runs about 50 characters.
   *
   * ADVISORY since 2026-08-22, for the same reason the body targets became
   * advisory a day earlier: a budget here is a statement about RENDERED WIDTH,
   * and over-running it wraps the row. Refusing instead turned a rendering
   * imperfection into a failed filing — measured over one 24-hour window, six
   * honest asks were bounced over a 90-character row budget, each at the
   * moment an agent was routing an ask to the queue instead of to chat, and
   * each costing a retry to shave two words. A wrapped row is worse than a
   * tight one and far better than an ask that never got filed.
   */
  headline: 70,
  /**
   * The one one-line length that still refuses — the sanity ceiling for the
   * row field, the counterpart of `detailMaxWords` for a body. Well past
   * anything a model overshoots a 70-character budget by (the measured
   * over-runs sat at 92–102), so it bounces a paragraph pasted into a row and
   * nothing else. Shared by the option `label`, which is a row field wearing
   * a button.
   */
  lineMaxChars: 500,
  /**
   * Words of body, by shape — Bryan's numbers, verbatim, as the TARGET an
   * author should aim for. ADVISORY since 2026-08-21: exceeding a target no
   * longer refuses. It used to (a 400), and a real ask often carries three or
   * four verified facts before the question makes sense — so the full context
   * went into the thread body and a compressed copy into `detail`, the two
   * said different things, and the card (what Bryan acts from) was the weaker
   * one. The bug was never that 150 is small; it is that exceeding it pushed
   * content somewhere the card does not show.
   */
  detailTargetWords: { decision: 50, review: 150 },
  /**
   * The one detail length that still refuses — a sanity ceiling an honest ask
   * cannot reach (13x the review target), there to bounce a pasted document
   * or a runaway generation, never to compress a real question's context.
   */
  detailMaxWords: 2000,
  /** Advisory, like the row budgets above — a fourth word wraps a button, it
   *  does not break one. Refusing four-word labels was half the measured
   *  bounces this rule set produced. */
  optionLabelWords: 3,
  /** A 1–3 word label still has to fit a full-width button at 430px. */
  optionLabelChars: 28,
  optionDetailWords: 50,
  minOptions: 2,
  maxOptions: 6,
} as const;

/**
 * Something worth telling the author about a payload that WAS filed.
 *
 * Three families, and keeping them distinct is what makes the advice usable:
 * a bare field name means the field is ABSENT ("write one"), a `…Length` gap
 * means the field is there and runs long ("it will wrap"), and the two
 * `…Linkless` gaps mean the body is there but what it points at is not. Told
 * the same way, an author who wrote a 100-character headline would be advised
 * to write one.
 *
 * The two reachability gaps are the same defect caught from opposite sides.
 * `detailLinkless` reads the COMMENT the item rode in on: links exist, they
 * are in the wrong place. `lookAskLinkless` reads the ASK itself: it sends
 * the reader somewhere and no link exists anywhere. Only one is ever raised —
 * see `checkReviewPayload` — because they would otherwise say nearly the same
 * sentence twice, and the comment-borne one is the more actionable of the two.
 */
export type ReviewGap =
  | 'detail'
  | 'detailLinkless'
  | 'lookAskLinkless'
  | 'headlineLength'
  | 'optionLabelLength'
  | 'optionDetailLength';

export interface ReviewCheck {
  /** No refusal-grade problem. `errors` is empty exactly when this is true. */
  ok: boolean;
  /** Refusals, each phrased to tell a retrying model what to write instead. */
  errors: string[];
  /** Present-but-thin. Advice on a SUCCESSFUL create, never a refusal. */
  gaps: ReviewGap[];
}

function words(s: string): number {
  const t = s.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Does this text give a reader somewhere to go?
 *
 * Two forms, because those are the two an agent writes: an inline markdown
 * link, which is the house style for a workspace path, and a bare absolute
 * URL. A bare relative path deliberately does NOT count — nothing renders it
 * as a link, so a reader cannot act on it either.
 */
function hasLink(s: string): boolean {
  return /\[[^\]]*\]\([^)\s]+\)/.test(s) || /https?:\/\/\S/.test(s);
}

/**
 * Verbs of PERCEIVING. Deliberately a small closed class — this is the set of
 * things you can ask someone to do to an artifact without changing it — and
 * it is extended only with another verb of the same kind, never with the
 * nouns of whatever artifact is in fashion (`mockup`, `PR`, `staging`).
 * Matching artifact nouns is the over-fit: the vocabulary is open-ended, it
 * dates immediately, and it fires on asks that merely MENTION the thing.
 */
const PERCEIVE_VERBS =
  'look|read|review|check|see|watch|open|try|visit|browse|inspect|compare|test';

/**
 * Is this ask telling the READER to go and perceive something?
 *
 * Two constraints do the work, and both are about precision rather than
 * coverage — the cost asymmetry runs the other way from most checks. A false
 * positive spends one sentence in a tool result. A false NEGATIVE is Bryan
 * hunting for a link, which is the whole reason this exists. But advice that
 * fires on asks with nothing to link is worse than either: it trains agents
 * to skim past the channel, and then the true positives stop landing too.
 * So this is tuned to be quiet and right, not thorough.
 *
 * 1. The verb is in its BASE form. "Read the draft" is a directive; "I read
 *    the draft", "reviewed", "checking" are reports about work already done,
 *    and a report is the commonest way one of these words appears in a
 *    detail that needs no link at all. `\b` after the stem does this for
 *    free: "looked", "reviews" and "checking" have no boundary there.
 *
 * 2. The verb sits where a request sits — opening a sentence, a line or a
 *    bullet, or following an explicit request marker ("please", "can you",
 *    "take a"). A verb buried mid-clause is almost always narration.
 *
 * 3. It TAKES AN OBJECT: the next word introduces one, being a determiner, a
 *    pronoun, a possessive or a preposition. Position alone is not enough,
 *    because every word in the list above is also a noun or an adjective and
 *    card titles are written as noun phrases — "Open question: what should we
 *    call it?", "Review complete", "Test results" all opened with a listed
 *    word and all were advised to add a link to an artifact that does not
 *    exist (codex review). A noun use is followed by another noun; a
 *    directive is followed by the thing it directs you at.
 *
 * What it deliberately misses: an ask that implies a target without naming
 * the act ("thoughts on the new nav?"). Catching those means guessing, and
 * guessing fires on every open question — the "what should we call it?"
 * family, which is complete with nothing to link. A decision whose options
 * are described in full carries no directive either, and is silent here by
 * construction rather than by a special case.
 */
function asksReaderToLook(s: string): boolean {
  const opener = String.raw`^|[.!?;:)\]]\s+|\n\s*(?:[-*>]\s*)?`;
  const marker = String.raw`\b(?:please|kindly)\s+|\b(?:can|could|would|will)\s+you\s+(?:please\s+)?|\byou\s+(?:can|should|could|might|may)\s+|\b(?:take|have)\s+a\s+`;
  // What an object of the directive starts with: a determiner, a pronoun, a
  // possessive ("Bryan's draft"), or a preposition. Anything else after the
  // verb and the word was a noun.
  const object = String.raw`at|the|a|an|this|that|these|those|it|them|my|our|your|its|his|her|their|through|over|into|whether|both|each|either|[\w-]+'s`;
  return new RegExp(`(?:${opener}|${marker})(?:${PERCEIVE_VERBS})\\s+(?:${object})\\b`, 'i').test(
    s,
  );
}

/**
 * Is this payload shaped like something a person can act on from a phone?
 *
 * Two tiers, and the line between them is the one thing this module has to get
 * right. `decision-shape.ts` already learned it for decision task bodies: a
 * gate that demands everything makes filing a chore, and the predictable
 * response to a chore is to route around it — there, by filing the decision as
 * an action instead. So only what the ROW is made of refuses.
 *
 * - **Refused**: a missing `headline`, a line break inside it, a `decision`
 *   with fewer than two options, and anything past a sanity ceiling
 *   (`lineMaxChars` for the row field, `detailMaxWords` for a body). These are
 *   structural: the row cannot be built at all without them, and a ceiling is
 *   only ever reached by a pasted document. Note it refuses rather than
 *   truncating — clipping a headline is precisely how the title went back to
 *   being a sentence cut in half, and the author would never learn.
 * - **Advised**: a missing `detail`, and any LENGTH over a budget. Both make
 *   the card thinner or wider than it wants to be; neither makes it
 *   unreadable. Demanding another field for a two-word question is the chore
 *   that gets routed around, and so is bouncing a filing to shave two words
 *   off a row line — measured, six times in one day. So is a `detail` that
 *   carries no link while the comment beside it does: the ask is filed and
 *   answerable, it is only the reader's route to the work that is missing.
 *
 * `context.text` is the comment the declaration rode in on, when there was
 * one. It is the only reason this function can tell a self-contained card
 * from one whose links stayed behind in the comment; a ticket-borne item
 * passes none and is judged on the payload alone.
 *
 * As of 2026-08-25 there is exactly ONE required field, because there is
 * exactly one field the row is made of. A payload still carrying the retired
 * `why` / `lookFor` passes untouched: unknown keys were never refused, and an
 * unrestarted caller must not get a 400 from a rule it cannot know about.
 * Their text is not discarded either — `readReviewPayload` folds it into the
 * body on the way to storage.
 *
 * Every check is one-directional in the same sense as `checkDecisionShape`:
 * counting words can undercount a field somebody wrote well (a false gap, i.e.
 * noise on a good payload), never pass a field that is absent.
 */
/**
 * The one mapping between the agent-facing vocabulary and the stored one.
 *
 * Bryan renamed the field to `review_type` and the open-ended kind to
 * `"question"` (2026-08-21) so the value stops colliding with "review item",
 * the general term. The stored spelling stays `shape: 'review'` — ~168
 * persisted docs and every pre-rename bundle already say it, and a stored
 * vocabulary migration would rewrite records for no reader's benefit. So:
 * new spellings are accepted at every door and normalized here; old spellings
 * are accepted forever for the callers nobody can restart.
 */
export function normalizeReviewType(value: unknown): ReviewShape | undefined {
  if (value === 'decision') return 'decision';
  if (value === 'review' || value === 'question') return 'review';
  return undefined;
}

export function checkReviewPayload(input: unknown, context?: { text?: string }): ReviewCheck {
  const errors: string[] = [];
  const gaps: ReviewGap[] = [];
  const fail = (msg: string) => errors.push(msg);

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['review must be an object.'], gaps: [] };
  }
  const p = input;

  const shape = normalizeReviewType(p.review_type ?? p.shape);
  if (shape === undefined) {
    fail(
      "review.review_type must be 'decision' (a choice between named options) or 'question' (read this and tell me what you think). The legacy spellings — field 'shape', value 'review' — are accepted too.",
    );
  }

  const headline = p.headline;
  if (headline === undefined || (typeof headline === 'string' && headline.trim() === '')) {
    fail(
      `review.headline is required — one line saying what needs review, at most ${REVIEW_LIMITS.headline} characters. It is the row title; write it as a ticket title, not as the first sentence of a status note.`,
    );
  } else if (typeof headline !== 'string') {
    fail('review.headline must be a string.');
  } else {
    // A newline is a second line by definition, and the headline is one line.
    // Refusing here is what keeps the card's clamp from being the thing that
    // enforces it.
    if (/[\r\n]/.test(headline)) {
      fail('review.headline must be a single line — it contains a line break.');
    }
    // Length ADVISES up to the sanity ceiling. The budget describes how much
    // fits one line on a phone, and over-running it wraps the row — a
    // rendering imperfection, which refusing turned into a failed filing.
    const n = headline.trim().length;
    if (n > REVIEW_LIMITS.lineMaxChars) {
      fail(
        `review.headline is ${n} characters; past ${REVIEW_LIMITS.lineMaxChars} it is a paragraph, not a row. Put the context in review.detail — the card renders all of it — and leave one line here.`,
      );
    } else if (n > REVIEW_LIMITS.headline) {
      gaps.push('headlineLength');
    }
  }

  const detail = p.detail;
  if (detail === undefined || (typeof detail === 'string' && detail.trim() === '')) {
    gaps.push('detail');
  } else if (typeof detail !== 'string') {
    fail('review.detail must be a markdown string.');
  } else {
    // Length only refuses at the sanity ceiling. The shape targets in
    // REVIEW_LIMITS.detailTargetWords are advice the tool description gives,
    // not a gate: refusing at the target made authors split the ask — full
    // context in the thread, a compressed copy here — and the card showed the
    // weaker half. The card renders everything, so the honest move is to
    // accept the detail the author actually has.
    const n = words(detail);
    if (n > REVIEW_LIMITS.detailMaxWords) {
      fail(
        `review.detail is ${n} words; past ${REVIEW_LIMITS.detailMaxWords} it is a document, not a card. Keep the ask's real context here — the card renders all of it — and link out to anything book-length instead of pasting it.`,
      );
    }
    // Links that stayed in the comment. Only ever advised against a comment
    // that HAS some: an ask with nothing to point at is complete without one,
    // and advising every linkless detail would be noise on most of them.
    if (context?.text !== undefined && hasLink(context.text) && !hasLink(detail)) {
      gaps.push('detailLinkless');
    }
  }

  // The same reachability question asked of the ASK rather than of the
  // comment. `detailLinkless` needs a comment to compare against, so the
  // ticket-borne doors — add_review_item, create_tasks — passed nothing and
  // were judged on the payload alone, which meant they were never judged on
  // this at all (Bryan, 2026-08-21: an item asked him to go and look and the
  // card carried no link, so he had to hunt for it).
  //
  // Read across the headline AND the detail, in both directions: an ask can
  // be a look-ask in its one line, and a link anywhere in the payload is
  // somewhere to go. Never raised alongside `detailLinkless` — that one has
  // already said the more actionable half, and two sentences about one
  // missing link read as a scolding.
  const askText = `${typeof headline === 'string' ? headline : ''}\n${
    typeof detail === 'string' ? detail : ''
  }`;
  if (!gaps.includes('detailLinkless') && asksReaderToLook(askText) && !hasLink(askText)) {
    gaps.push('lookAskLinkless');
  }

  const options: unknown[] | undefined = Array.isArray(p.options) ? p.options : undefined;
  if (p.options !== undefined && !Array.isArray(p.options)) {
    fail('review.options must be an array.');
  } else if (options !== undefined) {
    if (shape === 'review' && options.length > 0) {
      fail(
        "review.options belong to a 'decision'. A 'review' item is answered in the person's own words.",
      );
    }
    if (options.length > REVIEW_LIMITS.maxOptions) {
      fail(
        `review.options has ${options.length} entries; at most ${REVIEW_LIMITS.maxOptions} fit a phone screen as full-width buttons.`,
      );
    }
    const seen = new Set<string>();
    options.forEach((raw, i) => {
      if (!isPlainObject(raw)) {
        fail(`review.options[${i}] must be an object with an id and a label.`);
        return;
      }
      const id = raw.id;
      if (typeof id !== 'string' || id.trim() === '') {
        fail(`review.options[${i}].id is required — a short stable id, unique within this item.`);
      } else if (seen.has(id)) {
        fail(`review.options[${i}].id '${id}' is used twice; option ids must be unique.`);
      } else {
        seen.add(id);
      }
      const label = raw.label;
      if (typeof label !== 'string' || label.trim() === '') {
        fail(
          `review.options[${i}].label is required — 1 to ${REVIEW_LIMITS.optionLabelWords} words.`,
        );
      } else if (label.trim().length > REVIEW_LIMITS.lineMaxChars) {
        // The label's own sanity ceiling; a button cannot hold a paragraph.
        fail(
          `review.options[${i}].label is ${label.trim().length} characters; past ${REVIEW_LIMITS.lineMaxChars} it is not a button face. Put the reasoning in the option's detail.`,
        );
      } else if (
        words(label) > REVIEW_LIMITS.optionLabelWords ||
        label.trim().length > REVIEW_LIMITS.optionLabelChars
      ) {
        // Advisory for the same reason the row budgets are: a fourth word
        // wraps a button, it does not break one.
        gaps.push('optionLabelLength');
      }
      const d = raw.detail;
      if (d !== undefined) {
        if (typeof d !== 'string') {
          fail(`review.options[${i}].detail must be a markdown string.`);
        } else if (words(d) > REVIEW_LIMITS.detailMaxWords) {
          fail(
            `review.options[${i}].detail is ${words(d)} words; past ${REVIEW_LIMITS.detailMaxWords} it is a document, not a note under a button.`,
          );
        } else if (words(d) > REVIEW_LIMITS.optionDetailWords) {
          gaps.push('optionDetailLength');
        }
      }
    });
  }

  if (shape === 'decision' && (options?.length ?? 0) < REVIEW_LIMITS.minOptions) {
    fail(
      `a 'decision' needs at least ${REVIEW_LIMITS.minOptions} options — a choice of one is a statement. If there is nothing to choose between, this is a 'review'.`,
    );
  }

  // Deduped: six over-long option labels are one thing to say, not six.
  return { ok: errors.length === 0, errors, gaps: [...new Set(gaps)] };
}

/**
 * The refusal as one string, written to land verbatim in an agent's context
 * the way `decisionShapeMessage` does — the caller that hit this is usually a
 * model that will retry from this text alone, so it has to say what to write
 * rather than only that something is wrong.
 */
export function reviewPayloadMessage(check: ReviewCheck): string {
  return [
    'This review item cannot be filed as written.',
    ...check.errors,
    'A review item is a row on a phone: one line saying what needs review, then the body. Post it as an ordinary comment instead if it is a status note — status notes are welcome and no longer enter the review queue.',
  ].join(' ');
}

/**
 * The advice half of the check, for a payload that WAS filed.
 *
 * `gaps` are computed on every successful write and were, in the first cut of
 * this feature, read by nobody — the call returned 200, the card came out
 * thinner than the author meant, and nothing connected the two. That is the
 * same shape as the refusal this module argues against: a defect the author
 * cannot see is a defect the author repeats. So the advice travels back on the
 * success response, phrased like the refusals are — what to write, not what
 * was wrong.
 *
 * Returns undefined when there is nothing to say, so a caller can spread it
 * and an ordinary well-formed item carries no extra field.
 */
export function reviewGapAdvice(gaps: ReviewGap[]): string | undefined {
  if (gaps.length === 0) return undefined;
  const thin: string[] = [];
  if (gaps.includes('detail')) {
    thin.push(
      'review.detail is missing — the markdown body under the header. Without it the card is a headline and two options with nothing behind them.',
    );
  }

  // The length half. Phrased as what it costs on the screen rather than as a
  // rule that was broken: these lengths FILED, and an author who reads this as
  // a refusal retries and files the ask twice.
  const long: string[] = [];
  if (gaps.includes('headlineLength')) {
    long.push(
      `review.headline runs past ${REVIEW_LIMITS.headline} characters, so it wraps instead of holding its line on a phone.`,
    );
  }
  if (gaps.includes('optionLabelLength')) {
    long.push(
      `An option label runs past ${REVIEW_LIMITS.optionLabelWords} words or ${REVIEW_LIMITS.optionLabelChars} characters, so the button wraps — the reasoning belongs in that option's detail.`,
    );
  }
  if (gaps.includes('optionDetailLength')) {
    long.push(
      `An option's detail runs past ${REVIEW_LIMITS.optionDetailWords} words; it sits under a button, so a reader skims it rather than reads it.`,
    );
  }

  // The reachability half. A card can be complete prose and still be a
  // dead end: Bryan, 2026-08-27, on an item whose diff and draft were links
  // in the comment — "Why wasn't the question content with links in the
  // review item, and i had to scroll down to the bottom of comments?"
  const unreachable: string[] = [];
  if (gaps.includes('detailLinkless')) {
    unreachable.push(
      'The comment carries links and review.detail carries none. The reader acts from the Home card, which renders the detail — not the comment under it — so every link they need belongs in review.detail as an inline markdown link.',
    );
  }
  if (gaps.includes('lookAskLinkless')) {
    unreachable.push(
      'This asks the reader to go and look at something, and nothing in the payload says where. The reader acts from the Home card, which renders the headline and review.detail and nothing else — so the thing you are asking them to look at belongs in review.detail as an inline markdown link.',
    );
  }

  return [
    ...(thin.length > 0 ? ['Filed. It will be thinner than it needs to be:', ...thin] : []),
    ...(long.length > 0 ? ['Filed. Some of it will not fit where it renders:', ...long] : []),
    ...(unreachable.length > 0
      ? ['Filed. Some of it cannot be reached from the card:', ...unreachable]
      : []),
  ].join(' ');
}

/**
 * A payload read back out of the CRDT, or undefined.
 *
 * Defensive for the reason `readStoredSummary` is: this value is synced to
 * every peer, no peer's write is authoritative, and a malformed object that
 * reaches a renderer is a crash on a page that never touched the doc (see "A
 * malformed anchor crashes a request that never touched the doc" in
 * learnings.md). Reading is deliberately LOOSER than writing — `checkReview
 * Payload` guards the door, this only guards against a shape that would throw,
 * so an item written before a limit changed still renders rather than
 * vanishing.
 *
 * It is also where the retired `why` / `lookFor` are RECOVERED. Both paths run
 * through here — the write path normalizes an incoming payload with it before
 * storing, every read path runs it on the way out — so folding their text into
 * `detail` here answers the two obligations the removal created with one
 * mechanism: an old bundle's write keeps every word its author typed, and the
 * thousands of payloads already in `.ydoc` state keep rendering in full
 * without anything rewriting stored docs. A reader cannot tell which field a
 * paragraph came from, which is the point — they are one body now.
 */
/**
 * The superseded-wording list, read back defensively.
 *
 * Shared by `readReviewPayload` and `readTaskReviewItem` because the two
 * surfaces keep the SAME record in the same type — a doc-thread item on its
 * payload, a ticket-borne one on its wrapper — and two parsers for one shape
 * is how they would drift. Absent rather than empty when nothing parses, like
 * every other optional list here.
 */
function readRevisions(value: unknown): ReviewItemRevision[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const revs: ReviewItemRevision[] = [];
  for (const raw of value) {
    if (!isPlainObject(raw)) continue;
    // The previous headline IS the record — a row without one preserves
    // nothing, so it is the only field that can drop a row.
    if (typeof raw.headline !== 'string') continue;
    const rev: ReviewItemRevision = {
      at: num(raw.at, 0),
      by: str(raw.by, ''),
      headline: raw.headline,
    };
    if (typeof raw.detail === 'string') rev.detail = raw.detail;
    const options = readReviewPayload({ headline: raw.headline, options: raw.options })?.options;
    if (options) rev.options = options;
    if (typeof raw.threadId === 'string' && raw.threadId !== '') rev.threadId = raw.threadId;
    const span = readSpan(raw.revisedRange);
    if (span) rev.revisedRange = span;
    revs.push(rev);
  }
  return revs.length > 0 ? revs : undefined;
}

export function readReviewPayload(value: unknown): ReviewPayload | undefined {
  if (!isPlainObject(value)) return undefined;
  const shape = normalizeReviewType(value.review_type ?? value.shape);
  if (shape === undefined) return undefined;
  const headline = value.headline;
  if (typeof headline !== 'string' || headline.trim() === '') return undefined;

  const out: ReviewPayload = { shape, headline };
  const detail = foldLegacyBody(value.why, value.lookFor, value.detail);
  if (detail !== undefined) out.detail = detail;
  if (typeof value.answeredWith === 'string') out.answeredWith = value.answeredWith;
  // Read back defensively like the rest: a peer could sync anything here, and
  // an item whose answer stamp arrived as a string must not read as answered
  // by accident — nor as unanswered, which would put it back on the queue.
  if (typeof value.answeredAt === 'number' && Number.isFinite(value.answeredAt)) {
    out.answeredAt = value.answeredAt;
  }
  // The answer record's face. Loose like everything here: a junk-typed value
  // is dropped rather than thrown, and the item still reads as answered (or
  // not) from the stamps above — these two only decorate the record.
  if (typeof value.answeredBy === 'string') out.answeredBy = value.answeredBy;
  if (typeof value.answerText === 'string') out.answerText = value.answerText;

  // Defensively, like the answer stamps above: `withdrawnAt` is what makes an
  // item read as retracted, so a junk-typed value must not retire a live ask —
  // nor revive a retracted one, which would put words the asker took back
  // back in front of the reader.
  if (typeof value.withdrawnAt === 'number' && Number.isFinite(value.withdrawnAt)) {
    out.withdrawnAt = value.withdrawnAt;
  }
  if (typeof value.withdrawnBy === 'string') out.withdrawnBy = value.withdrawnBy;
  if (typeof value.withdrawnReason === 'string') out.withdrawnReason = value.withdrawnReason;

  const payloadRevisions = readRevisions(value.revisions);
  if (payloadRevisions) out.revisions = payloadRevisions;

  if (Array.isArray(value.answerHistory)) {
    const history: ReviewAnswerUndone[] = [];
    for (const raw of value.answerHistory) {
      if (!isPlainObject(raw)) continue;
      // The undo stamps are what a history row IS — without them it records
      // nothing — so they are the only fields that can drop a row. The
      // answer-side fields degrade like they do on the live payload.
      if (typeof raw.undoneAt !== 'number' || !Number.isFinite(raw.undoneAt)) continue;
      if (typeof raw.undoneBy !== 'string') continue;
      if (typeof raw.answeredAt !== 'number' || !Number.isFinite(raw.answeredAt)) continue;
      const entry: ReviewAnswerUndone = {
        answeredAt: raw.answeredAt,
        undoneAt: raw.undoneAt,
        undoneBy: raw.undoneBy,
      };
      if (typeof raw.answeredBy === 'string') entry.answeredBy = raw.answeredBy;
      if (typeof raw.answerText === 'string') entry.answerText = raw.answerText;
      if (typeof raw.answeredWith === 'string') entry.answeredWith = raw.answeredWith;
      history.push(entry);
    }
    if (history.length > 0) out.answerHistory = history;
  }

  if (Array.isArray(value.options)) {
    const options: ReviewOption[] = [];
    for (const raw of value.options) {
      if (!isPlainObject(raw)) continue;
      if (typeof raw.id !== 'string' || typeof raw.label !== 'string') continue;
      const o: ReviewOption = { id: raw.id, label: raw.label };
      if (typeof raw.detail === 'string') o.detail = raw.detail;
      options.push(o);
    }
    if (options.length > 0) out.options = options;
  }
  return out;
}

/** A finite number, or the fallback. Metadata must not be able to drop a row:
 *  an item with an unreadable timestamp still has to render. */
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * A `TaskReviewItem` read back out of the CRDT, or undefined.
 *
 * Loose on the way out for the same reason `readReviewPayload` is, and with
 * the same line drawn in the same place: only what makes the row IDENTIFIABLE
 * can drop it. A row needs an id (something has to address an answer at it)
 * and a readable `review` (there is nothing to show without one). Everything
 * else degrades — a missing `createdBy` reads as unattributed rather than
 * making the item vanish from a queue somebody is waiting on.
 *
 * Never throws. This value is synced to every peer, no peer's write is
 * authoritative, and a malformed object reaching a renderer is a crash on a
 * page that never touched the doc.
 */
/** One answer record, read loosely. Shared by `answer` and `priorAnswers` so
 *  a superseded answer can never read differently from a current one. */
function readAnswer(value: unknown): ReviewItemAnswer | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.text !== 'string' || value.text.trim() === '') return undefined;
  const out: ReviewItemAnswer = { text: value.text, by: str(value.by, ''), ts: num(value.ts, 0) };
  if (typeof value.answeredWith === 'string') out.answeredWith = value.answeredWith;
  return out;
}

export function readTaskReviewItem(value: unknown): TaskReviewItem | undefined {
  if (!isPlainObject(value)) return undefined;
  const id = value.id;
  if (typeof id !== 'string' || id.trim() === '') return undefined;
  const review = readReviewPayload(value.review);
  if (!review) return undefined;

  const out: TaskReviewItem = {
    id,
    review,
    createdAt: num(value.createdAt, 0),
    createdBy: str(value.createdBy, ''),
  };

  // The words ARE the answer, so a record without them is not one — dropping
  // it leaves the item open, which is the safe direction: an item wrongly read
  // as answered disappears from the queue and nobody is told.
  const answer = readAnswer(value.answer);
  if (answer) out.answer = answer;

  if (Array.isArray(value.priorAnswers)) {
    const prior: ReviewItemAnswer[] = [];
    for (const raw of value.priorAnswers) {
      const read = readAnswer(raw);
      if (read) prior.push(read);
    }
    if (prior.length > 0) out.priorAnswers = prior;
  }

  if (Array.isArray(value.infoRequests)) {
    const reqs: ReviewInfoRequest[] = [];
    for (const raw of value.infoRequests) {
      if (!isPlainObject(raw)) continue;
      if (typeof raw.text !== 'string' || raw.text.trim() === '') continue;
      const req: ReviewInfoRequest = { text: raw.text, by: str(raw.by, ''), ts: num(raw.ts, 0) };
      if (typeof raw.threadId === 'string' && raw.threadId !== '') req.threadId = raw.threadId;
      const range = readRange(raw.range);
      if (range) req.range = range;
      reqs.push(req);
    }
    if (reqs.length > 0) out.infoRequests = reqs;
  }

  const revisions = readRevisions(value.revisions);
  if (revisions) out.revisions = revisions;

  // A verdict that cannot be read is dropped, and the row kept: the safe
  // direction is the pass-through, since a hold nobody can explain is an item
  // that vanished from the queue with no reason on the card.
  const judge = readJudgement(value.judge);
  if (judge) out.judge = judge;
  return out;
}

function readJudgement(value: unknown): ReviewItemJudgement | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.verdict !== 'string' || !JUDGE_VERDICTS.has(value.verdict)) return undefined;
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return undefined;
  return {
    at: value.at,
    verdict: value.verdict as ReviewJudgeVerdictKind,
    reason: str(value.reason, ''),
  };
}

function readSpan(value: unknown): { start: number; end: number } | undefined {
  if (!isPlainObject(value)) return undefined;
  const { start, end } = value;
  if (typeof start !== 'number' || typeof end !== 'number') return undefined;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return undefined;
  }
  return { start, end };
}

function readRange(value: unknown): ReviewItemRange | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.text !== 'string' || value.text === '') return undefined;
  const span = readSpan({ start: value.start, end: value.end });
  return span ? { text: value.text, ...span } : { text: value.text };
}

/**
 * The shape of a legacy decision TASK, structurally — the parallel spelling.
 *
 * Declared structurally rather than imported so this module stays free of the
 * server's task types: core is the lower layer, and both the browser and the
 * REST route derive the same value from it.
 */
export interface DecisionTaskLike {
  title: string;
  body?: string;
  options?: ReadonlyArray<{ id: string; label: string; detail?: string }>;
  answer?: { optionId?: string };
}

/**
 * The one legacy decision a task carried, expressed as a `ReviewPayload`.
 *
 * MECHANICAL, and every mapping in it is a copy rather than a judgement:
 *
 *  - `headline` is the task TITLE verbatim. A title is an authored string —
 *    somebody wrote it to be a title — so this is not the clip-prose-into-a-
 *    headline move `review-migration.ts` refuses to make. Nothing is generated.
 *  - `detail` is the body verbatim, unbudgeted for the same reason: a limit
 *    invented after the fact cannot retroactively make stored content invalid.
 *  - `options` keep their SERVER-MINTED ids. `ReviewOption.id` only promises
 *    to be stable within the payload, which a minted id satisfies, and
 *    `answer.optionId` already points at these — re-minting would orphan every
 *    answer already recorded.
 *
 * Pure: no store, no clock, no I/O, nothing minted. Read-side migration, so a
 * caller can derive this on every read without ever rewriting stored data.
 */
export function reviewFromDecisionTask(task: DecisionTaskLike): ReviewPayload {
  const out: ReviewPayload = { shape: 'decision', headline: task.title };
  if (typeof task.body === 'string' && task.body.trim() !== '') out.detail = task.body;
  if (task.options && task.options.length > 0) {
    out.options = task.options.map((o) => {
      const opt: ReviewOption = { id: o.id, label: o.label };
      if (o.detail !== undefined) opt.detail = o.detail;
      return opt;
    });
  }
  if (typeof task.answer?.optionId === 'string') out.answeredWith = task.answer.optionId;
  return out;
}
