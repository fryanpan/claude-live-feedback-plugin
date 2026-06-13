import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  autoReanchorDoc,
  createAgentAnchor,
  deleteBlockAtAnchor,
  deleteBlocksInRange,
  deleteSection,
  findAndReplace,
  getProseFragment,
  insertAfterRange,
  insertBlocksAfterAnchor,
  parseMarkdownBlocks,
  readAgentAnchor,
  resolveTextRangeFromFind,
  rewriteRange,
  serializeFragmentToMarkdown,
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

  it('strips mark XML from plainText so offsets stay aligned with segment lengths', () => {
    // Y.XmlText.toString() renders marks as "<bold>hello</bold>" (18 chars)
    // but node.length reports the unmarked char count (5). If walkProse
    // appended toString() to plainText, segment docOffsets would drift
    // behind by the width of each mark wrapper, breaking indexOf→segment
    // lookups for anything after a marked span.
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    doc.transact(() => {
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.insert(0, 'hello');
      t1.format(0, 5, { bold: {} });
      p1.insert(0, [t1]);
      const p2 = new Y.XmlElement('paragraph');
      const t2 = new Y.XmlText();
      t2.insert(0, 'world');
      p2.insert(0, [t2]);
      frag.push([p1, p2]);
    });
    const { plainText, segments } = walkProse(frag);
    expect(plainText).toBe('hello\n\nworld');
    expect(plainText.indexOf('world')).toBe(7);
    // Second segment sits at offset 7 (5 + "\n\n"), covering 5 chars.
    expect(segments[1]?.docOffset).toBe(7);
    expect(segments[1]?.length).toBe(5);
  });
});

describe('findAndReplace — with marks', () => {
  it('matches text after a marked span', () => {
    // Regression: before the fix, plainText.indexOf("world") landed at a
    // position beyond any segment's [docOffset, docOffset+length) range
    // because the preceding marked "hello" had inflated plainText but not
    // docOffset, so findSegmentForOffset returned null → silent no-match.
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    doc.transact(() => {
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.insert(0, 'hello');
      t1.format(0, 5, { bold: {} });
      p1.insert(0, [t1]);
      const p2 = new Y.XmlElement('paragraph');
      const t2 = new Y.XmlText();
      t2.insert(0, 'world');
      p2.insert(0, [t2]);
      frag.push([p1, p2]);
    });
    const res = findAndReplace(doc, { find: 'world', replace: 'WORLD' });
    expect(res.ok).toBe(true);
    expect(walkProse(frag).plainText).toBe('hello\n\nWORLD');
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

/** Read the first paragraph's Y.XmlText delta — handy for inspecting marks
 *  applied to inserted text by parseInlineMarks. */
function firstParaDelta(
  doc: Y.Doc,
): Array<{ insert: string; attributes?: Record<string, unknown> }> {
  const frag = getProseFragment(doc);
  const first = frag.toArray()[0] as Y.XmlElement;
  const text = first.toArray()[0] as Y.XmlText;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return text.toDelta() as any;
}

describe('findAndReplace — parseInlineMarks', () => {
  it('default (parseInlineMarks omitted) inserts markdown syntax as literal text', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'Sonjayas project-creator was an inspiration' }]);
    const res = findAndReplace(doc, {
      find: 'project-creator',
      replace: '[project-creator](https://github.com/Consortium-team/project-creator)',
    });
    expect(res.ok).toBe(true);
    // Plain text now contains the literal markdown characters.
    expect(walkProse(getProseFragment(doc)).plainText).toContain(
      '[project-creator](https://github.com/Consortium-team/project-creator)',
    );
    // No link mark — the inserted span has no mark attributes.
    const delta = firstParaDelta(doc);
    for (const op of delta) {
      expect(op.attributes ?? {}).not.toHaveProperty('link');
    }
  });

  it('parseInlineMarks=true applies a link mark to inserted [label](url)', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'Sonjayas project-creator was an inspiration' }]);
    const res = findAndReplace(doc, {
      find: 'project-creator',
      replace: '[project-creator](https://github.com/Consortium-team/project-creator)',
      parseInlineMarks: true,
    });
    expect(res.ok).toBe(true);
    // Visible text is just the label, not the markdown.
    expect(walkProse(getProseFragment(doc)).plainText).toBe(
      'Sonjayas project-creator was an inspiration',
    );
    // The "project-creator" run has a link mark with the right href.
    const delta = firstParaDelta(doc);
    const linked = delta.find((op) => op.insert === 'project-creator' && op.attributes?.link);
    expect(linked).toBeDefined();
    expect((linked!.attributes!.link as { href: string }).href).toBe(
      'https://github.com/Consortium-team/project-creator',
    );
  });

  it('parseInlineMarks=true applies bold + link in one replacement', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'placeholder' }]);
    const res = findAndReplace(doc, {
      find: 'placeholder',
      replace: 'see **the [docs](https://example.com)** for details',
      parseInlineMarks: true,
    });
    expect(res.ok).toBe(true);
    const delta = firstParaDelta(doc);
    expect(walkProse(getProseFragment(doc)).plainText).toBe('see the docs for details');
    // 'docs' is both bold AND a link (nested marks).
    const docsRun = delta.find((op) => op.insert === 'docs');
    expect(docsRun?.attributes?.bold).toBeTruthy();
    expect((docsRun?.attributes?.link as { href: string } | undefined)?.href).toBe(
      'https://example.com',
    );
    // 'the ' is bold but not linked.
    const theRun = delta.find((op) => op.insert === 'the ');
    expect(theRun?.attributes?.bold).toBeTruthy();
    expect(theRun?.attributes?.link).toBeUndefined();
  });

  it('parseInlineMarks=true with no inline syntax in replace behaves like plain insert', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'old word here' }]);
    const res = findAndReplace(doc, {
      find: 'old word',
      replace: 'new word',
      parseInlineMarks: true,
    });
    expect(res.ok).toBe(true);
    expect(walkProse(getProseFragment(doc)).plainText).toBe('new word here');
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

  it('parseInlineMarks=true applies a link mark on the rewritten range', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'See foo for details.' }]);
    const a = anchorIn(doc, 4, 7); // "foo"
    const res = rewriteRange(doc, {
      ...a,
      replacement: '[the docs](https://example.com)',
      parseInlineMarks: true,
    });
    expect(res.ok).toBe(true);
    expect(walkProse(getProseFragment(doc)).plainText).toBe('See the docs for details.');
    const delta = firstParaDelta(doc);
    const linked = delta.find((op) => op.insert === 'the docs');
    expect((linked?.attributes?.link as { href: string } | undefined)?.href).toBe(
      'https://example.com',
    );
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

