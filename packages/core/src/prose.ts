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
import { LCS_CELL_BUDGET, lcsKept } from './lcs.ts';
import { SUGGEST_DELETE_MARK, SUGGEST_INSERT_MARK } from './suggest.ts';

export const PROSE_FRAGMENT_KEY = 'prose';

export function getProseFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(PROSE_FRAGMENT_KEY);
}

/** A single source text segment + the Y.XmlText it came from. */
export interface TextSegment {
  node: Y.XmlText;
  /** Offset of this segment's start within the flattened doc text. */
  docOffset: number;
  /** Length of this segment (= node.length at walk time). */
  length: number;
  /** Innermost block the text lives inside (paragraph inside table cell, etc.). */
  block: Y.XmlElement | null;
  /** Innermost block tag name. */
  blockType: string | null;
  /** TOP-LEVEL block the text lives inside (table, heading, paragraph at doc root).
   *  Differs from `block` for nested structures — a table cell's paragraph has
   *  blockType='paragraph' but topBlockType='table'. Used by get_doc to surface
   *  structural containers (tables, lists) as one logical block instead of N. */
  topBlock: Y.XmlElement | null;
  topBlockType: string | null;
  /** If a heading, its level attribute. */
  headingLevel?: number;
}

/**
 * Walk the fragment depth-first, emitting every Y.XmlText leaf with a
 * running offset into the flattened doc text. Block nodes contribute a
 * synthetic "\n\n" separator between them so the flat text has paragraph
 * breaks — but the separator is NOT part of any node (no way to edit it
 * via find_and_replace, which is what we want).
 */
export function walkProse(fragment: Y.XmlFragment): {
  plainText: string;
  segments: TextSegment[];
} {
  const segments: TextSegment[] = [];
  let plainText = '';
  let docOffset = 0;

  const visit = (
    node: Y.XmlElement | Y.XmlText | Y.XmlFragment,
    currentBlock: Y.XmlElement | null,
    topBlock: Y.XmlElement | null,
  ): void => {
    if (node instanceof Y.XmlText) {
      const length = node.length;
      segments.push({
        node,
        docOffset,
        length,
        block: currentBlock,
        blockType: currentBlock?.nodeName ?? null,
        topBlock,
        topBlockType: topBlock?.nodeName ?? null,
        headingLevel:
          currentBlock?.nodeName === 'heading' ? headingLevelOf(currentBlock) : undefined,
      });
      // IMPORTANT: toString() includes XML wrappers around marks
      // (e.g. "<bold>hello</bold>") but node.length is the unmarked
      // character count (5). If we used toString() here, plainText
      // would grow faster than docOffset and every segment after a
      // marked span would have an incorrect offset — find_and_replace
      // would silently no-match or land edits in the wrong place.
      // toDelta() gives us the raw insert strings without the wrappers.
      for (const op of node.toDelta() as Array<{ insert?: string }>) {
        if (typeof op.insert === 'string') plainText += op.insert;
      }
      docOffset += length;
      return;
    }
    if (node instanceof Y.XmlElement) {
      // New block? Insert a paragraph break before it (but not at the start).
      if (isBlock(node.nodeName) && plainText.length > 0 && !plainText.endsWith('\n\n')) {
        plainText += '\n\n';
        docOffset += 2;
      }
      const childBlock = isBlock(node.nodeName) ? node : currentBlock;
      // topBlock sticks to the first block we entered — doesn't update for
      // nested blocks inside it (so table-cell text reports topBlock=table).
      const childTop = isBlock(node.nodeName) ? (topBlock ?? node) : topBlock;
      for (const child of node.toArray())
        visit(child as Y.XmlElement | Y.XmlText, childBlock, childTop);
      return;
    }
    // Y.XmlFragment (top-level)
    for (const child of node.toArray())
      visit(child as Y.XmlElement | Y.XmlText, currentBlock, topBlock);
  };

  visit(fragment, null, null);
  return { plainText, segments };
}

function isBlock(tag: string): boolean {
  // Any prosemirror block node that can contain text. The list here
  // matches tiptap-starter-kit's defaults plus @tiptap/extension-table.
  return (
    tag === 'paragraph' ||
    tag === 'heading' ||
    tag === 'blockquote' ||
    tag === 'codeBlock' ||
    tag === 'bulletList' ||
    tag === 'orderedList' ||
    tag === 'listItem' ||
    tag === 'horizontalRule' ||
    tag === 'table' ||
    tag === 'tableRow' ||
    tag === 'tableCell' ||
    tag === 'tableHeader'
  );
}

export interface LocatedMatch {
  segment: TextSegment;
  /** Offset INSIDE the segment's Y.XmlText where the match starts. */
  offsetInNode: number;
  /** Length of the match. */
  length: number;
  /** Start of the match in flattened doc text. */
  docOffset: number;
}

/**
 * Doc-offset spans covered by `suggestInsert` — i.e. text that exists in the
 * live doc but is NOT part of the accepted state. a reviewerf-open [start, end).
 */
function pendingInsertSpans(segments: TextSegment[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const seg of segments) {
    let offset = 0;
    for (const op of seg.node.toDelta() as Array<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>) {
      if (typeof op.insert !== 'string') continue;
      if (op.attributes?.[SUGGEST_INSERT_MARK] != null) {
        spans.push([seg.docOffset + offset, seg.docOffset + offset + op.insert.length]);
      }
      offset += op.insert.length;
    }
  }
  return spans;
}

/**
 * Locate `find` in the flattened doc text, optionally requiring a
 * surrounding context. Returns all match positions mapped back to
 * (Y.XmlText, local offset) so the caller can mutate in place.
 *
 * Matches that straddle two Y.XmlText nodes are omitted and returned as
 * a separate `crossNode` count so the caller can report a meaningful
 * error without silently skipping content.
 *
 * `excludePendingSuggestions` drops matches that overlap text marked
 * `suggestInsert` — text a human hasn't accepted yet. A caller creating a
 * NEW proposal must not anchor onto an unaccepted one (rejecting the first
 * would take the second's target with it); the dropped count comes back as
 * `pendingSkipped` so the caller can say so instead of reporting a bare
 * no-match. `suggestDelete` text is still accepted state and stays matchable.
 */
export function locateMatches(
  fragment: Y.XmlFragment,
  opts: {
    find: string;
    contextBefore?: string;
    contextAfter?: string;
    excludePendingSuggestions?: boolean;
  },
): { matches: LocatedMatch[]; crossNode: number; pendingSkipped: number; plainText: string } {
  const { plainText, segments } = walkProse(fragment);
  const find = opts.find;
  if (find.length === 0) return { matches: [], crossNode: 0, pendingSkipped: 0, plainText };

  const before = opts.contextBefore ?? '';
  const after = opts.contextAfter ?? '';
  const pattern = before + find + after;

  const raw: Array<{ docOffset: number }> = [];
  let i = 0;
  while (true) {
    const idx = plainText.indexOf(pattern, i);
    if (idx < 0) break;
    raw.push({ docOffset: idx + before.length });
    i = idx + 1; // allow overlapping contexts
  }

  const pending = opts.excludePendingSuggestions === true ? pendingInsertSpans(segments) : [];

  const matches: LocatedMatch[] = [];
  let crossNode = 0;
  let pendingSkipped = 0;
  for (const r of raw) {
    const seg = findSegmentForOffset(segments, r.docOffset);
    if (!seg) continue;
    const offsetInNode = r.docOffset - seg.docOffset;
    if (offsetInNode + find.length > seg.length) {
      // Match spans a segment boundary — skip for MVP.
      crossNode++;
      continue;
    }
    const end = r.docOffset + find.length;
    if (pending.some(([ps, pe]) => r.docOffset < pe && ps < end)) {
      pendingSkipped++;
      continue;
    }
    matches.push({
      segment: seg,
      offsetInNode,
      length: find.length,
      docOffset: r.docOffset,
    });
  }
  return { matches, crossNode, pendingSkipped, plainText };
}

function findSegmentForOffset(segments: TextSegment[], offset: number): TextSegment | null {
  for (const s of segments) {
    if (offset >= s.docOffset && offset < s.docOffset + s.length) return s;
  }
  return null;
}

export interface ReplaceResult {
  ok: boolean;
  error?:
    | 'no-match'
    | 'ambiguous'
    | 'cross-node'
    | 'out-of-range'
    | 'occurrence-out-of-range'
    | 'replace-all-with-occurrence';
  /** For ambiguous results, a short preview of each candidate's neighbourhood. */
  candidates?: Array<{ docOffset: number; preview: string }>;
  /** replaceAll only: how many occurrences were replaced. */
  replaced?: number;
  /** replaceAll only, present when non-zero: matches that straddled two
   *  Y.XmlText nodes and were left untouched. The sweep is still ok — but a
   *  count the caller cannot see is a match silently skipped. */
  skippedCrossNode?: number;
  /** Mark keys (bold/italic/code/link/strike) that covered only PART of the
   *  replaced text, so they could not be carried onto the replacement. Present
   *  only when non-empty — a formatting loss this call could not avoid has to
   *  be VISIBLE to the caller rather than inferred from the doc afterwards. */
  marksDropped?: string[];
  /** Human-readable companion to `marksDropped`. */
  warning?: string;
  /** On `no-match` only: a NEAR miss a fallback scan found. `kind: 'case'`
   *  means the pattern is in the doc up to letter case; `kind: 'whitespace'`
   *  means it matches once whitespace runs are collapsed (double spaces,
   *  NBSP, newlines). `preview` shows the DOC's actual characters — newlines
   *  included, NOT flattened to spaces — so the caller can re-issue the find
   *  verbatim instead of falling back to a raw disk write. A preview that
   *  spans a block boundary quotes the flattened text's `\n\n` separator;
   *  re-issuing that find reports `cross-node` (the separator is not
   *  editable text), which is a terminal answer rather than a loop. Absent
   *  when the text is genuinely not there. */
  hint?: NoMatchHint;
}

