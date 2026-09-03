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
 *
 * ---------------------------------------------------------------------------
 * WHAT A COLLAPSED CARD IS FOR
 * ---------------------------------------------------------------------------
 *
 * A reader scanning a meeting's doc has one question per card — "is this one
 * mine?" — and answers it in about a second. The collapsed card has exactly
 * four jobs, and every pixel of it serves one of them:
 *
 *  1. WHAT IS IT ABOUT.  Line one leads with the topic: the ask's headline
 *     when the thread carries one, otherwise the generated summary topic.
 *     Never the sentence it hangs off — the highlight in the prose already
 *     shows that, and a card repeating it said nothing about what was wanted.
 *  2. WHO IS IT WAITING ON.  The glyph says which KIND of wait (blue bubble
 *     for a comment, amber question for an open ask, green tick once it is
 *     settled), and line one names who started it. Together they answer
 *     "does this need me" without opening anything.
 *  3. ANSWER IT, OR OPEN IT.  A thread that is waiting on this reader grows
 *     one answer row under the two lines — a decision's options as buttons,
 *     a question's "Answer" cue — so the common case is finished from the
 *     folded card. Everything else is behind the chevron.
 *  4. OPEN OR RESOLVED.  Carried by the glyph and by the card's own wash,
 *     not by a word: a resolved card is faded and green-ticked.
 *
 * And the things a collapsed line deliberately does NOT carry, each removed
 * because it cost a line without answering one of the four (Bryan, round 2 of
 * the card mocks): a reply count, a "Decision needed" tag, a "New" word tag,
 * a participants row, a second copy of the title, a resolve button, and the
 * timestamp. Anything added here has to name which of the four it serves.
 *
 * ---------------------------------------------------------------------------
 * THE ANATOMY
 * ---------------------------------------------------------------------------
 *
 * ```
 * .thread-head    ◆ topic · Who                                 ›   ← line 1
 * .thread-slot      where the conversation got to                   ← line 2
 *                   [ option ] [ option ]                           ← answers
 * ```
 *
 * Line one and the glyph STAY PUT when the card opens (approved: card mock
 * round 3) — the row you tapped becomes the open card's header rather than
 * being replaced by a second panel that repeats it. Only line two is a
 * folding slot: its summary face is the discussion line plus the answer row,
 * and its detail face is the same discussion line followed by the whole
 * conversation. One slot, not two, because there is only one disclosure.
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
 * Two rows, and only the second one folds:
 *
 * ```
 * .thread-head        ◆ topic · Who                             ›
 * .thread-slot.slot-a   discussion + answers ⇄  the conversation
 * ```
 *
 * The head is built once and never rebuilt or moved: the title and the glyph
 * are in the same place folded and unfolded, which is what makes opening read
 * as "this card grew" rather than "a second panel appeared under it".
 *
 * The slot holds two faces at once — the expand animation cross-fades between
 * two boxes that already exist, so neither may be built lazily and neither
 * may be omitted. Both faces open with the discussion line for that reason:
 * the summary face must never be empty (an empty face measures zero, and a
 * zero is refused rather than written, which would leave a card that opens
 * and cannot close), and repeating one short line is what keeps it honest.
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

  // A declared thread's folded line is the ASK, not the sentence it hangs
  // off: the highlight in the prose already shows the sentence, and a card
  // that repeated it said nothing about what was wanted.
  const topicIsAsk = itemComment?.review?.headline !== undefined;
  const topic = itemComment?.review?.headline ?? summary.topic;
  el.appendChild(head(host, t, status, { kind, topic, topicIsAsk }));
  el.appendChild(body(host, t, summary, status, { pending, itemComment, pendingReply }));
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

/**
 * Line one, and the row that stays put.
 *
 * Glyph, topic, who started it, the caret — built once, never rebuilt, and
 * identical folded and unfolded. That is the whole of Bryan's round-2 note
 * about the card: opening it must not stack a second box under a row that
 * then repeats itself.
 *
 * Everything that used to sit here and is now gone was removed for the same
 * reason — it cost a line and answered none of the four jobs in this file's
 * header. The "Decision needed" flag went with the loudest of them: a
 * decision announces itself through the amber glyph and the option buttons
 * on the folded card, and the flag was a third statement of the same fact
 * that clipped the asker's name to seven characters in a 300px column.
 */