describe('markdown images', () => {
  const integrate = (md: string): Y.XmlElement[] => {
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    doc.transact(() => frag.push(parseMarkdownBlocks(md)));
    return frag.toArray() as Y.XmlElement[];
  };
  const roundtrip = (md: string): string => {
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    doc.transact(() => frag.push(parseMarkdownBlocks(md)));
    return serializeFragmentToMarkdown(frag).trim();
  };

  it('parses a standalone image into an image node with src + alt', () => {
    const [img] = integrate('![a fork](https://example.com/fork.jpg)');
    expect(img?.nodeName).toBe('image');
    expect(img?.getAttribute('src')).toBe('https://example.com/fork.jpg');
    expect(img?.getAttribute('alt')).toBe('a fork');
  });

  it('round-trips an empty-alt image (regression: used to serialize to "!")', () => {
    expect(roundtrip('![](https://example.com/x.jpg)')).toBe('![](https://example.com/x.jpg)');
  });

  it('preserves underscores in a remote URL (regression: were parsed as italics)', () => {
    const md = '![](https://helixhelix.b-cdn.net/_images/DSC_1962_900x600.jpg)';
    const [img] = integrate(md);
    expect(img?.getAttribute('src')).toBe(
      'https://helixhelix.b-cdn.net/_images/DSC_1962_900x600.jpg',
    );
    expect(roundtrip(md)).toBe(md);
  });

  it('round-trips a relative local path', () => {
    const md = '![fork](./_images/fork-step.jpg)';
    const [img] = integrate(md);
    expect(img?.getAttribute('src')).toBe('./_images/fork-step.jpg');
    expect(roundtrip(md)).toBe(md);
  });

  it('round-trips an image title', () => {
    const md = '![alt](https://example.com/x.jpg "a title")';
    const [img] = integrate(md);
    expect(img?.getAttribute('title')).toBe('a title');
    expect(roundtrip(md)).toBe(md);
  });

  it('keeps an image as its own block between paragraphs', () => {
    const blocks = integrate('Before.\n\n![](https://e.com/x.jpg)\n\nAfter.');
    expect(blocks.map((b) => b.nodeName)).toEqual(['paragraph', 'image', 'paragraph']);
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

describe('resolveTextRangeFromFind', () => {
  it('returns startRel + endRel + matched snippet for a unique find', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'Foo bar baz.' }]);
    const res = resolveTextRangeFromFind(doc, { find: 'bar' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.startRel).toBeInstanceOf(Uint8Array);
      expect(res.endRel).toBeInstanceOf(Uint8Array);
      expect(res.snippetText).toBe('bar');
    }
  });

  it('disambiguates via contextAfter the same way find_and_replace does', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'paragraph', text: 'The cat sat.' },
      { tag: 'paragraph', text: 'The cat jumped.' },
    ]);
    const res = resolveTextRangeFromFind(doc, { find: 'cat', contextAfter: ' jumped' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.snippetText).toBe('cat');
  });

  it('returns ambiguous with candidates when not disambiguated', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'cat cat cat' }]);
    const res = resolveTextRangeFromFind(doc, { find: 'cat' });
    expect(res.ok).toBe(false);
    if (!res.ok && res.error === 'ambiguous') {
      expect(res.candidates).toHaveLength(3);
    }
  });

  it('returns no-match when find is absent', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'Hello' }]);
    const res = resolveTextRangeFromFind(doc, { find: 'bye' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('no-match');
  });

  it('picks by occurrence index when specified', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'a a a' }]);
    const res = resolveTextRangeFromFind(doc, { find: 'a', occurrence: 2 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.snippetText).toBe('a');
  });
});