/** See `ReplaceResult.hint`. */
export interface NoMatchHint {
  kind: 'case' | 'whitespace';
  preview: string;
}

/** A contiguous slice of one Y.XmlText, in document order. */
export interface TextSlice {
  node: Y.XmlText;
  offset: number;
  length: number;
}

const SUGGEST_MARK_KEYS = new Set<string>([SUGGEST_INSERT_MARK, SUGGEST_DELETE_MARK]);

/** Per-run inline attributes over [offset, offset+length) of one node, with
 *  suggestion bookkeeping marks stripped (they are never content). */
function runAttrsOverSlice(
  node: Y.XmlText,
  offset: number,
  length: number,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (length <= 0) return out;
  const end = offset + length;
  let cursor = 0;
  for (const op of node.toDelta() as Array<{
    insert?: string;
    attributes?: Record<string, unknown>;
  }>) {
    if (typeof op.insert !== 'string' || op.insert.length === 0) continue;
    const runStart = cursor;
    cursor += op.insert.length;
    if (cursor <= offset) continue;
    if (runStart >= end) break;
    const attrs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(op.attributes ?? {})) {
      if (SUGGEST_MARK_KEYS.has(k) || v == null) continue;
      attrs[k] = v;
    }
    out.push(attrs);
  }
  return out;
}

/**
 * The inline marks that cover EVERY character of the given slices, plus the
 * keys of marks that cover only some of them.
 *
 * This is what a replacement has to be inserted WITH. Yjs's unattributed
 * `Y.XmlText.insert` inherits the formatting of the character to the LEFT of
 * the insertion point — which is the right answer only when the match starts
 * strictly inside a marked run. A match that begins at a run's FIRST character
 * (very often the whole run: a bold label, a link, an inline-code span) has an
 * unmarked left neighbour, so the replacement came back plain, and when the
 * match covered the run entirely the mark disappeared from the document with
 * no error. Reading the marks off the text being replaced — which is what the
 * suggestion path always did — removes the dependency on what happens to sit
 * to the left.
 *
 * Marks that cover only part of the range cannot be carried: the replacement
 * is one string with no correspondence to the runs it replaces. Those come
 * back as `dropped` so the caller can say so instead of losing them quietly.
 */
export function coveringInlineMarks(slices: TextSlice[]): {
  attributes: Record<string, unknown>;
  dropped: string[];
} {
  const runs = slices.flatMap((s) => runAttrsOverSlice(s.node, s.offset, s.length));
  if (runs.length === 0) return { attributes: {}, dropped: [] };
  const keys = new Set<string>();
  for (const r of runs) for (const k of Object.keys(r)) keys.add(k);
  const attributes: Record<string, unknown> = {};
  for (const k of keys) {
    const first = runs[0]?.[k];
    if (first === undefined) continue;
    const encoded = JSON.stringify(first);
    if (runs.every((r) => k in r && JSON.stringify(r[k]) === encoded)) attributes[k] = first;
  }
  const dropped = [...keys].filter((k) => !(k in attributes)).sort();
  return { attributes, dropped };
}

function marksReport(dropped: string[]): { marksDropped?: string[]; warning?: string } {
  if (dropped.length === 0) return {};
  return {
    marksDropped: dropped,
    warning:
      `The replaced text was not uniformly formatted: ${dropped.join(', ')} covered only part ` +
      'of it, so the mark could not be carried onto the replacement. Re-apply it with ' +
      'parseInlineMarks if you need it back.',
  };
}

/**
 * Insert `text` into `node` at `offset`. When `parseInlineMarks` is true,
 * the text is tokenized via `inlineMarksToDelta` and inserted via
 * `applyDelta` so `[label](url)`, `**bold**`, `*italic*`, `` `code` ``,
 * and `~~strike~~` syntax in the input becomes real marks on the inserted
 * text. When false (default), the text is inserted as plain characters
 * and the insertion inherits any marks at `offset` from the surrounding
 * text — the original behavior.
 *
 * We use `applyDelta` rather than a loop of `insert(cursor, str, attrs)`
 * calls because per-call attributes set Yjs's open-mark state forward —
 * a subsequent unmarked `insert(cursor, plain)` then picks up the prior
 * marks and bleeds them into surrounding text. `applyDelta` treats each
 * op's attributes as scoped to that op's insert.
 *
 * `attributes` force marks onto the inserted text. Callers that want the
 * plain-insert inheritance MUST omit it — passing explicit attributes to
 * `Y.XmlText.insert` REPLACES what would have been inherited, so a caller
 * with its own mark to add (the suggestion path's `suggestInsert`) has to
 * merge the surrounding marks in itself. Per-op marks parsed out of the
 * text win over `attributes` on a key collision: explicit beats inherited.
 *
 * An EMPTY `attributes` object is not the same as omitting it: it means "this
 * text carries no marks", and it must suppress the left-inheritance too. A
 * caller that computed the marks of the text it is replacing (see
 * `coveringInlineMarks`) has an answer even when that answer is "none", and
 * silently falling back to whatever sits to the left would re-introduce the
 * mark bleed in the other direction — plain text picking up the bold of the
 * run in front of it.
 */
export function insertTextWithMarks(
  node: Y.XmlText,
  offset: number,
  text: string,
  opts?: { parseInlineMarks?: boolean; attributes?: Record<string, unknown> },
): void {
  if (text.length === 0) return;
  const extra = opts?.attributes;
  if (opts?.parseInlineMarks !== true) {
    if (extra) node.insert(offset, text, extra);
    else node.insert(offset, text);
    return;
  }
  const delta = inlineMarksToDelta(text).map((op) =>
    extra ? { ...op, attributes: { ...extra, ...(op.attributes ?? {}) } } : op,
  );
  const positioned: Array<{
    retain?: number;
    insert?: string;
    attributes?: Record<string, unknown>;
  }> = offset > 0 ? [{ retain: offset }, ...delta] : [...delta];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node.applyDelta(positioned as any);
}

/**
 * Resolve a find (with optional context) and replace it in place. The
 * replacement is inserted into the SAME Y.XmlText node, carrying the marks
 * (bold, italic, code, link, strike) that covered the matched text — which is
 * what you want when fixing a typo inside an italicized span, and equally
 * when the match IS the whole bold label.
 *
 * Marks that covered only PART of the match cannot be carried onto a single
 * replacement string; those come back as `marksDropped` rather than being
 * lost quietly.
 *
 * Pass `parseInlineMarks: true` to interpret `[label](url)` / `**bold**`
 * / `*italic*` / `` `code` `` / `~~strike~~` syntax in the `replace`
 * string as marks on the inserted text (instead of literal characters).
 */
export function findAndReplace(
  doc: Y.Doc,
  opts: {
    find: string;
    replace: string;
    contextBefore?: string;
    contextAfter?: string;
    /** 1-indexed. When omitted, requires a unique match. */
    occurrence?: number;
    /** Replace EVERY occurrence in one transaction instead of requiring a
     *  unique match. Mutually exclusive with `occurrence`. Default false. */
    replaceAll?: boolean;
    /** Parse inline markdown in `replace` into Yjs marks. Default false. */
    parseInlineMarks?: boolean;
    transactionOrigin?: unknown;
  },
): ReplaceResult {
  if (opts.replaceAll === true && opts.occurrence != null) {
    // The two answer opposite questions — "which one" vs "all of them" —
    // and guessing which the caller meant would silently do the other.
    return { ok: false, error: 'replace-all-with-occurrence' };
  }
  const fragment = getProseFragment(doc);
  const { matches, crossNode, plainText } = locateMatches(fragment, opts);

  if (matches.length === 0) {
    if (crossNode > 0) return { ok: false, error: 'cross-node' };
    const hint = noMatchHint(plainText, opts);
    return hint ? { ok: false, error: 'no-match', hint } : { ok: false, error: 'no-match' };
  }

  if (opts.replaceAll === true) {
    // locateMatches allows overlapping matches (context disambiguation needs
    // them); a sweep must not apply two matches over the same characters.
    // Keep greedy left-to-right, like String.replaceAll.
    const kept: LocatedMatch[] = [];
    let lastEnd = -1;
    for (const m of matches) {
      if (m.docOffset < lastEnd) continue;
      kept.push(m);
      lastEnd = m.docOffset + m.length;
    }
    const droppedUnion = new Set<string>();
    doc.transact(() => {
      // Apply in DESCENDING docOffset order so every earlier offset — both
      // the doc-wide walk offsets and each node-local offsetInNode — is
      // still valid when its turn comes: edits only ever land at or above
      // the position about to be edited next.
      for (let i = kept.length - 1; i >= 0; i--) {
        const m = kept[i]!;
        // Per-site mark carry, read immediately before this site's delete —
        // a bold occurrence stays bold, a plain one stays plain.
        const siteMarks = coveringInlineMarks([
          { node: m.segment.node, offset: m.offsetInNode, length: m.length },
        ]);
        for (const k of siteMarks.dropped) droppedUnion.add(k);
        m.segment.node.delete(m.offsetInNode, m.length);
        insertTextWithMarks(m.segment.node, m.offsetInNode, opts.replace, {
          parseInlineMarks: opts.parseInlineMarks === true,
          attributes: siteMarks.attributes,
        });
      }
    }, opts.transactionOrigin ?? 'agent');
    return {
      ok: true,
      replaced: kept.length,
      ...(crossNode > 0 ? { skippedCrossNode: crossNode } : {}),
      ...marksReport([...droppedUnion]),
    };
  }

  let chosen: LocatedMatch;
  if (opts.occurrence != null) {
    if (opts.occurrence < 1 || opts.occurrence > matches.length) {
      return { ok: false, error: 'occurrence-out-of-range' };
    }
    chosen = matches[opts.occurrence - 1]!;
  } else if (matches.length > 1) {
    const candidates = matches.map((m) => ({
      docOffset: m.docOffset,
      preview: preview(plainText, m.docOffset, m.length),
    }));
    return { ok: false, error: 'ambiguous', candidates };
  } else {
    chosen = matches[0]!;
  }

  // Read the marks off the text being replaced BEFORE deleting it: once the
  // characters are gone there is nothing left to read, and Yjs' own
  // left-inheritance answers with whatever precedes the match instead.
  const marks = coveringInlineMarks([
    { node: chosen.segment.node, offset: chosen.offsetInNode, length: chosen.length },
  ]);

  doc.transact(() => {
    chosen.segment.node.delete(chosen.offsetInNode, chosen.length);
    insertTextWithMarks(chosen.segment.node, chosen.offsetInNode, opts.replace, {
      parseInlineMarks: opts.parseInlineMarks === true,
      attributes: marks.attributes,
    });
  }, opts.transactionOrigin ?? 'agent');

  return { ok: true, ...marksReport(marks.dropped) };
}

