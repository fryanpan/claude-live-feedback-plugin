import { type Thread, suggestOps, threadRenderKey } from '@feedback/core';
import type { EditorView } from '@tiptap/pm/view';
import { balloonMarginVisible } from '../card-placement.ts';
import { keptComposerFocus, restoreComposerFocus } from '../composer-keep.ts';
import { showToast } from '../doc/chrome-dom.ts';
import { COMPOSER_MOUNTED_EVENT } from '../md-composer.ts';
import type { MountScope } from '../mount-scope.ts';
import type { ReviewChrome } from '../review-chrome.ts';
import { MORPH_MS, isFoldingTap, sizeThreadSlots } from '../thread-morph.ts';
import { createBalloonCards } from './balloon-cards.ts';
import { layoutBalloons } from './balloon-layout.ts';
import {
  type DeletionGroup,
  type RedlineDeletion,
  blockIndexForPos,
  groupDeletions,
} from './live-markup.ts';
import { mountDeletionSheet, mountSuggestionSheet } from './margin-sheets.ts';

// Re-exported for backward compatibility — the grouping algorithm lives in
// live-markup.ts now (it needs to be shared with the mobile chip decoration,
// which is built there), but this module is where callers/tests found it
// first.
export { groupDeletions };
export type { DeletionGroup };

/**
 * The markup margin: Word's balloon column for the redline surface — and,
 * since comment balloons are shared chrome, for plain markdown attachments
 * too (no deletions there; `getDeletions` returns `[]`).
 *
 * Owns a right-hand column next to the prose (`.redline-layout` grid on the
 * editor element — `minmax(0, 1fr) 300px`, the `minmax(0,…)` guarding against
 * the CSS Grid overflow trap in docs/process/learnings.md). Each deletion vs
 * base renders as a balloon (deleted markdown as plain text, clamped to ~6
 * lines with an expand toggle; consecutive deletions in the same paragraph
 * collapse into one balloon). Every OPEN comment thread with a resolvable
 * anchor renders as a balloon too — literally the same card the threads
 * drawer renders (`ThreadPanel.renderThread`, reused rather than
 * reimplemented, so reply/resolve/reopen/re-anchor behave identically
 * everywhere). Deletion and comment balloons share ONE `layoutBalloons` pass
 * sorted by anchor Y, so they stack against each other, not just within type.
 *
 * Anchor Y for a deletion comes from `view.coordsAtPos` on its live-doc
 * position; anchor Y for a comment comes from the live DOM position of its
 * `ThreadDecorations` highlight span (`.thread-range[data-thread-id]` —
 * thread-decorations.ts) — the rendered highlight IS the anchor, so reading
 * its own rect avoids re-deriving position math the decoration plugin
 * already did.
 *
 * Re-layout triggers: editor transactions (the mount forwards them, debounced
 * here — this also covers thread state changes, since posting/resolving/
 * activating a thread dispatches a decorations transaction), window resize,
 * and content-size changes via a ResizeObserver on the ProseMirror element —
 * mermaid diagrams render asynchronously with no completion event, and the
 * SVG landing changes the content height, which the observer sees.
 * Everything registers on the passed MountScope for teardown.
 *
 * Below 1100px the column is hidden via media query and the mobile fallback
 * takes over: each deletion group also renders as a compact "⌫ N lines" chip
 * decoration inline in the prose (built in live-markup.ts, alongside the
 * balloon so both agree on grouping), hidden ≥1100px via CSS the same way the
 * balloon column is hidden ≤1100px. Tapping a chip opens `mountDeletionSheet`
 * below — a bottom sheet built from the SAME DOM/CSS pattern as
 * review-chrome.ts's full-screen thread view (fixed slide-up sheet, drag
 * handle, close button), a distinct instance since it shows plain deleted
 * text rather than a thread. Comments keep review-chrome's existing
 * pill/drawer flow untouched — nothing here changes how a comment is created
 * or read on mobile.
 */

