import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { findAndReplace, getProseFragment, walkProse } from '../src/prose.ts';

/**
 * Build a minimal prosemirror-shaped Y.XmlFragment — paragraph + heading
 * + paragraph — without pulling in tiptap. Matches what y-prosemirror
 * produces at rest for a starter-kit doc.
 */
function seedDoc(
  doc: Y.Doc,
  blocks: Array<{ tag: string; text: string; attrs?: Record<string, string> }>,
) {
  const frag = getProseFragment(doc);
  doc.transact(() => {
    for (const b of blocks) {
      const el = new Y.XmlElement(b.tag);
      if (b.attrs) for (const [k, v] of Object.entries(b.attrs)) el.setAttribute(k, v);
      const text = new Y.XmlText();
      text.insert(0, b.text);
      el.insert(0, [text]);
      frag.push([el]);
    }
  });
}

describe('walkProse', () => {
  it('flattens blocks with double-newline separators', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'heading', text: 'Title', attrs: { level: '1' } },
      { tag: 'paragraph', text: 'Hello world.' },
      { tag: 'paragraph', text: 'Second paragraph.' },
    ]);
    const { plainText, segments } = walkProse(getProseFragment(doc));
    expect(plainText).toBe('Title\n\nHello world.\n\nSecond paragraph.');
    expect(segments).toHaveLength(3);
    expect(segments[0]?.blockType).toBe('heading');
    expect(segments[0]?.headingLevel).toBe(1);
    expect(segments[1]?.docOffset).toBe(7); // "Title" (5) + "\n\n" (2)
  });

  it('handles empty fragments', () => {
    const doc = new Y.Doc();
    const { plainText, segments } = walkProse(getProseFragment(doc));
    expect(plainText).toBe('');
    expect(segments).toHaveLength(0);
  });
});

describe('findAndReplace', () => {
  it('replaces a unique substring in place', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'The quick brown fox.' }]);
    const res = findAndReplace(doc, { find: 'quick brown', replace: 'lazy blue' });
    expect(res.ok).toBe(true);
    expect(walkProse(getProseFragment(doc)).plainText).toBe('The lazy blue fox.');
  });

  it('returns no-match when the find string is absent', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'Hello' }]);
    const res = findAndReplace(doc, { find: 'bye', replace: 'hi' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no-match');
  });

  it('surfaces ambiguous matches with candidates', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'paragraph', text: 'The cat sat.' },
      { tag: 'paragraph', text: 'The cat jumped.' },
    ]);
    const res = findAndReplace(doc, { find: 'cat', replace: 'dog' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ambiguous');
    expect(res.candidates).toHaveLength(2);
  });

  it('disambiguates via contextBefore/contextAfter', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'paragraph', text: 'The cat sat.' },
      { tag: 'paragraph', text: 'The cat jumped.' },
    ]);
    const res = findAndReplace(doc, {
      find: 'cat',
      replace: 'dog',
      contextAfter: ' jumped',
    });
    expect(res.ok).toBe(true);
    const text = walkProse(getProseFragment(doc)).plainText;
    expect(text).toContain('The cat sat.');
    expect(text).toContain('The dog jumped.');
  });

  it('picks by occurrence index when specified', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'a a a' }]);
    const res = findAndReplace(doc, { find: 'a', replace: 'X', occurrence: 2 });
    expect(res.ok).toBe(true);
    expect(walkProse(getProseFragment(doc)).plainText).toBe('a X a');
  });

  it('preserves surrounding text when replacing with empty string (delete)', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'keep [DELETE ME] keep' }]);
    const res = findAndReplace(doc, { find: ' [DELETE ME]', replace: '' });
    expect(res.ok).toBe(true);
    expect(walkProse(getProseFragment(doc)).plainText).toBe('keep keep');
  });

  it("tags the transaction with origin='agent' by default", () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'hello' }]);
    const origins: unknown[] = [];
    doc.on('afterTransaction', (tr) => origins.push(tr.origin));
    findAndReplace(doc, { find: 'hello', replace: 'world' });
    expect(origins).toContain('agent');
  });
});
