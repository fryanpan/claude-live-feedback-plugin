/**
 * Helpers for reading and editing the prosemirror content stored as a
 * `Y.XmlFragment` under the `prose` key in every markdown doc. Kept in
 * @feedback/core so the server, the MCP, and future headless tooling
 * can share one implementation.
 *
 * The fragment is a tree of `Y.XmlElement` nodes (paragraph, heading,
 * bulletList, …) with `Y.XmlText` leaves. We never run a headless
 * prosemirror view server-side — we walk the Yjs tree directly. Every
 * mutation happens inside a single `ydoc.transact(fn, 'agent')` so
 * concurrent user edits compose via Yjs' own CRDT machinery.
 */
import * as Y from 'yjs';
import { decodeRelativePositionSafe } from './anchor/validate.ts';
import { type AnchoredEditResult, type LocatedMatch, locateMatches } from './prose-edit.ts';
import {
  getProseFragment,
  headingLevelOf,
  preview,
  resolveRelativePositionRaw,
  walkProse,
} from './prose-fragment.ts';
import { parseMarkdownBlocks, textContent } from './prose-markdown.ts';
export {
  locateMatches,
  coveringInlineMarks,
  insertTextWithMarks,
  findAndReplace,
  rewriteRange,
  insertAfterRange,
} from './prose-edit.ts';
export type {
  LocatedMatch,
  ReplaceResult,
  NoMatchHint,
  TextSlice,
  AnchoredEditResult,
} from './prose-edit.ts';

export {
  PROSE_FRAGMENT_KEY,
  getProseFragment,
  walkProse,
  resolveRelativePosition,
  resolveRelativePositionRaw,
  headingLevelOf,
} from './prose-fragment.ts';
export type { TextSegment } from './prose-fragment.ts';
export {
  inlineMarksToDelta,
  normalizeHeadingLevels,
  applyMarkdownToFragment,
  parseMarkdownBlocks,
  normalizeMarkdown,
  serializeFragmentToMarkdown,
  serializeBlockToMarkdown,
} from './prose-markdown.ts';

/** Where insertBlocksAfterAnchor splices relative to the anchor's block. */
export type BlockPlacement = 'after-block' | 'top-level';

/**
 * Insert one or more markdown-parsed blocks AFTER the block containing
 * the anchor. Use this for "add a paragraph after this heading" or
 * "add a section here" — the anchor tells the agent where in the doc
 * structure to splice, and the markdown describes the new content.
 *
 * `placement` (default 'after-block') picks the splice point:
 * - 'after-block': immediately after the anchor's INNERMOST block, inside
 *   that block's parent. For an anchor inside a list item's paragraph the
 *   parent is the listItem, so the new blocks NEST under the item — which
 *   has broken document structure twice when the caller meant "after the
 *   list". Kept as the default because it is the historical behavior.
 * - 'top-level': after the anchor's TOP-LEVEL block, at fragment level —
 *   "after the whole list / table / blockquote". For an anchor already in
 *   a top-level block the two placements are identical.
 */
export function insertBlocksAfterAnchor(
  doc: Y.Doc,
  opts: {
    anchorRel: Uint8Array;
    markdown: string;
    placement?: BlockPlacement;
    transactionOrigin?: unknown;
  },
): AnchoredEditResult {
  const raw = resolveRelativePositionRaw(doc, opts.anchorRel);
  if (!raw) return { ok: false, error: 'anchor-orphaned' };
  const fragment = getProseFragment(doc);
  const { segments } = walkProse(fragment);
  const seg = segments.find((s) => s.node === raw.node);
  if (!seg || !seg.block) return { ok: false, error: 'no-host-block' };
  // walkProse guarantees topBlock is set for any segment with a block, but
  // fall through to the after-block path rather than crash if it isn't.
  const topLevel = opts.placement === 'top-level' && seg.topBlock != null;
  const block = topLevel ? (seg.topBlock as Y.XmlElement) : seg.block;
  const parent = (topLevel ? fragment : block.parent) as Y.XmlFragment | Y.XmlElement | null;
  if (!parent) return { ok: false, error: 'no-host-block' };
  const siblings = parent.toArray();
  const idx = siblings.indexOf(block);
  if (idx < 0) return { ok: false, error: 'no-host-block' };

  const blocks = parseMarkdownBlocks(opts.markdown);
  if (blocks.length === 0) return { ok: false, error: 'parse-failed' };

  doc.transact(() => {
    parent.insert(idx + 1, blocks);
  }, opts.transactionOrigin ?? 'agent');
  return { ok: true };
}

