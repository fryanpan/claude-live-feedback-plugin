import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';
import { BOARD_BOOT_SOURCES } from './support/board-boot-sources.ts';

/**
 * The hold-to-talk mic is DOCKED in the workspace nav, not floating over the
 * page.
 *
 * Bryan, 2026-08-19: *"can we make a more durable fix for the mic? Place it in
 * a fixed location instead of floating. Put it in bottom left of left navbar in
 * desktop views. And in the bottom tab on mobile, and give it a distinct look
 * and keep it slightly separate from the navbar so it's clear it's not a
 * navbar item"*.
 *
 * The float is the bug. A `position: fixed` launcher in the bottom-left corner
 * lands on top of whatever the page happens to put there — at 430px it sat on
 * "Record answer", the one control the review queue exists to deliver. This
 * branch answered that twice by reserving space around the mic (152fb3f,
 * 50c9619); a reservation is a promise that nothing will ever be positioned
 * under one particular column, and it has to be renewed at every width where
 * the promise could be broken. Docking the mic makes the promise unnecessary:
 * the mic lives in the nav's own column and no page content is ever behind it.
 *
 * The rail, the 901–1100px strip and the phone's bottom bar are three
 * different layouts of the same element, and every claim below is a claim
 * about ONE of them. That is what the old text version of this file could not
 * express: it regexed `styles.css` and `board.css` for declarations and then
 * reasoned about which `@media` block they had been found inside, which
 * passes whether or not the query matches at the width a reader is on. Here
 * the nav is built at 1180, at 1000 and at 430 and the computed value is read,
 * so the tier boundaries are measured rather than argued.
 *
 * The MARKUP half still reads `board-app.ts`: where the mic sits in the nav's
 * child order is a fact about the file that renders it. What a browser still
 * has to confirm is in the PR body: how the docked control READS.
 */
// The board's boot sources: `board-app.ts` and the three modules split out of
// it. Read as one string because these assertions are about the board's
// shape, not about which file a line ended up in — a move must not fail
// them, and an absence checked across all four is the stronger read.
const BOARD_APP = BOARD_BOOT_SOURCES.map((m) =>
  readFileSync(resolve(import.meta.dirname, `../src/board/${m}.ts`), 'utf8'),
).join('\n');

/** The 901–1100px band: the rail is a horizontal strip, in flow. */
const STRIP = { width: 1000, height: 800 } as const;

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('board.css', 'styles.css');
  publishInsets();
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.body.className = '';
  document.documentElement.style.cssText = '';
});

/**
 * Publish the runtime insets the app publishes.
 *
 * `keyboard-inset.ts` writes `--kb-bottom` on the root element before
 * anything is drawn, and `:root { --safe-bottom: env(safe-area-inset-bottom,
 * 0px) }` resolves to 0px on a device with no home indicator. happy-dom drops
 * `env()`, and does not honour a `var()` fallback inside `calc()` either, so
 * without these a rule like `bottom: calc(16px + var(--kb-bottom, 0px) +
 * var(--safe-bottom, 0px))` is discarded whole and the property reads as if
 * the rule never existed. Setting them puts the chain back — unevaluated,
 * which is why the assertions below compare two chains rather than pixels.
 */
function publishInsets(kb = '0px', safe = '0px'): void {
  document.documentElement.style.setProperty('--kb-bottom', kb);
  document.documentElement.style.setProperty('--safe-bottom', safe);
}

/** A token as the cascade resolves it, so no literal is copied from a rule. */
const token = (name: string, el: Element = document.documentElement) =>
  styleOf(el).getPropertyValue(name);

const px = (v: string) => Number.parseFloat(v);
const z = (v: string) => Number.parseFloat(v);