// ===========================================================================
// Block-deletion API — deleteBlockAtAnchor / deleteBlocksInRange / deleteSection
// ===========================================================================

/** Build an anchor at offset 0 of the FIRST text node inside top-level
 *  block at `topIdx`. Used by deleteBlockAtAnchor tests. */
function anchorInTopBlock(doc: Y.Doc, topIdx: number, offset = 0) {
  const frag = getProseFragment(doc);
  const top = frag.toArray()[topIdx] as Y.XmlElement;
  // Walk down through any nested blocks to the first XmlText.
  let cursor: Y.XmlElement | Y.XmlText = top;
  while (cursor instanceof Y.XmlElement) {
    const first = cursor.toArray()[0];
    if (!first) throw new Error('no leaf');
    cursor = first as Y.XmlElement | Y.XmlText;
  }
  const text = cursor as Y.XmlText;
  return Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, offset));
}

describe('deleteBlockAtAnchor', () => {
  it('deletes the host paragraph at the doc root', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'paragraph', text: 'first' },
      { tag: 'paragraph', text: 'middle (delete me)' },
      { tag: 'paragraph', text: 'last' },
    ]);
    const anchorRel = anchorInTopBlock(doc, 1);
    const res = deleteBlockAtAnchor(doc, { anchorRel });
    expect(res.ok).toBe(true);
    expect(res.deleted?.tag).toBe('paragraph');
    expect(res.deleted?.snippet).toContain('middle');
    expect(walkProse(getProseFragment(doc)).plainText).toBe('first\n\nlast');
  });

  it('deletes the innermost host block when the anchor is nested', () => {
    // bulletList > listItem > paragraph > XmlText. walkProse reports
    // the innermost block (the paragraph) as the host — that's what we
    // delete. The empty listItem is left behind; that's a known
    // limitation of the "innermost host" rule and matches the proposal's
    // wording. Use deleteSection / deleteBlocksInRange for whole-list deletion.
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    const list = new Y.XmlElement('bulletList');
    const itemTexts: Y.XmlText[] = [];
    doc.transact(() => {
      for (const t of ['one', 'two', 'three']) {
        const li = new Y.XmlElement('listItem');
        const p = new Y.XmlElement('paragraph');
        const xt = new Y.XmlText();
        xt.insert(0, t);
        p.insert(0, [xt]);
        li.insert(0, [p]);
        list.insert(list.length, [li]);
        itemTexts.push(xt);
      }
      frag.push([list]);
    });
    const anchorRel = Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(itemTexts[1]!, 0),
    );
    const res = deleteBlockAtAnchor(doc, { anchorRel });
    expect(res.ok).toBe(true);
    expect(res.deleted?.tag).toBe('paragraph');
    expect(res.deleted?.snippet).toContain('two');
    // The listItem-2 still exists but its paragraph is gone — flat text
    // shows just "one" and "three" because the empty listItem contributes
    // no text.
    expect(walkProse(frag).plainText).toBe('one\n\nthree');
    // bulletList still has all three listItems (one is now empty).
    expect(list.length).toBe(3);
  });

  it('returns anchor-orphaned when the anchor no longer resolves', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'gone soon' }]);
    const anchorRel = anchorInTopBlock(doc, 0);
    // Wipe the entire fragment — anchor's referenced XmlText is destroyed.
    doc.transact(() => {
      const frag = getProseFragment(doc);
      frag.delete(0, frag.length);
    });
    const res = deleteBlockAtAnchor(doc, { anchorRel });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('anchor-orphaned');
  });

  it("tags the transaction with origin='agent' by default", () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'go' }]);
    const anchorRel = anchorInTopBlock(doc, 0);
    const origins: unknown[] = [];
    doc.on('afterTransaction', (tr) => origins.push(tr.origin));
    deleteBlockAtAnchor(doc, { anchorRel });
    expect(origins).toContain('agent');
  });
});

