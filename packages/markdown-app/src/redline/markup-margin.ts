import type { Thread } from '@feedback/core';
import type { EditorView } from '@tiptap/pm/view';
import type { MountScope } from '../mount-scope.ts';
import type { ReviewChrome } from '../review-chrome.ts';
import { layoutBalloons } from './balloon-layout.ts';
import type { RedlineDeletion } from './live-markup.ts';

/**
 * The markup margin: Word's balloon column for the redline surface — and,
 * since comment balloons are shared chrome, for plain markdown review docs
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
 * Below 1100px the column is hidden via media query (the mobile treatment —
 * inline chips + drawer — is a separate commit).
 */

export interface DeletionGroup {
  /** Live-doc position of the group's first deletion. */
  pos: number;
  /** Top-level block index the group anchors in (grouping key). */
  blockKey: number;
  deletedMarkdown: string;
}

/**
 * Collapse consecutive deletions that anchor in the same top-level block into
 * one group, joining their markdown line-by-line. Pure — the caller supplies
 * the pos→block mapping.
 */
export function groupDeletions(
  deletions: RedlineDeletion[],
  blockKeyForPos: (pos: number) => number,
): DeletionGroup[] {
  const groups: DeletionGroup[] = [];
  for (const d of deletions) {
    const blockKey = blockKeyForPos(d.pos);
    const last = groups[groups.length - 1];
    if (last && last.blockKey === blockKey) {
      last.deletedMarkdown += `\n${d.deletedMarkdown}`;
    } else {
      groups.push({ pos: d.pos, blockKey, deletedMarkdown: d.deletedMarkdown });
    }
  }
  return groups;
}

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
  scope: MountScope;
}

