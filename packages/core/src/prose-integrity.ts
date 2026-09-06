/**
 * Does the live doc hold markdown SYNTAX as literal characters?
 *
 * Every corruption in this family looks identical from the writing side: the
 * verb returns ok, the file on disk serializes back correctly, and the only
 * casualty is the live doc, where `**`, `###` and list markers sit on screen
 * as text. Nobody who could fix it ever sees a signal. This module is that
 * signal — one cheap read over the fragment, run after a write, reported as
 * a `syncError` naming the block.
 *
 * It reads the doc's PLAIN text: marks are stripped, so a healthy doc has
 * zero `**` and zero `###`. Two places legitimately carry markdown
 * characters and are excluded rather than reported: fenced code blocks, and
 * runs carrying the inline `code` mark (```**kwargs``` is Python, not bold).
 *
 * Imports `prose-fragment.ts` only; nothing here parses or serializes.
 */
import * as Y from 'yjs';
import { headingLevelOf } from './prose-fragment.ts';

export type LiteralMarkdownKind = 'bold' | 'heading' | 'bullet' | 'ordered';

export interface LiteralMarkdownFinding {
  /** Position of the offending block among the fragment's top-level children. */
  blockIndex: number;
  /** Its tag — `paragraph`, `listItem`'s owning `bulletList`, and so on. */
  blockType: string;
  kind: LiteralMarkdownKind;
  /** The offending line, trimmed for a one-line error message. */
  snippet: string;
}

const SNIPPET_MAX = 80;

/** A heading run, as it renders when a heading was inserted as text. */
const LITERAL_HEADING = /###/;
/**
 * A COMPLETE bold run: an opener and a closer on one line with content
 * between them.
 *
 * A bare `\*\*` looked safe and was not. Bold that spans a soft line break
 * inside a list item is stored as one `**` in each of the item's paragraph
 * children, so a lone marker is ordinary healthy content — it fired on 12 of
 * this repo's own 76 markdown files on a clean parse, which would have put a
 * permanent, unactionable syncError on every write to them and concatenated
 * it onto any real disk conflict. Requiring the pair takes that to zero and
 * still catches the incident shape, where the whole `**label**` was inserted
 * as characters.
 */
const LITERAL_BOLD = /\*\*[^*\n]+\*\*/;
/** A bullet marker at the head of a line. */
const LITERAL_BULLET = /^[ \t]*[-*][ \t]+\S/;
/** An ordered marker at the head of a line. */
const LITERAL_ORDERED = /^[ \t]*\d+\.[ \t]+\S/;

/**
 * Read one block's plain text.
 *
 * Block children are separated by `\n` so "line-leading" means something: a
 * list item whose own text begins with `- ` is a marker that was inserted as
 * characters, and that is exactly what this has to be able to say. Code
 * blocks contribute nothing, and a `code`-marked run contributes a space, so
 * neither can raise a false alarm.
 */
function blockPlainText(node: Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) {
    let out = '';
    for (const op of node.toDelta() as Array<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>) {
      if (typeof op.insert !== 'string') continue;
      out += op.attributes?.code != null ? ' '.repeat(op.insert.length) : op.insert;
    }
    return out;
  }
  if (node.nodeName === 'codeBlock') return '';
  const parts: string[] = [];
  for (const child of node.toArray()) {
    parts.push(blockPlainText(child as Y.XmlElement | Y.XmlText));
  }
  // Paragraphs, list items and table cells each start a line of their own.
  return parts.join(node.nodeName === 'paragraph' || node.nodeName === 'heading' ? '' : '\n');
}

/**
 * Where a line-leading marker is evidence of corruption.
 *
 * In a paragraph or a list item it is: markdown would have parsed a real
 * list there, so a marker surviving as characters means something inserted
 * it. Everywhere else it is ordinary content — `### 1. Change how you say
 * the words` is a numbered heading, a quoted list lives inside a blockquote
 * as text by design, and a table cell may hold `- 5`. Those blocks are still
 * checked for `**` and `###`.
 */
function markersMeanCorruption(blockType: string): boolean {
  return blockType === 'paragraph' || blockType === 'bulletList' || blockType === 'orderedList';
}

function classify(
  text: string,
  checkLineMarkers: boolean,
): { kind: LiteralMarkdownKind; snippet: string } | null {
  for (const line of text.split('\n')) {
    if (LITERAL_HEADING.test(line)) return { kind: 'heading', snippet: trim(line) };
    if (LITERAL_BOLD.test(line)) return { kind: 'bold', snippet: trim(line) };
    if (!checkLineMarkers) continue;
    if (LITERAL_BULLET.test(line)) return { kind: 'bullet', snippet: trim(line) };
    if (LITERAL_ORDERED.test(line)) return { kind: 'ordered', snippet: trim(line) };
  }
  return null;
}

function trim(line: string): string {
  const s = line.trim();
  return s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX - 1)}…` : s;
}

/**
 * The first block whose plain text carries literal markdown syntax, or null
 * when the doc is clean. First rather than all: the message exists to send
 * someone to look, and one address does that.
 */
export function detectLiteralMarkdown(fragment: Y.XmlFragment): LiteralMarkdownFinding | null {
  const children = fragment.toArray() as (Y.XmlElement | Y.XmlText)[];
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (child instanceof Y.XmlElement && child.nodeName === 'codeBlock') continue;
    const nodeName = child instanceof Y.XmlElement ? child.nodeName : 'text';
    const found = classify(blockPlainText(child), markersMeanCorruption(nodeName));
    if (!found) continue;
    const type =
      child instanceof Y.XmlElement
        ? child.nodeName === 'heading'
          ? `heading${headingLevelOf(child)}`
          : child.nodeName
        : 'text';
    return { blockIndex: i, blockType: type, kind: found.kind, snippet: found.snippet };
  }
  return null;
}

/** The `syncError.message` a finding becomes. Names the block and what to do. */
export function literalMarkdownMessage(finding: LiteralMarkdownFinding): string {
  const what = {
    bold: 'a bold run (`**`)',
    heading: 'a heading (`###`)',
    bullet: 'a bullet marker (`- `)',
    ordered: 'an ordered-list marker (`1. `)',
  }[finding.kind];
  return (
    `block ${finding.blockIndex} (${finding.blockType}) holds ${what} as literal text: ` +
    `"${finding.snippet}". Block-level markdown cannot be inserted into an existing block — ` +
    'use insert_blocks_after_thread / insert_blocks_at_anchor, or reparse_from_disk to rebuild ' +
    'the doc from the file.'
  );
}
