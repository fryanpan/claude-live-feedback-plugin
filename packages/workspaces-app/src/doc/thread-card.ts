/**
 * One comment thread, rendered as a card.
 *
 * This is the drawer's row AND the redline balloon: a comment balloon is
 * literally this card plus positioning classes, so reply, resolve, reopen and
 * re-anchor behave identically in both places instead of a second
 * implementation drifting out of sync. That is why it left the panel — the
 * card is the shared thing, and the panel is one of its two callers.
 *
 * The panel state a card still needs arrives as a host, and every field on it
 * is a CALL rather than a value: a card's handlers run long after it was
 * built, and a snapshot of "which thread is active" taken at render time would
 * be stale by the time a caret is tapped.
 */
import {
  type Comment,
  type Participants,
  type ReviewPayload,
  type Thread,
  authorLabel,
  formatTime,
  pendingDeclaration,
  reviewAnswered,
  reviewItemBodyMarkdown,
  reviewWithdrawn,
  threadSummary,
} from '@feedback/core';
import { renderCommentMarkdown, renderCommentMarkdownInline } from '../comment-markdown.ts';
import { askedMetaLine, decidedMetaLine } from '../hub/hub-review-model.ts';
import { threadDecision } from '../long-thread.ts';
import { attachMarkdownComposer } from '../md-composer.ts';
import { threadGlyph, threadKind } from '../thread-kind.ts';
import { isFoldingTap, syncFaceVisibility } from '../thread-morph.ts';
import type { ThreadPanelOpts } from '../threads.ts';

/**
 * The panel, as far as a card is concerned. Everything is a call so the card
 * reads live state rather than a render-time copy.
 */
export interface ThreadCardHost {
  readonly opts: ThreadPanelOpts;
  /** Which thread is expanded in this panel right now. */
  activeId: () => string | null;
  /** The thread expanded in the OTHER surface, if any. */
  expandedElsewhere: () => string | null;
  statusOf: (threadId: string) => 'open' | 'resolved' | 'orphan' | undefined;
  setActive: (id: string | null) => void;
}

/**
 * Build one thread's card DOM. Used internally by `render()` for the
 * drawer list AND externally by the redline balloon margin — a comment
 * balloon is literally this same card (plus positioning classes), so
 * reply/resolve/reopen/re-anchor behave identically everywhere instead of
 * a second implementation drifting out of sync. Public on purpose.
 *
 * THREE rows, and the lower two are *slots* holding two faces each:
 *
 * ```
 * .thread-head    ? Alice                            2h   ›
 * .thread-slot.slot-a   topic line          ⇄  the opening message
 * .thread-slot.slot-b   who + discussion    ⇄  the replies, reply box, ✓ Resolve
 *                       + the item's control
 * ```
 *
 * Each summary line is paired with what it BECOMES, and both faces are
 * built here, together, always — the expand animation cross-fades between
 * two faces that already exist in the same box, so neither may be built
 * lazily and neither may be omitted. Only the head sits outside both slots,
 * so expanding never rebuilds or moves it.
 *
 * WHAT A CARD DOES NOT SAY (Bryan, 2026-09-04, on mock round 4). No kind
 * chip: a row of option buttons IS a decision and a field with a send button
 * IS a question, so a "DECIDE" badge beside them restates what the reader can
 * already press. No reply count, no "No replies yet", no captions — a card
 * spending a row to report an absence is a row that says nothing. **The
 * control is the marking.** What is left of the old chips are the two states
 * that have no affordance to read at all: resolved, and orphaned.
 */