function head(
  host: ThreadCardHost,
  t: Thread,
  status: 'open' | 'resolved' | 'orphan',
  mark: { kind: ReturnType<typeof threadKind>; topic: string; topicIsAsk: boolean },
): HTMLElement {
  const head = div('thread-head');
  // ONE glyph per state, everywhere it appears: blue bubble for a comment,
  // amber question mark for an open review item (question or decision
  // alike), green tick once answered or resolved. The same glyph sits on
  // the highlighted sentence, the top-bar chip and the off-screen hints.
  const glyph = span(`thread-glyph lf-ic lf-ic-${threadGlyph(mark.kind)}`);
  glyph.setAttribute('aria-hidden', 'true');
  // Unread rides the glyph as a dot rather than a "New" tag beside the name.
  // A word there competed with the topic for the one line the card has, and
  // said less than a mark on the thing it is marking.
  if (host.opts.isNew?.(t)) glyph.appendChild(span('thread-new-dot'));
  head.appendChild(glyph);

  const line = div('thread-topic-line clip');
  // Plain text, never HTML: the topic is doc content or an agent-supplied
  // headline, and both are untrusted.
  const topicEl = span('thread-topic');
  topicEl.textContent = mark.topic;
  line.appendChild(topicEl);

  // Who started it — the attribution for the OPENING MESSAGE, which is why
  // the opening message itself never repeats the name. The separator is its
  // own node so the name reads as exactly the name to anything that asks
  // for it, here and in the hub's activity feed.
  //
  // NOT on a card whose line one is an ASK (the approved mock: a question or
  // decision card carries the ask and the chevron and nothing else). Two
  // reasons, and the first is measured: in a 260px balloon "Induction
  // ordering · Rota Assistant" clipped the name to seven characters, which is
  // the same failure that cost the old decision flag its row. The second is
  // that the name answers a different question here — the ask is addressed TO
  // the reader, so who asked matters when they open it, and the opened card
  // names them directly under line one.
  const author = t.comments[0]?.author ?? t.createdBy;
  const sep = span('thread-sep');
  sep.textContent = ' · ';
  const who = span('thread-who');
  const name = span('name');
  // Plain text, never HTML: author names are agent-supplied and untrusted.
  name.textContent = authorLabel(author);
  who.appendChild(name);
  // Status only varies where resolved/orphaned threads can appear at all —
  // the margin renders open threads exclusively, so this is empty there. An
  // orphan is the one status worth a word: it has lost its anchor and needs
  // repairing, which no glyph says. Resolved is carried by the tick and the
  // card's own fade.
  if (status === 'orphan') {
    const tag = span('thread-tag');
    tag.textContent = ' · orphan';
    who.appendChild(tag);
  }
  if (!mark.topicIsAsk || status === 'orphan') line.append(sep, who);

  const lineLabel = host.opts.threadLineLabel?.(t.id);
  if (lineLabel) {
    const chip = span('thread-line');
    chip.textContent = lineLabel;
    line.appendChild(chip);
  }
  head.appendChild(line);

  // Top right, as far from ✓ Resolve as the card allows: the two were a
  // thumb-width apart, and the misfire that costs you resolves a thread.
  //
  // A real <button>, and the ONLY focusable thing on a collapsed card: the
  // whole card is the tap target, but a tap is not a gesture a keyboard or
  // a screen reader has, and the detail face is `inert` while folded — so
  // without this the opening message and every reply are unreachable. It
  // stays a HINT rather than the hit area because it has no handler of its
  // own: its click bubbles to the card's toggle like any other tap on the
  // card (`isFoldingTap` lets exactly this one control through).
  const caret = document.createElement('button');
  caret.type = 'button';
  caret.className = 'thread-caret';
  // Named for its own thread, not "Toggle comment thread" on every card. A
  // sighted reader tells the column apart by the topic and the glyph; a
  // keyboard user tabbing it got a run of identical buttons, with no way to
  // know which thread they were on or which one was holding a decision. The
  // decision half is also the only place that fact reaches a screen reader
  // at all, now that the flag row it used to announce is gone.
  const decision = threadDecision(t);
  const decisionSuffix =
    decision === 'pending' ? ', decision needed' : decision === 'answered' ? ', decision' : '';
  caret.setAttribute('aria-label', `Comment from ${authorLabel(author)}${decisionSuffix}`);
  caret.setAttribute('aria-expanded', String(host.activeId() === t.id));
  // One glyph in both states — the rotation is the state. Words here ("Details
  // ▾" / "Less ▴") were a second label on a row that already has a topic and
  // a name to read; the caret's `aria-expanded` is what actually announces
  // the fold, and it says it in both.
  caret.textContent = '›';
  head.appendChild(caret);
  return head;
}