/**
 * Scan all text-range threads in a doc. For each thread whose anchor
 * no longer resolves (e.g. the user split the block, re-typed the
 * text, or moved content across blocks in a way prosemirror destroyed
 * the original Y.XmlText), try to recover by text-matching the
 * thread's stored snippet against the current plain text. If the
 * snippet appears exactly once, build a new Y.RelativePosition and
 * update the thread's anchor in place.
 *
 * Returns a summary the caller can log. Safe to call repeatedly —
 * idempotent when nothing has changed.
 */
export function autoReanchorDoc(
  doc: Y.Doc,
  opts: { transactionOrigin?: unknown } = {},
): { checked: number; reanchored: number; stillOrphan: number } {
  const threads = doc.getMap('threads') as Y.Map<Y.Map<unknown>>;
  const fragment = getProseFragment(doc);
  const walk = walkProse(fragment);
  let checked = 0;
  let reanchored = 0;
  let stillOrphan = 0;

  threads.forEach((threadMap) => {
    const anchor = threadMap.get('anchor') as
      | { kind: 'text-range'; startRel: Uint8Array; endRel: Uint8Array; snippet: { text: string } }
      | { kind: 'element' | 'orphan' }
      | undefined;
    if (!anchor || anchor.kind !== 'text-range') return;
    checked++;
    if (
      resolveRelativePositionRaw(doc, anchor.startRel) &&
      resolveRelativePositionRaw(doc, anchor.endRel)
    ) {
      return;
    }
    // `snippet` is required by the type but not by anything that has ever
    // written one — a hand-written anchor can omit it, and this sweep is
    // where the missing property is first read.
    const needle = anchor.snippet?.text;
    if (!needle) {
      stillOrphan++;
      return;
    }
    const first = walk.plainText.indexOf(needle);
    if (first < 0 || walk.plainText.indexOf(needle, first + 1) >= 0) {
      // zero or multiple matches — don't guess
      stillOrphan++;
      return;
    }
    const startSeg = walk.segments.find(
      (s) => first >= s.docOffset && first < s.docOffset + s.length,
    );
    const endSeg = walk.segments.find(
      (s) => first + needle.length > s.docOffset && first + needle.length <= s.docOffset + s.length,
    );
    if (!startSeg || !endSeg) {
      stillOrphan++;
      return;
    }
    const startRel = Y.createRelativePositionFromTypeIndex(
      startSeg.node,
      first - startSeg.docOffset,
    );
    const endRel = Y.createRelativePositionFromTypeIndex(
      endSeg.node,
      first + needle.length - endSeg.docOffset,
    );
    doc.transact(() => {
      threadMap.set('anchor', {
        kind: 'text-range',
        startRel: Y.encodeRelativePosition(startRel),
        endRel: Y.encodeRelativePosition(endRel),
        snippet: { text: needle },
      });
    }, opts.transactionOrigin ?? 'agent-reanchor');
    reanchored++;
  });

  return { checked, reanchored, stillOrphan };
}

/**
 * Flat-text twin of `autoReanchorDoc` for `type='code'` docs.
 *
 * Code docs store their raw source in the flat `content` Y.Text (no prose
 * fragment), so the prose-fragment walk that `autoReanchorDoc` does would
 * find nothing and orphan every thread. This version operates on
 * `content.toString()`.
 *
 * NOTE the difference from the prose path: a relative position on a flat
 * Y.Text never truly "fails to resolve" — after a delete+reinsert the
 * Y.Text is the same CRDT type, so `createAbsolutePositionFromRelativePosition`
 * returns a clamped index (often 0) rather than null. So we can't gate on
 * resolution alone; an anchor is "still valid" only if both positions
 * resolve AND the text between them still equals the stored snippet. When
 * it doesn't, we text-match the snippet: if it appears exactly once, rebuild
 * the relative positions at that index; otherwise mark the thread orphaned
 * (preserving the original anchor for later manual re-anchoring).
 *
 * Returns a summary the caller can log. Idempotent — safe to call on every
 * `content` change.
 */