export function renderThreadCard(
  host: ThreadCardHost,
  t: Thread,
  pendingReply?: string,
): HTMLElement {
  const status = host.statusOf(t.id) ?? 'open';
  const summary = threadSummary(t);
  const el = document.createElement('div');
  el.className = `thread status-${status}`;
  if (status === 'resolved') el.classList.add('resolved');
  if (status === 'orphan') el.classList.add('orphan');
  // What the thread IS — the term every surface's glyph and colour key off
  // (`thread-kind.ts`): the highlight, this card wherever it renders, the
  // top-bar chip and the off-screen hints all say the same thing.
  const kind = threadKind(t);
  el.classList.add(`thread-kind-${kind}`);
  if (host.opts.isNew?.(t)) el.classList.add('is-new');
  // `expanded` is the class the two slots read; `active` is the drawer's
  // own selection styling. They coincide today (expanded == active), but
  // the slots key off `expanded` so the two can separate later without
  // touching the CSS that folds the card.
  // Selected and expanded are the same thing everywhere except under an open
  // modal, which is showing this conversation full size already.
  const shownElsewhere = host.expandedElsewhere() === t.id;
  if (host.activeId() === t.id) {
    el.classList.add('active');
    if (!shownElsewhere) el.classList.add('expanded');
  }
  // The lookup key for every copy of this thread on screen. A thread can be
  // rendered twice (inline in the doc AND in the mobile sheet), so nothing
  // may address a card by a document-unique id — drive them all from this.
  el.setAttribute('data-thread-id', t.id);

  // Which comment's declaration the full item card will carry — the
  // outstanding ask when there is one, else the latest declaration (whose
  // answered record is what the reader should meet). Computed HERE, above
  // both slots, because it is what tells the rest of the card not to state
  // the same question a second time: the card already says the kind, the
  // headline and the why in full.
  const pending = pendingDeclaration(t);
  const itemComment = pending ?? latestDeclaredComment(t.comments);
  // An ask its own asker took back. `latestDeclaredComment` steps over a
  // withdrawn declaration on purpose — a retracted ask is not a record to put
  // in the item card — so a thread whose every declaration was withdrawn
  // arrives here with no item at all and used to render as the plain
  // conversation it now is, saying nothing about the ask that was there.
  const withdrawn = itemComment ? undefined : withdrawnDeclaration(t.comments);
  if (withdrawn) el.classList.add('withdrawn');

  el.appendChild(head(host, t, status, kind));
  // A declared thread's folded line is the ASK, not the sentence it hangs
  // off: the highlight in the prose already shows the sentence, and a card
  // that repeated it said nothing about what was wanted.
  const topic = itemComment?.review?.headline ?? summary.topic;
  el.appendChild(slotA(t, topic, itemComment?.id));
  el.appendChild(
    slotB(host, t, summary, status, { pending, itemComment, withdrawn, pendingReply }),
  );
  syncFaceVisibility(el, host.activeId() === t.id && !shownElsewhere);

  // The whole card is the tap target; the caret is a hint, not the hit
  // area. The only exclusions are things you tap FOR something else — a
  // field, a button, a link — and a text selection being dragged out, which
  // must not collapse the comment out from under the reader.
  el.addEventListener('click', (ev) => {
    if (!isFoldingTap(ev.target)) return;
    // The tap TOGGLES. Tapping an open card folds it back into its two
    // lines; `onThreadClick` is the "engage with this thread" path (scroll
    // to it, pulse the anchor, open the mobile sheet) and would be wrong to
    // re-run on the way down.
    if (host.activeId() === t.id) host.setActive(null);
    else host.opts.onThreadClick(t.id);
  });

  return el;
}

/** Row 1: identity. The attribution for the OPENING MESSAGE and nothing
 *  else — which is why the opening message never repeats the name. */
