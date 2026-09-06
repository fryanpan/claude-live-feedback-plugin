import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { findAndReplace } from '../src/prose-edit.ts';
import { getProseFragment, walkProse } from '../src/prose-fragment.ts';

/**
 * `find_and_replace` splices its replacement into ONE Y.XmlText. Inline
 * syntax can become marks on those characters; a heading or a list item
 * cannot, and used to land on screen as literal `###` with the block count
 * unchanged, `ok: true`, and a correct file on disk. It refuses now.
 */

/** The doc's text with marks stripped. */
function plain(doc: Y.Doc): string {
  return walkProse(getProseFragment(doc)).plainText;
}

/** Seed a one-paragraph doc so an edit verb has something to match. */
function seedParagraph(text: string): Y.Doc {
  const doc = new Y.Doc();
  const fragment = getProseFragment(doc);
  doc.transact(() => {
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, text);
    p.insert(0, [t]);
    fragment.insert(0, [p]);
  });
  return doc;
}

describe('find_and_replace refuses block-level markdown in the replacement', () => {
  it('refuses a heading and names the offending line', () => {
    const doc = seedParagraph('Sources to check.');
    const res = findAndReplace(doc, {
      find: 'Sources to check.',
      replace: 'Sources to check.\n\n### Sources\n\nThe published sequence, checked.',
      parseInlineMarks: true,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('block-markdown-in-replacement');
    expect(res.blockLine).toBe('### Sources');
    // Refused means untouched: no half-applied edit left behind.
    expect(plain(doc)).toBe('Sources to check.');
  });

  it('refuses a numbered list', () => {
    const doc = seedParagraph('Next steps follow.');
    const res = findAndReplace(doc, {
      find: 'Next steps follow.',
      replace: 'Next steps:\n\n1. Read the toolbox.\n2. Print the passages.',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('block-markdown-in-replacement');
    expect(res.blockLine).toBe('1. Read the toolbox.');
  });

  it('still accepts inline marks and a plain paragraph break', () => {
    const doc = seedParagraph('old text');
    const res = findAndReplace(doc, {
      find: 'old text',
      replace: '**bold** new\n\nsecond paragraph',
      parseInlineMarks: true,
    });
    expect(res.ok).toBe(true);
    expect(plain(doc)).toContain('bold new');
  });

  it('still accepts a one-line replacement that opens with a hyphen', () => {
    const doc = seedParagraph('the range');
    const res = findAndReplace(doc, { find: 'the range', replace: '- 5 to 12 degrees' });
    expect(res.ok).toBe(true);
  });

  it('still accepts a multi-line replacement whose line opens with a year', () => {
    const doc = seedParagraph('the date');
    const res = findAndReplace(doc, {
      find: 'the date',
      replace: '2026. A year that opens a sentence\nand a second line under it',
    });
    expect(res.ok).toBe(true);
    expect(plain(doc)).toContain('2026. A year that opens a sentence');
  });

  it('still accepts an inline code span sitting at the head of a line', () => {
    const doc = seedParagraph('the call');
    const res = findAndReplace(doc, {
      find: 'the call',
      replace: '```kwargs``` is how the signature reads\nand nothing is fenced here',
    });
    expect(res.ok).toBe(true);
    expect(plain(doc)).toContain('is how the signature reads');
  });

  it('still refuses a real fenced block', () => {
    const doc = seedParagraph('the example');
    const res = findAndReplace(doc, {
      find: 'the example',
      replace: '```ts\nconst x = 1;\n```',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('block-markdown-in-replacement');
    expect(res.blockLine).toBe('```ts');
  });
});
