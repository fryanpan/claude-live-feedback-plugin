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
          currentBlock?.nodeName === 'heading'
            ? Number(currentBlock.getAttribute('level') ?? 1)
            : undefined,
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
 * Locate `find` in the flattened doc text, optionally requiring a
 * surrounding context. Returns all match positions mapped back to
 * (Y.XmlText, local offset) so the caller can mutate in place.
 *
 * Matches that straddle two Y.XmlText nodes are omitted and returned as
 * a separate `crossNode` count so the caller can report a meaningful
 * error without silently skipping content.
 */
export function locateMatches(
  fragment: Y.XmlFragment,
  opts: {
    find: string;
    contextBefore?: string;
    contextAfter?: string;
  },
): { matches: LocatedMatch[]; crossNode: number; plainText: string } {
  const { plainText, segments } = walkProse(fragment);
  const find = opts.find;
  if (find.length === 0) return { matches: [], crossNode: 0, plainText };

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

  const matches: LocatedMatch[] = [];
  let crossNode = 0;
  for (const r of raw) {
    const seg = findSegmentForOffset(segments, r.docOffset);
    if (!seg) continue;
    const offsetInNode = r.docOffset - seg.docOffset;
    if (offsetInNode + find.length > seg.length) {
      // Match spans a segment boundary — skip for MVP.
      crossNode++;
      continue;
    }
    matches.push({
      segment: seg,
      offsetInNode,
      length: find.length,
      docOffset: r.docOffset,
    });
  }
  return { matches, crossNode, plainText };
}

function findSegmentForOffset(segments: TextSegment[], offset: number): TextSegment | null {
  for (const s of segments) {
    if (offset >= s.docOffset && offset < s.docOffset + s.length) return s;
  }
  return null;
}

export interface ReplaceResult {
  ok: boolean;
  error?: 'no-match' | 'ambiguous' | 'cross-node' | 'out-of-range' | 'occurrence-out-of-range';
  /** For ambiguous results, a short preview of each candidate's neighbourhood. */
  candidates?: Array<{ docOffset: number; preview: string }>;
}

/**
 * Resolve a find (with optional context) and replace it in place. The
 * replacement is inserted as plain text into the SAME Y.XmlText node —
 * so any marks (bold, italic, links) covering the matched text apply
 * to the replacement too, which is what you want when fixing a typo
 * inside an italicized span.
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
    transactionOrigin?: unknown;
  },
): ReplaceResult {
  const fragment = getProseFragment(doc);
  const { matches, crossNode, plainText } = locateMatches(fragment, opts);

  if (matches.length === 0) {
    if (crossNode > 0) return { ok: false, error: 'cross-node' };
    return { ok: false, error: 'no-match' };
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

  doc.transact(() => {
    chosen.segment.node.delete(chosen.offsetInNode, chosen.length);
    if (opts.replace.length > 0) chosen.segment.node.insert(chosen.offsetInNode, opts.replace);
  }, opts.transactionOrigin ?? 'agent');

  return { ok: true };
}

function preview(text: string, at: number, length: number): string {
  const pad = 24;
  const start = Math.max(0, at - pad);
  const end = Math.min(text.length, at + length + pad);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end).replace(/\n/g, ' ') + suffix;
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
 *  that need to mutate (splice, insert) can operate directly on the node. */
export function resolveRelativePositionRaw(
  doc: Y.Doc,
  encoded: Uint8Array,
): { node: Y.XmlText; offset: number } | null {
  const rel = Y.decodeRelativePosition(encoded);
  const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
  if (!abs) return null;
  if (!(abs.type instanceof Y.XmlText)) return null;
  return { node: abs.type, offset: abs.index };
}

export interface AnchoredEditResult {
  ok: boolean;
  error?: 'anchor-not-found' | 'anchor-orphaned' | 'cross-block' | 'no-host-block' | 'parse-failed';
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
    transactionOrigin?: unknown;
  },
): AnchoredEditResult {
  const start = resolveRelativePositionRaw(doc, opts.startRel);
  const end = resolveRelativePositionRaw(doc, opts.endRel);
  if (!start || !end) return { ok: false, error: 'anchor-orphaned' };

  if (start.node === end.node) {
    const from = Math.min(start.offset, end.offset);
    const to = Math.max(start.offset, end.offset);
    doc.transact(() => {
      start.node.delete(from, to - from);
      if (opts.replacement.length > 0) start.node.insert(from, opts.replacement);
    }, opts.transactionOrigin ?? 'agent');
    return { ok: true };
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
    if (opts.replacement.length > 0) {
      touched[0]!.node.insert(firstOffset, opts.replacement);
    }
  }, opts.transactionOrigin ?? 'agent');
  return { ok: true };
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

    // [text](url)
    if (r.startsWith('[')) {
      const rb = r.indexOf(']');
      if (rb > 0 && r[rb + 1] === '(') {
        const rp = r.indexOf(')', rb + 2);
        if (rp > 0) {
          flush();
          out.push({
            insert: r.slice(1, rb),
            attributes: { link: { href: r.slice(rb + 2, rp) } },
          });
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
        const close = r.indexOf(m, m.length);
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
      if (r.startsWith(m) && r[1] && r[1] !== ' ' && r[1] !== m) {
        const close = r.indexOf(m, 1);
        if (close > 1 && r[close - 1] !== ' ') {
          emitWith(r.slice(1, close), { italic: true });
          i += close + 1;
          matched = true;
          break;
        }
      }
    }
    if (matched) continue;

    buf += text[i];
    i++;
  }
  flush();
  return out;
}

