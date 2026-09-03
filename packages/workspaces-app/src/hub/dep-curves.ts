/**
 * The dependency curve: one `after` edge drawn in a goal band's left gutter.
 *
 * The board says a row is waiting by drawing the line to what it waits for,
 * and nothing beside the title says so. That rules out the obvious cheap
 * alternative — a vertical rail down the gutter with the blocked rows tucked
 * under it — which was drawn and rejected: a rail groups rows that have
 * nothing to do with each other, and it cannot say WHICH ticket is holding
 * this one.
 *
 * Two properties this geometry has to hold, and both are why the curve is
 * measured at paint rather than laid out in CSS:
 *
 *  - It reads the same whether the blocker sits ABOVE the waiting row or
 *    below it. The arrowhead always lands on the row that is waiting, so the
 *    line has one direction to read, and the corner radius flips sign with
 *    the vertical direction instead of the drawing flipping shape.
 *  - It survives a title wrapping to two lines, a band folding, and the
 *    switch to the narrow tier, because it is built from the rows' real
 *    boxes rather than from a row height someone typed in.
 *
 * Only same-band edges are drawn: an edge whose blocker is under another
 * goal has nowhere to land, and a line leaving the band would be a rail by
 * another name. Such a row is still Blocked — the ring says that — it simply
 * has no curve.
 */

/** One row's box, measured relative to the band's task container. */
export interface DepRowBox {
  id: string;
  /** Distance from the container's content-box top to the row's top. */
  top: number;
  height: number;
}

/** A drawn edge: `from` is the blocker, `to` is the row that is waiting. */
export interface DepEdge {
  from: string;
  to: string;
}

/** The gutter the curve is drawn in, in the same pixel space as the boxes. */
export interface DepGutter {
  /** Where the line meets the rows — just left of the status ring. */
  edgeX: number;
  /** The vertical the line runs along between the two rows. */
  spineX: number;
}

export interface DepCurve extends DepEdge {
  /** The `d` of the line itself. */
  d: string;
  /** The `d` of the arrowhead, which lands on the WAITING row. */
  head: string;
}

/** The gutter for a container whose left padding is `paddingLeft`. Kept here
 *  rather than in the caller so the numbers that decide the shape all live
 *  in one place; the narrow tier changes the padding and nothing else. */
export function depGutter(paddingLeft: number): DepGutter {
  const pad = Number.isFinite(paddingLeft) && paddingLeft > 0 ? paddingLeft : 34;
  return { edgeX: round(pad - 3), spineX: round(Math.max(7, pad - 22)) };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function centre(box: DepRowBox): number {
  return round(box.top + box.height / 2);
}

/**
 * The curves for one band.
 *
 * An edge naming a row that is not in this band is dropped, not drawn short:
 * a line to nowhere is worse than no line. Rows measuring zero (a folded
 * band, a hidden tab) yield nothing at all, because every centre would be the
 * same point and the band would fill with degenerate curves.
 */
export function depCurves(
  rows: readonly DepRowBox[],
  edges: readonly DepEdge[],
  gutter: DepGutter,
): DepCurve[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (rows.length === 0 || rows.every((r) => r.height === 0)) return [];
  const { edgeX, spineX } = gutter;
  const out: DepCurve[] = [];
  for (const edge of edges) {
    const src = byId.get(edge.from);
    const dst = byId.get(edge.to);
    if (!src || !dst || src === dst) continue;
    const y1 = centre(src);
    const y2 = centre(dst);
    const dy = y2 - y1;
    if (dy === 0) continue;
    const sign = dy > 0 ? 1 : -1;
    const r = round(Math.min(10, Math.abs(dy) / 2));
    out.push({
      from: edge.from,
      to: edge.to,
      d: [
        'M',
        edgeX,
        y1,
        'C',
        spineX + 10,
        y1,
        spineX,
        y1,
        spineX,
        round(y1 + r * sign),
        'L',
        spineX,
        round(y2 - r * sign),
        'C',
        spineX,
        y2,
        spineX + 10,
        y2,
        edgeX,
        y2,
      ].join(' '),
      head: `M ${edgeX} ${y2} L ${round(edgeX - 5)} ${round(y2 - 3.5)} L ${round(edgeX - 5)} ${round(y2 + 3.5)} Z`,
    });
  }
  return out;
}
