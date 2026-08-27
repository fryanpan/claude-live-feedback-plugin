import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  findAndReplace,
  getProseFragment,
  parseMarkdownBlocks,
  serializeFragmentToMarkdown,
} from '../src/prose';

/**
 * Closes the table trap from the 2026-08-26 incident: an agent quoted a table
 * row from the on-disk markdown (`| Alpha | 2 |`) as a find_and_replace find
 * string. The live doc stores tables structurally — the flattened text has no
 * pipes — so the call 409'd no-match, which pushed the agent into a whole-doc
 * set_doc_content rewrite from a stale copy.
 *
 * Fix under test: when the find string parses as pipe-table row(s),
 * find_and_replace falls back to structural row matching — cells compared by
 * their live text, whitespace-normalized — and applies the replacement
 * cell-by-cell. When even that finds nothing, the no-match error must carry a
 * warning that names the working tools and forbids the set_doc_content
 * fallback.
 */

const TABLE_DOC = [
  '# Metrics',
  '',
  'Intro paragraph.',
  '',
  '| Name  | Count | Note        |',
  '| ----- | ----- | ----------- |',
  '| Alpha | 2     | first row   |',
  '| Beta  | 1     | second row  |',
  '| Gamma | 3     | third row   |',
].join('\n');

function mkDoc(md: string): Y.Doc {
  const doc = new Y.Doc();
  const frag = getProseFragment(doc);
  doc.transact(() => frag.push(parseMarkdownBlocks(md)));
  return doc;
}

