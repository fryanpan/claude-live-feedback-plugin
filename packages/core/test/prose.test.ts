import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  createAgentAnchor,
  findAndReplace,
  getProseFragment,
  insertAfterRange,
  readAgentAnchor,
  rewriteRange,
  walkProse,
} from '../src/prose.ts';

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

/** Build a text-range anchor on the FIRST text node covering [from, to). */
function anchorIn(doc: Y.Doc, from: number, to: number) {
  const frag = getProseFragment(doc);
  const first = frag.toArray()[0] as Y.XmlElement;
  const text = first.toArray()[0] as Y.XmlText;
  const startRel = Y.createRelativePositionFromTypeIndex(text, from);
  const endRel = Y.createRelativePositionFromTypeIndex(text, to);
  return {
    startRel: Y.encodeRelativePosition(startRel),
    endRel: Y.encodeRelativePosition(endRel),
  };
}

describe('rewriteRange', () => {
  it('replaces the anchored range with a new string', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'The quick brown fox jumped.' }]);
    const a = anchorIn(doc, 4, 15); // "quick brown"
    const res = rewriteRange(doc, { ...a, replacement: 'lazy blue' });
    expect(res.ok).toBe(true);
    expect(walkProse(getProseFragment(doc)).plainText).toBe('The lazy blue fox jumped.');
  });

  it('survives an intervening user edit before the anchor', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'The quick brown fox.' }]);
    const a = anchorIn(doc, 4, 15); // "quick brown"
    // User prepends text BEFORE the anchor — absolute offset of "quick"
    // changes from 4 to 13, but the relative position rebases.
    doc.transact(() => {
      const frag = getProseFragment(doc);
      const first = frag.toArray()[0] as Y.XmlElement;
      const text = first.toArray()[0] as Y.XmlText;
      text.insert(0, 'ANYWAY, ');
    });
    const res = rewriteRange(doc, { ...a, replacement: 'lazy blue' });
    expect(res.ok).toBe(true);
    expect(walkProse(getProseFragment(doc)).plainText).toBe('ANYWAY, The lazy blue fox.');
  });
});

describe('insertAfterRange', () => {
  it('inserts text at the anchor end', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'Hello world.' }]);
    const a = anchorIn(doc, 0, 5); // "Hello"
    const res = insertAfterRange(doc, { endRel: a.endRel, text: ' there,' });
    expect(res.ok).toBe(true);
    expect(walkProse(getProseFragment(doc)).plainText).toBe('Hello there, world.');
  });
});

describe('createAgentAnchor', () => {
  it('mints an anchor for a unique match and persists it for retrieval', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'Foo bar baz.' }]);
    const res = createAgentAnchor(doc, { find: 'bar' });
    expect(res.ok).toBe(true);
    expect(res.anchorId).toBeTruthy();
    const read = readAgentAnchor(doc, res.anchorId!);
    expect(read).not.toBeNull();
    expect(read?.startRel).toBeInstanceOf(Uint8Array);
  });

  it('rebases across later user insertion, surviving shifted offsets', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'Foo bar baz.' }]);
    const { anchorId } = createAgentAnchor(doc, { find: 'bar' });
    expect(anchorId).toBeTruthy();
    // Simulate a user inserting text BEFORE the anchor.
    doc.transact(() => {
      const first = getProseFragment(doc).toArray()[0] as Y.XmlElement;
      const text = first.toArray()[0] as Y.XmlText;
      text.insert(0, 'PRE-');
    });
    // Now rewrite via the anchor — should still hit the correct "bar".
    const anchor = readAgentAnchor(doc, anchorId!)!;
    rewriteRange(doc, { ...anchor, replacement: 'BAR' });
    expect(walkProse(getProseFragment(doc)).plainText).toBe('PRE-Foo BAR baz.');
  });

  it('returns ambiguous with candidates when multiple matches exist', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'cat cat cat' }]);
    const res = createAgentAnchor(doc, { find: 'cat' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ambiguous');
    expect(res.candidates).toHaveLength(3);
  });
});
