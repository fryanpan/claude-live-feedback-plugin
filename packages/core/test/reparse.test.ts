import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  applyMarkdownToFragment,
  getProseFragment,
  headingLevelOf,
  normalizeHeadingLevels,
  parseMarkdownBlocks,
  serializeFragmentToMarkdown,
} from '../src/prose.ts';

function docWith(md: string): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  const fragment = getProseFragment(doc);
  fragment.push(parseMarkdownBlocks(md));
  return { doc, fragment };
}

/**
 * Tiptap's Heading extension renders with
 *   `this.options.levels.includes(node.attrs.level) ? node.attrs.level : levels[0]`
 * and `levels` is [1..6] as NUMBERS. A heading whose Yjs `level` attribute is
 * the string '2' fails that `includes` check, so y-prosemirror hands Tiptap
 * `{level: '2'}` and every heading renders as <h1> — H1/H2/H3 all the same
 * size. Storing the number is what makes the editor render the right tag.
 */
describe('heading level attribute type', () => {
  it('parses heading levels as numbers, not strings', () => {
    // Read them once integrated — a prelim block exposes no attributes.
    const { fragment } = docWith('# One\n\n## Two\n\n### Three\n');
    const headings = fragment.toArray() as Y.XmlElement[];
    expect(headings.map(headingLevelOf)).toEqual([1, 2, 3]);
    for (const h of headings) expect(typeof h.getAttribute('level')).toBe('number');
  });

  it('still round-trips to markdown', () => {
    const { fragment } = docWith('# One\n\n## Two\n\nBody.\n');
    expect(serializeFragmentToMarkdown(fragment)).toBe('# One\n\n## Two\n\nBody.\n');
  });
});

describe('normalizeHeadingLevels', () => {
  it('converts legacy string levels to numbers and reports the count', () => {
    const doc = new Y.Doc();
    const fragment = getProseFragment(doc);
    const h = new Y.XmlElement('heading');
    // What every doc persisted before the fix looks like.
    h.setAttribute('level', '3');
    const t = new Y.XmlText();
    t.insert(0, 'Legacy');
    h.insert(0, [t]);
    fragment.push([h]);

    expect(normalizeHeadingLevels(doc)).toBe(1);
    expect(h.getAttribute('level')).toBe(3 as unknown as string);
    // Idempotent — a second pass has nothing to do.
    expect(normalizeHeadingLevels(doc)).toBe(0);
  });

  it('clamps out-of-range and unparseable levels', () => {
    const doc = new Y.Doc();
    const fragment = getProseFragment(doc);
    const a = new Y.XmlElement('heading');
    a.setAttribute('level', '9');
    const b = new Y.XmlElement('heading');
    b.setAttribute('level', 'bogus');
    fragment.push([a, b]);

    normalizeHeadingLevels(doc);
    expect(a.getAttribute('level')).toBe(6 as unknown as string);
    expect(b.getAttribute('level')).toBe(1 as unknown as string);
  });
});

/**
 * reparse_from_disk used to `fragment.delete(0, len)` + `push(freshBlocks)`.
 * That destroys the Y.XmlText identity of EVERY block, so every thread anchor
 * in the doc orphans — even threads on paragraphs the rewrite never touched.
 * applyMarkdownToFragment diffs at block granularity and only replaces the
 * blocks whose markdown actually changed.
 */
describe('applyMarkdownToFragment', () => {
  it('leaves untouched blocks in place so their anchors survive', () => {
    const { doc, fragment } = docWith('# Title\n\nKeep me.\n\nOld body.\n');
    const keeper = fragment.get(1) as Y.XmlElement;
    const keeperText = keeper.get(0) as Y.XmlText;
    const rel = Y.createRelativePositionFromTypeIndex(keeperText, 2);

    const changed = applyMarkdownToFragment(fragment, '# Title\n\nKeep me.\n\nNew body.\n');

    expect(changed).toBe(true);
    expect(fragment.get(1)).toBe(keeper);
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, doc);
    expect(abs?.index).toBe(2);
    expect(serializeFragmentToMarkdown(fragment)).toBe('# Title\n\nKeep me.\n\nNew body.\n');
  });

  it('applies insertions and deletions without touching neighbours', () => {
    const { fragment } = docWith('A\n\nB\n\nC\n');
    const a = fragment.get(0);
    const c = fragment.get(2);

    applyMarkdownToFragment(fragment, 'A\n\nB2\n\nInserted\n\nC\n');

    expect(fragment.get(0)).toBe(a);
    expect(fragment.get(3)).toBe(c);
    expect(serializeFragmentToMarkdown(fragment)).toBe('A\n\nB2\n\nInserted\n\nC\n');
  });

  it('is a no-op when the markdown is unchanged', () => {
    const { fragment } = docWith('# Title\n\nBody.\n');
    const [h, p] = [fragment.get(0), fragment.get(1)];

    expect(applyMarkdownToFragment(fragment, '# Title\n\nBody.\n')).toBe(false);

    expect(fragment.get(0)).toBe(h);
    expect(fragment.get(1)).toBe(p);
  });

  it('rewrites a heading whose only change is its level', () => {
    const { fragment } = docWith('# Section\n');
    applyMarkdownToFragment(fragment, '## Section\n');
    expect(headingLevelOf(fragment.get(0) as Y.XmlElement)).toBe(2);
    expect(serializeFragmentToMarkdown(fragment)).toBe('## Section\n');
  });

  it('does not equate two different blocks that both serialize to nothing', () => {
    // A text-empty heading serializes to null, so an index-only fallback key
    // made every such block compare equal and the diff kept the stale one.
    const { fragment } = docWith('## \n');
    applyMarkdownToFragment(fragment, '#### \n');
    expect(headingLevelOf(fragment.get(0) as Y.XmlElement)).toBe(4);
  });

  it('refuses to wipe the fragment on empty markdown', () => {
    const { fragment } = docWith('# Title\n\nBody.\n');
    expect(applyMarkdownToFragment(fragment, '')).toBe(false);
    expect(fragment.length).toBe(2);
  });
});
