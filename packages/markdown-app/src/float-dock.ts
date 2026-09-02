/**
 * The one row of floating controls at the bottom of the editor pane.
 *
 * Two floats live there on a huddle doc — Make Plan (plan-gate.ts) and
 * Review (review-float.ts) — and each used to pin itself to the pane's
 * centre on its own, which two centred buttons cannot both do. The dock is
 * the flex row they share: whichever mounts first creates it, the other
 * finds it, and the stylesheet places the ROW rather than either button.
 * Order in the row is mount order, which app.ts keeps as plan, then review.
 */
export function floatDock(anchor: Element): HTMLElement {
  for (const child of Array.from(anchor.children)) {
    if (child instanceof HTMLElement && child.classList.contains('doc-floats')) return child;
  }
  const dock = document.createElement('div');
  dock.className = 'doc-floats';
  anchor.append(dock);
  return dock;
}
