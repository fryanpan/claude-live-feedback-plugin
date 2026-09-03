/**
 * The gutter curve that says which ticket a blocked row is waiting for.
 *
 * The properties worth a test are the ones a reader would notice were wrong:
 * the arrowhead lands on the WAITING row in both directions, an edge that
 * leaves the band is dropped rather than drawn short, and a band with no
 * layout draws nothing instead of a knot of degenerate curves at y=0.
 *
 * Fixtures are synthetic.
 */
import { describe, expect, it } from 'vitest';
import { type DepRowBox, depCurves, depGutter } from '../src/hub/dep-curves.ts';

const GUTTER = depGutter(34);

function rows(...ids: string[]): DepRowBox[] {
  return ids.map((id, i) => ({ id, top: i * 40, height: 40 }));
}

/** The arrowhead's tip, which is its first point. */
function tip(head: string): { x: number; y: number } {
  const [, x, y] = head.split(' ');
  return { x: Number(x), y: Number(y) };
}

describe('depGutter', () => {
  it('puts the spine left of the ring and keeps it on the canvas when the padding shrinks', () => {
    expect(depGutter(34)).toEqual({ edgeX: 31, spineX: 12 });
    // The narrow tier pads 24; a naive pad-22 would put the spine at 2, half
    // of the 1.5px stroke hanging off the left edge.
    expect(depGutter(24)).toEqual({ edgeX: 21, spineX: 7 });
    // A pad small enough to push the spine off the canvas is clamped, not
    // allowed negative.
    expect(depGutter(10).spineX).toBe(7);
    // A container that has not been laid out yet measures 0; the gutter falls
    // back to the desktop padding rather than collapsing onto the rows.
    expect(depGutter(0)).toEqual(depGutter(34));
  });
});

describe('depCurves', () => {
  it('points the arrowhead at the waiting row when the blocker is ABOVE it', () => {
    const [curve] = depCurves(rows('a', 'b'), [{ from: 'a', to: 'b' }], GUTTER);
    expect(curve).toBeTruthy();
    // Row b's centre: top 40 + half of 40.
    expect(tip(curve?.head ?? '')).toEqual({ x: 31, y: 60 });
    expect(curve?.d.startsWith('M 31 20 ')).toBe(true);
    expect(curve?.d.endsWith(' 31 60')).toBe(true);
  });

  it('points it at the waiting row when the blocker is BELOW it — the line reads one way', () => {
    const [curve] = depCurves(rows('a', 'b'), [{ from: 'b', to: 'a' }], GUTTER);
    // Same pair of rows, edge reversed: the head must move to row a.
    expect(tip(curve?.head ?? '')).toEqual({ x: 31, y: 20 });
    expect(curve?.d.startsWith('M 31 60 ')).toBe(true);
    // The corner radius flips sign rather than the shape flipping: running
    // upward, the spine starts ABOVE the blocker's centre (60 - 10) and ends
    // BELOW the waiting row's (20 + 10).
    expect(curve?.d).toContain('12 50 L 12 30');
  });

  it('draws every edge it is given, including two rows waiting on one blocker', () => {
    const out = depCurves(
      rows('a', 'b', 'c'),
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
      ],
      GUTTER,
    );
    expect(out.map((c) => c.to)).toEqual(['b', 'c']);
  });

  it('drops an edge whose blocker sits in another goal — and the control shows the same edge drawn when it does not', () => {
    const edge = [{ from: 'elsewhere', to: 'b' }];
    expect(depCurves(rows('a', 'b'), edge, GUTTER)).toEqual([]);
    // Positive control: the identical call with the blocker present draws it,
    // so the empty result above is the band membership and not a typo.
    expect(
      depCurves([...rows('a', 'b'), { id: 'elsewhere', top: 80, height: 40 }], edge, GUTTER),
    ).toHaveLength(1);
  });

  it('draws nothing for a band with no layout, rather than a knot at the top', () => {
    const folded = [
      { id: 'a', top: 0, height: 0 },
      { id: 'b', top: 0, height: 0 },
    ];
    expect(depCurves(folded, [{ from: 'a', to: 'b' }], GUTTER)).toEqual([]);
    // Positive control: give the same rows a height and the curve appears.
    expect(depCurves(rows('a', 'b'), [{ from: 'a', to: 'b' }], GUTTER)).toHaveLength(1);
  });

  it('follows the rows when a title wraps, instead of assuming a row height', () => {
    const wrapped: DepRowBox[] = [
      { id: 'a', top: 0, height: 74 },
      { id: 'b', top: 74, height: 40 },
    ];
    const [curve] = depCurves(wrapped, [{ from: 'a', to: 'b' }], GUTTER);
    expect(curve?.d.startsWith('M 31 37 ')).toBe(true);
    expect(tip(curve?.head ?? '').y).toBe(94);
  });

  it('ignores a self-edge', () => {
    expect(depCurves(rows('a', 'b'), [{ from: 'a', to: 'a' }], GUTTER)).toEqual([]);
  });
});
