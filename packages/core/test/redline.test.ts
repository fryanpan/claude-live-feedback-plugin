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

  it('snapTo falls back to the LAST REAL LINE when nothing follows', () => {
    // Originally asserted newMd.length — which encoded a bug: that offset sits
    // on the empty line after the trailing newline, so snapOffsetsToLines
    // returned an empty range and the comment pill never appeared for a
    // deletion at the end of a document.
    const newMd = 'A.\n';
    const blocks = computeRedline('A.\n\nTrailing.\n', newMd);
    const del = blocks.find((b) => b.kind === 'del');
    expect(del?.snapTo).toBe(0);
    const snapped = snapOffsetsToLines(newMd, del?.snapTo as number, del?.snapTo as number);
    expect(newMd.slice(snapped.from, snapped.to)).toBe('A.');
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

describe('computeRedline block ordering', () => {
  it('keeps a deleted block in its base position, not floated above earlier text', () => {
    // Regression: pairGap emitted every deletion before every new-side block,
    // so a removed section that FOLLOWED a reworded paragraph rendered ABOVE
    // it — reading as though the wrong thing was cut, and snapping comments on
    // it to the paragraph instead of the section that follows.
    const base = 'Intro one.\n\n## Removed\n\nGone body.\n\n## Kept\n';
    const next = 'Intro two.\n\n## Kept\n';
    const kinds = computeRedline(base, next).map((b) => b.kind);
    expect(kinds).toEqual(['changed', 'del', 'del', 'same']);
  });

  it('snaps a deleted block to the block that FOLLOWED it in the base', () => {
    const base = 'Intro one.\n\n## Removed\n\n## Kept\n';
    const next = 'Intro two.\n\n## Kept\n';
    const blocks = computeRedline(base, next);
    const del = blocks.find((b) => b.kind === 'del');
    // "## Kept" is what survives after the deletion — that is where a comment
    // on the removed heading belongs, not back on the intro paragraph.
    expect(del?.snapTo).toBe(next.indexOf('## Kept'));
  });

  it('places an insertion where it was added, not at the end of the gap', () => {
    const base = 'Alpha.\n\nOmega.\n';
    const next = 'Alpha edited.\n\nInserted middle.\n\nOmega.\n';
    const kinds = computeRedline(base, next).map((b) => b.kind);
    expect(kinds).toEqual(['changed', 'ins', 'same']);
  });
});

describe('computeRedline — review regressions', () => {
  it('never emits the same new-side block twice when matches would cross', () => {
    // Unconstrained matching let pairs cross (B0<->A1, B1<->A0); the merge then
    // walked base order while new-side order ran backwards, re-emitting an
    // insertion. The reviewer saw the paragraph twice, offsets stopped
    // ascending (breaking snapTo), and resolveRel unioned a range across the
    // whole document.
    const base =
      'Alpha paragraph about widgets and gears.\n\nBeta paragraph about sprockets and cogs.\n';
    const next =
      'Beta paragraph about sprockets and cogs now.\n\nTotally new inserted paragraph here.\n\nAlpha paragraph about widgets and gears too.\n';
    const blocks = computeRedline(base, next);
    const froms = blocks.filter((b) => b.from != null).map((b) => b.from as number);
    expect(new Set(froms).size).toBe(froms.length);
  });

  it('keeps new-side offsets ascending even when blocks are reordered', () => {
    const base =
      'Alpha paragraph about widgets and gears.\n\nBeta paragraph about sprockets and cogs.\n';
    const next =
      'Beta paragraph about sprockets and cogs now.\n\nAlpha paragraph about widgets and gears too.\n';
    const froms = computeRedline(base, next)
      .filter((b) => b.from != null)
      .map((b) => b.from as number);
    // The snapTo backward pass and resolveRel both assume this ordering.
    expect([...froms].sort((x, y) => x - y)).toEqual(froms);
  });

  it('gives a trailing deletion a snap target on a real line, not past the end', () => {
    // snapTo === newMd.length sits on the empty line after the final newline,
    // so snapOffsetsToLines returned an empty range, getSelectionRel returned
    // null, and the comment pill never appeared. Deleting the last section of a
    // doc is routine.
    const next = '# Title\n\nKept paragraph.\n';
    const blocks = computeRedline('# Title\n\nKept paragraph.\n\nDoomed final paragraph.\n', next);
    const del = blocks.find((b) => b.kind === 'del');
    expect(del?.snapTo).toBeLessThan(next.length);
    const snapped = snapOffsetsToLines(next, del?.snapTo as number, del?.snapTo as number);
    expect(snapped.to).toBeGreaterThan(snapped.from);
    expect(next.slice(snapped.from, snapped.to)).toBe('Kept paragraph.');
  });
});