describe('deleteBlocksInRange', () => {
  it('deletes all top-level blocks from start match through end match', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'paragraph', text: 'keep before' },
      { tag: 'heading', text: 'TEMPLATE START', attrs: { level: '2' } },
      { tag: 'paragraph', text: 'cruft 1' },
      { tag: 'paragraph', text: 'cruft 2' },
      { tag: 'paragraph', text: 'TEMPLATE END' },
      { tag: 'paragraph', text: 'keep after' },
    ]);
    const res = deleteBlocksInRange(doc, {
      startFind: 'TEMPLATE START',
      endFind: 'TEMPLATE END',
    });
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(4);
    expect(walkProse(getProseFragment(doc)).plainText).toBe('keep before\n\nkeep after');
  });

  it('is block-inclusive — partial match removes the WHOLE containing block', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'paragraph', text: 'before' },
      { tag: 'paragraph', text: 'first paragraph of section' },
      { tag: 'paragraph', text: 'last paragraph of section' },
      { tag: 'paragraph', text: 'after' },
    ]);
    // "first" only matches a fragment of the second block but the whole
    // block is deleted regardless — this is the proposal's chosen
    // behavior ("blow away the section that contains this string").
    const res = deleteBlocksInRange(doc, {
      startFind: 'first',
      endFind: 'last',
    });
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(2);
    expect(walkProse(getProseFragment(doc)).plainText).toBe('before\n\nafter');
  });

  it('returns inverted-range when end appears before start', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'paragraph', text: 'alpha' },
      { tag: 'paragraph', text: 'beta' },
    ]);
    const res = deleteBlocksInRange(doc, {
      startFind: 'beta',
      endFind: 'alpha',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('inverted-range');
    // Doc is untouched.
    expect(walkProse(getProseFragment(doc)).plainText).toBe('alpha\n\nbeta');
  });

  it('returns no-match when startFind is not present', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'paragraph', text: 'hello' }]);
    const res = deleteBlocksInRange(doc, { startFind: 'nope', endFind: 'hello' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no-match');
  });

  it('returns ambiguous with candidates tagged start/end when find is not unique', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'paragraph', text: 'cat one' },
      { tag: 'paragraph', text: 'cat two' },
      { tag: 'paragraph', text: 'end' },
    ]);
    const res = deleteBlocksInRange(doc, { startFind: 'cat', endFind: 'end' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ambiguous');
    expect(res.candidates).toBeTruthy();
    expect(res.candidates?.every((c) => c.which === 'start')).toBe(true);
    expect(res.candidates).toHaveLength(2);
  });

  it('disambiguates via startOccurrence/endOccurrence', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'paragraph', text: 'marker' },
      { tag: 'paragraph', text: 'middle' },
      { tag: 'paragraph', text: 'marker' },
      { tag: 'paragraph', text: 'tail' },
    ]);
    const res = deleteBlocksInRange(doc, {
      startFind: 'marker',
      endFind: 'marker',
      startOccurrence: 1,
      endOccurrence: 2,
    });
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(3);
    expect(walkProse(getProseFragment(doc)).plainText).toBe('tail');
  });

  it('match inside a nested listItem deletes the whole top-level list', () => {
    // Block-inclusive at the top level — see proposal: nested matches
    // resolve to their topBlock, which IS the deleted unit.
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    doc.transact(() => {
      const before = new Y.XmlElement('paragraph');
      const bt = new Y.XmlText();
      bt.insert(0, 'before');
      before.insert(0, [bt]);
      const list = new Y.XmlElement('bulletList');
      for (const t of ['one', 'two']) {
        const li = new Y.XmlElement('listItem');
        const p = new Y.XmlElement('paragraph');
        const x = new Y.XmlText();
        x.insert(0, t);
        p.insert(0, [x]);
        li.insert(0, [p]);
        list.insert(list.length, [li]);
      }
      const after = new Y.XmlElement('paragraph');
      const at = new Y.XmlText();
      at.insert(0, 'after');
      after.insert(0, [at]);
      frag.push([before, list, after]);
    });
    const res = deleteBlocksInRange(doc, { startFind: 'one', endFind: 'two' });
    expect(res.ok).toBe(true);
    // Only the bulletList (one top-level block) is deleted.
    expect(res.deleted).toBe(1);
    expect(walkProse(frag).plainText).toBe('before\n\nafter');
  });

  it('runs every removal as a single Yjs transaction', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'paragraph', text: 'a' },
      { tag: 'paragraph', text: 'b' },
      { tag: 'paragraph', text: 'c' },
    ]);
    let txCount = 0;
    doc.on('afterTransaction', (tr) => {
      if (tr.origin === 'agent') txCount++;
    });
    const res = deleteBlocksInRange(doc, { startFind: 'a', endFind: 'c' });
    expect(res.ok).toBe(true);
    expect(txCount).toBe(1);
  });
});

