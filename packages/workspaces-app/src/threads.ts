import { type Thread, type User, threadRenderKey } from '@feedback/core';
import {
  keptComposerFocus,
  keptScrollTops,
  restoreComposerFocus,
  restoreScrollTops,
} from './composer-keep.ts';
import { type ThreadCardHost, renderThreadCard } from './doc/thread-card.ts';
import {
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
   * decision's offered options — provenance only, same contract as the board:
   * the answer is always the verbatim `text`, and a typed answer sending no
   * id is not answering any less.
   *
   * The return value says whether the post LANDED: resolve `false` and the
   * panel puts the typed words back in the box (every board composer restores
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
  /**
   * Has this thread changed since the reader last looked (`comment-seen.ts`)?
   * Stamps `is-new` on the card — a red dot on its glyph. Cleared IN PLACE by
   * the chrome once the thread has sat in view, never by a rebuild, so it is
   * deliberately not part of the render key.
   */
  isNew?: (t: Thread) => boolean;
  /**
   * Can this reader post? The server's answer, carried down from the mount
   * context — NOT a hopeful `true` the card narrows later.
   *
   * `false` disables every control on a card that posts: the option buttons,
   * the folded answer field, the reply composer, Resolve/Reopen, Undo. A
   * read-only reader was getting the full working card under the "You are
   * reading only" banner, and tapping a decision option did nothing at all —
   * the request never reached a route that could refuse it, so there was not
   * even a failure toast to read.
   *
   * Optional, defaulting to writable, because the panel is built in a dozen
   * tests that have no notion of access. The three surfaces that mount the
   * chrome must pass it: `ChromeOpts.canWrite` is required for exactly that
   * reason.
   */
  canWrite?: boolean;
}

export class ThreadPanel {
  private activeId: string | null = null;
  /**
   * A thread whose conversation is being shown somewhere this panel does not
   * own — today, inside the wide modal.
   *
   * Selection and EXPANSION were the same thing until the modal arrived, and
   * the card's own comment has said for a while that the two key off different
   * classes so they could separate later. This is later. The thread stays
   * selected (the anchor highlight is downstream of that, and so is the drawer
   * row's styling) while every copy in the column, the drawer and the sheet
   * stays folded — otherwise the same conversation renders two and three times
   * under the scrim, dimmed and unreadable but still there to be scrolled past.
   */
  private expandedElsewhere: string | null = null;
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
      // Selected, but not unfolded here: something else is already showing
      // this conversation full size, and a second copy under it is noise.
      if (next !== this.expandedElsewhere) morphThread(next, true);
      for (const el of threadCards(next)) el.classList.add('active');
    }
  }

  /**
   * Hand this thread's expansion to another surface, or take it back.
   *
   * Only ever FOLDS on the way in. Handing it back re-opens the copies only
   * when the caller passes `null` — a straight hand-off from one thread to
   * another (the modal switching threads) would otherwise flash the outgoing
   * thread open for the instant before its deselection folds it again.
   */
  setExpandedElsewhere(id: string | null): void {
    const previous = this.expandedElsewhere;
    if (previous === id) return;
    this.expandedElsewhere = id;
    if (id && id === this.activeId) morphThread(id, false);
    else if (id === null && previous && previous === this.activeId) morphThread(previous, true);
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
   *  Every term comes from `threadRenderKey` rather than from fields picked
   *  out here, and that is the whole point: the two things this panel shows
   *  which move on their own — a generated summary landing, an answer being
   *  stamped or taken back — change no count and no clock, so a
   *  hand-assembled key comes out identical across both and the card never
   *  repaints. The balloon margin memoizes the same card off the same
   *  function, so the two cannot drift. */
  private computeKey(): string {
    const parts: string[] = [];
    for (const t of this.threads) {
      parts.push(threadRenderKey(t));
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
    // …and the caret and the scroll with it: this render fires on background
    // events (a peer's reply on ANOTHER thread, a summary landing), and the
    // rebuild below would otherwise drop focus to body and let the emptied
    // pane clamp its scrollTop to 0 under whoever is typing.
    const keptFocus = keptComposerFocus(c);
    const keptScroll = keptScrollTops(c);

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
    if (keptFocus) restoreComposerFocus(c, keptFocus);
    restoreScrollTops(keptScroll);
    this.lastRenderKey = key;
  }

  private heading(label: string): HTMLElement {
    const h = document.createElement('div');
    h.className = 'section-heading';
    h.textContent = label;
    return h;
  }

  /**
   * One thread's card. Used by this panel's own list AND, through this same
   * method, by the redline balloon margin — the balloon IS this card. The
   * rendering lives in doc/thread-card.ts; what stays here is the panel state
   * it reads, handed over as live calls rather than a render-time copy.
   */
  renderThread(t: Thread, pendingReply?: string): HTMLElement {
    return renderThreadCard(this.cardHost(), t, pendingReply);
  }

  /** The panel, as a card sees it. Rebuilt per call and read through, so a
   *  handler that runs after the render still sees current state. */
  private cardHost(): ThreadCardHost {
    return {
      opts: this.opts,
      activeId: () => this.activeId,
      expandedElsewhere: () => this.expandedElsewhere,
      statusOf: (id) => this.statusMap.get(id),
      setActive: (id) => this.setActive(id),
    };
  }
}

function sortByActivity(ts: Thread[]): Thread[] {
  return [...ts].sort((a, b) => b.lastActivity - a.lastActivity);
}
