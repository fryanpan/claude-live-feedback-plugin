import * as Y from 'yjs';
import {
  type TextSlice,
  coveringInlineMarks,
  getProseFragment,
  insertTextWithMarks,
  resolveRelativePositionRaw,
  resolveSingleFind,
  serializeBlockToMarkdown,
  walkProse,
} from './prose.ts';
import {
  SUGGEST_DELETE_MARK,
  SUGGEST_INSERT_MARK,
  type SuggestionAttrs,
  readSuggestionAttrs,
} from './suggest.ts';

/**
 * Suggestion operations (redline-suggestions phase 2): the Yjs-level
 * registry + mutations behind list/accept/reject/resolve-all and the
 * suggestion-creation primitive.
 *
 * There is deliberately NO stored registry: suggestions ARE the marks. Every
 * operation re-scans the prose fragment for suggestion marks at execution
 * time, so ranges survive concurrent edits for free (marks travel with the
 * text — that's the point of mark-based storage; no RelativePositions to
 * re-resolve) and a sid that no longer exists — accepted by someone else a
 * moment ago, or dropped by an external rewrite — honestly reports
 * `not-found` instead of mutating stale offsets.
 *
 * All mutations transact under the same 'agent' origin the existing agent
 * edit tools use (findAndReplace, rewriteRange, block deletion): NOT
 * 'file-seed'/'file-watch', so the rooms write-back observer flushes the
 * result to disk; not a browser-local origin, so a client Y.UndoManager with
 * default trackedOrigins never puts these transactions on a human's undo
 * stack (pinned by test).
 */

export interface SuggestionAuthor {
  id: string;
  name: string;
  color: string;
}

export type SuggestionKind = 'insert' | 'delete' | 'replace';

/** One contiguous marked range of a suggestion, located at scan time. */
export interface SuggestionRange {
  node: Y.XmlText;
  /** Offset inside `node` — valid only until the next mutation. */
  offset: number;
  length: number;
  kind: 'insert' | 'delete';
  text: string;
  /** Innermost block the range lives inside (walkProse's notion). */
  block: Y.XmlElement | null;
  /** Start offset in the flattened doc text — stable ordering key. */
  docOffset: number;
}

export interface SuggestionScanEntry {
  attrs: SuggestionAttrs;
  ranges: SuggestionRange[];
}

/** Agent/UI-facing summary of one pending proposal. */
export interface SuggestionSummary {
  sid: string;
  author: SuggestionAuthor;
  kind: SuggestionKind;
  /** Human-readable preview: inserted text, deleted text, or `old → new`
   *  (truncated, single joined string — agent/MCP-facing). */
  snippet: string;
  /** Full (untruncated) inserted text — '' for a pure delete. UI chrome that
   *  needs to render struck-old / underlined-new as separate spans reads
   *  this and `deletedText` rather than re-parsing `snippet`. */
  insertedText: string;
  /** Full (untruncated) deleted text — '' for a pure insert. */
  deletedText: string;
  /** Accepted-state preview of the containing block. */
  blockContext: string;
  /** Creation time, epoch ms. */
  ts: number;
}

export type SuggestionOpResult = { ok: true } | { ok: false; error: 'not-found' };

export type SuggestReplaceResult =
  | { ok: true; sid: string }
  | {
      ok: false;
      error: 'no-match' | 'ambiguous' | 'match-in-pending-suggestion';
      candidates?: Array<{ docOffset: number; preview: string }>;
    };

export type SuggestRewriteRangeResult =
  | { ok: true; sid: string }
  | { ok: false; error: 'anchor-orphaned' | 'cross-block' };

/**
 * Scan the fragment for suggestion marks, grouped by sid. Ranges come back
 * in doc order. Attrs are taken from the first range seen for a sid (all
 * ranges of one proposal are written with identical attrs).
 */