export interface MarkupMarginOpts {
  /** The scrollable editor mount (`#editor`) — becomes the layout grid. */
  editorEl: HTMLElement;
  /** The live ProseMirror view: maps deletion positions to anchor Y
   *  coordinates and paragraph keys. */
  view: EditorView;
  getDeletions: () => RedlineDeletion[];
  /** All threads on the doc (open + resolved) — filtered here to open ones
   *  with a resolvable anchor. Pass `chrome.collectThreads`. Omit (or pass
   *  without `chrome`) to render deletion balloons only. */
  threads?: () => Thread[];
  /** Thread actions for comment balloons — the margin calls into
   *  `chrome.threadsPanel.renderThread` (reply/resolve/reopen/re-anchor,
   *  active-state) rather than reimplementing the card. */
  chrome?: ReviewChrome | null;
  /** All pending suggestions in the doc — pass `() =>
   *  suggestOps.listSuggestions(ydoc)`. Recomputed every relayout, same
   *  pattern as `threads`. Requires `docId` (below) to render Accept/Reject;
   *  omit both to render no suggestion balloons. */
  getSuggestions?: () => suggestOps.SuggestionSummary[];
  /** Doc id for the suggestion accept/reject fetch calls. */
  docId?: string;
  scope: MountScope;
}

export interface MarkupMarginHandle {
  /** Synchronous re-render + re-measure + re-stack. */
  relayout: () => void;
  /** Debounced relayout — wire this to editor transactions. */
  scheduleRelayout: () => void;
  /** The column element — the off-screen hints (`comment-hints.ts`) sit
   *  inside it, sticky to the scroller's edges. */
  marginEl: HTMLElement;
  /**
   * Scroll a thread's balloon into view and pulse it — the balloon-side half
   * of "click an anchored range, see its comment" (the editor-side click
   * already highlights via `refreshThreadDecorations`). Returns false when
   * the thread has no rendered balloon (resolved, orphaned, or the column is
   * hidden below 1100px) so the caller can fall back to the drawer.
   */
  revealThreadBalloon: (id: string) => boolean;
}

const GAP = 8;
const RELAYOUT_DEBOUNCE_MS = 100;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Is the margin actually on screen? `rendered[]` is populated regardless of
 *  the surface in force, so anything answering "is this balloon visible?" must
 *  consult the placement, not the DOM. It used to mirror a `max-width` query
 *  the stylesheet also carried; both now read `card-placement.ts`, so the
 *  reader's stored choice moves the column and this check together. */
function marginHidden(): boolean {
  return !balloonMarginVisible();
}

/** `CSS.escape` guarded — happy-dom (and very old browsers) may not have it. */
function cssEscape(id: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
}

interface RenderedDelBalloon {
  kind: 'del';
  key: string;
  group: DeletionGroup;
  el: HTMLElement;
}

interface RenderedCommentBalloon {
  kind: 'comment';
  key: string;
  thread: Thread;
  el: HTMLElement;
}

interface RenderedSuggestionBalloon {
  kind: 'suggestion';
  key: string;
  summary: suggestOps.SuggestionSummary;
  el: HTMLElement;
}

type RenderedBalloon = RenderedDelBalloon | RenderedCommentBalloon | RenderedSuggestionBalloon;

