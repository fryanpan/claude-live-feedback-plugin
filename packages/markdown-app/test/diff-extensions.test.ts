import { Chunk } from '@codemirror/merge';
import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { oldLineForPos } from '../src/code/diff-extensions.ts';

function chunksFor(a: string, b: string) {
  return Chunk.build(Text.of(a.split('\n')), Text.of(b.split('\n')));
}

describe('oldLineForPos', () => {
  it('maps context lines through a modification + insertion', () => {
    // base:            target:
    // 1 line1          1 line1
    // 2 line2          2 line2 CHANGED
    // 3 line3          3 line3
    //                  4 line4 added
    const a = 'line1\nline2\nline3\n';
    const b = 'line1\nline2 CHANGED\nline3\nline4 added\n';
    const docB = Text.of(b.split('\n'));
    const chunks = chunksFor(a, b);
    const lineStart = (n: number) => docB.line(n).from;

    expect(oldLineForPos(chunks, Text.of(a.split('\n')), lineStart(1))).toBe(1);
    // Changed line: no old number.
    expect(oldLineForPos(chunks, Text.of(a.split('\n')), lineStart(2))).toBeNull();
    expect(oldLineForPos(chunks, Text.of(a.split('\n')), lineStart(3))).toBe(3);
    // Inserted line: no old number.
    expect(oldLineForPos(chunks, Text.of(a.split('\n')), lineStart(4))).toBeNull();
  });

  it('shifts context lines after a pure deletion', () => {
    // base has an extra middle line; target lines after it shift up by one.
    const a = 'keep1\ndoomed\nkeep2\nkeep3\n';
    const b = 'keep1\nkeep2\nkeep3\n';
    const docA = Text.of(a.split('\n'));
    const docB = Text.of(b.split('\n'));
    const chunks = chunksFor(a, b);

    expect(oldLineForPos(chunks, docA, docB.line(1).from)).toBe(1);
    expect(oldLineForPos(chunks, docA, docB.line(2).from)).toBe(3);
    expect(oldLineForPos(chunks, docA, docB.line(3).from)).toBe(4);
  });

  it('returns null for every line of an added file', () => {
    const a = '';
    const b = 'new1\nnew2\n';
    const docB = Text.of(b.split('\n'));
    const chunks = chunksFor(a, b);
    expect(oldLineForPos(chunks, Text.of(['']), docB.line(1).from)).toBeNull();
    expect(oldLineForPos(chunks, Text.of(['']), docB.line(2).from)).toBeNull();
  });

  it('handles multiple chunks accumulating deltas', () => {
    const a = 'a\nb\nc\nd\ne\nf\ng\n';
    const b = 'a\nB1\nB2\nc\nd\nf\ng\n'; // b→B1+B2 (grow 1), e deleted (shrink 1)
    const docA = Text.of(a.split('\n'));
    const docB = Text.of(b.split('\n'));
    const chunks = chunksFor(a, b);

    expect(oldLineForPos(chunks, docA, docB.line(1).from)).toBe(1); // a
    expect(oldLineForPos(chunks, docA, docB.line(4).from)).toBe(3); // c
    expect(oldLineForPos(chunks, docA, docB.line(5).from)).toBe(4); // d
    expect(oldLineForPos(chunks, docA, docB.line(6).from)).toBe(6); // f
    expect(oldLineForPos(chunks, docA, docB.line(7).from)).toBe(7); // g
  });
});