/** The nav, its dock, and the mic and indicator inside the dock. */
function nav(viewport: { width: number; height: number }, navClasses = 'board-nav') {
  setViewport(viewport);
  const el = attach(navClasses, { tag: 'nav' });
  const dock = attach('board-nav-dock', { parent: el });
  const mic = attach('voice-mic', { tag: 'button', parent: dock });
  const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  mic.appendChild(glyph);
  return {
    nav: styleOf(el),
    dock: styleOf(dock),
    mic: styleOf(mic),
    glyph: styleOf(glyph),
    indicator: styleOf(attach('voice-indicator', { parent: dock })),
    item: styleOf(attach('board-nav-item', { tag: 'a', parent: el })),
  };
}

/** The free-floating mic, on a shell with nothing to dock into. */
function floatingMic(viewport: { width: number; height: number }) {
  setViewport(viewport);
  return {
    mic: styleOf(attach('voice-mic', { tag: 'button' })),
    indicator: styleOf(attach('voice-indicator')),
  };
}

/** The task overlay and the settings popover, whose layers the nav sits under. */
function overlays(viewport: { width: number; height: number }) {
  setViewport(viewport);
  return {
    detail: styleOf(attach('board-detail')),
    settings: styleOf(attach('board-settings-panel')),
  };
}

describe('the mic lives in the nav, not on top of the page', () => {
  it('mounts the mic and its indicator inside the nav element', () => {
    const start = BOARD_APP.indexOf('<nav id="board-nav"');
    const end = BOARD_APP.indexOf('</nav>', start);
    const markup = start < 0 || end < 0 ? '' : BOARD_APP.slice(start, end);
    // Positive control: this really is the nav, and the items it has always
    // held are in the slice being read.
    expect(markup, 'the board nav element moved or was renamed').not.toBe('');
    expect(markup).toContain('board-nav-item');
    expect(markup).toContain('id="board-nav-collapse"');

    expect(markup).toContain('id="board-mic"');
    expect(markup).toContain('id="board-voice"');
    // …and in a wrapper of its own, which is what carries the divider and the
    // gap that say "this is not one more page you can navigate to".
    expect(markup).toContain('board-nav-dock');
    // At the END of the rail: after every nav item and after the collapse
    // toggle, so it reads as the rail's foot rather than as another tab.
    expect(markup.indexOf('id="board-mic"')).toBeGreaterThan(markup.lastIndexOf('data-nav='));
    expect(markup.indexOf('id="board-mic"')).toBeGreaterThan(
      markup.indexOf('id="board-nav-collapse"'),
    );
    // The mic keeps the hold-to-talk affordance it had as a FAB — the press is
    // the gesture, and the label is what a screen reader gets.
    expect(markup).toContain('aria-label="Hold to talk"');
  });

  it('takes the docked mic out of the viewport-fixed layer', () => {
    const docked = nav(IPAD).mic;
    expect(docked.position).toBe('static');
    // The FAB's viewport offsets mean nothing in flow; leaving them set is how
    // a later reader concludes the mic is still fixed.
    expect(docked.left).toBe('auto');
    expect(docked.bottom).toBe('auto');
    // Positive control: the SAME class, undocked, is still the fixed float.
    expect(floatingMic(IPAD).mic.position).toBe('fixed');
  });

  it('keeps the float as a fallback, for a shell with nothing to dock into', () => {
    // `.voice-mic` is shared by the board and the /review/<docId> surface. Both
    // dock it now — the board in its rail/bar, the doc surface at the head of the
    // topbar's toolbar (`.doc-nav-dock`) — so the base rule's positioning is
    // what a shell with NEITHER falls back to. Docking the base would strand
    // that fallback in flow at the end of <body>.
    const resting = floatingMic(IPAD);
    expect(resting.mic.position).toBe('fixed');
    expect(resting.mic.left).toBe('16px');
    const restingBottom = resting.mic.bottom;
    const restingIndicator = resting.indicator.bottom;

    // It still rises with the on-screen keyboard, like every bottom-docked
    // element on that surface — asserted by moving the inset the app
    // publishes and watching the offset follow it.
    publishInsets('260px');
    expect(floatingMic(IPAD).mic.bottom).not.toBe(restingBottom);
    expect(floatingMic(IPAD).indicator.bottom).not.toBe(restingIndicator);

    // Nothing about the board's bottom bar belongs in it any more: on the only
    // surface this rule now positions, that variable has never been defined,
    // so publishing it must move nothing.
    publishInsets();
    document.documentElement.style.setProperty('--board-bottom-bar', '58px');
    expect(floatingMic(IPAD).mic.bottom).toBe(restingBottom);
    expect(floatingMic(IPAD).indicator.bottom).toBe(restingIndicator);
  });
});