export function mountMarkupMargin(opts: MarkupMarginOpts): MarkupMarginHandle {
  const { editorEl, view, getDeletions, scope } = opts;

  // The card builders take no state — see balloon-cards.ts. They come back as
  // a set because the margin renders four faces and the phone sheet renders a
  // fifth from the same builder.
  const {
    buildSuggestionBalloon,
    buildCollapsedSuggestion,
    buildDelBalloon,
    buildCollapsedDel,
    addCollapseButton,
  } = createBalloonCards({ resolveSuggestion });

  editorEl.classList.add('redline-layout');

  const marginEl = document.createElement('div');
  marginEl.className = 'markup-margin';
  editorEl.appendChild(marginEl);

  const overlay = document.createElementNS(SVG_NS, 'svg');
  overlay.setAttribute('class', 'cw-leader-overlay');
  overlay.setAttribute('aria-hidden', 'true');
  editorEl.appendChild(overlay);

  let rendered: RenderedBalloon[] = [];

  /**
   * Word-style collapsed balloons: every balloon renders as a one-line
   * summary until clicked; at most ONE is expanded at a time (expanding
   * another collapses the current one). Keyed by stable identity —
   * `c:<threadId>` / `s:<sid>` / `d:<blockKey>` — so the expanded card
   * survives rebuilds triggered by unrelated edits.
   */
  let expandedKey: string | null = null;
  const isExpanded = (k: string): boolean => expandedKey === k;

  /**
   * A COMMENT balloon's expand state is not kept here — it is the drawer's
   * active thread, and nothing else.
   *
   * The margin balloon and the drawer row are literally the same card, so two
   * separate authorities would let a drawer click leave the balloon folded
   * (or vice versa) and, worse, would put `expanded` back in the render key —
   * which rebuilds the card, and a rebuilt node cannot morph. `expandedKey`
   * still owns deletions and suggestions, which have no drawer counterpart.
   */
  const commentExpanded = (id: string): boolean => opts.chrome?.threadsPanel.getActive() === id;

  function expandBalloon(key: string): void {
    if (key.startsWith('c:')) {
      // One card open at a time across all three kinds: a comment opening
      // folds any expanded deletion/suggestion back down.
      if (expandedKey) {
        expandedKey = null;
        relayout();
      }
      const id = key.slice(2);
      // setActive folds the card in place (no rebuild) on every copy, and
      // carries the anchor highlight with it.
      opts.chrome?.threadsPanel.setActive(id);
      // Heights change over the next 150ms without a rebuild, so the column
      // has to restack all the way through the fold — not once, at the start.
      restackThroughMorph();
      return;
    }
    expandedKey = key;
    // …and symmetrically, a deletion/suggestion opening folds the comment.
    opts.chrome?.threadsPanel.setActive(null);
    relayout();
  }

  const blockKeyForPos = (pos: number): number => blockIndexForPos(view.state.doc, pos);

  // Mobile fallback: the chip decoration (live-markup.ts) is grouped and
  // built inside the editor's own decorations; this margin only owns what
  // happens when one is tapped — a small bottom sheet showing the deleted
  // text, built once per mount and reused across taps.
  const deletionSheet = mountDeletionSheet(scope);
  scope.listen(editorEl, 'click', (ev) => {
    const chip = (ev.target as HTMLElement).closest?.('.cw-del-chip');
    if (!chip) return;
    ev.preventDefault();
    deletionSheet.open((chip as HTMLElement).dataset.lfDelText ?? '');
  });

  // Mobile fallback for suggestions: same pattern, a distinct sheet (the
  // deletion sheet shows plain text; this one shows the full accept/reject
  // card — see mountSuggestionSheet above).
  const suggestionSheet = mountSuggestionSheet(scope, buildSuggestionBalloon);
  scope.listen(editorEl, 'click', (ev) => {
    const chip = (ev.target as HTMLElement).closest?.('.cw-suggest-chip');
    if (!chip) return;
    ev.preventDefault();
    const sid = (chip as HTMLElement).dataset.lfSuggestSid ?? '';
    const summary = eligibleSuggestions().find((s) => s.sid === sid);
    if (summary) suggestionSheet.open(summary);
  });

  /** A suggestion's live-doc anchor + reveal target — the mark's own
   *  rendered span already carries `data-sid` (suggest-marks.ts), so no
   *  separate position bookkeeping is needed (mirrors `threadSpan` below). A
   *  "replace" proposal has two spans (del + ins) sharing one sid; either is
   *  fine as the anchor/reveal target — `querySelector` returns the first. */
  function suggestionSpan(sid: string): Element | null {
    return view.dom.querySelector(`[data-sid="${cssEscape(sid)}"]`);
  }

  /** Pending proposals with a resolvable anchor, minus ones this client has
   *  already optimistically resolved (see `resolveSuggestion`) — a real
   *  accept/reject also removes the mark from the doc, which would drop the
   *  sid here on its own once Yjs sync lands; the local set just makes the
   *  card disappear immediately instead of waiting for the round trip (and
   *  covers the case where the server call actually failed). */
  const dismissedSids = new Set<string>();
  function eligibleSuggestions(): suggestOps.SuggestionSummary[] {
    if (!opts.getSuggestions || !opts.docId) return [];
    return opts
      .getSuggestions()
      .filter((s) => !dismissedSids.has(s.sid) && suggestionSpan(s.sid) != null);
  }

  async function resolveSuggestion(sid: string, action: 'accept' | 'reject'): Promise<void> {
    const docId = opts.docId;
    if (!docId) return;
    // Optimistic: the card disappears on click, not on the round trip —
    // both because that's the responsive thing to do, and because it's the
    // only way to make a `{ ok:false, error:'not-found' }` response (someone
    // else already resolved it) actually clear the stale card, since the
    // server made no doc change for THIS client to sync.
    dismissedSids.add(sid);
    suggestionSheet.closeIfShowing(sid);
    relayout();
    try {
      const res = await fetch(
        `/api/docs/${encodeURIComponent(docId)}/suggestions/${encodeURIComponent(sid)}/${action}`,
        { method: 'POST' },
      );
      if (!res.ok) {
        showToast('That suggestion is no longer available');
        return;
      }
      showToast(action === 'accept' ? '✓ Suggestion accepted' : '✓ Suggestion rejected');
    } catch {
      showToast(`Failed to ${action} — try again`);
    }
  }

  /** A thread's live-doc anchor position, from its own rendered highlight —
   *  the ThreadDecorations plugin already stamped `data-thread-id` on the
   *  span it decorated (thread-decorations.ts). Absent for resolved/orphaned
   *  threads, which don't get a decoration span at all. */
  function threadSpan(id: string): Element | null {
    return view.dom.querySelector(`.thread-range[data-thread-id="${cssEscape(id)}"]`);
  }

  /** Threads with a resolvable, currently-decorated anchor. Resolved ones
   *  render too, folded to a faded line (approved: comments mock 3) — the
   *  tick on the sentence needs a card to land on; orphaned threads have no
   *  anchor and nowhere to sit. */
  function eligibleThreads(): Thread[] {
    if (!opts.threads || !opts.chrome) return [];
    return opts.threads().filter((t) => threadSpan(t.id) != null);
  }

  function buildCommentBalloon(thread: Thread, pendingReply?: string): HTMLElement {
    // Reuse the drawer's own card verbatim — reply/resolve/reopen/re-anchor
    // are ITS click handlers dispatching to the chrome's fetch calls, not a
    // second implementation. Positioning classes are additive.
    const el = opts.chrome?.threadsPanel.renderThread(thread, pendingReply);
    if (!el) throw new Error('buildCommentBalloon requires opts.chrome');
    el.classList.add('cw-balloon', 'cw-balloon-comment');
    // This is the ONLY comment builder: collapsed and expanded are the same
    // node in two states, because the morph cross-fades between two faces
    // that must both already exist. `renderThread` has already put the card
    // in the right state — the drawer's active thread is the expand state.
    return el;
  }

  /** Rebuild the balloon list only when the underlying data actually
   *  changed, so expand/reply state and DOM focus survive relayouts
   *  triggered by unrelated activity (typing elsewhere in the doc dispatches
   *  a transaction on every keystroke). */
  function renderBalloons(
    delGroups: DeletionGroup[],
    openThreads: Thread[],
    suggestions: suggestOps.SuggestionSummary[],
  ): void {
    // Expanded state is part of the render key for deletions and suggestions,
    // which still swap between two builders, so toggling rebuilds those cards.
    const delKeys = delGroups.map(
      (g) => `del|${g.blockKey}|${g.deletedMarkdown}|${isExpanded(`d:${g.blockKey}`)}`,
    );
    // A comment balloon IS the drawer's card, so it memoizes off the drawer's
    // key — `threadRenderKey` carries everything the card displays, including
    // the two things that move without touching a count or a clock: a
    // generated summary landing, and an answer being stamped or taken back.
    //
    // Deliberately ABSENT: expanded/active. A comment card folds in place, so
    // a rebuild on expand would destroy the very node the morph is animating.
    // The key carries what the card DISPLAYS and not what it merely animates.
    const commentKeys = openThreads.map((t) => `comment|${threadRenderKey(t)}`);
    const suggestionKeys = suggestions.map(
      (s) => `suggest|${s.sid}|${s.kind}|${isExpanded(`s:${s.sid}`)}`,
    );
    const keys = [...delKeys, ...commentKeys, ...suggestionKeys];
    if (keys.length === rendered.length && keys.every((k, i) => k === rendered[i].key)) {
      // Nothing display-relevant changed — refresh the live refs (an anchor
      // position may have moved) without touching any DOM. Both kinds that
      // hold one: a retained `thread` object goes stale exactly as a `group`
      // does, and anything reading `r.thread` later would get old data.
      let di = 0;
      let ci = 0;
      for (const r of rendered) {
        if (r.kind === 'del') r.group = delGroups[di++];
        else if (r.kind === 'comment') r.thread = openThreads[ci++] ?? r.thread;
      }
      return;
    }

    // Preserve in-progress reply drafts across the rebuild — the same trick
    // ThreadPanel.render() uses for the drawer, needed here because the
    // margin can rebuild far more often (any editor transaction).
    const pendingReplies = new Map<string, string>();
    for (const r of rendered) {
      if (r.kind !== 'comment') continue;
      const ta = r.el.querySelector<HTMLTextAreaElement>('textarea');
      if (ta?.value) pendingReplies.set(r.thread.id, ta.value);
    }
    // …and the caret with them: a peer's reply landing on ANY thread rebuilds
    // every balloon, and losing focus mid-word dismisses the iPad keyboard
    // and yanks the viewport with it.
    const keptFocus = keptComposerFocus(marginEl);

    // Only the balloons go — the off-screen hints live in this column too
    // and must survive every rebuild.
    for (const r of rendered) r.el.remove();
    const nextDel: RenderedDelBalloon[] = delGroups.map((group, i) => {
      const expanded = isExpanded(`d:${group.blockKey}`);
      const el = expanded ? buildDelBalloon(group) : buildCollapsedDel(group);
      if (expanded) addCollapseButton(el);
      marginEl.appendChild(el);
      return { kind: 'del', key: delKeys[i], group, el };
    });
    const nextComments: RenderedCommentBalloon[] = openThreads.map((thread, i) => {
      // No collapse button: the whole card is the tap target now, and
      // `✓ Resolve` is the only control in the footer.
      const el = buildCommentBalloon(thread, pendingReplies.get(thread.id));
      marginEl.appendChild(el);
      return { kind: 'comment', key: commentKeys[i], thread, el };
    });
    const nextSuggestions: RenderedSuggestionBalloon[] = suggestions.map((summary, i) => {
      const expanded = isExpanded(`s:${summary.sid}`);
      const el = expanded ? buildSuggestionBalloon(summary) : buildCollapsedSuggestion(summary);
      if (expanded) addCollapseButton(el);
      marginEl.appendChild(el);
      return { kind: 'suggestion', key: suggestionKeys[i], summary, el };
    });
    rendered = [...nextDel, ...nextComments, ...nextSuggestions];
    // A card's folding slots have no intrinsic height — measure them now the
    // balloons are in the document, BEFORE layoutBalloons reads `offsetHeight`
    // off the cards, or every comment balloon stacks as a header and a footer.
    sizeThreadSlots(marginEl);
    if (keptFocus) restoreComposerFocus(marginEl, keptFocus);
  }

  /** Y of a client-rect top in the editor's scrolled content space. */
  function contentY(clientTop: number, editorRect: DOMRect): number {
    return clientTop - editorRect.top + editorEl.scrollTop;
  }

  /**
   * Content-space floor keeping balloons clear of the floating view toggle.
   * `body.diff-mode #view-toggle` is absolutely positioned over the editor
   * pane's top-right at z-index 5 (opaque, non-scrolling) — exactly where
   * the margin column's grid track starts — so a balloon anchored at the top
   * of the doc would render underneath it. Measured live (not hardcoded) so
   * format-bar height and toggle wrapping can't drift out of sync. The
   * clearance is viewport-relative to the editor's top, which equals content
   * space at scroll-top — the only scroll position where the floor matters;
   * scrolled content passing under the pill is normal floating-control UX.
   */
  function toggleClearanceY(editorRect: DOMRect): number {
    const toggle = document.getElementById('view-toggle');
    if (!toggle || toggle.classList.contains('hidden')) return 0;
    const r = toggle.getBoundingClientRect();
    if (r.height === 0 || r.bottom <= editorRect.top) return 0;
    return r.bottom - editorRect.top + GAP;
  }

  function positionBalloons(): void {
    const editorRect = editorEl.getBoundingClientRect();
    const marginRect = marginEl.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const proseRect = view.dom.getBoundingClientRect();
    const marginOffsetY = contentY(marginRect.top, editorRect);
    const doc = view.state.doc;

    const items = rendered.map((b) => {
      let anchorY = 0;
      try {
        if (b.kind === 'del') {
          const pos = Math.max(0, Math.min(b.group.pos, doc.content.size));
          anchorY = contentY(view.coordsAtPos(pos).top, editorRect);
        } else if (b.kind === 'comment') {
          const span = threadSpan(b.thread.id);
          if (span) anchorY = contentY(span.getBoundingClientRect().top, editorRect);
        } else {
          const span = suggestionSpan(b.summary.sid);
          if (span) anchorY = contentY(span.getBoundingClientRect().top, editorRect);
        }
      } catch {
        // happy-dom / positions without layout info — stack from the top.
      }
      return { anchorY: Math.max(0, anchorY), height: b.el.offsetHeight };
    });
    // Floor stacking positions below the floating toggle, but keep the TRUE
    // anchor for the leader lines — the line should still point at the
    // deletion/highlight, only the card slides down. max() is monotonic, so
    // the anchor-sorted stacking order is preserved.
    const minY = toggleClearanceY(editorRect);
    // Fit-to-fold: a balloon anchored low in the visible viewport lifts so
    // its footer (the composer and its Answer button) stays reachable without
    // scrolling the document — the CSS height clamp bounds the card, this
    // bounds its position. clientHeight of 0 means no real layout (tests,
    // hidden pane): skip the bound rather than fit to a degenerate viewport.
    const viewport =
      editorEl.clientHeight > 0
        ? {
            top: Math.max(editorEl.scrollTop, minY),
            bottom: editorEl.scrollTop + editorEl.clientHeight - GAP,
          }
        : undefined;
    const ys = layoutBalloons(
      items.map((it) => ({ anchorY: Math.max(minY, it.anchorY), height: it.height })),
      GAP,
      viewport,
    );

    // Size the overlay to the scrolled content so lines aren't clipped.
    overlay.setAttribute('width', String(Math.max(0, editorEl.scrollWidth)));
    overlay.setAttribute('height', String(Math.max(0, editorEl.scrollHeight)));
    overlay.textContent = '';
    const overlayOffsetY = contentY(overlayRect.top, editorRect);
    const overlayOffsetX = overlayRect.left - editorRect.left;
    const anchorX = proseRect.right - editorRect.left - overlayOffsetX;
    const balloonX = marginRect.left - editorRect.left - overlayOffsetX + 4;

    // Which thread the reader is on, if any — the panel's selection, which is
    // the one authority for it (a balloon promoted into the modal stays folded
    // and SELECTED, so this is not the same question as "which is expanded").
    const selectedId = opts.chrome?.threadsPanel.getActive() ?? null;

    let maxBottom = 0;
    for (let i = 0; i < rendered.length; i++) {
      const y = Math.max(0, ys[i]);
      rendered[i].el.style.top = `${y - marginOffsetY}px`;
      maxBottom = Math.max(maxBottom, y + items[i].height);

      const leaderKind = rendered[i].kind;
      const line = document.createElementNS(SVG_NS, 'line');
      const classes =
        leaderKind === 'comment'
          ? ['cw-leader', 'cw-leader-comment']
          : leaderKind === 'suggestion'
            ? ['cw-leader', 'cw-leader-suggestion']
            : ['cw-leader'];
      // Word's rule: tapping a balloon brings it forward and pushes the rest
      // back, and its leader comes with it. The CARDS dim in CSS (the margin
      // reads `:has(.thread.active)`), but a line in a detached SVG overlay
      // has no ancestor that knows which thread is selected — so the emphasis
      // is written here, on the pass that draws them.
      const b = rendered[i];
      if (selectedId !== null && b.kind === 'comment') {
        classes.push(b.thread.id === selectedId ? 'cw-leader-on' : 'cw-leader-dim');
      }
      line.setAttribute('class', classes.join(' '));
      // The visible leg starts where the PROSE ends, never inside it: `anchorX`
      // is the right edge of `view.dom`, so a connector runs out of the text
      // block and across the gutter rather than over a word. The one geometry
      // rule this column has, and the reason the line is straight.
      line.setAttribute('x1', String(anchorX));
      line.setAttribute('y1', String(items[i].anchorY - overlayOffsetY));
      line.setAttribute('x2', String(balloonX));
      line.setAttribute('y2', String(y - overlayOffsetY + 12));
      overlay.appendChild(line);
    }
    // Balloons are absolutely positioned and add no flow height; stretch the
    // margin so the shared scroll container reaches the last balloon.
    marginEl.style.minHeight = `${Math.max(0, maxBottom - marginOffsetY)}px`;
  }

  function relayout(): void {
    if (scope.disposed) return;
    renderBalloons(
      groupDeletions(getDeletions(), blockKeyForPos),
      eligibleThreads(),
      eligibleSuggestions(),
    );
    positionBalloons();
  }

  function revealThreadBalloon(id: string): boolean {
    // Below the breakpoint the column is display:none — the balloon exists
    // in `rendered[]` but the user can't see it, and a silent scrollIntoView
    // no-op would eat the caller's drawer/thread-view fallback (the 901–
    // 1100px gap is a real iPad-portrait width, not an edge case).
    if (marginHidden()) return false;
    let found = rendered.find(
      (r): r is RenderedCommentBalloon => r.kind === 'comment' && r.thread.id === id,
    );
    if (!found) return false;
    // Revealing means engaging — expand the balloon. The card folds in place,
    // but a deletion/suggestion giving up the open slot still rebuilds
    // `rendered`, so re-find the element before scrolling to it.
    if (!commentExpanded(id)) {
      expandBalloon(`c:${id}`);
      found =
        rendered.find(
          (r): r is RenderedCommentBalloon => r.kind === 'comment' && r.thread.id === id,
        ) ?? found;
    }
    try {
      found.el.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    } catch {
      // scrollIntoView can throw in some test/embedded environments — the
      // highlight in the editor already happened, this is a nice-to-have.
    }
    return true;
  }

  /**
   * Restack the column for the whole 150ms a card takes to fold.
   *
   * `positionBalloons` measures `el.offsetHeight`, and while the morph runs
   * that is the height a Web Animation is INTERPOLATING — a WAAPI `height`
   * animation overrides the inline height the morph engine wrote, so a single
   * pass at t=0 stacks the column against the height the card is LEAVING and
   * nothing ever corrects it: an expanded balloon overlaps the one below it,
   * a collapsed one leaves a permanent gap. (The debounced relayout the
   * decoration transaction schedules lands at 100ms, still mid-morph, so it
   * is not the missing pass either.) One frame at a time so the balloons below
   * travel with the card, and one final pass a tick after the animation is
   * over, when the slot reports its resting height again.
   */
  let morphRaf: number | null = null;
  let morphTimer: ReturnType<typeof setTimeout> | null = null;
  function stopMorphRestack(): void {
    if (morphRaf != null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(morphRaf);
    }
    morphRaf = null;
    if (morphTimer != null) clearTimeout(morphTimer);
    morphTimer = null;
  }
  function restackThroughMorph(): void {
    positionBalloons();
    stopMorphRestack();
    const step = (): void => {
      morphRaf = null;
      if (scope.disposed) return;
      positionBalloons();
      if (typeof requestAnimationFrame === 'function') morphRaf = requestAnimationFrame(step);
    };
    if (typeof requestAnimationFrame === 'function') morphRaf = requestAnimationFrame(step);
    morphTimer = setTimeout(() => {
      morphTimer = null;
      stopMorphRestack();
      if (!scope.disposed) positionBalloons();
    }, MORPH_MS + 1);
  }
  scope.onCleanup(stopMorphRestack);

  let timer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRelayout(): void {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      relayout();
    }, RELAYOUT_DEBOUNCE_MS);
  }

  // Balloon expand/collapse (the Word-style one-at-a-time state) via one
  // delegated listener — balloons rebuild on content changes, so per-balloon
  // listeners would leak or vanish.
  scope.listen(marginEl, 'click', (ev) => {
    const target = ev.target as HTMLElement;
    // A comment card toggles ITSELF — the card's own handler (the whole card
    // is the tap target) has already folded every copy in place by the time
    // this bubbles up. All the column owes it is a restack: a card that just
    // grew or shrank moves every card below it.
    if (target.closest?.('.cw-balloon-comment')) {
      // …but only when the tap actually folded something. The same exclusion
      // list the card itself uses, shared rather than copied.
      if (!isFoldingTap(target)) return;
      if (expandedKey) {
        // The comment took the one open slot from a deletion/suggestion.
        expandedKey = null;
        relayout();
      }
      // The card is mid-fold: its height is being interpolated for the next
      // 150ms, so one pass now would stack the column against the height it
      // is leaving.
      restackThroughMorph();
      return;
    }
    if (target.closest?.('.cw-balloon-collapse')) {
      expandedKey = null;
      relayout();
      return;
    }
    const collapsed = target.closest?.('.cw-balloon-collapsed') as HTMLElement | null;
    if (!collapsed) return;
    // The compact ✓/✕ on a collapsed suggestion act without expanding.
    if (target.closest('button')) return;
    const key = collapsed.dataset.expandKey;
    if (key) expandBalloon(key);
  });

  // "Show more" toggle inside an expanded deletion balloon (text clamp).
  scope.listen(marginEl, 'click', (ev) => {
    const toggle = (ev.target as HTMLElement).closest?.('.cw-balloon-expand');
    if (!toggle) return;
    const balloon = toggle.closest('.cw-balloon');
    const text = balloon?.querySelector('.cw-balloon-text');
    if (!balloon || !text) return;
    const expanded = balloon.classList.toggle('is-expanded');
    text.classList.toggle('is-clamped', !expanded);
    toggle.textContent = expanded ? 'Show less' : 'Show more';
    positionBalloons(); // heights changed — restack without rebuilding
  });

  // A reply composer's editor chunk mounts in a microtask, AFTER this column
  // measured the card it lives in: the detail face grows under a written slot
  // height and `overflow: hidden` eats the reply box. Re-measure the subtree
  // and restack — the cards below the grown one all move.
  scope.listen(marginEl, COMPOSER_MOUNTED_EVENT, () => {
    sizeThreadSlots(marginEl);
    restackThroughMorph();
  });

  scope.listen(window, 'resize', scheduleRelayout);

  // The fit-to-fold bound moves with the scroll position, and nothing else
  // re-runs on scroll — restack (positions only, no rebuild, so drafts and
  // focus are untouched) once scrolling settles, or a balloon whose anchor
  // sits low in the NEW viewport is right back under the fold.
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  scope.listen(editorEl, 'scroll', () => {
    if (scrollTimer != null) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      if (!scope.disposed) positionBalloons();
    }, RELAYOUT_DEBOUNCE_MS);
  });
  scope.onCleanup(() => {
    if (scrollTimer != null) clearTimeout(scrollTimer);
    scrollTimer = null;
  });

  // Mermaid renders complete asynchronously with no event; the injected SVG
  // resizes the prose element, which this observer sees (and it doubles as
  // the catch-all for images/fonts landing late).
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(scheduleRelayout);
    ro.observe(view.dom);
    scope.onCleanup(() => ro.disconnect());
  }

  scope.onCleanup(() => {
    if (timer != null) clearTimeout(timer);
    timer = null;
    overlay.remove();
    marginEl.remove();
    editorEl.classList.remove('redline-layout');
  });

  relayout();
  return { marginEl, relayout, scheduleRelayout, revealThreadBalloon };
}
