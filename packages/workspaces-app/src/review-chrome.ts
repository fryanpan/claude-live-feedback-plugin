import { type Thread, type User, readDocMeta } from '@feedback/core';
import type * as Y from 'yjs';
import {
  applyPlacement,
  cardPlacement,
  effectiveSurface,
  inlineCardsVisible,
  onPlacementChange,
  otherPlacement,
  placementToggleLabel,
  setCardPlacement,
} from './card-placement.ts';
import { type SeenTracker, createSeenTracker } from './comment-seen.ts';
import type { ChromeSelection } from './doc/anchor-body.ts';
import { el } from './doc/chrome-dom.ts';
import { wireResizeHandle } from './doc/chrome-panels.ts';
import { wireReviewComposer } from './doc/review-composer.ts';
import { createThreadActions } from './doc/thread-actions.ts';
import { createThreadProjection } from './doc/thread-projection.ts';
import {
  initialDrawerOpen,
  readDrawerPref,
  wireSetPaneToggle,
  writeDrawerPref,
} from './doc/view-prefs.ts';
import { threadNeedsModal } from './long-thread.ts';
import { type MobileReview, mountMobileReview } from './mobile-review.ts';
import type { MountScope } from './mount-scope.ts';
import type { ReviewSurface } from './review-surface.ts';
import { setTabTitle, tabName } from './tab-title.ts';
import { type ThreadModalHandle, mountThreadModal } from './thread-modal.ts';
import { installSlotRemeasure, sizeThreadSlots } from './thread-morph.ts';
import { ThreadPanel, type ThreadTab } from './threads.ts';

/**
 * The review "chrome" — everything around the editor that is identical for
 * every SPA surface (markdown / code / diff): the threads drawer + tabs, the
 * panel and modal it renders into, the mobile sheet, the doc-title label and
 * the hotkeys. Extracted from app.ts / code-app.ts, which had forked ~450
 * duplicated lines of this wiring; each boot now supplies only its genuinely
 * surface-specific parts via `ChromeOpts`.
 *
 * What is NOT here, and why: the ydoc → Thread[] projection and its
 * decorations live in `doc/thread-projection.ts`, the five server writes a
 * card can make in `doc/thread-actions.ts`, the two writing surfaces in
 * `doc/review-composer.ts`, the per-device view preferences in
 * `doc/view-prefs.ts`, the selection → wire-anchor build in
 * `doc/anchor-body.ts`, the resize handles in `doc/chrome-panels.ts` and the
 * DOM helpers in `doc/chrome-dom.ts`. What is left is the WIRING: which
 * surface repaints when, and which callback each panel gets.
 */

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
  /**
   * Can this reader post? Straight from `MountContext.canWrite` — the
   * server's answer, fetched once before the router started.
   *
   * REQUIRED for the same reason `whenSynced` is: three surfaces mount this
   * chrome, and an optional access flag is how two of them would quietly keep
   * offering a working reply box to somebody the server will refuse. Making
   * it required turns "did I wire all three" into a compile error.
   */
  canWrite: boolean;
}

/**
 * Wire the topbar's comment-placement toggle: cards in the flow, or cards in
 * the right margin.
 *
 * Beside the doc-list toggle and the comments toggle, because it is the same
 * kind of thing — a stored per-device view preference, not a doc setting. Runs
 * once per page for the same reason `wireSetPaneToggle` does: chrome remounts
 * on every doc change, and a second listener would flip the placement twice
 * per click.
 *
 * The glyph shows the surface IN FORCE and the labels name the destination,
 * so a reader who has never touched it can still tell where their comments
 * are. There is no `aria-pressed`: this is not an on/off, it is a choice
 * between two surfaces, and "pressed = margin" would be an arbitrary reading
 * of which one counts as on.
 */