export function scanSuggestions(fragment: Y.XmlFragment): Map<string, SuggestionScanEntry> {
  const out = new Map<string, SuggestionScanEntry>();
  const { segments } = walkProse(fragment);
  for (const seg of segments) {
    let offset = 0;
    const delta = seg.node.toDelta() as Array<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>;
    for (const op of delta) {
      if (typeof op.insert !== 'string') continue;
      const length = op.insert.length;
      // An op carrying BOTH marks is nonsensical (text can't be both
      // proposed-new and proposed-removed); treat insert as authoritative.
      const insAttrs = readSuggestionAttrs(op.attributes?.[SUGGEST_INSERT_MARK]);
      const delAttrs = insAttrs ? null : readSuggestionAttrs(op.attributes?.[SUGGEST_DELETE_MARK]);
      const attrs = insAttrs ?? delAttrs;
      if (attrs) {
        let entry = out.get(attrs.sid);
        if (!entry) {
          entry = { attrs, ranges: [] };
          out.set(attrs.sid, entry);
        }
        entry.ranges.push({
          node: seg.node,
          offset,
          length,
          kind: insAttrs ? 'insert' : 'delete',
          text: op.insert,
          block: seg.block,
          docOffset: seg.docOffset + offset,
        });
      }
      offset += length;
    }
  }
  return out;
}

function truncate(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Accepted-state preview of a range's containing block. */
function blockContextOf(range: SuggestionRange | undefined): string {
  const block = range?.block;
  if (!block) return '';
  try {
    return truncate(serializeBlockToMarkdown(block), 100);
  } catch {
    return '';
  }
}

function kindOf(entry: SuggestionScanEntry): SuggestionKind {
  const hasInsert = entry.ranges.some((r) => r.kind === 'insert');
  const hasDelete = entry.ranges.some((r) => r.kind === 'delete');
  if (hasInsert && hasDelete) return 'replace';
  return hasInsert ? 'insert' : 'delete';
}

/** Full (untruncated) text of one kind's ranges, joined in doc order. */
function joinedText(entry: SuggestionScanEntry, kind: 'insert' | 'delete'): string {
  return entry.ranges
    .filter((r) => r.kind === kind)
    .map((r) => r.text)
    .join('');
}

function snippetOf(entry: SuggestionScanEntry): string {
  switch (kindOf(entry)) {
    case 'insert':
      return truncate(joinedText(entry, 'insert'));
    case 'delete':
      return truncate(joinedText(entry, 'delete'));
    case 'replace':
      return `${truncate(joinedText(entry, 'delete'), 40)} → ${truncate(joinedText(entry, 'insert'), 40)}`;
  }
}

/** All pending proposals in the doc, in doc order. */
export function listSuggestions(doc: Y.Doc): SuggestionSummary[] {
  const scan = scanSuggestions(getProseFragment(doc));
  const summaries: Array<SuggestionSummary & { order: number }> = [];
  for (const [sid, entry] of scan) {
    const first = entry.ranges[0];
    summaries.push({
      sid,
      author: {
        id: entry.attrs.authorId,
        name: entry.attrs.authorName,
        color: entry.attrs.authorColor,
      },
      kind: kindOf(entry),
      snippet: snippetOf(entry),
      insertedText: joinedText(entry, 'insert'),
      deletedText: joinedText(entry, 'delete'),
      blockContext: blockContextOf(first),
      ts: entry.attrs.ts,
      order: first?.docOffset ?? 0,
    });
  }
  summaries.sort((a, b) => a.order - b.order);
  return summaries.map(({ order: _order, ...rest }) => rest);
}

/** Total character count of every Y.XmlText descendant of `el`. */
function totalTextLength(el: Y.XmlElement): number {
  let n = 0;
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) n += child.length;
    else if (child instanceof Y.XmlElement) n += totalTextLength(child);
  }
  return n;
}

/**
 * Remove blocks that a suggestion resolution emptied, so accepting a
 * whole-block deletion (or rejecting a whole-block insertion) leaves no
 * empty shell — same policy as the block-deletion API, applied at the point
 * the emptiness is created. Cascades upward: an emptied paragraph inside a
 * listItem takes the now-empty listItem (and a now-empty list) with it.
 * Must run inside the caller's transact.
 */
function removeEmptiedBlocks(blocks: Set<Y.XmlElement>): void {
  for (const block of blocks) {
    let node: Y.XmlElement = block;
    while (true) {
      if (totalTextLength(node) > 0) break;
      const parent = node.parent;
      if (!(parent instanceof Y.XmlFragment) && !(parent instanceof Y.XmlElement)) break;
      const idx = parent.toArray().indexOf(node);
      if (idx < 0) break; // already removed via an earlier cascade
      parent.delete(idx, 1);
      if (!(parent instanceof Y.XmlElement)) break; // reached the fragment
      node = parent;
    }
  }
}

