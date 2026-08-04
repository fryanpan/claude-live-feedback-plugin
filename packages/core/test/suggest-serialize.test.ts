import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  applyMarkdownToFragment,
  getProseFragment,
  parseMarkdownBlocks,
  serializeBlockToMarkdown,
  serializeFragmentToMarkdown,
} from '../src/prose.ts';
import {
  SUGGEST_DELETE_MARK,
  SUGGEST_INSERT_MARK,
  type SuggestionAttrs,
  readSuggestionAttrs,
} from '../src/suggest.ts';

/**
 * THE SERIALIZER RULE (redline-suggestions phase 2, the crux): disk always
 * holds the ACCEPTED state. Text carrying `suggestInsert` is omitted from
 * markdown output; text carrying `suggestDelete` is emitted without the mark.
 * Everything downstream of the serializer (write-back, git, reconcile's
 * `currentSerialized`, lastWritten bookkeeping) inherits the rule for free —
 * which is exactly why it lives here and nowhere else.
 *
 * TDD note: the omission tests (insert spans, whole-block inserts) were
 * written first and watched fail against the unmodified serializer — i.e.
 * reverting the serializer rule makes this suite fail.
 */

const sattrs = (sid: string): SuggestionAttrs => ({
  sid,
  authorId: 'agent-1',
  authorName: 'Docs Agent',
  authorColor: '#7c5cff',
  ts: 1754200000000,
});

function docFrom(md: string): Y.Doc {
  const doc = new Y.Doc();
  getProseFragment(doc).push(parseMarkdownBlocks(md));
  return doc;
}

function blockText(doc: Y.Doc, blockIndex: number): Y.XmlText {
  const el = getProseFragment(doc).get(blockIndex) as Y.XmlElement;
  const t = el.toArray()[0];
  if (!(t instanceof Y.XmlText)) throw new Error('block has no text child');
  return t;
}

const serialize = (doc: Y.Doc): string => serializeFragmentToMarkdown(getProseFragment(doc));

describe('serializer rule: suggestInsert omitted, suggestDelete emitted unmarked', () => {
  it('(b) a suggestInsert span never reaches the markdown output', () => {
    const doc = docFrom('Alpha beta gamma.\n');
    blockText(doc, 0).insert('Alpha '.length, 'proposed ', {
      [SUGGEST_INSERT_MARK]: sattrs('s1'),
    });
    expect(serialize(doc)).toBe('Alpha beta gamma.\n');
  });

  it('(c) a suggestDelete span still serializes, without any mark syntax', () => {
    const doc = docFrom('Alpha beta gamma.\n');
    blockText(doc, 0).format('Alpha '.length, 'beta '.length, {
      [SUGGEST_DELETE_MARK]: sattrs('s2'),
    });
    expect(serialize(doc)).toBe('Alpha beta gamma.\n');
  });

  it('keeps real inline marks under a suggestDelete, and omits marked suggestInsert text', () => {
    const doc = docFrom('Keep **bold** text.\n');
    const t = blockText(doc, 0);
    // 'bold' occupies plain-text offsets 5..9.
    t.format(5, 4, { [SUGGEST_DELETE_MARK]: sattrs('s3') });
    t.insert(t.length, ' shiny', { [SUGGEST_INSERT_MARK]: sattrs('s3'), bold: true });
    expect(serialize(doc)).toBe('Keep **bold** text.\n');
  });

  it('(a) round-trip: parse(serialize(doc-with-suggestions)) equals the accepted state', () => {
    const doc = docFrom('Alpha beta gamma.\n\nSecond paragraph.\n');
    const t = blockText(doc, 0);
    // One sid spanning a delete + adjacent insert = a "replace" proposal.
    t.format('Alpha '.length, 'beta'.length, { [SUGGEST_DELETE_MARK]: sattrs('s4') });
    t.insert('Alpha beta'.length, ' delta', { [SUGGEST_INSERT_MARK]: sattrs('s4') });
    const accepted = 'Alpha beta gamma.\n\nSecond paragraph.\n';
    const md = serialize(doc);
    expect(md).toBe(accepted);
    const reparsed = docFrom(md);
    expect(serialize(reparsed)).toBe(md);
  });

  it('(d) a paragraph whose entire text is suggestInsert contributes nothing', () => {
    const doc = docFrom('Alpha.\n');
    const fragment = getProseFragment(doc);
    const p = new Y.XmlElement('paragraph');
    fragment.push([p]);
    const t = new Y.XmlText();
    p.insert(0, [t]);
    t.insert(0, 'Entirely proposed.', { [SUGGEST_INSERT_MARK]: sattrs('s5') });
    expect(serialize(doc)).toBe('Alpha.\n');
  });

  it('(d) a codeBlock whose entire text is suggestInsert emits no empty fence', () => {
    const doc = docFrom('Alpha.\n');
    const fragment = getProseFragment(doc);
    const cb = new Y.XmlElement('codeBlock');
    cb.setAttribute('language', 'ts');
    fragment.push([cb]);
    const t = new Y.XmlText();
    cb.insert(0, [t]);
    t.insert(0, 'const x = 1;', { [SUGGEST_INSERT_MARK]: sattrs('s6') });
    expect(serialize(doc)).toBe('Alpha.\n');
  });

  it('(d) a fully-suggested list item emits no empty marker line', () => {
    const doc = docFrom('- real item\n');
    const fragment = getProseFragment(doc);
    const list = fragment.get(0) as Y.XmlElement;
    const li = new Y.XmlElement('listItem');
    list.push([li]);
    const p = new Y.XmlElement('paragraph');
    li.insert(0, [p]);
    const t = new Y.XmlText();
    p.insert(0, [t]);
    t.insert(0, 'proposed item', { [SUGGEST_INSERT_MARK]: sattrs('s7') });
    expect(serialize(doc)).toBe('- real item\n');
  });

  it('a genuinely empty codeBlock still round-trips (the whole-block rule needs text)', () => {
    const doc = docFrom('```\n\n```\n');
    expect(serialize(doc)).toBe('```\n\n```\n');
  });

  it('serializeBlockToMarkdown applies the same rule (every serialize path)', () => {
    const doc = docFrom('Alpha beta.\n');
    const fragment = getProseFragment(doc);
    blockText(doc, 0).insert('Alpha '.length, 'proposed ', {
      [SUGGEST_INSERT_MARK]: sattrs('s8'),
    });
    const para = fragment.get(0) as Y.XmlElement;
    expect(serializeBlockToMarkdown(para)).toBe('Alpha beta.');
    // A fully-suggested block serializes to nothing.
    const p2 = new Y.XmlElement('paragraph');
    fragment.push([p2]);
    const t2 = new Y.XmlText();
    p2.insert(0, [t2]);
    t2.insert(0, 'all new', { [SUGGEST_INSERT_MARK]: sattrs('s9') });
    expect(serializeBlockToMarkdown(p2)).toBe('');
  });
});