describe('find_and_replace on markdown table rows', () => {
  it('matches a row quoted in on-disk pipe syntax and applies the cell edits', () => {
    const doc = mkDoc(TABLE_DOC);
    const res = findAndReplace(doc, {
      find: '| Alpha | 2     | first row   |',
      replace: '| Alpha | **2** | first row |',
    });
    expect(res.ok).toBe(true);
    const out = serializeFragmentToMarkdown(getProseFragment(doc));
    expect(out).toContain('**2**');
    // Untouched cells and rows survive.
    expect(out).toContain('Alpha');
    expect(out).toContain('first row');
    expect(out).toContain('second row');
  });

  it('is whitespace-tolerant: the agent’s padding need not match the serializer’s', () => {
    const doc = mkDoc(TABLE_DOC);
    const res = findAndReplace(doc, {
      find: '| Beta | 1 | second row |',
      replace: '| Beta | **1** | second row |',
    });
    expect(res.ok).toBe(true);
    const out = serializeFragmentToMarkdown(getProseFragment(doc));
    expect(out).toContain('**1**');
  });

  it('matches a multi-row find (separator lines ignored) and edits each row', () => {
    const doc = mkDoc(TABLE_DOC);
    const res = findAndReplace(doc, {
      find: ['| Alpha | 2 | first row |', '| Beta | 1 | second row |'].join('\n'),
      replace: ['| Alpha | **2** | first row |', '| Beta | 1 | second row |'].join('\n'),
    });
    expect(res.ok).toBe(true);
    const out = serializeFragmentToMarkdown(getProseFragment(doc));
    expect(out).toContain('**2**');
  });

  it('matches a header row too', () => {
    const doc = mkDoc(TABLE_DOC);
    const res = findAndReplace(doc, {
      find: '| Name | Count | Note |',
      replace: '| Name | Count (≥2 bold) | Note |',
    });
    expect(res.ok).toBe(true);
    const out = serializeFragmentToMarkdown(getProseFragment(doc));
    expect(out).toContain('Count (≥2 bold)');
  });

  it('replaceAll sweeps every matching row', () => {
    const twoTables = `${TABLE_DOC}\n\nAnother table.\n\n| Name | Count |\n| --- | --- |\n| Alpha | 2 |\n`;
    const doc = mkDoc(twoTables);
    const res = findAndReplace(doc, {
      find: '| Alpha | 2 |',
      replace: '| Alpha | **2** |',
      replaceAll: true,
    });
    // Only the second table has a two-cell Alpha row; the first table's
    // Alpha row has three cells and must not match a two-cell find.
    expect(res.ok).toBe(true);
    const out = serializeFragmentToMarkdown(getProseFragment(doc));
    expect(out).toContain('**2**');
    expect(out).toContain('first row');
  });

  it('refuses a shape-mismatched replacement instead of guessing', () => {
    const doc = mkDoc(TABLE_DOC);
    const res = findAndReplace(doc, {
      find: '| Alpha | 2 | first row |',
      replace: '| Alpha | 2 |',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('table-shape-mismatch');
  });

  it('a table-shaped find that matches nothing warns against the set_doc_content fallback', () => {
    const doc = mkDoc(TABLE_DOC);
    const res = findAndReplace(doc, {
      find: '| Delta | 9 | no such row |',
      replace: '| Delta | 9 | still none |',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('no-match');
    expect(res.warning).toContain('set_doc_content');
    expect(res.warning).toContain('edit_at_anchor');
  });

  it('matches a row whose cell carries inline marks, quoted in its serialized form', () => {
    // The primary use case is pasting a row from the .md — and a marked cell
    // serializes as `**2**` / `[label](url)`, not as its plain text.
    const doc = mkDoc(
      [
        '| Name | Count | Link |',
        '| --- | --- | --- |',
        '| Alpha | **2** | [docs](https://x.test) |',
      ].join('\n'),
    );
    const res = findAndReplace(doc, {
      find: '| Alpha | **2** | [docs](https://x.test) |',
      replace: '| Alpha | **2** (checked) | [docs](https://x.test) |',
    });
    expect(res.ok).toBe(true);
    const out = serializeFragmentToMarkdown(getProseFragment(doc));
    expect(out).toContain('**2**');
    expect(out).toContain('(checked)');
    expect(out).toContain('[docs](https://x.test)');
  });

  it('treats \\| as cell content, matching a row with a literal pipe by its on-disk form', () => {
    // The serializer emits `a \| b` for a cell holding a literal pipe;
    // splitting on every `|` would shred that into cells that can never
    // match. Both the doc's own parse and the find/replace rows must honor
    // the escape.
    const md = ['| Name | Note |', '| --- | --- |', '| Alpha | a \\| b |'].join('\n');
    const doc = mkDoc(md);
    // The parse itself keeps the escaped pipe inside ONE cell…
    expect(serializeFragmentToMarkdown(getProseFragment(doc))).toContain('a \\| b');
    // …and a find quoting the serialized row matches it.
    const res = findAndReplace(doc, {
      find: '| Alpha | a \\| b |',
      replace: '| Alpha | a \\| b (ok) |',
    });
    expect(res.ok).toBe(true);
    const out = serializeFragmentToMarkdown(getProseFragment(doc));
    expect(out).toContain('a \\| b (ok)');
  });

  it('a replacement can write a NEW literal pipe into a cell and it round-trips escaped', () => {
    const doc = mkDoc(TABLE_DOC);
    const res = findAndReplace(doc, {
      find: '| Beta | 1 | second row |',
      replace: '| Beta | 1 | x \\| y |',
    });
    expect(res.ok).toBe(true);
    const out = serializeFragmentToMarkdown(getProseFragment(doc));
    // In the doc the cell holds a literal `x | y`; the serializer escapes it.
    expect(out).toContain('x \\| y');
    // And the new serialized form matches on a follow-up find.
    const again = findAndReplace(doc, {
      find: '| Beta | 1 | x \\| y |',
      replace: '| Beta | 1 | second row |',
    });
    expect(again.ok).toBe(true);
  });

  it('plain cell-text finds keep working exactly as before', () => {
    const doc = mkDoc(TABLE_DOC);
    const res = findAndReplace(doc, { find: 'second row', replace: 'row two' });
    expect(res.ok).toBe(true);
    const out = serializeFragmentToMarkdown(getProseFragment(doc));
    expect(out).toContain('row two');
  });
});
