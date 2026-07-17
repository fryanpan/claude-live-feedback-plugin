import { describe, expect, it } from 'vitest';
import { splitMarkdownBlocks } from '../src/markdown-blocks.ts';

describe('splitMarkdownBlocks', () => {
  it('returns spans whose text is verbatim source', () => {
    // THE invariant: the whole provenance chain rests on being able to slice
    // a block's source back out of the document by its reported offsets.
    const md = '# Title\n\nA paragraph.\n\n- a\n- b\n\n> quote\n\n```ts\nx\n```\n';
    const blocks = splitMarkdownBlocks(md);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(md.slice(b.from, b.to)).toBe(b.text);
    }
  });

  it('splits headings and paragraphs', () => {
    const blocks = splitMarkdownBlocks('# Title\n\nA paragraph.\n');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph']);
    expect(blocks[0].text.trim()).toBe('# Title');
    expect(blocks[1].text.trim()).toBe('A paragraph.');
  });

  it('keeps a fenced code block whole, including blank lines inside it', () => {
    const md = '```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter.\n';
    const blocks = splitMarkdownBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual(['codeBlock', 'paragraph']);
    expect(blocks[0].text).toContain('const b = 2;');
  });

  it('does not treat markdown inside a fence as block syntax', () => {
    const md = '```md\n# not a heading\n- not a list\n```\n';
    const blocks = splitMarkdownBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('codeBlock');
  });

  it('keeps a multi-item list as one block', () => {
    const blocks = splitMarkdownBlocks('- one\n- two\n- three\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('bulletList');
  });

  it('keeps a nested list inside its parent block', () => {
    const blocks = splitMarkdownBlocks('- one\n  - nested\n- two\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('nested');
  });

  it('distinguishes ordered from bullet lists', () => {
    expect(splitMarkdownBlocks('1. one\n2. two\n')[0].type).toBe('orderedList');
    expect(splitMarkdownBlocks('- one\n')[0].type).toBe('bulletList');
  });

  it('keeps a multi-paragraph blockquote as one block', () => {
    const blocks = splitMarkdownBlocks('> First.\n>\n> Second.\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('blockquote');
  });

  it('splits a pipe table as one block', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter.\n';
    const blocks = splitMarkdownBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual(['table', 'paragraph']);
  });

  it('recognizes a horizontal rule', () => {
    const blocks = splitMarkdownBlocks('A.\n\n---\n\nB.\n');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'horizontalRule', 'paragraph']);
  });

  it('returns an empty array for empty or blank input', () => {
    expect(splitMarkdownBlocks('')).toEqual([]);
    expect(splitMarkdownBlocks('\n\n')).toEqual([]);
    expect(splitMarkdownBlocks('   \n')).toEqual([]);
  });

  it('normalizes CRLF without breaking the slice invariant', () => {
    const md = '# T\r\n\r\nBody.\r\n';
    const normalized = md.replace(/\r\n/g, '\n');
    for (const b of splitMarkdownBlocks(md)) {
      expect(normalized.slice(b.from, b.to)).toBe(b.text);
    }
  });

  it('produces non-overlapping spans in ascending order', () => {
    const blocks = splitMarkdownBlocks('# T\n\nA.\n\n- x\n- y\n\n> q\n');
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].from).toBeGreaterThanOrEqual(blocks[i - 1].to);
    }
  });

  it('keeps a multi-line paragraph together', () => {
    const blocks = splitMarkdownBlocks('one\ntwo\nthree\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('one\ntwo\nthree');
  });

  it('ends a paragraph at a following block starter with no blank line', () => {
    const blocks = splitMarkdownBlocks('text\n# Heading\n');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'heading']);
  });
});