function head(
  host: ThreadCardHost,
  t: Thread,
  status: 'open' | 'resolved' | 'orphan',
  kind: ReturnType<typeof threadKind>,
): HTMLElement {
  const head = div('thread-head');
  // ONE glyph per state, everywhere it appears: blue bubble for a comment,
  // amber question mark for an open review item (question or decision
  // alike), green tick once answered or resolved. The same glyph sits on
  // the highlighted sentence, the top-bar chip and the off-screen hints.
  //
  // It is also the ONLY state marker in the head now. The status dot beside
  // it said the same thing in a colour with no name, and a card carrying both
  // spent two of a 260px row's slots on one fact.
  const glyph = span(`thread-glyph cw-ic cw-ic-${threadGlyph(kind)}`);
  glyph.setAttribute('aria-hidden', 'true');
  head.appendChild(glyph);

  const author = t.comments[0]?.author ?? t.createdBy;
  const swatch = span('swatch');
  // Assigning a style PROPERTY can't smuggle extra declarations the way an
  // interpolated style ATTRIBUTE can — the CSS parser drops the whole value
  // if it isn't a colour. Same treatment every author swatch already gets.
  swatch.style.background = author.color;
  head.appendChild(swatch);

  const who = span('thread-who clip');
  const name = span('name');
  // Plain text, never HTML: author names are agent-supplied and untrusted.
  name.textContent = authorLabel(author);
  who.appendChild(name);
  head.appendChild(who);

  const lineLabel = host.opts.threadLineLabel?.(t.id);
  if (lineLabel) {
    const chip = span('thread-line');
    chip.textContent = lineLabel;
    head.appendChild(chip);
  }
  // The ONE chip left, and only for the one state the card cannot show any
  // other way. Resolved lost its badge with mock round 4: the head's glyph is
  // already the green tick, the card recedes, the settled line carries the
  // outcome and the foot says "✓ Resolved" — four sayings of one fact, and the
  // word was the only one adding nothing. An orphan has none of that. Its
  // anchor is gone, which is a fact about a thing no longer on the page, so
  // there is no control to read it off and no colour that would mean it.
  // `is-new` rides the glyph as a dot rather than as a second word.
  if (status === 'orphan') {
    const tag = span('thread-tag');
    tag.textContent = 'Orphaned';
    head.appendChild(tag);
  }
  if (host.opts.isNew?.(t)) glyph.classList.add('is-new');

  // WHEN THIS STARTED, top right. It used to be the foot's `lastActivity`
  // beside a reply count, and both went with the foot: the count restated the
  // replies the card is showing, and "who started it and when" is one fact
  // about the opening message — which is what the head has always been the
  // attribution for. So it is the OPENING comment's clock, not the thread's.
  const started = span('thread-time');
  started.textContent = formatTime(t.comments[0]?.ts ?? t.lastActivity);
  head.appendChild(started);

  // As far from ✓ Resolve as the card allows: the two were a thumb-width
  // apart, and the misfire that costs you resolves a thread. Resolve now lives
  // on the detail face, which puts a whole fold between them.
  //
  // A real <button>, and the ONLY focusable thing on a collapsed comment card:
  // the whole card is the tap target, but a tap is not a gesture a keyboard or
  // a screen reader has, and the detail face is `inert` while folded — so
  // without this the opening message and every reply are unreachable. It
  // stays a HINT rather than the hit area because it has no handler of its
  // own: its click bubbles to the card's toggle like any other tap on the
  // card (`isFoldingTap` lets exactly this one control through).
  //
  // A chevron on every card, with no word beside it. The "Details ▾" caption a
  // declared thread used to carry was one of the captions this round removes:
  // a card whose folded face already offers the options or the answer box does
  // not need telling that there is more behind the fold.
  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'thread-caret';
  // Named for its own thread, not "Toggle comment thread" on every card. A
  // sighted reader tells the column apart by the name and the control it
  // carries; a keyboard user tabbing it got a run of identical buttons, with
  // no way to know which thread they were on or which one was holding a
  // decision. The decision half is also the only place that fact reaches a
  // screen reader at all, now that no chip says it in words.
  const decision = threadDecision(t);
  const decisionSuffix =
    decision === 'pending' ? ', decision needed' : decision === 'answered' ? ', decision' : '';
  caret.setAttribute('aria-label', `Comment from ${authorLabel(author)}${decisionSuffix}`);
  caret.setAttribute('aria-expanded', String(host.activeId() === t.id));
  caret.textContent = '›';
  head.appendChild(caret);
  return head;
}

/** Slot A: the topic line becomes the opening message, in place. */
function slotA(t: Thread, topic: string, itemCommentId?: string): HTMLElement {
  const topicEl = div('thread-topic clip');
  // Plain text, never HTML: the snippet is doc content, untrusted.
  topicEl.textContent = topic;

  const msg = div('thread-message body');
  // Comments are untrusted input; renderCommentMarkdown escapes first and
  // only emits a fixed safe tag set, so innerHTML is safe here.
  msg.innerHTML = renderCommentMarkdown(t.comments[0]?.text ?? '');

  // The banner an opening declaration carries — SUPPRESSED when slot B's
  // item card is already carrying this same declaration, which is the usual
  // case for a declared thread. Both render the kind chip, the headline and
  // the why, so leaving both in place stated the question twice and pushed
  // the interface that answers it below the fold. Kept for a declaration no
  // card is showing (a superseded ask, still part of the history): there,
  // nothing else says it was ever asked.
  const opening = t.comments[0];
  const header = opening && opening.id !== itemCommentId ? reviewHeader(opening.review) : null;
  return slot('slot-a', [topicEl], header ? [header, msg] : [msg]);
}

