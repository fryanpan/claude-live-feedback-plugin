/**
 * How much of the window the on-screen keyboard is covering, published as
 * `--kb-bottom` for anything docked to the bottom to rise by.
 *
 * iOS puts `position: fixed` elements on the LAYOUT viewport, which does not
 * shrink when the keyboard appears — so a control at `bottom: 16px`, or a
 * panel sized in `vh`, ends up behind it. The visual viewport is the one that
 * moves; this watches it and writes the difference where CSS can read it.
 *
 * It lives in its own module because BOTH entry points need it and only one
 * had it. `app.ts` (the doc surface) has published this since the composer
 * first went under the keyboard; the hub — board, Home, the task panel — is a
 * separate entry and inherited none of it, which is how the task panel's
 * Comment button ended up under the bar with no scroll left to reach it.
 */

/** iOS floats a form-accessory bar (^ v Done) ABOVE the keyboard whenever a
 *  text field is focused, and `visualViewport.height` excludes the keyboard
 *  but not that bar — so a control lifted by the raw difference is still
 *  under it. With a hardware keyboard attached this bar is the whole of what
 *  covers the screen: no keyboard, still a bar. */
export const IOS_ACCESSORY = 46;

/** The visual-viewport facts this needs — narrower than the DOM type so a
 *  test can hand it two numbers. */
export interface ViewportLike {
  height: number;
  offsetTop: number;
}

/** The inset, in CSS pixels. Zero means nothing is covering the bottom. */
export function keyboardInset(innerHeight: number, vv: ViewportLike | null): number {
  if (!vv) return 0;
  const kb = Math.max(0, innerHeight - vv.height - vv.offsetTop);
  return kb > 0 ? kb + IOS_ACCESSORY : 0;
}

/** Publish `--kb-bottom` now and on every viewport change. Idempotent: a
 *  second call re-registers listeners on the same element, which costs a
 *  duplicate write and nothing else. */
export function wireKeyboardInset(): void {
  const vv = window.visualViewport;
  const apply = () => {
    const px = keyboardInset(window.innerHeight, vv);
    document.documentElement.style.setProperty('--kb-bottom', `${px}px`);
  };
  apply();
  if (vv) {
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
  }
  window.addEventListener('orientationchange', () => setTimeout(apply, 120));
}
