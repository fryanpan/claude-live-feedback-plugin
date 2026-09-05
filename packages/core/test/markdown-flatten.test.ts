import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getProseFragment, walkProse } from '../src/prose-fragment.ts';
import { parseMarkdownBlocks, serializeFragmentToMarkdown } from '../src/prose-markdown.ts';

/**
 * The bound-doc flattening incident of 2026-09-04, in the two shapes that
 * actually produce it. A whole region of a research doc rendered as one
 * paragraph with `###` and `**` on screen, while the file on disk stayed
 * correct and every write returned ok.
 */

/** Parse markdown into an attached fragment and report each top-level block. */
function parseInto(md: string): { doc: Y.Doc; fragment: Y.XmlFragment; kinds: string[] } {
  const doc = new Y.Doc();
  const fragment = getProseFragment(doc);
  doc.transact(() => fragment.insert(0, parseMarkdownBlocks(md)));
  const kinds = (fragment.toArray() as Y.XmlElement[]).map((b) => b.nodeName);
  return { doc, fragment, kinds };
}

/** The doc's text with marks stripped — the form a healthy doc has no `**` in. */
function plain(fragment: Y.XmlFragment): string {
  return walkProse(fragment).plainText;
}

describe('a blank line between list items makes a loose list, not a flattened region', () => {
  // The exact shape of the file that broke: three items, a blank line, three
  // more, then prose and an `###` heading. Content invented; only the shape
  // is taken from the report.
  const looseList = [
    '### Ranked build directions',
    '',
    '1. **Generator with a hard verifier loop.** Regenerate until it clears.',
    '2. **No app at all.** A text file and a template. No accounts, no state.',
    '3. **Instrument the real sessions.** Two weeks yields the real sequence.',
    '',
    '4. **Consistent original art.** Lock the reference sheets up front.',
    '5. **Re-letter something you already have.** Swap one pipeline step.',
    '6. **Adaptive coach** — recognition, error detection, next-item choice.',
    '',
    '**The recommendation, which is not the order I would have guessed:**',
    '',
    '### The strongest argument against building any of it',
    '',
    'The cheaper option already covers the case the expensive one is for.',
    '',
    'That should change the pitch rather than the decision.',
  ].join('\n');

  it('keeps the six items in one list across the blank line', () => {
    const { fragment, kinds } = parseInto(looseList);
    expect(kinds).toEqual([
      'heading',
      'orderedList',
      'paragraph',
      'heading',
      'paragraph',
      'paragraph',
    ]);
    const list = fragment.get(1) as Y.XmlElement;
    expect(
      list.toArray().filter((li) => (li as Y.XmlElement).nodeName === 'listItem'),
    ).toHaveLength(6);
  });

  it('leaves no markdown syntax in the doc text', () => {
    const { fragment } = parseInto(looseList);
    const text = plain(fragment);
    expect(text).not.toContain('###');
    expect(text).not.toContain('**');
  });
});

describe('an ATX heading always interrupts a paragraph', () => {
  it('reads an indented heading inside a list item as a heading', () => {
    // Before the fix the item's continuation gatherer had no heading rule at
    // all: the heading and everything under it became literal text inside
    // the list item, which is the "one slip flattens forty lines" shape.
    const { fragment, kinds } = parseInto(
      [
        '- Item one',
        '',
        '  Continuation paragraph.',
        '',
        '  ### Sub heading',
        '',
        '  Under it.',
      ].join('\n'),
    );
    expect(kinds).toEqual(['bulletList', 'heading', 'paragraph']);
    expect(plain(fragment)).not.toContain('###');
  });

  it('reads an indented list after a paragraph line as a list', () => {
    const { fragment, kinds } = parseInto(
      ['Some prose:', '  - alpha', '  - beta', '', '### After'].join('\n'),
    );
    expect(kinds).toEqual(['paragraph', 'bulletList', 'heading']);
    expect(plain(fragment)).not.toContain('- alpha');
  });

  it('breaks a paragraph at a heading with no blank line before it', () => {
    const { kinds } = parseInto(['Paragraph line one', '### Heading no blank', 'Text'].join('\n'));
    expect(kinds).toEqual(['paragraph', 'heading', 'paragraph']);
  });
});

describe("stripping a continuation line keeps the author's line breaks", () => {
  it('drops a continuation indent but keeps a trailing hard break', () => {
    const md = ['One sentence, hard-broken.  ', '  and its indented continuation.'].join('\n');
    const { fragment } = parseInto(md);
    const out = serializeFragmentToMarkdown(fragment);
    // The two trailing spaces ARE the line break markdown renders; trimming
    // them rewrote the author's paragraph on the next write-back.
    expect(out).toContain('hard-broken.  ');
    // The indent is not content, and gluing it in put a run of spaces into
    // the middle of a sentence.
    expect(plain(fragment)).toContain('hard-broken.   and its indented continuation.');
    expect(plain(fragment)).not.toContain('     and');
  });
});