function insertDeltaInto(xmlText: Y.XmlText, delta: ReturnType<typeof inlineMarksToDelta>): void {
  if (delta.length === 0) return;
  xmlText.applyDelta(delta);
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

  const isBlockStart = (s: string) =>
    isHeading(s) ||
    isBullet(s) ||
    isNumbered(s) ||
    isQuote(s) ||
    isFence(s) ||
    isRule(s) ||
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
      h.setAttribute('level', String(level));
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
      const ordered = isNumbered(line);
      const list = new Y.XmlElement(ordered ? 'orderedList' : 'bulletList');
      const stripRe = ordered ? /^\d+\.\s+/ : /^[-*]\s+/;
      while (i < lines.length && (ordered ? isNumbered : isBullet)(lines[i] ?? '')) {
        const itemText = (lines[i] ?? '').replace(stripRe, '');
        const li = new Y.XmlElement('listItem');
        li.insert(0, [mkParagraph(itemText)]);
        list.insert(list.length, [li]);
        i++;
      }
      out.push(list);
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
  switch (node.nodeName) {
    case 'paragraph':
      return textContent(node);
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.getAttribute('level') ?? 1)));
      const text = textContent(node);
      return text.length > 0 ? `${'#'.repeat(level)} ${text}` : null;
    }
    case 'blockquote':
      return textContent(node)
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
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
      return listItems(node)
        .map((item) => `- ${item}`)
        .join('\n');
    case 'orderedList':
      return listItems(node)
        .map((item, i) => `${i + 1}. ${item}`)
        .join('\n');
    case 'table':
      return serializeTable(node);
    default:
      return textContent(node);
  }
}

function serializeTable(table: Y.XmlElement): string {
  const rows = table
    .toArray()
    .filter((n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'tableRow');
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
  for (const op of delta) {
    if (typeof op.insert !== 'string') continue;
    out += wrapMarks(op.insert, op.attributes);
  }
  return out;
}

function wrapMarks(text: string, attrs: Record<string, unknown> | undefined): string {
  if (!attrs || text.length === 0) return text;
  let s = text;
  // Order matters: inner marks wrap first, outer last. Link goes outermost.
  if (attrs.code) s = `\`${s}\``;
  if (attrs.italic) s = `*${s}*`;
  if (attrs.bold) s = `**${s}**`;
  if (attrs.strike) s = `~~${s}~~`;
  if (attrs.link && typeof attrs.link === 'object' && attrs.link !== null) {
    const href = (attrs.link as { href?: string }).href ?? '';
    if (href) s = `[${s}](${href})`;
  }
  return s;
}

function listItems(list: Y.XmlElement): string[] {
  const items: string[] = [];
  for (const li of list.toArray()) {
    if (!(li instanceof Y.XmlElement) || li.nodeName !== 'listItem') continue;
    // listItem contains one or more paragraphs; concatenate their text.
    const bits: string[] = [];
    for (const child of li.toArray()) {
      if (child instanceof Y.XmlElement) bits.push(textContent(child));
    }
    items.push(bits.join(' '));
  }
  return items;
}

/**
 * Insert one or more markdown-parsed blocks AFTER the block containing
 * the anchor. Use this for "add a paragraph after this heading" or
 * "add a section here" — the anchor tells the agent where in the doc
 * structure to splice, and the markdown describes the new content.
 */
export function insertBlocksAfterAnchor(
  doc: Y.Doc,
  opts: {
    anchorRel: Uint8Array;
    markdown: string;
    transactionOrigin?: unknown;
  },
): AnchoredEditResult {
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
    const needle = anchor.snippet.text;
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
  const fragment = getProseFragment(doc);
  const { matches, crossNode } = locateMatches(fragment, opts);
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
    const { plainText } = walkProse(fragment);
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

  const startRel = Y.createRelativePositionFromTypeIndex(chosen.segment.node, chosen.offsetInNode);
  const endRel = Y.createRelativePositionFromTypeIndex(
    chosen.segment.node,
    chosen.offsetInNode + chosen.length,
  );
  const anchorId = `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const entry = new Y.Map<unknown>();
  doc.transact(() => {
    entry.set('startRel', Y.encodeRelativePosition(startRel));
    entry.set('endRel', Y.encodeRelativePosition(endRel));
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