/** Slot B: who spoke + where it got to becomes the replies + the reply box. */
function slotB(
  host: ThreadCardHost,
  t: Thread,
  summary: {
    discussion: string;
    discussionKind: 'replies' | 'none' | 'pending';
    participants: Participants | null;
  },
  status: 'open' | 'resolved' | 'orphan',
  item: {
    /** The outstanding ask by the shared rule, or null. */
    pending: Comment | null;
    /** Whose declaration the item card carries, pending or settled. */
    itemComment: Comment | undefined;
    /** The retracted declaration, when nothing live replaced it. */
    withdrawn?: Comment | undefined;
    pendingReply?: string;
  },
): HTMLElement {
  const { pending, itemComment, withdrawn, pendingReply } = item;
  const summaryFace: HTMLElement[] = [];
  // Both rows come and go now. With nobody but the author in the thread there
  // is nobody to list — and with no replies there is no discussion to
  // summarise. The line that used to say "No replies yet" was spending a row
  // of a 260px card to report an absence the reader can already see, so slot
  // B's summary face on a fresh question is just the answer field: the
  // control, and nothing restating it.
  if (summary.participants) summaryFace.push(participantsRow(summary.participants));
  if (summary.discussionKind !== 'none') {
    const discussion = div('thread-discussion clip');
    if (summary.discussionKind === 'pending') discussion.classList.add('pending');
    discussion.textContent = summary.discussion;
    summaryFace.push(discussion);
  }
  // A review item answers from its FOLDED face (approved: comments mock 3).
  // A decision offers its option labels right there; a question shows
  // where to tap; an answered item keeps a compact record — who, when, and
  // the words — so nothing has to be opened to see what a card is asking or
  // what it was told. The full item card, with the detail and each option's
  // reasoning, stays one fold away behind "Details".
  if (itemComment?.review) {
    const compact = compactItemLine(host, t, itemComment, itemComment.review, pending !== null);
    if (compact) summaryFace.push(compact);
  } else if (withdrawn?.review) {
    // The card is already saying it was withdrawn — dimmed, with the ask
    // struck through. This line is the one thing the strike cannot say: why.
    // No word repeating "Withdrawn", for the same reason the kind chips went.
    // No `clip`: that class is `white-space: nowrap`, which put an ellipsis
    // through the middle of the reason at 260px. The reason wraps like the
    // thread-summary line it stands in for.
    const gone = div('thread-gone');
    gone.textContent =
      withdrawn.review.withdrawnReason?.replace(/\s+/g, ' ').trim() ||
      (withdrawn.review.withdrawnBy
        ? `Taken back by ${withdrawn.review.withdrawnBy}.`
        : 'Taken back.');
    summaryFace.push(gone);
  }

  const comments = div('comments');
  // Same suppression as slot A, one row further down: a reply that declared
  // the ask the item card is carrying must not repeat its chip, headline and
  // why in the history directly beneath the card that just said them.
  for (const c of t.comments.slice(1))
    comments.appendChild(commentRow(c, c.id === itemComment?.id));

  const reply = div('thread-reply');
  // The ask these words will answer, if there is one. `pendingDeclaration`
  // (computed by the caller, above both slots) is the SAME rule the server's
  // queue reads (core exports one copy): newest declaration wins, ts order
  // not array order, and a resolved thread has nothing pending. Anything
  // looser here offers an Answer composer for an item no queue is showing —
  // answering it stamps a comment Home never offered.
  const answering = pending?.id;
  if (answering) reply.classList.add('answering');
  const ta = document.createElement('textarea');
  ta.rows = 2;
  ta.placeholder = answering
    ? `Answer as ${host.opts.currentUser.name}…`
    : `Reply as ${host.opts.currentUser.name}…`;
  if (pendingReply) ta.value = pendingReply;
  reply.appendChild(lockWrite(host, ta));
  // Every composer is a markdown editor (design point 4); refresh covers
  // the programmatic clear below, which the editor cannot see.
  const refreshComposer = attachMarkdownComposer(ta);
  const submitReply = () => {
    const text = ta.value.trim();
    if (!text) return;
    const posted = host.opts.onReply(t.id, text, answering);
    ta.value = '';
    refreshComposer();
    // A refused post hands the words back — the chrome's 'try again' toast
    // must never point at an empty box. Only while the box is still empty,
    // though: restoring over words typed since would stomp them.
    void Promise.resolve(posted)
      .catch(() => false)
      .then((ok) => {
        if (ok === false && ta.value === '') {
          ta.value = text;
          refreshComposer();
        }
      });
  };
  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      submitReply();
    }
  });
  const actions = div('thread-actions');
  actions.appendChild(lockWrite(host, btn(answering ? 'Answer' : 'Reply', 'primary', submitReply)));
  // Resolve/Reopen is NOT here — one control, in the foot, outside the
  // slots. Re-anchoring is a repair, not a reply, and belongs with the
  // conversation it is repairing.
  if (status === 'orphan') {
    actions.appendChild(
      lockWrite(
        host,
        btn('Re-anchor…', '', () => host.opts.onReanchor(t.id)),
      ),
    );
  }
  reply.appendChild(actions);

  // A thread that carries a review item IS the review item (approved
  // design, review-flow-mock-v1; Bryan verbatim: "if I open a comment that
  // has one or more review items in it, I should get the full review item
  // interface, with the comment history secondary"). The full item card
  // renders FIRST, the conversation drops below an "Earlier in this
  // thread" label, and while the item is pending the one composer is the
  // card's answer box. Once settled the card holds the answered record and
  // the composer returns to its usual place as a plain Reply.
  const detailFace: Node[] = [];
  if (itemComment?.review) {
    const card = itemCard(host, t, itemComment, itemComment.review, pending !== null);
    if (answering) card.append(reply);
    detailFace.push(card);
    if (t.comments.length > 1) {
      const label = div('thread-history-label');
      label.textContent = 'Earlier in this thread';
      detailFace.push(label);
    }
    detailFace.push(comments);
    if (!answering) detailFace.push(reply);
  } else {
    detailFace.push(comments, reply);
  }
  // ✓ Resolve, LAST, and on the detail face only. It used to be a fourth row
  // outside both slots, which put it on the folded card beside a reply count
  // — a destructive control one thumb-width from the caret, on a face whose
  // whole job is to be scanned. Expanding is the gesture that reveals it, and
  // it is the last thing an expanded thread offers because it is the last
  // thing you do with one.
  detailFace.push(foot(host, t, status));
  return slot('slot-b', summaryFace, detailFace);
}