describe('the docked mic reads as a control, not as a nav item', () => {
  it('separates the dock from the items with a divider and a gap', () => {
    const { dock } = nav(IPAD);
    expect(px(dock.borderTopWidth)).toBe(1);
    expect(dock.borderTopStyle).toBe('solid');
    expect(dock.borderTopColor).toBe(token('--border'));
    // *"keep it slightly separate from the navbar"* — the divider alone still
    // reads as a list separator; the gap is what sets it apart.
    expect(px(dock.paddingTop)).toBeGreaterThanOrEqual(8);
    expect(px(dock.marginTop)).toBeGreaterThanOrEqual(8);
  });

  it('gives it a filled, bordered treatment the borderless nav items do not have', () => {
    // Nav items are borderless text rows on the rail's own panel colour. The
    // mic keeps the round bordered button it has always been, and takes the
    // page background so the circle is visible against the rail.
    const { item, mic } = nav(IPAD);
    expect(item.borderTopStyle).toBe('none');
    expect(mic.backgroundColor).toBe(token('--bg'));
    expect(mic.borderRadius).toBe('50%');
    expect(px(mic.borderTopWidth)).toBe(1);
    expect(mic.borderTopColor).toBe(token('--border'));
  });

  it('keeps both states the mic has always had', () => {
    setViewport(IPAD);
    const rail = attach('board-nav', { tag: 'nav' });
    const dock = attach('board-nav-dock', { parent: rail });
    // Recording: the same red — a token since the Open Props trial, so the
    // board's quick mic and this dock cannot drift apart literal by literal.
    // The docked background is written `:not(.voice-active)` so it cannot
    // out-specify the state that matters most.
    const active = styleOf(attach('voice-mic voice-active', { tag: 'button', parent: dock }));
    expect(active.backgroundColor).toBe(token('--red-strong'));
    // Insecure origin: dimmed but still PRESSABLE — the press is how the
    // reason gets surfaced, so `disabled` would swallow the explanation.
    const off = styleOf(attach('voice-mic voice-unavailable', { tag: 'button', parent: dock }));
    expect(off.opacity).toBe('0.45');
    expect(off.pointerEvents).not.toBe('none');
  });

  it('never deadens the button, only the glyph inside it', () => {
    // `.voice-mic svg` sets `pointer-events: none` on purpose, so hit-testing
    // over the mic keeps answering "the mic" now that the glyph is an element
    // rather than a text node. Deadening the BUTTON is the opposite, and is
    // what would take the press away — so the two are read together, and the
    // glyph's own `none` is the control proving the read can see one.
    for (const viewport of [IPAD, STRIP, PHONE]) {
      const { mic, glyph } = nav(viewport);
      expect(mic.pointerEvents, `the mic is deadened at ${viewport.width}px`).not.toBe('none');
      expect(glyph.pointerEvents).toBe('none');
    }
  });

  it('stays a 44px touch target, and a hold rather than a scroll', () => {
    const base = floatingMic(IPAD).mic;
    expect(px(base.width)).toBeGreaterThanOrEqual(44);
    expect(px(base.height)).toBeGreaterThanOrEqual(44);
    // The hold IS the gesture — a docked mic inside a scrollable rail must not
    // start a scroll on touchmove.
    expect(base.touchAction).toBe('none');
    // Docking must not shrink it, at any of the three layouts.
    for (const viewport of [IPAD, STRIP, PHONE]) {
      const { mic } = nav(viewport);
      expect(px(mic.width), `the dock shrank the mic at ${viewport.width}px`).toBe(px(base.width));
      expect(px(mic.height)).toBe(px(base.height));
    }
  });

  it('still fits, whole, in the collapsed rail', () => {
    // The rail collapses to icons (`board-nav--collapsed`, persisted). The mic is
    // already icon-only, so it stays exactly where it is — moving it on
    // collapse would put the one control back to "where did it go". What the
    // collapse has to buy is room: 44px of button inside the narrowed rail,
    // border-box, so the rail's border and padding come out of the width.
    const collapsed = nav(IPAD, 'board-nav board-nav--collapsed');
    expect(collapsed.nav.boxSizing).toBe('border-box');
    const inner =
      px(collapsed.nav.width) -
      px(collapsed.nav.borderRightWidth) -
      px(collapsed.nav.paddingLeft) -
      px(collapsed.nav.paddingRight);
    expect(inner).toBeGreaterThanOrEqual(px(collapsed.mic.width));
    // …and it is not hidden with the labels.
    expect(collapsed.dock.display).not.toBe('none');
  });
});

