import {
  type Comment,
  type Participants,
  type ReviewPayload,
  type Thread,
  type User,
  formatTime,
  pendingDeclaration,
  reviewAnswered,
  reviewItemBodyMarkdown,
  summaryKey,
  threadSummary,
} from '@feedback/core';
import { renderCommentMarkdown, renderCommentMarkdownInline } from './comment-markdown.ts';
import { askedMetaLine } from './hub/hub-model.ts';
import { attachMarkdownField } from './md-field.ts';
import {
  isFoldingTap,
  morphThread,
  prefersReducedMotion,
  sizeThreadSlots,
  syncFaceVisibility,
  threadCards,
} from './thread-morph.ts';

// The card's measurement/fold helpers live with the morph engine that owns
// them; re-exported here because the card and its folding are one feature to
// every caller.
export { sizeThreadSlots, syncFaceVisibility };

export type ThreadTab = 'open' | 'resolved' | 'all';

export interface ThreadPanelOpts {
  container: HTMLElement;
  currentUser: User;
  onThreadClick: (threadId: string) => void;
  /**
   * `answersCommentId` is set when this reply ANSWERS a review item declared
   * in the thread — the doc's half of the same contract Home already keeps.
   * The chrome routes those through `/answer` so the item leaves the queue;
   * without an id it posts a plain comment, which is what a thread with
   * nothing outstanding should do.
   *
   * `optionId` rides along when the answer came from TAPPING one of a
   * decision's offered options — provenance only, same contract as the hub:
   * the answer is always the verbatim `text`, and a typed answer sending no
   * id is not answering any less.
   *
   * The return value says whether the post LANDED: resolve `false` and the
   * panel puts the typed words back in the box (every hub composer restores
   * verbatim on refusal; this one used to clear first and toast 'try again'
   * over an empty textarea). Anything else — `true`, `undefined`, a
   * fire-and-forget handler — means posted. Typed `unknown` rather than a
   * union with `void`, so existing handlers that return nothing stay valid.
   */
  onReply: (
    threadId: string,
    text: string,
    answersCommentId?: string,
    optionId?: string,
  ) => unknown;
  /**
   * Take a recorded answer back. `commentId` names the declaring comment the
   * stamps live on; the chrome routes it through `/answer/undo`, which moves
   * them into `answerHistory` (soft delete) and re-offers the item on every
   * queue. Optional because read-only surfaces render the record without
   * offering a button that could only fail.
   */
  onUndoAnswer?: (threadId: string, commentId: string) => void;
  onResolve: (threadId: string) => void;
  onReopen: (threadId: string) => void;
  onReanchor: (threadId: string) => void;
  /**
   * The selection changed — including to nothing, when a tap folds the open
   * card shut. The surface's active-anchor highlight is downstream of this
   * panel's state, and folding is the one transition with no click handler
   * of its own to carry it, so it has to be announced from in here.
   */
  onActiveChange?: (threadId: string | null) => void;
  /** "L293" / "L293–301" label for line-oriented surfaces; null hides it. */
  threadLineLabel?: (threadId: string) => string | null;
}

export class ThreadPanel {
  private activeId: string | null = null;
  private threads: Thread[] = [];
  private statusMap = new Map<string, 'open' | 'resolved' | 'orphan'>();
  private tab: ThreadTab = 'open';
  /**
   * Has this doc's content arrived over the websocket yet? The panel is
   * handed `[]` at mount, long before the first sync lands, so without this
   * an unsynced doc and a genuinely empty one render the identical
   * "No open comments" — an absence presented as a fact, on the surface
   * where a missing comment reads as data loss.
   *
   * One-directional by construction: it only ever moves false → true, so the
   * worst it can do is keep saying "Loading" a beat too long. It can never
   * claim an emptiness it has no way to know.
   */
  private synced = false;
  /** Hash of what we last rendered. Skip re-render when nothing display-relevant changed. */
  private lastRenderKey = '';

  constructor(private opts: ThreadPanelOpts) {}

  /** The first sync landed — from here on, an empty list really is empty. */
  markSynced(): void {
    if (this.synced) return;
    this.synced = true;
    this.render();
  }

  setThreads(threads: Thread[]): void {
    this.threads = threads;
    this.statusMap.clear();
    for (const t of threads) {
      const s =
        t.anchor.kind === 'orphan' ? 'orphan' : t.status === 'resolved' ? 'resolved' : 'open';
      this.statusMap.set(t.id, s);
    }
    this.render();
  }

