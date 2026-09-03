/**
 * Word's balloon stacking: each balloon wants to sit at its own anchorY.
 * Sorted by anchorY (stable for ties, so equal anchors keep input order),
 * each balloon is pushed down only as far as needed to clear the previous
 * balloon's bottom edge plus `gap` — minimal displacement, never above the
 * anchor of the first (topmost-anchored) balloon.
 *
 * With a `viewport`, balloons anchored at or above `viewport.bottom` are
 * additionally lifted just enough that their bottom edge (the composer and
 * its Answer button) stays inside the fold — cascading upward through the
 * stack when neighbours are in the way, but never lifting a balloon above
 * `viewport.top` and never moving one that already sits above it. Balloons
 * anchored below the fold are off-screen content and keep anchor placement.
 * When the stack simply cannot fit, the top of it pins at `viewport.top`
 * and the remainder overflows downward as before.
 *
 * The returned array is index-aligned with `items`: result[i] is the y for
 * items[i], regardless of anchor order in the input.
 */
export interface BalloonViewport {
  /** Content-space y of the visible region's top edge. */
  top: number;
  /** Content-space y of the visible region's bottom edge. */
  bottom: number;
}

export function layoutBalloons(
  items: Array<{ anchorY: number; height: number }>,
  gap: number,
  viewport?: BalloonViewport,
): number[] {
  const order = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.anchorY - b.item.anchorY);

  const result = new Array<number>(items.length);
  let prevBottom = Number.NEGATIVE_INFINITY;

  for (const { item, index } of order) {
    const y =
      prevBottom === Number.NEGATIVE_INFINITY
        ? item.anchorY
        : Math.max(item.anchorY, prevBottom + gap);
    result[index] = y;
    prevBottom = y + item.height;
  }

  if (!viewport) return result;

  // Backward lift pass: walking up from the fold, each in-viewport balloon
  // drops to the lower of its pushed-down position and the ceiling left by
  // the balloon below it. min() means a balloon that already fits does not
  // move; the floor means a balloon is never lifted above the viewport top,
  // and one already above it stays put.
  let ceiling = viewport.bottom;
  for (let i = order.length - 1; i >= 0; i--) {
    const { item, index } = order[i];
    if (item.anchorY > viewport.bottom) continue;
    const y = result[index];
    const lifted = Math.min(y, ceiling - item.height);
    result[index] = Math.max(lifted, Math.min(y, viewport.top));
    ceiling = result[index] - gap;
  }

  // The lift both frees room (a balloon pushed down by a since-lifted
  // neighbour belongs back at its anchor) and, where the floor stopped it,
  // leaves overlap — one more push-down pass from each balloon's new desired
  // position settles both.
  prevBottom = Number.NEGATIVE_INFINITY;
  for (const { item, index } of order) {
    const desired = Math.min(item.anchorY, result[index]);
    const y =
      prevBottom === Number.NEGATIVE_INFINITY ? desired : Math.max(desired, prevBottom + gap);
    result[index] = y;
    prevBottom = y + item.height;
  }

  return result;
}