describe('the phone gets the mic in the bottom tab bar', () => {
  it('puts the dock at the bar’s left end, divided from the tabs', () => {
    // The horizontal treatment is written once, in the ≤1100px strip band, and
    // the ≤900px bar inherits it — the bar IS that strip, pinned to the
    // bottom. Both are read here, so a rule that stops reaching the phone
    // fails rather than being argued about from source order.
    for (const viewport of [STRIP, PHONE]) {
      const { dock } = nav(viewport);
      // The rail's top divider becomes a side one.
      expect(dock.borderTopStyle, `still a top divider at ${viewport.width}px`).toBe('none');
      expect(px(dock.borderRightWidth)).toBe(1);
      // The mic has always been bottom-LEFT, and the feedback widget's pencil
      // owns the opposite corner; `order` puts it at the head of the bar
      // without moving it in the DOM, where it belongs after the pages it is
      // not one of.
      expect(dock.order).toBe('-1');
      // …and it stays positioned, or the readout absolutely positioned against
      // it would silently re-anchor to the viewport.
      expect(dock.position).toBe('relative');
    }

    const phone = nav(PHONE);
    // Positive control: this is the width that pins that strip to the bottom.
    expect(phone.nav.position).toBe('fixed');
    // Inset from the screen edge, and NOT `flex: 1` like the tabs beside it.
    expect(phone.dock.paddingLeft).toBe('10px');
    expect(phone.dock.flexGrow).not.toBe('1');
  });

  it('undoes the rail’s sticky offset when the dock joins a horizontal bar', () => {
    // `bottom: 8px` is the STICKY rail's offset — how far off the scrollport's
    // foot the mic parks. `position: relative` keeps reading the same
    // declaration, and a relatively positioned box with a `bottom` is PAINTED
    // that far ABOVE its flow position: the dock's stretched box, divider and
    // all, would ride 8px out of line with the tabs beside it and poke over
    // the bar's top border. A media query adds no specificity, so the reset
    // has to be written — the rule the rail block states in its own comment.
    // Positive control first: the offset really is there on the rail.
    expect(px(nav(IPAD).dock.bottom)).toBeGreaterThan(0);
    expect(nav(STRIP).dock.bottom).toBe('auto');
    expect(nav(PHONE).dock.bottom).toBe('auto');
  });

  it('gives up the rail’s layer, because the strip has page content behind it', () => {
    // The rail earns `z-index: 70` on one premise: nothing of the page sits
    // behind its column, so a mic painted over the task overlay covers
    // nothing. In this band the nav is a top strip and the centred panel runs
    // underneath it, so the premise is false and the same number reproduces
    // the float. Measured 2026-08-19 at 905px: the mic covered the panel
    // whole, clipped the first characters of the task title, and
    // `elementFromPoint` over the intersection returned `BUTTON.voice-mic` —
    // it took the click as well as the pixels.
    expect(nav(STRIP).dock.zIndex).toBe('auto');
    expect(nav(PHONE).dock.zIndex).toBe('auto');
    // Positive control, and the point of the whole test: the number this
    // overrides is really there on the rail. Without this the assertions above
    // pass just as happily against a dock that never had a layer.
    expect(z(nav(IPAD).dock.zIndex)).toBeGreaterThan(0);
  });

  it('leaves the bar no higher than the full-screen overlays', () => {
    // The bar itself stays under the detail overlay: an overlay that covers
    // the board covers the pages you could navigate to instead of it. Equal
    // z-index is enough, because the detail overlay comes later in the shell
    // markup. (What must NOT be covered is the mic — see the describe below,
    // where the overlay is kept off the bar's row entirely.)
    const bar = z(nav(PHONE).nav.zIndex);
    expect(bar, 'the bar lost its layer').not.toBeNaN();
    expect(bar).toBeLessThanOrEqual(z(overlays(PHONE).detail.zIndex));
    // And the docked mic carries no layer of its own — it rides the dock's.
    expect(nav(PHONE).mic.zIndex).toBe('auto');
  });
});