/**
 * `verbatim` keeps newlines as-is instead of flattening them to spaces.
 * The flattened form is for DISPLAY (ambiguous-match candidate lists); a
 * near-miss hint must quote the doc's characters byte-for-byte, because the
 * caller is told to re-issue the find from it — flattening a newline there
 * hands back the exact string that just failed, an infinite loop.
 */
function preview(text: string, at: number, length: number, verbatim = false): string {
  const pad = 24;
  const start = Math.max(0, at - pad);
  const end = Math.min(text.length, at + length + pad);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const body = text.slice(start, end);
  return prefix + (verbatim ? body : body.replace(/\n/g, ' ')) + suffix;
}

/**
 * Fallback scans behind a bare no-match: is the pattern in the doc up to
 * letter case, or up to whitespace runs? A mechanical sweep that mis-cases a
 * SHA, or single-spaces a double-spaced sentence, otherwise learns nothing
 * from `no-match` — and the measured next move was a raw disk write against
 * the bound file. The scan covers the FULL pattern (context included),
 * because that is the string that failed to match; the preview quotes the
 * doc's own characters so the caller can re-issue the find verbatim.
 *
 * Returns undefined when the exact pattern IS present (the no-match then has
 * a different cause — e.g. a segment-boundary straddle — and a "case" hint
 * would mislead) and when the text is genuinely absent. Case+whitespace
 * combined misses are deliberately not chased: two stacked normalizations
 * make the preview an ever-looser guess.
 */
function noMatchHint(
  plainText: string,
  opts: { find: string; contextBefore?: string; contextAfter?: string },
): NoMatchHint | undefined {
  const pattern = (opts.contextBefore ?? '') + opts.find + (opts.contextAfter ?? '');
  if (pattern.length === 0 || plainText.includes(pattern)) return undefined;

  const ci = plainText.toLowerCase().indexOf(pattern.toLowerCase());
  if (ci >= 0) return { kind: 'case', preview: preview(plainText, ci, pattern.length, true) };

  const hay = collapseWhitespace(plainText);
  const needle = collapseWhitespace(pattern).text;
  if (needle.length === 0) return undefined;
  const wi = hay.text.indexOf(needle);
  if (wi >= 0) {
    const startOrig = hay.map[wi] ?? 0;
    const endOrig =
      wi + needle.length < hay.map.length
        ? (hay.map[wi + needle.length] ?? plainText.length)
        : plainText.length;
    return {
      kind: 'whitespace',
      preview: preview(plainText, startOrig, endOrig - startOrig, true),
    };
  }
  return undefined;
}

/** Collapse every whitespace run (space, NBSP, tab, newline — all of `\s`)
 *  to a single space. `map[i]` is the original index of collapsed char `i`
 *  (a run maps to its first character), so a hit in the collapsed text can
 *  be quoted from the original. */
function collapseWhitespace(text: string): { text: string; map: number[] } {
  let out = '';
  const map: number[] = [];
  let i = 0;
  while (i < text.length) {
    map.push(i);
    if (/\s/.test(text[i] as string)) {
      out += ' ';
      i++;
      while (i < text.length && /\s/.test(text[i] as string)) i++;
    } else {
      out += text[i] as string;
      i++;
    }
  }
  return { text: out, map };
}

/** Resolve a serialized Y.RelativePosition to an absolute position in
 *  the flattened prose text. Returns null if the anchor no longer
 *  references a valid point in the doc. */
export function resolveRelativePosition(doc: Y.Doc, encoded: Uint8Array): number | null {
  const abs = resolveRelativePositionRaw(doc, encoded);
  if (!abs) return null;
  const fragment = getProseFragment(doc);
  const { segments } = walkProse(fragment);
  for (const s of segments) {
    if (s.node === abs.node) return s.docOffset + abs.offset;
  }
  return null;
}

/** Same resolution, but returns the Y.XmlText + local offset so callers
 *  that need to mutate (splice, insert) can operate directly on the node.
 *
 *  An anchor whose bytes don't decode answers null, exactly like one that no
 *  longer resolves. This is the single busiest reader of a stored anchor, and
 *  most of its callers run inside a Yjs observer where a throw would land on
 *  an unrelated request. */
export function resolveRelativePositionRaw(
  doc: Y.Doc,
  encoded: Uint8Array,
): { node: Y.XmlText; offset: number } | null {
  const rel = decodeRelativePositionSafe(encoded);
  if (!rel) return null;
  const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
  if (!abs) return null;
  if (!(abs.type instanceof Y.XmlText)) return null;
  return { node: abs.type, offset: abs.index };
}

export interface AnchoredEditResult {
  ok: boolean;
  error?: 'anchor-not-found' | 'anchor-orphaned' | 'cross-block' | 'no-host-block' | 'parse-failed';
  /** See `ReplaceResult.marksDropped` — same contract, same reason. */
  marksDropped?: string[];
  warning?: string;
}

/**
 * Replace the text spanned by two serialized Y.RelativePositions with a
 * new string, inside a single Yjs transaction.
 *
 * Handles three cases:
 *   1. same Y.XmlText → splice in place (the common case).
 *   2. multiple Y.XmlTexts inside the SAME block element (happens when
 *      the range crosses a mark boundary — bold, italic, link) → delete
 *      the tail of the first, wipe any middles, delete the head of the
 *      last, insert the replacement at the first position.
 *   3. spans multiple blocks → rejected (`cross-block`). Joining blocks
 *      by deleting block boundaries would require restructuring the XML
 *      tree, which is out of scope for a text-range tool. Use
 *      `insertBlocksAfterAnchor` + manual cleanup if you really need it.
 */
export function rewriteRange(
  doc: Y.Doc,
  opts: {
    startRel: Uint8Array;
    endRel: Uint8Array;
    replacement: string;
    /** Parse inline markdown in `replacement` into Yjs marks. Default false. */
    parseInlineMarks?: boolean;
    transactionOrigin?: unknown;
  },
): AnchoredEditResult {
  const start = resolveRelativePositionRaw(doc, opts.startRel);
  const end = resolveRelativePositionRaw(doc, opts.endRel);
  if (!start || !end) return { ok: false, error: 'anchor-orphaned' };
  const parseInlineMarks = opts.parseInlineMarks === true;

  if (start.node === end.node) {
    const from = Math.min(start.offset, end.offset);
    const to = Math.max(start.offset, end.offset);
    const marks = coveringInlineMarks([{ node: start.node, offset: from, length: to - from }]);
    doc.transact(() => {
      start.node.delete(from, to - from);
      insertTextWithMarks(start.node, from, opts.replacement, {
        parseInlineMarks,
        attributes: marks.attributes,
      });
    }, opts.transactionOrigin ?? 'agent');
    return { ok: true, ...marksReport(marks.dropped) };
  }

  // Cross-node. Walk the flattened fragment, locate the block each
  // anchor is in, and bail if they're in different blocks.
  const fragment = getProseFragment(doc);
  const { segments } = walkProse(fragment);
  const startSeg = segments.find((s) => s.node === start.node);
  const endSeg = segments.find((s) => s.node === end.node);
  if (!startSeg || !endSeg) return { ok: false, error: 'anchor-orphaned' };
  if (!startSeg.block || startSeg.block !== endSeg.block) {
    return { ok: false, error: 'cross-block' };
  }

  // Order the two endpoints by flattened docOffset so we always iterate
  // left-to-right regardless of which anchor was which.
  const firstSeg = startSeg.docOffset <= endSeg.docOffset ? startSeg : endSeg;
  const lastSeg = firstSeg === startSeg ? endSeg : startSeg;
  const firstOffset = firstSeg === startSeg ? start.offset : end.offset;
  const lastOffset = lastSeg === endSeg ? end.offset : start.offset;
  const blockSegments = segments.filter((s) => s.block === startSeg.block);
  const firstIdx = blockSegments.indexOf(firstSeg);
  const lastIdx = blockSegments.indexOf(lastSeg);
  const touched = blockSegments.slice(firstIdx, lastIdx + 1);

  const slices: TextSlice[] = touched.map((seg, i) => {
    if (i === touched.length - 1) return { node: seg.node, offset: 0, length: lastOffset };
    if (i === 0) {
      return { node: seg.node, offset: firstOffset, length: seg.length - firstOffset };
    }
    return { node: seg.node, offset: 0, length: seg.length };
  });
  const marks = coveringInlineMarks(slices);

  doc.transact(() => {
    // Delete from the END so earlier node indices don't shift.
    for (let i = touched.length - 1; i >= 0; i--) {
      const seg = touched[i]!;
      if (i === touched.length - 1) {
        seg.node.delete(0, lastOffset);
      } else if (i === 0) {
        seg.node.delete(firstOffset, seg.length - firstOffset);
      } else {
        seg.node.delete(0, seg.length);
      }
    }
    insertTextWithMarks(touched[0]!.node, firstOffset, opts.replacement, {
      parseInlineMarks,
      attributes: marks.attributes,
    });
  }, opts.transactionOrigin ?? 'agent');
  return { ok: true, ...marksReport(marks.dropped) };
}

