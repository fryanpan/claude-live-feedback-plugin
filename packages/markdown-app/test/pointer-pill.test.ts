/**
 * The pointer pill (src/pointer-pill.ts): two actions above the point where
 * a selection was let go.
 *
 * The placement is a pure function over boxes, so it is tested as one — every
 * rule in the fallback chain, with the case that forces it. What a browser
 * actually draws at 1180×820 and 430px is measured over CDP and reported
 * with the PR; happy-dom resolves no layout, so the DOM half here only checks
 * that the pill is built from real buttons, shows what `place` said, and
 * stays in the document when hidden.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Box,
  MOUSE_GAP,
  type PillAnchor,
  TOUCH_GAP,
  mountPointerPill,
  placePointerPill,
} from '../src/pointer-pill.ts';

const SIZE = { w: 200, h: 40 };
/** A roomy editor box: nothing is forced anywhere unless a test says so. */
const BOUNDS: Box = { left: 0, top: 0, right: 1000, bottom: 800 };
const box = (left: number, top: number, right: number, bottom: number): Box => ({
  left,
  top,
  right,
  bottom,
});
const mouse = (x: number, y: number): PillAnchor => ({ x, y, touch: false });
const touch = (x: number, y: number): PillAnchor => ({ x, y, touch: true });

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
function inside(r: Box, b: Box): boolean {
  return r.left >= b.left && r.top >= b.top && r.right <= b.right && r.bottom <= b.bottom;
}

describe('placePointerPill — above the anchor', () => {
  it('clears a fingertip by 44px and a mouse by 12px', () => {
    // One line, released at its end, nothing in the way.
    const line = box(100, 400, 500, 420);
    const t = placePointerPill(SIZE, touch(480, 415), [line], BOUNDS);
    expect(t.rule).toBe('above');
    expect(t.gap).toBe(TOUCH_GAP);
    expect(415 - t.rect.bottom).toBeGreaterThanOrEqual(44);
    const m = placePointerPill(SIZE, mouse(480, 415), [line], BOUNDS);
    expect(m.rule).toBe('above');
    expect(m.gap).toBe(MOUSE_GAP);
    expect(415 - m.rect.bottom).toBeGreaterThanOrEqual(12);
    // …and the mouse pill sits closer, since that is the point of the two numbers.
    expect(m.rect.bottom).toBeGreaterThan(t.rect.bottom);
  });

  it('centres on the anchor and points the arrow at it', () => {
    const p = placePointerPill(SIZE, mouse(480, 415), [box(100, 400, 500, 420)], BOUNDS);
    expect(p.rect.left).toBe(480 - SIZE.w / 2);
    expect(p.arrowX).toBe(SIZE.w / 2);
  });

  it('is lifted clear of a multi-line selection released on its LAST line', () => {
    // Three lines; the 12px mouse gap alone would leave the pill over the
    // first two. The selection is what the person is looking at.
    const lines = [box(100, 300, 600, 320), box(100, 324, 600, 344), box(100, 348, 400, 368)];
    const p = placePointerPill(SIZE, mouse(380, 360), lines, BOUNDS);
    expect(p.rule).toBe('above');
    for (const l of lines) expect(overlaps(p.rect, l)).toBe(false);
    expect(p.rect.bottom).toBeLessThanOrEqual(300 - 8);
  });

  it('ignores zero-area rects instead of dodging them', () => {
    // A collapsed line box at the top of the page would otherwise drag the
    // pill up to clear nothing.
    const ghost = box(100, 10, 100, 10);
    const line = box(100, 400, 500, 420);
    const p = placePointerPill(SIZE, mouse(480, 415), [ghost, line], BOUNDS);
    expect(p.rule).toBe('above');
    // Lifted clear of the real line (the release was inside it), and no
    // further: the ghost at y=10 moved nothing.
    expect(p.rect.bottom).toBe(line.top - 8);
    expect(p).toEqual(placePointerPill(SIZE, mouse(480, 415), [line], BOUNDS));
  });

  it('keeps the pill inside the editor sideways and slides the arrow with it', () => {
    // Released 10px from the left edge: centring would run off the box.
    const p = placePointerPill(SIZE, mouse(10, 415), [box(6, 400, 300, 420)], BOUNDS);
    expect(p.rule).toBe('above');
    expect(p.rect.left).toBe(BOUNDS.left);
    // The arrow still points at the anchor, but never into the rounded end.
    expect(p.arrowX).toBe(14);
    const q = placePointerPill(SIZE, mouse(995, 415), [box(700, 400, 994, 420)], BOUNDS);
    expect(q.rect.right).toBe(BOUNDS.right);
    expect(q.arrowX).toBe(SIZE.w - 14);
  });
});