export function wireCardPlacementToggle(): void {
  const btn = document.getElementById('toggle-cards');
  if (!btn || btn.dataset.wired === '1') return;
  btn.dataset.wired = '1';
  const paint = () => {
    // The SURFACE, not the stored choice: on a phone a stored `balloon`
    // resolves to the sheet, and the button has to say so.
    const label = placementToggleLabel(effectiveSurface());
    btn.textContent = label.glyph;
    btn.title = label.title;
    btn.setAttribute('aria-label', label.ariaLabel);
  };
  paint();
  // Repaint on a width change too: with nothing stored the placement follows
  // the width, so crossing the default boundary moves the cards and a button
  // still showing the old glyph would be describing the other surface.
  onPlacementChange((target, type, fn) => target.addEventListener(type, fn), paint);
  btn.addEventListener('click', () => {
    setCardPlacement(otherPlacement(cardPlacement()));
  });
}

/** `CSS.escape` guarded — happy-dom (and very old browsers) may not have it.
 *  Same guard thread-morph.ts carries, for the same lookup. */
function cssEscape(id: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
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
  /** What this reader has already looked at (`comment-seen.ts`). */
  seen: SeenTracker;
  /**
   * The thread has sat in view long enough: record it seen and take the red
   * dot off every copy of its card and off its highlight, IN PLACE — a
   * rebuild would destroy a card mid-morph, and "new" is not in the render
   * key for exactly that reason.
   */
  markSeen: (threadId: string) => boolean;
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
  openComposer: (prefill?: string) => void;
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
  on(toggleThreads, 'click', () => {
    const open = !shell.classList.contains('threads-open');
    open ? openDrawer() : closeDrawer();
    writeDrawerPref(open);
  });
  on(closeThreads, 'click', () => {
    closeDrawer();
    writeDrawerPref(false);
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
  // Publish the surface before anything measures a card: the stylesheet
  // keys the margin and the inline cards off `body[data-cards]`, and a first
  // paint with the attribute missing lays every card out on the wrong surface.
  applyPlacement();
  wireCardPlacementToggle();
  wireResizeHandle({
    pane: document.getElementById('set-pane'),
    cssVar: '--set-w',
    storageKey: 'lf:set-w',
    min: 240,
    max: () => Math.min(600, Math.round(window.innerWidth * 0.45)),
    widthFromPointer: (e) => e.clientX,
    handleClass: 'set-resize',
    label: 'Resize the doc list',
  });
  // Desktop layout shows the drawer inline. Default open — EXCEPT when a
  // balloon margin is visible, where the drawer duplicates the balloons.
  const storedPref = readDrawerPref();
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
  // The ydoc → Thread[] projection, the anchor decorations, the seen tracker's
  // in-place dot removal and the pending-summary expiry timer live in
  // doc/thread-projection.ts with the state they own. The chrome keeps only
  // the fan-out below: which surfaces get repainted when that projection
  // changes.

  // Per doc, per browser: which threads this reader has looked at. Drives the
  // red "new" dot on the card, the highlight and the off-screen hints.
  const seen = createSeenTracker({ docId });
  const projection = createThreadProjection({
    ydoc,
    surface,
    seen,
    onPendingExpiry: () => redrawThreads(),
  });
  const {
    collect: collectThreads,
    resolveRange: resolveThreadRange,
    refreshDecorations: refreshThreadDecorations,
    lineLabel: threadLineLabel,
    markSeen,
  } = projection;

  function redrawThreads(): void {
    const all = collectThreads();
    threadsPanel.setThreads(all);
    refreshThreadDecorations(projection.activeThreadId());
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
  // --- thread panel ------------------------------------------------------
  // Every write a card can make. Stateless and DOM-free — see
  // doc/thread-actions.ts for why the failure contract is the reason they are
  // one module.
  const actions = createThreadActions({
    docId,
    user,
    getSelection: opts.getSelection,
    reanchorHint: opts.reanchorHint,
  });

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
    // The rectangle the dialog grows out of, measured BEFORE anything folds:
    // the margin bubble this thread is showing in. Null on every other route
    // (the drawer, a keyboard, a phone), and the modal simply appears there —
    // growing out of a row in a panel the dialog is about to cover would point
    // the gesture at nothing the reader is looking at.
    const bubble = document
      .querySelector('.markup-margin')
      ?.querySelector<HTMLElement>(`.thread[data-thread-id="${cssEscape(id)}"]`);
    const origin = bubble?.getBoundingClientRect() ?? null;
    threadsPanel.setExpandedElsewhere(id);
    threadModal.open(t, origin);
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
    canWrite: opts.canWrite,
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
    isNew: (t) => seen.isNew(t),
    // The five server writes a card can make — reply / answer, undo-answer,
    // resolve, reopen, re-anchor — live in doc/thread-actions.ts with the
    // failure contract they share. Nothing repaints from their return value:
    // the server writes the thread, the CRDT syncs it, and the observer below
    // redraws. The one exception is `reply`, whose `false` is what lets the
    // panel put the typed words back in the box.
    onReply: (id, text, answersCommentId, optionId) =>
      actions.reply(id, text, answersCommentId, optionId),
    onUndoAnswer: (id, commentId) => {
      void actions.undoAnswer(id, commentId);
    },
    onResolve: (id) => {
      void actions.resolve(id);
    },
    onReopen: (id) => {
      void actions.reopen(id);
    },
    onReanchor: (id) => {
      void actions.reanchor(id);
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
  // Which surface owns the comments can move three ways — the reader flips
  // the topbar toggle, or the window crosses either of the two widths where
  // the DEFAULT changes — and a listener on one of them alone is a silent
  // half-fix. `onPlacementChange` subscribes to all three.
  onPlacementChange(on, () => {
    applyPlacement();
    mobile.refresh();
    // Moving to the flow hands the conversation to the inline card and the
    // sheet. Leaving the dialog up would stack a second dismissable layer over
    // the same thread — and page zoom moves a reviewer across this line, so it
    // is not a hypothetical transition.
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

  // The comment composer and the full-screen thread view — the two writing
  // surfaces — live in doc/review-composer.ts with the state they own.
  const { openComposer, hideComposer, openThreadView, closeThreadView, refreshThreadView } =
    wireReviewComposer({
      els: {
        composer,
        composerText,
        composerAvatar,
        composerScrim,
        threadView,
        threadViewBody,
        threadViewClose,
        threadViewReplyText,
        threadViewReplySubmit,
      },
      user,
      docId,
      on,
      onCleanup: (fn) => opts.scope?.onCleanup(fn),
      surface,
      threadsPanel,
      collectThreads,
      resolveThreadRange,
      threadLineLabel,
      getSelection: opts.getSelection,
      selectHint: opts.selectHint,
      ...(opts.hidePill ? { hidePill: opts.hidePill } : {}),
      ...(opts.onComposerOpened ? { onComposerOpened: opts.onComposerOpened } : {}),
      ...(opts.onPosted ? { onPosted: opts.onPosted } : {}),
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
      huddle: m.huddle,
    });
    // On mobile the full path eats the topbar — show just the basename
    // truncated to ~32 chars, full path in `title` for tap-and-hold.
    const mobile = window.matchMedia('(max-width: 720px)').matches;
    // The kind pill beside the arrow already says "Plan" / "Meeting notes",
    // and the server titles the doc with the same word — "Meeting notes
    // Meeting notes 2026-09-01 14:40" read as a stutter at 1180px. The
    // crumb's own text drops it; the tab and the tooltip keep the whole
    // title, and on a phone (pill hidden) the crumb shows the clock's tail
    // either way.
    //
    // Only ahead of the minted clock, so a doc somebody RENAMED to "Plan the
    // offsite" keeps its first word.
    const shown =
      m.huddle === true
        ? full.replace(/^(?:Plan|Meeting notes) (?=\d{4}-\d{2}-\d{2} \d{2}:\d{2}$)/, '')
        : full;
    docTitleEl.textContent = mobile ? mobileLabel(shown) : shown;
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
    refreshThreadView();
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
    seen,
    markSeen,
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
      projection.clearPendingExpiry();
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
  huddle?: boolean;
}): string {
  return (
    (opts.type === 'diff' ? opts.relPath : undefined) ??
    // A live doc is named by its kind and the clock — "Plan 2026-09-01
    // 14:40" — and its
    // file is a generated path under the data dir that nobody chose, so the
    // title is the name and the path is plumbing. Every other file-backed
    // doc keeps the path: there the file IS what the person opened.
    (opts.huddle === true ? opts.title : undefined) ??
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