/**
 * The folded face's answer row for a declared thread — **the marking**, now
 * that no chip names the kind. Pending decision: the option labels as
 * buttons. Pending question: a one-line answer FIELD, which is what makes a
 * question legible as a question. Answered: the record, one line.
 *
 * The field replaced an "Answer" cue that was a span rather than a control:
 * it looked like a caption, it had to be tapped twice (once to unfold, once
 * to reach the composer), and it told the reader what to do instead of
 * letting them do it. Everything here posts through the SAME `onReply` route
 * the full card uses, so a folded answer and an expanded one are one path.
 */
function compactItemLine(
  host: ThreadCardHost,
  t: Thread,
  c: Comment,
  review: ReviewPayload,
  pending: boolean,
): HTMLElement | null {
  if (reviewAnswered(review)) {
    const line = div('thread-answered-line');
    const tick = span('thread-answered-tick');
    tick.textContent = '✓ ';
    line.appendChild(tick);
    // A decision's outcome already rides the flag row above the head;
    // repeating it here would say the same words twice on a folded card.
    // The OUTCOME, for every settled item including a decision. A decision's
    // outcome used to ride the flag row above the head, so repeating it here
    // would have said the same words twice; with that row gone this is the
    // only place a folded card says what was decided. Reported from a
    // walkthrough before the flag row existed: an answered decision's folded
    // card led with "No replies yet" — true, since an answer is a payload on
    // the item rather than a reply, and useless.
    const words = span('thread-answered-words');
    // Plain text: an answer is a person's words.
    words.textContent = (
      review.answerText ??
      review.options?.find((o) => o.id === review.answeredWith)?.label ??
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();
    line.appendChild(words);
    const meta = span('thread-answered-who');
    meta.textContent = decidedMetaLine(
      review.answeredBy,
      host.opts.currentUser.name,
      review.answeredAt,
      Date.now(),
      review.shape === 'decision',
    );
    line.appendChild(meta);
    return line;
  }
  if (!pending) return null;
  if (review.shape === 'decision' && review.options && review.options.length > 0) {
    const opts = div('thread-options-compact');
    for (const o of review.options) {
      const b = lockWrite(
        host,
        btn(o.label, 'thread-item-option thread-item-option-compact', () =>
          host.opts.onReply(t.id, o.label, c.id, o.id),
        ),
      );
      if (o.detail) b.title = o.detail;
      opts.appendChild(b);
    }
    return opts;
  }
  return compactAnswerField(host, t, c.id);
}

/**
 * The one-line answer field a pending QUESTION carries on its folded face.
 *
 * A single-line `<input>` rather than the card's own two-row textarea: this
 * has to fit under two lines of summary in a 260px margin bubble, and the
 * answer to a question asked in one sentence is usually one sentence back.
 * Anything longer is what the fold is for — the expanded card's composer is
 * the same route, carrying the same `answersCommentId`.
 *
 * Both the field and its button are in `isFoldingTap`'s exclusion list, so
 * reaching for either does not fold the card out from under the reader.
 */
function compactAnswerField(
  host: ThreadCardHost,
  t: Thread,
  answersCommentId: string,
): HTMLElement {
  const wrap = div('thread-answer-field');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'thread-answer-input';
  input.placeholder = `Answer as ${host.opts.currentUser.name}…`;
  input.setAttribute('aria-label', 'Answer this question');
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    const posted = host.opts.onReply(t.id, text, answersCommentId);
    input.value = '';
    // A refused post hands the words back — the chrome's 'try again' toast
    // must never point at an empty box. Only while the box is still empty,
    // though: restoring over words typed since would stomp them.
    void Promise.resolve(posted)
      .catch(() => false)
      .then((ok) => {
        if (ok === false && input.value === '') input.value = text;
      });
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) {
      ev.preventDefault();
      send();
    }
  });
  wrap.append(
    lockWrite(host, input),
    lockWrite(host, btn('Answer', 'thread-answer-send primary', send)),
  );
  return wrap;
}

