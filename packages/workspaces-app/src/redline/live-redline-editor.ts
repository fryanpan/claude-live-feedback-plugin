import { prose } from '@feedback/core';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../editor.ts';
import type { ReviewSurface } from '../review-surface.ts';
import {
  LiveMarkup,
  type RedlineDeletion,
  computeLiveMarkup,
  liveMarkupKey,
} from './live-markup.ts';

/**
 * The EDITABLE redline surface: the standard collaborative markdown editor
 * (same extensions, same Collaboration binding, same prose-fragment thread
 * anchors as the File view) plus the LiveMarkup extension rendering ins
 * decorations vs `baseText` and extracting deletions for the margin.
 *
 * Because it wraps `createEditor` over the COMPANION doc, everything the File
 * view already ships comes for free: typing flows companion → disk → the diff
 * member's poll; agent tools (`find_and_replace`, `create_thread`, …) operate
 * on the same fragment; concurrent edits CRDT-merge and re-render as markup.
 */
export interface LiveRedlineSurface extends ReviewSurface {
  /** Deletions vs baseText, positioned in the live doc — the markup margin
   *  (plan commit 3) renders these as balloons. */
  getDeletions: () => RedlineDeletion[];
  /** Force a synchronous markup recompute (bypasses the debounce). */
  refresh: () => void;
  /** The underlying Tiptap handle — the mount uses it for doc inspection. */
  handle: EditorHandle;
}

export interface CreateLiveRedlineEditorOpts {
  parent: HTMLElement;
  /** The COMPANION doc (prose fragment) — not the diff member doc. */
  ydoc: Y.Doc;
  awareness: Awareness;
  /** File content at the base commit. Empty string = added file: no markup. */
  baseText: string;
  /** True only for diff status 'added' — clean render, no markup. Never
   *  inferred from an empty baseText (modified files can have empty bases). */
  isAdded?: boolean;
  onSelectionChange?: () => void;
  user?: { name: string; color: string };
  /** Markup recompute delay after a doc change. Tests pass 0. */
  debounceMs?: number;
  /** In-app navigation for relative sibling links (see CreateEditorOpts). */
  docLink?: { workspaceId: string; relPath: string; navigate: (url: string) => void };
  /**
   * Whether this surface takes typing. Defaults to `true` — it is the
   * editable redline. A browser the server refuses writes from still gets it
   * (the markup, the balloons, and the companion doc's comment threads are
   * the same ones everyone else is reading), built read-only rather than
   * swapped for the derived fallback, because losing the surface would lose
   * the threads with it.
   */
  editable?: boolean;
}

export function createLiveRedlineEditor(opts: CreateLiveRedlineEditorOpts): LiveRedlineSurface {
  const handle = createEditor({
    parent: opts.parent,
    ydoc: opts.ydoc,
    awareness: opts.awareness,
    onSelectionChange: opts.onSelectionChange,
    user: opts.user,
    docLink: opts.docLink,
    editable: opts.editable ?? true,
    extraExtensions: [
      LiveMarkup.configure({
        baseText: opts.baseText,
        isAdded: opts.isAdded ?? false,
        ydoc: opts.ydoc,
        debounceMs: opts.debounceMs ?? 300,
      }),
    ],
  });

  return {
    getSelectionRel: () => handle.getSelectionRel(),
    resolveRel: (startRel, endRel) => handle.resolveRel(startRel, endRel),
    scrollToPos: (pos) => handle.scrollToPos(pos),
    pulseRange: (from, to) => handle.pulseRange(from, to),
    setThreadRanges: (ranges, activeId) => handle.setThreadRanges(ranges, activeId),
    setInlineCards: (cards) => handle.setInlineCards(cards),
    getDeletions: () => liveMarkupKey.getState(handle.editor.state)?.deletions ?? [],
    refresh: () => {
      const { state, view } = handle.editor;
      const result = opts.isAdded
        ? { insRanges: [], deletions: [] }
        : computeLiveMarkup(opts.baseText, state.doc, prose.getProseFragment(opts.ydoc));
      view.dispatch(state.tr.setMeta(liveMarkupKey, result));
    },
    destroy: () => handle.destroy(),
    handle,
  };
}
