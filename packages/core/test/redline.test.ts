import { describe, expect, it } from 'vitest';
import { computeRedline, snapOffsetsToLines } from '../src/redline.ts';

const joinKind = (segs: { kind: string; text: string }[], kind: string) =>
  segs
    .filter((s) => s.kind === kind)
    .map((s) => s.text)
    .join('');

describe('snapOffsetsToLines', () => {
  it('extends a mid-line range to whole lines', () => {
    const text = 'alpha\nbravo\ncharlie\n';
    expect(snapOffsetsToLines(text, 7, 10)).toEqual({ from: 6, to: 11 });
  });

  it('snaps a collapsed offset to its own line', () => {
    const text = 'alpha\nbravo\n';
    expect(snapOffsetsToLines(text, 8, 8)).toEqual({ from: 6, to: 11 });
  });

  it('handles the first and last line', () => {
    const text = 'alpha\nbravo';
    expect(snapOffsetsToLines(text, 0, 1)).toEqual({ from: 0, to: 5 });
    expect(snapOffsetsToLines(text, 7, 8)).toEqual({ from: 6, to: 11 });
  });

  it('spans multiple lines when the range does', () => {
    const text = 'alpha\nbravo\ncharlie\n';
    expect(snapOffsetsToLines(text, 2, 8)).toEqual({ from: 0, to: 11 });
  });

  it('clamps out-of-range offsets to the document', () => {
    // 'alpha\n' is two lines: "alpha" (0-5) and an empty trailing line at 6.
    // Clamping `to` past the end lands on that empty line, so the snapped
    // range legitimately ends at 6, not at the newline.
    expect(snapOffsetsToLines('alpha\n', -5, 999)).toEqual({ from: 0, to: 6 });
    expect(snapOffsetsToLines('alpha', -5, 999)).toEqual({ from: 0, to: 5 });
  });
});

describe('computeRedline', () => {
  it('does not let punctuation split an obvious edit into delete + insert', () => {
    // Regression: similarity() tokenized on whitespace, so "One." and "One
    // changed." shared no token, scored 0, and fell below the pairing
    // threshold — a one-word addition rendered as a full rewrite.
    const blocks = computeRedline('One.\n', 'One changed.\n');
    expect(blocks.map((b) => b.kind)).toEqual(['changed']);
  });

  it('marks every block same for identical input', () => {
    const md = '# Title\n\nBody text.\n';
    expect(computeRedline(md, md).map((b) => b.kind)).toEqual(['same', 'same']);
  });

  it('is deterministic — the property multi-client convergence rests on', () => {
    const a = '# T\n\nOne two three.\n';
    const b = '# T\n\nOne four three.\n\nAdded.\n';
    expect(JSON.stringify(computeRedline(a, b))).toBe(JSON.stringify(computeRedline(a, b)));
  });

  it('word-diffs a reworded paragraph rather than replacing it', () => {
    const blocks = computeRedline('The quick brown fox.\n', 'The quick red fox.\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('changed');
    expect(joinKind(blocks[0].segments, 'del')).toBe('brown');
    expect(joinKind(blocks[0].segments, 'ins')).toBe('red');
  });

  it('reports an inserted block with a new-side span that slices back', () => {
    const newMd = 'A.\n\nB.\n';
    const blocks = computeRedline('A.\n', newMd);
    const ins = blocks.filter((b) => b.kind === 'ins');
    expect(ins).toHaveLength(1);
    expect(newMd.slice(ins[0].from, ins[0].to)).toBe('B.');
  });

  it('gives a deleted block a snapTo pointing at the next surviving block', () => {
    const newMd = 'A.\n\nC.\n';
    const blocks = computeRedline('A.\n\nB.\n\nC.\n', newMd);
    const del = blocks.find((b) => b.kind === 'del');
    expect(del).toBeDefined();
    expect(del?.from).toBeUndefined();
    expect(del?.snapTo).toBe(newMd.indexOf('C.'));
  });

  it('snapTo falls back to the end of the document when nothing follows', () => {
    const newMd = 'A.\n';
    const blocks = computeRedline('A.\n\nTrailing.\n', newMd);
    const del = blocks.find((b) => b.kind === 'del');
    expect(del?.snapTo).toBe(newMd.length);
  });

  it('renders a heading level change as delete + insert, not a word diff', () => {
    // The level lives in the source text, so word-diffing would show
    // "##" -> "###" — marker noise instead of the real change. Word does the
    // same thing for structural changes.
    const kinds = computeRedline('## Section\n', '### Section\n')
      .map((b) => b.kind)
      .sort();
    expect(kinds).toEqual(['del', 'ins']);
  });

  it('renders a paragraph becoming a list as delete + insert', () => {
    const kinds = computeRedline('one two\n', '- one\n- two\n')
      .map((b) => b.kind)
      .sort();
    expect(kinds).toEqual(['del', 'ins']);
  });

  it('does not word-diff two unrelated paragraphs', () => {
    // Below the similarity threshold: this is a delete and an add, not an edit.
    const kinds = computeRedline(
      'Completely unrelated prose here.\n',
      'Nothing alike whatsoever.\n',
    )
      .map((b) => b.kind)
      .sort();
    expect(kinds).toEqual(['del', 'ins']);
  });

  it('treats an added file (empty base) as all insertions', () => {
    const blocks = computeRedline('', '# New\n\nBody.\n');
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((b) => b.kind === 'ins')).toBe(true);
  });

  it('treats a deleted file (empty new) as all deletions', () => {
    const blocks = computeRedline('# Gone\n', '');
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((b) => b.kind === 'del')).toBe(true);
  });

  it('returns nothing for two empty documents', () => {
    expect(computeRedline('', '')).toEqual([]);
  });

  it('keeps new-side blocks in document order', () => {
    const blocks = computeRedline('A.\n\nB.\n', 'A.\n\nX.\n\nB.\n');
    const spans = blocks.filter((b) => b.from != null).map((b) => b.from as number);
    expect([...spans].sort((x, y) => x - y)).toEqual(spans);
  });

  it('leaves untouched blocks as same when one block changes', () => {
    const blocks = computeRedline('# T\n\nOne.\n\nTwo.\n', '# T\n\nOne changed.\n\nTwo.\n');
    expect(blocks.map((b) => b.kind)).toEqual(['same', 'changed', 'same']);
  });

  it('every non-del block span slices back to its own source', () => {
    const newMd = '# T\n\nAlpha beta.\n\n- x\n- y\n\n> quote\n';
    for (const b of computeRedline('# T\n\nAlpha gamma.\n', newMd)) {
      if (b.from == null || b.to == null) continue;
      expect(newMd.slice(b.from, b.to)).toBe(
        b.segments
          .filter((s) => s.kind !== 'del')
          .map((s) => s.text)
          .join(''),
      );
    }
  });
});
