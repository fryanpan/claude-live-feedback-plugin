/**
 * The selection affordances over a markdown document: the round comment pill,
 * the always-in-view Comment float, and the cached selection both of them and
 * the composer anchor to.
 *
 * One module because they are one state machine, not three widgets. A gesture
 * suppresses the pill; a settled selection brings it back; a caret shows a
 * lighter pill over the sentence it would select; a blur takes both away —
 * and every one of those transitions writes the SAME cached selection, which
 * is the thing iOS destroys between the pill appearing and the tap landing.
 * Split across files, that cache would need a second writer, which is exactly
 * the bug the cache exists to prevent.
 *
 * On a huddle doc a range selection grows the pointer pill instead (see
 * doc-pointer-pill.ts); the round pill survives there only in caret mode,
 * where its job is to make the selection the pointer pill then hangs off.
 */
import type { EditorState } from '@tiptap/pm/state';
import type { EditorHandle } from '../editor.ts';
import { trackGesture } from '../gesture.ts';
import type { MountScope } from '../mount-scope.ts';
import type { ChromeSelection } from '../review-chrome.ts';
import { showToast } from './chrome-dom.ts';
import { mountCommentFloat } from './comment-float.ts';
import type { PointerPillLayer } from './doc-pointer-pill.ts';

export interface CommentPillOptions {
  /** True on a huddle doc, where a range selection belongs to the pointer
   *  pill and the round pill only ever appears in caret mode. */
  huddle: boolean;
  editor: EditorHandle;
  /** The `#editor` element — the scroll container the pill is clamped to. */
  editorMount: HTMLElement;
  /** The `#composer` sheet. An open composer freezes the pill. */
  composer: HTMLElement;
  commentPill: HTMLButtonElement;
  scope: MountScope;
  /** The pointer pill a huddle doc shows over a range selection. */
  pointer: PointerPillLayer;
  openComposer: () => void;
  /** Keep the caret clear of the on-screen keyboard (edit-viewport.ts).
   *  A no-op with no keyboard up. */
  follow: () => void;
}

export interface CommentPillHandle {
  /** The selection a comment should anchor to: the editor's own if it has
   *  one, else the last one this controller cached. */
  currentSelection: () => ChromeSelection | null;
  /** Re-read the editor's selection (the editor's own selection callback). */
  refreshSelection: () => void;
  /** Hide the round pill AND the pointer pill. */
  hide: () => void;
  /** Scroll the selection above the composer + keyboard, once it opens. */
  onComposerOpened: () => void;
}

