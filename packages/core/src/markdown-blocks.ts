/**
 * Split markdown source into top-level block spans, tracking byte offsets.
 *
 * `parseMarkdownBlocks` (prose.ts) produces Yjs elements and discards source
 * positions. The redline needs the positions: a rendered block has to be able
 * to name its own byte range in the `content` Y.Text, so a comment on it
 * anchors line-snapped exactly like the source diff view's comments do.
 *
 * Invariant: `block.text === md.slice(block.from, block.to)` for every block
 * (against \n-normalized source). The line grammar deliberately mirrors
 * prose.ts's parser so the two agree on what a block is.
 */

export type MarkdownBlockType =
  | 'heading'
  | 'paragraph'
  | 'bulletList'
  | 'orderedList'
  | 'blockquote'
  | 'codeBlock'
  | 'horizontalRule'
  | 'table';

export interface MarkdownBlockSpan {
  type: MarkdownBlockType;
  /** Verbatim source: text === md.slice(from, to). */
  text: string;
  from: number;
  to: number;
}

const isHeading = (s: string) => /^#{1,6}\s+/.test(s);
const isBullet = (s: string) => /^\s*[-*]\s+/.test(s);
const isNumbered = (s: string) => /^\s*\d+\.\s+/.test(s);
const isQuote = (s: string) => /^>/.test(s);
const isFence = (s: string) => /^```/.test(s);
const isRule = (s: string) => /^(---|\*\*\*|___)\s*$/.test(s);
const isTableRow = (s: string) => /^\|.*\|\s*$/.test(s);
const isTableSep = (s: string) => /^\|[\s:|-]+\|\s*$/.test(s);
/** Indented continuation of the block above (list item body, lazy line). */
const isIndented = (s: string) => /^\s+\S/.test(s);

export function splitMarkdownBlocks(md: string): MarkdownBlockSpan[] {
  // CRLF would put every offset after line 1 off by one per line. Callers pass
  // content the server already read as \n; this is belt-and-braces, and the
  // reported offsets index the NORMALIZED string.
  const src = md.replace(/\r\n/g, '\n');
  const out: MarkdownBlockSpan[] = [];

  // Line table with absolute start offsets, so a block's span is just
  // starts[first] .. starts[last] + lines[last].length.
  const lines: string[] = [];
  const starts: number[] = [];
  let cursor = 0;
  for (const line of src.split('\n')) {
    lines.push(line);
    starts.push(cursor);
    cursor += line.length + 1; // +1 for the \n
  }

  const emit = (type: MarkdownBlockType, first: number, last: number): void => {
    const from = starts[first];
    const to = starts[last] + lines[last].length;
    if (to <= from) return;
    out.push({ type, text: src.slice(from, to), from, to });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    // Fences first: everything inside one is literal, so no other rule may
    // look at those lines.
    if (isFence(line)) {
      const start = i;
      i++;
      while (i < lines.length && !isFence(lines[i])) i++;
      if (i < lines.length) i++; // closing fence
      emit('codeBlock', start, i - 1);
      continue;
    }
    if (isRule(line)) {
      emit('horizontalRule', i, i);
      i++;
      continue;
    }
    if (isHeading(line)) {
      emit('heading', i, i);
      i++;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const start = i;
      while (i < lines.length && isTableRow(lines[i])) i++;
      emit('table', start, i - 1);
      continue;
    }
    if (isQuote(line)) {
      const start = i;
      while (i < lines.length && isQuote(lines[i])) i++;
      emit('blockquote', start, i - 1);
      continue;
    }
    if (isBullet(line) || isNumbered(line)) {
      const type: MarkdownBlockType = isBullet(line) ? 'bulletList' : 'orderedList';
      const start = i;
      // A list runs until a line that is neither an item, an indented
      // continuation, nor a blank line followed by one of those — so nested
      // items and multi-paragraph item bodies stay inside the block.
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') {
          const next = lines[i + 1] ?? '';
          if (!isIndented(next) && !isBullet(next) && !isNumbered(next)) break;
        } else if (!isBullet(l) && !isNumbered(l) && !isIndented(l)) {
          break;
        }
        i++;
      }
      // Don't let a trailing blank line inside the run land in the span.
      let last = i - 1;
      while (last > start && lines[last].trim() === '') last--;
      emit(type, start, last);
      continue;
    }
    // Paragraph: runs to the next blank line or block starter.
    const start = i;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') break;
      if (i > start && (isHeading(l) || isFence(l) || isRule(l) || isQuote(l))) break;
      if (i > start && (isBullet(l) || isNumbered(l))) break;
      i++;
    }
    emit('paragraph', start, i - 1);
  }
  return out;
}
