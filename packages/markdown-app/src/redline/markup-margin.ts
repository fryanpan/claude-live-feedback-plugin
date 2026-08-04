import type { Thread } from '@feedback/core';
import type { EditorView } from '@tiptap/pm/view';
import type { MountScope } from '../mount-scope.ts';
import type { ReviewChrome } from '../review-chrome.ts';
import { layoutBalloons } from './balloon-layout.ts';
import type { RedlineDeletion } from './live-markup.ts';

/**
 * The markup margin: Word's balloon column for the redline surface.
 *
 * Owns a right-hand column next to the prose (`.redline-layout` grid on the
 * editor element — `minmax(0, 1fr) 300px`, the `minmax(0,…)` guarding against
 * the CSS Grid overflow trap in docs/process/learnings.md). Each deletion vs
 * base renders as a balloon (deleted markdown as plain text, clamped to ~6
 * lines with an expand toggle; consecutive deletions in the same paragraph
 * collapse into one balloon). Anchor Y positions are measured from the live
 * editor DOM, stacked with `layoutBalloons`, and joined to their anchors by
 * leader lines drawn in ONE absolutely-positioned SVG overlay.
 *
 * Re-layout triggers: editor transactions (the mount forwards them, debounced
 * here), window resize, and content-size changes via a ResizeObserver on the
 * ProseMirror element — mermaid diagrams render asynchronously with no
 * completion event, and the SVG landing changes the content height, which the
 * observer sees. Everything registers on the passed MountScope for teardown.
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
  /** Open threads for comment balloons — consumed by the comment-balloon
   *  commit (plan commit 4); accepted now so the mount signature is stable. */
  threads?: () => Thread[];
  /** Thread actions for comment balloons — same follow-up commit. */
  chrome?: ReviewChrome | null;
  scope: MountScope;
}

export interface MarkupMarginHandle {
  /** Synchronous re-render + re-measure + re-stack. */
  relayout: () => void;
  /** Debounced relayout — wire this to editor transactions. */
  scheduleRelayout: () => void;
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

interface RenderedBalloon {
  key: string;
  group: DeletionGroup;
  el: HTMLElement;
}

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

  function buildBalloon(group: DeletionGroup): HTMLElement {
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

  /** Rebuild the balloon list only when the groups actually changed, so
   *  expand state survives position-only relayouts. */
  function renderBalloons(groups: DeletionGroup[]): void {
    const keys = groups.map((g) => `${g.blockKey}|${g.deletedMarkdown}`);
    if (keys.length === rendered.length && keys.every((k, i) => k === rendered[i].key)) {
      for (let i = 0; i < groups.length; i++) rendered[i].group = groups[i];
      return;
    }
    marginEl.textContent = '';
    rendered = groups.map((group, i) => {
      const el = buildBalloon(group);
      marginEl.appendChild(el);
      return { key: keys[i], group, el };
    });
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
        const pos = Math.max(0, Math.min(b.group.pos, doc.content.size));
        anchorY = contentY(view.coordsAtPos(pos).top, editorRect);
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
      line.setAttribute('class', 'lf-leader');
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
    renderBalloons(groupDeletions(getDeletions(), blockKeyForPos));
    positionBalloons();
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
  return { relayout, scheduleRelayout };
}
