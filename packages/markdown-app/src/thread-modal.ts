import { type Thread, threadRenderKey, threadSummary } from '@feedback/core';
import {
  keptComposerFocus,
  keptScrollTops,
  restoreComposerFocus,
  restoreScrollTops,
} from './composer-keep.ts';
import { threadDecision } from './long-thread.ts';
import { isFoldingTap, sizeThreadSlots, syncFaceVisibility } from './thread-morph.ts';

/**
 * The wide modal a long or decision-bearing thread opens in.
 *
 * The balloon column is 300px and the card that lands in it is sometimes a
 * whole conversation or a decision with option buttons under it. Above the
 * threshold in `long-thread.ts` the thread stops expanding in place and opens
 * here instead: same card, room to read it.
 *
 * The card is `ThreadPanel.renderThread` — the ONE builder behind the drawer
 * row, the margin balloon, the mobile inline card and the sheet — reused
 * rather than reimplemented, so reply / resolve / reopen / re-anchor and the
 * whole review-item interface behave identically here. That is also why this
 * module takes `renderCard` rather than a panel: it renders nothing of its own
 * and has no opinion about what a thread looks like.
 *
 * Deliberately NOT a second expand authority. The panel's active thread is
 * still the one state, and the chrome sets it when it opens this — the modal
 * only forces its own copy open so a caller that forgets cannot produce a
 * folded card inside a dialog.
 *
 * Desktop and tablet only. Below 1100px a comment already opens as a
 * full-width inline card with the over-doc sheet behind it, and a modal on top
 * of a sheet is two dismissable layers over one conversation. The width test
 * lives with the caller (`inlineCardsVisible`), which is the thing that knows.
 */

/**
 * Just the two things this needs from a lifecycle owner. A `MountScope`
 * satisfies it, and so does the ad-hoc pair the chrome assembles for a mount
 * that has no scope of its own — which is what the lighter test fixtures and
 * the pre-router boots are.
 */
export interface ThreadModalScope {
  listen: (
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions,
  ) => void;
  onCleanup: (fn: () => void) => void;
}

export interface ThreadModalOpts {
  scope: ThreadModalScope;
  /** The card. Pass `(t, draft) => threadsPanel.renderThread(t, draft)`. */
  renderCard: (t: Thread, pendingReply?: string) => HTMLElement;
  /**
   * The modal closed — by any route, including `close()` itself. Carries the
   * thread it WAS showing, which is what lets the chrome hand the selection
   * back only when the selection is still that thread: a close caused by
   * another thread being selected must not then unselect that other thread.
   *
   * Fires exactly once per open. A close that closes nothing announces
   * nothing, which is what keeps the caller's own `setActive(null)` from
   * looping back in through `onActiveChange`.
   */
  onClose: (threadId: string) => void;
  /**
   * Which thread's card, if any, sits under this point on the page BEHIND the
   * scrim. The chrome answers with `document.elementsFromPoint`; the modal has
   * no business knowing how a card is found.
   *
   * Omit it and the scrim is a plain dismiss, which is what it was.
   */
  threadUnderPoint?: (x: number, y: number) => string | null;
  /**
   * The reader clicked another thread's card through the scrim. Route it the
   * same way a click on that card would go — inline, modal or sheet, by the
   * caller's own predicate.
   */
  onSwitchThread?: (threadId: string) => void;
}

export interface ThreadModalHandle {
  open: (t: Thread) => void;
  close: () => void;
  /** The thread on screen, or null when the modal is down. */
  openThreadId: () => string | null;
  /**
   * The doc changed. Pass the current version of the open thread — or `null`
   * when it is gone (deleted, resolved out of the caller's set), which closes.
   * A no-op while nothing is open.
   */
  refresh: (t: Thread | null) => void;
}

