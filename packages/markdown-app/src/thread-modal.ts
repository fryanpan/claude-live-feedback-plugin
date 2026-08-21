import { type Thread, threadRenderKey } from '@feedback/core';
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

  function draft(): string | undefined {
    return bodyEl.querySelector<HTMLTextAreaElement>('textarea')?.value || undefined;
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
    // and it can only be measured once it is in the document.
    sizeThreadSlots(bodyEl);
    titleEl.textContent = threadDecision(t) === 'none' ? 'Comment' : 'Decision';
    renderedKey = threadRenderKey(t);
  }

  function open(t: Thread): void {
    if (openId === null) {
      returnFocus = document.activeElement as HTMLElement | null;
    }
    openId = t.id;
    paint(t);
    scrim.classList.remove('hidden');
    root.classList.remove('hidden');
    scrim.setAttribute('aria-hidden', 'false');
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
    paint(t, draft());
  }

  scope.listen(root.querySelector('.thread-modal-close') as HTMLElement, 'click', close);
  scope.listen(scrim, 'click', close);
  scope.listen(document, 'keydown', (ev) => {
    if ((ev as KeyboardEvent).key !== 'Escape' || openId === null) return;
    ev.stopPropagation();
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
    root.remove();
    scrim.remove();
  });

  return { open, close, openThreadId: () => openId, refresh };
}