function resolveOne(
  doc: Y.Doc,
  sid: string,
  action: 'accept' | 'reject',
  transactionOrigin: unknown,
): SuggestionOpResult {
  const fragment = getProseFragment(doc);
  const entry = scanSuggestions(fragment).get(sid);
  if (!entry) return { ok: false, error: 'not-found' };

  // Group ranges per node and apply in DESCENDING offset order so text
  // deletions don't shift the offsets of ranges we haven't touched yet.
  const byNode = new Map<Y.XmlText, SuggestionRange[]>();
  for (const r of entry.ranges) {
    const list = byNode.get(r.node) ?? [];
    list.push(r);
    byNode.set(r.node, list);
  }
  const affectedBlocks = new Set<Y.XmlElement>();
  for (const r of entry.ranges) if (r.block) affectedBlocks.add(r.block);

  doc.transact(() => {
    for (const ranges of byNode.values()) {
      ranges.sort((a, b) => b.offset - a.offset);
      for (const r of ranges) {
        const keep = action === 'accept' ? r.kind === 'insert' : r.kind === 'delete';
        if (keep) {
          const mark = r.kind === 'insert' ? SUGGEST_INSERT_MARK : SUGGEST_DELETE_MARK;
          r.node.format(r.offset, r.length, { [mark]: null });
        } else {
          r.node.delete(r.offset, r.length);
        }
      }
    }
    removeEmptiedBlocks(affectedBlocks);
  }, transactionOrigin);
  return { ok: true };
}

/**
 * Accept a proposal: suggestInsert marks are stripped (the text becomes
 * real), suggestDelete text is deleted. A block fully emptied by the
 * deletion is removed — no empty shell. Missing sid → not-found (also the
 * correct answer to the double-accept race).
 */
export function acceptSuggestion(
  doc: Y.Doc,
  sid: string,
  opts?: { transactionOrigin?: unknown },
): SuggestionOpResult {
  return resolveOne(doc, sid, 'accept', opts?.transactionOrigin ?? 'agent');
}

/**
 * Reject a proposal: suggestInsert text is deleted, suggestDelete marks are
 * stripped — restoring exactly the pre-suggestion text. A block that was
 * entirely a proposed insertion is removed.
 */
export function rejectSuggestion(
  doc: Y.Doc,
  sid: string,
  opts?: { transactionOrigin?: unknown },
): SuggestionOpResult {
  return resolveOne(doc, sid, 'reject', opts?.transactionOrigin ?? 'agent');
}

/** Accept or reject every pending proposal (optionally one author's). */
export function resolveAllSuggestions(
  doc: Y.Doc,
  opts: { action: 'accept' | 'reject'; authorId?: string; transactionOrigin?: unknown },
): { ok: true; resolved: number; sids: string[] } {
  const scan = scanSuggestions(getProseFragment(doc));
  const sids: string[] = [];
  for (const [sid, entry] of scan) {
    if (opts.authorId != null && entry.attrs.authorId !== opts.authorId) continue;
    sids.push(sid);
  }
  const resolvedSids: string[] = [];
  for (const sid of sids) {
    // Each resolution rescans, so earlier mutations can't stale-out later
    // sids' offsets; a sid another actor raced away just skips.
    const res = resolveOne(doc, sid, opts.action, opts.transactionOrigin ?? 'agent');
    if (res.ok) resolvedSids.push(sid);
  }
  return { ok: true, resolved: resolvedSids.length, sids: resolvedSids };
}

/**
 * The marks a proposed replacement must carry, so that accepting it produces
 * exactly what the direct edit path would have produced.
 *
 * Both paths now read the marks off the text being REPLACED
 * (`coveringInlineMarks`) rather than relying on Yjs' left-inheritance, which
 * answers with whatever precedes the match and therefore dropped the marks of
 * any span the match started at. Call this BEFORE mutating: `format(…,
 * {suggestDelete})` rewrites the delta.
 *
 * A zero-length range (a pure insertion at a point) has no replaced text to
 * read, so it keeps the old positional answer.
 */
function markedAttrsForSlices(
  slices: TextSlice[],
  fallback: { node: Y.XmlText; offset: number },
): Record<string, unknown> {
  const total = slices.reduce((n, s) => n + Math.max(0, s.length), 0);
  if (total === 0) return inlineAttrsAt(fallback.node, fallback.offset);
  return coveringInlineMarks(slices).attributes;
}

/**
 * Inline-mark attributes carried by the character at `offset`, with the
 * suggestion marks stripped out.
 *
 * An offset past the end falls back to the last op's marks, matching the
 * left-inheritance Yjs would have applied to an unattributed insert.
 */
