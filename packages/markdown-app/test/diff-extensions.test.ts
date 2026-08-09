import { Chunk } from '@codemirror/merge';
import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import {
  isWhitespaceOnlyChange,
  oldLineForPos,
  whitespaceFilter,
} from '../src/code/diff-extensions.ts';

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

describe('isWhitespaceOnlyChange', () => {
  it('is true for indentation, trailing space, and blank lines', () => {
    expect(isWhitespaceOnlyChange('', '    ')).toBe(true);
    expect(isWhitespaceOnlyChange('a\nb', '  a\n  b')).toBe(true);
    expect(isWhitespaceOnlyChange('a  ', 'a')).toBe(true);
    expect(isWhitespaceOnlyChange('a\nb', 'a\n\n\nb')).toBe(true);
    expect(isWhitespaceOnlyChange('a\r\nb', 'a\nb')).toBe(true);
  });

  it('is false as soon as one non-space character differs', () => {
    expect(isWhitespaceOnlyChange('four', 'CHANGED')).toBe(false);
    expect(isWhitespaceOnlyChange('a b', 'ab')).toBe(false); // a space that MATTERS
    expect(isWhitespaceOnlyChange('x = 1', 'x = 2')).toBe(false);
  });
});

/**
 * Suppressing whitespace changes is the easy half. The hard half is that
 * `oldLineForPos` reconstructs base line numbers by accumulating the size
 * delta of every CHUNK before a position — so a change that is hidden
 * contributes no delta and every old line number after it drifts by the
 * width of the indent. The drift is silent: the gutter keeps rendering
 * plausible numbers that are simply wrong.
 *
 * The fixture below is built so the drift crosses a line boundary. Four
 * lines each gain 8 spaces = 32 characters of accumulated error, against
 * base lines only 3 characters wide.
 */
