/**
 * The pointer pill — Comment, Research and Create Task, hung off the point
 * where a selection was released.
 *
 * A selection on a huddle doc used to grow a round button at its far end
 * which opened a four-row menu, and the menu became a bottom sheet on a
 * phone. Bryan's round-4 call (2026-09-01) replaced all of that with one
 * thing: a pill of text buttons that sits just beside wherever the finger or
 * mouse LET GO. The actions are already where the hand stopped, on every
 * width, with no second tap to open anything and no sheet to reach for at
 * the bottom of the screen. Comment is one of them — the first cut carried
 * only the two spin-offs, and the owner expected the comment he can leave
 * everywhere else to still be there ("keep a comment option available, just
 * to the right of where I click", 2026-09-01).
 *
 * The placement is the whole component, so it is a pure function
 * (`placePointerPill`) over plain boxes, tested without a browser, and the
 * DOM half (`mountPointerPill`) only asks it where to go. In order:
 *
 *   1. BESIDE the anchor to its RIGHT, at the same height, clear of a
 *      fingertip (56px on touch, 20px for a mouse) — just to the right of
 *      where the hand let go, which is where the owner asked for it;
 *   2. else ABOVE the anchor, clear of the fingertip (44px on touch, 12px for
 *      a mouse) and lifted further if it would touch any line of the
 *      selection — the selection is what the person is looking at, and a
 *      pill over it hides the words it is about;
 *   3. else BESIDE the anchor to its left;
 *   4. else BELOW the selection's last line;
 *   5. else pinned to the bottom of the editor's visible box — still never
 *      under the finger, because the anchor is by then above it.
 *
 * Every candidate is clamped inside the editor's visible box, which the
 * caller hands in already cut down by the on-screen keyboard. A small arrow
 * on the pill's underside marks the release point when — and only when — the
 * pill actually sits above it; an arrow pointing at nothing is a lie.
 */

/** An axis-aligned box in viewport coordinates. `DOMRect` fits it. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where the selection was released, and by what. `touch` picks the gap:
 *  a fingertip covers ~44px of what it just touched; a mouse covers none. */
export interface PillAnchor {
  x: number;
  y: number;
  touch: boolean;
}

export type PillRule = 'above' | 'beside-right' | 'beside-left' | 'below' | 'pinned-bottom';

export interface PillPlacement {
  rect: Box;
  rule: PillRule;
  /** The clearance the anchor was given, sideways when beside it and
   *  vertical when above — reported so a test (or the debug readout) can
   *  check the number that was actually used. */
  gap: number;
  /** Where along the pill's width the arrow points, in pixels from its left
   *  edge; `null` when the pill is not above the anchor and shows no arrow. */
  arrowX: number | null;
}

/** Clearance between the anchor and the pill's bottom edge, when above. */
export const TOUCH_GAP = 44;
export const MOUSE_GAP = 12;
/** Clearance between the anchor and the pill's near edge, when beside. */
export const TOUCH_SIDE_GAP = 56;
export const MOUSE_SIDE_GAP = 20;
/** Breathing room between the pill and any line of the selection. */
const SELECTION_CLEAR = 8;
/** The arrow never sits inside the pill's rounded end. */
const ARROW_INSET = 14;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