export interface MarkupMarginHandle {
  /** Synchronous re-render + re-measure + re-stack. */
  relayout: () => void;
  /** Debounced relayout — wire this to editor transactions. */
  scheduleRelayout: () => void;
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
const CLAMP_LINES = 6;
const CLAMP_CHARS = 480;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Long enough to clamp? Text-based so the decision is testable without
 *  layout; the CSS line-clamp does the visual truncation. */
function needsClamp(md: string): boolean {
  return md.split('\n').length > CLAMP_LINES || md.length > CLAMP_CHARS;
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

type RenderedBalloon = RenderedDelBalloon | RenderedCommentBalloon;

export function mountMarkupMargin(opts: MarkupMarginOpts): MarkupMarginHandle {
  const { editorEl, view, getDeletions, scope } = opts;

  editorEl.classList.add('redline-layout');

  const marginEl = document.createElement('div');
  marginEl.className = 'markup-margin';
  editorEl.appendChild(marginEl);

  const overlay = document.createElementNS(SVG_NS, 'svg');
  overlay.setAttribute('class', 'lf-leader-overlay');
  overlay.setAttribute('aria-hidden', 'true');
  editorEl.appendChild(overlay);

  let rendered: RenderedBalloon[] = [];

  const blockKeyForPos = (pos: number): number => {
    const doc = view.state.doc;
    const p = Math.max(0, Math.min(pos, doc.content.size));
    return doc.resolve(p).index(0);
  };

  function buildDelBalloon(group: DeletionGroup): HTMLElement {
    const el = document.createElement('div');
    el.className = 'lf-balloon lf-balloon-del';
    const label = document.createElement('div');
    label.className = 'lf-balloon-label';
    label.textContent = 'Deleted';
    el.appendChild(label);
    const text = document.createElement('div');
    text.className = 'lf-balloon-text';
    // Plain text, never HTML: deleted markdown is untrusted doc content.
    text.textContent = group.deletedMarkdown;
    el.appendChild(text);
    if (needsClamp(group.deletedMarkdown)) {
      text.classList.add('is-clamped');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'lf-balloon-expand';
      toggle.textContent = 'Show more';
      el.appendChild(toggle);
    }
    return el;
  }

  /** A thread's live-doc anchor position, from its own rendered highlight —
   *  the ThreadDecorations plugin already stamped `data-thread-id` on the
   *  span it decorated (thread-decorations.ts). Absent for resolved/orphaned
   *  threads, which don't get a decoration span at all. */
  function threadSpan(id: string): Element | null {
    return view.dom.querySelector(`.thread-range[data-thread-id="${cssEscape(id)}"]`);
  }

  /** Open threads with a resolvable, currently-decorated anchor — resolved
   *  and orphaned threads have nowhere to anchor a balloon. */
  function eligibleThreads(): Thread[] {
    if (!opts.threads || !opts.chrome) return [];
    return opts.threads().filter((t) => t.status === 'open' && threadSpan(t.id) != null);
  }

  function buildCommentBalloon(thread: Thread, pendingReply?: string): HTMLElement {
    // Reuse the drawer's own card verbatim — reply/resolve/reopen/re-anchor
    // are ITS click handlers dispatching to the chrome's fetch calls, not a
    // second implementation. Positioning classes are additive.
    const el = opts.chrome?.threadsPanel.renderThread(thread, pendingReply);
    if (!el) throw new Error('buildCommentBalloon requires opts.chrome');
    el.classList.add('lf-balloon', 'lf-balloon-comment');
    return el;
  }

  /** Rebuild the balloon list only when the underlying data actually
   *  changed, so expand/reply state and DOM focus survive relayouts
   *  triggered by unrelated activity (typing elsewhere in the doc dispatches
   *  a transaction on every keystroke). */
  function renderBalloons(delGroups: DeletionGroup[], openThreads: Thread[]): void {
    const activeId = opts.chrome?.threadsPanel.getActive() ?? null;
    const delKeys = delGroups.map((g) => `del|${g.blockKey}|${g.deletedMarkdown}`);
    const commentKeys = openThreads.map(
      (t) => `comment|${t.id}|${t.status}|${t.commentCount}|${t.lastActivity}|${activeId === t.id}`,
    );
    const keys = [...delKeys, ...commentKeys];
    if (keys.length === rendered.length && keys.every((k, i) => k === rendered[i].key)) {
      // Nothing display-relevant changed — refresh the live group refs
      // (anchor position may have moved) without touching any DOM.
      let di = 0;
      for (const r of rendered) {
        if (r.kind === 'del') r.group = delGroups[di++];
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

    marginEl.textContent = '';
    const nextDel: RenderedDelBalloon[] = delGroups.map((group, i) => {
      const el = buildDelBalloon(group);
      marginEl.appendChild(el);
      return { kind: 'del', key: delKeys[i], group, el };
    });
    const nextComments: RenderedCommentBalloon[] = openThreads.map((thread, i) => {
      const el = buildCommentBalloon(thread, pendingReplies.get(thread.id));
      marginEl.appendChild(el);
      return { kind: 'comment', key: commentKeys[i], thread, el };
    });
    rendered = [...nextDel, ...nextComments];
  }

  /** Y of a client-rect top in the editor's scrolled content space. */
  function contentY(clientTop: number, editorRect: DOMRect): number {
    return clientTop - editorRect.top + editorEl.scrollTop;
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
        } else {
          const span = threadSpan(b.thread.id);
          if (span) anchorY = contentY(span.getBoundingClientRect().top, editorRect);
        }
      } catch {
        // happy-dom / positions without layout info — stack from the top.
      }
      return { anchorY: Math.max(0, anchorY), height: b.el.offsetHeight };
    });
    const ys = layoutBalloons(items, GAP);

    // Size the overlay to the scrolled content so lines aren't clipped.
    overlay.setAttribute('width', String(Math.max(0, editorEl.scrollWidth)));
    overlay.setAttribute('height', String(Math.max(0, editorEl.scrollHeight)));
    overlay.textContent = '';
    const overlayOffsetY = contentY(overlayRect.top, editorRect);
    const overlayOffsetX = overlayRect.left - editorRect.left;
    const anchorX = proseRect.right - editorRect.left - overlayOffsetX;
    const balloonX = marginRect.left - editorRect.left - overlayOffsetX + 4;

    let maxBottom = 0;
    for (let i = 0; i < rendered.length; i++) {
      const y = Math.max(0, ys[i]);
      rendered[i].el.style.top = `${y - marginOffsetY}px`;
      maxBottom = Math.max(maxBottom, y + items[i].height);

      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute(
        'class',
        rendered[i].kind === 'comment' ? 'lf-leader lf-leader-comment' : 'lf-leader',
      );
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
    renderBalloons(groupDeletions(getDeletions(), blockKeyForPos), eligibleThreads());
    positionBalloons();
  }

  function revealThreadBalloon(id: string): boolean {
    const found = rendered.find(
      (r): r is RenderedCommentBalloon => r.kind === 'comment' && r.thread.id === id,
    );
    if (!found) return false;
    try {
      found.el.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    } catch {
      // scrollIntoView can throw in some test/embedded environments — the
      // highlight in the editor already happened, this is a nice-to-have.
    }
    return true;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  function scheduleRelayout(): void {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      relayout();
    }, RELAYOUT_DEBOUNCE_MS);
  }

  // Expand/collapse via one delegated listener — balloons rebuild on content
  // changes, so per-balloon listeners would leak or vanish.
  scope.listen(marginEl, 'click', (ev) => {
    const toggle = (ev.target as HTMLElement).closest?.('.lf-balloon-expand');
    if (!toggle) return;
    const balloon = toggle.closest('.lf-balloon');
    const text = balloon?.querySelector('.lf-balloon-text');
    if (!balloon || !text) return;
    const expanded = balloon.classList.toggle('is-expanded');
    text.classList.toggle('is-clamped', !expanded);
    toggle.textContent = expanded ? 'Show less' : 'Show more';
    positionBalloons(); // heights changed — restack without rebuilding
  });

  scope.listen(window, 'resize', scheduleRelayout);

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
  return { relayout, scheduleRelayout, revealThreadBalloon };
}
