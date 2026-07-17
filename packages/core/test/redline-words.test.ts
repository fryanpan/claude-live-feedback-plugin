import { describe, expect, it } from 'vitest';
import { type RedlineSegment, diffWords } from '../src/redline.ts';

const textOf = (segs: RedlineSegment[], kind: string) =>
  segs
    .filter((s) => s.kind === kind)
    .map((s) => s.text)
    .join('');

describe('diffWords', () => {
  it('marks everything same for identical input', () => {
    const segs = diffWords('the quick fox', 'the quick fox');
    expect(segs.every((s) => s.kind === 'same')).toBe(true);
    expect(textOf(segs, 'same')).toBe('the quick fox');
  });

  it('isolates a single changed word', () => {
    const segs = diffWords('the quick brown fox', 'the quick red fox');
    expect(textOf(segs, 'del')).toBe('brown');
    expect(textOf(segs, 'ins')).toBe('red');
    expect(textOf(segs, 'same')).toContain('the quick');
    expect(textOf(segs, 'same')).toContain('fox');
  });

  it('reports offsets into b that slice back to the segment text', () => {
    const b = 'the quick red fox';
    for (const s of diffWords('the quick brown fox', b)) {
      if (s.kind === 'del') {
        // Deleted text has no position on the new side — that absence is the
        // whole reason the deletedSnippet anchor hint exists.
        expect(s.from).toBeUndefined();
        continue;
      }
      expect(b.slice(s.from, s.to)).toBe(s.text);
    }
  });

  it('applies bOffset to reported offsets', () => {
    const segs = diffWords('a', 'b', 100);
    const ins = segs.find((s) => s.kind === 'ins');
    expect(ins?.from).toBe(100);
    expect(ins?.to).toBe(101);
  });

  it('handles pure insertion and pure deletion', () => {
    expect(textOf(diffWords('', 'new text'), 'ins')).toBe('new text');
    expect(textOf(diffWords('old text', ''), 'del')).toBe('old text');
  });

  it('returns nothing for two empty strings', () => {
    expect(diffWords('', '')).toEqual([]);
  });

  it('preserves whitespace so segments reassemble into the originals', () => {
    const a = 'one  two\nthree';
    const b = 'one  four\nthree';
    const segs = diffWords(a, b);
    const rebuiltA = segs
      .filter((s) => s.kind !== 'ins')
      .map((s) => s.text)
      .join('');
    const rebuiltB = segs
      .filter((s) => s.kind !== 'del')
      .map((s) => s.text)
      .join('');
    expect(rebuiltA).toBe(a);
    expect(rebuiltB).toBe(b);
  });

  it('reassembles exactly even for a heavily rewritten string', () => {
    const a = 'The quick brown fox jumps over the lazy dog.';
    const b = 'A quick red fox vaulted over some lazy dogs today.';
    const segs = diffWords(a, b);
    expect(
      segs
        .filter((s) => s.kind !== 'ins')
        .map((s) => s.text)
        .join(''),
    ).toBe(a);
    expect(
      segs
        .filter((s) => s.kind !== 'del')
        .map((s) => s.text)
        .join(''),
    ).toBe(b);
  });

  it('merges adjacent same tokens into one segment', () => {
    expect(diffWords('a b c', 'a b c')).toHaveLength(1);
  });

  it('keeps ins and del as separate segments rather than merging across kinds', () => {
    const segs = diffWords('alpha', 'beta');
    expect(segs.map((s) => s.kind)).toEqual(['del', 'ins']);
  });
});
