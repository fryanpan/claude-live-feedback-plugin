import { computeRedline, getContent, snapOffsetsToLines } from '@feedback/core';
import { Editor } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import type * as Y from 'yjs';
import { encodeOffsetRel, resolveRelOffset } from '../code/code-anchor.ts';
import { MermaidCodeBlock } from '../mermaid-code-block.ts';
import type { ReviewSurface } from '../review-surface.ts';
import { ThreadDecorations, setThreadDecorations } from '../thread-decorations.ts';
import { renderRedlineHtml, stripTrailingEmptyParagraphs } from './redline-html.ts';
import { RedlineDel, RedlineIns, RedlineProvenance } from './redline-marks.ts';

export interface RedlineSelection {
  start: Uint8Array;
  end: Uint8Array;
  snippet: string;
  /** Present only when the selection was entirely base-only (struck-through)
   *  text, which has no position in `content` to anchor to. */
  deletedSnippet?: string;
}

export interface RedlineSurface extends ReviewSurface {
  getSelectionRel: () => RedlineSelection | null;
  /** Recompute and re-render from the current content. */
  refresh: () => void;
}

export interface CreateRedlineEditorOpts {
  parent: HTMLElement;
  ydoc: Y.Doc;
  /** File content at the pinned base commit. Immutable for the review's life. */
  baseText: string;
  onSelectionChange?: () => void;
}

/** One block's provenance: where it sits in the rendered doc, and what it maps
 *  to in `content`. */
interface BlockIndexEntry {
  pmFrom: number;
  pmTo: number;
  /** New-side span. Null on deletion-only blocks. */
  from: number | null;
  to: number | null;
  /** Nearest following new-side offset, on deletion-only blocks. */
  snap: number | null;
}

const EXTENSIONS = [
  StarterKit.configure({ undoRedo: false, codeBlock: false }),
  MermaidCodeBlock,
  Image,
  Markdown,
  RedlineIns,
  RedlineDel,
  RedlineProvenance,
];

/**
 * Read-only Tiptap surface rendering a Word-style redline of `baseText`
 * against the `content` Y.Text.
 *
 * The document is NOT collaborative — it is DERIVED. Every client computes the
 * same redline from the same shared inputs (`content` is CRDT-synced;
 * `baseText` is pinned to a commit hash and immutable), so there is nothing to
 * sync and no coordination to get wrong. Threads still live in the shared CRDT,
 * anchored into `content` via each block's provenance — which is what keeps
 * them interoperable with the source diff view and with the agent.
 *
 * Implements `ReviewSurface`, so `mountReviewChrome` gives this surface the
 * whole thread/composer/drawer/reveal stack unchanged.
 */
