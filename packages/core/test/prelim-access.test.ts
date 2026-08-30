import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { getProseFragment, parseMarkdownBlocks } from '../src/prose.ts';

/**
 * Parsing a pipe table must not read a Yjs type before it is integrated.
 *
 * `mkTable` built each row with `row.insert(row.length, …)` on a prelim
 * `Y.XmlElement`; `.length` on a type with no doc logs Yjs's "Invalid access:
 * Add Yjs type to a document before reading data." — once per cell, per row,
 * per table, and the same for every nested list item. Every bound markdown
 * doc is normalized at hydrate: replaying that parse over the live data dir's
 * 1,465 bound docs measured 57,936 of those warnings and 11.1 MB of stderr in
 * a SINGLE pass, which is how the prod error log reached 357,378,067 bytes
 * (2026-08-29) across restarts. The parse also has to keep producing exactly
 * what it produced before — verified byte-for-byte over all 1,465.
 */
describe('parseMarkdownBlocks: pipe tables', () => {
  afterEach(() => vi.restoreAllMocks());

  const md = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 |', ''].join('\n');

  const listMd = [
    '- one',
    '  - nested',
    '',
    '    continuation paragraph',
    '  ```js',
    '  code()',
    '  ```',
    '- two',
    '',
    '1. first',
    '2. second',
    '',
  ].join('\n');

  it('logs no premature-access warning while building a table or a nested list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseMarkdownBlocks(md);
    parseMarkdownBlocks(listMd);
    const premature = warn.mock.calls.filter((c) => String(c[0]).includes('Invalid access'));
    expect(premature).toEqual([]);
  });

  it('still builds a rectangular table: header row + padded body rows', () => {
    const doc = new Y.Doc();
    const fragment = getProseFragment(doc);
    doc.transact(() => fragment.push(parseMarkdownBlocks(md)));
    const table = fragment.get(0) as Y.XmlElement;
    expect(table.nodeName).toBe('table');
    const rows = table.toArray() as Y.XmlElement[];
    expect(rows.map((r) => r.nodeName)).toEqual(['tableRow', 'tableRow', 'tableRow']);
    const cellNames = rows.map((r) => (r.toArray() as Y.XmlElement[]).map((c) => c.nodeName));
    expect(cellNames).toEqual([
      ['tableHeader', 'tableHeader'],
      ['tableCell', 'tableCell'],
      ['tableCell', 'tableCell'],
    ]);
    // The short row is padded with an EMPTY cell — a paragraph with no text.
    const padded = (rows[2]?.toArray() as Y.XmlElement[])[1] as Y.XmlElement;
    const para = padded.get(0) as Y.XmlElement;
    expect(para.nodeName).toBe('paragraph');
    expect(para.length).toBe(0);
    doc.destroy();
  });

  it('still round-trips a nested list with a continuation paragraph and a fence', () => {
    const doc = new Y.Doc();
    const fragment = getProseFragment(doc);
    doc.transact(() => fragment.push(parseMarkdownBlocks(listMd)));
    const [bullets, ordered] = fragment.toArray() as Y.XmlElement[];
    expect(bullets?.nodeName).toBe('bulletList');
    expect(ordered?.nodeName).toBe('orderedList');
    const items = bullets?.toArray() as Y.XmlElement[];
    expect(items.map((li) => (li.toArray() as Y.XmlElement[]).map((c) => c.nodeName))).toEqual([
      ['paragraph', 'bulletList', 'codeBlock'],
      ['paragraph'],
    ]);
    const nested = (items[0]?.toArray() as Y.XmlElement[])[1] as Y.XmlElement;
    const nestedItem = nested.get(0) as Y.XmlElement;
    expect((nestedItem.toArray() as Y.XmlElement[]).map((c) => c.nodeName)).toEqual([
      'paragraph',
      'paragraph',
    ]);
    expect((ordered?.toArray() as Y.XmlElement[]).length).toBe(2);
    doc.destroy();
  });
});