/**
 * Line two, and the only thing that folds.
 *
 * Summary face: where the conversation got to, plus — when this thread is
 * waiting on the reader — the row that answers it without opening anything.
 * Detail face: the same summary line, then the whole thread.
 *
 * The summary line is repeated at the top of the detail face on purpose. It
 * keeps line two in place across the fold (the mock's "the row you tapped
 * becomes the header"), and it reads as the abstract over the history below
 * it, which is a different thing from the raw replies: one is what the thread
 * MEANS, the other is what was said.
 */
function body(
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
    pendingReply?: string;
  },
): HTMLElement {
  const { pending, itemComment, pendingReply } = item;

  // A review item answers from its FOLDED face (approved: comments mock 3).
  // A decision offers its option labels right there; a question shows
  // where to tap; an answered item keeps a compact record — who, when, and
  // the words — so nothing has to be opened to see what a card is asking or
  // what it was told. The full item card, with the detail and each option's
  // reasoning, stays one fold away behind the chevron.
  const compact = itemComment?.review
    ? compactItemLine(host, t, itemComment, itemComment.review, pending !== null)
    : null;
  // Line two of the FOLDED card is one thing or the other, and sometimes
  // neither. "No replies yet" is a fact about the card the reader can do
  // nothing with, it is true of most review items and of every thread nobody
  // has answered yet, and it lands on resolved cards too — where it is the
  // last thing left to say about a thread that is finished. A card with
  // nothing on line two folds to its head, which is the one line this
  // redesign is named for.
  //
  // That makes an EMPTY summary face reachable, and `sizeThreadSlots` used to
  // refuse every zero it measured. It now refuses a zero only from a face
  // that has children — the case its guard was written for, a subtree not
  // being laid out — so an empty face closes to nothing and still reopens.
  const summaryFace: HTMLElement[] = [];
  if (summary.discussionKind !== 'none') summaryFace.push(discussionLine(summary));
  if (compact) summaryFace.push(compact);

  // The opened card shows every reply in full below, so a summary of them is
  // an abstract over something already on screen — worth keeping while it
  // says something, and never worth a line to say there is nothing. The
  // detail face always carries the opening message and the foot, so dropping
  // this one can never leave it empty.
  const detailFace: Node[] = summary.discussionKind === 'none' ? [] : [discussionLine(summary)];

  // Who opened this and when. On the folded card the name rides line one;
  // here it is the attribution for the opening message directly under it,
  // which is why that message never repeats the name.
  const opening = t.comments[0];
  if (opening) detailFace.push(askedMeta(opening));

  const msg = div('thread-message body');
  // Comments are untrusted input; renderCommentMarkdown escapes first and
  // only emits a fixed safe tag set, so innerHTML is safe here.
  msg.innerHTML = renderCommentMarkdown(opening?.text ?? '');
  // The banner an opening declaration carries — SUPPRESSED when the item
  // card below is already carrying this same declaration, which is the usual
  // case for a declared thread. Both render the kind chip, the headline and
  // the why, so leaving both in place stated the question twice and pushed
  // the interface that answers it below the fold. Kept for a declaration no
  // card is showing (a superseded ask, still part of the history): there,
  // nothing else says it was ever asked.
  const openingHeader =
    opening && opening.id !== itemComment?.id ? reviewHeader(opening.review) : null;
  if (openingHeader) detailFace.push(openingHeader);
  detailFace.push(msg);

  const comments = div('comments');
  // Same suppression one row further down: a reply that declared the ask the
  // item card is carrying must not repeat its chip, headline and why in the
  // history directly beneath the card that just said them.
  for (const c of t.comments.slice(1))
    comments.appendChild(commentRow(c, c.id === itemComment?.id));

  const reply = div('thread-reply');
  // The ask these words will answer, if there is one. `pendingDeclaration`
  // (computed by the caller, above the slot) is the SAME rule the server's
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
  reply.appendChild(ta);
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
  actions.appendChild(btn(answering ? 'Answer' : 'Reply', 'primary', submitReply));
  // Resolve/Reopen is NOT here — one control, in the foot at the bottom of
  // this face. Re-anchoring is a repair, not a reply, and belongs with the
  // conversation it is repairing.
  if (status === 'orphan') {
    actions.appendChild(btn('Re-anchor…', '', () => host.opts.onReanchor(t.id)));
  }
  reply.appendChild(actions);

  // A thread that carries a review item IS the review item (approved
  // design, review-flow-mock-v1; Bryan verbatim: "if I open a comment that
  // has one or more review items in it, I should get the full review item
  // interface, with the comment history secondary"). The full item card
  // renders FIRST, and while the item is pending the one composer is the
  // card's answer box. Once settled the card holds the answered record and
  // the composer returns to its usual place as a plain Reply.
  if (itemComment?.review) {
    const card = itemCard(host, t, itemComment, itemComment.review, pending !== null, {
      // The asked-by line above already attributes this declaration when the
      // opening comment IS the declaration — the usual case. Printing it in
      // the card too put "Rota Assistant · 8m" and "Asked by Rota Assistant 8
      // minutes ago" three lines apart on one open card. Kept for a
      // declaration that arrived as a REPLY, where the two name different
      // people at different times and the card is the only thing that says
      // who put the question.
      attributed: itemComment.id === opening?.id,
    });
    if (answering) card.append(reply);
    detailFace.push(card);
  }
  // The history is headed "Comments" and nothing counts replies (Bryan,
  // round 2: a count answers none of the collapsed card's four jobs, and
  // opened cards are read, not tallied). The heading only appears when
  // there is a history to head.
  if (t.comments.length > 1) {
    const label = div('thread-history-label');
    label.textContent = 'Comments';
    detailFace.push(label);
  }
  detailFace.push(comments);
  if (!answering) detailFace.push(reply);
  detailFace.push(foot(host, t, status));

  return slot('slot-a', summaryFace, detailFace);
}