/**
 * Append text at the end of the range described by a pair of
 * Y.RelativePositions. Useful for "add a note after the sentence this
 * thread is on." Operates in the SAME Y.XmlText as the end anchor, so
 * any marks covering the end position carry to the new text.
 */
export function insertAfterRange(
  doc: Y.Doc,
  opts: {
    endRel: Uint8Array;
    text: string;
    transactionOrigin?: unknown;
  },
): AnchoredEditResult {
  const end = resolveRelativePositionRaw(doc, opts.endRel);
  if (!end) return { ok: false, error: 'anchor-orphaned' };
  if (opts.text.length === 0) return { ok: true };
  doc.transact(() => {
    end.node.insert(end.offset, opts.text);
  }, opts.transactionOrigin ?? 'agent');
  return { ok: true };
}

/**
 * Parse a small subset of markdown into Y.XmlElement blocks matching
 * tiptap-starter-kit's schema. Enough for the agent to answer "add a
 * section", "insert a bullet list", "add a heading" without having to
 * build XmlElement trees by hand.
 *
 * Supported:
 *   # / ## / ###        → heading (level from # count)
 *   -, *                → bulletList > listItem > paragraph
 *   1.                  → orderedList > listItem > paragraph
 *   >                   → blockquote > paragraph
 *   ```                 → codeBlock
 *   ---                 → horizontalRule
 *   (anything else)     → paragraph (blank lines split paragraphs)
 *
 * Deliberately NOT a full markdown parser. Inline marks (bold/italic/
 * links) come through as literal text for now — the agent can follow
 * up with find_and_replace or edit_at_anchor to add marks later.
 */
/**
 * Tokenize a line of inline prose into a Yjs delta with mark attributes.
 * Handles the common syntax round-tripped by tiptap-markdown:
 *   `code`   **bold**   *italic*   ~~strike~~   [text](url)
 * Underscore variants (__bold__, _italic_) are supported too.
 * Ambiguous text (unpaired asterisks etc.) passes through literal.
 */
