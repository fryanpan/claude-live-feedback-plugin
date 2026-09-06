/**
 * Finding a span of doc text and replacing it — the two ways an agent edits
 * prose without a cursor.
 *
 * `locateMatches` / `findAndReplace` address text by what it says: flatten
 * the fragment, find the string, splice inside the `Y.XmlText` it landed in.
 * `rewriteRange` / `insertAfterRange` address it by a pair of stored
 * `Y.RelativePosition`s, which is what a comment thread or an agent anchor
 * carries, so an edit lands where the reader is looking even after the doc
 * moved underneath it.
 *
 * Two things run through all of it. Every mutation happens inside a single
 * `ydoc.transact(fn, 'agent')`, so concurrent human edits compose through
 * Yjs' own CRDT machinery rather than racing. And a failed find returns a
 * hint rather than a bare `no-match`, because the measured next move after a
 * bare no-match was a raw disk write against a live doc.
 *
 * Builds on `prose-fragment.ts` and `prose-markdown.ts`; imports neither
 * `prose-blocks.ts` nor `prose.ts`.
 */
import * as Y from 'yjs';
import {
  type TextSegment,
  getProseFragment,
  preview,
  resolveRelativePositionRaw,
  walkProse,
} from './prose-fragment.ts';
import {
  inlineMarksToDelta,
  insertDeltaInto,
  splitTableRow,
  textContent,
} from './prose-markdown.ts';
import { SUGGEST_DELETE_MARK, SUGGEST_INSERT_MARK } from './suggest.ts';

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
    | 'table-shape-mismatch'
    | 'block-markdown-in-replacement';
  /** On `block-markdown-in-replacement`: the offending line of `replace`,
   *  so the caller can see which one it was without re-reading its payload. */
  blockLine?: string;
  /** A sentence the caller can act on, naming the verb that does the job this
   *  one refused. The MCP client interpolates this whole result into the Error
   *  it throws, so an `error` code alone reaches the agent as a slug with no
   *  next move in it; this field is what makes the refusal actionable. */
  message?: string;
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
  // `applyDelta` takes `Array<any>`, so the typed array above needs no cast.
  node.applyDelta(positioned);
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
/**
 * The first line of a replacement that is block-level markdown, or null.
 *
 * Deliberately narrow, in two tiers. A heading, a fence or a thematic break
 * is block-level wherever it appears — no sentence begins `### `. A list
 * marker or a `>` quote is only read as block-level in a MULTI-LINE
 * replacement, because a one-line replacement may legitimately start with a
 * hyphen or an angle bracket (`- 5 degrees`), and refusing that would block
 * an edit this verb has always done correctly.
 *
 * A bare `\n\n` is NOT block markdown — it has always meant "a paragraph
 * break inside this block" here, and callers rely on it.
 *
 * Both markers are narrower than markdown's own grammar on purpose, because
 * a false refusal here blocks an edit that was always correct while the miss
 * it guards against is only a literal-character insert the integrity check
 * then reports. So an ordered marker is at most two digits: CommonMark would
 * read `2026. A year` as a list, and prose writes years far more often than
 * it writes hundred-item lists.
 */
/**
 * A line that OPENS or CLOSES a fenced code block, as opposed to one that
 * merely begins with an inline code span.
 *
 * A bare `^```` refused `` ```**kwargs``` is Python `` — a perfectly ordinary
 * inline replacement — because the span happened to sit at the head of the
 * line. A real fence line carries an info string at most, so no further
 * backtick follows it; a span always closes on the same line.
 */
function isFenceLine(line: string): boolean {
  return /^```[^`]*$/.test(line) || /^~~~/.test(line);
}

function blockMarkdownLine(replace: string): string | null {
  const lines = replace.split('\n');
  const multi = lines.length > 1;
  for (const raw of lines) {
    const line = raw.trimStart();
    if (line.length === 0) continue;
    const always =
      /^#{1,6}\s+\S/.test(line) || // ATX heading
      isFenceLine(line) ||
      /^(?:---+|\*\*\*+|___+)\s*$/.test(line); // thematic break
    const whenMulti =
      multi &&
      (/^[-*+]\s+\S/.test(line) || // bullet item
        /^\d{1,2}[.)]\s+\S/.test(line) || // ordered item
        /^>\s?\S/.test(line)); // blockquote
    if (always || whenMulti) return raw.trim();
  }
  return null;
}

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
  const blockLine = blockMarkdownLine(opts.replace);
  if (blockLine != null) {
    // A replacement is spliced INTO one Y.XmlText. Inline syntax can become
    // marks on those characters; a heading, a list item or a rule cannot —
    // it has no home inside a block, so it landed on screen as literal `###`
    // with the block count unchanged, ok:true, and a correct file on disk.
    // Refusing is the only honest answer available here: turning one block
    // into several is `insert_blocks_*`'s job, and doing it silently from
    // this verb is the corruption, not the cure.
    return {
      ok: false,
      error: 'block-markdown-in-replacement',
      blockLine,
      message:
        `replace contains block-level markdown ("${blockLine}"), which cannot go inside an ` +
        'existing block — it would land in the doc as literal characters. Use ' +
        'insert_blocks_after_thread or insert_blocks_at_anchor to add new blocks, and keep ' +
        'find_and_replace for inline text.',
    };
  }
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
