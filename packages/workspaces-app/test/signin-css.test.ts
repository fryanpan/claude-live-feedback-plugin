import { afterEach, describe, expect, it } from 'vitest';
import {
  IPAD,
  PHONE,
  type SheetName,
  attach,
  installSheets,
  setViewport,
  styleOf,
} from './css-harness.ts';

/**
 * The sign-in page's layout promises, read off the cascade rather than out of
 * three stylesheets' text.
 *
 * The mockup's two hard viewport constraints: every state fits iPad
 * landscape's ~750px usable height without scrolling (the card is a single
 * short column, centered), and the six code boxes plus their gaps fit 430px
 * minus page padding (46px boxes shrink to 40px under 480px:
 * 6×40 + 5×6 = 270px, well inside 430 − 32 of padding). How it LOOKS at
 * 1180x820 and 430px is a browser check; see the PR report.
 *
 * THREE PAGES, THREE CASCADES, and that is why the sheets are installed per
 * test rather than once. `renderSigninShell` loads styles.css then signin.css
 * then tokens.css; `renderBoardShell` loads board.css, styles.css, tokens.css and
 * never signin.css; an attachment loads neither of the two page sheets.
 * Installing exactly the sheets a page loads is also what replaces the old
 * "which file is this rule in?" text assertions: a rule that moved into the
 * shared sheet shows up as a value the OTHER page can now see.
 *
 * tokens.css is left out of all three. The served /app/tokens.css is the
 * vendored Open Props subset concatenated with src/tokens.css, and installing
 * the mapping layer alone resolves its `var(--gray-9)` chain to nothing —
 * which would blank the colours compared below. tokens-css.test.ts installs
 * the pair.
 */

let cleanup = () => {};
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.body.className = '';
});

/** Install the sheets one page loads, in that page's order. */
function page(...sheets: SheetName[]): void {
  cleanup();
  cleanup = installSheets(...sheets);
}

const SIGNIN: SheetName[] = ['styles.css', 'signin.css'];
const BOARD: SheetName[] = ['board.css', 'styles.css'];