  /**
   * Select a thread — which is also what expands its card.
   *
   * Toggling must MUTATE the cards on screen, never rebuild them: a freshly
   * built node mounts at its final height and cannot animate, there is no
   * "from" to tween out of. So when the cards this affects are already in the
   * DOM, fold them in place and simply re-stamp the render fingerprint. The
   * full rebuild is the fallback for when the incoming card isn't rendered at
   * all (a different tab, an empty drawer).
   */
  setActive(id: string | null): void {
    if (this.activeId !== id) {
      const previous = this.activeId;
      this.activeId = id;
      this.foldInPlace(previous, id);
      // Rebuild the drawer list ONLY when its own copy of the incoming card
      // isn't there to fold — a different tab, or a list that has never
      // rendered. Every other case has just been mutated in place, so all that
      // is left is to re-stamp the fingerprint.
      if (id && threadCards(id, this.opts.container).length === 0) {
        this.lastRenderKey = '';
        this.render();
      } else {
        this.lastRenderKey = this.computeKey();
      }
    }
    // Announced on every call, not only on a change: a caller re-asserting
    // the current selection is asking for the surface to match it, and the
    // decoration is recomputed from live ranges that may have moved since.
    this.opts.onActiveChange?.(id);
  }

  /**
   * Fold the outgoing card shut and the incoming one open, wherever they are.
   *
   * Deliberately GLOBAL rather than scoped to this panel's container: one
   * thread can be on screen more than once — the drawer row and the margin
   * balloon are literally the same card, and on mobile a thread appears
   * inline and again in the sheet — and every copy shares one expand state.
   * A container-scoped (or `querySelector`-singular) fold animates one copy
   * and leaves the others silently in the wrong state.
   */
  private foldInPlace(previous: string | null, next: string | null): void {
    if (previous) {
      morphThread(previous, false);
      for (const el of threadCards(previous)) el.classList.remove('active');
    }
    if (next) {
      morphThread(next, true);
      for (const el of threadCards(next)) el.classList.add('active');
    }
  }

  /**
   * Bring a thread fully into the panel: switch to a tab that shows it (so
   * clicking a resolved highlight while on the 'open' tab still surfaces it),
   * mark it active, and scroll it into view. This is the doc→panel half of
   * "click a highlight, see its comment" — the editor scroll was already
   * wired; the panel scroll was not.
   */
  revealThread(id: string): void {
    const status = this.statusMap.get(id);
    let tabChanged = false;
    if (status && this.tab !== 'all') {
      const wantTab: ThreadTab = status === 'resolved' ? 'resolved' : 'open';
      if (this.tab !== wantTab) {
        this.tab = wantTab;
        tabChanged = true;
      }
    }
    if (tabChanged) {
      // A different tab is a different list — nothing to fold in place.
      this.activeId = id;
      this.lastRenderKey = '';
      this.render();
      this.opts.onActiveChange?.(id);
    } else {
      // The card is already on screen: fold it in place rather than rebuild
      // the list out from under a morph that is about to run.
      this.setActive(id);
    }
    this.scrollActiveIntoView();
  }