export function inlineMarksToDelta(
  text: string,
): Array<{ insert: string; attributes?: Record<string, unknown> }> {
  const out: Array<{ insert: string; attributes?: Record<string, unknown> }> = [];
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf.length === 0) return;
    out.push({ insert: buf });
    buf = '';
  };
  const emitWith = (inner: string, attrs: Record<string, unknown>) => {
    flush();
    const nested = inlineMarksToDelta(inner);
    for (const op of nested) {
      out.push({
        insert: op.insert,
        attributes: { ...(op.attributes ?? {}), ...attrs },
      });
    }
  };

  while (i < text.length) {
    const r = text.slice(i);

    // `code`
    if (r.startsWith('`')) {
      const close = r.indexOf('`', 1);
      if (close > 1) {
        flush();
        out.push({ insert: r.slice(1, close), attributes: { code: true } });
        i += close + 1;
        continue;
      }
    }

    // [text](url) — the label is parsed recursively so `[**b**](u)` (which
    // is what the serializer emits for a bold link: link outermost) reads
    // back as bold+link rather than as a link whose text is literally `**b**`.
    if (r.startsWith('[')) {
      const rb = r.indexOf(']');
      if (rb > 0 && r[rb + 1] === '(') {
        const rp = r.indexOf(')', rb + 2);
        if (rp > 0) {
          emitWith(r.slice(1, rb), { link: { href: r.slice(rb + 2, rp) } });
          i += rp + 1;
          continue;
        }
      }
    }

    // ~~strike~~
    if (r.startsWith('~~')) {
      const close = r.indexOf('~~', 2);
      if (close > 2) {
        emitWith(r.slice(2, close), { strike: true });
        i += close + 2;
        continue;
      }
    }

    // 2-char wrappers: **bold** / __bold__
    let matched = false;
    for (const m of ['**', '__'] as const) {
      if (r.startsWith(m)) {
        const close = findEmphasisClose(r, m);
        if (close > m.length) {
          emitWith(r.slice(m.length, close), { bold: true });
          i += close + m.length;
          matched = true;
          break;
        }
      }
    }
    if (matched) continue;

    // 1-char wrappers: *italic* / _italic_
    // Require the inner char to be non-space so "a * b" doesn't italicize.
    for (const m of ['*', '_'] as const) {
      if (!r.startsWith(m) || !r[1] || r[1] === ' ' || r[1] === m) continue;
      // CommonMark: underscore emphasis does NOT open/close intra-word
      // (asterisk does). Without this, snake_case identifiers like
      // `estimated_effort_h` get parsed as `estimated`+<em>effort</em>+`h`
      // and round-trip back to `estimated*effort*h` — which broke bound-doc
      // editing of any doc full of snake_case field names.
      if (m === '_' && /\w/.test(i > 0 ? (text[i - 1] ?? '') : '')) continue;
      const close = findEmphasisClose(r, m);
      if (close > 1 && r[close - 1] !== ' ') {
        if (m === '_' && /\w/.test(r[close + 1] ?? '')) continue;
        emitWith(r.slice(1, close), { italic: true });
        i += close + 1;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    buf += text[i];
    i++;
  }
  flush();
  return out;
}

/**
 * Find the index (in `r`) of the delimiter run that closes an emphasis span
 * opened by `delim` (`*`, `**`, `_` or `__`) at the start of `r`. Returns -1
 * when there is no closer.
 *
 * A plain `indexOf` cannot read nested emphasis: in `**a *b***` the first
 * `**` after the opener is INSIDE the closing `***`, so the bold ended one
 * character early and the italic never parsed. The serializer legitimately
 * emits exactly that shape (bold containing an italic that ends where the
 * bold ends), so the parser has to read it back or the round-trip loses the
 * mark. The rule: walk delimiter RUNS, not characters. A run of the other
 * width toggles an "inner span is open" flag and is skipped; a run of our own
 * width closes; a mixed run (odd length ≥ 3) is the inner span's closer glued
 * to ours — inner closes first when an inner span is open, otherwise the outer
 * closer comes first and the remainder is left for the caller (`*a***b**` is
 * italic a then bold b, per CommonMark).
 *
 * Underscore runs inside a word (`snake_case`) are never delimiters.
 */
function findEmphasisClose(r: string, delim: '*' | '**' | '_' | '__'): number {
  const ch = delim[0] as string;
  const want = delim.length;
  let innerOpen = false;
  let p = want;
  while (p < r.length) {
    if (r[p] !== ch) {
      p++;
      continue;
    }
    let len = 1;
    while (r[p + len] === ch) len++;
    const intraWord = ch === '_' && /\w/.test(r[p - 1] ?? '') && /\w/.test(r[p + len] ?? '');
    if (intraWord) {
      p += len;
      continue;
    }
    if (want === 1) {
      if (len === 1) return p;
      if (len % 2 === 0) {
        if ((len / 2) % 2 === 1) innerOpen = !innerOpen;
        p += len;
        continue;
      }
      // Odd run ≥ 3: `**…` plus our single closer.
      return innerOpen ? p + len - 1 : p;
    }
    // want === 2
    if (len === 1) {
      innerOpen = !innerOpen;
      p += 1;
      continue;
    }
    if (len === 2) return p;
    // Run ≥ 3: our `**` closer plus a single. When an inner italic is open it
    // closes first (`***`), so our closer is the LAST two.
    return len % 2 === 1 && innerOpen ? p + len - 2 : p;
  }
  return -1;
}

function insertDeltaInto(xmlText: Y.XmlText, delta: ReturnType<typeof inlineMarksToDelta>): void {
  if (delta.length === 0) return;
  xmlText.applyDelta(delta);
}

/**
 * Store a heading's level as a NUMBER, not a string.
 *
 * y-prosemirror hands Yjs attributes to prosemirror verbatim, and Tiptap's
 * Heading extension picks its tag with `options.levels.includes(attrs.level)`
 * where `levels` is `[1..6]` — numbers. A string `'2'` fails that check, so
 * the node renders as `<h1>` and every heading in the doc comes out the same
 * size. (This is why manually re-setting a heading in the editor "fixed" it:
 * prosemirror writes the number back.) Yjs itself stores any JSON value in an
 * attribute; the default Y.XmlElement type param is what narrows it to string.
 */
function setHeadingLevel(el: Y.XmlElement, level: number): void {
  const clamped = Math.min(6, Math.max(1, level));
  (el as unknown as Y.XmlElement<{ level: number }>).setAttribute('level', clamped);
}

/** A heading's level, whatever form it was persisted in. */
export function headingLevelOf(el: Y.XmlElement): number {
  const raw = Number(el.getAttribute('level') ?? 1);
  return Number.isFinite(raw) ? Math.min(6, Math.max(1, raw)) : 1;
}

/**
 * Rewrite any heading whose `level` attribute is still a string (every doc
 * persisted before the fix above) to the numeric form. Returns how many
 * headings changed; idempotent, so it's safe to run on every room load.
 */
export function normalizeHeadingLevels(
  doc: Y.Doc,
  opts: { transactionOrigin?: unknown } = {},
): number {
  const fragment = getProseFragment(doc);
  const stale: Y.XmlElement[] = [];
  const visit = (node: Y.XmlElement | Y.XmlText | Y.XmlHook): void => {
    if (!(node instanceof Y.XmlElement)) return;
    if (node.nodeName === 'heading' && typeof node.getAttribute('level') !== 'number') {
      stale.push(node);
    }
    for (const child of node.toArray()) visit(child as Y.XmlElement | Y.XmlText);
  };
  for (const child of fragment.toArray()) visit(child as Y.XmlElement | Y.XmlText);
  if (stale.length === 0) return 0;
  doc.transact(() => {
    for (const el of stale) {
      setHeadingLevel(el, headingLevelOf(el));
    }
  }, opts.transactionOrigin ?? 'file-watch');
  return stale.length;
}

/** Serialization keys for a fresh parse of `markdown`. A prelim (not yet
 *  integrated) Y.XmlElement exposes neither children nor attributes, so the
 *  blocks are integrated into a throwaway doc to be read. */
function markdownBlockKeys(
  markdown: string,
  key: (node: Y.XmlElement | Y.XmlText, i: number) => string,
): string[] {
  const scratch = new Y.Doc();
  const fragment = getProseFragment(scratch);
  fragment.push(parseMarkdownBlocks(markdown));
  return (fragment.toArray() as (Y.XmlElement | Y.XmlText)[]).map(key);
}

/**
 * Replace the fragment's top-level blocks with a fresh parse of `markdown`,
 * touching only the blocks that actually changed.
 *
 * The naive `fragment.delete(0, len) + push(next)` destroys the Y.XmlText
 * identity of EVERY block, which orphans every thread anchor in the doc —
 * even threads on paragraphs the rewrite never touched. Diffing at block
 * granularity (blocks keyed by their serialized markdown) keeps untouched
 * blocks in place, so their RelativePositions keep resolving.
 *
 * Returns true if the fragment changed.
 */
export function applyMarkdownToFragment(fragment: Y.XmlFragment, markdown: string): boolean {
  const prev = fragment.toArray() as (Y.XmlElement | Y.XmlText)[];
  // serializeBlock returns null for a text-empty heading, an empty XmlText and
  // a src-less image. Those still have to be told apart, so the fallback key
  // carries the node type AND its attributes — an empty `## ` and an empty
  // `#### ` differ only in `level`, and a type-only key would call them equal
  // and keep the stale block (with its stale level).
  const key = (node: Y.XmlElement | Y.XmlText, i: number): string => {
    const s = serializeBlock(node);
    if (s != null) return s;
    if (!(node instanceof Y.XmlElement)) return `__empty_text_${i}__`;
    return `__empty_${node.nodeName}_${JSON.stringify(node.getAttributes())}__`;
  };
  // Blocks whose entire text is a pending insert-suggestion serialize to
  // NOTHING, so they have no key in disk space — an LCS over them would
  // delete a pending proposal on any external disk change, even one that
  // never touched its neighborhood. Treat them as transparent instead: they
  // are excluded from the diff, never deleted, and new blocks are positioned
  // relative to the accepted blocks only.
  const suggestedPrev = prev.map((b) => b instanceof Y.XmlElement && isEntirelySuggestedInsert(b));
  const acceptedIdx: number[] = [];
  for (let i = 0; i < prev.length; i++) {
    if (!suggestedPrev[i]) acceptedIdx.push(i);
  }
  const prevKeys = acceptedIdx.map((i) => key(prev[i]!, i));
  const nextKeys = markdownBlockKeys(markdown, key);
  // Keyed separately from the blocks we insert: reading a prelim block's
  // content requires integrating it into a doc, and an integrated Yjs type
  // can't then be re-parented into the live fragment. (So the markdown is
  // parsed twice per call — cheap next to the Yjs work, and this runs at most
  // once per 500ms mtime poll.)
  const next = parseMarkdownBlocks(markdown);

  // Never wipe the doc to empty. Both call sites already guard on a zero-block
  // parse, but this is exported — make it safe by construction.
  if (next.length === 0) return false;

  // Guard the O(n·m) table. Beyond this the destructive replace is the only
  // option — which reinstates the thread-orphaning this function exists to
  // prevent, so say so out loud rather than degrading silently. 2000×2000
  // blocks is far past any real review doc (this repo's run 30–100).
  if (prevKeys.length * nextKeys.length > LCS_CELL_BUDGET) {
    console.warn(
      `[prose] ${prevKeys.length}→${nextKeys.length} blocks exceeds the diff budget; ` +
        'falling back to a destructive replace — thread anchors in this doc will orphan',
    );
    fragment.delete(0, fragment.length);
    fragment.push(next);
    return true;
  }

  // Longest common subsequence → which old blocks survive, and what each
  // maps to in the new list.
  const n = prevKeys.length;
  const m = nextKeys.length;
  const { keptA: keptOld, keptB: keptNew } = lcsKept(prevKeys, nextKeys);
  if (keptOld.size === n && keptNew.size === m) return false;

  // Deletions first, right-to-left so earlier indices stay valid. `keptOld`
  // indexes the ACCEPTED (non-suggested) blocks; map back through acceptedIdx
  // so fully-suggested blocks are never deleted.
  for (let a = n - 1; a >= 0; a--) {
    if (!keptOld.has(a)) fragment.delete(acceptedIdx[a]!, 1);
  }
  // The fragment now holds the kept accepted blocks in order, interleaved
  // with any surviving fully-suggested blocks. Insert new block j where the
  // j-th accepted block sits (append past the end), counting suggested
  // blocks as transparent — so a proposal stays attached to its preceding
  // accepted neighbor.
  for (let j = 0; j < m; j++) {
    if (!keptNew.has(j)) fragment.insert(acceptedInsertPos(fragment, j), [next[j]]);
  }
  return true;
}

/** Index in `fragment` of the j-th accepted (non-fully-suggested) block, or
 *  fragment.length when there are fewer than j+1 accepted blocks. */
function acceptedInsertPos(fragment: Y.XmlFragment, j: number): number {
  const kids = fragment.toArray() as (Y.XmlElement | Y.XmlText)[];
  let accepted = 0;
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i]!;
    if (k instanceof Y.XmlElement && isEntirelySuggestedInsert(k)) continue;
    if (accepted === j) return i;
    accepted++;
  }
  return kids.length;
}