describe('placePointerPill — the fallback chain', () => {
  /** A selection on the first line of the editor: nothing fits above it. */
  const topLine = box(100, 6, 500, 26);

  it('goes beside the anchor, right first, when the top edge blocks above', () => {
    // Released at the line's END, so the space to the right is free.
    const p = placePointerPill(SIZE, touch(500, 20), [topLine], BOUNDS);
    expect(p.rule).toBe('beside-right');
    expect(p.arrowX).toBeNull();
    expect(p.rect.left).toBeGreaterThanOrEqual(500 + 44);
    expect(inside(p.rect, BOUNDS)).toBe(true);
    expect(overlaps(p.rect, topLine)).toBe(false);
  });

  it('goes beside-left when the selection itself blocks beside-right', () => {
    // A backwards drag: released at the line's START, with the selected
    // words running right from there — beside-right would sit on them.
    const wide = box(400, 6, 990, 26);
    const p = placePointerPill(SIZE, mouse(400, 20), [wide], BOUNDS);
    expect(p.rule).toBe('beside-left');
    expect(p.rect.right).toBeLessThanOrEqual(400 - 20);
    expect(inside(p.rect, BOUNDS)).toBe(true);
    expect(overlaps(p.rect, wide)).toBe(false);
  });

  it('goes below the selection when neither side has room', () => {
    // A narrow editor (a phone) with a full-width top line.
    const narrow: Box = { left: 0, top: 0, right: 430, bottom: 900 };
    const full = box(6, 6, 424, 26);
    const p = placePointerPill(SIZE, touch(215, 20), [full], narrow);
    expect(p.rule).toBe('below');
    expect(p.rect.top).toBeGreaterThanOrEqual(26 + 8);
    expect(inside(p.rect, narrow)).toBe(true);
  });

  it('pins to the bottom of the box as the last resort, still off the finger', () => {
    // A box shorter than the pill needs everywhere: above blocked, no side
    // room, and below runs out of the box too.
    const tiny: Box = { left: 0, top: 0, right: 430, bottom: 60 };
    const full = box(6, 6, 424, 26);
    const p = placePointerPill(SIZE, touch(215, 20), [full], tiny);
    expect(p.rule).toBe('pinned-bottom');
    expect(p.rect.bottom).toBe(60);
    expect(p.arrowX).toBeNull();
  });

  it('never covers any line of the selection on any rule', () => {
    const lines = [box(100, 6, 900, 26), box(100, 30, 900, 50), box(100, 54, 500, 74)];
    for (const anchor of [touch(480, 70), mouse(120, 40), touch(890, 10), mouse(500, 60)]) {
      const p = placePointerPill(SIZE, anchor, lines, BOUNDS);
      for (const l of lines)
        expect(overlaps(p.rect, l), `${p.rule} @${anchor.x},${anchor.y}`).toBe(false);
      expect(inside(p.rect, BOUNDS)).toBe(true);
    }
  });
});

describe('mountPointerPill', () => {
  const ACTIONS = [
    { id: 'research', label: 'Research' },
    { id: 'task', label: 'Create Task' },
  ] as const;
  beforeEach(() => document.body.replaceChildren());

  function buttons(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll<HTMLButtonElement>('.pointer-pill-btn'));
  }

  it('is exactly the two text buttons, hidden until placed', () => {
    const pill = mountPointerPill({ actions: ACTIONS, onPick: () => {} });
    expect(pill.hidden).toBe(true);
    expect(pill.el.getAttribute('role')).toBe('toolbar');
    expect(buttons().map((b) => b.textContent)).toEqual(['Research', 'Create Task']);
    for (const b of buttons()) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.children, 'a label is text, never markup').toHaveLength(0);
    }
    // No hamburger, no icons, no other rows — the pill's children ARE the buttons.
    expect(pill.el.children).toHaveLength(2);
    pill.destroy();
  });

  it('shows where the placement says, with the arrow only when above', () => {
    const pill = mountPointerPill({ actions: ACTIONS, onPick: () => {} });
    // happy-dom measures nothing; the fallback size is what gets placed.
    const above = pill.show(mouse(480, 415), [box(100, 400, 500, 420)], BOUNDS);
    expect(pill.hidden).toBe(false);
    expect(above.rule).toBe('above');
    expect(pill.el.dataset.rule).toBe('above');
    expect(pill.el.style.left).toBe(`${Math.round(above.rect.left)}px`);
    expect(pill.el.style.top).toBe(`${Math.round(above.rect.top)}px`);
    expect(pill.el.classList.contains('no-arrow')).toBe(false);
    expect(pill.el.style.getPropertyValue('--arrow-x')).toMatch(/px$/);

    const beside = pill.show(touch(500, 20), [box(100, 6, 500, 26)], BOUNDS);
    expect(beside.rule).toBe('beside-right');
    expect(pill.el.classList.contains('no-arrow')).toBe(true);
    pill.destroy();
  });

  it('reports the tapped action, and a hidden pill reports nothing', () => {
    const onPick = vi.fn();
    const pill = mountPointerPill({ actions: ACTIONS, onPick });
    pill.show(mouse(480, 415), [box(100, 400, 500, 420)], BOUNDS);
    buttons()[1]?.click();
    expect(onPick).toHaveBeenCalledWith('task');
    pill.hide();
    // Hidden keeps the element (opacity 0, no pointer events) so a tap that
    // blurred the editor first still has an element to land on — but a
    // click that somehow reaches a hidden pill is not a pick.
    expect(document.querySelector('.pointer-pill')).not.toBeNull();
    buttons()[0]?.click();
    expect(onPick).toHaveBeenCalledTimes(1);
    pill.destroy();
  });

  it('hides on Escape and says so; a destroyed pill hears nothing', () => {
    const onDismiss = vi.fn();
    const pill = mountPointerPill({ actions: ACTIONS, onPick: () => {}, onDismiss });
    pill.show(mouse(480, 415), [box(100, 400, 500, 420)], BOUNDS);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(pill.hidden).toBe(true);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    // Already hidden: Escape is somebody else's.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    pill.destroy();
    expect(document.querySelector('.pointer-pill')).toBeNull();
    pill.show(mouse(480, 415), [box(100, 400, 500, 420)], BOUNDS);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(() => pill.destroy()).not.toThrow();
  });
});