  private scrollActiveIntoView(): void {
    if (!this.activeId) return;
    const sel =
      typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(this.activeId) : this.activeId;
    const row = this.opts.container.querySelector<HTMLElement>(`.thread[data-thread-id="${sel}"]`);
    // 'start', not 'nearest': the active thread expands (comments + reply box)
    // and is often taller than the panel viewport — 'nearest' would land the
    // user on the reply box at the bottom. Align the top so they see the
    // comment from its start.
    row?.scrollIntoView({
      block: 'start',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }

  setTab(tab: ThreadTab): void {
    if (this.tab === tab) return;
    this.tab = tab;
    this.lastRenderKey = '';
    this.render();
  }

  getStatus(threadId: string): 'open' | 'resolved' | 'orphan' | undefined {
    return this.statusMap.get(threadId);
  }

  /** The currently active thread id, or null. Read by the redline balloon
   *  margin so a comment balloon's `.active` styling / reply visibility stays
   *  in sync with the drawer without duplicating the state. */
  getActive(): string | null {
    return this.activeId;
  }

  countByStatus(): { open: number; resolved: number; orphan: number } {
    let open = 0;
    let resolved = 0;
    let orphan = 0;
    for (const s of this.statusMap.values()) {
      if (s === 'open') open++;
      else if (s === 'resolved') resolved++;
      else if (s === 'orphan') orphan++;
    }
    return { open, resolved, orphan };
  }

  /** Cheap fingerprint used to short-circuit renders when nothing user-visible changed.
   *
   *  The topic line is derived from the anchor snippet, which moves when the
   *  doc is edited — independently of every other term here. Leave it out and
   *  an edited anchor keeps a stale topic on screen until some unrelated
   *  change happens to force a repaint. Whatever `threadSummary` reads has to
   *  be in the key, which is why the key comes from `summaryKey` and not from
   *  a field picked out here — a generated summary would otherwise arrive
   *  without moving any term this compares. */
  private computeKey(): string {
    const parts: string[] = [];
    for (const t of this.threads) {
      const status = this.statusMap.get(t.id);
      parts.push(`${t.id}:${status}:${t.commentCount}:${t.lastActivity}:${summaryKey(t)}`);
    }
    // `synced` belongs in the key: the empty state's TEXT depends on it while
    // the thread list stays `[]` either side of the transition, so leaving it
    // out means the memo short-circuits and the drawer keeps the pre-sync
    // wording forever.
    return `${this.tab}|${this.synced ? 's' : 'u'}|${this.activeId ?? ''}|${parts.join('|')}`;
  }

  private filtered(): Thread[] {
    if (this.tab === 'open') {
      return this.threads.filter(
        (t) => this.statusMap.get(t.id) === 'open' || this.statusMap.get(t.id) === 'orphan',
      );
    }
    if (this.tab === 'resolved') {
      return this.threads.filter((t) => this.statusMap.get(t.id) === 'resolved');
    }
    return this.threads;
  }

  private render(): void {
    const c = this.opts.container;
    const key = this.computeKey();
    if (key === this.lastRenderKey) return;

    // Preserve pending reply input so live edits elsewhere don't wipe it.
    const pendingReplies = new Map<string, string>();
    for (const existing of Array.from(c.querySelectorAll<HTMLElement>('.thread'))) {
      const id = existing.getAttribute('data-thread-id');
      const ta = existing.querySelector<HTMLTextAreaElement>('textarea');
      if (id && ta && ta.value) pendingReplies.set(id, ta.value);
    }

    c.innerHTML = '';
    const visible = this.filtered();
    if (visible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'threads-empty';
      // Before the first sync every one of these sentences would be a claim
      // about content that has not arrived. Say what is actually true.
      empty.textContent = !this.synced
        ? 'Loading comments…'
        : this.tab === 'open'
          ? 'No open comments. Select text in the doc to leave one.'
          : this.tab === 'resolved'
            ? 'Nothing resolved yet.'
            : 'No comments on this doc yet.';
      c.appendChild(empty);
      this.lastRenderKey = key;
      return;
    }

    // Open and All group by status. Orphaned is the group that demands an
    // action, and on mobile this list IS the over-doc sheet — the only place
    // an orphaned or resolved thread appears at all, because neither has a
    // line to sit beside inline. The Resolved tab stays flat: a lone
    // "Resolved (N)" heading under a tab already labelled Resolved is noise.
    if (this.tab === 'open' || this.tab === 'all') {
      const groups: Array<[string, Thread[]]> = [
        ['Open', visible.filter((t) => this.statusMap.get(t.id) === 'open')],
        ['Orphaned', visible.filter((t) => this.statusMap.get(t.id) === 'orphan')],
        ['Resolved', visible.filter((t) => this.statusMap.get(t.id) === 'resolved')],
      ];
      for (const [name, ts] of groups) {
        if (ts.length === 0) continue;
        c.appendChild(
          this.heading(
            name === 'Orphaned'
              ? `Orphaned (${ts.length}) — re-anchor needed`
              : `${name} (${ts.length})`,
          ),
        );
        for (const t of sortByActivity(ts))
          c.appendChild(this.renderThread(t, pendingReplies.get(t.id)));
      }
    } else {
      for (const t of sortByActivity(visible))
        c.appendChild(this.renderThread(t, pendingReplies.get(t.id)));
    }
    sizeThreadSlots(c);
    this.lastRenderKey = key;
  }

  private heading(label: string): HTMLElement {
    const h = document.createElement('div');
    h.className = 'section-heading';
    h.textContent = label;
    return h;
  }

  /**
   * Build one thread's card DOM. Used internally by `render()` for the
   * drawer list AND externally by the redline balloon margin — a comment
   * balloon is literally this same card (plus positioning classes), so
   * reply/resolve/reopen/re-anchor behave identically everywhere instead of
   * a second implementation drifting out of sync. Public on purpose.
   *
   * Four rows, and the middle two are *slots* holding two faces each:
   *
   * ```
   * .thread-head    ● Alice · orphan                              ›
   * .thread-slot.slot-a   topic line          ⇄  the opening message
   * .thread-slot.slot-b   who + discussion    ⇄  the replies + reply box
   * .thread-foot    3 replies · 2h                     [ ✓ Resolve ]
   * ```
   *
   * Each summary line is paired with what it BECOMES, and both faces are
   * built here, together, always — the expand animation cross-fades between
   * two faces that already exist in the same box, so neither may be built
   * lazily and neither may be omitted. The head and the foot sit outside
   * both slots so expanding never rebuilds or moves them.
   */
  renderThread(t: Thread, pendingReply?: string): HTMLElement {
    const status = this.statusMap.get(t.id) ?? 'open';
    const summary = threadSummary(t);
    const el = document.createElement('div');
    el.className = `thread status-${status}`;
    if (status === 'resolved') el.classList.add('resolved');
    if (status === 'orphan') el.classList.add('orphan');
    // `expanded` is the class the two slots read; `active` is the drawer's
    // own selection styling. They coincide today (expanded == active), but
    // the slots key off `expanded` so the two can separate later without
    // touching the CSS that folds the card.
    if (this.activeId === t.id) el.classList.add('active', 'expanded');
    // The lookup key for every copy of this thread on screen. A thread can be
    // rendered twice (inline in the doc AND in the mobile sheet), so nothing
    // may address a card by a document-unique id — drive them all from this.
    el.setAttribute('data-thread-id', t.id);

    el.appendChild(this.head(t, status));
    el.appendChild(this.slotA(t, summary.topic));
    el.appendChild(this.slotB(t, summary, status, pendingReply));
    el.appendChild(this.foot(t, status));
    syncFaceVisibility(el, this.activeId === t.id);

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
      if (this.activeId === t.id) this.setActive(null);
      else this.opts.onThreadClick(t.id);
    });

    return el;
  }

