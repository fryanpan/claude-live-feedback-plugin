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

describe('layoutBalloons — fit-to-viewport shift-up', () => {
  const vp = { top: 0, bottom: 800 };

  it('shifts a balloon up so its bottom meets the viewport bottom', () => {
    expect(layoutBalloons([{ anchorY: 600, height: 560 }], 8, vp)).toEqual([240]);
  });

  it('shifts by exactly the overflow, not more', () => {
    expect(layoutBalloons([{ anchorY: 600, height: 300 }], 8, vp)).toEqual([500]);
  });

  it('leaves a fitting balloon at its anchor', () => {
    expect(layoutBalloons([{ anchorY: 100, height: 560 }], 8, vp)).toEqual([100]);
  });

  it('cascades: the balloon above yields room for a shifted lower one', () => {
    const items = [
      { anchorY: 300, height: 300 },
      { anchorY: 620, height: 300 },
    ];
    // Lower fits at 800 - 300 = 500; upper must clear 500 - gap - height = 192.
    expect(layoutBalloons(items, 8, vp)).toEqual([192, 500]);
  });

  it('leaves balloons anchored below the viewport bottom at their anchors', () => {
    expect(layoutBalloons([{ anchorY: 900, height: 560 }], 8, vp)).toEqual([900]);
  });

  it('re-relaxes the push-down after a shift frees room above', () => {
    // Without the shift, the below-fold balloon is pushed to 600+560+8 = 1168;
    // once the first balloon lifts to 240 the second belongs back at its anchor.
    const items = [
      { anchorY: 600, height: 560 },
      { anchorY: 900, height: 100 },
    ];
    expect(layoutBalloons(items, 8, vp)).toEqual([240, 900]);
  });

  it('never lifts a balloon above the viewport top; leftover overflow pushes down', () => {
    // 500 + 8 + 500 cannot fit in an 800px viewport: the first floors at the
    // viewport top and the second keeps the gap, overflowing minimally.
    const items = [
      { anchorY: 100, height: 500 },
      { anchorY: 350, height: 500 },
    ];
    expect(layoutBalloons(items, 8, vp)).toEqual([0, 508]);
  });

  it('does not move a balloon already above the viewport top', () => {
    const scrolled = { top: 400, bottom: 1200 };
    expect(layoutBalloons([{ anchorY: 200, height: 100 }], 8, scrolled)).toEqual([200]);
  });

  it('stays index-aligned with unsorted input under a viewport', () => {
    const items = [
      { anchorY: 600, height: 560 }, // index 0, sorts second, needs the lift
      { anchorY: 100, height: 100 }, // index 1, sorts first, fits
    ];
    const result = layoutBalloons(items, 8, vp);
    expect(result[1]).toBe(100);
    expect(result[0]).toBe(240);
  });

  it('behaves exactly as before when no viewport is given', () => {
    const items = [
      { anchorY: 600, height: 560 },
      { anchorY: 900, height: 100 },
    ];
    expect(layoutBalloons(items, 8)).toEqual([600, 1168]);
  });
});
