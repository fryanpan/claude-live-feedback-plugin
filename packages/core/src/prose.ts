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
import {
  type TextSegment,
  getProseFragment,
  headingLevelOf,
  preview,
  resolveRelativePositionRaw,
  walkProse,
} from './prose-fragment.ts';
import {
  inlineMarksToDelta,
  insertDeltaInto,
  parseMarkdownBlocks,
  splitTableRow,
  textContent,
} from './prose-markdown.ts';
import { SUGGEST_DELETE_MARK, SUGGEST_INSERT_MARK } from './suggest.ts';

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
    | 'replace-all-with-occurrence'
    | 'table-shape-mismatch';
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
    // Table-row fallback (2026-08-26 incident): a find string quoted from the
    // doc's MARKDOWN form — `| Alpha | 2 | … |` — can never match the
    // flattened text, because pipes and padding are serializer output, not
    // document content. Match those structurally instead of leaving the
    // caller a bare no-match whose recorded next move was a whole-doc
    // rewrite from a stale copy.
    const tableRes = tryTableRowReplace(doc, fragment, opts);
    if (tableRes) return tableRes;
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

/** Table-row syntax, shared with the parser's heuristics: a line whose
 *  content sits between a leading and a trailing pipe. */
const TABLE_ROW_LINE = /^\s*\|.*\|\s*$/;
const TABLE_SEP_LINE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

/** Parse a string as pipe-table row(s): separator lines are dropped, every
 *  other non-empty line must be a `| … |` row. Returns rows of trimmed
 *  cells, or null when the string isn't table-shaped at all. */
function parsePipeRows(s: string): string[][] | null {
  const lines = s
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const rows: string[][] = [];
  for (const line of lines) {
    if (TABLE_SEP_LINE.test(line)) continue;
    if (!TABLE_ROW_LINE.test(line)) return null;
    rows.push(splitTableRow(line));
  }
  return rows.length > 0 ? rows : null;
}

/** Whitespace-normalized comparison form for a table cell: the serializer
 *  pads cells for column alignment, and an agent quoting an older flush (or
 *  typing the row by hand) pads differently. Runs of whitespace are one
 *  space; edges are trimmed. */
function normCell(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Every `table` element in the fragment, in document order (nested tables
 *  included, though the parser only produces top-level ones today). */
function collectTables(
  node: Y.XmlFragment | Y.XmlElement,
  out: Y.XmlElement[] = [],
): Y.XmlElement[] {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlElement) {
      if (child.nodeName === 'table') out.push(child);
      else collectTables(child, out);
    }
  }
  return out;
}

/** A row's cell elements (tableCell / tableHeader), in order. */
function rowCells(row: Y.XmlElement): Y.XmlElement[] {
  return row
    .toArray()
    .filter(
      (c): c is Y.XmlElement =>
        c instanceof Y.XmlElement && (c.nodeName === 'tableCell' || c.nodeName === 'tableHeader'),
    );
}

/** A cell's text without mark syntax — raw delta inserts, recursively. */
function rawCellText(node: Y.XmlElement): string {
  let out = '';
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as Array<{ insert?: string }>) {
        if (typeof op.insert === 'string') out += op.insert;
      }
    } else if (child instanceof Y.XmlElement) {
      out += rawCellText(child);
    }
  }
  return out;
}

/** Does this live row match one find row? Cell counts must agree, and each
 *  find cell must equal the live cell's text — either its markdown form
 *  (`**2**`, what the agent read from disk) or its plain form (`2`, what
 *  get_doc's plainText shows) — up to whitespace. */
function rowMatches(row: Y.XmlElement, findCells: string[]): boolean {
  const cells = rowCells(row);
  if (cells.length !== findCells.length) return false;
  return cells.every((cell, i) => {
    const want = normCell(findCells[i] ?? '');
    return want === normCell(rawCellText(cell)) || want === normCell(textContent(cell));
  });
}