function inlineAttrsAt(node: Y.XmlText, offset: number): Record<string, unknown> {
  const strip = (attrs: Record<string, unknown> | undefined): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(attrs ?? {})) {
      if (k === SUGGEST_INSERT_MARK || k === SUGGEST_DELETE_MARK) continue;
      if (v == null) continue;
      out[k] = v;
    }
    return out;
  };
  const delta = node.toDelta() as Array<{
    insert?: string;
    attributes?: Record<string, unknown>;
  }>;
  let cursor = 0;
  let last: Record<string, unknown> | undefined;
  for (const op of delta) {
    if (typeof op.insert !== 'string' || op.insert.length === 0) continue;
    last = op.attributes;
    if (offset < cursor + op.insert.length) return strip(op.attributes);
    cursor += op.insert.length;
  }
  return strip(last);
}

let sidCounter = 0;

function newSid(): string {
  sidCounter = (sidCounter + 1) % 36 ** 4;
  return `s-${Date.now().toString(36)}-${sidCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/**
 * The suggestion-creation primitive: resolve a find-range with the SAME
 * matching machinery findAndReplace uses (resolveSingleFind — extracted, not
 * duplicated), then apply the replacement AS a proposal — matched text marked
 * suggestDelete, replacement inserted with suggestInsert, one shared sid,
 * author from the caller. The accepted state (serialization) is unchanged
 * until someone accepts. An empty `replace` yields a pure deletion proposal.
 *
 * The find deliberately refuses to match inside another proposal's pending
 * `suggestInsert` text: anchoring proposal B onto text proposal A only
 * proposes means rejecting A silently takes B's target with it. Text marked
 * `suggestDelete` is still accepted state and remains a legal target.
 */
export function suggestReplace(
  doc: Y.Doc,
  opts: {
    find: string;
    replace: string;
    contextBefore?: string;
    contextAfter?: string;
    /** 1-indexed. When omitted, requires a unique match. */
    occurrence?: number;
    /** Parse inline markdown in `replace` into marks on the proposed text. */
    parseInlineMarks?: boolean;
    author: SuggestionAuthor;
    /** Creation timestamp override (epoch ms). Defaults to Date.now(). */
    ts?: number;
    transactionOrigin?: unknown;
  },
): SuggestReplaceResult {
  const fragment = getProseFragment(doc);
  const resolved = resolveSingleFind(fragment, { ...opts, excludePendingSuggestions: true });
  if (!resolved.ok) {
    if (resolved.error === 'ambiguous') {
      return { ok: false, error: 'ambiguous', candidates: resolved.candidates };
    }
    return { ok: false, error: resolved.error };
  }
  const { segment, offsetInNode, length } = resolved.match;
  // Read the replaced text's marks BEFORE the suggestDelete format rewrites
  // the delta, so the proposal carries the same bold/italic/code/link the
  // direct edit path would have inherited.
  const inherited = markedAttrsForSlices([{ node: segment.node, offset: offsetInNode, length }], {
    node: segment.node,
    offset: offsetInNode,
  });
  const sid = newSid();
  // Attribute types are load-bearing (the Yjs heading-level learnings):
  // four strings + a NUMBER ts, exactly what readers expect.
  const attrs: SuggestionAttrs = {
    sid,
    authorId: opts.author.id,
    authorName: opts.author.name,
    authorColor: opts.author.color,
    ts: opts.ts ?? Date.now(),
  };
  doc.transact(() => {
    segment.node.format(offsetInNode, length, { [SUGGEST_DELETE_MARK]: attrs });
    insertTextWithMarks(segment.node, offsetInNode + length, opts.replace, {
      parseInlineMarks: opts.parseInlineMarks === true,
      attributes: { ...inherited, [SUGGEST_INSERT_MARK]: attrs },
    });
  }, opts.transactionOrigin ?? 'agent');
  return { ok: true, sid };
}

/**
 * The anchor-based suggestion-creation primitive — the `rewrite_thread_region`
 * twin of `suggestReplace`. Resolves the SAME pair of Y.RelativePositions
 * `rewriteRange` uses (immune to concurrent edits, no offset re-derivation),
 * then applies the rewrite AS a proposal instead of a direct edit: the
 * anchored range is marked `suggestDelete` (not deleted), the replacement is
 * inserted marked `suggestInsert`, one shared sid, author from the caller.
 * Mirrors `rewriteRange`'s three cases:
 *   1. same Y.XmlText → format in place, insert the replacement right after.
 *   2. multiple Y.XmlTexts inside the SAME block (a mark boundary) → format
 *      every touched segment, insert the replacement into the FIRST touched
 *      node at the start offset — matching where `rewriteRange` inserts, so
 *      accepting the proposal reproduces exactly what an immediate
 *      `rewriteRange` call would have produced.
 *   3. spans multiple blocks → rejected (`cross-block`), same as `rewriteRange`.
 * An empty `replacement` yields a pure deletion proposal.
 */
export function suggestRewriteRange(
  doc: Y.Doc,
  opts: {
    startRel: Uint8Array;
    endRel: Uint8Array;
    replacement: string;
    /** Parse inline markdown in `replacement` into marks on the proposed text. */
    parseInlineMarks?: boolean;
    author: SuggestionAuthor;
    /** Creation timestamp override (epoch ms). Defaults to Date.now(). */
    ts?: number;
    transactionOrigin?: unknown;
  },
): SuggestRewriteRangeResult {
  const start = resolveRelativePositionRaw(doc, opts.startRel);
  const end = resolveRelativePositionRaw(doc, opts.endRel);
  if (!start || !end) return { ok: false, error: 'anchor-orphaned' };
  const parseInlineMarks = opts.parseInlineMarks === true;

  const sid = newSid();
  const attrs: SuggestionAttrs = {
    sid,
    authorId: opts.author.id,
    authorName: opts.author.name,
    authorColor: opts.author.color,
    ts: opts.ts ?? Date.now(),
  };

  if (start.node === end.node) {
    const from = Math.min(start.offset, end.offset);
    const to = Math.max(start.offset, end.offset);
    const inherited = markedAttrsForSlices(
      [{ node: start.node, offset: from, length: to - from }],
      {
        node: start.node,
        offset: from,
      },
    );
    doc.transact(() => {
      if (to > from) {
        start.node.format(from, to - from, { [SUGGEST_DELETE_MARK]: attrs });
      }
      insertTextWithMarks(start.node, to, opts.replacement, {
        parseInlineMarks,
        attributes: { ...inherited, [SUGGEST_INSERT_MARK]: attrs },
      });
    }, opts.transactionOrigin ?? 'agent');
    return { ok: true, sid };
  }

  // Cross-node. Walk the flattened fragment, locate the block each anchor is
  // in, and bail if they're in different blocks (same restriction rewriteRange
  // applies — joining blocks is out of scope for a text-range tool).
  const fragment = getProseFragment(doc);
  const { segments } = walkProse(fragment);
  const startSeg = segments.find((s) => s.node === start.node);
  const endSeg = segments.find((s) => s.node === end.node);
  if (!startSeg || !endSeg) return { ok: false, error: 'anchor-orphaned' };
  if (!startSeg.block || startSeg.block !== endSeg.block) {
    return { ok: false, error: 'cross-block' };
  }

  const firstSeg = startSeg.docOffset <= endSeg.docOffset ? startSeg : endSeg;
  const lastSeg = firstSeg === startSeg ? endSeg : startSeg;
  const firstOffset = firstSeg === startSeg ? start.offset : end.offset;
  const lastOffset = lastSeg === endSeg ? end.offset : start.offset;
  const blockSegments = segments.filter((s) => s.block === startSeg.block);
  const firstIdx = blockSegments.indexOf(firstSeg);
  const lastIdx = blockSegments.indexOf(lastSeg);
  const touched = blockSegments.slice(firstIdx, lastIdx + 1);

  const inherited = markedAttrsForSlices(
    touched.map((seg, i) => ({
      node: seg.node,
      offset: i === 0 ? firstOffset : 0,
      length: (i === touched.length - 1 ? lastOffset : seg.length) - (i === 0 ? firstOffset : 0),
    })),
    { node: touched[0]!.node, offset: firstOffset },
  );
  doc.transact(() => {
    for (let i = 0; i < touched.length; i++) {
      const seg = touched[i]!;
      const from = i === 0 ? firstOffset : 0;
      const to = i === touched.length - 1 ? lastOffset : seg.length;
      if (to > from) seg.node.format(from, to - from, { [SUGGEST_DELETE_MARK]: attrs });
    }
    insertTextWithMarks(touched[0]!.node, firstOffset, opts.replacement, {
      parseInlineMarks,
      attributes: { ...inherited, [SUGGEST_INSERT_MARK]: attrs },
    });
  }, opts.transactionOrigin ?? 'agent');
  return { ok: true, sid };
}