/**
 * The FULL review-item interface, in the thread that carries it: the same
 * one-card anatomy as the hub's walkthrough and task panel — head row (kind
 * badge, headline, asked-by meta), one markdown body — then the ways to
 * answer, or the answered record once somebody has. Thread-scoped class
 * names, hub anatomy: the vocabulary must read as one component wherever an
 * item is met.
 */
function itemCard(
  host: ThreadCardHost,
  t: Thread,
  c: Comment,
  review: ReviewPayload,
  pending: boolean,
): HTMLElement {
  const card = div('thread-item-card');
  const head = div('thread-item-head');
  // NO kind chip, on any face. The folded card dropped it with mock round 4
  // and this one was simply missed: the rule is the same either side of the
  // fold, because the row of option buttons directly below IS the decision
  // and the answer box IS the question. A "Decision" badge above them
  // restates in a word what the reader can already press, and the modal was
  // the one place a person met both at once.
  //
  // Doc surface only. The hub board renders review items through its own
  // `src/hub/thread-card.tsx`, which this file shares no code with, so its
  // cards are untouched by this change.
  const headline = document.createElement('p');
  headline.className = 'thread-item-headline';
  // Plain text, never HTML: the headline is agent-supplied and the API
  // takes it as a single-line string, not markdown.
  headline.textContent = review.headline;
  head.append(headline);
  const meta = document.createElement('p');
  meta.className = 'thread-item-meta';
  // A declaration IS an ask, so this always reads "Asked" — same judgment
  // the hub's `askedMeta` records for declared items. The clock is the
  // declaring comment's, which is when the question was put.
  meta.textContent = askedMetaLine(authorLabel(c.author), true, c.ts, Date.now());
  head.append(meta);
  card.append(head);

  // ONE body, markdown-rendered — the payload's `detail`, via the same
  // `reviewItemBodyMarkdown` every other surface asks.
  const bodyMarkdown = reviewItemBodyMarkdown(review);
  if (bodyMarkdown !== '') {
    const body = div('thread-item-body');
    // Agent-supplied, untrusted; renderCommentMarkdown escapes first and
    // only re-adds a fixed safe tag set.
    body.innerHTML = renderCommentMarkdown(bodyMarkdown);
    card.append(body);
  }

  if (reviewAnswered(review)) {
    card.append(answeredRecord(host, t, c, review));
    return card;
  }

  // Tappable options only while the item is actually PENDING by the shared
  // rule. A retired ask (its thread resolved, or a newer declaration
  // answered over it) keeps its card as a record, but offering its options
  // would answer an item no queue is showing.
  if (pending && review.options && review.options.length > 0) {
    const opts = div('thread-item-options');
    for (const o of review.options) {
      const b = lockWrite(
        host,
        btn('', 'thread-item-option', () =>
          // The tap answers with the option's VERBATIM label — the id is
          // provenance the chrome forwards to `/answer`, never the answer.
          host.opts.onReply(t.id, o.label, c.id, o.id),
        ),
      );
      const label = span('thread-item-option-label');
      label.textContent = o.label;
      b.append(label);
      if (o.detail) {
        const detail = span('thread-item-option-detail');
        detail.textContent = o.detail;
        b.append(detail);
      }
      opts.append(b);
    }
    card.append(opts);
  }
  return card;
}

/**
 * The settled RECORD, directly below the item it settles — the whole point
 * of which is that the card above it stays intact. A decided item keeps its
 * full headline and detail body exactly as they were asked (neither is
 * clamped), and the outcome arrives as a LABELLED strip rather than as a
 * sentence wrapped around it: "Answered by Cara: “AssemblyAI…”" put the
 * outcome mid-sentence, where the one word a person scans for — what was
 * decided — had no visual home. The approved mock gives it one.
 *
 * Three parts, in reading order: the label ("Decision" or "Answer" — the
 * card carries no kind chip any more, so this strip is the only place the
 * word appears), the verbatim outcome, then who settled it and when. Undo is the recovery path for a
 * single unconfirmed tap, so it persists rather than expiring with a toast.
 *
 * The words render markdown-inline because they are a comment's words.
 */
