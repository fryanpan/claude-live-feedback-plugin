import type { MarkdownBlockType, RedlineBlock, RedlineSegment } from '@feedback/core';

/**
 * Render redline blocks to HTML for the read-only Tiptap surface.
 *
 * Why HTML and not markdown — three probed facts (see the REVISION note in
 * docs/product/plans/md-redline-plan.md):
 *
 *  1. Provenance via `data-*` needs an HTML element, and an HTML *block* in
 *     markdown stops markdown parsing inside it. So markdown-with-attributes
 *     is not available.
 *  2. Adjacent same-type lists MERGE across a blank line, so "one emitted
 *     markdown block = one top-level node" is false — a deleted list followed
 *     by its inserted replacement collapses into a single node and shifts
 *     every later anchor.
 *  3. Inline `<ins>`/`<del>` inside a markdown block works, and markdown inside
 *     the wrapper still parses.
 *
 * So each block's markdown is converted to HTML in ISOLATION (fact 2 can't
 * bite across separate parses), the provenance attributes are injected into
 * the resulting element AFTER conversion (fact 1 defused — the inline content
 * is already HTML), and inline change marks ride along from fact 3.
 */

/** Converts one block's markdown to HTML. Injected so this module stays pure
 *  and testable; the surface passes a scratch-editor-backed implementation. */
export type MarkdownToHtml = (markdown: string) => string;

const TAG = { ins: 'ins', del: 'del' } as const;

/** Leading block marker that must stay literal markdown — wrapping it would
 *  turn `## Heading` into a paragraph of struck-through hashes. */
const MARKER_RE = /^(\s*(?:#{1,6}\s+|[-*]\s+|\d+\.\s+|>\s?))/;

/**
 * Blocks whose ENTIRE body is literal syntax, where no inline wrapping is
 * possible at all.
 *
 * A fence wrapped per line produces "<del>```js</del>\n<del>const a = 1;</del>",
 * whose backticks then pair into an inline code span ACROSS the wrappers: the
 * fence disappears, the tags render as escaped literal text, and the reviewer
 * sees garbage with no strikethrough. A table row wrapped as "<del>| a | b |</del>"
 * stops starting with a pipe, so it stops being a table row.
 *
 * `pairable()` already refuses to word-diff these, so such a block is always a
 * whole-block same/ins/del — the change signal belongs on the block
 * (data-lf-change + CSS), which is where the design put it anyway.
 */
const STRUCTURAL: readonly MarkdownBlockType[] = ['codeBlock', 'table', 'horizontalRule'];

interface Piece {
  kind: RedlineSegment['kind'];
  text: string;
}

/**
 * Rebuild a block's markdown with changed runs wrapped in `<ins>`/`<del>`.
 *
 * Wrappers never cross a newline (probed: `<ins>` spanning a line break merged
 * two list items into one), and any leading block marker on EVERY line stays
 * outside the wrapper — not just the first line's, since a list block's later
 * items carry their own markers.
 */
export function annotateBlockMarkdown(
  segments: RedlineSegment[],
  type?: MarkdownBlockType,
): string {
  // Literal-syntax blocks are emitted verbatim; see STRUCTURAL.
  if (type && STRUCTURAL.includes(type)) return segments.map((s) => s.text).join('');
  const lines: Piece[][] = [[]];
  for (const seg of segments) {
    const parts = seg.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part !== '') lines[lines.length - 1].push({ kind: seg.kind, text: part });
    });
  }
  return lines.map(renderLine).join('\n');
}

function renderLine(pieces: Piece[]): string {
  const full = pieces.map((p) => p.text).join('');
  const markerLen = MARKER_RE.exec(full)?.[1].length ?? 0;
  let consumed = 0;
  const out: string[] = [];
  for (const piece of pieces) {
    let text = piece.text;
    // The marker is emitted raw regardless of which side it came from — it is
    // structure, not prose, and a wrapped marker breaks the block.
    if (consumed < markerLen) {
      const take = Math.min(markerLen - consumed, text.length);
      out.push(text.slice(0, take));
      consumed += take;
      text = text.slice(take);
      if (text === '') continue;
    }
    out.push(wrap(piece.kind, text));
  }
  return out.join('');
}

function wrap(kind: RedlineSegment['kind'], text: string): string {
  if (kind === 'same') return text;
  // A wrapper around pure whitespace renders as a stray underlined gap.
  if (text.trim() === '') return text;
  const tag = TAG[kind];
  return `<${tag}>${text}</${tag}>`;
}

/** Provenance + change attributes for one block. */
function attrsFor(block: RedlineBlock): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (block.from != null && block.to != null) {
    attrs['data-lf-from'] = String(block.from);
    attrs['data-lf-to'] = String(block.to);
  } else if (block.snapTo != null) {
    // Deleted blocks have no new-side span; a comment on one snaps here.
    attrs['data-lf-snap'] = String(block.snapTo);
  }
  if (block.kind !== 'same') attrs['data-lf-change'] = block.kind;
  return attrs;
}

/**
 * Render every block to a single HTML string for `setContent`.
 *
 * `toHtml` converts ONE block's markdown at a time — isolation is the point,
 * not an implementation detail.
 */
export function renderRedlineHtml(blocks: RedlineBlock[], toHtml: MarkdownToHtml): string {
  return blocks
    .map((block) => {
      const md = annotateBlockMarkdown(block.segments, block.type);
      const html = toHtml(md);
      return applyAttrs(html, attrsFor(block));
    })
    .filter((s) => s !== '')
    .join('');
}

/**
 * Drop trailing empty paragraphs from generated HTML.
 *
 * Tiptap appends a trailing empty paragraph after several block types, so a
 * per-block conversion returns e.g. `<h1>T</h1><p></p>`. Left in, each block
 * renders a blank filler paragraph AND — because the attributes are applied to
 * every top-level element — that filler inherits the real block's provenance,
 * so a comment can resolve onto the filler instead of the block it was about.
 *
 * Safe because the block splitter never emits an empty block: any empty
 * paragraph here is Tiptap's, not the document's.
 */
export function stripTrailingEmptyParagraphs(html: string): string {
  const host = document.createElement('div');
  host.innerHTML = html;
  while (host.lastElementChild && isEmptyParagraph(host.lastElementChild)) {
    host.lastElementChild.remove();
  }
  return host.innerHTML;
}

function isEmptyParagraph(el: Element): boolean {
  if (el.tagName !== 'P') return false;
  if ((el.textContent ?? '').trim() !== '') return false;
  // A <br> placeholder is still empty; an image or anything else is not.
  return Array.from(el.children).every((c) => c.tagName === 'BR');
}

/**
 * Put `attrs` on the outer element of `html`.
 *
 * Done through the DOM rather than by string surgery on the opening tag: the
 * tag name, existing attributes and self-closing forms all vary, and a regex
 * over generated HTML is how you get a subtly broken document.
 *
 * A block whose markdown produced several top-level elements (or none) is not
 * expected — each block is one markdown block — but if it happens, every
 * element gets the attributes so a comment still resolves somewhere sane
 * rather than nowhere.
 */
export function applyAttrs(html: string, attrs: Record<string, string>): string {
  if (Object.keys(attrs).length === 0) return html;
  const host = document.createElement('div');
  host.innerHTML = html;
  const children = Array.from(host.children);
  if (children.length === 0) return html;
  for (const el of children) {
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  }
  return host.innerHTML;
}