export function parseMarkdownBlocks(markdown: string): Y.XmlElement[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: Y.XmlElement[] = [];
  let i = 0;

  const isHeading = (s: string) => /^#{1,6}\s+/.test(s);
  const isBullet = (s: string) => /^[-*]\s+/.test(s);
  const isNumbered = (s: string) => /^\d+\.\s+/.test(s);
  const isQuote = (s: string) => /^>\s?/.test(s);
  const isFence = (s: string) => /^```/.test(s);
  const isRule = (s: string) => /^(---|\*\*\*|___)\s*$/.test(s);
  // Pipe-table heuristics: a table row has a leading/trailing pipe with
  // cells between them. The second line is a separator of dashes.
  const isTableRow = (s: string) => /^\s*\|.*\|\s*$/.test(s);
  const isTableSep = (s: string) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(s);
  // A line that is *only* a markdown image: ![alt](src) or ![alt](src "title").
  // Captured as an image node so the src lives in an attribute and never gets
  // run through inline emphasis parsing (which would mangle `_` in URLs).
  const isImage = (s: string) => /^!\[[^\]]*\]\([^)]*\)\s*$/.test(s.trim());

  const isBlockStart = (s: string) =>
    isHeading(s) ||
    isBullet(s) ||
    isNumbered(s) ||
    isQuote(s) ||
    isFence(s) ||
    isRule(s) ||
    isImage(s) ||
    isTableRow(s);

  const mkParagraph = (text: string): Y.XmlElement => {
    const p = new Y.XmlElement('paragraph');
    if (text.length > 0) {
      const t = new Y.XmlText();
      insertDeltaInto(t, inlineMarksToDelta(text));
      p.insert(0, [t]);
    }
    return p;
  };

  // Build an `image` node from a standalone `![alt](src "title")` line. The
  // node name matches the Tiptap Image extension so it renders in the live
  // editor; src/alt/title round-trip as attributes. src is matched as a run
  // of non-space chars, so remote URLs and relative paths both work and
  // underscores in the path are never parsed as emphasis.
  const mkImage = (raw: string): Y.XmlElement => {
    const m = raw.trim().match(/^!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)$/);
    const img = new Y.XmlElement('image');
    img.setAttribute('src', m?.[2] ?? '');
    img.setAttribute('alt', m?.[1] ?? '');
    if (m?.[3]) img.setAttribute('title', m[3]);
    return img;
  };

  // --- Nested list parsing -------------------------------------------------
  // The serializer emits 2-space-per-level indentation; the parser reads
  // nesting back by leading-space count so the round-trip is lossless. We
  // accept any increase in indentation as a deeper level (handles 2- and
  // 4-space human-authored markdown alike). `isBullet`/`isNumbered` above
  // anchor at column 0; these indent-aware variants drive the list builder.
  const indentOf = (s: string) => s.match(/^ */)?.[0].length ?? 0;
  const isListItemLine = (s: string) => /^\s*(?:[-*]|\d+\.)\s+/.test(s);
  const isOrderedLine = (s: string) => /^\s*\d+\.\s+/.test(s);
  const stripMarker = (s: string) => s.replace(/^\s*(?:[-*]|\d+\.)\s+/, '');

  // Append an item's child content (nested lists + continuation paragraphs,
  // all indented deeper than `baseIndent`) to `li`. Returns the next index.
  function consumeItemChildren(start: number, baseIndent: number, li: Y.XmlElement): number {
    let k = start;
    for (;;) {
      let j = k;
      while (j < lines.length && (lines[j] ?? '').trim() === '') j++;
      if (j >= lines.length) return k;
      const ind = indentOf(lines[j] ?? '');
      if (ind <= baseIndent) return k; // back to sibling level or shallower
      k = j; // consume intervening blanks now that we know content follows
      if (isListItemLine(lines[k] ?? '')) {
        const [sub, next] = parseListAt(k, ind);
        li.insert(li.length, [sub]);
        k = next;
      } else if (isFence((lines[k] ?? '').trim())) {
        // A fenced code block inside the item. The serializer emits it
        // indented one level under the marker; read it back as a codeBlock
        // child (stripping that indent from every line) instead of letting
        // the paragraph gatherer below join its lines with spaces — which
        // flattened multi-line code onto one line on every round-trip.
        const fenceLine = (lines[k] ?? '').trim();
        const lang = fenceLine.replace(/^```/, '').trim();
        const strip = (s: string) => (indentOf(s) >= ind ? s.slice(ind) : s.trimStart());
        k++;
        const code: string[] = [];
        while (k < lines.length && !isFence((lines[k] ?? '').trim())) {
          code.push(strip(lines[k] ?? ''));
          k++;
        }
        if (k < lines.length) k++; // closing fence
        const cb = new Y.XmlElement('codeBlock');
        if (lang) cb.setAttribute('language', lang);
        const t = new Y.XmlText();
        t.insert(0, code.join('\n'));
        cb.insert(0, [t]);
        li.insert(li.length, [cb]);
      } else {
        const paraLines: string[] = [];
        while (
          k < lines.length &&
          (lines[k] ?? '').trim() !== '' &&
          indentOf(lines[k] ?? '') > baseIndent &&
          !isListItemLine(lines[k] ?? '') &&
          !isFence((lines[k] ?? '').trim())
        ) {
          paraLines.push((lines[k] ?? '').trim());
          k++;
        }
        li.insert(li.length, [mkParagraph(paraLines.join(' '))]);
      }
    }
  }

  // Parse a list whose items sit at exactly `baseIndent`. Consumes sibling
  // items, their nested lists, and continuation paragraphs. Returns the
  // list element and the next index.
  function parseListAt(start: number, baseIndent: number): [Y.XmlElement, number] {
    const ordered = isOrderedLine(lines[start] ?? '');
    const list = new Y.XmlElement(ordered ? 'orderedList' : 'bulletList');
    let k = start;
    for (;;) {
      let j = k;
      while (j < lines.length && (lines[j] ?? '').trim() === '') j++;
      if (j >= lines.length) {
        k = j;
        break;
      }
      const ind = indentOf(lines[j] ?? '');
      if (ind < baseIndent) break;
      if (ind > baseIndent) break; // deeper content with no open item — malformed
      if (!isListItemLine(lines[j] ?? '')) break; // non-item line at this level
      if (isOrderedLine(lines[j] ?? '') !== ordered) break; // list type switches
      k = j;
      const li = new Y.XmlElement('listItem');
      li.insert(li.length, [mkParagraph(stripMarker(lines[k] ?? ''))]);
      k++;
      k = consumeItemChildren(k, baseIndent, li);
      list.insert(list.length, [li]);
    }
    return [list, k];
  }

  // YAML frontmatter — only at the very top of the file. Captured as a
  // single codeBlock(language='yaml-frontmatter') holding the raw YAML text
  // so the keys aren't merged into a single space-joined paragraph by the
  // generic line-coalescer below, and the serializer can emit `---\n…\n---`
  // verbatim. Falls through to normal parsing if there's no closing `---`.
  if (i < lines.length && (lines[i] ?? '').trim() === '---') {
    let j = i + 1;
    while (j < lines.length && (lines[j] ?? '').trim() !== '---') j++;
    if (j < lines.length) {
      const yamlLines: string[] = [];
      for (let k = i + 1; k < j; k++) {
        const ln = lines[k] ?? '';
        // Drop blank lines so frontmatter that was previously round-tripped
        // through the old parser (which left blank lines between values)
        // self-heals on the next reparse.
        if (ln.trim() !== '') yamlLines.push(ln);
      }
      if (yamlLines.length > 0) {
        const cb = new Y.XmlElement('codeBlock');
        cb.setAttribute('language', 'yaml-frontmatter');
        const t = new Y.XmlText();
        t.insert(0, yamlLines.join('\n'));
        cb.insert(0, [t]);
        out.push(cb);
        i = j + 1;
      }
    }
  }

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }

    if (isHeading(line)) {
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      const level = Math.min(6, Math.max(1, m?.[1]?.length ?? 1));
      const text = m?.[2] ?? '';
      const h = new Y.XmlElement('heading');
      setHeadingLevel(h, level);
      if (text) {
        const t = new Y.XmlText();
        insertDeltaInto(t, inlineMarksToDelta(text));
        h.insert(0, [t]);
      }
      out.push(h);
      i++;
      continue;
    }

    if (isRule(line)) {
      out.push(new Y.XmlElement('horizontalRule'));
      i++;
      continue;
    }

    if (isFence(line)) {
      // Capture the language hint after the opening fence (```mermaid, ```ts, …).
      const lang = line.replace(/^```/, '').trim();
      i++;
      const code: string[] = [];
      while (i < lines.length && !isFence(lines[i] ?? '')) {
        code.push(lines[i] ?? '');
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      const cb = new Y.XmlElement('codeBlock');
      if (lang) cb.setAttribute('language', lang);
      const t = new Y.XmlText();
      t.insert(0, code.join('\n'));
      cb.insert(0, [t]);
      out.push(cb);
      continue;
    }

    if (isBullet(line) || isNumbered(line)) {
      const [list, next] = parseListAt(i, indentOf(line));
      out.push(list);
      i = next;
      continue;
    }

    if (isQuote(line)) {
      const quoted: string[] = [];
      while (i < lines.length && isQuote(lines[i] ?? '')) {
        quoted.push((lines[i] ?? '').replace(/^>\s?/, ''));
        i++;
      }
      const bq = new Y.XmlElement('blockquote');
      bq.insert(0, [mkParagraph(quoted.join('\n'))]);
      out.push(bq);
      continue;
    }

    // GFM-style pipe table. Detected by: header row → separator row
    // (dashes + pipes) → one-or-more body rows. Cells are split on
    // `|`, trimmed, and wrapped as paragraph children of each cell.
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1] ?? '')) {
      const headerCells = splitTableRow(line);
      i += 2; // consume header + separator
      const bodyRows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i] ?? '')) {
        bodyRows.push(splitTableRow(lines[i] ?? ''));
        i++;
      }
      out.push(mkTable(headerCells, bodyRows));
      continue;
    }

    // Standalone image line → image node (keeps the src out of inline parsing).
    if (isImage(line)) {
      out.push(mkImage(line));
      i++;
      continue;
    }

    // Default: a paragraph. Gather consecutive non-blank, non-block-start
    // lines and join with a space so soft-wrapped prose becomes one
    // paragraph (standard markdown convention).
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const nxt = lines[i] ?? '';
      if (nxt.trim() === '' || isBlockStart(nxt)) break;
      paraLines.push(nxt);
      i++;
    }
    out.push(mkParagraph(paraLines.join(' ')));
  }
  return out;
}

function splitTableRow(line: string): string[] {
  // Strip the optional leading/trailing pipe, then split on `|`.
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim());
}

function mkTable(headerCells: string[], bodyRows: string[][]): Y.XmlElement {
  const table = new Y.XmlElement('table');
  // Header row
  const headerRow = new Y.XmlElement('tableRow');
  for (const cell of headerCells) {
    const th = new Y.XmlElement('tableHeader');
    const p = new Y.XmlElement('paragraph');
    if (cell.length > 0) {
      const t = new Y.XmlText();
      insertDeltaInto(t, inlineMarksToDelta(cell));
      p.insert(0, [t]);
    }
    th.insert(0, [p]);
    headerRow.insert(headerRow.length, [th]);
  }
  table.insert(0, [headerRow]);
  // Body rows — pad with empty cells if a row is short so shape stays rectangular.
  for (const row of bodyRows) {
    const tr = new Y.XmlElement('tableRow');
    for (let ci = 0; ci < headerCells.length; ci++) {
      const cellText = row[ci] ?? '';
      const td = new Y.XmlElement('tableCell');
      const p = new Y.XmlElement('paragraph');
      if (cellText.length > 0) {
        const t = new Y.XmlText();
        insertDeltaInto(t, inlineMarksToDelta(cellText));
        p.insert(0, [t]);
      }
      td.insert(0, [p]);
      tr.insert(tr.length, [td]);
    }
    table.insert(table.length, [tr]);
  }
  return table;
}

/**
 * Parse markdown and serialize it straight back: the serializer-space
 * normal form. Two strings with the same normal form carry identical
 * document content and differ only in formatting the round-trip doesn't
 * preserve (blank-line runs, list indent style, ...). Sync arbitration
 * uses this to tell pure normalization drift apart from a real edit.
 */
export function normalizeMarkdown(markdown: string): string {
  const doc = new Y.Doc();
  try {
    const fragment = getProseFragment(doc);
    doc.transact(() => {
      const blocks = parseMarkdownBlocks(markdown);
      // Parse + push, NOT applyMarkdownToFragment: the fragment is empty so
      // the diff would insert everything anyway, and apply's block-keying
      // reads prelim types, which logs a Yjs warning per block — at hydrate
      // this runs for every bound doc, so that's log spam at scale.
      if (blocks.length > 0) fragment.push(blocks);
    });
    return serializeFragmentToMarkdown(fragment);
  } finally {
    doc.destroy();
  }
}

/**
 * Serialize the entire prose fragment back into markdown. Round-trips
 * the block types parseMarkdownBlocks handles (headings, paragraphs,
 * bullet/ordered lists, blockquotes, code blocks, horizontal rules).
 * Inline marks (bold/italic/link) are lost — same limitation as the
 * parser. Used by the file-backed-doc writer so edits flow out to
 * disk as human-readable markdown.
 */
export function serializeFragmentToMarkdown(fragment: Y.XmlFragment): string {
  const children = fragment.toArray();
  // Recognize a leading YAML-frontmatter pattern: horizontalRule, then one or
  // more paragraphs (the YAML lines), then a closing horizontalRule. The
  // markdown parser doesn't have a typed frontmatter node — it tokenizes
  // `---` as horizontalRule and the YAML lines as plain paragraphs — so on
  // round-trip we need to emit the block back as `---\nyaml\n---` without
  // the `\n\n` block separators that would otherwise appear between every
  // paragraph and corrupt the YAML. Self-heals docs whose frontmatter was
  // already corrupted by a prior round-trip (the parser ignores blank lines
  // so they're absent from the Yjs state — the serializer just stops
  // re-introducing them).
  let i = 0;
  let frontmatterMd: string | null = null;
  if (children.length >= 2) {
    const first = children[0];
    if (isHorizontalRuleNode(first)) {
      let j = 1;
      const yamlLines: string[] = [];
      while (j < children.length && isParagraphNode(children[j])) {
        yamlLines.push(textContent(children[j] as Y.XmlElement));
        j++;
      }
      if (j < children.length && isHorizontalRuleNode(children[j]) && yamlLines.length > 0) {
        frontmatterMd = `---\n${yamlLines.join('\n')}\n---`;
        i = j + 1;
      }
    }
  }

  const parts: string[] = [];
  if (frontmatterMd != null) parts.push(frontmatterMd);
  for (; i < children.length; i++) {
    const s = serializeBlock(children[i] as Y.XmlElement | Y.XmlText);
    if (s != null && s !== '') parts.push(s);
  }
  return parts.length > 0 ? `${parts.join('\n\n')}\n` : '';
}

function isHorizontalRuleNode(n: unknown): boolean {
  return n instanceof Y.XmlElement && n.nodeName === 'horizontalRule';
}
function isParagraphNode(n: unknown): boolean {
  return n instanceof Y.XmlElement && n.nodeName === 'paragraph';
}

/** Serialize a single block element to markdown (public accessor for
 *  get_doc's table/list rendering). */
export function serializeBlockToMarkdown(node: Y.XmlElement): string {
  return serializeBlock(node) ?? '';
}

function serializeBlock(node: Y.XmlElement | Y.XmlText): string | null {
  if (node instanceof Y.XmlText) {
    const s = node.toString();
    return s.length > 0 ? s : null;
  }
  if (!(node instanceof Y.XmlElement)) return null;
  // A block whose entire text is a pending insert-suggestion has no accepted
  // content — it contributes nothing (no empty paragraph line, no empty
  // fence). Blocks with no text at all (horizontalRule, image, a genuinely
  // empty codeBlock) are unaffected: the whole-block rule requires text.
  if (isEntirelySuggestedInsert(node)) return null;
  switch (node.nodeName) {
    case 'paragraph':
      return textContent(node);
    case 'heading': {
      const level = headingLevelOf(node);
      const text = textContent(node);
      return text.length > 0 ? `${'#'.repeat(level)} ${text}` : null;
    }
    case 'blockquote':
      return serializeBlockquote(node);
    case 'codeBlock': {
      const lang = node.getAttribute('language') ?? '';
      // YAML frontmatter is captured as a typed codeBlock at parse time so
      // the keys round-trip without being merged into a single paragraph.
      // The serializer emits it back as a `---`-bracketed block.
      if (lang === 'yaml-frontmatter') {
        return `---\n${textContent(node)}\n---`;
      }
      return `\`\`\`${lang}\n${textContent(node)}\n\`\`\``;
    }
    case 'horizontalRule':
      return '---';
    case 'bulletList':
    case 'orderedList':
      return serializeList(node, 0);
    case 'table':
      return serializeTable(node);
    case 'image': {
      const src = String(node.getAttribute('src') ?? '');
      if (!src) return null;
      const alt = String(node.getAttribute('alt') ?? '');
      const title = node.getAttribute('title');
      const titlePart = title ? ` "${String(title)}"` : '';
      return `![${alt}](${src}${titlePart})`;
    }
    default:
      return textContent(node);
  }
}

