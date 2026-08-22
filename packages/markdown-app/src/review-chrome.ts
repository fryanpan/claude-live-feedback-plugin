import {
  SUMMARY_PENDING_WINDOW_MS,
  type Thread,
  type User,
  formatTime,
  readDocMeta,
  readReviewPayload,
  readStoredSummary,
  summaryPending,
} from '@feedback/core';
import type * as Y from 'yjs';
import { threadNeedsModal } from './long-thread.ts';
import { attachMarkdownComposer, focusMarkdownComposer } from './md-composer.ts';
import { type MobileReview, mountMobileReview } from './mobile-review.ts';
import type { MountScope } from './mount-scope.ts';
import type { ReviewSurface } from './review-surface.ts';
import { setTabTitle, tabName } from './tab-title.ts';
import { type ThreadModalHandle, mountThreadModal } from './thread-modal.ts';
import { installSlotRemeasure, sizeThreadSlots } from './thread-morph.ts';
import { ThreadPanel, type ThreadTab } from './threads.ts';

/**
 * The review "chrome" — everything around the editor that is identical for
 * every SPA surface (markdown / code / diff): the threads drawer + tabs +
 * panel callbacks, the composer sheet, the mobile full-screen thread view,
 * thread collection/decoration plumbing, the doc-title label, hotkeys, and
 * the small DOM helpers. Extracted from app.ts / code-app.ts, which had
 * forked ~450 duplicated lines of this wiring; each boot now supplies only
 * its genuinely surface-specific parts via `ChromeOpts`.
 */

export interface ChromeSelection {
  start: Uint8Array;
  end: Uint8Array;
  snippet: string;
  /**
   * Set by the redline surface when the selection was entirely base-only
   * (struck-through) text, which has no position in `content`. The anchor
   * snaps to the nearest following retained line; this records what the
   * comment was actually about.
   */
  deletedSnippet?: string;
}

/**
 * Build the wire anchor for a selection.
 *
 * ONE place on purpose. Every anchor body here is hand-built field by field,
 * so a new field added to ChromeSelection but not copied is silently dropped —
 * the server accepts it, returns 200, and the data is gone. That is exactly
 * how `deletedSnippet` first shipped broken (and how `groups` did before it;
 * see docs/process/learnings.md). Add new anchor fields HERE, not at the call
 * sites.
 */
export function anchorBody(sel: ChromeSelection) {
  return {
    kind: 'text-range' as const,
    startRel: Array.from(sel.start),
    endRel: Array.from(sel.end),
    snippet: { text: sel.snippet },
    ...(sel.deletedSnippet ? { deletedSnippet: sel.deletedSnippet } : {}),
  };
}

export interface ChromeOpts {
  docId: string;
  user: User;
  ydoc: Y.Doc;
  surface: ReviewSurface;
  /**
   * Register a callback for "this doc's content has arrived" — pass the
   * client's `onReady`, which fires immediately when the first sync already
   * landed. Until it fires, the thread drawer says "Loading comments…"
   * instead of "No open comments", because the panel is handed `[]` at mount
   * and the two states are otherwise indistinguishable on screen.
   *
   * REQUIRED on purpose, though only one branch of one render reads it:
   * there are three surfaces mounting this chrome, and an optional field is
   * how two of them would quietly keep claiming a doc is empty. Making it
   * required turns "did I wire all three" into a compile error.
   */
  whenSynced: (cb: () => void) => void;
  /** Fallback for the topbar label, from the REST meta the router already
   *  fetched. The Yjs meta map no longer carries `sourceUrl` — it named a path
   *  on the host and the CRDT syncs to share visitors — so the label can't come
   *  from there any more. The owner gets the full path exactly as before; a
   *  share visitor gets the basename `relPath` the redacted payload supplies,
   *  which beats the opaque docId they'd otherwise fall back to. */
  labelHint?: string;
  /** Toast shown when the composer opens without a usable selection. */
  selectHint: string;
  /** Toast shown when re-anchor is clicked without a selection. */
  reanchorHint: string;
  /** Current selection for composer/re-anchor. Surfaces own their caching
   *  quirks (iOS blur, caret expansion) behind this. */
  getSelection: () => ChromeSelection | null;
  /** Runs right after the composer sheet opens (markdown scrolls the
   *  selection above the keyboard here). */
  onComposerOpened?: () => void;
  /** Runs after a comment posts successfully (markdown blurs the editor). */
  onPosted?: () => void;
  /** Hide the surface's comment pill (called when the composer or the
   *  thread view opens). */
  hidePill?: () => void;
  /** Per-document lifecycle scope. When provided, every listener this mount
   *  registers is torn down on `scope.dispose()` and the chrome self-registers
   *  its `destroy()` — so navigating to another doc leaves no double-bound
   *  submit handlers (which would post to the previous docId). */
  scope?: MountScope;
  /** The surface mounts a balloon margin (markdown / editable redline). When
   *  the margin is actually visible (≥1101px), balloons already show every
   *  anchored thread, so the side drawer defaults CLOSED there — it would be
   *  a second copy of the same comments. An explicit user toggle overrides
   *  the default for the rest of the session. */
  hasBalloonMargin?: boolean;
}

/**
 * The width at or below which comment cards sit inline in the document.
 *
 * The SAME boundary the balloon margin hides at (`markup-margin.ts`), and
 * deliberately so: one always-on comment surface at every width, never two
 * and never none. 901–1100px used to fall between them — the margin had
 * already collapsed and inline cards had not yet started — which left the
 * drawer as the only way to see a comment.
 */
export const INLINE_CARDS_QUERY = '(max-width: 1100px)';

export function inlineCardsVisible(): boolean {
  return window.matchMedia(INLINE_CARDS_QUERY).matches;
}

/**
 * Should the threads drawer start open for this mount? Pure so the
 * drawer-default policy is unit-testable without a DOM.
 *  - mobile: never (it's an overlay there)
 *  - user toggled it this session: their choice wins
 *  - an always-on surface is showing (balloon margin, or inline cards):
 *    closed, because that surface already shows every comment and the drawer
 *    would be a second copy of the same threads
 *  - otherwise (a code doc above 1100px, which has neither): open
 */
export function initialDrawerOpen(opts: {
  isDesktop: boolean;
  marginVisible: boolean;
  /** Inline cards cover this width — see `INLINE_CARDS_QUERY`. */
  inlineVisible: boolean;
  stored: string | null;
}): boolean {
  if (!opts.isDesktop) return false;
  if (opts.stored === 'open') return true;
  if (opts.stored === 'closed') return false;
  return !opts.marginVisible && !opts.inlineVisible;
}

const DRAWER_PREF_KEY = 'lf:drawer';