  /** Row 1: identity. The attribution for the OPENING MESSAGE and nothing
   *  else — which is why the opening message never repeats the name. */
  private head(t: Thread, status: 'open' | 'resolved' | 'orphan'): HTMLElement {
    const head = div('thread-head');
    head.appendChild(div('status-dot'));

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
    name.textContent = author.name;
    who.appendChild(name);
    // Status only varies where resolved/orphaned threads can appear at all —
    // the margin renders open threads exclusively, so this is empty there.
    if (status !== 'open') {
      const tag = span('thread-tag');
      tag.textContent = ` · ${status}`;
      who.appendChild(tag);
    }
    head.appendChild(who);

    const lineLabel = this.opts.threadLineLabel?.(t.id);
    if (lineLabel) {
      const chip = span('thread-line');
      chip.textContent = lineLabel;
      head.appendChild(chip);
    }

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
    caret.setAttribute('aria-label', 'Toggle comment thread');
    caret.setAttribute('aria-expanded', String(this.activeId === t.id));
    caret.textContent = '›';
    head.appendChild(caret);
    return head;
  }

  /** Slot A: the topic line becomes the opening message, in place. */
  private slotA(t: Thread, topic: string): HTMLElement {
    const topicEl = div('thread-topic clip');
    // Plain text, never HTML: the snippet is doc content, untrusted.
    topicEl.textContent = topic;

    const msg = div('thread-message body');
    // Comments are untrusted input; renderCommentMarkdown escapes first and
    // only emits a fixed safe tag set, so innerHTML is safe here.
    msg.innerHTML = renderCommentMarkdown(t.comments[0]?.text ?? '');

    // A thread whose OPENING comment declared reads as a request from the
    // collapsed card, without opening it — which is the state this pane is in
    // most of the time.
    const header = reviewHeader(t.comments[0]?.review);
    return slot('slot-a', [topicEl], header ? [header, msg] : [msg]);
  }