describe('reconcile apply treats whole-block insert suggestions as transparent', () => {
  // A fully-suggested block serializes to nothing, so it has NO key in disk
  // space. Without special handling, applyMarkdownToFragment would delete it
  // on ANY external disk change — dropping a pending proposal the external
  // edit never touched.
  function withSuggestedBetween(): { doc: Y.Doc; fragment: Y.XmlFragment } {
    const doc = docFrom('One.\n\nTwo.\n');
    const fragment = getProseFragment(doc);
    const p = new Y.XmlElement('paragraph');
    fragment.insert(1, [p]);
    const t = new Y.XmlText();
    p.insert(0, [t]);
    t.insert(0, 'Proposed.', { [SUGGEST_INSERT_MARK]: sattrs('sp') });
    return { doc, fragment };
  }

  it('an in-sync apply is a no-op that keeps the suggested block', () => {
    const { doc, fragment } = withSuggestedBetween();
    expect(serialize(doc)).toBe('One.\n\nTwo.\n');
    expect(applyMarkdownToFragment(fragment, 'One.\n\nTwo.\n')).toBe(false);
    expect(fragment.length).toBe(3);
  });

  it('an external rewrite elsewhere keeps the suggested block and its mark', () => {
    const { doc, fragment } = withSuggestedBetween();
    expect(applyMarkdownToFragment(fragment, 'One.\n\nTwo changed.\n')).toBe(true);
    expect(serialize(doc)).toBe('One.\n\nTwo changed.\n');
    expect(fragment.length).toBe(3);
    const mid = fragment.get(1) as Y.XmlElement;
    const t = mid.toArray()[0] as Y.XmlText;
    const ops = t.toDelta() as Array<{ insert?: string; attributes?: Record<string, unknown> }>;
    const marked = ops.find((op) => op.attributes?.[SUGGEST_INSERT_MARK] != null);
    expect(marked?.insert).toBe('Proposed.');
    expect(readSuggestionAttrs(marked?.attributes?.[SUGGEST_INSERT_MARK])?.sid).toBe('sp');
  });

  it('an external insertion lands in accepted order with the suggestion intact', () => {
    const { doc, fragment } = withSuggestedBetween();
    expect(applyMarkdownToFragment(fragment, 'One.\n\nInserted.\n\nTwo.\n')).toBe(true);
    expect(serialize(doc)).toBe('One.\n\nInserted.\n\nTwo.\n');
    expect(fragment.length).toBe(4);
  });
});

describe('readSuggestionAttrs', () => {
  it('reads a well-formed payload', () => {
    expect(readSuggestionAttrs(sattrs('x'))).toEqual(sattrs('x'));
  });
  it('rejects payloads without a sid', () => {
    expect(readSuggestionAttrs({ authorId: 'a' })).toBeNull();
    expect(readSuggestionAttrs('nope')).toBeNull();
    expect(readSuggestionAttrs(null)).toBeNull();
  });
  it('tolerates a stringified ts from a foreign writer', () => {
    expect(readSuggestionAttrs({ sid: 's', ts: '123' })?.ts).toBe(123);
  });
});