/** Above this, a 320px doc list costs the prose nothing — Bryan's 4K monitor.
 *  Every phone, tablet and laptop is one tier below it and shares one answer.
 *  Deliberately NOT an attempt to identify a device: pinch-zoom scales the
 *  layout viewport (a 1366px iPad at 85% reports 1607px), so width cannot say
 *  what hardware this is. It can still say how much room there is. */
export const WIDE_SCREEN_QUERY = '(min-width: 1921px)';

const SET_PANE_PREF_KEY = 'lf:set-pane';

/** Whether the review-set sidebar starts open. A stored choice wins in both
 *  directions; with nothing stored, only a 4K-class screen opens it. */
export function initialSetPaneOpen(stored: string | null, isWide: boolean): boolean {
  if (stored === 'open') return true;
  if (stored === 'closed') return false;
  return isWide;
}

/** Wire the topbar's doc-list toggle. Shell-level and doc-independent, so it
 *  runs once per page rather than per navigation — `mountReviewChrome` runs on
 *  every doc change, and a second listener here would flip the pane twice per
 *  click. The button's own visibility is CSS (`body.has-set` + the 1101px
 *  floor); this only owns the open/closed state. */
export function wireSetPaneToggle(): void {
  const btn = document.getElementById('toggle-set-pane');
  if (!btn || btn.dataset.wired === '1') return;
  btn.dataset.wired = '1';
  const apply = (open: boolean) => {
    document.body.classList.toggle('set-pane-open', open);
    btn.setAttribute('aria-pressed', String(open));
    btn.title = open ? 'Hide doc list' : 'Show doc list';
    btn.setAttribute(
      'aria-label',
      open ? 'Hide the list of docs in this review' : 'Show the list of docs in this review',
    );
  };
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(SET_PANE_PREF_KEY);
  } catch {
    // storage unavailable — the tier default still applies.
  }
  apply(initialSetPaneOpen(stored, window.matchMedia(WIDE_SCREEN_QUERY).matches));
  btn.addEventListener('click', () => {
    const next = !document.body.classList.contains('set-pane-open');
    apply(next);
    try {
      localStorage.setItem(SET_PANE_PREF_KEY, next ? 'open' : 'closed');
    } catch {
      // storage unavailable — the choice holds for this page only.
    }
  });
}

export interface ReviewChrome {
  threadsPanel: ThreadPanel;
  openDrawer: () => void;
  closeDrawer: () => void;
  isMobile: () => boolean;
  resolveThreadRange: (threadId: string) => { from: number; to: number } | null;
  collectThreads: () => Thread[];
  redrawThreads: () => void;
  refreshThreadDecorations: (activeId: string | null) => void;
  /** Scroll+pulse the thread's range and focus it in panel / thread view. */
  revealThread: (id: string) => void;
  /**
   * Open this thread in the wide modal IF it has outgrown the 300px column —
   * more than ~100 words, or a decision at any length (`long-thread.ts`) — and
   * the viewport is wide enough for a modal to be the right treatment.
   *
   * Returns false when the caller should go on expanding the card in place, so
   * every route into a thread asks the same question in the same words. There
   * are three of them (a card tap, `revealThread`, a tap on the anchor
   * highlight), and the third does not pass through the other two.
   */
  openInModal: (id: string) => boolean;
  /** Mobile inline cards + over-doc sheet + the ‹ › comment nav. */
  mobile: MobileReview;
  openThreadView: (id: string) => void;
  closeThreadView: () => void;
  openComposer: () => void;
  hideComposer: () => void;
  renderDocLabel: () => void;
  /** Tear down the chrome for this document: signal-bound listeners are
   *  already gone via `scope.dispose()`; this clears the rendered UI so the
   *  next document's mount doesn't briefly show this one's threads. */
  destroy: () => void;
}