  /** Slot B: who spoke + where it got to becomes the replies + the reply box. */
  private slotB(
    t: Thread,
    summary: {
      discussion: string;
      discussionKind: 'replies' | 'none' | 'pending';
      participants: Participants | null;
    },
    status: 'open' | 'resolved' | 'orphan',
    pendingReply?: string,
  ): HTMLElement {
    const summaryFace: HTMLElement[] = [];
    // The only row that comes and goes — with nobody but the author in the
    // thread there is nobody to list. Both LINES are always rendered.
    if (summary.participants) summaryFace.push(participantsRow(summary.participants));
    const discussion = div('thread-discussion clip');
    if (summary.discussionKind === 'none') discussion.classList.add('none');
    if (summary.discussionKind === 'pending') discussion.classList.add('pending');
    discussion.textContent = summary.discussion;
    summaryFace.push(discussion);

    const comments = div('comments');
    for (const c of t.comments.slice(1)) comments.appendChild(commentRow(c));

    const reply = div('thread-reply');
    // The ask these words will answer, if there is one. Computed once here
    // because the panel is the only half that holds the conversation — the
    // chrome sees an id and a string and cannot work it out for itself.
    // `pendingDeclaration` is the SAME rule the server's queue reads (core
    // exports one copy): newest declaration wins, ts order not array order,
    // and a resolved thread has nothing pending. Anything looser here offers
    // an Answer composer for an item no queue is showing — answering it
    // stamps a comment Home never offered.
    const pending = pendingDeclaration(t);
    const answering = pending?.id;
    // The item this thread CARRIES, pending or settled: the outstanding ask
    // when there is one, else the latest declaration (whose answered record
    // is what the reader should meet). A thread nobody declared anything on
    // has neither, and renders exactly as it always did.
    const itemComment = pending ?? latestDeclaredComment(t.comments);
    if (answering) reply.classList.add('answering');
    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = answering
      ? `Answer as ${this.opts.currentUser.name}…`
      : `Reply as ${this.opts.currentUser.name}…`;
    if (pendingReply) ta.value = pendingReply;
    reply.appendChild(ta);
    // Every composer speaks markdown (design point 4); refresh covers the
    // programmatic clear below, which fires no `input` event.
    const refreshPreview = attachMarkdownField(ta);
    const submitReply = () => {
      const text = ta.value.trim();
      if (!text) return;
      const posted = this.opts.onReply(t.id, text, answering);
      ta.value = '';
      refreshPreview();
      // A refused post hands the words back — the chrome's 'try again' toast
      // must never point at an empty box. Only while the box is still empty,
      // though: restoring over words typed since would stomp them.
      void Promise.resolve(posted)
        .catch(() => false)
        .then((ok) => {
          if (ok === false && ta.value === '') {
            ta.value = text;
            refreshPreview();
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
    // Resolve/Reopen is NOT here — one control, in the foot, outside the
    // slots. Re-anchoring is a repair, not a reply, and belongs with the
    // conversation it is repairing.
    if (status === 'orphan') {
      actions.appendChild(btn('Re-anchor…', '', () => this.opts.onReanchor(t.id)));
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
      const card = this.itemCard(t, itemComment, itemComment.review, pending !== null);
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
    return slot('slot-b', summaryFace, detailFace);
  }

  /**
   * The FULL review-item interface, in the thread that carries it: the same
   * one-card anatomy as the hub's walkthrough and task panel — head row (kind
   * badge, headline, asked-by meta), one markdown body — then the ways to
   * answer, or the answered record once somebody has. Thread-scoped class
   * names, hub anatomy: the vocabulary must read as one component wherever an
   * item is met.
   */
  private itemCard(t: Thread, c: Comment, review: ReviewPayload, pending: boolean): HTMLElement {
    const card = div('thread-item-card');
    const head = div('thread-item-head');
    // New UI text says Question; the class token stays `review` (stored
    // vocabulary and tone classes are unchanged by the rename in flight).
    const decision = review.shape === 'decision';
    const kind = span(`thread-item-k thread-item-k-${decision ? 'decision' : 'review'}`);
    kind.textContent = decision ? 'Decision' : 'Question';
    head.append(kind);
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
    meta.textContent = askedMetaLine(c.author.name, true, c.ts, Date.now());
    head.append(meta);
    card.append(head);

    // ONE body: why + lookFor + detail composed as markdown, same join as
    // every other surface (`reviewItemBodyMarkdown`).
    const bodyMarkdown = reviewItemBodyMarkdown(review);
    if (bodyMarkdown !== '') {
      const body = div('thread-item-body');
      // Agent-supplied, untrusted; renderCommentMarkdown escapes first and
      // only re-adds a fixed safe tag set.
      body.innerHTML = renderCommentMarkdown(bodyMarkdown);
      card.append(body);
    }

    if (reviewAnswered(review)) {
      card.append(this.answeredRecord(t, c, review));
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
          this.opts.onReply(t.id, o.label, c.id, o.id),
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
   * The answered RECORD, directly below the item it answers: the same shape a
   * tapped option and a typed answer produce everywhere — "Answered by you:
   * …" and a persistent Undo. "you" when the reader answered; the words
   * render markdown-inline because they are a comment's words. Undo is the
   * recovery path for a single unconfirmed tap, so it persists rather than
   * expiring with a toast.
   */
  private answeredRecord(t: Thread, c: Comment, review: ReviewPayload): HTMLElement {
    const wrap = div('thread-answered');
    const line = document.createElement('p');
    line.className = 'thread-answered-line';
    const by = review.answeredBy;
    const who = by !== undefined && by === this.opts.currentUser.name ? 'you' : by;
    line.append(document.createTextNode(who ? `Answered by ${who}: “` : 'Answered: “'));
    const words = span('thread-answer-words');
    // A legacy tapped answer may predate `answerText`; the tapped option's
    // label is the verbatim words it recorded.
    const answerText =
      review.answerText ?? review.options?.find((o) => o.id === review.answeredWith)?.label ?? '';
    words.innerHTML = renderCommentMarkdownInline(answerText);
    line.append(words, document.createTextNode('”'));
    wrap.append(line);
    if (this.opts.onUndoAnswer) {
      const undo = btn('Undo', 'thread-answer-undo', () => this.opts.onUndoAnswer?.(t.id, c.id));
      undo.title = 'Take this answer back — it reopens the item and keeps a record';
      undo.setAttribute('aria-label', 'Undo this answer and reopen the review item');
      wrap.append(undo);
    }
    return wrap;
  }

  /** Row 4: how much conversation there is, and the one resolve control. */
  private foot(t: Thread, status: 'open' | 'resolved' | 'orphan'): HTMLElement {
    const foot = div('thread-foot');
    const meta = span('thread-meta');
    const replies = Math.max(0, t.commentCount - 1);
    const count = replies > 0 ? `${replies} ${replies === 1 ? 'reply' : 'replies'} · ` : '';
    meta.textContent = `${count}${formatTime(t.lastActivity)}`;
    foot.appendChild(meta);

    // ONE control, same element and same class in both states, so expanding
    // never swaps it for a different button. It reads as an action before you
    // take it — never icon-only, never green-only-once-resolved.
    const resolved = status === 'resolved';
    const b = btn(resolved ? '✓ Resolved' : '✓ Resolve', 'thread-resolve', () =>
      resolved ? this.opts.onReopen(t.id) : this.opts.onResolve(t.id),
    );
    b.setAttribute('aria-label', resolved ? 'Reopen thread' : 'Resolve thread');
    foot.appendChild(b);
    return foot;
  }
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
 * The two-line header a declared Review Item carries, or null.
 *
 * Plain text on both lines: they are agent-supplied, and unlike the comment
 * BODY they are not markdown — the API takes them as single-line strings and
 * refuses anything else, so rendering them as markup would interpret
 * characters the author was told would be literal.
 */
function reviewHeader(review: Comment['review']): HTMLElement | null {
  if (!review) return null;
  const box = div('comment-review');
  const kind = span('comment-review-k');
  kind.textContent = review.shape === 'decision' ? 'Decision' : 'Review';
  const headline = div('comment-review-headline');
  headline.textContent = review.headline;
  const why = div('comment-review-why');
  why.textContent = review.why;
  box.append(kind, headline, why);
  return box;
}

/** One reply, in slot B's detail face. The opening message is slot A's. */
function commentRow(c: Comment): HTMLElement {
  const row = div(c.review ? 'comment comment-declared' : 'comment');
  const authorRow = div('author');
  const swatch = span('swatch');
  swatch.style.background = c.author.color;
  const name = span('name');
  // Plain text, never HTML: names are untrusted (agent-supplied).
  name.textContent = c.author.name;
  const time = span('time');
  time.textContent = formatTime(c.ts);
  authorRow.append(swatch, name, time);

  const body = div('body');
  // Comments are untrusted input; renderCommentMarkdown escapes first and
  // only emits a fixed safe tag set, so innerHTML is safe here.
  body.innerHTML = renderCommentMarkdown(c.text);

  const header = reviewHeader(c.review);
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
    if (byTime[i]?.review) return byTime[i];
  }
  return undefined;
}

function sortByActivity(ts: Thread[]): Thread[] {
  return [...ts].sort((a, b) => b.lastActivity - a.lastActivity);
}