function intersects(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function intersectsAny(r: Box, rects: readonly Box[]): boolean {
  return rects.some((b) => b.right > b.left && b.bottom > b.top && intersects(r, b));
}

/**
 * Where a pill of `size` goes for a selection released at `anchor`.
 *
 * `selRects` are the selection's own client rects (`Range.getClientRects`) —
 * one per line, and the pill must not cover any of them. `bounds` is the box
 * the pill must stay inside: the editor's visible area, above the keyboard.
 * Zero-area rects (a collapsed line box) are ignored rather than avoided.
 */
export function placePointerPill(
  size: { w: number; h: number },
  anchor: PillAnchor,
  selRects: readonly Box[],
  bounds: Box,
): PillPlacement {
  const { w, h } = size;
  const gap = anchor.touch ? TOUCH_GAP : MOUSE_GAP;
  const live = selRects.filter((r) => r.right > r.left && r.bottom > r.top);
  const minSelTop = live.length ? Math.min(...live.map((r) => r.top)) : anchor.y;
  const maxSelBottom = live.length ? Math.max(...live.map((r) => r.bottom)) : anchor.y;

  const mk = (left: number, top: number): Box => ({ left, top, right: left + w, bottom: top + h });
  const centred = clamp(anchor.x - w / 2, bounds.left, bounds.right - w);

  // 1 · beside the anchor, to its right, at the same height. A finger is
  // wider than a cursor, and a pill that starts under it is a pill that gets
  // pressed by accident on release.
  const sideGap = anchor.touch ? TOUCH_SIDE_GAP : MOUSE_SIDE_GAP;
  const sideTop = clamp(anchor.y - h / 2, bounds.top, bounds.bottom - h);
  const right = mk(anchor.x + sideGap, sideTop);
  if (right.right <= bounds.right && !intersectsAny(right, live)) {
    return { rect: right, rule: 'beside-right', gap: sideGap, arrowX: null };
  }

  // 2 · above the anchor, lifted clear of the selection's top line.
  let bottom = anchor.y - gap;
  let above = mk(centred, bottom - h);
  if (intersectsAny(above, live)) {
    bottom = Math.min(bottom, minSelTop - SELECTION_CLEAR);
    above = mk(centred, bottom - h);
  }
  if (above.top >= bounds.top && !intersectsAny(above, live)) {
    return {
      rect: above,
      rule: 'above',
      gap,
      arrowX: clamp(anchor.x - above.left, ARROW_INSET, w - ARROW_INSET),
    };
  }

  // 3 · beside the anchor to its left.
  const left = mk(anchor.x - sideGap - w, sideTop);
  if (left.left >= bounds.left && !intersectsAny(left, live)) {
    return { rect: left, rule: 'beside-left', gap: sideGap, arrowX: null };
  }

  // 4 · below the selection's last line.
  const below = mk(centred, maxSelBottom + SELECTION_CLEAR);
  if (below.bottom <= bounds.bottom) {
    return { rect: below, rule: 'below', gap, arrowX: null };
  }

  // 5 · pinned to the bottom of the visible box.
  return { rect: mk(centred, bounds.bottom - h), rule: 'pinned-bottom', gap, arrowX: null };
}

export interface PointerPillAction<Id extends string = string> {
  id: Id;
  label: string;
  /** Drawn in the accent: the one action the pill is mostly for. The first
   *  action is primary when none says so. */
  primary?: boolean;
}

export interface PointerPillOpts<Id extends string> {
  actions: readonly PointerPillAction<Id>[];
  onPick: (action: Id) => void;
  /** Escape. Hiding for any other reason is the caller's call, since the
   *  caller is the one watching the selection. */
  onDismiss?: () => void;
  /** Defaults to the document body: the pill is `position: fixed`, and no
   *  `overflow: hidden` in the editor's layout may clip it. */
  root?: HTMLElement;
  /** What the toolbar is called for a screen reader. */
  ariaLabel?: string;
}

export interface PointerPillHandle {
  readonly el: HTMLElement;
  /** Place the pill for this release point and selection, and show it.
   *  Re-called on every scroll or resize with fresh rects. */
  show(anchor: PillAnchor, selRects: readonly Box[], bounds: Box): PillPlacement;
  /** Hide WITHOUT removing: a tap on the pill blurs the editor first on
   *  iOS, and the click still has to land on an element that exists. */
  hide(): void;
  readonly hidden: boolean;
  destroy(): void;
}

/**
 * Build the pill once per editor mount. It starts hidden; `show` places it.
 */
export function mountPointerPill<Id extends string>(opts: PointerPillOpts<Id>): PointerPillHandle {
  const root = opts.root ?? document.body;
  let live = true;

  const el = document.createElement('div');
  el.className = 'pointer-pill hidden no-arrow';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', opts.ariaLabel ?? 'Turn this line into work');

  const flagged = opts.actions.some((a) => a.primary === true);
  for (const [i, action] of opts.actions.entries()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    const primary = flagged ? action.primary === true : i === 0;
    btn.className = primary ? 'pointer-pill-btn primary' : 'pointer-pill-btn';
    btn.dataset.action = action.id;
    // textContent, never innerHTML: the labels are ours today, and keeping
    // the builder markup-free is what keeps that true of whatever is added.
    btn.textContent = action.label;
    // On desktop the press would blur the editor before the click lands, and
    // the selection this pill is about goes with it. On iOS preventing the
    // touch cancels the synthetic click entirely — so only mousedown.
    btn.addEventListener('mousedown', (ev) => ev.preventDefault());
    btn.addEventListener('click', () => {
      if (!live || el.classList.contains('hidden')) return;
      opts.onPick(action.id);
    });
    el.append(btn);
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape' && !el.classList.contains('hidden')) {
      hide();
      opts.onDismiss?.();
    }
  }
  function hide(): void {
    el.classList.add('hidden');
  }
  function show(anchor: PillAnchor, selRects: readonly Box[], bounds: Box): PillPlacement {
    // Measure while still hidden — `.hidden` keeps the layout box, so the
    // width is real. A pill measured at 0 would be centred on nothing.
    const w = el.offsetWidth || 200;
    const h = el.offsetHeight || 40;
    const p = placePointerPill({ w, h }, anchor, selRects, bounds);
    el.style.left = `${Math.round(p.rect.left)}px`;
    el.style.top = `${Math.round(p.rect.top)}px`;
    el.dataset.rule = p.rule;
    if (p.arrowX !== null) {
      el.style.setProperty('--arrow-x', `${Math.round(p.arrowX)}px`);
      el.classList.remove('no-arrow');
    } else {
      el.classList.add('no-arrow');
    }
    el.classList.remove('hidden');
    return p;
  }

  root.append(el);
  document.addEventListener('keydown', onKeyDown);

  return {
    el,
    show,
    hide,
    get hidden() {
      return el.classList.contains('hidden');
    },
    destroy() {
      if (!live) return;
      live = false;
      document.removeEventListener('keydown', onKeyDown);
      el.remove();
    },
  };
}
