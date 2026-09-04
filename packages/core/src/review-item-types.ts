/**
 * The Review Item CONTRACT: every shape a declaration, its answer, its
 * revisions and its verdict are stored in, and nothing that acts on them.
 *
 * The verbs live in `review-item.ts`, the quality gate in
 * `review-item-check.ts`, the defensive readers in `review-item-wire.ts` —
 * and all three are written in terms of these types. They were declared
 * alongside the verbs until this split, which meant the gate and the readers
 * imported the module that imports THEM: a cycle that only stayed harmless
 * because a type-only import erases at build time.
 *
 * Types only, on purpose. This file emits no JavaScript, so a module may
 * depend on the contract without depending on anything that runs; the
 * runtime surface is unchanged because `review-item.ts` re-exports every
 * name below, and `packages/core/src/index.ts` re-exports that.
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
  /**
   * The quality gate's verdict on the CURRENT words of a review item raised
   * on a COMMENT — see `ReviewItemJudgement`, which is the same record a
   * ticket item keeps on its wrapper.
   *
   * It lives on the payload for the reason `revisions` does: a comment-borne
   * declaration has no wrapper to hang anything on, the payload IS the item.
   * Before this field the gate could only judge the ticket form, so the
   * filing path the fleet rule actually recommends — a `review` payload on
   * `create_thread` / `post_reply` — reached the reader's queue with the
   * judge called zero times. A gate the standard path bypasses is worse than
   * no gate: it produces confidence it has not earned.
   *
   * NEVER read off a caller's own body. `readReviewPayload` restores it from
   * the CRDT, and `reviewFromBody` — the door an agent's payload arrives
   * through — strips it, or filing with `judge: {verdict: 'ok'}` would be a
   * one-key bypass of the gate.
   */
  judge?: ReviewItemJudgement;
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
   *  it read at the time. Present when the question was asked about a phrase;
   *  a question typed into the answer composer carries the thread alone —
   *  it is about the whole item, and there are no words to mark. */
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