function serializeTable(table: Y.XmlElement): string {
  const rows = table
    .toArray()
    .filter((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'tableRow')
    // A fully-suggested row would otherwise serialize as an all-empty `| |`
    // line — it has no accepted content, so it contributes nothing.
    .filter((r) => !isEntirelySuggestedInsert(r));
  if (rows.length === 0) return '';
  const cells: string[][] = rows.map((r) =>
    r
      .toArray()
      .filter(
        (c): c is Y.XmlElement =>
          c instanceof Y.XmlElement && (c.nodeName === 'tableCell' || c.nodeName === 'tableHeader'),
      )
      .map((c) => textContent(c).replace(/\|/g, '\\|').replace(/\n/g, ' ')),
  );
  const colCount = Math.max(...cells.map((r) => r.length));
  // Pad ragged rows to rectangular shape.
  for (const r of cells) while (r.length < colCount) r.push('');
  // Column widths for pretty alignment (cap to avoid runaway widths).
  const widths = new Array(colCount).fill(0);
  for (const r of cells) {
    for (let ci = 0; ci < colCount; ci++) {
      widths[ci] = Math.min(60, Math.max(widths[ci], r[ci]?.length ?? 0, 3));
    }
  }
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
  const lines: string[] = [];
  const [header, ...body] = cells;
  if (header) lines.push(`| ${header.map((c, ci) => pad(c, widths[ci])).join(' | ')} |`);
  lines.push(`| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`);
  for (const row of body) lines.push(`| ${row.map((c, ci) => pad(c, widths[ci])).join(' | ')} |`);
  return lines.join('\n');
}

function textContent(node: Y.XmlElement): string {
  const parts: string[] = [];
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) parts.push(textWithMarks(child));
    else if (child instanceof Y.XmlElement) parts.push(textContent(child));
  }
  return parts.join('');
}

/**
 * Read a Y.XmlText's delta and re-emit markdown syntax for any marks
 * (bold/italic/code/link/strike) it carries. Inverse of
 * inlineMarksToDelta — plain text remains plain; marked runs get
 * wrapped in the appropriate syntax.
 */
function textWithMarks(xmlText: Y.XmlText): string {
  const delta = xmlText.toDelta() as Array<{
    insert?: string;
    attributes?: Record<string, unknown>;
  }>;
  let out = '';
  // Marks currently open, outermost first. A Yjs delta is a flat sequence of
  // ops each carrying a SET of marks — it has no notion of which mark is
  // "outer" — so nesting is decided here, by MARK precedence (link outermost,
  // code innermost). A mark stays open across ops as long as every op still
  // carries it; the moment an op drops a mark, that mark and everything opened
  // inside it is closed (innermost first), and whatever the op still carries
  // is re-opened. This is what makes `**a *b* c**` come out as one bold run
  // rather than three — the old per-op `wrapMarks` closed and re-opened bold
  // around the italic, doubling the delimiters into `**a ****b**** c**` and
  // corrupting every bound file that held such a run.
  const active: InlineMark[] = [];
  for (const seg of expelEmphasisWhitespace(delta)) {
    const marks = seg.marks;
    let keep = 0;
    while (keep < active.length && marks.some((m) => m.key === active[keep]!.key)) keep++;
    for (let k = active.length - 1; k >= keep; k--) out += active[k]!.close;
    active.length = keep;
    // A whitespace segment never OPENS a mark: an emphasis delimiter must sit
    // against a word, so a run that has to be (re)opened opens after the
    // space, on the word that follows.
    if (!seg.ws) {
      for (const m of marks) {
        if (active.some((a) => a.key === m.key)) continue;
        out += m.open;
        active.push(m);
      }
    }
    out += seg.text;
  }
  for (let k = active.length - 1; k >= 0; k--) out += active[k]!.close;
  return out;
}

