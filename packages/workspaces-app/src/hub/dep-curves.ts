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
 *
 * Every line in a band gets its OWN vertical, because a band with several
 * blockers drew them all down the same x and the result was unreadable: two
 * curves overlapped for their whole length and there was no way to tell which
 * blocker fed which waiting row (Bryan, 2026-09-04). The lanes nest by how
 * far the edge reaches — the shortest edge keeps the rightmost vertical and
 * each longer one steps left — so the lines read as a set of nested brackets
 * and a reader can follow any one of them by its own x. The step stays inside
 * the gutter the rows already leave empty, so nothing on the board moves.
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
  /** The x of this line's own vertical — its lane. Distinct from every other
   *  curve's in the same band, which is the whole point of the nesting. */
  laneX: number;
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

/** How far left each further lane steps. Bryan asked for "1-2px more to the
 *  left for each line"; 2 is the readable end of that range at the 1.5px
 *  stroke the curves are drawn with. */
const LANE_STEP = 2;

/** The leftmost x a lane may sit at. Half the stroke is 0.75, so 2 leaves the
 *  outermost line fully inside the gutter rather than clipped by its edge. */
const LANE_MIN_X = 2;

/**
 * The `count` lane x's for one band, rightmost first.
 *
 * Lane 0 is the gutter's own spine — the x a single line has always used, so
 * a band with one blocker is pixel-identical to before — and each further
 * lane steps `LANE_STEP` left of the one before it.
 *
 * The step shrinks rather than the lanes running off the canvas: a band with
 * enough edges to need more room than the gutter has spreads them evenly
 * across what there is. Every returned x is still distinct, which is the
 * property the nesting depends on.
 */
export function depLanes(spineX: number, count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [round(spineX)];
  const room = Math.max(0, spineX - LANE_MIN_X);
  const step = Math.min(LANE_STEP, room / (count - 1));
  return Array.from({ length: count }, (_, i) => round(spineX - i * step));
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

  // Which edges are actually drawable, and how far each one reaches. The
  // undrawable ones are dropped BEFORE lanes are handed out: an edge to
  // another goal must not spend a lane and leave a gap in the nesting.
  const drawable = edges.flatMap((edge) => {
    const src = byId.get(edge.from);
    const dst = byId.get(edge.to);
    if (!src || !dst || src === dst) return [];
    const y1 = centre(src);
    const y2 = centre(dst);
    if (y2 - y1 === 0) return [];
    return [{ edge, y1, y2, reach: Math.abs(y2 - y1) }];
  });

  // Lanes by reach, shortest first. Ranked rather than sorted in place, so
  // the curves come back in the order they were asked for and only their x
  // changes: the caller paints them in DOM order and a reordered array would
  // silently restack them. Ties break on the original index, so the same band
  // paints the same way twice.
  const lanes = depLanes(spineX, drawable.length);
  const rank = drawable
    .map((d, i) => ({ i, reach: d.reach }))
    .sort((a, b) => a.reach - b.reach || a.i - b.i);
  const laneOf = new Array<number>(drawable.length);
  rank.forEach((r, lane) => {
    laneOf[r.i] = lanes[lane] ?? spineX;
  });

  return drawable.map(({ edge, y1, y2 }, i) => {
    const laneX = laneOf[i] ?? spineX;
    const sign = y2 - y1 > 0 ? 1 : -1;
    const r = round(Math.min(10, Math.abs(y2 - y1) / 2));
    return {
      from: edge.from,
      to: edge.to,
      laneX,
      d: [
        'M',
        edgeX,
        y1,
        'C',
        round(laneX + 10),
        y1,
        laneX,
        y1,
        laneX,
        round(y1 + r * sign),
        'L',
        laneX,
        round(y2 - r * sign),
        'C',
        laneX,
        y2,
        round(laneX + 10),
        y2,
        edgeX,
        y2,
      ].join(' '),
      head: `M ${edgeX} ${y2} L ${round(edgeX - 5)} ${round(y2 - 3.5)} L ${round(edgeX - 5)} ${round(y2 + 3.5)} Z`,
    };
  });
}