export function autoReanchorCodeDoc(
  doc: Y.Doc,
  opts: { transactionOrigin?: unknown } = {},
): { checked: number; reanchored: number; stillOrphan: number } {
  const threads = doc.getMap('threads') as Y.Map<Y.Map<unknown>>;
  const content = doc.getText('content');
  const text = content.toString();
  let checked = 0;
  let reanchored = 0;
  let stillOrphan = 0;

  threads.forEach((threadMap) => {
    const anchor = threadMap.get('anchor') as
      | { kind: 'text-range'; startRel: Uint8Array; endRel: Uint8Array; snippet: { text: string } }
      | { kind: 'element' | 'orphan' }
      | undefined;
    if (!anchor || anchor.kind !== 'text-range') return;
    checked++;
    const needle = anchor.snippet?.text;
    // Still valid? Both positions must resolve AND the spanned text must
    // still equal the snippet. (Resolution alone is insufficient — see the
    // note above about flat-Y.Text clamping.) Undecodable bytes resolve to
    // null here rather than throwing inside the observer this runs in.
    const storedStart = decodeRelativePositionSafe(anchor.startRel);
    const storedEnd = decodeRelativePositionSafe(anchor.endRel);
    const startAbs = storedStart
      ? Y.createAbsolutePositionFromRelativePosition(storedStart, doc)
      : null;
    const endAbs = storedEnd ? Y.createAbsolutePositionFromRelativePosition(storedEnd, doc) : null;
    if (startAbs && endAbs) {
      const lo = Math.min(startAbs.index, endAbs.index);
      const hi = Math.max(startAbs.index, endAbs.index);
      if (text.slice(lo, hi) === needle) return;
    }
    if (!needle) {
      markThreadOrphan(doc, threadMap, opts.transactionOrigin);
      stillOrphan++;
      return;
    }
    const first = text.indexOf(needle);
    if (first < 0 || text.indexOf(needle, first + 1) >= 0) {
      // zero or multiple matches — don't guess
      markThreadOrphan(doc, threadMap, opts.transactionOrigin);
      stillOrphan++;
      return;
    }
    const startRel = Y.createRelativePositionFromTypeIndex(content, first);
    const endRel = Y.createRelativePositionFromTypeIndex(content, first + needle.length);
    doc.transact(() => {
      threadMap.set('anchor', {
        kind: 'text-range',
        startRel: Y.encodeRelativePosition(startRel),
        endRel: Y.encodeRelativePosition(endRel),
        snippet: { text: needle },
      });
    }, opts.transactionOrigin ?? 'agent-reanchor');
    reanchored++;
  });

  return { checked, reanchored, stillOrphan };
}

/** Mark a thread orphaned in place, preserving its original anchor so it
 *  can be re-anchored later. No-op if already orphaned. */
function markThreadOrphan(doc: Y.Doc, threadMap: Y.Map<unknown>, origin: unknown): void {
  const current = threadMap.get('anchor') as
    | { kind: 'text-range' | 'element' | 'orphan' }
    | undefined;
  if (!current || current.kind === 'orphan') return;
  doc.transact(() => {
    threadMap.set('anchor', { kind: 'orphan', original: current, lastSeenAt: Date.now() });
  }, origin ?? 'agent-reanchor');
}

/**
 * Ephemeral anchors the AGENT mints for its own bookkeeping — same
 * Y.RelativePosition tech as thread anchors, but stored separately so
 * they never show up in the user's threads list. Useful for "anchor
 * three spots, then rewrite each" patterns where the agent needs to
 * survive its own intermediate edits shifting later positions.
 *
 * Stored in a Y.Map under the `agent_anchors` key. Each entry:
 *   { startRel: Uint8Array, endRel: Uint8Array, label?: string, createdAt: number }
 */