/**
 * The 901–1100px band — the third thing, and the one the dock was never given.
 *
 * ≤1100px turns the rail into a horizontal strip and ≤900px pins that strip to
 * the bottom as a fixed bar. Between them the strip is neither: it sat at the
 * top of the content IN FLOW, so it scrolled away and took the mic with it.
 * Measured at 1000x800 on a 70-row board: the mic was at y=54 at the top and
 * y=-2271 at the bottom, and `elementFromPoint` over it returned nothing at
 * every scroll position past the first screen. A docked mic that is off the
 * screen keeps none of docking's promise — "a fixed location" is a location
 * you can still reach.
 */
describe('the strip band keeps the mic on screen', () => {
  it('pins the strip to the top of the scrollport', () => {
    const strip = nav(STRIP).nav;
    expect(strip.position).toBe('sticky');
    expect(strip.top).toBe('0px');
    // Positive control: the BASE rail rule is where this is absent, so the
    // band is really what introduces it rather than the file having always
    // said so.
    expect(nav(IPAD).nav.position).toBe('');
  });

  it('gives the strip a containing block its sticky can travel in', () => {
    // A grid item's containing block is its GRID AREA — the strip's own 57px
    // row — so a sticky strip has nowhere to go by the spec. Chromium sticks
    // it against the grid CONTAINER regardless; that is an engine reading an
    // under-specified corner, and this band's reviewer is on Safari. A flex
    // column makes `.board-main`'s content box the containing block, where the
    // travel is defined.
    setViewport(STRIP);
    const banded = styleOf(attach('board-main'));
    expect(banded.display).toBe('flex');
    expect(banded.flexDirection).toBe('column');
    // `align-items: start` on the base rule means block-start in a grid and
    // SHRINK-TO-FIT in a column flex container — the board would narrow to its
    // own content instead of the page. The undo has to be written.
    expect(banded.alignItems).toBe('stretch');
    // Positive control: the base layout really is the grid this overrides.
    setViewport(IPAD);
    const base = styleOf(attach('board-main'));
    expect(base.display).toBe('grid');
    expect(base.alignItems).toBe('start');
  });

  it('paints over the rows it is pinned above, and under the task panel', () => {
    // A pinned bar with no layer is a bar the board scrolls THROUGH: rows
    // carry absolutely positioned marks (`.board-status-select` is `inset: -6px`
    // over its mark) and a positioned box later in tree order beats a
    // positioned box with no layer. Measured at `z-index: auto`, the topmost
    // element at the mic's centre came back `select.board-status-select` at
    // three of five scroll positions — visible mic, stolen click.
    const strip = nav(STRIP).nav;
    expect(z(strip.zIndex), 'the pinned strip has no layer').not.toBeNaN();
    // …and under the overlay, which is what keeps the deliberate loss below
    // (`.board-nav-dock`'s own note) true: the panel still covers the strip.
    const over = overlays(STRIP);
    expect(z(strip.zIndex)).toBeLessThan(z(over.detail.zIndex));
    expect(z(strip.zIndex)).toBeLessThan(z(over.settings.zIndex));
    // Opaque, or the page shows through the thing it is scrolling under.
    expect(strip.backgroundColor).toBe(token('--bg'));
  });

  it('does not follow the strip onto the phone, where the bar is at the bottom', () => {
    // Same specificity, so SOURCE ORDER is the whole guarantee: the ≤900 block
    // has to restate every offset the sticky strip sets, and has to sit below
    // it in the file. Reading the computed values at 430px is what proves the
    // order held — a ≤900 block written above the ≤1100 one would leave the
    // sticky offsets standing here.
    const bar = nav(PHONE).nav;
    expect(bar.position).toBe('fixed');
    expect(bar.top).toBe('auto');
    expect(bar.bottom).toBe('0px');
    expect(bar.backgroundColor).toBe(token('--bg-panel'));
  });
});