describe('deleteSection', () => {
  it('deletes a heading and its body up to the next heading at the same level', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'heading', text: 'Intro', attrs: { level: '1' } },
      { tag: 'paragraph', text: 'Welcome.' },
      { tag: 'heading', text: 'Routes', attrs: { level: '2' } },
      { tag: 'paragraph', text: 'p1' },
      { tag: 'paragraph', text: 'p2' },
      { tag: 'heading', text: 'Goodbye', attrs: { level: '2' } },
      { tag: 'paragraph', text: 'bye.' },
    ]);
    const res = deleteSection(doc, { heading: 'Routes' });
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(3); // Routes h2 + p1 + p2
    expect(res.nextHeading).toEqual({ level: 2, text: 'Goodbye' });
    expect(walkProse(getProseFragment(doc)).plainText).toBe('Intro\n\nWelcome.\n\nGoodbye\n\nbye.');
  });

  it('runs to end of doc when no later heading at ≤ level exists', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'heading', text: 'Top', attrs: { level: '1' } },
      { tag: 'paragraph', text: 'a' },
      { tag: 'heading', text: 'Sub', attrs: { level: '3' } },
      { tag: 'paragraph', text: 'b' },
    ]);
    const res = deleteSection(doc, { heading: 'Top', level: 1 });
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(4);
    expect(res.nextHeading).toBe(null);
    expect(walkProse(getProseFragment(doc)).plainText).toBe('');
  });

  it('stops at a HIGHER-level heading too (h3 section ends at h2)', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'heading', text: 'A', attrs: { level: '3' } },
      { tag: 'paragraph', text: 'inside-a' },
      { tag: 'heading', text: 'B', attrs: { level: '2' } },
      { tag: 'paragraph', text: 'after-a' },
    ]);
    const res = deleteSection(doc, { heading: 'A', level: 3 });
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(2);
    expect(res.nextHeading).toEqual({ level: 2, text: 'B' });
  });

  it('returns no-match when the heading text is absent', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [{ tag: 'heading', text: 'Other', attrs: { level: '1' } }]);
    const res = deleteSection(doc, { heading: 'Missing' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no-match');
  });

  it('returns not-a-heading when the string matches a non-heading block', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'heading', text: 'Real Heading', attrs: { level: '1' } },
      { tag: 'paragraph', text: 'Fake Heading lives here in body text.' },
    ]);
    const res = deleteSection(doc, { heading: 'Fake Heading' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not-a-heading');
  });

  it('returns ambiguous when the same heading text appears more than once', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'heading', text: 'Notes', attrs: { level: '2' } },
      { tag: 'paragraph', text: 'a' },
      { tag: 'heading', text: 'Notes', attrs: { level: '2' } },
      { tag: 'paragraph', text: 'b' },
    ]);
    const res = deleteSection(doc, { heading: 'Notes' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ambiguous');
    expect(res.candidates).toHaveLength(2);
  });

  it('disambiguates by occurrence and level', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'heading', text: 'Notes', attrs: { level: '2' } },
      { tag: 'paragraph', text: 'first-section' },
      { tag: 'heading', text: 'Notes', attrs: { level: '2' } },
      { tag: 'paragraph', text: 'second-section' },
    ]);
    const res = deleteSection(doc, { heading: 'Notes', occurrence: 2 });
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(2);
    expect(walkProse(getProseFragment(doc)).plainText).toBe('Notes\n\nfirst-section');
  });

  it('runs every removal as a single Yjs transaction', () => {
    const doc = new Y.Doc();
    seedDoc(doc, [
      { tag: 'heading', text: 'X', attrs: { level: '2' } },
      { tag: 'paragraph', text: 'a' },
      { tag: 'paragraph', text: 'b' },
      { tag: 'paragraph', text: 'c' },
    ]);
    let txCount = 0;
    doc.on('afterTransaction', (tr) => {
      if (tr.origin === 'agent') txCount++;
    });
    const res = deleteSection(doc, { heading: 'X' });
    expect(res.ok).toBe(true);
    expect(txCount).toBe(1);
  });
});