export function mountReviewChrome(opts: ChromeOpts): ReviewChrome {
  const { docId, user, ydoc, surface } = opts;

  // Every listener registered here closes over this document's `docId` /
  // `ydoc` / `surface`. When a scope is supplied, bind through it so a
  // navigation removes them — otherwise the next mount's submit handlers stack
  // on top of this one's and a single click posts to multiple docs.
  const on = (
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ): void => {
    if (opts.scope) opts.scope.listen(target, type, handler, options);
    else target.addEventListener(type, handler, options);
  };

  /** Teardown for the modal when this mount has no scope of its own — it
   *  appends to `document.body`, so `destroy()` has to be able to take it
   *  away or the next document mounts under a stranded dialog. */
  const modalCleanups: Array<() => void> = [];

  const threadsListEl = el<HTMLElement>('threads-list');
  const docTitleEl = el<HTMLElement>('doc-title');
  const composer = el<HTMLElement>('composer');
  const composerText = el<HTMLTextAreaElement>('composer-text');
  const composerAvatar = el<HTMLElement>('composer-avatar');
  const composerScrim = el<HTMLElement>('composer-scrim');
  const threadView = el<HTMLElement>('thread-view');
  const threadViewBody = el<HTMLElement>('thread-view-body');
  const threadViewClose = el<HTMLButtonElement>('thread-view-close');
  const threadViewReplyText = el<HTMLTextAreaElement>('thread-view-reply-text');
  const threadViewReplySubmit = el<HTMLButtonElement>('thread-view-reply-submit');
  const toggleThreads = el<HTMLButtonElement>('toggle-threads');
  const threadsCount = el<HTMLElement>('threads-count');
  const closeThreads = el<HTMLButtonElement>('close-threads');
  const scrim = el<HTMLElement>('threads-scrim');
  const shell = document.getElementById('shell') as HTMLElement;

  function isMobile(): boolean {
    return !window.matchMedia('(min-width: 901px)').matches;
  }

  // --- threads drawer --------------------------------------------------------
  function openDrawer(): void {
    shell.classList.add('threads-open');
    toggleThreads.setAttribute('aria-pressed', 'true');
    document.getElementById('threads-pane')?.setAttribute('aria-hidden', 'false');
    // The pane is `display: none` while closed on desktop, and every card in
    // it was still rendered — against a subtree with no layout, where a
    // folding slot cannot be measured. Measure now, or the drawer opens
    // showing an author row and a ✓ Resolve with nothing in between.
    sizeThreadSlots(threadsListEl);
  }
  function closeDrawer(): void {
    shell.classList.remove('threads-open');
    toggleThreads.setAttribute('aria-pressed', 'false');
    document.getElementById('threads-pane')?.setAttribute('aria-hidden', 'true');
  }
  // Explicit open/close via the toggle or the ✕ is a stated preference —
  // remember it so per-file navigation in a diff review doesn't keep
  // re-applying the balloon default the user just overrode. Session-scoped
  // on purpose: a fresh visit re-evaluates the default.
  function rememberDrawerPref(open: boolean): void {
    try {
      sessionStorage.setItem(DRAWER_PREF_KEY, open ? 'open' : 'closed');
    } catch {
      // storage unavailable — default logic reapplies per mount
    }
  }
  on(toggleThreads, 'click', () => {
    const open = !shell.classList.contains('threads-open');
    open ? openDrawer() : closeDrawer();
    rememberDrawerPref(open);
  });
  on(closeThreads, 'click', () => {
    closeDrawer();
    rememberDrawerPref(false);
  });
  on(scrim, 'click', closeDrawer);

  // Resizable side panels (desktop): the comments pane (right edge drag)
  // and the In-This-Review pane (left edge drag). Widths persist; on
  // mobile both are overlays and the handles are hidden.
  wireResizeHandle({
    pane: document.getElementById('threads-pane'),
    cssVar: '--threads-w',
    storageKey: 'lf:threads-w',
    min: 280,
    max: () => Math.min(720, Math.round(window.innerWidth * 0.6)),
    widthFromPointer: (e) => window.innerWidth - e.clientX,
    handleClass: 'threads-resize',
    label: 'Resize comments panel',
  });
  wireSetPaneToggle();
  wireResizeHandle({
    pane: document.getElementById('set-pane'),
    cssVar: '--set-w',
    storageKey: 'lf:set-w',
    min: 240,
    max: () => Math.min(600, Math.round(window.innerWidth * 0.45)),
    widthFromPointer: (e) => e.clientX,
    handleClass: 'set-resize',
    label: 'Resize review panel',
  });
  // Desktop layout shows the drawer inline. Default open — EXCEPT when a
  // balloon margin is visible, where the drawer duplicates the balloons.
  let storedPref: string | null = null;
  try {
    storedPref = sessionStorage.getItem(DRAWER_PREF_KEY);
  } catch {
    // storage unavailable
  }
  const marginVisible =
    (opts.hasBalloonMargin ?? false) && window.matchMedia('(min-width: 1101px)').matches;
  // Enforce (not just apply-when-open): the `threads-open` class lives on the
  // shell and survives navigation, so a drawer a previous doc opened via
  // revealThread would otherwise leak into a doc whose default is closed.
  if (
    initialDrawerOpen({
      isDesktop: window.matchMedia('(min-width: 901px)').matches,
      marginVisible,
      inlineVisible: inlineCardsVisible(),
      stored: storedPref,
    })
  )
    openDrawer();
  else closeDrawer();

  const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.threads-tabs .tab'));
  for (const b of tabButtons) {
    on(b, 'click', () => {
      const tab = (b.getAttribute('data-tab') ?? 'open') as ThreadTab;
      threadsPanel.setTab(tab);
      for (const x of tabButtons) x.classList.toggle('active', x === b);
    });
  }

  // --- thread data plumbing --------------------------------------------------
  function resolveThreadRange(threadId: string): { from: number; to: number } | null {
    const doc = ydoc.getMap('threads').get(threadId) as Y.Map<unknown> | undefined;
    if (!doc) return null;
    const anchor = doc.get('anchor') as
      | { kind: 'text-range'; startRel: Uint8Array | number[]; endRel: Uint8Array | number[] }
      | { kind: 'element' | 'orphan' }
      | undefined;
    if (!anchor || anchor.kind !== 'text-range') return null;
    const startRel =
      anchor.startRel instanceof Uint8Array ? anchor.startRel : new Uint8Array(anchor.startRel);
    const endRel =
      anchor.endRel instanceof Uint8Array ? anchor.endRel : new Uint8Array(anchor.endRel);
    return surface.resolveRel(startRel, endRel);
  }

  function collectThreads(): Thread[] {
    const threadsMap = ydoc.getMap('threads');
    const out: Thread[] = [];
    threadsMap.forEach((entry, id) => {
      const threadMap = entry as Y.Map<unknown>;
      const anchorRaw = threadMap.get('anchor') as Thread['anchor'] | undefined;
      const status = threadMap.get('status') as Thread['status'] | undefined;
      const createdBy = threadMap.get('createdBy') as User | undefined;
      const commentsArr = threadMap.get('comments') as Y.Array<Y.Map<unknown>> | undefined;
      if (!anchorRaw || !status || !createdBy) return;
      const comments = [];
      if (commentsArr) {
        for (const c of commentsArr) {
          const cid = c.get('id') as string | undefined;
          const author = c.get('author') as User | undefined;
          const text = c.get('text') as string | undefined;
          const ts = c.get('ts') as number | undefined;
          if (cid && author && text != null && ts != null) {
            // The review payload is what makes a thread CARRY an item — drop
            // it here and the panel renders a plain conversation: no item
            // card, no Answer routing, no answered record. This reader is the
            // panel's only source (see the summary note below), so the doc
            // half of answering worked in every panel unit test and not at
            // all through the mounted chrome until the glue tests posted
            // through it.
            const review = readReviewPayload(c.get('review'));
            comments.push({ id: cid, author, text, ts, ...(review ? { review } : {}) });
          }
        }
      }
      // A text-range anchor that no longer resolves displays as orphaned so
      // the panel offers the recover flow (the persisted anchor is untouched).
      let displayAnchor: Thread['anchor'] = anchorRaw;
      if (anchorRaw.kind === 'text-range') {
        const r = resolveThreadRange(id);
        if (!r) displayAnchor = { kind: 'orphan', original: anchorRaw, lastSeenAt: Date.now() };
      }
      // The generated summary is part of the thread, not a decoration on top
      // of it: `threadLines` reads `t.summary`, so a Thread built without it
      // silently renders the deterministic lines forever. This reader is the
      // ONLY source of threads for the panel, the balloons and the mobile
      // cards — the widget gets the lift for free via core's `readThread`,
      // this surface does not. Same shape as the "route layer silently drops
      // params" class in docs/process/learnings.md.
      const summary = readStoredSummary(threadMap.get('summary'));
      const pendingTsRaw = threadMap.get('summaryPendingTs');
      const t: Thread = {
        id,
        status,
        anchor: displayAnchor,
        createdBy,
        commentCount: comments.length,
        lastActivity: comments.length > 0 ? (comments[comments.length - 1]?.ts ?? 0) : 0,
        comments,
        ...(summary ? { summary } : {}),
        ...(typeof pendingTsRaw === 'number' ? { summaryPendingTs: pendingTsRaw } : {}),
      };
      // "A summary is being generated" is a server-written fact, not a guess:
      // `summaryPendingTs` is stamped when a generation is QUEUED (gated
      // visitor writes never stamp), and `summaryPending` time-bounds it so a
      // failed call degrades to the deterministic lines.
      if (summaryPending(t, { now: Date.now() })) {
        t.summaryPending = true;
        schedulePendingExpiry((t.summaryPendingTs ?? 0) + SUMMARY_PENDING_WINDOW_MS);
      }
      out.push(t);
    });
    return out;
  }

  // A pending card's ONLY exits are a summary syncing in (repaints via the
  // ydoc observer) or its window expiring — and expiry is a clock event, not
  // a doc event, so nothing would repaint the card without this timer. One
  // timer, always armed for the EARLIEST expiry seen: a later `collect` may
  // find a thread that expires sooner, so an earlier deadline retimes the
  // timer rather than being swallowed by "one is already scheduled".
  let pendingExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingExpiryAt = Number.POSITIVE_INFINITY;
  function schedulePendingExpiry(expiresAt: number): void {
    const fireAt = expiresAt + 250; // small slack so the redraw lands after expiry
    if (fireAt >= pendingExpiryAt) return;
    if (pendingExpiryTimer != null) clearTimeout(pendingExpiryTimer);
    pendingExpiryAt = fireAt;
    pendingExpiryTimer = setTimeout(
      () => {
        clearPendingExpiry();
        redrawThreads();
      },
      Math.max(0, fireAt - Date.now()),
    );
  }
  function clearPendingExpiry(): void {
    if (pendingExpiryTimer != null) clearTimeout(pendingExpiryTimer);
    pendingExpiryTimer = null;
    pendingExpiryAt = Number.POSITIVE_INFINITY;
  }

  let activeThreadId: string | null = null;
  function redrawThreads(): void {
    const all = collectThreads();
    threadsPanel.setThreads(all);
    refreshThreadDecorations(activeThreadId);
    const counts = threadsPanel.countByStatus();
    const openCount = counts.open + counts.orphan;
    threadsCount.textContent = String(openCount);
    threadsCount.classList.toggle('has-count', openCount > 0);
    // The inline cards are a second rendering of the same threads. They go
    // stale exactly when the drawer would, so they refresh from the same
    // signal rather than a listener of their own.
    mobile.refresh();
    // …and so does the modal's copy. It holds a card the panel's own render
    // never rebuilds, so without this a reply landing over the websocket shows
    // up everywhere on the page except in the dialog being read.
    const modalId = threadModal.openThreadId();
    if (modalId) threadModal.refresh(all.find((t) => t.id === modalId) ?? null);
  }
  function refreshThreadDecorations(activeId: string | null): void {
    activeThreadId = activeId;
    const ranges = collectThreads()
      .filter((t) => t.anchor.kind === 'text-range')
      .map((t) => {
        const r = resolveThreadRange(t.id);
        if (!r) return null;
        return { id: t.id, from: r.from, to: r.to, status: t.status };
      })
      .filter((x): x is NonNullable<typeof x> => x != null);
    surface.setThreadRanges(ranges, activeId);
  }

  // "L293" / "L293–301" for line-oriented surfaces (code/diff); null on
  // prose. Recomputed at render time so labels track live edits.
  function threadLineLabel(threadId: string): string | null {
    if (!surface.lineForPos) return null;
    const r = resolveThreadRange(threadId);
    if (!r) return null;
    const a = surface.lineForPos(r.from);
    const b = surface.lineForPos(Math.max(r.from, r.to - 1));
    if (a == null) return null;
    return b != null && b > a ? `L${a}–${b}` : `L${a}`;
  }

  // --- thread panel ------------------------------------------------------
  // The wide modal a thread too big for the column opens in. Built BEFORE the
  // panel it renders from: the two reference each other, so one of them has to
  // be named first, and every reference here is inside a closure that does not
  // run until after both exist.
  const threadModal: ThreadModalHandle = mountThreadModal({
    scope: {
      listen: on,
      onCleanup: (fn) => {
        if (opts.scope) opts.scope.onCleanup(fn);
        else modalCleanups.push(fn);
      },
    },
    renderCard: (t, pendingReply) => threadsPanel.renderThread(t, pendingReply),
    // Hand the selection back only when it is still the thread the modal was
    // showing: closing BECAUSE another thread was selected must not then
    // unselect that other thread — which is the loop `onActiveChange` feeds.
    //
    // Deselect BEFORE handing the expansion back. The other order re-opens
    // every copy of the card for the instant before the deselection folds them
    // again, which is a visible flinch on the way out of the dialog.
    onClose: (threadId) => {
      if (threadsPanel.getActive() === threadId) threadsPanel.setActive(null);
      threadsPanel.setExpandedElsewhere(null);
    },
    // Which card the reader was actually pointing at, through the scrim.
    // `elementsFromPoint` walks the whole stack rather than stopping at the
    // scrim, which is the only reason this can see past it. Guarded because
    // it is a layout API, and a DOM without layout does not have to have one.
    threadUnderPoint: (x, y) => {
      if (typeof document.elementsFromPoint !== 'function') return null;
      for (const el of document.elementsFromPoint(x, y)) {
        const card = (el as Element).closest?.('.thread[data-thread-id]');
        const id = card?.getAttribute('data-thread-id');
        if (id) return id;
      }
      return null;
    },
    // Exactly the route a click on that card takes — same scroll, same pulse,
    // same inline/modal/sheet decision. A switch that took its own path is how
    // the two start disagreeing about what opening a thread means.
    onSwitchThread: (id) => engageThread(id),
  });

  /* `body.thread-card-open` is gone. It existed to tell the stylesheet that a
     full-width comment card was open over the document, and it had exactly one
     consumer: the hold-to-talk mic, which was fixed bottom-LEFT and landed on
     the card's reply box at ≤1100px. The mic is docked in the topbar now
     (`.doc-nav-dock`), where a card cannot reach it — so the class described a
     collision that can no longer happen and its only effect was to take voice
     away from the reader mid-conversation. */

  /**
   * Open `id` in the wide modal, or say no.
   *
   * Two conditions and both are load-bearing. The thread has to have outgrown
   * the column (`threadNeedsModal`), and the viewport has to be one where a
   * modal is the right answer at all: below 1100px a comment ALREADY opens as
   * a full-width inline card with the over-doc sheet behind it, so a dialog
   * there is a second dismissable layer over one conversation.
   *
   * `setActive` still happens — the panel's selection carries the anchor
   * highlight and the drawer row's styling — but LAST, and it no longer
   * expands anything. `setExpandedElsewhere` takes the expansion first, so the
   * copies in the column, the drawer and the sheet stay folded instead of
   * rendering the same conversation two and three times under the scrim. The
   * modal force-opens its own copy and needs nothing from the selection.
   *
   * The order matters for a second reason: with the modal already showing the
   * thread by the time `setActive` announces it, `onActiveChange` finds its own
   * thread on screen and leaves it alone. Selecting first made it close the
   * modal it was about to reopen, dropping the return-focus target on the way.
   */
  function maybeOpenModal(id: string): boolean {
    if (inlineCardsVisible()) return false;
    const t = collectThreads().find((x) => x.id === id);
    if (!t || !threadNeedsModal(t)) return false;
    threadsPanel.setExpandedElsewhere(id);
    threadModal.open(t);
    threadsPanel.setActive(id);
    return true;
  }

  /**
   * Open a thread, wherever it belongs.
   *
   * ONE path, shared by a click on a card in the drawer or the column, a click
   * on the highlighted text in the document, and a click through the modal's
   * scrim onto another thread. Each of those used to decide for itself, and a
   * route that reasons separately is how two of them end up disagreeing about
   * what opening a thread means.
   */
  function engageThread(id: string): void {
    const range = resolveThreadRange(id);
    if (range) {
      surface.scrollToPos(range.from);
      surface.pulseRange(range.from, range.to);
    }
    // A thread that has outgrown the column opens in the modal instead of
    // unfolding into it; `maybeOpenModal` has already made the selection.
    if (maybeOpenModal(id)) return;
    // Nothing extra on mobile: setActive unfolds EVERY copy of this card, so a
    // tap in the sheet expands the sheet's copy in place (and the inline one
    // underneath it) rather than launching a third, separate full-screen view
    // of the same conversation.
    threadsPanel.setActive(id);
  }

  const threadsPanel = new ThreadPanel({
    container: threadsListEl,
    currentUser: user,
    threadLineLabel,
    // The anchor highlight follows the panel's selection from here, once,
    // instead of at each of the half-dozen places that change it. Folding an
    // open card had no such place — it selects nothing, from inside the card's
    // own tap handler — so the highlight used to stay lit with no card open.
    onActiveChange: (id) => {
      refreshThreadDecorations(id);
      // The selection moved off whatever the modal is showing — a different
      // thread, or nothing. The modal is a view of ONE thread and the panel's
      // selection is the authority, so it follows rather than argues.
      if (id !== threadModal.openThreadId()) threadModal.close();
    },
    onThreadClick: (id) => engageThread(id),
    onReply: async (id, text, answersCommentId, optionId) => {
      // Two routes, one reply. `/answer` posts the SAME comment and
      // additionally stamps `answeredAt` on the declaring comment, which is
      // what takes the item off the Home queue. The panel decides which by
      // handing back an id or not; sending one the server did not declare is
      // refused rather than invented, so there is nothing to guess here.
      //
      // Until this branch existed, every doc reply went to `/comments`, so a
      // review item could be read in the doc, answered in the person's own
      // words, and stay queued — which is exactly what happened four times on
      // `board-review-2026-08-19`.
      const base = `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}`;
      let res: Response;
      try {
        res = await fetch(answersCommentId ? `${base}/answer` : `${base}/comments`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            author: user,
            text,
            ...(answersCommentId ? { commentId: answersCommentId } : {}),
            // Provenance for a tapped option — records WHICH offered candidate
            // the verbatim words came from. Typed answers send none.
            ...(answersCommentId && optionId ? { optionId } : {}),
          }),
        });
      } catch {
        if (answersCommentId) showToast('Answer failed to post — try again');
        return false;
      }
      // A failed answer must not read as a posted one: the toast says try
      // again, and the returned `false` is what makes trying again possible —
      // the panel puts the typed words back in the box.
      if (!res.ok && answersCommentId) {
        showToast('Answer failed to post — try again');
      }
      return res.ok;
    },
    onUndoAnswer: async (id, commentId) => {
      // Soft delete on the server: the stamps move into `answerHistory` and
      // the reply comment stays. The doc's own websocket repaint is what
      // re-renders the thread as pending again, so success needs no client
      // state here.
      const res = await fetch(
        `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/answer/undo`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ author: user, commentId }),
        },
      );
      if (!res.ok) {
        // "not-answered" means somebody else took it back first — the live
        // repaint is already showing that, and a failure toast over an
        // already-done undo would read as a broken button.
        const err = (await res.json().catch(() => undefined)) as { error?: string } | undefined;
        if (err?.error !== 'not-answered') showToast('Undo failed — try again');
      }
    },
    onResolve: async (id) => {
      try {
        const res = await fetch(
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/resolve`,
          { method: 'POST' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('✓ Resolved');
      } catch {
        showToast('Failed to resolve — try again');
      }
    },
    onReopen: async (id) => {
      try {
        const res = await fetch(
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/reopen`,
          { method: 'POST' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('✓ Reopened');
      } catch {
        showToast('Failed to reopen — try again');
      }
    },
    onReanchor: async (id) => {
      const sel = opts.getSelection();
      if (!sel) {
        showToast(opts.reanchorHint);
        return;
      }
      try {
        const res = await fetch(
          `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/reanchor`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ anchor: anchorBody(sel) }),
          },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('✓ Re-anchored');
      } catch {
        showToast('Failed to re-anchor — try again');
      }
    },
  });

  // Until the first sync lands the panel is holding `[]` because nothing has
  // arrived, not because there is nothing. `onReady` fires immediately if the
  // doc was already hydrated, so a late mount is not left saying "Loading".
  opts.whenSynced(() => threadsPanel.markSynced());

  // --- mobile: inline cards + the over-doc sheet ---------------------------
  // On a phone there is no standalone drawer. Comments render inline under
  // the text they point at, and the same `#threads-pane` rises as a bottom
  // sheet when the app bar's comment badge is tapped (CSS owns that shape;
  // the open/close state is the drawer's, unchanged).
  const mobile = mountMobileReview({
    inlineVisible: inlineCardsVisible,
    threads: collectThreads,
    resolveRange: resolveThreadRange,
    renderCard: (t, pendingReply) => threadsPanel.renderThread(t, pendingReply),
    surface,
    setActive: (id) => {
      threadsPanel.setActive(id);
    },
    getActive: () => threadsPanel.getActive(),
    revealInSheet: (id) => requestAnimationFrame(() => threadsPanel.revealThread(id)),
    openSheet: openDrawer,
    closeSheet: closeDrawer,
    isSheetOpen: () => shell.classList.contains('threads-open'),
    listen: on,
    onCleanup: (fn) => opts.scope?.onCleanup(fn),
  });
  // Crossing the phone breakpoint changes which surface owns the comments —
  // inline cards must appear (or be handed back) at the same width the
  // stylesheet swaps the drawer for a sheet.
  on(window.matchMedia(INLINE_CARDS_QUERY), 'change', () => {
    mobile.refresh();
    // Crossing DOWN hands the conversation to the inline card and the sheet.
    // Leaving the dialog up would stack a second dismissable layer over the
    // same thread — and page zoom moves a reviewer across this line, so it is
    // not a hypothetical transition.
    if (inlineCardsVisible()) threadModal.close();
  });

  // A card's folding slots hold a height we MEASURED, so anything that
  // changes text metrics after first paint — a reflow, a webfont landing —
  // strands every card on screen at a height that no longer fits its content.
  installSlotRemeasure(
    {
      listen: on,
      get disposed() {
        return opts.scope?.disposed ?? false;
      },
      // Only when there IS a scope: a mount without one never tears down, so
      // running the cleanup instead would disconnect the observer on the spot.
      onCleanup: opts.scope ? (fn) => opts.scope?.onCleanup(fn) : undefined,
    },
    // …including the two that resize WITHOUT a window event: dragging the
    // comments panel's handle rewrites `--threads-w`, and that reflows every
    // card in it and every inline card beside it.
    [document.getElementById('threads-pane'), document.getElementById('editor')],
  );

  function revealThread(id: string): void {
    refreshThreadDecorations(id);
    const range = resolveThreadRange(id);
    if (range) {
      surface.scrollToPos(range.from);
      surface.pulseRange(range.from, range.to);
    }
    if (isMobile()) {
      // The inline card IS the mobile comment surface: centre it in the
      // doc's own scroller. A thread with no line to sit beside (orphaned,
      // resolved) has no inline card at all — showThread opens the sheet,
      // the only place it exists.
      mobile.showThread(id);
    } else if (!maybeOpenModal(id)) {
      // Open the drawer first, then (after layout) scroll the panel to the
      // thread — otherwise the active comment lands off-screen and the
      // click appears to do nothing.
      openDrawer();
      requestAnimationFrame(() => threadsPanel.revealThread(id));
    }
  }

  // --- composer ------------------------------------------------------------
  composerAvatar.style.background = user.color;
  composerAvatar.textContent = (user.name[0] ?? '?').toUpperCase();

  // Every composer is a markdown editor (design point 4), and this is the one
  // a reviewer reaches first — select text, tap the pill, type. Comments
  // RENDER markdown, so the box they are typed into edits it live.
  // `attachMarkdownComposer` is idempotent because `#composer` is shell DOM
  // that outlives the document while this function runs once per navigation.
  const refreshComposer = attachMarkdownComposer(composerText);

  /** Selection captured when the composer opened — survives the editor
   *  losing its DOM selection while the user types the comment. */
  let composerSelection: ChromeSelection | null = null;

  function openComposer(): void {
    const use = opts.getSelection();
    if (!use) {
      showToast(opts.selectHint);
      return;
    }
    composerSelection = use;
    // Muted quote of the anchored text so the user doesn't lose sight of
    // what they're commenting on once iOS lifts the keyboard.
    el<HTMLElement>('composer-quote').textContent = use.snippet;
    composer.classList.remove('hidden');
    composerScrim.classList.remove('hidden');
    document.body.classList.add('composer-open');
    opts.hidePill?.();
    composerText.value = '';
    // Emptying the box in code is invisible to the editor, so it has to be
    // told — otherwise the previous comment is still sitting in the box the
    // reviewer just opened for a new one.
    refreshComposer();
    // Focusing without scrolling stops iOS's auto-scroll-to-focus from
    // yanking the page — what `preventScroll` bought while this was a
    // textarea.
    setTimeout(() => focusMarkdownComposer(composerText, null, { scroll: false }), 30);
    opts.onComposerOpened?.();
  }
  function hideComposer(): void {
    composer.classList.add('hidden');
    composerScrim.classList.add('hidden');
    document.body.classList.remove('composer-open');
  }
  on(composerScrim, 'click', hideComposer);
  on(composerText, 'keydown', (ev) => {
    const ke = ev as KeyboardEvent;
    if (ke.key === 'Enter' && !ke.shiftKey && !ke.isComposing) {
      ke.preventDefault();
      void submitComposer();
    }
    if (ke.key === 'Escape') hideComposer();
  });
  on(el<HTMLButtonElement>('composer-submit'), 'click', () => void submitComposer());

  async function submitComposer(): Promise<void> {
    const text = composerText.value.trim();
    if (!text) return;
    if (!composerSelection) {
      showToast('Lost the selection — try again.');
      return;
    }
    const anchor = anchorBody(composerSelection);
    const submitBtn = el<HTMLButtonElement>('composer-submit');
    submitBtn.disabled = true;
    try {
      const res = await fetch(`/api/docs/${encodeURIComponent(docId)}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: user, text, anchor }),
      });
      if (!res.ok) throw new Error('post failed');
      const body = (await res.json()) as { thread: { id: string } };
      hideComposer();
      opts.onPosted?.();
      showToast('✓ Comment posted');
      // Post-feedback: wait for the Yjs update to land the highlight, then
      // scroll it into view + pulse so the user sees where it landed.
      setTimeout(() => {
        const r = resolveThreadRange(body.thread.id);
        if (r) {
          surface.scrollToPos(r.from);
          surface.pulseRange(r.from, r.to);
        }
      }, 150);
    } catch {
      showToast('Failed to post comment');
    } finally {
      submitBtn.disabled = false;
    }
  }

  // --- full-screen thread view -----------------------------------------------
  // No longer the mobile comment surface — inline cards + the over-doc sheet
  // replaced it, and nothing routes a comment tap here any more. Retained
  // because `#thread-view` is still a live element (its CSS block is what
  // the deletion and suggestion sheets are built from) and because
  // openThreadView remains on the chrome interface for callers outside this
  // file. Do not add new comment routing to it: it is a forked comment DOM
  // with no slots, so a card opened here cannot morph.
  let threadViewId: string | null = null;
  function renderThreadView(id: string): void {
    const t = collectThreads().find((x) => x.id === id);
    if (!t) return;
    const anchorText =
      t.anchor.kind === 'subject'
        ? ''
        : t.anchor.kind === 'orphan'
          ? t.anchor.original.snippet.text
          : t.anchor.snippet.text;
    threadViewBody.innerHTML = '';
    const anchor = document.createElement('div');
    anchor.className = 'thread-anchor';
    anchor.textContent = anchorText;
    const lineLabel = threadLineLabel(id);
    if (lineLabel) {
      const chip = document.createElement('span');
      chip.className = 'thread-line';
      chip.textContent = lineLabel;
      anchor.prepend(chip);
    }
    threadViewBody.appendChild(anchor);
    for (const c of t.comments) {
      const row = document.createElement('div');
      row.className = 'comment';
      const a = document.createElement('div');
      a.className = 'author';
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = c.author.color;
      const nm = document.createElement('span');
      nm.className = 'name';
      nm.textContent = c.author.name;
      const tm = document.createElement('span');
      tm.className = 'time';
      tm.textContent = formatTime(c.ts);
      a.append(sw, nm, tm);
      const bodyEl = document.createElement('div');
      bodyEl.className = 'body';
      bodyEl.textContent = c.text;
      row.append(a, bodyEl);
      threadViewBody.appendChild(row);
    }
    const actions = document.createElement('div');
    actions.className = 'thread-view-actions';
    const isResolved = t.status === 'resolved';
    const action = isResolved ? 'reopen' : 'resolve';
    actions.appendChild(
      makeBtn(isResolved ? 'Reopen' : 'Resolve', async () => {
        // Don't close the sheet until the fetch confirms — closing on a
        // fire-and-forget call leaves the user with no signal on a network
        // blip. Yjs sync re-renders panel + highlights once status flips.
        try {
          const res = await fetch(
            `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(t.id)}/${action}`,
            { method: 'POST' },
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          showToast(isResolved ? '✓ Reopened' : '✓ Resolved');
          if (!isResolved) closeThreadView();
        } catch {
          showToast(`Failed to ${action} — try again`);
        }
      }),
    );
    threadViewBody.appendChild(actions);
  }
  function openThreadView(id: string): void {
    threadViewId = id;
    threadsPanel.setActive(id);
    renderThreadView(id);
    opts.hidePill?.();
    threadView.classList.remove('hidden');
    threadView.setAttribute('aria-hidden', 'false');
    document.body.classList.add('thread-view-open');
    // Scroll the anchor into view behind the sheet for when it closes.
    const range = resolveThreadRange(id);
    if (range) surface.scrollToPos(range.from);
  }
  function closeThreadView(): void {
    threadViewId = null;
    threadView.classList.add('hidden');
    threadView.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('thread-view-open');
    threadViewReplyText.value = '';
  }
  on(threadViewClose, 'click', closeThreadView);
  async function submitThreadReply(): Promise<void> {
    if (!threadViewId) return;
    const text = threadViewReplyText.value.trim();
    if (!text) return;
    const id = threadViewId;
    threadViewReplyText.value = '';
    await fetch(
      `/api/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(id)}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ author: user, text }),
      },
    );
  }
  on(threadViewReplySubmit, 'click', () => void submitThreadReply());
  on(threadViewReplyText, 'keydown', (ev) => {
    const ke = ev as KeyboardEvent;
    if (ke.key === 'Enter' && !ke.shiftKey && !ke.isComposing) {
      ke.preventDefault();
      void submitThreadReply();
    }
  });

  // --- doc label --------------------------------------------------------------
  function renderDocLabel(): void {
    const m = readDocMeta(ydoc);
    const full = docLabel({
      type: m.type,
      relPath: m.relPath,
      title: m.title,
      docId: m.docId,
      labelHint: opts.labelHint,
    });
    // On mobile the full path eats the topbar — show just the basename
    // truncated to ~32 chars, full path in `title` for tap-and-hold.
    const mobile = window.matchMedia('(max-width: 720px)').matches;
    docTitleEl.textContent = mobile ? mobileLabel(full) : full;
    docTitleEl.title = full;
    // The browser tab names the DOC, not the product — otherwise every open
    // review reads the same until it truncates. This is the one place all
    // three surfaces resolve a label, and it re-runs per navigation and on
    // every meta change, so the tab follows an in-place doc swap and a
    // late-arriving title without either boot wiring it separately.
    setTabTitle(document, tabName(full));
  }
  on(window.matchMedia('(max-width: 720px)'), 'change', () => renderDocLabel());

  // --- live wiring -------------------------------------------------------------
  // Bound to this document's ydoc, which is destroyed when its client closes on
  // navigation (see ws-client close()), so this observer is released with it.
  const threadsObserver = () => {
    redrawThreads();
    if (threadViewId) renderThreadView(threadViewId);
  };
  ydoc.getMap('threads').observeDeep(threadsObserver);
  opts.scope?.onCleanup(() => ydoc.getMap('threads').unobserveDeep(threadsObserver));

  // --- hotkeys ------------------------------------------------------------------
  on(document, 'keydown', (ev) => {
    const ke = ev as KeyboardEvent;
    if ((ke.metaKey || ke.ctrlKey) && ke.key.toLowerCase() === 'm') {
      ke.preventDefault();
      openComposer();
    }
    if (ke.key === 'Escape') {
      // Innermost first, one layer per press. The expanded card sits between
      // the full-screen thread view and the drawer: the view covers it, and it
      // is inside the drawer's list. Its branch used to be missing entirely,
      // so which gesture dismissed a thread depended on its WORD COUNT — over
      // the threshold it opened as a dialog and Escape worked, under it you
      // had to find the caret, and nothing about the card says which it is.
      // The dialog never reaches here: its own handler stops the event
      // immediately, on this same node.
      if (!composer.classList.contains('hidden')) hideComposer();
      else if (!threadView.classList.contains('hidden')) closeThreadView();
      else if (threadsPanel.getActive()) threadsPanel.setActive(null);
      else if (shell.classList.contains('threads-open')) closeDrawer();
    }
  });

  const chrome: ReviewChrome = {
    threadsPanel,
    openDrawer,
    closeDrawer,
    isMobile,
    resolveThreadRange,
    collectThreads,
    redrawThreads,
    refreshThreadDecorations,
    revealThread,
    openInModal: maybeOpenModal,
    mobile,
    openThreadView,
    closeThreadView,
    openComposer,
    hideComposer,
    renderDocLabel,
    destroy() {
      // Signal-bound listeners are already gone via scope.dispose(); clear the
      // rendered UI so the next document's mount doesn't briefly show this
      // one's threads / open composer / open thread view.
      //
      // The pending-expiry timer is NOT signal-bound, so it would outlive this
      // chrome and fire `redrawThreads` for the document we just left —
      // repainting the previous doc's threads over the next mount, which
      // reuses the same DOM.
      clearPendingExpiry();
      threadsListEl.innerHTML = '';
      hideComposer();
      closeThreadView();
      // The modal lives on `document.body`, outside every element this
      // function empties — a scope-less mount has to take it away by hand or
      // the next document mounts underneath a stranded dialog.
      threadModal.close();
      for (const fn of modalCleanups.splice(0)) fn();
      // The doc-level suggestions badge (suggestions-summary.ts) is only
      // mounted by the markdown/redline surfaces, not the code surface — if
      // the next document's mount doesn't call mountSuggestionsSummary at
      // all (navigating to a code file), nothing else resets this, so the
      // badge would otherwise keep showing the PREVIOUS doc's stale count.
      // Optional lookup: older/lighter test fixtures don't include this
      // element, and this must be a no-op there.
      document.getElementById('toggle-suggestions')?.classList.add('hidden');
      document.getElementById('suggestions-menu')?.classList.add('hidden');
    },
  };
  // The router only calls scope.dispose(); make the visual teardown part of it.
  opts.scope?.onCleanup(() => chrome.destroy());
  return chrome;
}

// --- thread-range click → focus the thread -------------------------------------

export interface ThreadFocusOpts {
  /** The scroll container that hosts the editor's `.thread-range` spans. */
  editorMount: HTMLElement;
  chrome: ReviewChrome;
  surface: Pick<ReviewSurface, 'pulseRange'>;
  scope: MountScope;
  /**
   * Try showing the thread in the balloon margin first (the "vice versa" of
   * "click a balloon, see its anchor" — see markup-margin.ts). Return true
   * when handled; the drawer/thread-view fallback below is skipped. Omit on
   * surfaces with no margin (the click still highlights + pulses the anchor).
   */
  revealBalloon?: (threadId: string) => boolean;
}

/**
 * Tap-on-highlight in the editor → focus the thread. Shared by the plain
 * markdown mount and the redline mount so the click-to-focus behaviour is
 * one implementation, not two forks that drift.
 *   • A balloon margin present and showing the thread → scroll the balloon
 *     into view (the balloon already reads as the mini-drawer for that spot).
 *   • Otherwise: mobile → full-screen thread view; desktop → open the side
 *     drawer and scroll to the thread's card.
 */
export function wireThreadRangeClicks(opts: ThreadFocusOpts): void {
  const { editorMount, chrome, surface, scope, revealBalloon } = opts;
  scope.listen(editorMount, 'click', (ev) => {
    const t = ((ev as MouseEvent).target as HTMLElement).closest('.thread-range');
    if (!t) return;
    const threadId = t.getAttribute('data-thread-id');
    if (!threadId) return;
    ev.preventDefault();
    ev.stopPropagation();
    chrome.refreshThreadDecorations(threadId);
    // No scrollToPos here — the user clicked the highlight, it's already
    // on screen; jumping the doc would feel broken.
    const range = chrome.resolveThreadRange(threadId);
    if (range) surface.pulseRange(range.from, range.to);
    // Asked BEFORE the balloon, because a balloon reveal expands the card in
    // the column — which is the treatment this thread was promoted out of.
    // This is the one route into a thread that does not pass through
    // `onThreadClick`, so without this the modal would be reachable from the
    // drawer and not from the highlight the reader actually taps.
    if (chrome.openInModal(threadId)) return;
    if (revealBalloon?.(threadId)) return;
    if (chrome.isMobile()) {
      // The card is already inline, directly under the text just tapped —
      // unfold it where it sits (every copy) instead of covering the doc
      // with a separate view of the same thread.
      chrome.threadsPanel.setActive(threadId);
    } else {
      chrome.openDrawer();
      requestAnimationFrame(() => chrome.threadsPanel.revealThread(threadId));
    }
  });
}

// --- resizable side panels ----------------------------------------------------

interface ResizeOpts {
  pane: HTMLElement | null;
  cssVar: string;
  storageKey: string;
  min: number;
  max: () => number;
  /** Pointer x → desired panel width (direction depends on which edge). */
  widthFromPointer: (e: PointerEvent) => number;
  handleClass: string;
  label: string;
}

function wireResizeHandle(opts: ResizeOpts): void {
  const { pane } = opts;
  if (!pane) return;
  // The pane and handle are shell-level (doc-independent), but mountReviewChrome
  // runs per navigation — wire the handle exactly once so re-mounts don't stack
  // duplicate drag bars (and duplicate window pointer listeners) on the pane.
  // Each pane owns a distinct handleClass, so a plain class query is precise.
  if (pane.querySelector(`.${opts.handleClass}`)) return;
  const clamp = (w: number) => Math.max(opts.min, Math.min(opts.max(), w));
  const apply = (w: number) => document.documentElement.style.setProperty(opts.cssVar, `${w}px`);
  try {
    const saved = Number(localStorage.getItem(opts.storageKey));
    if (Number.isFinite(saved) && saved >= opts.min) apply(clamp(saved));
  } catch {
    // localStorage unavailable — fall back to the CSS default width.
  }

  const handle = document.createElement('div');
  handle.className = opts.handleClass;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', opts.label);
  handle.title = 'Drag to resize · double-click to reset';
  pane.appendChild(handle);

  let dragging = false;
  const onMove = (e: PointerEvent) => {
    if (dragging) apply(clamp(opts.widthFromPointer(e)));
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('threads-resizing');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const px = Number.parseInt(
      getComputedStyle(document.documentElement).getPropertyValue(opts.cssVar),
      10,
    );
    if (Number.isFinite(px)) {
      try {
        localStorage.setItem(opts.storageKey, String(px));
      } catch {
        // ignore — width still applied for this session
      }
    }
  };
  handle.addEventListener('pointerdown', (e) => {
    if (window.matchMedia('(max-width: 900px)').matches) return;
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.classList.add('threads-resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  handle.addEventListener('dblclick', () => {
    document.documentElement.style.removeProperty(opts.cssVar);
    try {
      localStorage.removeItem(opts.storageKey);
    } catch {
      // ignore
    }
  });
}

// --- tiny DOM helpers shared by the boots -------------------------------------

export function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element #${id}`);
  return e as T;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function showToast(msg: string): void {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
}

export function makeBtn(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  if (primary) b.className = 'primary';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

/**
 * The topbar label for a doc.
 *
 * Diff docs label with the repo-relative path — the absolute worktree path
 * (their sourceUrl in live mode) is noise for a reviewer.
 *
 * Everything else used to read `sourceUrl` straight off the Yjs meta map. That
 * key is gone from the CRDT (it named a path on the host, and the CRDT syncs
 * to share visitors), so the path now arrives as `labelHint` from the REST
 * meta the router already fetched: the owner sees the same full path as
 * before, and a share visitor sees the basename `relPath` the redacted payload
 * carries rather than the opaque docId.
 */
export function docLabel(opts: {
  type?: string;
  relPath?: string;
  title?: string;
  docId?: string;
  labelHint?: string;
}): string {
  return (
    (opts.type === 'diff' ? opts.relPath : undefined) ??
    opts.labelHint ??
    opts.title ??
    opts.docId ??
    ''
  );
}

export function mobileLabel(full: string): string {
  let s = full;
  try {
    if (/^https?:\/\//.test(s)) s = new URL(s).pathname;
  } catch {}
  const parts = s.split('/').filter(Boolean);
  const base = parts[parts.length - 1] ?? s;
  return base.length <= 32 ? base : `…${base.slice(-31)}`;
}

/** Exposed for unit tests — this is the layer that silently drops anchor
 *  fields, so it needs a test of its own. Not part of the public surface. */
export const __testing = { anchorBody };