describe('the task detail never lands on top of the docked mic', () => {
  /**
   * Docking traded one overlap for another. `.board-detail` is `position: fixed;
   * inset: 0` and comes after `.board-main` in the shell, so the panel and its
   * scrim cover the nav — and the mic went into the nav. That is not cosmetic:
   * hold-to-talk from inside an open task is a shipped capability (the voice
   * context sends `surface: 'task'`), and the keyboard half of it needs a
   * Space key a phone does not have. The mic has to stay reachable while a
   * task is open, at every width.
   */
  it('lifts the dock — and only the dock — over the panel’s scrim', () => {
    // Where the nav is a static rail or strip (≥901px) it opens no stacking
    // context, so the dock alone can sit above the overlay. The rail's column
    // holds no page content, so a mic painted over that scrim covers nothing —
    // while a scrim painted over the mic hands the click to the scrim's own
    // close-on-outside handler and dismisses the task instead.
    const dock = nav(IPAD).dock;
    expect(z(dock.zIndex), 'the dock has no layer of its own').not.toBeNaN();
    expect(z(dock.zIndex)).toBeGreaterThan(z(overlays(IPAD).detail.zIndex));
    // Only the dock: the pages stay under the overlay, so this lifts the mic
    // rather than restoring a nav you can click through a modal.
    expect(nav(IPAD).nav.zIndex).toBe('');
  });

  it('stops the phone’s full-screen panel above the bar the mic is in', () => {
    // A fixed bar IS a stacking context whatever its z-index, so at ≤900px no
    // z-index on the dock can escape it. The answer is geometric instead: the
    // overlay ends where the bar begins, so the mic is not merely on top of
    // nothing — nothing is over it.
    document.body.className = 'board-body';
    setViewport(PHONE);
    const barHeight = token('--board-bottom-bar', document.body);
    // Positive control: the bar's height really is published at this width, so
    // the offset below resolves to the bar rather than to a 0 fallback.
    expect(px(barHeight)).toBeGreaterThan(0);
    const overlay = styleOf(attach('board-detail'));
    expect(overlay.bottom).not.toBe('0px');
    expect(overlay.bottom).toContain(barHeight);
    // …and it clears the home-indicator inset the bar itself pads for: moving
    // that inset moves the overlay's foot with it.
    const flat = overlay.bottom;
    publishInsets('0px', '34px');
    expect(styleOf(attach('board-detail')).bottom).not.toBe(flat);
    // Control: at 1180 the overlay owes the bar nothing, because there is none.
    publishInsets();
    setViewport(IPAD);
    expect(styleOf(attach('board-detail')).bottom).toBe('0px');
  });
});

