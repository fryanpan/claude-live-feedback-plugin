import { describe, expect, it } from 'vitest';
import { layoutBalloons } from '../src/redline/balloon-layout.ts';

describe('layoutBalloons', () => {
  it('returns an empty array for an empty list', () => {
    expect(layoutBalloons([], 8)).toEqual([]);
  });

  it('places a single balloon at its own anchor', () => {
    expect(layoutBalloons([{ anchorY: 100, height: 40 }], 8)).toEqual([100]);
  });

  it('leaves non-overlapping balloons at their anchors', () => {
    const items = [
      { anchorY: 0, height: 20 },
      { anchorY: 100, height: 20 },
      { anchorY: 200, height: 20 },
    ];
    expect(layoutBalloons(items, 8)).toEqual([0, 100, 200]);
  });

  it('pushes a dense overlap chain down by height + gap each step', () => {
    // Each wants y=0, height 30, gap 10 -> stacks at 0, 40, 80.
    const items = [
      { anchorY: 0, height: 30 },
      { anchorY: 0, height: 30 },
      { anchorY: 0, height: 30 },
    ];
    expect(layoutBalloons(items, 10)).toEqual([0, 40, 80]);
  });

  it('keeps the returned array index-aligned with the input, not sorted order', () => {
    // Input given out of anchor order; output[i] must be the y for input item i.
    const items = [
      { anchorY: 100, height: 20 }, // index 0
      { anchorY: 0, height: 20 }, // index 1 (earliest anchor)
      { anchorY: 50, height: 20 }, // index 2
    ];
    const result = layoutBalloons(items, 5);
    // Sorted by anchorY: item1(0) -> 0, item2(50) -> 50, item0(100) -> 100 (no overlap, gap=5 not needed)
    expect(result[1]).toBe(0);
    expect(result[2]).toBe(50);
    expect(result[0]).toBe(100);
  });

  it('resolves an out-of-order overlap chain with minimal displacement', () => {
    // Two balloons both anchored near 0 but item 0 comes second in anchor order.
    const items = [
      { anchorY: 10, height: 20 }, // index 0, sorts second
      { anchorY: 0, height: 20 }, // index 1, sorts first
    ];
    const result = layoutBalloons(items, 5);
    // index1 (anchor 0) -> 0; index0 (anchor 10) must clear index1's bottom+gap = 25
    expect(result[1]).toBe(0);
    expect(result[0]).toBe(25);
  });

  it('treats zero-height items as needing only the gap to separate', () => {
    const items = [
      { anchorY: 0, height: 0 },
      { anchorY: 0, height: 0 },
    ];
    expect(layoutBalloons(items, 4)).toEqual([0, 4]);
  });

  it('handles negative anchorY, keeping relative order and never floating above the first anchor', () => {
    const items = [
      { anchorY: -50, height: 10 },
      { anchorY: -45, height: 10 },
    ];
    const result = layoutBalloons(items, 5);
    expect(result[0]).toBe(-50);
    expect(result[1]).toBe(-35); // -50 + 10 + 5
  });

  it('never places any balloon above the anchor of the earliest-anchored item', () => {
    const items = [
      { anchorY: 5, height: 10 },
      { anchorY: 5, height: 10 },
    ];
    const result = layoutBalloons(items, 3);
    expect(Math.min(...result)).toBeGreaterThanOrEqual(5);
  });

  it('is stable for exact ties, preserving input order among equal anchors', () => {
    const items = [
      { anchorY: 0, height: 10 }, // index 0
      { anchorY: 0, height: 10 }, // index 1
      { anchorY: 0, height: 10 }, // index 2
    ];
    const result = layoutBalloons(items, 2);
    // Stable sort on ties: index0 stays first in stacking order.
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(12);
    expect(result[2]).toBe(24);
  });
});