export function mountCommentPill(opts: CommentPillOptions): CommentPillHandle {
  const {
    huddle,
    editor,
    editorMount,
    composer,
    commentPill,
    scope,
    pointer,
    openComposer,
    follow,
  } = opts;

  // =========================================================================
  // COMMENT PILL — small inline affordance
  //   • Range selection → pill appears just past the end of the selection
  //     (or below it if there's no room), so the user sees what they've
  //     selected without the pill occluding the doc or competing with
  //     iOS's native selection menu for screen space.
  //   • Empty selection (caret after tap) → a lighter pill appears in the
  //     right margin of the current line so the user can comment on a
  //     paragraph by tap → pill → composer (Bryan: "tap then comment").
  //     Tapping the pill expands selection to the tapped paragraph before
  //     opening the composer.
  // =========================================================================

  let selection: ChromeSelection | null = null;
  let selectionSettled = false;

  /** What the pill represents if clicked: a range selection, or expand
   *  to the paragraph containing the caret. */
  let pillMode: 'range' | 'caret' = 'range';
  /** Cached paragraph range for caret mode — captured when the pill is
   *  shown so the click handler doesn't depend on the editor still having
   *  the same selection (iOS blurs the editor when the pill is tapped). */
  let caretParaRange: { from: number; to: number } | null = null;

  // A gesture on the document suppresses the pill until it ends, so the pill
  // doesn't hop around under the finger mid-drag. Releasing is only ONE of
  // the ways a touch ends — a cancelled one (scroll, iOS long-press takeover)
  // delivers no pointerup at all, and treating that as "still dragging" left
  // inline commenting dead for the rest of the page load. See gesture.ts.
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const gesture = trackGesture({
    dom: editor.editor.view.dom,
    win: window,
    onBegin: () => {
      selectionSettled = false;
      hidePill();
    },
    onEnd: () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        selectionSettled = true;
        const sel = editor.getSelectionRel();
        if (sel) selection = sel;
        positionPill();
      }, 50);
    },
  });
  scope.onCleanup(() => {
    gesture.dispose();
    // Same reason the selectionchange timer is cleared below: this one would
    // run positionPill() against the destroyed editor of the previous doc.
    if (settleTimer) clearTimeout(settleTimer);
  });

  function refreshSelectionState(): void {
    const sel = editor.getSelectionRel();
    if (sel) selection = sel;
    // Typing or arrowing towards the bottom of the window walks the caret
    // under the on-screen keyboard; `follow` scrolls it back into the band
    // the visual viewport says is visible. No-op with no keyboard up, and a
    // no-op again once the caret is already clear.
    follow();
  }

  /** Is there a non-collapsed native selection sitting inside the editor?
   *  In VIEW mode (contenteditable=false) the editor is never focused and
   *  ProseMirror's selection stays empty, so the pill must key off the raw
   *  DOM selection instead — this is what makes iOS long-press commenting
   *  work without making the doc editable. */
  function hasDomSelection(): boolean {
    const s = window.getSelection();
    if (!s || s.rangeCount === 0 || s.isCollapsed) return false;
    const r = s.getRangeAt(0);
    const dom = editor.editor.view.dom;
    return dom.contains(r.startContainer) && dom.contains(r.endContainer);
  }

  function positionPill(): void {
    if (gesture.active) {
      hidePill();
      return;
    }
    // Don't reposition (and don't re-show) the pill while the composer
    // is open. The visualViewport `resize` that fires when the keyboard
    // slides up would otherwise repaint the pill mid-transition at a
    // stale location.
    if (!composer.classList.contains('hidden')) {
      hidePill();
      return;
    }
    // No focus = no active cursor = no pill — UNLESS there's a raw DOM
    // selection inside the editor (view mode, where the editor never takes
    // focus but the user can still long-press-select text to comment on).
    if (!editor.editor.isFocused && !hasDomSelection()) {
      hidePill();
      return;
    }
    const state = editor.editor.state;
    const view = editor.editor.view;
    const { from, to, empty } = state.selection;
    try {
      const pillW = 36;
      const pillH = 36;
      const gap = 8;
      const viewportW = window.innerWidth;
      // On iOS, position:fixed and getBoundingClientRect are LAYOUT-viewport
      // relative, but visualViewport.height already excludes the on-screen
      // keyboard. We want the max-y the pill can use to stay above the
      // keyboard, expressed in the same layout-viewport coords the browser
      // gives us. That's vv.offsetTop + vv.height. Do NOT subtract
      // --kb-bottom again here — that was the bug that pinned the pill
      // to y=0 when the keyboard was open.
      const vv = window.visualViewport;
      const vvTop = vv?.offsetTop ?? 0;
      const vvHeight = vv?.height ?? window.innerHeight;
      const availableBottom = vvTop + vvHeight - pillH - 8;

      // Range mode fires when PM has a selection (edit mode) OR there's a raw
      // DOM selection (view mode). The positioning below already prefers the
      // DOM selection's client rects, so it works the same either way.
      if (!empty || hasDomSelection()) {
        pillMode = 'range';
        caretParaRange = null;
        commentPill.classList.remove('caret');
        if (huddle) {
          commentPill.classList.add('hidden');
          pointer.show(from, to);
          return;
        }
        // Prefer the DOM selection's LAST client rect — that's what the
        // user actually sees highlighted on iOS (where native selection
        // handles don't always stay in lockstep with ProseMirror's `to`).
        // Fall back to coordsAtPos if DOM selection is empty.
        let endRight = 0;
        let endTop = 0;
        let endBottom = 0;
        const winSel = window.getSelection();
        if (winSel && winSel.rangeCount > 0 && !winSel.isCollapsed) {
          const rects = winSel.getRangeAt(0).getClientRects();
          const last = rects.length > 0 ? rects[rects.length - 1] : null;
          if (last) {
            endRight = last.right;
            endTop = last.top;
            endBottom = last.bottom;
          }
        }
        if (endRight === 0) {
          const c = view.coordsAtPos(to);
          endRight = c.right;
          endTop = c.top;
          endBottom = c.bottom;
        }
        let left = endRight + gap;
        let top = Math.max(8, endTop - 2);
        // If that runs past the right edge, tuck below the selection end.
        if (left + pillW > viewportW - 8) {
          left = Math.max(8, endRight - pillW);
          top = endBottom + gap;
        }
        top = Math.min(top, availableBottom);
        commentPill.style.left = `${Math.max(8, left)}px`;
        commentPill.style.top = `${top}px`;
        commentPill.classList.remove('hidden');
      } else if (selectionSettled) {
        // Caret mode — float the pill RIGHT next to the caret so the user
        // sees it as attached to the spot they tapped. Cache the SENTENCE
        // range (not the whole paragraph) so the click handler can commit
        // even if iOS blurred the editor selection in the meantime.
        pillMode = 'caret';
        commentPill.classList.add('caret');
        const caret = view.coordsAtPos(from);
        let left = caret.right + gap;
        let top = Math.max(8, caret.top - 2);
        if (left + pillW > viewportW - 8) left = viewportW - pillW - 8;
        top = Math.min(top, availableBottom);
        commentPill.style.left = `${Math.max(8, left)}px`;
        commentPill.style.top = `${Math.max(8, top)}px`;
        commentPill.classList.remove('hidden');
        caretParaRange = sentenceRangeAt(state, from);
      } else {
        hidePill();
      }
    } catch {
      hidePill();
    }
  }

  function hidePill(): void {
    commentPill.classList.add('hidden');
    pointer.hide();
    caretParaRange = null;
  }

  // Prevent the pill from stealing focus on DESKTOP (mousedown causes blur
  // before click). On iOS, preventDefault on touchstart/pointerdown
  // cancels the synthetic click entirely — so only hook mousedown.
  scope.listen(commentPill, 'mousedown', (ev) => (ev as MouseEvent).preventDefault());
  scope.listen(commentPill, 'click', () => {
    if (pillMode === 'caret') {
      // Use the cached paragraph range — the editor may have lost its
      // selection when the pill was tapped (iOS blur), but we stashed
      // the range when the pill appeared.
      if (!caretParaRange) {
        showToast('Tap again to place the caret, then the pill.');
        return;
      }
      const { from, to } = caretParaRange;
      if (from >= to) return;
      editor.editor.commands.focus();
      editor.editor.commands.setTextSelection({ from, to });
      // setTextSelection is synchronous; read the rel positions now.
      const sel = editor.getSelectionRel();
      if (sel) selection = sel;
    }
    // On a HUDDLE doc the round pill only ever appears in caret mode, and its
    // job ends with the sentence selection it just made: `positionPill` sees
    // a range and brings up the pointer pill over it. Everywhere else it is
    // the comment affordance it has always been, and opens the composer.
    if (huddle) {
      selectionSettled = true;
      positionPill();
      return;
    }
    openComposer();
  });

  /**
   * Start a comment from the always-in-view Comment float.
   *
   * Same three cases the selection pill handles, in the same order, because
   * the reader has to be able to reach the composer from the button they can
   * see rather than only from the one that appears: a live selection is the
   * anchor; otherwise the SENTENCE at the caret is (the pill's "tap then
   * comment" gesture, without needing the tap to have raised a pill); with
   * neither, say what would make it work rather than opening an empty box.
   */
  function commentAtCaret(): void {
    if (editor.getSelectionRel()) {
      openComposer();
      return;
    }
    const { state } = editor.editor.view;
    const range = caretParaRange ?? sentenceRangeAt(state, state.selection.from);
    if (!range || range.from >= range.to) {
      showToast('Tap the sentence you want to comment on, then Comment.');
      return;
    }
    editor.editor.commands.focus();
    editor.editor.commands.setTextSelection(range);
    const sel = editor.getSelectionRel();
    if (sel) selection = sel;
    openComposer();
  }

  mountCommentFloat({
    anchor: editorMount.closest('#editor-pane') ?? editorMount,
    onComment: commentAtCaret,
    listen: (target, type, fn) => scope.listen(target, type, fn),
  });

  // This lives on the editor's own DOM, which is removed by editor.destroy()
  // on teardown, so its listener dies with it — no scope binding needed.
  editor.editor.view.dom.addEventListener('keyup', (ev) => {
    if (ev.shiftKey || ev.key.startsWith('Arrow') || ev.key === 'Home' || ev.key === 'End') {
      selectionSettled = true;
      refreshSelectionState();
      positionPill();
    }
  });
  editor.editor.on('selectionUpdate', () => {
    if (!gesture.active && selectionSettled) positionPill();
  });
  // Typing into the editor hides the caret-mode pill — it's a commenting
  // affordance, not something we want hovering mid-sentence. Range-mode
  // pill auto-clears because a selection can't exist while typing.
  editor.editor.on('update', () => {
    if (pillMode === 'caret') hidePill();
  });
  // Editor loses focus (user tapped outside, keyboard dismissed, etc.)
  // → no active cursor → no pill. Same for the underlying DOM element,
  // since iOS can blur the input without firing Tiptap's blur event
  // when the pill is tapped.
  editor.editor.on('blur', () => {
    selectionSettled = false;
    hidePill();
  });
  editor.editor.view.dom.addEventListener('focusout', (ev) => {
    // Ignore transient focus loss that immediately returns to the editor
    // (e.g., toolbar button clicks that refocus).
    setTimeout(() => {
      if (!editor.editor.isFocused) {
        selectionSettled = false;
        hidePill();
      }
    }, 0);
    void ev;
  });
  // Keep pill in sync if the keyboard appears/disappears (visualViewport
  // resize changes --kb-bottom, which changes our clamp max).
  if (window.visualViewport) scope.listen(window.visualViewport, 'resize', () => positionPill());
  scope.listen(window, 'scroll', () => positionPill(), { passive: true });
  scope.listen(editorMount, 'scroll', () => positionPill(), { passive: true });
  // VIEW mode: ProseMirror fires no selectionUpdate (the editor isn't
  // editable), and iOS selection-handle drags don't always produce a clean
  // pointerup on the editor DOM. The document `selectionchange` event is the
  // reliable signal there, so (debounced) drive the pill off it. In edit mode
  // PM's own selectionUpdate already handles this, so skip to avoid double work.
  let selChangeTimer: ReturnType<typeof setTimeout> | null = null;
  scope.listen(document, 'selectionchange', () => {
    if (!document.body.classList.contains('view-mode')) return;
    if (gesture.active) return; // wait for the gesture to settle (see gesture.ts)
    if (selChangeTimer) clearTimeout(selChangeTimer);
    selChangeTimer = setTimeout(() => {
      selectionSettled = true;
      refreshSelectionState();
      positionPill();
    }, 120);
  });
  // A pending selectionchange timer must not fire after this mount is torn down
  // — it would run positionPill() against a destroyed editor on the next doc.
  scope.onCleanup(() => {
    if (selChangeTimer) clearTimeout(selChangeTimer);
  });

  // =========================================================================
  // COMPOSER (Notion-style slim sheet)
  //   The doc stays behind a dim scrim with the selection still visible
  //   (we do NOT re-quote the snippet inside the composer — the user sees
  //   what they're commenting on in place). On open we scroll the editor
  //   so the selection sits above the composer + keyboard.
  // =========================================================================

  function scrollSelectionAboveKeyboard(): void {
    try {
      const vv = window.visualViewport;
      const vvTop = vv?.offsetTop ?? 0;
      const vvHeight = vv?.height ?? window.innerHeight;
      // 20% from the top of the visible-above-keyboard area
      const desiredTop = vvTop + vvHeight * 0.2;
      let selTop = 0;
      const winSel = window.getSelection();
      if (winSel && winSel.rangeCount > 0 && !winSel.isCollapsed) {
        selTop = winSel.getRangeAt(0).getBoundingClientRect().top;
      } else {
        const { from } = editor.editor.state.selection;
        selTop = editor.editor.view.coordsAtPos(from).top;
      }
      const deltaY = selTop - desiredTop;
      if (Math.abs(deltaY) < 20) return;
      const scroller = document.getElementById('editor');
      if (scroller) scroller.scrollBy({ top: deltaY, behavior: 'smooth' });
    } catch {}
  }

  return {
    currentSelection: () => editor.getSelectionRel() ?? selection,
    refreshSelection: refreshSelectionState,
    hide: hidePill,
    onComposerOpened: () => {
      // Wait for the keyboard to finish sliding up (visualViewport
      // resizes), THEN scroll the editor so the selection sits ~20% from
      // the top of the visible-above-keyboard area. If vv doesn't resize
      // within 500ms, assume the keyboard was already open.
      const vv = window.visualViewport;
      let done = false;
      const run = () => {
        if (done) return;
        done = true;
        vv?.removeEventListener('resize', run);
        scrollSelectionAboveKeyboard();
      };
      vv?.addEventListener('resize', run);
      setTimeout(run, 500);
    },
  };
}