const TABLE_NO_MATCH_WARNING =
  'The find string looks like a markdown table row, but no row in this doc has ' +
  'those cells. Do NOT fall back to set_doc_content — a whole-doc rewrite from ' +
  'your copy destroys concurrent human edits. Re-read the doc with get_doc ' +
  '(tables come back as blocks in their current form), then re-issue ' +
  'find_and_replace with the current row, target the cell text alone, or use ' +
  'edit_at_anchor / insert_blocks_at_anchor / delete_block_at_anchor for ' +
  'structural changes.';

/**
 * Structural find/replace for pipe-table rows. Returns null when `find` is
 * not table-shaped (the caller reports its normal no-match); otherwise a
 * terminal ReplaceResult.
 *
 * Matching compares cells by text, whitespace-normalized, so the caller's
 * padding never matters. The replacement must keep the find's shape (same
 * rows, same cells per row) — changed cells are rewritten with inline
 * markdown parsed, exactly as the table parser treats cell text; untouched
 * cells keep their content, marks, and anchors.
 */
function tryTableRowReplace(
  doc: Y.Doc,
  fragment: Y.XmlFragment,
  opts: {
    find: string;
    replace: string;
    occurrence?: number;
    replaceAll?: boolean;
    transactionOrigin?: unknown;
  },
): ReplaceResult | null {
  const findRows = parsePipeRows(opts.find);
  if (!findRows) return null;

  const replaceRows = parsePipeRows(opts.replace);
  if (
    !replaceRows ||
    replaceRows.length !== findRows.length ||
    replaceRows.some((r, i) => r.length !== (findRows[i]?.length ?? -1))
  ) {
    return {
      ok: false,
      error: 'table-shape-mismatch',
      warning:
        'The find matched table-row syntax, so the replace must be table rows of ' +
        'the same shape (same row count, same cells per row). To add or remove ' +
        'rows/columns use insert_blocks_at_anchor / delete_block_at_anchor — ' +
        'not set_doc_content.',
    };
  }

  // Greedy, non-overlapping scan per table, tables in document order.
  const found: Array<{ rows: Y.XmlElement[] }> = [];
  for (const table of collectTables(fragment)) {
    const rows = table
      .toArray()
      .filter((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'tableRow');
    let i = 0;
    while (i + findRows.length <= rows.length) {
      const span = rows.slice(i, i + findRows.length);
      if (span.every((row, k) => rowMatches(row, findRows[k] ?? []))) {
        found.push({ rows: span });
        i += findRows.length;
      } else {
        i++;
      }
    }
  }

  if (found.length === 0) {
    return { ok: false, error: 'no-match', warning: TABLE_NO_MATCH_WARNING };
  }

  let chosen: Array<{ rows: Y.XmlElement[] }>;
  if (opts.replaceAll === true) {
    chosen = found;
  } else if (opts.occurrence != null) {
    if (opts.occurrence < 1 || opts.occurrence > found.length) {
      return { ok: false, error: 'occurrence-out-of-range' };
    }
    chosen = [found[opts.occurrence - 1] as { rows: Y.XmlElement[] }];
  } else if (found.length > 1) {
    return {
      ok: false,
      error: 'ambiguous',
      candidates: found.map((m, idx) => ({
        docOffset: idx,
        preview: `| ${rowCells(m.rows[0] as Y.XmlElement)
          .map((c) => normCell(textContent(c)))
          .join(' | ')} |`,
      })),
    };
  } else {
    chosen = [found[0] as { rows: Y.XmlElement[] }];
  }

  doc.transact(() => {
    for (const match of chosen) {
      match.rows.forEach((row, r) => {
        rowCells(row).forEach((cell, c) => {
          const before = findRows[r]?.[c] ?? '';
          const after = replaceRows[r]?.[c] ?? '';
          // An unchanged cell is left alone — its marks and anchors survive.
          if (normCell(before) === normCell(after)) return;
          const p = new Y.XmlElement('paragraph');
          if (after.length > 0) {
            const t = new Y.XmlText();
            insertDeltaInto(t, inlineMarksToDelta(after));
            p.insert(0, [t]);
          }
          cell.delete(0, cell.length);
          cell.insert(0, [p]);
        });
      });
    }
  }, opts.transactionOrigin ?? 'agent');

  return opts.replaceAll === true ? { ok: true, replaced: chosen.length } : { ok: true };
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
