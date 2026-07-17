import { describe, expect, it } from 'vitest';
import { lcsKept } from '../src/lcs.ts';

describe('lcsKept', () => {
  it('keeps everything when the sequences are identical', () => {
    const { keptA, keptB } = lcsKept(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect([...keptA].sort()).toEqual([0, 1, 2]);
    expect([...keptB].sort()).toEqual([0, 1, 2]);
  });

  it('keeps nothing when the sequences are disjoint', () => {
    const { keptA, keptB } = lcsKept(['a'], ['z']);
    expect(keptA.size).toBe(0);
    expect(keptB.size).toBe(0);
  });

  it('finds the common subsequence around an insertion', () => {
    const { keptA, keptB } = lcsKept(['a', 'c'], ['a', 'b', 'c']);
    expect([...keptA].sort()).toEqual([0, 1]);
    expect([...keptB].sort()).toEqual([0, 2]);
  });

  it('finds the common subsequence around a deletion', () => {
    const { keptA, keptB } = lcsKept(['a', 'b', 'c'], ['a', 'c']);
    expect([...keptA].sort()).toEqual([0, 2]);
    expect([...keptB].sort()).toEqual([0, 1]);
  });

  it('handles empty input on either side', () => {
    expect(lcsKept([], ['a']).keptA.size).toBe(0);
    expect(lcsKept(['a'], []).keptB.size).toBe(0);
    expect(lcsKept([], []).keptA.size).toBe(0);
  });

  it('picks the longest subsequence, not the first greedy match', () => {
    // Greedy left-to-right would match only 'x'; the LCS is x,y,z.
    const { keptA } = lcsKept(['x', 'q', 'y', 'z'], ['x', 'y', 'z']);
    expect([...keptA].sort()).toEqual([0, 2, 3]);
  });

  it('reports kept indices that select equal elements pairwise', () => {
    const a = ['the', 'quick', 'brown', 'fox'];
    const b = ['the', 'quick', 'red', 'fox'];
    const { keptA, keptB } = lcsKept(a, b);
    const pickedA = [...keptA].sort((x, y) => x - y).map((i) => a[i]);
    const pickedB = [...keptB].sort((x, y) => x - y).map((i) => b[i]);
    expect(pickedA).toEqual(pickedB);
    expect(pickedA).toEqual(['the', 'quick', 'fox']);
  });
});
