import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wireEditViewport } from '../src/edit-viewport.ts';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The stylesheet half of "editing on a phone is not broken": the meeting strip
 * yields its grid row while an editor has focus, and a RECORDING strip stays
 * on screen rather than disappearing.
 *
 * Both halves are read off the cascade here rather than out of `styles.css`'s
 * text. The old version searched the ≤720px block for a
 * `body[data-edit-viewport="hidden"] .meeting-strip { display: none }`
 * substring, which could not answer either of the questions that decide the
 * outcome: whether that block MATCHES at 430px, and whether anything later
 * un-does it. The sheet is installed and the strip is built at each viewport,
 * so what is asserted is the display value the browser would use — and the
 * "compact never hides" case is now measured on a real element instead of
 * inferred from a regex that no rule mentions.
 *
 * The yield is also driven end to end: `wireEditViewport` publishes the mode
 * and the strip element is checked for still being mounted and still not
 * `hidden`, which is the actual contract (`hidden` on the strip root already
 * means "no meeting surface is available here" — reusing it would let the
 * strip's own availability logic un-yield mid-edit, and would end a huddle's
 * only surface for the duration of a keystroke).
 *
 * NOT COVERED HERE, deliberately: `#editor`'s bottom padding, which is what
 * gives the LAST line of a document somewhere to scroll to under an open
 * keyboard (`max(160px, var(--kb-bottom, 0px))` — the larger of the resting
 * gap and the keyboard, never their sum). happy-dom does not implement
 * `max()`, and an unsupported function makes it drop the whole declaration, so
 * the computed padding comes back empty whatever the rule says. There is
 * nothing to assert that a deleted rule would not also satisfy. That property
 * is a browser check: measured rects at 430x932 and 1180x820 are in the PR
 * body, and `bun run ui:shot` is how it is re-measured.
 *
 * SHEETS: the review shell links `styles.css` then `doc.css` — the meeting
 * strip is one of the editor-only surfaces in the second, and the tokens and
 * the top bar it sits under are in the first (then `tokens.css`, left out
 * here — the served file is a vendored Open Props subset plus `src/tokens.css`,
 * and the mapping half alone re-points every remapped token at an undefined
 * `var(--gray-N)`).
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('styles.css', 'doc.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.body.removeAttribute('data-edit-viewport');
});

/** The strip's display at `vp` under a given yield mode, taken on the spot —
 *  happy-dom's computed style is live, so a held declaration re-answers after
 *  a viewport or attribute change. */
function stripDisplay(vp: { width: number; height: number }, mode: string | null): string {
  setViewport(vp);
  if (mode === null) document.body.removeAttribute('data-edit-viewport');
  else document.body.dataset.editViewport = mode;
  return styleOf(attach('meeting-strip')).display;
}

describe('the voice strip yields while an editor has focus', () => {
  it('hides an idle strip only under the phone breakpoint', () => {
    expect(stripDisplay(PHONE, 'hidden')).toBe('none');
    // Above the breakpoint the same attribute buys nothing: the complaint is a
    // phone complaint and the iPad pays for its 36px bar once.
    expect(stripDisplay(IPAD, 'hidden')).toBe('flex');
  });

  it('keeps a RECORDING strip on screen whole', () => {
    // `stripYield` publishes `compact` for a live strip, and since the top-bar
    // overhaul no rule consumes it: the strip is one 36px line fused under the
    // topbar, clear of the keyboard, and a live mic with no indicator is not a
    // thing to ship. Only `hidden` — the idle strip's yield — may reach
    // `display: none`.
    expect(stripDisplay(PHONE, 'compact')).toBe('flex');
    // Positive control, at the width and in the mode that DOES hide, so the
    // read above is discriminating rather than an empty stylesheet.
    expect(stripDisplay(PHONE, 'hidden')).toBe('none');
    expect(stripDisplay(PHONE, null)).toBe('flex');
  });

  it('yields in layout only — never by unmounting the strip or setting [hidden]', () => {
    // Driven through the real wiring rather than grepping `edit-viewport.ts`:
    // put a phone-width editor under a keyboard, focus it, and ask what the
    // strip looks like afterwards.
    setViewport(PHONE);
    const editor = attach('', { attrs: { id: 'editor' } });
    const prose = attach('', { parent: editor });
    // happy-dom does not derive isContentEditable from the attribute.
    Object.defineProperty(prose, 'isContentEditable', { value: true });
    prose.tabIndex = 0;
    const strip = attach('meeting-strip');
    // Something is covering the bottom of the window — `keyboardInset` reads
    // the difference between the layout and the visual viewport.
    Object.defineProperty(window, 'visualViewport', {
      value: {
        height: window.innerHeight - 300,
        offsetTop: 0,
        addEventListener() {},
        removeEventListener() {},
      },
      configurable: true,
    });
    const off: Array<() => void> = [];
    const api = wireEditViewport({
      roots: () => [editor],
      scroller: () => editor,
      strip: () => strip,
      caretRect: () => ({ top: 10, bottom: 30 }),
      listen: (t, type, h, o) => {
        t.addEventListener(type, h, o);
        off.push(() => t.removeEventListener(type, h, o));
      },
      onCleanup: (fn) => off.push(fn),
    });
    prose.focus();
    api.sync();

    // The yield happened…
    expect(document.body.dataset.editViewport).toBe('hidden');
    expect(styleOf(strip).display).toBe('none');
    // …and it happened in the stylesheet ONLY. The element is still mounted,
    // its state machine and socket untouched, and the attribute that means
    // "no meeting surface here" is still the strip's own to set.
    expect(strip.isConnected).toBe(true);
    expect(strip.hidden).toBe(false);

    for (let i = off.length - 1; i >= 0; i--) off[i]?.();
  });
});