/** Line two's text, built twice — once per face. */
function discussionLine(summary: {
  discussion: string;
  discussionKind: 'replies' | 'none' | 'pending';
}): HTMLElement {
  const discussion = div('thread-discussion clip');
  if (summary.discussionKind === 'none') discussion.classList.add('none');
  if (summary.discussionKind === 'pending') discussion.classList.add('pending');
  discussion.textContent = summary.discussion;
  return discussion;
}

/**
 * Who opened the thread and when, under line one on the opened card.
 *
 * The swatch is here rather than on line one: on the folded card the glyph
 * already owns the left edge, and a second coloured mark beside it made two
 * different threads read as the same one at a glance.
 */
function askedMeta(opening: Comment): HTMLElement {
  const meta = div('thread-asked-meta');
  const swatch = span('swatch');
  // Assigning a style PROPERTY can't smuggle extra declarations the way an
  // interpolated style ATTRIBUTE can — the CSS parser drops the whole value
  // if it isn't a colour.
  swatch.style.background = opening.author.color;
  const who = span('thread-asked-who');
  // Plain text, never HTML: author names are agent-supplied and untrusted.
  who.textContent = `${authorLabel(opening.author)} · ${formatTime(opening.ts)}`;
  meta.append(swatch, who);
  return meta;
}