export function createRedlineEditor(opts: CreateRedlineEditorOpts): RedlineSurface {
  const content = getContent(opts.ydoc);

  const editor = new Editor({
    element: opts.parent,
    editable: false,
    extensions: [...EXTENSIONS, ThreadDecorations],
    content: '',
    onSelectionUpdate: () => opts.onSelectionChange?.(),
  });

  // Scratch editor for per-block markdown -> HTML. Reused across renders and
  // across blocks; converting each block in ISOLATION is the point (a shared
  // parse merges adjacent same-type lists and shifts every later anchor).
  const scratchHost = document.createElement('div');
  const scratch = new Editor({ element: scratchHost, extensions: EXTENSIONS, content: '' });
  const toHtml = (md: string): string => {
    scratch.commands.setContent(md, { emitUpdate: false });
    // Tiptap appends a trailing empty paragraph after several block types; it
    // would render as blank filler AND inherit the block's provenance.
    return stripTrailingEmptyParagraphs(scratch.getHTML());
  };

  let index: BlockIndexEntry[] = [];
  let lastHtml: string | null = null;

  function render(): void {
    const html = renderRedlineHtml(computeRedline(opts.baseText, content.toString()), toHtml);
    // setContent resets the selection, so skip a no-op re-render. In
    // working-tree mode `content` churns as the agent saves.
    if (html === lastHtml) return;
    lastHtml = html;
    editor.commands.setContent(html, { emitUpdate: false });

    index = [];
    editor.state.doc.forEach((node, pos) => {
      const a = node.attrs as {
        lfFrom?: number | null;
        lfTo?: number | null;
        lfSnap?: number | null;
      };
      if (a.lfFrom == null && a.lfSnap == null) return;
      index.push({
        pmFrom: pos,
        pmTo: pos + node.nodeSize,
        from: a.lfFrom ?? null,
        to: a.lfTo ?? null,
        snap: a.lfSnap ?? null,
      });
    });
  }

  // Derive on every content change INCLUDING the empty->content transition:
  // Yjs syncs after the surface mounts, so a mount-time render alone would
  // leave the view permanently empty. Same class as the collapseUnchanged
  // compartment bug in learnings.md — anything derived at mount is stale for
  // a doc that streams in afterwards.
  render();
  const onContentChange = () => render();
  content.observe(onContentChange);

  /** The indexed block containing a PM position, or the nearest one before it. */
  function blockAt(pos: number): BlockIndexEntry | null {
    let best: BlockIndexEntry | null = null;
    for (const e of index) {
      if (e.pmFrom > pos) break;
      best = e;
    }
    if (best && pos >= best.pmTo) {
      // Past the end of the last block that starts before pos — still the best
      // answer for a selection that ends in trailing whitespace.
      return best;
    }
    return best;
  }

  /** Resolve a PM range to `content` offsets via block provenance, line-snapped
   *  so the anchor is byte-identical to what the source diff view produces. */
  function selectionToContent(
    from: number,
    to: number,
  ): { from: number; to: number; deletedOnly: boolean } | null {
    const a = blockAt(from);
    const b = blockAt(to) ?? a;
    if (!a) return null;
    const lo = a.from ?? a.snap;
    const hi = b?.to ?? b?.snap ?? lo;
    if (lo == null || hi == null) return null;
    const text = content.toString();
    const snapped = snapOffsetsToLines(text, lo, hi);
    // Every touched block is deletion-only => the comment is about text that
    // exists only on the base side.
    const deletedOnly = a.from == null && (b?.from ?? null) == null;
    return { ...snapped, deletedOnly };
  }

  return {
    getSelectionRel(): RedlineSelection | null {
      let from = editor.state.selection.from;
      let to = editor.state.selection.to;
      if (editor.state.selection.empty) {
        // The surface is contenteditable=false, so a long-press selection —
        // notably on iOS Safari, which is how this gets reviewed — never
        // reaches ProseMirror's selection state. Fall back to the raw DOM
        // selection, exactly as editor.ts does for view mode.
        const dom = window.getSelection();
        if (!dom || dom.rangeCount === 0 || dom.isCollapsed) return null;
        const range = dom.getRangeAt(0);
        const view = editor.view;
        if (!view.dom.contains(range.startContainer) || !view.dom.contains(range.endContainer)) {
          return null;
        }
        try {
          const x = view.posAtDOM(range.startContainer, range.startOffset);
          const y = view.posAtDOM(range.endContainer, range.endOffset);
          if (x < 0 || y < 0 || x === y) return null;
          from = Math.min(x, y);
          to = Math.max(x, y);
        } catch {
          return null;
        }
      }

      const mapped = selectionToContent(from, to);
      if (!mapped || mapped.from === mapped.to) return null;
      const text = content.toString();
      const sel: RedlineSelection = {
        start: encodeOffsetRel(content, mapped.from),
        end: encodeOffsetRel(content, mapped.to),
        snippet: text.slice(mapped.from, mapped.to).slice(0, 120),
      };
      if (mapped.deletedOnly) {
        // Record what the comment was actually about; the anchor itself points
        // at the nearest following retained line.
        sel.deletedSnippet = editor.state.doc.textBetween(from, to, ' ').slice(0, 120);
      }
      return sel;
    },

    resolveRel(startRel, endRel) {
      const s = resolveRelOffset(opts.ydoc, startRel);
      const e = resolveRelOffset(opts.ydoc, endRel);
      if (s == null || e == null) return null;
      const lo = Math.min(s, e);
      const hi = Math.max(s, e);
      let from: number | null = null;
      let to: number | null = null;
      for (const b of index) {
        if (b.from == null || b.to == null) continue;
        // Overlap test — a thread on a line inside this block lights the block.
        if (b.to <= lo || b.from >= hi) continue;
        from = from == null ? b.pmFrom : Math.min(from, b.pmFrom);
        to = to == null ? b.pmTo : Math.max(to, b.pmTo);
      }
      if (from == null || to == null || from === to) return null;
      return { from, to };
    },

    lineForPos(pos) {
      const b = blockAt(pos);
      const off = b?.from ?? b?.snap;
      if (off == null) return null;
      return content.toString().slice(0, off).split('\n').length;
    },

    scrollToPos(pos) {
      const clamped = Math.max(0, Math.min(pos, editor.state.doc.content.size));
      editor.commands.setTextSelection(clamped);
      editor.commands.scrollIntoView();
    },

    pulseRange(from, to) {
      const pulseId = `pulse-${from}-${to}-${Date.now()}`;
      setThreadDecorations(editor.view, { pulseId });
      setTimeout(() => setThreadDecorations(editor.view, { pulseId: null }), 1200);
    },

    setThreadRanges(ranges, activeId) {
      setThreadDecorations(editor.view, { ranges, activeId });
    },

    refresh: render,

    destroy() {
      content.unobserve(onContentChange);
      scratch.destroy();
      editor.destroy();
    },
  };
}