function answeredRecord(
  host: ThreadCardHost,
  t: Thread,
  c: Comment,
  review: ReviewPayload,
): HTMLElement {
  const decision = review.shape === 'decision';
  const wrap = div('thread-answered');
  const strip = div('thread-decision-strip');
  const label = span('thread-decision-label');
  label.textContent = decision ? 'Decision' : 'Answer';
  const words = span('thread-answer-words');
  // A legacy tapped answer may predate `answerText`; the tapped option's
  // label is the verbatim words it recorded.
  const answerText =
    review.answerText ?? review.options?.find((o) => o.id === review.answeredWith)?.label ?? '';
  words.innerHTML = renderCommentMarkdownInline(answerText);
  strip.append(label, words);
  wrap.append(strip);

  const meta = document.createElement('p');
  meta.className = 'thread-answered-meta';
  meta.textContent = decidedMetaLine(
    review.answeredBy,
    host.opts.currentUser.name,
    review.answeredAt,
    Date.now(),
    decision,
  );
  wrap.append(meta);

  if (host.opts.onUndoAnswer) {
    const undo = lockWrite(
      host,
      btn('Undo', 'thread-answer-undo', () => host.opts.onUndoAnswer?.(t.id, c.id)),
    );
    undo.title = 'Take this answer back — it reopens the item and keeps a record';
    undo.setAttribute('aria-label', 'Undo this answer and reopen the review item');
    wrap.append(undo);
  }
  return wrap;
}

/**
 * The last row of an EXPANDED thread: the one resolve control, and nothing
 * else.
 *
 * The reply count and the clock that used to sit beside it are both gone. The
 * count restated the replies the open card is already showing and told a
 * folded card's reader a number they could not act on; the clock moved to the
 * head, where "who started it and when" belongs together.
 */
function foot(
  host: ThreadCardHost,
  t: Thread,
  status: 'open' | 'resolved' | 'orphan',
): HTMLElement {
  const foot = div('thread-foot');

  // ONE control, same element and same class in both states, so expanding
  // never swaps it for a different button. It reads as an action before you
  // take it — never icon-only, never green-only-once-resolved.
  const resolved = status === 'resolved';
  const b = lockWrite(
    host,
    btn(resolved ? '✓ Resolved' : '✓ Resolve', 'thread-resolve', () =>
      resolved ? host.opts.onReopen(t.id) : host.opts.onResolve(t.id),
    ),
  );
  b.setAttribute('aria-label', resolved ? 'Reopen thread' : 'Resolve thread');
  foot.appendChild(b);
  return foot;
}

function div(cls: string): HTMLElement {
  const el = document.createElement('div');
  el.className = cls;
  return el;
}

function span(cls: string): HTMLElement {
  const el = document.createElement('span');
  el.className = cls;
  return el;
}

/**
 * A folding slot: two faces stacked in the same box, the summary one and the
 * one it morphs into. Both are absolutely positioned at `top: 0` by CSS, so
 * the slot has no intrinsic height — the morph engine measures the visible
 * face and sets it. That is what lets the opening message land on the exact
 * pixel row the topic line occupied.
 */
function slot(cls: string, summaryFace: Node[], detailFace: Node[]): HTMLElement {
  const el = div(`thread-slot ${cls}`);
  const a = div('thread-face face-summary');
  a.append(...summaryFace);
  const b = div('thread-face face-detail');
  b.append(...detailFace);
  el.append(a, b);
  return el;
}

/** Who else is in the thread, sitting with the discussion line it describes. */
function participantsRow(p: Participants): HTMLElement {
  const row = div('thread-participants clip');
  for (const u of p.repliers) {
    const sw = span('swatch');
    sw.style.background = u.color;
    row.appendChild(sw);
  }
  if (p.label.kind === 'named' && p.label.text.startsWith(p.label.name)) {
    // Style the name, but take the wording from the builder — the seam owns
    // what the row SAYS; this only decides how it looks.
    const nameEl = span('name');
    // Plain text, never HTML: names are untrusted (agent-supplied).
    nameEl.textContent = p.label.name;
    row.append(nameEl, document.createTextNode(p.label.text.slice(p.label.name.length)));
  } else {
    row.appendChild(document.createTextNode(p.label.text));
  }
  return row;
}

/**
 * The header a declared Review Item carries, or null.
 *
 * Kind and headline — the second line was the payload's `why`, and the field
 * went with the structure it imposed (2026-08-25). Whatever an author wrote
 * there is in the body now; a header that quoted the first sentence of it back
 * would be the reader's own words twice.
 *
 * Plain text: the headline is agent-supplied, and unlike the comment BODY it
 * is not markdown — the API takes it as a single-line string and refuses
 * anything else, so rendering it as markup would interpret characters the
 * author was told would be literal.
 */
