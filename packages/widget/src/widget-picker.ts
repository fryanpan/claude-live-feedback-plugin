import { type ElementAnchor, anchors, escapeHtml as escape } from '@feedback/core';
import { composerNote, composerSignIn } from './widget-auth.ts';
import type { FeedbackWidgetEl } from './widget.ts';

const { hasContext } = anchors;

/**
 * Feedback mode and the composer — arming the picker, deciding what a tap
 * landed on, and putting a comment box beside it.
 *
 * Split out of `widget.ts` unchanged, as the second extraction of B7. The
 * private methods become functions taking the element first; the element
 * still holds the mode state, so the shipped bundle behaves identically.
 *
 * `TAG` and `IGNORE_ATTR` live here rather than in the parent because the
 * two predicates that read them — "did this tap land on our own chrome"
 * (`hitTest`) and "did this mutation come from our own chrome"
 * (`isInOwnChrome`) — are the same question, and an extracted file may not
 * import a value from the file that imports it. `widget.ts` imports both
 * names back.
 */
export const TAG = 'claude-feedback-widget';
export const IGNORE_ATTR = 'data-feedback-widget';

// The FAB is a MODE toggle, not a menu: one click arms it, every click on
// the page after that composes a comment, and it stays armed until the FAB
// is clicked again (or Escape with no composer open). Modeled on the
// comment mode in Claude Desktop artifacts — toggle on, click to place a
// bubble, type — because the whole point is fewer clicks per comment.

export function toggleFeedbackMode(el: FeedbackWidgetEl): void {
  if (el.feedbackMode) exitFeedbackMode(el);
  else enterFeedbackMode(el);
}

export function enterFeedbackMode(el: FeedbackWidgetEl): void {
  if (el.feedbackMode) return;
  el.feedbackMode = true;
  // The speech-bubble cursor rides a body class (see injectLightStyles) so
  // it beats per-element cursor styles the host page declares.
  document.body.classList.add('cfw-feedback-mode');
  // iOS Safari fires `click` reliably only on elements that have
  // `cursor: pointer` (or are a button/anchor). The mode needs to catch
  // taps on arbitrary mockup elements — `<div>`s, custom components,
  // etc. — that DON'T have a clickable cursor style. A window-level click
  // listener silently no-ops on those.
  //
  // Pointer events fix it: `pointerup` fires for mouse, touch, and pen
  // regardless of cursor style. Bonus: `touch-action: manipulation` on the
  // body suppresses the 300ms double-tap-zoom delay on iOS so taps
  // register instantly.
  const prevTouchAction = document.body.style.touchAction;
  document.body.style.touchAction = 'manipulation';
  el.togglePanel(false);
  const fab = el.shadow.querySelector('.fab');
  fab?.setAttribute('aria-pressed', 'true');
  fab?.classList.add('open');

  // The banner names the mode and holds the way out — the cursor alone
  // says "you're in a mode" but not how to leave it.
  const banner = document.createElement('div');
  banner.className = 'picker-banner';
  banner.innerHTML = `
      <span>Click anything to comment.</span>
      <button class="picker-cancel">Done (Esc)</button>
    `;
  el.shadow.appendChild(banner);

  const onMove = (ev: PointerEvent) => {
    // Skip hover-highlight on touch — fingers don't "hover," and
    // repainting outlines along a drag is just visual noise.
    if (ev.pointerType === 'touch') return;
    const t = hitTest(ev);
    if (el.hoverEl && el.hoverEl !== t) unhighlight(el.hoverEl);
    el.hoverEl = t;
    if (t) highlight(t);
  };
  const onTap = (ev: PointerEvent) => {
    const t = hitTest(ev);
    // Own chrome (FAB, composer, pins) keeps its normal behavior — a
    // preventDefault here would break the very controls the mode relies on.
    if (!t) return;
    ev.preventDefault();
    ev.stopPropagation();
    openComposerForElement(el, t, ev.clientX, ev.clientY);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    // First Escape backs out of the comment being written; the next one
    // exits the mode. Matches every modal-inside-a-mode convention.
    const composer = el.shadow.querySelector('.composer');
    if (composer) {
      composer.remove();
      return;
    }
    exitFeedbackMode(el);
  };
  banner.querySelector('.picker-cancel')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    exitFeedbackMode(el);
  });
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onTap, true);
  window.addEventListener('keydown', onKey, true);

  el.modeCleanup = () => {
    document.body.classList.remove('cfw-feedback-mode');
    document.body.style.touchAction = prevTouchAction;
    if (el.hoverEl) unhighlight(el.hoverEl);
    el.hoverEl = null;
    banner.remove();
    fab?.setAttribute('aria-pressed', 'false');
    fab?.classList.remove('open');
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onTap, true);
    window.removeEventListener('keydown', onKey, true);
  };
}

