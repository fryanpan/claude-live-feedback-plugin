/**
 * The margin phase of a markdown document's boot: everything that reports on
 * comments the reader is not looking at.
 *
 * Three mounts and one jump, together because they are one loop. The balloon
 * margin draws the cards; the suggestions summary counts what is pending
 * across the doc; the comment hints say how many threads sit above and below
 * the fold — and all three have to be told again after every editor
 * transaction, which is the single `transaction` listener at the end.
 *
 * `jumpToThread` is here rather than at the call site because it is the one
 * behaviour the three share: a tap on a hint has to land on the card wherever
 * that card currently lives (a balloon in the margin, the mobile inline list,
 * the modal, or the desktop drawer), and only this module knows all four.
 */
import { suggestOps } from '@feedback/core';
import type * as Y from 'yjs';
import { balloonMarginVisible } from '../card-placement.ts';
import { mountCommentHints } from '../comment-hints.ts';
import type { EditorHandle } from '../editor.ts';
import type { MountScope } from '../mount-scope.ts';
import { type MarkupMarginHandle, mountMarkupMargin } from '../redline/markup-margin.ts';
import type { ReviewChrome } from '../review-chrome.ts';
import { mountSuggestionsSummary } from '../suggestions/suggestions-summary.ts';
import { threadCards } from '../thread-morph.ts';

export interface DocMarginOptions {
  docId: string;
  ydoc: Y.Doc;
  scope: MountScope;
  editor: EditorHandle;
  /** The `#editor` element — the scroll container the hints measure against. */
  editorMount: HTMLElement;
  chrome: ReviewChrome;
}

export interface DocMarginHandle {
  /** Scroll a thread's balloon into view; false when it has none. */
  revealThreadBalloon: (id: string) => boolean;
  /** Re-run the balloon layout — after a seen-state change, say. */
  scheduleRelayout: () => void;
}

export function mountDocMargin(opts: DocMarginOptions): DocMarginHandle {
  const { docId, ydoc, scope, editor, editorMount, chrome } = opts;

  // The balloon margin: plain markdown docs get comment balloons only (no
  // git base, so no deletions) — reuses the same mount as the redline
  // surface, which is why comment balloons behave identically everywhere.
  // Mounted unconditionally; the `#editor.redline-layout` grid and the
  // `.markup-margin` column both collapse via CSS below 1100px, so this
  // never introduces horizontal scroll on mobile.
  const margin: MarkupMarginHandle = mountMarkupMargin({
    editorEl: editorMount,
    view: editor.editor.view,
    getDeletions: () => [],
    threads: () => chrome.collectThreads(),
    chrome,
    getSuggestions: () => suggestOps.listSuggestions(ydoc),
    docId,
    scope,
  });
  // Doc-level "N pending suggestions" topbar badge (Accept all / Reject all
  // across every author) — per-suggestion Accept/Reject lives on the
  // balloon/chip card the margin just wired above.
  const suggestionsSummary = mountSuggestionsSummary({ docId, ydoc, scope });
  // Off-screen comment counts + the "N waiting on you" chip — the
  // information scent for what the reader cannot see (comment-hints.ts).
  // Jumping goes the same route a tap on the highlight takes: scroll, pulse,
  // and open the card where it lives (balloon above 1100px, inline below).
  const spanFor = (id: string): HTMLElement | null =>
    editor.editor.view.dom.querySelector<HTMLElement>(
      `.thread-range[data-thread-id="${CSS.escape(id)}"]`,
    );
  const jumpToThread = (id: string): void => {
    chrome.refreshThreadDecorations(id);
    const range = chrome.resolveThreadRange(id);
    if (range) {
      editor.scrollToPos(range.from);
      editor.pulseRange(range.from, range.to);
    }
    // A jump from an off-screen hint lands the SENTENCE a third of the way
    // down, not merely inside the edge: the editor's own scrollIntoView is
    // minimal, and a sentence a few pixels above the fold stays hidden
    // behind the hint that was tapped to reach it.
    const span = spanFor(id);
    if (span) {
      const r = span.getBoundingClientRect();
      const s = editorMount.getBoundingClientRect();
      editorMount.scrollTop += r.top - s.top - s.height * 0.35;
    }
    if (chrome.openInModal(id)) return;
    if (margin.revealThreadBalloon(id)) return;
    if (chrome.isMobile() || chrome.mobile.inlineThreads().some((t) => t.id === id)) {
      chrome.mobile.showThread(id);
      return;
    }
    chrome.revealThread(id);
  };
  const hints = mountCommentHints({
    scroller: editorMount,
    marginEl: margin.marginEl,
    floatParent:
      editorMount.closest<HTMLElement>('#editor-pane') ??
      editorMount.parentElement ??
      document.body,
    chipEl: document.getElementById('doc-asks'),
    threads: () => chrome.collectThreads(),
    spanFor,
    cardsFor: (id) => threadCards(id),
    isNew: (t) => chrome.seen.isNew(t),
    markSeen: (t) => chrome.markSeen(t.id),
    onSeen: () => margin.scheduleRelayout(),
    onJump: jumpToThread,
    dockEl: () => document.querySelector<HTMLElement>('#editor-pane .plan-float'),
    marginVisible: balloonMarginVisible,
    scope,
  });
  const onMarginTransaction = (): void => {
    margin.scheduleRelayout();
    suggestionsSummary.scheduleRefresh();
    hints.refresh();
  };
  editor.editor.on('transaction', onMarginTransaction);
  scope.onCleanup(() => editor.editor.off('transaction', onMarginTransaction));

  return {
    revealThreadBalloon: (id) => margin.revealThreadBalloon(id),
    scheduleRelayout: () => margin.scheduleRelayout(),
  };
}