function reviewHeader(review: Comment['review']): HTMLElement | null {
  if (!review) return null;
  // WITHDRAWN — the asker took this ask back. It renders here and nowhere
  // else: no card, no queue row, no answer box. The words stay because a
  // reader may already have read them, and this is the row that has to say
  // why they are no longer being asked. Marking it is the whole job — an
  // unmarked retracted question is a question, and the reader answers it.
  const withdrawn = reviewWithdrawn(review);
  const box = div(withdrawn ? 'comment-review comment-review-withdrawn' : 'comment-review');
  const kind = span('comment-review-k');
  kind.textContent = withdrawn
    ? 'Withdrawn'
    : review.shape === 'decision'
      ? 'Decision'
      : 'Question';
  const headline = div('comment-review-headline');
  headline.textContent = review.headline;
  box.append(kind, headline);
  if (withdrawn) {
    const note = div('comment-review-withdrawn-note');
    // "Superseded by the item below" is the difference between a
    // disappearance and a correction, so the reason gets its own line when
    // its author wrote one.
    const by = review.withdrawnBy ? `Withdrawn by ${review.withdrawnBy}` : 'Withdrawn';
    note.textContent = review.withdrawnReason ? `${by} — ${review.withdrawnReason}` : by;
    box.append(note);
  }
  return box;
}

/**
 * One reply, in slot B's detail face. The opening message is slot A's.
 *
 * `carriedByItemCard` says the item card above this row is already stating
 * this comment's declaration in full, so the row shows the words and not a
 * second copy of the ask.
 */
function commentRow(c: Comment, carriedByItemCard = false): HTMLElement {
  const row = div(c.review ? 'comment comment-declared' : 'comment');
  const authorRow = div('author');
  const swatch = span('swatch');
  swatch.style.background = c.author.color;
  const name = span('name');
  // Plain text, never HTML: names are untrusted (agent-supplied).
  name.textContent = authorLabel(c.author);
  const time = span('time');
  time.textContent = formatTime(c.ts);
  authorRow.append(swatch, name, time);

  const body = div('body');
  // Comments are untrusted input; renderCommentMarkdown escapes first and
  // only emits a fixed safe tag set, so innerHTML is safe here.
  body.innerHTML = renderCommentMarkdown(c.text);

  const header = carriedByItemCard ? null : reviewHeader(c.review);
  // Above the words, not instead of them: the text is what the agent said,
  // the declaration is what it is asking for.
  row.append(authorRow, ...(header ? [header] : []), body);
  return row;
}

/**
 * Disable a control that POSTS, for a reader the server will refuse.
 *
 * `disabled` is what stops the click; `aria-disabled` is what a screen reader
 * announces, and both are set because a `disabled` button is skipped by some
 * readers rather than reported as unavailable. Under the "You are reading
 * only" banner the whole card used to render live: the decision options took
 * a tap and did nothing — no answer, no error, not even the failure toast a
 * refused post would have shown, because the tap never reached a route that
 * could refuse it.
 *
 * The caret is deliberately NOT locked. Unfolding a card is reading, not
 * writing, and it is the only focusable thing on a folded card — locking it
 * would take the conversation away from a keyboard entirely.
 */
function lockWrite<T extends HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>(
  host: ThreadCardHost,
  el: T,
): T {
  if (host.opts.canWrite !== false) return el;
  el.disabled = true;
  el.setAttribute('aria-disabled', 'true');
  return el;
}

function btn(label: string, cls: string, on: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', on);
  return b;
}

/**
 * The retracted ask, when nothing live has replaced it.
 *
 * Only the NEWEST declaration decides. A withdrawn ask sitting under a later
 * live one is history — the card's state is whatever the newest declaration
 * says — which is the same rule `pendingDeclaration` and
 * `latestDeclaredComment` read, applied to the one outcome neither of them
 * returns.
 */
function withdrawnDeclaration(comments: ReadonlyArray<Comment>): Comment | undefined {
  const byTime = [...comments].sort((a, b) => a.ts - b.ts);
  for (let i = byTime.length - 1; i >= 0; i -= 1) {
    const c = byTime[i];
    if (!c?.review) continue;
    return reviewWithdrawn(c.review) ? c : undefined;
  }
  return undefined;
}

/**
 * The newest declared comment in the thread, answered or not — the one whose
 * card (and, once settled, whose record) the reader should meet. Newest by
 * ts, for the same reason `pendingDeclaration` sorts: a later ask supersedes
 * an earlier one, and a Yjs array's order is a merge order, not a clock.
 */
function latestDeclaredComment(comments: ReadonlyArray<Comment>): Comment | undefined {
  const byTime = [...comments].sort((a, b) => a.ts - b.ts);
  for (let i = byTime.length - 1; i >= 0; i -= 1) {
    const review = byTime[i]?.review;
    if (!review) continue;
    // Skipped, the same way `pendingDeclaration` steps over it: a retracted
    // ask is not the record the reader should meet. Without this the fallback
    // could put a withdrawn question in the card while the queue was offering
    // a live one underneath it — the exact drift that made this rule shared
    // in the first place. Every declaration withdrawn means no card at all,
    // and the thread renders as the conversation it now is.
    if (reviewWithdrawn(review)) continue;
    return byTime[i];
  }
  return undefined;
}