/**
 * The folded face's answer row for a declared thread. Pending decision:
 * the option labels as buttons, wired to the SAME reply route the full card
 * uses. Pending question: an "Answer" cue — tapping it folds the card open
 * onto the composer, so it is a span, not a control, and rides the card's
 * own tap. Answered: the record, one line.
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
    // WHAT was decided, on the folded card. A decision's outcome used to ride
    // the "Decision" flag row above the head instead, and was suppressed here
    // to avoid saying it twice; the flag row went with the collapsed redesign,
    // so this is now the only place a folded card can say it. Without it an
    // answered decision folded to "✓ — decided by Bryan", which names
    // everything except the decision.
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
      const b = btn(o.label, 'thread-item-option thread-item-option-compact', () =>
        host.opts.onReply(t.id, o.label, c.id, o.id),
      );
      if (o.detail) b.title = o.detail;
      opts.appendChild(b);
    }
    return opts;
  }
  const cue = span('thread-answer-cta');
  cue.textContent = 'Answer';
  return cue;
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
  opts: { attributed?: boolean } = {},
): HTMLElement {
  const card = div('thread-item-card');
  const head = div('thread-item-head');
  // New UI text says Question; the class token stays `review` (stored
  // vocabulary and tone classes are unchanged by the rename in flight).
  const decision = review.shape === 'decision';
  const kind = span(`thread-item-k thread-item-k-${decision ? 'decision' : 'review'}`);
  kind.textContent = decision ? 'Decision' : 'Question';
  head.append(kind);
  // NO headline here. Line one of the card above is this very headline —
  // `renderThreadCard` takes the topic from `itemComment.review.headline`,
  // and this card is that same declaration — so printing it again put the
  // ask twice on one open card, in two type sizes, and pushed the buttons
  // that answer it further down. The chip and the asked-by line stay: they
  // say what KIND of ask it is and who is waiting, which line one does not.
  if (!opts.attributed) {
    const meta = document.createElement('p');
    meta.className = 'thread-item-meta';
    // A declaration IS an ask, so this always reads "Asked" — same judgment
    // the hub's `askedMeta` records for declared items. The clock is the
    // declaring comment's, which is when the question was put.
    meta.textContent = askedMetaLine(authorLabel(c.author), true, c.ts, Date.now());
    head.append(meta);
  }
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
      const b = btn('', 'thread-item-option', () =>
        // The tap answers with the option's VERBATIM label — the id is
        // provenance the chrome forwards to `/answer`, never the answer.
        host.opts.onReply(t.id, o.label, c.id, o.id),
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
 * Three parts, in reading order: the label ("Decision" or "Answer",
 * following the same shape the card's kind chip reads), the verbatim
 * outcome, then who settled it and when. Undo is the recovery path for a
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
    const undo = btn('Undo', 'thread-answer-undo', () => host.opts.onUndoAnswer?.(t.id, c.id));
    undo.title = 'Take this answer back — it reopens the item and keeps a record';
    undo.setAttribute('aria-label', 'Undo this answer and reopen the review item');
    wrap.append(undo);
  }
  return wrap;
}

/**
 * The one resolve control, at the bottom of the opened card.
 *
 * It used to sit outside the fold beside "3 replies · 2h". Both went with the
 * collapsed redesign: the count answered none of the four jobs a folded line
 * has, and a Resolve a thumb-width from the chevron is a misfire that closes
 * somebody's thread. Resolving is now a deliberate act on an open card.
 */
function foot(
  host: ThreadCardHost,
  t: Thread,
  status: 'open' | 'resolved' | 'orphan',
): HTMLElement {
  const foot = div('thread-foot');
  // ONE control, same element and same class in both states, so resolving
  // and reopening are never two different buttons. It reads as an action
  // before you take it — never icon-only, never green-only-once-resolved.
  const resolved = status === 'resolved';
  const b = btn(resolved ? '\u2713 Resolved' : '\u2713 Resolve', 'thread-resolve', () =>
    resolved ? host.opts.onReopen(t.id) : host.opts.onResolve(t.id),
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
 * The folding slot: two faces stacked in the same box, the summary one and
 * the one it morphs into. Both are absolutely positioned at `top: 0` by CSS,
 * so the slot has no intrinsic height — the morph engine measures the visible
 * face and sets it. That is what lets the conversation land on the exact
 * pixel row the discussion line occupied.
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

function btn(label: string, cls: string, on: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', on);
  return b;
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