type InlineMark = { key: string; open: string; close: string };
type InlineSegment = { text: string; marks: InlineMark[]; ws?: boolean };

const EMPHASIS_KEYS = new Set(['bold', 'italic', 'strike']);

/**
 * Turn a Yjs delta into the segments the serializer walks, moving whitespace
 * OUT from under emphasis marks at their edges. Markdown emphasis cannot open
 * before a space or close after one (`** word**`, `*word *` are literal
 * asterisks in CommonMark and in this file's own parser), and an editor
 * selection routinely bolds a trailing space. So an op's leading whitespace
 * keeps only the emphasis it shares with the PREVIOUS op, its trailing
 * whitespace only what it shares with the NEXT one, and a whitespace-only op
 * only what both neighbours carry — the delimiters land against a word on
 * both sides. Link and code are not emphasis and keep their whitespace; a code
 * op is never split at all.
 *
 * Also applies THE SERIALIZER RULE for suggested edits: disk always holds the
 * ACCEPTED state, so text carrying a pending insert-suggestion is dropped here
 * — and ONLY here, because every doc→disk path (write-back, reconcile's
 * currentSerialized, lastWritten, normalizeMarkdown) funnels through
 * textWithMarks. Text carrying `suggestDelete` falls through and is emitted
 * WITHOUT the mark: inlineMarksOf reads only the real inline marks.
 */
function expelEmphasisWhitespace(
  delta: Array<{ insert?: string; attributes?: Record<string, unknown> }>,
): InlineSegment[] {
  const ops = delta.filter(
    (op): op is { insert: string; attributes?: Record<string, unknown> } =>
      typeof op.insert === 'string' &&
      op.insert.length > 0 &&
      op.attributes?.[SUGGEST_INSERT_MARK] == null,
  );
  const out: InlineSegment[] = [];
  const shared = (marks: InlineMark[], neighbour: InlineMark[] | undefined) =>
    marks.filter((m) => !EMPHASIS_KEYS.has(m.key) || neighbour?.some((n) => n.key === m.key));
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const marks = inlineMarksOf(op.attributes);
    const hasEmphasis = marks.some((m) => EMPHASIS_KEYS.has(m.key));
    const isCode = marks.some((m) => m.key === 'code');
    if (!hasEmphasis || isCode) {
      out.push({ text: op.insert, marks });
      continue;
    }
    const prev = i > 0 ? inlineMarksOf(ops[i - 1]!.attributes) : undefined;
    const next = i + 1 < ops.length ? inlineMarksOf(ops[i + 1]!.attributes) : undefined;
    const m = op.insert.match(/^(\s*)(.*?)(\s*)$/s);
    const lead = m?.[1] ?? '';
    const core = m?.[2] ?? '';
    const trail = m?.[3] ?? '';
    if (core.length === 0) {
      out.push({ text: op.insert, marks: shared(shared(marks, prev), next), ws: true });
      continue;
    }
    if (lead) out.push({ text: lead, marks: shared(marks, prev), ws: true });
    out.push({ text: core, marks });
    if (trail) out.push({ text: trail, marks: shared(marks, next), ws: true });
  }
  return out;
}

/**
 * The inline marks an op carries, in NESTING order — outermost first. Link
 * wraps everything (`[**b**](u)`), code sits innermost so no delimiter ever
 * lands inside a code span. Suggestion bookkeeping attributes are not marks
 * and are ignored here.
 */
function inlineMarksOf(attrs: Record<string, unknown> | undefined): InlineMark[] {
  if (!attrs) return [];
  const out: InlineMark[] = [];
  if (attrs.link && typeof attrs.link === 'object' && attrs.link !== null) {
    const href = (attrs.link as { href?: string }).href ?? '';
    if (href) out.push({ key: `link:${href}`, open: '[', close: `](${href})` });
  }
  if (attrs.strike) out.push({ key: 'strike', open: '~~', close: '~~' });
  if (attrs.bold) out.push({ key: 'bold', open: '**', close: '**' });
  if (attrs.italic) out.push({ key: 'italic', open: '*', close: '*' });
  if (attrs.code) out.push({ key: 'code', open: '`', close: '`' });
  return out;
}

/**
 * True when a block's ENTIRE text is a pending insert-suggestion (and it has
 * at least one character of text). Such a block does not exist in the
 * accepted state: it must contribute nothing to serialization — not even an
 * empty shell (`- ` marker, empty code fence) — and a disk-driven reconcile
 * must treat it as transparent (it has no key in disk space to match).
 */
function isEntirelySuggestedInsert(node: Y.XmlElement): boolean {
  let sawText = false;
  const visit = (n: Y.XmlElement | Y.XmlText | Y.XmlHook): boolean => {
    if (n instanceof Y.XmlText) {
      const delta = n.toDelta() as Array<{
        insert?: string;
        attributes?: Record<string, unknown>;
      }>;
      for (const op of delta) {
        if (typeof op.insert !== 'string' || op.insert.length === 0) continue;
        sawText = true;
        if (op.attributes?.[SUGGEST_INSERT_MARK] == null) return false;
      }
      return true;
    }
    if (n instanceof Y.XmlElement) {
      for (const child of n.toArray()) {
        if (!visit(child as Y.XmlElement | Y.XmlText)) return false;
      }
    }
    return true;
  };
  return visit(node) && sawText;
}

/**
 * Serialize a bulletList / orderedList to markdown, preserving nested
 * lists and multi-paragraph list items. `depth` is the nesting level
 * (0 = top). Indentation is 2 spaces per level — the same unit the
 * parser reads back, so the round-trip is lossless.
 *
 * The editor (y-prosemirror) shapes a list item as
 *   listItem > paragraph [, bulletList|orderedList ] [, paragraph … ]
 * The previous serializer flattened EVERY child of a listItem with
 * `textContent` joined by a single space, which silently destroyed
 * nested bullets and sub-paragraphs on write-back (a peer lost a nested
 * "Notes & Questions" section this way). Recurse instead.
 */
function serializeList(list: Y.XmlElement, depth: number): string {
  const ordered = list.nodeName === 'orderedList';
  const indent = '  '.repeat(depth);
  const contIndent = '  '.repeat(depth + 1);
  const lines: string[] = [];
  let n = 0;
  for (const li of list.toArray()) {
    if (!(li instanceof Y.XmlElement) || li.nodeName !== 'listItem') continue;
    // A fully-suggested item is not part of the accepted list — skipping it
    // here (not just via serializeBlock) avoids emitting an empty `- ` marker.
    if (isEntirelySuggestedInsert(li)) continue;
    n++;
    const marker = ordered ? `${n}. ` : '- ';
    const children = li.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
    // The first paragraph is the item's own line; everything after it
    // (nested lists, extra paragraphs) renders as indented child content.
    const firstParaIdx = children.findIndex((c) => c.nodeName === 'paragraph');
    const firstText = firstParaIdx >= 0 ? textContent(children[firstParaIdx]!) : '';
    lines.push(`${indent}${marker}${firstText}`);
    for (let k = 0; k < children.length; k++) {
      if (k === firstParaIdx) continue;
      const child = children[k]!;
      if (child.nodeName === 'bulletList' || child.nodeName === 'orderedList') {
        lines.push(serializeList(child, depth + 1));
      } else {
        // Continuation paragraph (or other block) inside the item: blank
        // line, then indent one level deeper than the marker.
        const text = serializeBlock(child) ?? textContent(child);
        lines.push('');
        for (const tl of text.split('\n')) lines.push(tl.length > 0 ? `${contIndent}${tl}` : tl);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Serialize a blockquote to markdown, preserving paragraph boundaries.
 *
 * The editor (y-prosemirror) shapes a quote the human split with Enter as
 *   blockquote > paragraph [, paragraph … ]
 * The previous serializer flattened all children with `textContent` (joined
 * by ''), so multiple paragraphs collapsed onto one `> ` line with the
 * boundary erased — a CRM peer misread Bryan's own multi-paragraph draft as a
 * single line because of it. Recurse over the block children instead, quoting
 * each, and separate adjacent paragraphs with a blank `>` line (the markdown
 * paragraph separator inside a quote). A single paragraph that carries soft
 * line-breaks still renders as adjacent `> ` lines, so both shapes round-trip.
 */
function serializeBlockquote(node: Y.XmlElement): string {
  const quote = (text: string): string =>
    text
      .split('\n')
      .map((l) => (l.length > 0 ? `> ${l}` : '>'))
      .join('\n');
  const parts = node
    .toArray()
    .map((child) => serializeBlock(child as Y.XmlElement | Y.XmlText))
    .filter((s): s is string => s != null && s !== '')
    .map(quote);
  // An empty quote (bare `>`, or an editor placeholder before the user types)
  // still emits its marker so the block survives the round-trip instead of
  // being silently dropped by the fragment serializer.
  return parts.length > 0 ? parts.join('\n>\n') : '>';
}

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
