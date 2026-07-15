import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  getProseFragment,
  parseMarkdownBlocks,
  serializeFragmentToMarkdown,
} from '../src/prose.ts';

/**
 * A blockquote can hold MULTIPLE paragraph children — that's the shape
 * y-prosemirror produces when a human presses Enter inside a quote in the
 * browser editor. The old serializer flattened every child via textContent
 * (joined with ''), so two paragraphs came out run together on one `> ` line
 * with the boundary erased — a CRM peer misread Bryan's own multi-paragraph
 * email draft as a single line because of this. Same class as the nested-list
 * flattening bug; the fix is to recurse.
 */
function para(text: string): Y.XmlElement {
  const p = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  return p;
}

function serialize(frag: Y.XmlFragment): string {
  return serializeFragmentToMarkdown(frag);
}

describe('blockquote serialization', () => {
  it('keeps a paragraph boundary between multiple paragraph children (editor shape)', () => {
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    const bq = new Y.XmlElement('blockquote');
    bq.insert(0, [para('First paragraph of the quote.'), para('Second paragraph, separate.')]);
    frag.push([bq]);

    expect(serialize(frag)).toBe(
      '> First paragraph of the quote.\n>\n> Second paragraph, separate.\n',
    );
  });

  it('renders a single paragraph with a soft break as adjacent quote lines', () => {
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    const bq = new Y.XmlElement('blockquote');
    bq.insert(0, [para('Line one\nline two')]);
    frag.push([bq]);

    expect(serialize(frag)).toBe('> Line one\n> line two\n');
  });

  it('round-trips a multi-paragraph blockquote through markdown stably', () => {
    const md = '> First paragraph.\n>\n> Second paragraph.\n';
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    frag.push(parseMarkdownBlocks(md));

    const once = serialize(frag);
    // Re-parse the serialized output and serialize again — must be a fixpoint.
    const doc2 = new Y.Doc();
    const frag2 = getProseFragment(doc2);
    frag2.push(parseMarkdownBlocks(once));
    expect(serialize(frag2)).toBe(once);
    expect(once).toContain('> First paragraph.');
    expect(once).toContain('> Second paragraph.');
    // The blank quote line is the paragraph separator — it must be there.
    expect(once).toMatch(/First paragraph\.\n>\n> Second/);
  });
});
