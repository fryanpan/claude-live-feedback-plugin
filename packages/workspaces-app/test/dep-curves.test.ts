/**
 * The gutter curve that says which ticket a blocked row is waiting for.
 *
 * The properties worth a test are the ones a reader would notice were wrong:
 * the arrowhead lands on the WAITING row in both directions, an edge that
 * leaves the band is dropped rather than drawn short, a band with no layout
 * draws nothing instead of a knot of degenerate curves at y=0, and every line
 * in a band runs down an x of its own so a reader can follow one of them.
 *
 * Fixtures are synthetic.
 */
import { describe, expect, it } from 'vitest';
import { type DepRowBox, depCurves, depGutter, depLanes } from '../src/hub/dep-curves.ts';

const GUTTER = depGutter(34);

function rows(...ids: string[]): DepRowBox[] {
  return ids.map((id, i) => ({ id, top: i * 40, height: 40 }));
}

/** The arrowhead's tip, which is its first point. */
function tip(head: string): { x: number; y: number } {
  const [, x, y] = head.split(' ');
  return { x: Number(x), y: Number(y) };
}

/** The x of the vertical a curve runs down, read back out of its `d`:
 *  `M edgeX y1 C ctrlX y1 laneX ...`. Read from the path rather than the
 *  `laneX` field so the test proves the number reached the drawing. */
function laneOf(d: string): number {
  return Number(d.split(' ')[6]);
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

describe('depLanes', () => {
  it('gives one line the gutter spine, unchanged from before the nesting', () => {
    expect(depLanes(12, 1)).toEqual([12]);
    expect(depLanes(12, 0)).toEqual([]);
  });

  it('steps each further lane 2px left, rightmost first', () => {
    expect(depLanes(12, 5)).toEqual([12, 10, 8, 6, 4]);
    // The narrow tier's spine is 7 and the same step still fits three lanes.
    expect(depLanes(7, 3)).toEqual([7, 5, 3]);
  });

  it('shrinks the step rather than running lines off the left of the gutter', () => {
    // 12 down to the 2px floor is 10px of room; eleven lanes need 1px each.
    expect(depLanes(12, 11)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    const many = depLanes(12, 40);
    expect(Math.min(...many)).toBe(2);
    // Still distinct, which is the property the nesting depends on.
    expect(new Set(many).size).toBe(40);
    // Positive control: at a count the 2px step does fit, the step IS 2.
    expect(depLanes(12, 3)).toEqual([12, 10, 8]);
  });
});

describe('depCurves lanes', () => {
  const many: DepRowBox[] = rows('a', 'b', 'c', 'd', 'e', 'f', 'g');

  it('gives every line in a band its own x, nearest target rightmost', () => {
    const out = depCurves(
      many,
      ['b', 'c', 'd', 'e', 'f', 'g'].map((to) => ({ from: 'a', to })),
      GUTTER,
    );
    expect(out.map((c) => laneOf(c.d))).toEqual([12, 10, 8, 6, 4, 2]);
    expect(new Set(out.map((c) => c.laneX)).size).toBe(6);
    // The lanes move and nothing else does: every curve still leaves and
    // re-enters the rows at the SAME edgeX, so the ends stay in a column and
    // only the horizontal run into each row grows. That is what makes the set
    // read as nested brackets rather than a fan.
    expect(out.every((c) => c.d.startsWith('M 31 '))).toBe(true);
    expect(out.every((c) => /\s31\s[\d.]+$/.test(c.d))).toBe(true);
  });

  it('ranks by reach, not by the order the edges arrive in', () => {
    const out = depCurves(
      many,
      ['g', 'b'].map((to) => ({ from: 'a', to })),
      GUTTER,
    );
    // Asked for the long edge first; the array comes back in that order so the
    // caller's paint order is untouched, but the SHORT edge holds lane 0.
    expect(out.map((c) => c.to)).toEqual(['g', 'b']);
    expect(out.map((c) => c.laneX)).toEqual([10, 12]);
  });

  it('does not spend a lane on an edge it never draws', () => {
    const out = depCurves(
      many,
      [
        { from: 'elsewhere', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'a', to: 'd' },
      ],
      GUTTER,
    );
    // Two drawn edges, so two lanes — the dropped one must not leave a gap
    // that pushes both of these one step further left.
    expect(out.map((c) => c.laneX)).toEqual([12, 10]);
  });

  it('leaves a band with a single blocker pixel-identical to before the nesting', () => {
    const [curve] = depCurves(rows('a', 'b'), [{ from: 'a', to: 'b' }], GUTTER);
    expect(curve?.d).toBe('M 31 20 C 22 20 12 20 12 30 L 12 50 C 12 60 22 60 31 60');
  });
});