describe('heading-level round-trip', () => {
  function roundTrip(md: string): string {
    const doc = new Y.Doc();
    const fragment = getProseFragment(doc);
    const blocks = parseMarkdownBlocks(md);
    doc.transact(() => fragment.push(blocks));
    return serializeFragmentToMarkdown(fragment);
  }

  // Regression coverage for a "live editor renders H3 but disk shows ##"
  // report from 2026-05-12. Verified server-side: parser captures the
  // `#` count, sets `level` attribute as a string, serializer reads it
  // back and emits `'#'.repeat(level)`. No level downgrade.
  it('preserves every level from H1 through H6 unchanged', () => {
    const input = [
      '# H1 title',
      '',
      '## H2 section',
      '',
      '### H3 subsection',
      '',
      '#### H4 sub-subsection',
      '',
      '##### H5',
      '',
      '###### H6',
      '',
    ].join('\n');
    const out = roundTrip(input);
    expect(out).toContain('# H1 title');
    expect(out).toContain('## H2 section');
    expect(out).toContain('### H3 subsection');
    expect(out).toContain('#### H4 sub-subsection');
    expect(out).toContain('##### H5');
    expect(out).toContain('###### H6');
    // And ensure no level got promoted/demoted (`#### ` doesn't appear
    // as `### ` etc.).
    expect(out.split('\n').filter((l) => l.startsWith('# '))).toHaveLength(1);
    expect(out.split('\n').filter((l) => l.startsWith('## '))).toHaveLength(1);
    expect(out.split('\n').filter((l) => l.startsWith('### '))).toHaveLength(1);
    expect(out.split('\n').filter((l) => l.startsWith('#### '))).toHaveLength(1);
    expect(out.split('\n').filter((l) => l.startsWith('##### '))).toHaveLength(1);
    expect(out.split('\n').filter((l) => l.startsWith('###### '))).toHaveLength(1);
  });

  it('preserves H3 specifically when interleaved with H2 (the reported scenario)', () => {
    const input = [
      '## Section',
      '',
      '### Subsection A',
      '',
      'Body A.',
      '',
      '### Subsection B',
      '',
      'Body B.',
      '',
      '## Next section',
      '',
    ].join('\n');
    const out = roundTrip(input);
    // The three H3s must survive — not downgrade to ##.
    expect(out.split('\n').filter((l) => l.startsWith('### '))).toHaveLength(2);
    expect(out).toContain('### Subsection A');
    expect(out).toContain('### Subsection B');
  });
});

