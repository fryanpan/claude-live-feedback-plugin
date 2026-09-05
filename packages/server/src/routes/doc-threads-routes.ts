/**
 * The `/api/docs/:id/...` resource block's thread family: creating a
 * thread (`threads` POST, `threads/by_find` POST) and every per-thread
 * mutation (`threads/:threadId/...` — reply, answer, revise, withdraw,
 * resolve, reopen, reanchor, and the anchored-edit trio). Split out of
 * `routes/docs.ts`'s `handleDocResourceRoutes`; see that file's header for
 * why call order across the three families is not load-bearing.
 *
 * The ticket for this split named `threads` POST and `threads/by_find`
 * POST as this family and filed the `threads/:threadId/...` block under
 * the `home` bucket of `doc-resource.ts` — its ~400-line estimate for
 * "home" only adds up if it includes that block, which sits directly below
 * `home` in the source and above `threads` POST. It moved here instead:
 * every route in it is a thread mutation, the same family `threads` POST
 * and `threads/by_find` belong to, and `reviewFromBody` (also moved here)
 * is used by all three route groups and nowhere else.
 */
import {
  type Anchor,
  type ReviewPayload,
  type Thread,
  anchors,
  answerAsksBack,
  answerFromReply,
  checkReviewPayload,
  isReviewPayloadHeld,
  latestThreadedQuestion,
  locateReviewItemRange,
  pendingDeclaration,
  readReviewPayload,
  reviewGapAdvice,
  reviewItemState,
  reviewPayloadMessage,
  summaryHash,
} from '@feedback/core';
import { needsCall } from '@feedback/core/summary-prompt';
import { classifyActor } from '../actor-identity.ts';
import { KEYCHAIN_SERVICE } from '../summarize.ts';
import { isCategoryAuthor } from '../task-owner.ts';
import {
  type DocResourceRouteRequest,
  type DocRoutesContext,
  PLACEMENT_INVALID,
  type ThreadReviewGate,
  parsePlacement,
  parseSuggestionAuthor,
  withSyncError,
} from './docs.ts';

/** A comment's optional Review Item declaration, checked at the door.
 *
 * Every route that writes a comment calls this, because a payload that gets
 * past one of them is stored in the CRDT and renders on Bryan's Home queue
 * with a headline that does not fit two lines on a phone — which is the
 * defect the whole feature exists to remove, re-created by the feature.
 *
 * **Refuse rather than truncate.** Clipping a long headline is exactly what
 * produced the "titles are random detailed text" rows this replaces, and it
 * teaches the author nothing: the call returns 200, the row looks wrong, and
 * nobody connects the two. A 400 quoting every problem lands in a retrying
 * model's context, where it can be acted on.
 *
 * Returns `undefined` for an absent declaration — an ordinary comment is
 * still an ordinary comment, and the overwhelming majority are.
 *
 * `advice` is the non-refusing half: a payload that filed successfully but
 * left the card thin. It rides back on the 200 rather than being dropped
 * here, because an author who is never told writes the same thin item again.
 *
 * `text` is the comment the declaration arrived on. The checker needs it to
 * see a card whose links stayed behind in the comment — the reader acts from
 * the Home card, and the comment is not on it. */
function reviewFromBody(
  rawIn: unknown,
  text?: string,
): { ok: true; review?: ReviewPayload; advice?: string } | { ok: false; error: string } {
  if (rawIn === undefined || rawIn === null) return { ok: true };
  // The gate's own verdict is NEVER read off a caller's body. `judge` is
  // written by `runReviewGate` and restored from the CRDT by
  // `readReviewPayload`; accepting it here would let any filing clear the
  // gate with one key — `judge: {verdict: "ok"}` — which is a hole the
  // ticket form never had, because its verdict lives on a wrapper the
  // caller cannot address. Dropped silently: a payload carrying it is
  // almost certainly a peer echoing back an item it read, not an attack,
  // and refusing would bounce an otherwise honest ask.
  const raw =
    typeof rawIn === 'object' && rawIn !== null && 'judge' in (rawIn as Record<string, unknown>)
      ? (({ judge: _dropped, ...rest }) => rest)(rawIn as Record<string, unknown>)
      : rawIn;
  const check = checkReviewPayload(raw, { text });
  if (!check.ok) return { ok: false, error: reviewPayloadMessage(check) };
  const advice = reviewGapAdvice(check.gaps);
  // Stored via the reader so the agent-facing spellings (`review_type`,
  // 'question') land in the stored vocabulary and junk keys never persist.
  const review = readReviewPayload(raw);
  if (!review) return { ok: false, error: reviewPayloadMessage(check) };
  return { ok: true, review, ...(advice ? { advice } : {}) };
}