export const AGENT_ANCHORS_KEY = 'agent_anchors';

export function getAgentAnchorsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap(AGENT_ANCHORS_KEY) as Y.Map<Y.Map<unknown>>;
}

export interface CreateAnchorResult {
  ok: boolean;
  anchorId?: string;
  error?: 'no-match' | 'ambiguous' | 'cross-node';
  candidates?: Array<{ docOffset: number; preview: string }>;
}

/**
 * Find `text` in the doc (optionally disambiguated by context) and
 * persist its start/end as a named anchor. Returns a short id the
 * agent can pass to editAtAnchor later.
 */
/**
 * Resolve a `find` (with optional context / occurrence) to a serialized
 * Y.RelativePosition pair plus the matched snippet text. Shared by:
 *   - `createAgentAnchor` (agent-private bookmarks)
 *   - `rooms.createThreadByFind` (agent-created review threads)
 *
 * Both call sites need the same disambiguation semantics as
 * `find_and_replace`: occurrence picker, cross-node detection, ambiguous
 * candidate listing. Keeping one resolver means a bug-fix here lands in
 * both paths automatically.
 */
export type ResolveTextRangeResult =
  | { ok: true; startRel: Uint8Array; endRel: Uint8Array; snippetText: string }
  | { ok: false; error: 'no-match' | 'cross-node' }
  | {
      ok: false;
      error: 'ambiguous';
      candidates: Array<{ docOffset: number; preview: string }>;
    };

export function resolveTextRangeFromFind(
  doc: Y.Doc,
  opts: {
    find: string;
    contextBefore?: string;
    contextAfter?: string;
    occurrence?: number;
  },
): ResolveTextRangeResult {
  const fragment = getProseFragment(doc);
  const { matches, crossNode, plainText } = locateMatches(fragment, opts);
  if (matches.length === 0) {
    if (crossNode > 0) return { ok: false, error: 'cross-node' };
    return { ok: false, error: 'no-match' };
  }
  let chosen: LocatedMatch;
  if (opts.occurrence != null) {
    if (opts.occurrence < 1 || opts.occurrence > matches.length) {
      return { ok: false, error: 'no-match' };
    }
    chosen = matches[opts.occurrence - 1]!;
  } else if (matches.length > 1) {
    return {
      ok: false,
      error: 'ambiguous',
      candidates: matches.map((m) => ({
        docOffset: m.docOffset,
        preview: preview(plainText, m.docOffset, m.length),
      })),
    };
  } else {
    chosen = matches[0]!;
  }

  const startRel = Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(chosen.segment.node, chosen.offsetInNode),
  );
  const endRel = Y.encodeRelativePosition(
    Y.createRelativePositionFromTypeIndex(chosen.segment.node, chosen.offsetInNode + chosen.length),
  );
  const snippetText = plainText.slice(chosen.docOffset, chosen.docOffset + chosen.length);
  return { ok: true, startRel, endRel, snippetText };
}