describe('YAML frontmatter round-trip', () => {
  function roundTrip(md: string): string {
    const doc = new Y.Doc();
    const fragment = getProseFragment(doc);
    const blocks = parseMarkdownBlocks(md);
    doc.transact(() => fragment.push(blocks));
    return serializeFragmentToMarkdown(fragment);
  }

  it('preserves clean frontmatter without inserting blank lines', () => {
    const input = '---\ntitle: Welcome\nlang: en\n---\n\n# About\n\nBody text.\n';
    const out = roundTrip(input);
    expect(out).toBe('---\ntitle: Welcome\nlang: en\n---\n\n# About\n\nBody text.\n');
  });

  it('self-heals frontmatter that already has blank lines between values', () => {
    const input = '---\n\nlang: en\n\n---\n\n# About\n';
    const out = roundTrip(input);
    expect(out).toBe('---\nlang: en\n---\n\n# About\n');
  });

  it('leaves a horizontal rule in body content alone', () => {
    const input = '# Heading\n\nBody A\n\n---\n\nBody B\n';
    const out = roundTrip(input);
    expect(out).toBe('# Heading\n\nBody A\n\n---\n\nBody B\n');
  });

  it('treats a leading hr without a closing hr as a normal horizontal rule', () => {
    const input = '---\n\n# Just a heading\n';
    const out = roundTrip(input);
    expect(out).toBe('---\n\n# Just a heading\n');
  });
});

describe('YAML frontmatter — legacy in-Yjs shape', () => {
  it('serializes legacy [hr, paragraphs, hr] without inserting blank lines (back-compat)', () => {
    // Docs seeded by the OLD parser have frontmatter as [horizontalRule,
    // paragraph(\"key: value\"), horizontalRule] in Yjs. The serializer
    // recognizes that shape at the start of the fragment and emits
    // `---\nkeys\n---` so they keep round-tripping cleanly without a
    // re-seed.
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    doc.transact(() => {
      frag.push([new Y.XmlElement('horizontalRule')]);
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.insert(0, 'title: Welcome');
      p1.insert(0, [t1]);
      frag.push([p1]);
      const p2 = new Y.XmlElement('paragraph');
      const t2 = new Y.XmlText();
      t2.insert(0, 'lang: en');
      p2.insert(0, [t2]);
      frag.push([p2]);
      frag.push([new Y.XmlElement('horizontalRule')]);
      const h = new Y.XmlElement('heading');
      h.setAttribute('level', '1');
      const ht = new Y.XmlText();
      ht.insert(0, 'About');
      h.insert(0, [ht]);
      frag.push([h]);
    });
    const out = serializeFragmentToMarkdown(frag);
    expect(out).toBe('---\ntitle: Welcome\nlang: en\n---\n\n# About\n');
  });
});

describe('GFM table round-trip', () => {
  // Regression guard: a peer reported a table "wedging" disk→doc sync and
  // hypothesized tables weren't handled. They are — the wedge was a stale
  // fs.watch watcher. These pin the parse + serialize round-trip so the
  // table path doesn't silently regress.
  function roundtrip(md: string): string {
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    doc.transact(() => frag.push(parseMarkdownBlocks(md)));
    return serializeFragmentToMarkdown(frag);
  }

  it('parses a pipe table into a table block', () => {
    const md = [
      '| Decision | Signal | Owner |',
      '| --- | --- | --- |',
      '| Hire | velocity | EM |',
    ].join('\n');
    const blocks = parseMarkdownBlocks(md);
    expect(blocks.some((b) => b.nodeName === 'table')).toBe(true);
  });

  it('round-trips a table without dropping cells', () => {
    const md = [
      '| Decision | Signal | Cadence |',
      '| --- | --- | --- |',
      '| Hire | velocity | monthly |',
      '| Cut scope | cycle time | weekly |',
    ].join('\n');
    const out = roundtrip(md);
    for (const cell of [
      'Decision',
      'Signal',
      'Cadence',
      'Hire',
      'velocity',
      'Cut scope',
      'weekly',
    ]) {
      expect(out).toContain(cell);
    }
  });

  it('keeps a paragraph that follows a table', () => {
    const md = ['| A | B |', '| --- | --- |', '| 1 | 2 |', '', 'Paragraph after table.'].join('\n');
    const out = roundtrip(md);
    expect(out).toContain('Paragraph after table.');
  });
});