export function mountThreadModal(opts: ThreadModalOpts): ThreadModalHandle {
  const { scope } = opts;

  const scrim = document.createElement('div');
  scrim.className = 'thread-modal-scrim hidden';
  const root = document.createElement('div');
  root.className = 'thread-modal hidden';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Comment thread');
  root.innerHTML = `
    <header class="thread-modal-header">
      <h2 class="thread-modal-title">Comment</h2>
      <button type="button" class="icon-btn thread-modal-close" aria-label="Close" title="Close">×</button>
    </header>
    <div class="thread-modal-body"></div>
  `;
  document.body.append(scrim, root);
  const titleEl = root.querySelector('.thread-modal-title') as HTMLElement;
  const bodyEl = root.querySelector('.thread-modal-body') as HTMLElement;

  let openId: string | null = null;
  /** What the card on screen was built from — the same fingerprint the drawer
   *  and the balloon column memoize off, so all three agree on when a card has
   *  actually changed rather than merely been re-collected. */
  let renderedKey = '';
  /** Where focus was when this opened, so closing puts it back. */
  let returnFocus: HTMLElement | null = null;
  /** Watches the open card's faces so growth with no event anywhere — a reply
   *  wrapping onto another line as it is typed, an image landing in a comment
   *  body — re-sizes the slots instead of being clipped by a stale height. */
  let faceWatch: ResizeObserver | null = null;

  function draft(): string | undefined {
    return bodyEl.querySelector<HTMLTextAreaElement>('textarea')?.value || undefined;
  }

  function watchFaces(card: HTMLElement): void {
    faceWatch?.disconnect();
    if (typeof ResizeObserver !== 'function') return;
    // Height-reactive on purpose, unlike `installSlotRemeasure`'s width-only
    // containers: a slot's height never feeds back into its face's height, so
    // re-sizing on face growth settles instead of looping — the one indirect
    // path (a write that summons the body's scrollbar and narrows the faces)
    // converges, because the scrollbar appears at most once.
    faceWatch = new ResizeObserver(() => sizeThreadSlots(bodyEl));
    for (const face of Array.from(card.querySelectorAll<HTMLElement>('.thread-face'))) {
      faceWatch.observe(face);
    }
  }

  function paint(t: Thread, pendingReply?: string): void {
    bodyEl.textContent = '';
    const card = opts.renderCard(t, pendingReply);
    // The modal's contract is that the card is OPEN. The panel's selection is
    // the authority and the chrome sets it, but a card built while the panel
    // disagrees would mount folded inside a dialog with nothing to unfold it —
    // the fold tap is swallowed in here.
    card.classList.add('expanded');
    syncFaceVisibility(card, true);
    bodyEl.appendChild(card);
    // A slot has no intrinsic height; nothing renders until it is measured,
    // and it can only be measured once it is in the document — which is also
    // why `open()` un-hides the dialog BEFORE painting: against `display:
    // none` every face reads 0, the zero is refused, and the card would hang
    // its whole interior on some later remeasure happening to fire.
    sizeThreadSlots(bodyEl);
    watchFaces(card);
    // The dialog covers the document, so the anchor snippet is the one thing
    // the reader can no longer go and look at — "Comment" told them nothing
    // they had not just clicked. `threadSummary` is the shared seam every
    // other surface titles its card from, so the dialog and the balloon it
    // came out of cannot disagree about what a thread is about. A decision
    // keeps its kind: there the WHAT outranks the WHERE.
    // textContent, never innerHTML: a snippet is document text and untrusted.
    titleEl.textContent =
      threadDecision(t) === 'none' ? threadSummary(t).topic || 'Comment' : 'Decision';
    renderedKey = threadRenderKey(t);
  }

  function open(t: Thread): void {
    if (openId === null) {
      returnFocus = document.activeElement as HTMLElement | null;
    }
    openId = t.id;
    // Visible BEFORE painted: paint measures the card's slots, and a subtree
    // under `display: none` measures 0 everywhere. Same tick, so no frame is
    // ever shown between the two.
    scrim.classList.remove('hidden');
    root.classList.remove('hidden');
    scrim.setAttribute('aria-hidden', 'false');
    paint(t);
    // Focus lands on the close button rather than on the card: it is the one
    // control that is always present and always safe to press, and tabbing on
    // from it walks the conversation in reading order.
    (root.querySelector('.thread-modal-close') as HTMLElement | null)?.focus?.();
  }

  function close(): void {
    // A close that closes nothing announces nothing. The caller's `onClose`
    // hands the panel's selection back, which comes round again as an
    // active-change — and that is where an unguarded second close would loop.
    if (openId === null) return;
    const was = openId;
    openId = null;
    renderedKey = '';
    faceWatch?.disconnect();
    faceWatch = null;
    bodyEl.textContent = '';
    root.classList.add('hidden');
    scrim.classList.add('hidden');
    scrim.setAttribute('aria-hidden', 'true');
    returnFocus?.focus?.();
    returnFocus = null;
    opts.onClose(was);
  }

  function refresh(t: Thread | null): void {
    if (openId === null) return;
    if (!t || t.id !== openId) {
      close();
      return;
    }
    // Same fingerprint, same card — and leaving it alone is not merely an
    // optimisation: a rebuild while somebody is typing loses the caret, and
    // the column rebuilds on every editor transaction in the doc behind this.
    if (threadRenderKey(t) === renderedKey) return;
    // A reply landing in THIS thread does rebuild the card — carry the caret
    // and the body's scroll across it, same contract as the drawer's render.
    const keptFocus = keptComposerFocus(bodyEl);
    const keptScroll = keptScrollTops(bodyEl);
    paint(t, draft());
    if (keptFocus) restoreComposerFocus(bodyEl, keptFocus);
    restoreScrollTops(keptScroll);
  }

  scope.listen(root.querySelector('.thread-modal-close') as HTMLElement, 'click', close);
  /**
   * The scrim dismisses — unless the reader was aiming at another thread.
   *
   * Measured on the build: with the dialog up, clicking a second thread's card
   * only closed the dialog, so switching threads took two clicks and the first
   * one looked like a miss. It wasn't a miss — the click landed exactly where
   * it was aimed, on a scrim covering the card. Asking what is UNDER the point
   * turns that first click into what the reader meant by it.
   *
   * Falls through to `close()` for a click on the same thread's own card too:
   * there is nothing to switch to, and dismissing is the only other thing the
   * gesture could mean.
   */
  scope.listen(scrim, 'click', (ev) => {
    const me = ev as MouseEvent;
    const under = opts.threadUnderPoint?.(me.clientX, me.clientY) ?? null;
    if (under !== null && under !== openId && opts.onSwitchThread) {
      opts.onSwitchThread(under);
      return;
    }
    close();
  });
  /**
   * Everything inside the dialog a Tab could land on.
   *
   * The `display`/`visibility` filter is what keeps the reply box's hidden
   * `<textarea>` out of the list — every composer is a markdown editor, and
   * the textarea it replaced is still in the DOM behind a `display: none`
   * class. In a browser `getComputedStyle` reports that and the element drops
   * out; under happy-dom no stylesheet is loaded so it stays in, which is
   * harmless: the trap only reads the two ENDS of this list, and the textarea
   * is never at either end.
   */
  const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable]:not([contenteditable="false"])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(', ');

  function focusables(): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
      // A folded face is `inert`, and its contents are not reachable.
      if (el.hasAttribute('inert') || el.closest('[inert]')) return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      const cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
      return !cs || (cs.display !== 'none' && cs.visibility !== 'hidden');
    });
  }

  /**
   * Keep Tab inside the dialog.
   *
   * `aria-modal="true"` is a promise to assistive tech and nothing more — it
   * moves no focus on its own. Measured before this existed: four stops inside
   * the card and then out into the page behind, where every control sits under
   * a scrim the keyboard can neither see nor dismiss.
   *
   * Bound to `document` rather than to the dialog on purpose, so the branch
   * that matters most still fires: focus that is ALREADY outside gets pulled
   * back, which a listener scoped to the dialog could never see.
   */
  scope.listen(document, 'keydown', (ev) => {
    const ke = ev as KeyboardEvent;
    if (ke.key !== 'Tab' || openId === null) return;
    const items = focusables();
    if (items.length === 0) {
      ev.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!active || !root.contains(active)) {
      ev.preventDefault();
      (ke.shiftKey ? last : first).focus();
      return;
    }
    // Anywhere but the two ends, the browser's own order is right — only the
    // edges need turning back.
    if (ke.shiftKey && active === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ke.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  });

  // Escape closes the TOP layer and only the top layer.
  //
  // `stopImmediatePropagation`, not `stopPropagation`: the chrome's own
  // Escape handler is bound to `document` too, and stopping propagation does
  // nothing to another listener on the SAME node — it only stops the event
  // travelling further up. So the weaker call left one Escape closing the
  // dialog and the comments drawer underneath it in a single press.
  scope.listen(document, 'keydown', (ev) => {
    if ((ev as KeyboardEvent).key !== 'Escape' || openId === null) return;
    ev.stopImmediatePropagation();
    close();
  });

  // The whole card is its own tap target — that is how a balloon folds — and
  // in here that contract is wrong: a tap on the words would collapse the
  // conversation the reader opened the dialog to read. Swallowed in the
  // CAPTURE phase, before the card's own handler sees it. The caret is the
  // exception and keeps its meaning: it is the collapse control, and in a
  // modal collapsing IS closing.
  scope.listen(
    root,
    'click',
    (ev) => {
      const target = ev.target as HTMLElement;
      if (target.closest?.('.thread-modal-close')) return;
      if (target.closest?.('.thread-caret')) {
        ev.stopPropagation();
        close();
        return;
      }
      if (isFoldingTap(target)) ev.stopPropagation();
    },
    { capture: true },
  );

  scope.onCleanup(() => {
    // A scope can die while the dialog is open — close() never runs then, so
    // the observer must be released here too or it retains the removed card.
    faceWatch?.disconnect();
    faceWatch = null;
    root.remove();
    scrim.remove();
  });

  return { open, close, openThreadId: () => openId, refresh };
}