/**
 * Thread creation and every per-thread mutation: `threads` POST,
 * `threads/by_find` POST, and the `threads/:threadId/...` family (reply,
 * answer, revise, withdraw, resolve, reopen, reanchor, rewrite_region,
 * insert_after, insert_blocks_after). `undefined` means none matched.
 */
export async function handleDocThreadRoutes(
  ctx: DocRoutesContext,
  rq: DocResourceRouteRequest,
): Promise<Response | undefined> {
  const {
    rooms,
    taskStore,
    taskProjection,
    readyNudger,
    threadRequestDedup,
    summarizer,
    j,
    safeJson,
    resolveWorkspaceForDoc,
    threadUrl,
    judgeThreadReview,
    announceThreadReview,
    recordedThreadHold,
    gateThreadDeclaration,
    heldFields,
    parseRevisedRange,
  } = ctx;
  const { req, docId, rest, visitor, authorFor, refuseCategoryAuthor, withTaskChips } = rq;
  const threadIdMatch = rest.match(/^threads\/([^/]+)(\/.*)?$/);
  if (threadIdMatch) {
    const threadId = decodeURIComponent(threadIdMatch[1] ?? '');
    const threadRest = threadIdMatch[2] ?? '';
    if (threadRest === '' && req.method === 'GET') {
      const t = rooms.getThread(docId, threadId);
      return t
        ? j(200, { thread: withTaskChips(docId, t) })
        : j(404, { error: 'thread not found' });
    }
    if (threadRest === '/comments' && req.method === 'POST') {
      const body = await safeJson(req);
      const user = authorFor(body?.author);
      const text = body?.text as string | undefined;
      if (!user || !text) return j(400, { error: 'author + text required' });
      if (isCategoryAuthor(user)) return refuseCategoryAuthor();
      const declared = reviewFromBody(body?.review, text);
      if (!declared.ok) return j(400, { error: declared.error });
      // A person's plain reply IS the answer to the ask it lands on.
      //
      // Three surfaces render an Answer composer and post at
      // `/answer`; every other door a reply comes through — a task
      // panel's discussion composer, the widget, MCP `post_reply`, an
      // older bundle — arrives here. Measured across this project's
      // stored docs, that gap left 12 declarations unanswered with a
      // person's reply sitting under each one, which is what made the
      // queue read as ignored while the reader had in fact answered.
      //
      // `pendingDeclaration` and `answerFromReply` are core's, shared
      // with the queue and the doc panel, so what counts as pending
      // and what counts as an answer are decided in one place. A
      // reply that DECLARES its own ask is skipped: that is a new
      // question, not an answer to the old one.
      const priorThread = declared.review ? null : rooms.getThread(docId, threadId);
      const pending = priorThread ? pendingDeclaration(priorThread) : null;
      const folded =
        pending?.review && classifyActor(user) === 'person'
          ? answerFromReply(pending.review, text)
          : null;
      let t: Thread | null = null;
      if (pending && folded) {
        // The whole answer path, exactly as the explicit route uses
        // it — the stamps, the displaced-answer history, the reply,
        // the events. A second writer here is how the two spellings
        // of "answered" would drift.
        const res = await rooms.answerReviewItem(
          docId,
          threadId,
          pending.id,
          user,
          text,
          folded.optionId,
          // Conditional on the item STILL being pending, re-checked
          // inside the same synchronous stretch as the stamp. The read
          // above is a claim about a moment already past; an
          // unconditional write here would let a reply folded on that
          // stale claim displace an answer somebody had meanwhile
          // given, and displace it into history where nobody looks.
          { generate: !visitor, onlyIfUnanswered: true },
        );
        if (res.ok) {
          t = res.thread;
          // Same nudge the explicit answer fires: an answer on a
          // COMMENT moves no task row, so `decision.answered` never
          // fires for it and the lead would otherwise not hear that
          // the thing it was blocked on came back.
          const foldedHome = resolveWorkspaceForDoc(docId);
          if (foldedHome) {
            readyNudger.reviewAnswered({ workspaceId: foldedHome, actorId: user.id });
          }
        }
        // A refusal here is the loser of that race, never a reason to
        // drop the words: fall through and post the reply as the
        // ordinary comment it always was.
      }
      if (!t) {
        t = await rooms.postComment(docId, threadId, user, text, undefined, {
          // A share visitor must not be able to spend the API key.
          generate: !visitor,
          ...(declared.review ? { review: declared.review } : {}),
        });
      }
      // The quality gate, on the same terms the ticket form gets: the
      // reply that DECLARES an ask is judged before anything says the
      // reader can see it. This is the path `.claude/rules` tells the
      // whole fleet to file asks on, so leaving it ungated meant the
      // gate covered the road nobody drives.
      const replyGate =
        t && declared.review
          ? await gateThreadDeclaration(docId, t, declared.review, user)
          : undefined;
      const handoff = threadUrl(docId, Boolean(visitor));
      return t
        ? j(200, {
            thread: rooms.getThread(docId, t.id) ?? t,
            ...(declared.advice ? { reviewAdvice: declared.advice } : {}),
            ...(handoff ? { threadUrl: handoff } : {}),
            ...heldFields(replyGate),
          })
        : j(404, { error: 'thread not found' });
    }
    // Answering a Review Item. Deliberately a thin wrapper over the
    // reply above rather than a second write path: `text` is always
    // the verbatim answer, and `optionId` only records which offered
    // option those words came from. A person who types their own
    // answer sends no id and is not answering any less.
    if (threadRest === '/answer' && req.method === 'POST') {
      const body = await safeJson(req);
      const user = authorFor(body?.author);
      const text = body?.text as string | undefined;
      const commentId = body?.commentId as string | undefined;
      if (!user || !text || !commentId) {
        return j(400, { error: 'author + text + commentId required' });
      }
      // A person's question is not the answer, here either — same
      // conversion as the task review-item route. It posts as an
      // ordinary reply on the declaring thread: no answer stamp, so
      // the item stays open, and the owner hears the question the way
      // it hears every comment. `answerFromReply` refuses the same
      // reading on the plain-comment door, so the two doors agree. A
      // tapped option answers whatever its label reads.
      if (
        typeof body?.optionId !== 'string' &&
        classifyActor(user) === 'person' &&
        answerAsksBack(text)
      ) {
        const asked = await rooms.postComment(docId, threadId, user, text, undefined, {
          generate: !visitor,
        });
        if (!asked) return j(404, { error: 'thread not found' });
        return j(200, { asked: true, thread: rooms.getThread(docId, asked.id) ?? asked });
      }
      const res = await rooms.answerReviewItem(
        docId,
        threadId,
        commentId,
        user,
        text,
        typeof body?.optionId === 'string' ? body.optionId : undefined,
        { generate: !visitor },
      );
      if (!res.ok) {
        return j(res.error === 'no-doc' ? 404 : 400, { error: res.error });
      }
      // A review item on a COMMENT is the same ask as one on a
      // ticket, and its answer is the same thing to act on — but it
      // moves no task row, so `decision.answered` never fires for it
      // and the store-event bridge cannot see it. Wired here, at the
      // one route that records such an answer.
      const answerHome = resolveWorkspaceForDoc(docId);
      if (answerHome) {
        readyNudger.reviewAnswered({ workspaceId: answerHome, actorId: user.id });
      }
      return j(200, { thread: res.thread });
    }
    // Correcting a review item raised on a doc thread — the verb
    // that did not exist, and whose absence forced an agent that
    // found its own advice wrong to file a SECOND item, leaving the
    // reader two rows about one question with the older, wronger one
    // still reading as live.
    //
    // Addressed by commentId, like /answer directly above: that is
    // the identity `review-queue.ts` already keys a doc-thread row on
    // and the one `setCommentReview` already mutates by. Nothing was
    // minted for this route.
    if (threadRest === '/revise' && req.method === 'POST') {
      const body = await safeJson(req);
      const user = authorFor(body?.author);
      const commentId = body?.commentId as string | undefined;
      if (!user || !commentId) return j(400, { error: 'author + commentId required' });
      if (isCategoryAuthor(user)) return refuseCategoryAuthor();
      const parsed = parseRevisedRange(body?.revisedRange);
      if (!parsed.ok) return j(400, { error: parsed.error });
      const res = rooms.reviseCommentReview(
        docId,
        threadId,
        commentId,
        {
          ...(body?.headline !== undefined ? { headline: body.headline } : {}),
          ...(body?.detail !== undefined ? { detail: body.detail } : {}),
          ...(body?.options !== undefined ? { options: body.options } : {}),
        },
        {
          actor: user,
          ...(parsed.range ? { revisedRange: parsed.range } : {}),
        },
      );
      if (!res.ok) {
        return j(res.error === 'no-doc' || res.error === 'not-a-review-item' ? 404 : 400, {
          error: res.error,
          ...(res.message !== undefined ? { message: res.message } : {}),
        });
      }
      // Re-judged on every revision, exactly as the ticket form is:
      // the verdict was about the old words. Without this a hold on
      // this surface would be a dead end — the filer's one remedy
      // would leave the item held for words the judge never read.
      const gate = await judgeThreadReview(docId, threadId, commentId, res.review, user);
      // Watchers hear a revision the same way they hear the original
      // ask: the item changed, and anyone holding the old words is
      // holding words the reader can no longer see. Not while it is
      // held, though — a held item is on nobody's queue, so nothing
      // may buzz a phone claiming it is.
      if (!gate.held) announceThreadReview(docId, threadId, gate.review, user);
      return j(200, {
        thread: rooms.getThread(docId, threadId) ?? res.thread,
        review: gate.review,
        ...heldFields(gate),
      });
    }
    // Taking the ASK back — the asker's exit, as opposed to /answer
    // (the reader's) and /revise (a correction that keeps asking).
    //
    // Scoped to one comment on purpose. `/resolve` retires the whole
    // thread, so an agent that had filed a correction as a second
    // item on a shared thread could only clean up by taking its live
    // ask down alongside the stale one. This leaves the thread open
    // and its siblings answerable.
    //
    // Agents only. A withdrawal is a statement about what its author
    // meant to ask, and a share visitor is a reader — the person a
    // review item is FOR — so the door they get is /answer.
    if ((threadRest === '/withdraw' || threadRest === '/withdraw/undo') && req.method === 'POST') {
      if (visitor) return j(403, { error: 'not available to share visitors' });
      const body = await safeJson(req);
      const user = authorFor(body?.author);
      const commentId = body?.commentId as string | undefined;
      if (!user || !commentId) return j(400, { error: 'author + commentId required' });
      if (isCategoryAuthor(user)) return refuseCategoryAuthor();
      const reason = body?.reason;
      if (reason !== undefined && typeof reason !== 'string') {
        return j(400, { error: 'reason must be a string' });
      }
      const res = rooms.withdrawCommentReview(docId, threadId, commentId, {
        actor: user,
        ...(reason !== undefined ? { reason } : {}),
        ...(threadRest === '/withdraw/undo' ? { undo: true } : {}),
      });
      if (!res.ok) {
        return j(res.error === 'no-doc' || res.error === 'not-a-review-item' ? 404 : 400, {
          error: res.error,
          ...(res.message !== undefined ? { message: res.message } : {}),
        });
      }
      // Announced on the way BACK only. `announceThreadReview` sends
      // the reader a push whose title is the item's headline — "here
      // is something to review" — so announcing a withdrawal would
      // buzz their phone with the exact ask that was just taken off
      // their queue. Reinstating does put an ask in front of them
      // again, and that is worth telling them about.
      // …unless the gate is still holding it. Reinstating restores an
      // item's standing, not its verdict: the words never changed, so
      // the hold placed on them stands and the queue still omits it.
      if (threadRest === '/withdraw/undo' && !isReviewPayloadHeld(res.review)) {
        announceThreadReview(docId, threadId, res.review, user);
      }
      return j(200, { thread: res.thread, review: res.review });
    }
    // Taking an answer back. The stamps move into the declaration's
    // `answerHistory` (soft delete — the words are user content) and
    // the reply comment stays in the thread. Un-stamping is what
    // re-offers the item on every surface: each queue derives
    // "waiting on you" from the stamps, so there is no second state
    // to sync. Same visitor gating as /answer — a share visitor's
    // click must not spend the API key.
    if (threadRest === '/answer/undo' && req.method === 'POST') {
      const body = await safeJson(req);
      const user = authorFor(body?.author);
      const commentId = body?.commentId as string | undefined;
      if (!user || !commentId) return j(400, { error: 'author + commentId required' });
      const res = rooms.undoReviewItemAnswer(docId, threadId, commentId, user, {
        generate: !visitor,
      });
      if (!res.ok) {
        return j(res.error === 'no-doc' ? 404 : 400, { error: res.error });
      }
      return j(200, { thread: res.thread });
    }
    if (threadRest === '/summary' && req.method === 'POST') {
      // On-demand generation. The scheduled path is debounced and
      // fire-and-forget; this one blocks and reports what happened,
      // because an agent asked for it and is waiting.
      if (visitor) return j(403, { error: 'not available to share visitors' });
      const t = rooms.getThread(docId, threadId);
      if (!t) return j(404, { error: 'thread not found' });
      if (!summarizer?.enabled) {
        return j(503, {
          error: 'summaries disabled',
          detail: `set CW_SUMMARIES=1 and add a key: security add-generic-password -a "$USER" -s ${KEYCHAIN_SERVICE} -w`,
        });
      }
      // Already summarized as it stands: answer with what is stored
      // rather than paying to regenerate the same two lines. The
      // scheduled path and the backfill both ask this question through
      // `needsCall`; an agent that polls this route was the one caller
      // that could bill on every retry. `force` is the deliberate
      // "that line is wrong, do it again" escape hatch.
      const force = (await safeJson(req))?.force === true;
      if (!force && !needsCall(t, t.summary)) {
        return j(200, { thread: t, summary: t.summary, cached: true });
      }
      const summary = await summarizer.generate(t);
      if (!summary) return j(503, { error: 'generation failed' });
      // Re-read before storing, exactly as the scheduled path does.
      // A reply that landed during the call moves `summaryHash`, so
      // storing this one would (a) report success for a summary
      // `threadLines` will ignore forever, and (b) overwrite a valid
      // summary the scheduled path may have just landed for the NEW
      // state — leaving nothing scheduled to repair it.
      const now = rooms.getThread(docId, threadId);
      if (!now) return j(404, { error: 'thread not found' });
      if (summaryHash(now) !== summary.hash) {
        return j(409, { error: 'thread changed during generation' });
      }
      const updated = rooms.applyThreadSummary(docId, threadId, summary);
      return updated ? j(200, { thread: updated, summary }) : j(404, { error: 'thread not found' });
    }
    if (threadRest === '/resolve' && req.method === 'POST') {
      const body = await safeJson(req);
      const author = authorFor(body?.author);
      if (isCategoryAuthor(author)) return refuseCategoryAuthor();
      // Resolve is a thread change, so it schedules a summary — and a
      // visitor must not be able to spend the API key by clicking it.
      const t = rooms.resolve(docId, threadId, author, { generate: !visitor });
      return t ? j(200, { thread: t }) : j(404, { error: 'thread not found' });
    }
    if (threadRest === '/reopen' && req.method === 'POST') {
      const body = await safeJson(req);
      const author = authorFor(body?.author);
      if (isCategoryAuthor(author)) return refuseCategoryAuthor();
      const t = rooms.reopen(docId, threadId, author, { generate: !visitor });
      return t ? j(200, { thread: t }) : j(404, { error: 'thread not found' });
    }
    if (threadRest === '/reanchor' && req.method === 'POST') {
      const body = await safeJson(req);
      const anchor = body?.anchor as Anchor | undefined;
      if (!anchor) return j(400, { error: 'anchor required' });
      // Same gate as thread creation: this route can plant a
      // malformed anchor on an EXISTING thread just as easily.
      const reanchorCheck = anchors.validateAnchor(anchor);
      if (!reanchorCheck.ok) return j(400, { error: reanchorCheck.error });
      const t = rooms.reanchor(docId, threadId, anchor);
      return t ? j(200, { thread: t }) : j(404, { error: 'thread not found' });
    }
    if (threadRest === '/rewrite_region' && req.method === 'POST') {
      const body = await safeJson(req);
      const replacement = String(body?.replacement ?? '');
      const parseInlineMarks = body?.parseInlineMarks === true;
      if (body?.suggest === true) {
        const author = parseSuggestionAuthor(visitor ? { author: authorFor(body?.author) } : body);
        if (!author) return j(400, { error: 'author required when suggest is true' });
        const res = rooms.createSuggestionForThread(docId, threadId, {
          replacement,
          parseInlineMarks,
          author,
        });
        return res.ok ? j(200, res) : j(409, res);
      }
      const res = rooms.rewriteThreadRegion(docId, threadId, replacement, {
        parseInlineMarks,
      });
      return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
    }
    if (threadRest === '/insert_after' && req.method === 'POST') {
      const body = await safeJson(req);
      const text = String(body?.text ?? '');
      const res = rooms.insertAfterThread(docId, threadId, text);
      return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
    }
    if (threadRest === '/insert_blocks_after' && req.method === 'POST') {
      const body = await safeJson(req);
      const markdown = String(body?.markdown ?? '');
      const placement = parsePlacement(body?.placement);
      if (placement === PLACEMENT_INVALID) {
        return j(400, { error: "placement must be 'after-block' or 'top-level'" });
      }
      const res = rooms.insertBlocksAfterThread(docId, threadId, markdown, { placement });
      return res.ok ? j(200, withSyncError(rooms, docId, res)) : j(409, res);
    }
  }
  if (rest === 'threads' && req.method === 'POST') {
    const body = await safeJson(req);
    const user = authorFor(body?.author);
    const text = body?.text as string | undefined;
    let anchor = body?.anchor as Anchor | undefined;
    if (!user || !text || !anchor) {
      return j(400, { error: 'author + text + anchor required' });
    }
    if (isCategoryAuthor(user)) return refuseCategoryAuthor();
    // Validate BEFORE the write. An anchor whose startRel/endRel
    // don't decode is accepted silently by the CRDT and then kills
    // the re-anchor sweep from inside a Yjs observer, i.e. on
    // whatever request happens to be in flight minutes later. The
    // caller that wrote it has to be the one that hears about it.
    const anchorCheck = anchors.validateAnchor(anchor);
    if (!anchorCheck.ok) return j(400, { error: anchorCheck.error });
    // Computed early (not just before the write, where it used to
    // live) so both the dedup escape hatch below and the normal
    // return can build the SAME response shape — a retry must get
    // its reviewAdvice back too, not just its thread.
    const requestId = typeof body?.requestId === 'string' ? body.requestId : undefined;
    const declared = reviewFromBody(body?.review, text);
    if (!declared.ok) return j(400, { error: declared.error });
    // Identity for the dedup below — computed from the RAW anchor
    // (so a duplicate call matches regardless of how the
    // review-item branch below rewrites `anchor` for the eventual
    // write), the declared review, AND the author. Codex review
    // caught both gaps in turn: anchor alone let a requestId reuse
    // with a CORRECTED review payload silently return the stale
    // thread, and anchor+review alone let two DIFFERENT people who
    // (client-controlled, not globally unique) happened to mint the
    // same requestId collide — the second author's comment would
    // come back attributed to the first.
    const identityKey = JSON.stringify({
      anchor,
      review: declared.review ?? null,
      authorId: user.id,
    });
    // A retry of an already-handled request has to be caught HERE,
    // before the review-item validation below: that block refuses a
    // second ask while the item is `waiting`, a state the FIRST
    // request's own side effect sets — so a retry would otherwise
    // never reach the dedupe() call at the bottom and would get a
    // stale-state 409 instead of the thread it already made.
    const priorThreadCreate = threadRequestDedup.lookup(docId, requestId, text, identityKey);
    if (priorThreadCreate) {
      const t = await priorThreadCreate;
      const handoff = threadUrl(docId, Boolean(visitor));
      // Re-read, because the FIRST request's judge wrote to the
      // comment after the thread this promise resolved to was built.
      // A retry told nothing about the hold would treat its filing as
      // accepted and wait on a reader who cannot see the item (codex
      // review) — so the verdict is read back off the stored payload.
      const settledPrior = t ? (rooms.getThread(docId, t.id) ?? t) : null;
      return t && settledPrior
        ? j(200, {
            thread: settledPrior,
            ...(declared.advice ? { reviewAdvice: declared.advice } : {}),
            ...(handoff ? { threadUrl: handoff } : {}),
            ...heldFields(recordedThreadHold(docId, settledPrior, declared.review)),
          })
        : j(500, { error: 'could not create thread' });
    }
    // A thread on a PHRASE of a review item — the doc-style question
    // asked back at an ask. The anchor names an item this task must
    // carry, and its offsets must spell its snippet in the item's
    // current detail (or be absent, in which case the phrase is
    // located here). The write below is two writes: the thread, and
    // the question recorded on the item — which is what takes the
    // item off the reader's queue while the owner revises it.
    let itemAsk:
      | {
          taskId: string;
          reviewItemId: string;
          range: ReturnType<typeof locateReviewItemRange>;
        }
      | undefined;
    if (anchor.kind === 'review-item') {
      if (!docId.startsWith('task:')) {
        return j(400, {
          error: 'a review-item anchor belongs on a task doc (task:<taskId>)',
        });
      }
      const taskId = docId.slice('task:'.length);
      if (!taskStore.getTask(taskId)) return j(404, { error: 'task not found' });
      // The derived `r-legacy` row is admitted like any other — it
      // used to be refused here ("anchor a text-range there
      // instead"), which left a `needs: 'decision'` ticket's card
      // with no way to ask: an identical-looking card whose only
      // exit was Skip. `listReviewItems` derives the row, the
      // question is recorded on the task WITH its thread
      // (`requestMoreInfoOnReview` → `requestMoreInfo`), and the
      // decision leaves the reader's queue by the same derivation a
      // stored item does. Its `detail` is the task body, so a phrase
      // of the body anchors with offsets and the headline (the
      // title) anchors snippet-only.
      const wanted = anchor.reviewItemId;
      const item = taskStore.listReviewItems(taskId).find((r) => r.id === wanted);
      if (!item) return j(404, { error: 'unknown-review-item' });
      // One open question at a time. A second anchored ask while the
      // item is already `waiting` would orphan the first — `revise`
      // only reads the NEWEST threaded question (`latestThreadedQuestion`),
      // so a buried one could never be answered. Refused before the
      // thread is created (not just before the info-request stamp),
      // so a refusal never leaves an orphan thread with nothing
      // recorded against it.
      if (reviewItemState(item) === 'waiting') {
        const openThreadId = latestThreadedQuestion(item)?.threadId;
        const owner = item.createdBy.trim() || 'the owner';
        return j(409, {
          error: 'waiting',
          message: `Already waiting on ${owner} — add to the open thread instead`,
          ...(openThreadId !== undefined ? { threadId: openThreadId } : {}),
        });
      }
      const range = locateReviewItemRange(item.review.detail, {
        text: anchor.snippet.text,
        ...(anchor.start !== undefined ? { start: anchor.start } : {}),
        ...(anchor.end !== undefined ? { end: anchor.end } : {}),
      });
      if (!range) {
        return j(400, {
          error: "anchor.start/end do not spell anchor.snippet.text in the item's current detail",
        });
      }
      // Store the LOCATED anchor, so a snippet-only ask still renders
      // at its offsets.
      anchor = {
        kind: 'review-item',
        reviewItemId: item.id,
        snippet: { text: range.text },
        ...(range.start !== undefined && range.end !== undefined
          ? { start: range.start, end: range.end }
          : {}),
      };
      itemAsk = { taskId, reviewItemId: item.id, range };
    }
    // `dedupe` reserves (docId, requestId) synchronously and runs
    // this closure at most once for however many duplicate requests
    // arrive while it is in flight — the write AND the review-item
    // side effects it triggers, so a concurrent repeat never fires
    // `requestMoreInfoOnReview` a second time either.
    let gate: ThreadReviewGate | undefined;
    const { value: t } = await threadRequestDedup.dedupe(
      docId,
      requestId,
      text,
      identityKey,
      async () => {
        const created = await rooms.postComment(docId, null, user, text, anchor, {
          generate: !visitor,
          ...(declared.review ? { review: declared.review } : {}),
        });
        if (created && itemAsk?.range) {
          const asked = taskStore.requestMoreInfoOnReview(
            itemAsk.taskId,
            itemAsk.reviewItemId,
            text,
            { actor: user, threadId: created.id, range: itemAsk.range },
          );
          if (asked.ok) taskProjection.ensureWorkspace(asked.task.workspaceId);
        }
        if (created && declared.review) {
          // Judged before it is announced, and before this route
          // answers — see `gateThreadDeclaration`. Inside the dedupe
          // closure so a duplicated request cannot spend a second
          // judge call on one filing.
          gate = await gateThreadDeclaration(docId, created, declared.review, user);
        }
        return created;
      },
    );
    const handoff = threadUrl(docId, Boolean(visitor));
    const settled = t ? (rooms.getThread(docId, t.id) ?? t) : null;
    return t && settled
      ? j(200, {
          thread: settled,
          ...(declared.advice ? { reviewAdvice: declared.advice } : {}),
          ...(handoff ? { threadUrl: handoff } : {}),
          // `gate` is undefined on a DEDUPLICATED request — it never
          // ran the closure — so the hold is read back off the stored
          // payload rather than dropped. See `recordedThreadHold`.
          ...heldFields(gate ?? recordedThreadHold(docId, settled, declared.review)),
        })
      : j(500, { error: 'could not create thread' });
  }
  if (rest === 'threads/by_find' && req.method === 'POST') {
    const body = await safeJson(req);
    const author = authorFor(body?.author);
    const text = body?.text as string | undefined;
    const find = body?.find ? String(body.find) : '';
    if (!author || !text || find.length === 0) {
      return j(400, { error: 'author + text + find required' });
    }
    const declared = reviewFromBody(body?.review, text);
    if (!declared.ok) return j(400, { error: declared.error });
    const res = await rooms.createThreadByFind(
      docId,
      {
        find,
        contextBefore: body?.contextBefore ? String(body.contextBefore) : undefined,
        contextAfter: body?.contextAfter ? String(body.contextAfter) : undefined,
        occurrence: typeof body?.occurrence === 'number' ? Number(body.occurrence) : undefined,
      },
      author,
      text,
      // Visitor-authored text becomes the entire prompt on this route.
      { generate: !visitor, ...(declared.review ? { review: declared.review } : {}) },
    );
    const findGate =
      res.ok && declared.review
        ? await gateThreadDeclaration(docId, res.thread, declared.review, author)
        : undefined;
    const findHandoff = threadUrl(docId, Boolean(visitor));
    return res.ok
      ? j(200, {
          thread: rooms.getThread(docId, res.thread.id) ?? res.thread,
          ...(declared.advice ? { reviewAdvice: declared.advice } : {}),
          ...(findHandoff ? { threadUrl: findHandoff } : {}),
          ...heldFields(findGate),
        })
      : j(409, res);
  }
  return undefined;
}