describe('nested list round-trip', () => {
  // Bug reported by a peer: a human built a nested bullet structure (a
  // "Notes & Questions" section with sub-bullets and sub-paragraphs) in the
  // browser editor. On write-back the serializer flattened every nested item
  // and sub-paragraph of a list item into a single space-joined line, and the
  // flattened version propagated back into the live doc + disk, destroying the
  // nesting irrecoverably. These pin nested-list fidelity through the
  // serialize → parse → serialize round-trip on BOTH ends (parser + serializer
  // were nesting-blind).

  function roundtrip(md: string): string {
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    doc.transact(() => frag.push(parseMarkdownBlocks(md)));
    return serializeFragmentToMarkdown(frag);
  }

  // Build bulletList > listItem(paragraph "Parent A" + nested bulletList) the
  // way y-prosemirror emits a nested list at rest, so we test the SERIALIZER
  // against editor-shaped state, not just parser output.
  function mkPara(text: string): Y.XmlElement {
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, text);
    p.insert(0, [t]);
    return p;
  }
  function mkItem(children: Y.XmlElement[]): Y.XmlElement {
    const li = new Y.XmlElement('listItem');
    li.insert(0, children);
    return li;
  }

  it('serializes a nested bullet list with indentation, not a flat line', () => {
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    const nested = new Y.XmlElement('bulletList');
    nested.insert(0, [mkItem([mkPara('Child A1')]), mkItem([mkPara('Child A2')])]);
    const top = new Y.XmlElement('bulletList');
    top.insert(0, [mkItem([mkPara('Parent A'), nested]), mkItem([mkPara('Parent B')])]);
    doc.transact(() => frag.push([top]));

    const out = serializeFragmentToMarkdown(frag);
    expect(out).toContain('- Parent A');
    expect(out).toContain('  - Child A1');
    expect(out).toContain('  - Child A2');
    expect(out).toContain('- Parent B');
    // The bug smashed children onto the parent line:
    expect(out).not.toContain('Parent A Child A1');
  });

  it('parses an indented bullet as a nested list under the parent item', () => {
    const doc = new Y.Doc();
    const frag = getProseFragment(doc);
    doc.transact(() => frag.push(parseMarkdownBlocks('- Parent\n  - Child\n')));
    const top = frag.toArray()[0] as Y.XmlElement;
    expect(top.nodeName).toBe('bulletList');
    expect(top.toArray()).toHaveLength(1);
    const li = top.toArray()[0] as Y.XmlElement;
    const childTags = li.toArray().map((c) => (c as Y.XmlElement).nodeName);
    expect(childTags).toContain('paragraph');
    expect(childTags).toContain('bulletList');
  });

  it('round-trips two levels of bullets without flattening', () => {
    const md = `${['- A', '  - A1', '  - A2', '- B'].join('\n')}\n`;
    expect(roundtrip(md)).toBe(md);
  });

  it('round-trips three levels of bullets', () => {
    const md = `${['- A', '  - A1', '    - A1a', '  - A2'].join('\n')}\n`;
    expect(roundtrip(md)).toBe(md);
  });

  it('round-trips an ordered list nested under a bullet', () => {
    const md = `${['- Steps', '  1. first', '  2. second'].join('\n')}\n`;
    expect(roundtrip(md)).toBe(md);
  });

  it('preserves a second paragraph inside a list item', () => {
    const md = `${['- Item one', '', '  More detail for item one', '- Item two'].join('\n')}\n`;
    const out = roundtrip(md);
    expect(out).toContain('More detail for item one');
    // Not flattened onto the marker line:
    expect(out).not.toContain('Item one More detail');
    expect(out).toContain('- Item two');
  });

  it('still round-trips a flat list (regression)', () => {
    const md = `${['- one', '- two', '- three'].join('\n')}\n`;
    expect(roundtrip(md)).toBe(md);
  });

  it('keeps a heading after a nested list (region boundary)', () => {
    const md = `${['- A', '  - A1', '', '## After'].join('\n')}\n`;
    const out = roundtrip(md);
    expect(out).toContain('  - A1');
    expect(out).toContain('## After');
  });
});