/** A composer left open survives the exit — mid-typed text is not the
 *  mode's to discard. */
export function exitFeedbackMode(el: FeedbackWidgetEl): void {
  if (!el.feedbackMode) return;
  el.feedbackMode = false;
  el.modeCleanup?.();
  el.modeCleanup = null;
}

function hitTest(ev: MouseEvent): HTMLElement | null {
  const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
  if (!el) return null;
  // skip widget chrome
  if (el.closest(`[${IGNORE_ATTR}]`) || el.tagName === TAG.toUpperCase()) return null;
  return el;
}

/** The other half of `hitTest`'s question, asked of a mutation record rather
 *  than a pointer: writes the widget made itself must not re-enter the
 *  render loop. */
export function isInOwnChrome(node: Node): boolean {
  let el: Node | null = node;
  while (el) {
    if (el.nodeType === 1) {
      const e = el as Element;
      if (
        e.hasAttribute?.(IGNORE_ATTR) ||
        e.tagName === TAG.toUpperCase() ||
        e.id === 'cfw-light-styles'
      ) {
        return true;
      }
    }
    el = el.parentNode;
  }
  return false;
}

function highlight(el: HTMLElement): void {
  el.dataset.cfwPrevOutline = el.style.outline;
  el.style.outline = '2px solid #2e7dd7';
}
function unhighlight(el: HTMLElement): void {
  el.style.outline = el.dataset.cfwPrevOutline ?? '';
  delete el.dataset.cfwPrevOutline;
}

// --- Composer ---

function openComposerForElement(
  widget: FeedbackWidgetEl,
  el: HTMLElement,
  cx: number,
  cy: number,
): void {
  const anchor: ElementAnchor = {
    ...anchors.Element.createAnchor(el),
    ...(hasContext(widget.currentContext) ? { context: { ...widget.currentContext } } : {}),
  };
  showComposer(widget, anchor, cx, cy, null);
}

function showComposer(
  el: FeedbackWidgetEl,
  anchor: ElementAnchor,
  cx: number,
  cy: number,
  replyTo: string | null,
): void {
  const existing = el.shadow.querySelector('.composer') as HTMLElement | null;
  existing?.remove();
  const composer = document.createElement('div');
  composer.className = 'composer';
  composer.style.left = `${Math.min(cx + 12, window.innerWidth - 320)}px`;
  composer.style.top = `${Math.min(cy + 12, window.innerHeight - 200)}px`;
  composer.innerHTML = `
      <div class="composer-snippet">${escape(anchor.snippet.text)}</div>
      <textarea placeholder="${replyTo ? 'Reply…' : 'Comment on this element…'}" rows="3"></textarea>
      <div class="composer-actions">
        <button class="cancel">Cancel</button>
        <button class="primary submit">Post</button>
      </div>
    `;
  el.shadow.appendChild(composer);
  const ta = composer.querySelector('textarea') as HTMLTextAreaElement;
  ta.focus();
  composer.querySelector('.cancel')?.addEventListener('click', () => composer.remove());
  const submit = composer.querySelector('.submit') as HTMLButtonElement;
  // Say it before the first attempt when the widget already knows.
  if (el.signInToWrite && !el.authToken) composerSignIn(el, composer, submit);
  submit.addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text || !el.user) return;
    // A silent await reads as a dead button — say the click landed.
    submit.disabled = true;
    submit.textContent = 'Posting…';
    // A rejected fetch (server unreachable) is a failed post like any
    // other — without the catch it would strand the button at "Posting…".
    let posted = false;
    try {
      posted = replyTo ? await el.postReply(replyTo, text) : await el.postNewThread(anchor, text);
    } catch {}
    if (!posted) {
      // Kept on failure, with the text still in it.
      submit.disabled = false;
      submit.textContent = 'Post';
      if (el.signInToWrite && !el.authToken) composerSignIn(el, composer, submit);
      else composerNote(composer, 'Couldn’t post — try again.');
      return;
    }
    composer.remove();
  });
}