export function createAgentAnchor(
  doc: Y.Doc,
  opts: {
    find: string;
    contextBefore?: string;
    contextAfter?: string;
    occurrence?: number;
    label?: string;
  },
): CreateAnchorResult {
  const resolved = resolveTextRangeFromFind(doc, opts);
  if (!resolved.ok) {
    if (resolved.error === 'ambiguous') {
      return { ok: false, error: 'ambiguous', candidates: resolved.candidates };
    }
    return { ok: false, error: resolved.error };
  }
  const anchorId = `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const entry = new Y.Map<unknown>();
  doc.transact(() => {
    entry.set('startRel', resolved.startRel);
    entry.set('endRel', resolved.endRel);
    entry.set('createdAt', Date.now());
    if (opts.label) entry.set('label', opts.label);
    getAgentAnchorsMap(doc).set(anchorId, entry);
  }, 'agent');
  return { ok: true, anchorId };
}

export function readAgentAnchor(
  doc: Y.Doc,
  anchorId: string,
): { startRel: Uint8Array; endRel: Uint8Array; label?: string } | null {
  const entry = getAgentAnchorsMap(doc).get(anchorId);
  if (!entry) return null;
  const startRel = entry.get('startRel') as Uint8Array | undefined;
  const endRel = entry.get('endRel') as Uint8Array | undefined;
  if (!startRel || !endRel) return null;
  const label = entry.get('label') as string | undefined;
  return { startRel, endRel, ...(label ? { label } : {}) };
}

export function deleteAgentAnchor(doc: Y.Doc, anchorId: string): boolean {
  const map = getAgentAnchorsMap(doc);
  if (!map.has(anchorId)) return false;
  doc.transact(() => map.delete(anchorId), 'agent');
  return true;
}

// ===========================================================================
// Block-deletion API — see docs/proposals/delete-blocks-api.md.
//
// Three exported functions, smallest first:
//
//   deleteBlockAtAnchor   — delete the single host block of an anchor.
//   deleteBlocksInRange   — delete every whole block from startFind through
//                           endFind (block-inclusive).
//   deleteSection         — heading-aware: delete a heading block plus all
//                           subsequent top-level blocks until the next
//                           heading at level ≤ the start heading's level.
//
// All three wrap their mutations in a single `doc.transact(fn, 'agent')`
// for clean Yjs CRDT concurrency, exactly like rewriteRange and
// insertBlocksAfterAnchor.
// ===========================================================================

/** Short preview of a block's textual content — useful for the
 *  agent-facing return of deleteBlockAtAnchor. Strips wrapper marks. */
function blockSnippet(block: Y.XmlElement, max = 80): string {
  const text = textContent(block).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface DeleteBlockResult {
  ok: boolean;
  error?: 'anchor-orphaned' | 'no-host-block';
  deleted?: { tag: string; snippet: string };
}

/**
 * Delete the single block that contains the anchor. The "host block" is
 * the INNERMOST prosemirror block ancestor of the anchored Y.XmlText —
 * for an anchor inside a paragraph at the doc root, that's the
 * paragraph itself; for an anchor inside a listItem's paragraph, that's
 * the paragraph (NOT the listItem). Same notion of "host block"
 * walkProse already exposes via `segment.block`.
 *
 * Caveat: deleting the inner paragraph of a listItem leaves the
 * containing listItem empty (it still occupies the list slot). For
 * "delete the whole list item" or "delete the whole list", reach for
 * deleteBlocksInRange / deleteSection instead — they operate at the
 * top-level fragment.
 *
 * The anchor's start position is used to locate the host block. End
 * position is irrelevant — block deletion is all-or-nothing.
 */
export function deleteBlockAtAnchor(
  doc: Y.Doc,
  opts: {
    anchorRel: Uint8Array;
    transactionOrigin?: unknown;
  },
): DeleteBlockResult {
  const raw = resolveRelativePositionRaw(doc, opts.anchorRel);
  if (!raw) return { ok: false, error: 'anchor-orphaned' };
  const fragment = getProseFragment(doc);
  const { segments } = walkProse(fragment);
  const seg = segments.find((s) => s.node === raw.node);
  if (!seg || !seg.block) return { ok: false, error: 'no-host-block' };
  const block = seg.block;
  const parent = block.parent as Y.XmlFragment | Y.XmlElement | null;
  if (!parent) return { ok: false, error: 'no-host-block' };
  const siblings = parent.toArray();
  const idx = siblings.indexOf(block);
  if (idx < 0) return { ok: false, error: 'no-host-block' };

  const tag = block.nodeName;
  const snippet = blockSnippet(block);

  doc.transact(() => {
    parent.delete(idx, 1);
  }, opts.transactionOrigin ?? 'agent');

  return { ok: true, deleted: { tag, snippet } };
}

export interface DeleteBlocksInRangeResult {
  ok: boolean;
  error?: 'no-match' | 'ambiguous' | 'inverted-range' | 'no-blocks';
  /** Number of TOP-LEVEL blocks removed from the fragment. */
  deleted?: number;
  /** For ambiguous results, candidate previews. `which` says whether
   *  the ambiguity was on `startFind` or `endFind`. */
  candidates?: Array<{ which: 'start' | 'end'; docOffset: number; preview: string }>;
}

/**
 * Delete every TOP-LEVEL block from the one containing `startFind`
 * through the one containing `endFind` — block-inclusive. A partial
 * match still removes the entire containing block; this is intentional
 * ("blow away the section that contains this string"). Both find
 * strings disambiguate via the same contextBefore / contextAfter /
 * occurrence machinery as findAndReplace.
 *
 * Operates on the fragment's top-level blocks. If the start match lives
 * inside a nested block (a listItem, a tableCell), the whole containing
 * top-level block (the bulletList, the table) is deleted. This is
 * deliberate — it keeps the contract simple ("delete the section") and
 * sidesteps the hairier question of "delete this listItem from its
 * bulletList but keep the others." Use deleteBlockAtAnchor for that.
 */
export function deleteBlocksInRange(
  doc: Y.Doc,
  opts: {
    startFind: string;
    endFind: string;
    contextBefore?: string;
    contextAfter?: string;
    startOccurrence?: number;
    endOccurrence?: number;
    transactionOrigin?: unknown;
  },
): DeleteBlocksInRangeResult {
  const fragment = getProseFragment(doc);

  const startRes = resolveSingleFind(fragment, {
    find: opts.startFind,
    contextBefore: opts.contextBefore,
    contextAfter: opts.contextAfter,
    occurrence: opts.startOccurrence,
  });
  if (!startRes.ok) return mapFindError(startRes.error, startRes.candidates, 'start');

  const endRes = resolveSingleFind(fragment, {
    find: opts.endFind,
    contextBefore: opts.contextBefore,
    contextAfter: opts.contextAfter,
    occurrence: opts.endOccurrence,
  });
  if (!endRes.ok) return mapFindError(endRes.error, endRes.candidates, 'end');

  const startTop = startRes.match.segment.topBlock;
  const endTop = endRes.match.segment.topBlock;
  if (!startTop || !endTop) return { ok: false, error: 'no-blocks' };

  const top = fragment.toArray() as Y.XmlElement[];
  const startIdx = top.indexOf(startTop);
  const endIdx = top.indexOf(endTop);
  if (startIdx < 0 || endIdx < 0) return { ok: false, error: 'no-blocks' };
  if (endIdx < startIdx) return { ok: false, error: 'inverted-range' };

  const count = endIdx - startIdx + 1;
  doc.transact(() => {
    fragment.delete(startIdx, count);
  }, opts.transactionOrigin ?? 'agent');

  return { ok: true, deleted: count };
}

export interface DeleteSectionResult {
  ok: boolean;
  error?: 'no-match' | 'ambiguous' | 'not-a-heading';
  /** Number of top-level blocks removed (heading + body). */
  deleted?: number;
  /** Heading that ended the run (= first block AFTER the deleted span),
   *  or null if the section ran to the end of the doc. */
  nextHeading?: { level: number; text: string } | null;
  candidates?: Array<{ docOffset: number; preview: string }>;
}

/**
 * Delete a heading block plus every subsequent top-level block until the
 * next heading at level ≤ the start heading's level (or end of doc).
 * Convenience layer over deleteBlocksInRange for the common ask: "delete
 * the X section." `heading` matches against block-text exactly (after
 * trimming surrounding whitespace) — pass `level` to disambiguate when
 * the same heading text appears at multiple levels, `occurrence` for
 * repeats at the same level.
 */
export function deleteSection(
  doc: Y.Doc,
  opts: {
    heading: string;
    level?: number;
    occurrence?: number;
    transactionOrigin?: unknown;
  },
): DeleteSectionResult {
  const fragment = getProseFragment(doc);
  const top = fragment.toArray() as Y.XmlElement[];
  const wanted = opts.heading.trim();

  // Collect every heading block whose text matches, optionally filtered by level.
  const matches: Array<{ idx: number; level: number; el: Y.XmlElement }> = [];
  for (let i = 0; i < top.length; i++) {
    const el = top[i]!;
    if (el.nodeName !== 'heading') continue;
    const level = headingLevelOf(el);
    if (opts.level != null && level !== opts.level) continue;
    if (textContent(el).trim() !== wanted) continue;
    matches.push({ idx: i, level, el });
  }

  if (matches.length === 0) {
    // Distinguish "string isn't anywhere in the doc" from "found, but not
    // on a heading block" — same shape as the proposal's error vocabulary.
    const { plainText } = walkProse(fragment);
    if (plainText.includes(wanted)) return { ok: false, error: 'not-a-heading' };
    return { ok: false, error: 'no-match' };
  }

  let chosen: { idx: number; level: number; el: Y.XmlElement };
  if (opts.occurrence != null) {
    if (opts.occurrence < 1 || opts.occurrence > matches.length) {
      return { ok: false, error: 'no-match' };
    }
    chosen = matches[opts.occurrence - 1]!;
  } else if (matches.length > 1) {
    return {
      ok: false,
      error: 'ambiguous',
      candidates: matches.map((m) => ({
        docOffset: m.idx,
        preview: `h${m.level}: ${blockSnippet(m.el, 60)}`,
      })),
    };
  } else {
    chosen = matches[0]!;
  }

  // Walk forward to find the first heading at level <= chosen.level.
  let endExclusive = top.length;
  let nextHeading: { level: number; text: string } | null = null;
  for (let i = chosen.idx + 1; i < top.length; i++) {
    const el = top[i]!;
    if (el.nodeName !== 'heading') continue;
    const level = headingLevelOf(el);
    if (level <= chosen.level) {
      endExclusive = i;
      nextHeading = { level, text: textContent(el).trim() };
      break;
    }
  }

  const count = endExclusive - chosen.idx;
  doc.transact(() => {
    fragment.delete(chosen.idx, count);
  }, opts.transactionOrigin ?? 'agent');

  return { ok: true, deleted: count, nextHeading };
}

/** Resolve a single find with the same disambiguation as findAndReplace,
 *  returning the chosen LocatedMatch or a typed error.  */
/**
 * Shared "choose exactly one match" resolution used by the block-deletion API
 * and the suggestion-creation primitive (suggest-ops.ts) — the same
 * find/context/occurrence machinery findAndReplace applies, extracted so
 * callers don't re-implement (and drift from) the disambiguation rules.
 */
export function resolveSingleFind(
  fragment: Y.XmlFragment,
  opts: {
    find: string;
    contextBefore?: string;
    contextAfter?: string;
    occurrence?: number;
    /** Refuse to match inside pending `suggestInsert` text — see locateMatches. */
    excludePendingSuggestions?: boolean;
  },
):
  | { ok: true; match: LocatedMatch }
  | {
      ok: false;
      error: 'no-match' | 'ambiguous' | 'match-in-pending-suggestion';
      candidates?: Array<{ docOffset: number; preview: string }>;
    } {
  const { matches, pendingSkipped, plainText } = locateMatches(fragment, opts);
  if (matches.length === 0) {
    // Distinguish "the string isn't there" from "the only place it appears is
    // somebody's unaccepted proposal" — the second is actionable advice.
    if (pendingSkipped > 0) return { ok: false, error: 'match-in-pending-suggestion' };
    return { ok: false, error: 'no-match' };
  }
  if (opts.occurrence != null) {
    if (opts.occurrence < 1 || opts.occurrence > matches.length) {
      return { ok: false, error: 'no-match' };
    }
    return { ok: true, match: matches[opts.occurrence - 1]! };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: 'ambiguous',
      candidates: matches.map((m) => ({
        docOffset: m.docOffset,
        preview: preview(plainText, m.docOffset, m.length),
      })),
    };
  }
  return { ok: true, match: matches[0]! };
}

function mapFindError(
  error: 'no-match' | 'ambiguous' | 'match-in-pending-suggestion',
  candidates: Array<{ docOffset: number; preview: string }> | undefined,
  which: 'start' | 'end',
): DeleteBlocksInRangeResult {
  if (error === 'ambiguous') {
    return {
      ok: false,
      error: 'ambiguous',
      candidates: (candidates ?? []).map((c) => ({ which, ...c })),
    };
  }
  return { ok: false, error: 'no-match' };
}
