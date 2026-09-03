/**
 * Carry the reader's typing across a rebuild.
 *
 * Every surface that shows thread cards repaints by clearing its container
 * and building fresh nodes — the drawer on any display-relevant change to ANY
 * thread, the balloon margin on any editor transaction, the modal when its
 * thread changes. Each of them already carries the draft's WORDS across the
 * rebuild; none of them carried the caret or the scroll position, so a peer's
 * reply landing over the websocket dropped focus to `body` (dismissing the
 * iPad keyboard) and let the emptied pane clamp its scrollTop to 0 — the
 * "typing a comment and suddenly I'm at the top" bug.
 *
 * The snapshot is scoped to the container being rebuilt: focus that lives
 * anywhere else — another copy of the same card, the doc, a toolbar — is not
 * this rebuild's to move, and stays where the reader put it.
 */

import {
  type ComposerSelection,
  composerSelection,
  composerState,
  focusMarkdownComposer,
  isComposerFocused,
} from './md-composer.ts';

export interface KeptComposerFocus {
  threadId: string;
  /** ProseMirror caret when the box was a live editor at snapshot time;
   *  null for a plain textarea, whose caret is `start`/`end`. */
  composer: ComposerSelection | null;
  start: number | null;
  end: number | null;
  dir: 'forward' | 'backward' | 'none';
}

/**
 * The reply box the reader is typing in under `root`, or null.
 *
 * "Typing in" means the box HOLDS focus right now — a draft the reader tapped
 * away from is carried by the caller's own value snapshot, and restoring
 * focus to it would yank the caret back from wherever they went.
 */
export function keptComposerFocus(root: ParentNode): KeptComposerFocus | null {
  const active = document.activeElement;
  for (const ta of Array.from(root.querySelectorAll<HTMLTextAreaElement>('.thread textarea'))) {
    // Three surfaces can hold the reader's focus for one box: the textarea
    // itself, the mounted editor's DOM under the shared `.md-composer` wrap,
    // or the editor's own notion of focus (ProseMirror keeps it through
    // transactions even while document.activeElement lags).
    const wrap = ta.closest('.md-composer');
    const focused =
      ta === active ||
      (wrap != null && active instanceof Node && wrap.contains(active)) ||
      isComposerFocused(ta);
    if (!focused) continue;
    const threadId = ta.closest<HTMLElement>('.thread')?.getAttribute('data-thread-id');
    if (!threadId) return null;
    return {
      threadId,
      composer: composerState(ta) === 'live' ? composerSelection(ta) : null,
      start: ta.selectionStart,
      end: ta.selectionEnd,
      dir: (ta.selectionDirection ?? 'none') as 'forward' | 'backward' | 'none',
    };
  }
  return null;
}

/**
 * Put the caret back into the rebuilt copy of the thread the reader was
 * typing in. `scroll: false` / `preventScroll` throughout — the caller's
 * scroll restore owns where the pane sits, and a focus that scrolls would
 * fight it.
 */
export function restoreComposerFocus(root: ParentNode, kept: KeptComposerFocus): void {
  const sel = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(kept.threadId) : kept.threadId;
  const ta = root.querySelector<HTMLTextAreaElement>(`.thread[data-thread-id="${sel}"] textarea`);
  if (!ta) return;
  const state = composerState(ta);
  if (state === 'live') {
    focusMarkdownComposer(ta, kept.composer, { scroll: false });
    return;
  }
  // The textarea is what is on screen — a plain box, or a composer whose
  // chunk is still in flight. Focus it now; for the pending case, also leave
  // the ask with the field so the mount carries it onto the editor.
  if (state === 'pending') focusMarkdownComposer(ta, kept.composer, { scroll: false });
  ta.focus({ preventScroll: true });
  if (kept.start != null && kept.end != null) {
    ta.setSelectionRange(kept.start, kept.end, kept.dir);
  }
}

/**
 * Every scrolled element from `from` up to the root, with where it sat.
 *
 * Taken BEFORE the container is cleared: emptying the list collapses the
 * pane's scrollHeight, and the browser clamps a scrollTop it can no longer
 * reach to 0 — silently, with no event. Restoring after the rebuild puts the
 * pane back on the exact rows the reader was looking at.
 */
export function keptScrollTops(from: Element): Array<{ el: Element; top: number }> {
  const kept: Array<{ el: Element; top: number }> = [];
  for (let el: Element | null = from; el; el = el.parentElement) {
    if (el.scrollTop > 0) kept.push({ el, top: el.scrollTop });
  }
  return kept;
}

export function restoreScrollTops(kept: Array<{ el: Element; top: number }>): void {
  for (const { el, top } of kept) el.scrollTop = top;
}
