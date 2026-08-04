/**
 * Word's balloon stacking: each balloon wants to sit at its own anchorY.
 * Sorted by anchorY (stable for ties, so equal anchors keep input order),
 * each balloon is pushed down only as far as needed to clear the previous
 * balloon's bottom edge plus `gap` — minimal displacement, never above the
 * anchor of the first (topmost-anchored) balloon.
 *
 * The returned array is index-aligned with `items`: result[i] is the y for
 * items[i], regardless of anchor order in the input.
 */
export function layoutBalloons(
  items: Array<{ anchorY: number; height: number }>,
  gap: number,
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

  return result;
}
