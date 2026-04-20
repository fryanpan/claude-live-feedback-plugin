import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  autoReanchorDoc,
  createAgentAnchor,
  findAndReplace,
  getProseFragment,
  insertAfterRange,
  insertBlocksAfterAnchor,
  parseMarkdownBlocks,
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

describe('rewriteRange — cross-node within same block', () => {
  it('splices across two XmlText siblings inside one block', () => {
    const doc = new Y.Doc();
    // Simulate a mark boundary: paragraph with two XmlText children
    // "hello " + "world" — as if "world" was bolded.
    const frag = getProseFragment(doc);
    const p = new Y.XmlElement('paragraph');
    const t1 = new Y.XmlText();
    t1.insert(0, 'hello ');
    const t2 = new Y.XmlText();
    t2.insert(0, 'world');
    doc.transact(() => {
      p.insert(0, [t1, t2]);
      frag.push([p]);
    });
    // Anchor from offset 2 in t1 ("llo ") through offset 3 in t2 ("wor")
    const startRel = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(t1, 2));
    const endRel = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(t2, 3));
    const res = rewriteRange(doc, { startRel, endRel, replacement: 'OWDY-P' });
    expect(res.ok).toBe(true);
    expect(walkProse(frag).plainText).toBe('heOWDY-Pld');
  });
});

describe('parseMarkdownBlocks', () => {
  // Y.XmlElement.getAttribute returns undefined until the element is
  // integrated into a Y.Doc — push into a fragment first.
  const integrate = (blocks: Y.XmlElement[]): Y.XmlElement[] => {
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    doc.transact(() => frag.push(blocks));
    return frag.toArray() as Y.XmlElement[];
  };

  it('parses headings, paragraphs, and bullet lists', () => {
    const blocks = integrate(parseMarkdownBlocks('## Hello\n\nA paragraph.\n\n- one\n- two'));
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.nodeName).toBe('heading');
    expect(blocks[0]?.getAttribute('level')).toBe('2');
    expect(blocks[1]?.nodeName).toBe('paragraph');
    expect(blocks[2]?.nodeName).toBe('bulletList');
    expect(blocks[2]?.toArray()).toHaveLength(2);
  });

  it('parses numbered lists and blockquotes', () => {
    const blocks = integrate(parseMarkdownBlocks('1. first\n2. second\n\n> quoted'));
    expect(blocks[0]?.nodeName).toBe('orderedList');
    expect(blocks[1]?.nodeName).toBe('blockquote');
  });

  it('parses horizontal rule', () => {
    const blocks = integrate(parseMarkdownBlocks('a\n\n---\n\nb'));
    expect(blocks[1]?.nodeName).toBe('horizontalRule');
  });
});

describe('insertBlocksAfterAnchor', () => {
  it('inserts new blocks immediately after the host block', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'heading', text: 'Gorillas', attrs: { level: '2' } },
      { tag: 'heading', text: 'Monkeys', attrs: { level: '2' } },
    ]);
    // Anchor inside the Gorillas heading
    const frag = getProseFragment(doc);
    const first = frag.toArray()[0] as Y.XmlElement;
    const heading = first.toArray()[0] as Y.XmlText;
    const anchorRel = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(heading, 0));
    const res = insertBlocksAfterAnchor(doc, {
      anchorRel,
      markdown: 'Gentle giants of central Africa.\n\n- diet: plants\n- habitat: forest',
    });
    expect(res.ok).toBe(true);
    const text = walkProse(frag).plainText;
    // New paragraph + bullet list should land between the two headings
    expect(text).toMatch(
      /Gorillas\n\nGentle giants.*\n\ndiet: plants\n\nhabitat: forest\n\nMonkeys/s,
    );
  });
});

describe('autoReanchorDoc', () => {
  it('recovers a text-range thread whose XmlText was recreated', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'The quick brown fox' }]);
    // Create a thread anchor pointing at "quick brown"
    const frag = getProseFragment(doc);
    const p = frag.toArray()[0] as Y.XmlElement;
    const text = p.toArray()[0] as Y.XmlText;
    const startRel = Y.createRelativePositionFromTypeIndex(text, 4);
    const endRel = Y.createRelativePositionFromTypeIndex(text, 15);
    const threads = doc.getMap('threads') as Y.Map<Y.Map<unknown>>;
    const threadMap = new Y.Map<unknown>();
    threadMap.set('anchor', {
      kind: 'text-range',
      startRel: Y.encodeRelativePosition(startRel),
      endRel: Y.encodeRelativePosition(endRel),
      snippet: { text: 'quick brown' },
    });
    threads.set('t1', threadMap);

    // Simulate a destructive edit that wipes the XmlText and replaces
    // it with a fresh one containing the same content — anchors in the
    // old node become orphaned.
    doc.transact(() => {
      p.delete(0, p.length);
      const fresh = new Y.XmlText();
      fresh.insert(0, 'The quick brown fox');
      p.insert(0, [fresh]);
    });

    // Pre-sweep: anchor should not resolve.
    const before = threadMap.get('anchor') as { startRel: Uint8Array };
    expect(
      Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(before.startRel), doc),
    ).toBeNull();

    const summary = autoReanchorDoc(doc);
    expect(summary.reanchored).toBe(1);

    const after = threadMap.get('anchor') as { startRel: Uint8Array };
    const resolved = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(after.startRel),
      doc,
    );
    expect(resolved).not.toBeNull();
  });

  it('leaves ambiguous threads orphaned rather than guessing wrong', () => {
    // Build the anchor against a scratch doc, then plant it in a
    // DIFFERENT doc whose plain text has multiple matches of the
    // snippet. The anchor can't resolve (wrong doc) and the snippet
    // is ambiguous, so reanchor should refuse to guess.
    const scratch = new Y.Doc();
    const scratchText = new Y.Text();
    scratch.getMap('tmp').set('x', scratchText);
    scratchText.insert(0, 'dummy');
    const startRel = Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(scratchText, 0),
    );
    const endRel = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(scratchText, 3));

    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'cat cat cat' }]);
    const threads = doc.getMap('threads') as Y.Map<Y.Map<unknown>>;
    const tm = new Y.Map<unknown>();
    tm.set('anchor', { kind: 'text-range', startRel, endRel, snippet: { text: 'cat' } });
    threads.set('t1', tm);

    const res = autoReanchorDoc(doc);
    expect(res.reanchored).toBe(0);
    expect(res.stillOrphan).toBe(1);
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