/**
 * Expand a caret position to the sentence it's inside (or the sentence
 * immediately before, if the caret sits in whitespace just after a
 * terminator). Operates on the paragraph-level textblock the caret is in
 * — multi-paragraph sentences aren't really a thing. Returns prosemirror
 * absolute positions.
 */
export function sentenceRangeAt(state: EditorState, pos: number): { from: number; to: number } {
  const $pos = state.doc.resolve(pos);
  const blockStart = $pos.start($pos.depth);
  const blockEnd = $pos.end($pos.depth);
  const text = $pos.parent.textContent;
  const n = text.length;
  if (n === 0) return { from: blockStart, to: blockEnd };

  let i = Math.min($pos.parentOffset, n - 1);
  if (i < 0) i = 0;
  // If sitting on whitespace immediately after a terminator, step back
  // so we land in the previous sentence instead of the next.
  if (i > 0 && /\s/.test(text.charAt(i)) && /[.!?]/.test(text.charAt(i - 1))) {
    i = i - 1;
  }

  // Find start of sentence — scan back for a terminator followed by
  // whitespace, then skip past the whitespace to the next real char.
  let start = 0;
  for (let j = i; j > 0; j--) {
    if (/[.!?]/.test(text.charAt(j - 1)) && /\s/.test(text.charAt(j))) {
      start = j;
      while (start < n && /\s/.test(text.charAt(start))) start++;
      break;
    }
  }
  // Find end of sentence — scan forward for the next terminator.
  let end = n;
  for (let j = Math.max(i, start); j < n; j++) {
    if (/[.!?]/.test(text.charAt(j))) {
      end = j + 1;
      break;
    }
  }

  return { from: blockStart + start, to: blockStart + end };
}