describe('sign-in page css', () => {
  it('centers a fluid card', () => {
    page(...SIGNIN);
    setViewport(IPAD);
    document.body.className = 'signin-body';
    const body = styleOf(document.body);
    expect(body.display).toBe('flex');
    expect(body.justifyContent).toBe('center');
    expect(body.minHeight).toBe('100dvh');
    // NOT asserted, and dropped from the text version: the card's own
    // `width: min(380px, 100%)`. happy-dom returns '' for any `width` built
    // from `min()`/`calc()`/`var()`, so there is nothing to read — `bun run
    // ui:shot` owns the card's measure. What IS readable is that the card
    // rule reaches the element at all.
    expect(styleOf(attach('signin-card')).textAlign).toBe('center');
  });

  it('sizes the code boxes per the mockup and shrinks them under 480px', () => {
    page(...SIGNIN);
    const box = (viewport: { width: number; height: number }) => {
      setViewport(viewport);
      return styleOf(attach('', { tag: 'input', parent: attach('signin-code') }));
    };
    const wide = box(IPAD);
    expect(wide.width).toBe('46px');
    expect(wide.height).toBe('56px');
    // Under 480px the boxes shrink so six of them plus five gaps clear a
    // 430px screen. Measured at the phone this project verifies rather than
    // at the breakpoint, and measured rather than matched: the block is one
    // of several at this width, and a text search cannot say which one wins.
    const narrow = box(PHONE);
    expect(narrow.width).toBe('40px');
    expect(narrow.height).toBe('50px');
    expect(6 * Number.parseFloat(narrow.width) + 5 * 6).toBeLessThanOrEqual(PHONE.width - 32);
  });

  it('keeps inputs at 16px so iOS Safari does not zoom on focus', () => {
    page(...SIGNIN);
    setViewport(PHONE);
    const form = attach('signin-form');
    for (const type of ['email', 'text']) {
      const input = attach('', { tag: 'input', parent: form, attrs: { type } });
      expect(styleOf(input).fontSize, type).toBe('16px');
    }
  });

  it('lives in the sign-in page’s own stylesheet, not at the tail of a shared one', () => {
    // What this used to assert — "filed under a banner, not appended at EOF" —
    // the split now settles by construction: these rules are a file the sign-in
    // shell loads and no other page does. What can still go wrong is a rule
    // added to the shared sheet instead, and that is measurable: install the
    // shared sheet ALONE and the sign-in card must reach nothing.
    setViewport(IPAD);
    page('styles.css');
    expect(styleOf(attach('signin-card')).textAlign).toBe('');
    // Control: styles.css did install — the identity prompt stayed behind in
    // it, and that is deliberate. The board and the editor both raise the
    // prompt, and sign-in never does.
    expect(styleOf(attach('identity-prompt')).position).toBe('fixed');
    // The other direction: signin.css alone carries the card and NOT the
    // prompt, so neither file has quietly absorbed the other's section.
    page('signin.css');
    expect(styleOf(attach('signin-card')).textAlign).toBe('center');
    expect(styleOf(attach('identity-prompt')).position).toBe('');
  });

  it('gives the board identity chip a popover anchored like the settings panel', () => {
    page(...BOARD);
    setViewport(IPAD);
    const menu = styleOf(attach('board-me-menu'));
    expect(menu.position).toBe('absolute');
    expect(menu.right).toBe('0px');
  });

  it('keeps the identity chip at the 36px tap-target floor (design-mobile.md)', () => {
    // The chip is the sole sign-in entry point, and it is tapped on an iPad.
    page(...BOARD);
    setViewport(IPAD);
    const chip = styleOf(attach('board-me', { tag: 'button' }));
    expect(chip.width).toBe('36px');
    expect(chip.height).toBe('36px');
  });

  it('makes the read-only notice a layout row, not an overlay', () => {
    // It shipped as one `position: fixed` box offset by the doc topbar's
    // measured height. On the board there is no `#topbar` to measure, so the
    // fallback constant put it on the action row and "Start a planning
    // huddle" could not be clicked at all; at 430px on the doc it covered the
    // H1 and the format bar. A fixed box over a page covers something at some
    // width — taking space is the fix, not finding a band that looks free.
    page(...SIGNIN);
    setViewport(PHONE);
    const bar = styleOf(attach('signin-bar'));
    expect(bar.position).not.toBe('fixed');
    expect(bar.display).toBe('flex');
    // The doc shell declares its own rows, so the bar's row has to be
    // declared too — otherwise it lands inside the topbar's 48px and clips.
    // Four tracks: the bar, the topbar, the meeting strip's auto row, the doc.
    document.body.className = 'signin-gated';
    expect(styleOf(attach('', { attrs: { id: 'shell' } })).gridTemplateRows).toBe(
      'auto 48px auto 1fr',
    );
    // The fallback for a surface with no header still floats, and docks to
    // the bottom rather than to the band the doc title lives in — an unset
    // `top` is what "not the top band" computes to.
    const floating = styleOf(attach('signin-bar signin-bar--floating'));
    expect(floating.position).toBe('fixed');
    expect(floating.top).toBe('');
    expect(floating.zIndex).toBe('900');
    // NOT asserted: the `bottom` itself. It is `calc(12px + var(--safe-bottom,
    // 0px))`, and happy-dom returns '' for a calc() carrying a var() — the
    // same limitation that costs this file the card's width.
  });

  it('makes a control the write gate disabled LOOK disabled', () => {
    // Both gated toggles were pixel-identical to the live control beside
    // them: opacity 1, cursor pointer. A `title` is not the substitute — the
    // primary device here is an iPad, where nothing hovers.
    page(...BOARD);
    setViewport(IPAD);
    for (const cls of ['icon-btn', 'board-btn']) {
      const off = styleOf(attach(cls, { tag: 'button', attrs: { disabled: '' } }));
      expect(off.opacity, cls).toBe('0.35');
      expect(off.cursor, cls).toBe('default');
      // Control: the same class NOT disabled reads as the live control, so
      // the two values above belong to `:disabled` and not to the base rule.
      const on = styleOf(attach(cls, { tag: 'button' }));
      expect(on.opacity === '' || on.opacity === '1', cls).toBe(true);
      expect(on.cursor, cls).toBe('pointer');
    }
    // A pressed toggle that is disabled keeps the unpressed surface, so the
    // gate does not read as "on". This is where the convention at
    // `.comment-nav:disabled` stopped and these two needed more.
    const pressed = attach('icon-btn', {
      tag: 'button',
      attrs: { disabled: '', 'aria-pressed': 'true' },
    });
    expect(styleOf(pressed).backgroundColor).toBe(
      styleOf(document.documentElement).getPropertyValue('--bg').trim(),
    );
    // NOT asserted, and dropped from the text version: the `:disabled:hover`
    // rule that stops the control lighting up under a pointer. happy-dom has
    // no pointer, so `:hover` cannot be entered — `bun run ui:shot` owns it.
  });
});