describe('whitespace-aware diff', () => {
  const a = 'real\nb1\nb2\nb3\nb4\ntail\n';
  const b = 'CHANGED\n        b1\n        b2\n        b3\n        b4\ntail\n';
  const docA = Text.of(a.split('\n'));
  const docB = Text.of(b.split('\n'));

  const build = (enabled: boolean) => {
    const filter = whitespaceFilter({ scanLimit: 2000, enabled });
    const chunks = Chunk.build(docA, docB, filter.diffConfig);
    return { filter, chunks };
  };

  it('CONTROL: with the filter OFF the reindented lines all read as changed', () => {
    // Without this the assertions below could pass on a diff that found
    // nothing to hide in the first place. This is the noise being removed:
    // three lines whose only change is indentation, marked as changed and
    // stripped of their base line numbers.
    const { filter, chunks } = build(false);
    expect(filter.hidden).toHaveLength(0);
    for (const line of [3, 4, 5]) {
      expect(oldLineForPos(chunks, docA, docB.line(line).from), `line ${line}`).toBeNull();
    }
  });

  it('hides the reindents and keeps the real edit', () => {
    const { filter, chunks } = build(true);
    // Three, not four: presentableDiff merges the first reindent into the
    // adjacent real change, so that line stays visible. Suppression is
    // per-change, and a change that carries any content is never dropped.
    expect(filter.hidden).toHaveLength(3);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.fromB).toBe(0); // the `real` → `CHANGED` line only
  });

  it('keeps old line numbers correct AFTER a suppressed reindent', () => {
    const { filter, chunks } = build(true);
    // `tail` is line 6 in both files. The suppressed changes account for 24
    // characters of the 35-character offset between the documents; drop them
    // from the running delta and this reads past the end of a 22-character
    // base document and returns null instead of 6.
    const got = oldLineForPos(chunks, docA, docB.line(6).from, {
      hidden: filter.hidden,
      doc: docB,
    });
    expect(got).toBe(6);
  });

  it('numbers the suppressed lines themselves, rather than blanking them', () => {
    const { filter, chunks } = build(true);
    const opts = { hidden: filter.hidden, doc: docB };
    // A reindented line is unchanged content: it still has a base number.
    // Compare with the CONTROL above, where all three were null.
    expect(oldLineForPos(chunks, docA, docB.line(3).from, opts)).toBe(3);
    expect(oldLineForPos(chunks, docA, docB.line(4).from, opts)).toBe(4);
    expect(oldLineForPos(chunks, docA, docB.line(5).from, opts)).toBe(5);
  });

  it('still returns null for a genuinely changed line', () => {
    const { filter, chunks } = build(true);
    const opts = { hidden: filter.hidden, doc: docB };
    expect(oldLineForPos(chunks, docA, docB.line(1).from, opts)).toBeNull();
    // Line 2's reindent was absorbed into that chunk, so it reads as changed
    // too — visible noise, but never a WRONG number.
    expect(oldLineForPos(chunks, docA, docB.line(2).from, opts)).toBeNull();
  });

  it('leaves an inserted blank line WITHOUT a base number', () => {
    // A blank line the formatter added exists in the target only. Numbering
    // it would repeat the line above and claim an identity it doesn't have.
    const p = 'x = 1\ny = 2\n';
    const q = 'x = 1\n\n\ny = 2\n';
    const dp = Text.of(p.split('\n'));
    const dq = Text.of(q.split('\n'));
    const f = whitespaceFilter({ scanLimit: 2000, enabled: true });
    const chunks = Chunk.build(dp, dq, f.diffConfig);
    expect(f.hidden.length).toBeGreaterThan(0); // control: it WAS suppressed
    expect(chunks).toHaveLength(0); // control: nothing renders as changed
    const opts = { hidden: f.hidden, doc: dq };
    expect(oldLineForPos(chunks, dp, dq.line(1).from, opts)).toBe(1);
    expect(oldLineForPos(chunks, dp, dq.line(3).from, opts)).toBeNull();
    // The line AFTER the insertion still resolves — the delta is accounted for.
    expect(oldLineForPos(chunks, dp, dq.line(4).from, opts)).toBe(2);
  });

  /**
   * The invariant that matters, over a realistic formatter output: whenever
   * the gutter shows a base line number, the base line at that number must
   * be the SAME line of code. Anything else is a gutter that lies, which is
   * worse than the noise this feature removes. Found two real bugs — an
   * inserted blank line borrowing its neighbour's number, and the following
   * line mapping into the middle of a base line.
   */
  it('never points at the wrong base line, over a whole reformatted file', () => {
    const base = [
      'function computeTotal(items) {',
      'return items.reduce((sum, item) => sum + item.price, 0);',
      '}',
      'function applyDiscount(total, rate) {',
      'return total * (1 - rate);',
      '}',
      'export { computeTotal, applyDiscount };',
      '',
    ].join('\n');
    const target = [
      'function computeTotal(items) {',
      '    return items.reduce((sum, item) => sum + item.price, 0);',
      '}',
      '',
      'function applyDiscount(total, rate) {',
      '    return total * (1 - rate);',
      '}',
      '',
      'export { computeTotal, applyDiscount, roundUp };',
      '',
    ].join('\n');
    const dBase = Text.of(base.split('\n'));
    const dTarget = Text.of(target.split('\n'));
    const f = whitespaceFilter({ scanLimit: 2000, enabled: true });
    const chunks = Chunk.build(dBase, dTarget, f.diffConfig);
    const opts = { hidden: f.hidden, doc: dTarget };

    expect(f.hidden.length).toBeGreaterThan(0); // control: suppression happened
    let numbered = 0;
    for (let n = 1; n <= dTarget.lines; n++) {
      const got = oldLineForPos(chunks, dBase, dTarget.line(n).from, opts);
      if (got === null) continue;
      numbered++;
      expect(dBase.line(got).text.trim(), `target line ${n} → base ${got}`).toBe(
        dTarget.line(n).text.trim(),
      );
    }
    // Control: the loop above is vacuous if everything came back null.
    expect(numbered).toBeGreaterThanOrEqual(dTarget.lines - 4);
  });

  it('is a no-op when nothing differs but whitespace-free content', () => {
    // A diff with only real changes must produce the same chunks either way.
    const p = 'x = 1\ny = 2\n';
    const q = 'x = 9\ny = 2\n';
    const on = Chunk.build(
      Text.of(p.split('\n')),
      Text.of(q.split('\n')),
      whitespaceFilter({ scanLimit: 2000, enabled: true }).diffConfig,
    );
    const off = Chunk.build(Text.of(p.split('\n')), Text.of(q.split('\n')));
    expect(on.map((c) => [c.fromA, c.toA, c.fromB, c.toB])).toEqual(
      off.map((c) => [c.fromA, c.toA, c.fromB, c.toB]),
    );
  });
});
