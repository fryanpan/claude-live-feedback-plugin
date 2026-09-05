import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getProseFragment } from '../src/prose-fragment.ts';
import { detectLiteralMarkdown, literalMarkdownMessage } from '../src/prose-integrity.ts';
import { parseMarkdownBlocks } from '../src/prose-markdown.ts';

/**
 * The post-write read that gives the writing agent a signal at all. Every
 * corruption in this family returns ok and serializes back to a correct
 * file; the live doc is the only casualty.
 */

/** Parse markdown into an attached fragment. */
function parseInto(md: string): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  const fragment = getProseFragment(doc);
  doc.transact(() => fragment.insert(0, parseMarkdownBlocks(md)));
  return { doc, fragment };
}

describe('the post-write integrity read names the block that holds literal markdown', () => {
  it('finds a heading embedded as text and says which block', () => {
    const doc = new Y.Doc();
    const fragment = getProseFragment(doc);
    doc.transact(() => {
      fragment.insert(0, parseMarkdownBlocks('Intro paragraph.\n\nSecond paragraph.'));
    });
    const second = fragment.get(1) as Y.XmlElement;
    doc.transact(() => {
      (second.get(0) as Y.XmlText).insert(0, '### Sources\n\n');
    });
    const finding = detectLiteralMarkdown(fragment);
    expect(finding).not.toBeNull();
    expect(finding?.blockIndex).toBe(1);
    expect(finding?.kind).toBe('heading');
    expect(literalMarkdownMessage(finding!)).toContain('block 1');
    expect(literalMarkdownMessage(finding!)).toContain('insert_blocks_after_thread');
  });

  it('finds a list marker at the head of a line', () => {
    const doc = new Y.Doc();
    const fragment = getProseFragment(doc);
    doc.transact(() => fragment.insert(0, parseMarkdownBlocks('Steps:')));
    doc.transact(() => {
      ((fragment.get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(6, '\n- one\n- two');
    });
    expect(detectLiteralMarkdown(fragment)?.kind).toBe('bullet');
  });

  it('does not fire on a fenced code block', () => {
    const { fragment } = parseInto('```python\ndef f(**kwargs):\n    # 1. do it\n    pass\n```');
    expect(detectLiteralMarkdown(fragment)).toBeNull();
  });

  it('does not fire on an inline code span holding asterisks', () => {
    const { fragment } = parseInto('Pass `**kwargs` through to the callee.');
    expect(detectLiteralMarkdown(fragment)).toBeNull();
  });

  it('does not fire on bold spanning a soft line break in a list item', () => {
    // Measured on this repo's own docs: a wrapped bullet puts the marker line
    // and its continuation in separate paragraph children, so bold opened on
    // one and closed on the other leaves a single `**` in each. Twelve of the
    // repo's seventy-six markdown files parse that way, and a bare `**` test
    // called every one of them corrupt — a permanent syncError on every write
    // to those docs, with nothing the agent could do about it.
    const { fragment } = parseInto(
      [
        "- **Don't append CSS at the end of any stylesheet under",
        '  `src/`** — put rules in the banner they belong to.',
        '- A second item, so the list is a list.',
      ].join('\n'),
    );
    expect(detectLiteralMarkdown(fragment)).toBeNull();
  });

  it('still fires on a complete bold run inserted as characters', () => {
    // The positive control for the pair above: the same block shape, but the
    // whole `**label**` is present as text. This is the incident shape.
    const { fragment } = parseInto('- A list item.\n- Another item.');
    const list = fragment.get(0) as Y.XmlElement;
    const item = list.get(1) as Y.XmlElement;
    const para = item.get(0) as Y.XmlElement;
    (fragment.doc as Y.Doc).transact(() => {
      (para.get(0) as Y.XmlText).insert(0, '**Bold label.** ');
    });
    expect(detectLiteralMarkdown(fragment)?.kind).toBe('bold');
  });

  it('does not fire on a numbered heading', () => {
    // `### 1. Change how you say the words` is a heading whose TEXT begins
    // "1. ". Found by running the detector over the doc the incident was
    // reported on: the first version called every one of its numbered
    // section headings corruption.
    const { fragment } = parseInto('### 1. Change how you say the words\n\nBody.');
    expect(detectLiteralMarkdown(fragment)).toBeNull();
  });

  it('does not fire on a quoted list inside a blockquote', () => {
    const { fragment } = parseInto('> 1. at, as, it\n> 2. up, us, ox');
    expect(detectLiteralMarkdown(fragment)).toBeNull();
  });

  it('still fires on a list marker inside a paragraph', () => {
    const { fragment } = parseInto('Steps follow.');
    const doc = (fragment.doc as unknown as { transact: (f: () => void) => void }) ?? null;
    expect(doc).not.toBeNull();
    const block = fragment.get(0) as Y.XmlElement;
    doc.transact(() => {
      (block.get(0) as Y.XmlText).insert(13, '\n- one\n- two');
    });
    expect(detectLiteralMarkdown(fragment)?.kind).toBe('bullet');
  });

  it('does not fire on an ordinary doc with bold, lists and headings', () => {
    const { fragment } = parseInto(
      ['# Title', '', 'A **bold** claim.', '', '- one', '- two', '', '1. first', '2. second'].join(
        '\n',
      ),
    );
    expect(detectLiteralMarkdown(fragment)).toBeNull();
  });
});