describe('the indicator follows the mic', () => {
  it('anchors the board indicator to the dock rather than to the viewport corner', () => {
    // `.voice-indicator` rode directly above a mic pinned at the viewport's
    // bottom-left. On a centred 1500px board the rail's foot is nowhere near
    // that corner, so a viewport-anchored indicator would point at the page
    // gutter. Anchoring it to the dock makes it follow the mic at every width.
    const { indicator, dock } = nav(IPAD);
    expect(indicator.position).toBe('absolute');
    expect(indicator.bottom).toContain('100%');
    // The dock is the containing block it resolves against.
    expect(dock.position).toBe('sticky');
    // Positive control: undocked, the same class is anchored to the viewport.
    expect(floatingMic(IPAD).indicator.position).toBe('fixed');
  });

  it('is not clipped by the nav it now hangs off', () => {
    // The indicator is up to 840px wide and overflows a 170px rail by design.
    // An `overflow-x` on the nav would clip it — and would also make the nav a
    // scroll container, which silently breaks the dock's `position: sticky`.
    for (const viewport of [IPAD, STRIP, PHONE]) {
      const { nav: bar } = nav(viewport);
      expect(bar.overflow, `the nav clips at ${viewport.width}px`).toBe('');
      expect(bar.overflowX, `the nav scrolls at ${viewport.width}px`).toBe('');
    }
  });
});

describe('the float-era mitigations are gone with the float', () => {
  it('drops the tail reservation the fixed mic forced on the task panel', () => {
    // 152fb3f and 50c9619 reserved 24+60px under the panel at every width the
    // panel's left edge reached the mic's column (a ≤1023px block). Nothing is
    // in that column any more, so the panel's tail is the same at every width.
    setViewport(IPAD);
    const wide = styleOf(attach('board-detail-panel')).paddingBottom;
    expect(px(wide), 'the task panel is unstyled').toBeGreaterThan(0);
    for (const width of [1023, 1000, 900, 430]) {
      setViewport({ width, height: 800 });
      expect(
        styleOf(attach('board-detail-panel')).paddingBottom,
        `the panel still reserves mic clearance at ${width}px`,
      ).toBe(wide);
    }
    // Positive control: the phone's own page tail still clears the bottom bar —
    // that reservation is about the BAR, which is still fixed, and is not one
    // of the mic mitigations.
    document.body.className = 'board-body';
    setViewport(PHONE);
    const barHeight = token('--board-bottom-bar', document.body);
    expect(px(barHeight)).toBeGreaterThan(0);
    expect(styleOf(attach('', { attrs: { id: 'board-root' } })).paddingBottom).toContain(barHeight);
  });

  it('drops the right-aligned submits the fixed mic forced on every composer', () => {
    // The RIGHT alignment existed only to keep a submit out of the mic's
    // column. A form is free to lay its buttons out however the form wants
    // again — `.board-decide-form` still starts its button, which is a layout
    // choice about the form and doubles here as the control proving this read
    // can see an `align-self` at all.
    setViewport(IPAD);
    let sawAnAlignment = false;
    for (const form of ['board-comment-form', 'board-decide-form']) {
      const el = attach(form, { tag: 'form' });
      // Positive control: the composers themselves are still styled.
      expect(styleOf(el).display, `.${form} is unstyled`).not.toBe('');
      const submit = attach('', { tag: 'button', parent: el, attrs: { type: 'submit' } });
      const align = styleOf(submit).alignSelf;
      expect(align, `.${form} still right-aligns to dodge the mic`).not.toBe('flex-end');
      if (align !== '') sawAnAlignment = true;
    }
    expect(sawAnAlignment, 'no composer declares an align-self, so the read is blind').toBe(true);
  });
});
