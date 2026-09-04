import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The top-bar overhaul moved the transcript strip out of `#editor-pane` and
 * into `#shell` itself — the strip is `#shell`'s second grid row, fused
 * directly under the bar the Record button sits in (the notch points at it),
 * so its height comes out of the editor below rather than sitting on top of
 * the prose.
 *
 * One shape at both widths Bryan reads on (1180x820 and 430px) — a single
 * flex row that only tweaks its own padding/gap/notch position narrow; there
 * is no separate stacked-panel layout any more (the old chrome's mode/engine
 * switches, toggle button and status word are gone — every choice now lives
 * in the popovers behind the Record button).
 *
 * This file used to regex `styles.css` for those declarations, which passes
 * against a rule the cascade no longer applies. The sheets are installed here
 * and the strip is built at each viewport instead. The SHELL half still reads
 * `index.html` and `meeting-strip.ts`, because "the strip element sits between
 * the header and main, and only a markdown doc mounts it" is a fact about
 * files rather than about any computed value.
 *
 * What stays a browser check (`bun run ui:shot`), because happy-dom resolves
 * no pseudo-element, no `color-mix()` and no `prefers-reduced-motion`: the
 * notch that fuses the strip to the Record button, the pencil glyph on the
 * speaker pill, the red wash while live, and the reduced-motion stand-down.
 */
const SHELL = readFileSync(resolve(import.meta.dirname, '../index.html'), 'utf8');
const MOUNT = readFileSync(resolve(import.meta.dirname, '../src/meeting-strip.ts'), 'utf8');
const APP = readFileSync(resolve(import.meta.dirname, '../src/app.ts'), 'utf8');

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('hub.css', 'styles.css', 'doc.css');
  setViewport(IPAD);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.body.removeAttribute('data-edit-viewport');
});

/** A token's value as the cascade resolves it, so no colour is hand-copied. */
const token = (name: string) => styleOf(document.documentElement).getPropertyValue(name);

const px = (v: string) => Number.parseFloat(v);

/** The strip, and the parts of it a test asks about. */
function strip(extra = '') {
  const el = attach(`meeting-strip ${extra}`.trim());
  return { el, style: styleOf(el) };
}

describe('the shell reserves a row for the strip', () => {
  it('gives #shell three tracks: topbar, strip, main', () => {
    // The strip's `auto` track is what makes it RESERVE its height instead of
    // covering the prose. That track is not sufficient on its own: a hidden
    // strip is `display: none`, which drops it out of the grid's item list
    // rather than collapsing its track, so #main used to auto-place into the
    // strip's row and leave the last one empty. The three children are pinned
    // explicitly now — shell-grid-placement.test.ts owns that invariant and
    // the control that proves the bug is still detectable.
    const shell = styleOf(attach('', { attrs: { id: 'shell' } }));
    expect(shell.display).toBe('grid');
    expect(shell.gridTemplateRows).toBe('48px auto minmax(0, 1fr)');
  });

  it('no longer asks #editor-pane for that row — the strip left the pane', () => {
    // Two tracks only: the format bar and the document. The floating Approve
    // button and the view-controls toggle are `position: absolute` and claim
    // no track of their own.
    const pane = styleOf(attach('', { attrs: { id: 'editor-pane' } }));
    expect(pane.gridTemplateRows).toBe('auto 1fr');
  });

  it('positive control: the shell really puts the strip between the bar and main', () => {
    const topbarEnd = SHELL.indexOf('</header>');
    const mainStart = SHELL.indexOf('<main');
    const stripAt = SHELL.indexOf('id="meeting-strip"');
    expect(topbarEnd).toBeGreaterThan(-1);
    expect(mainStart).toBeGreaterThan(-1);
    expect(stripAt, 'no #meeting-strip in the shell').toBeGreaterThan(-1);
    expect(stripAt).toBeGreaterThan(topbarEnd);
    expect(stripAt).toBeLessThan(mainStart);
  });

  it('is hidden until a markdown doc mounts it, so a diff review keeps its layout', () => {
    expect(SHELL).toMatch(/id="meeting-strip"[\s\S]{0,80}?hidden/);
    expect(MOUNT).toMatch(/root\.hidden = !stripVisible\(\)/);
    expect(MOUNT).toMatch(/root\.hidden = true/);
    // A hidden strip must not claim its grid row anyway — `display: flex`
    // out-specifies the UA's `[hidden]` rule, so this override is load-bearing
    // and is read as the value the browser would use, not as a declaration.
    const hidden = styleOf(attach('meeting-strip', { attrs: { hidden: '' } }));
    expect(hidden.display).toBe('none');
    // Positive control: without the override the class would win — the strip
    // that is NOT hidden is a flex row on the same cascade.
    expect(strip().style.display).toBe('flex');
    // The diff surface's own floating controls are absolutely positioned, so
    // they claim no track — but only the markdown mount adds the strip at all.
    expect(APP).toMatch(/docType === 'markdown'/);
  });
});

describe('the speaker tag', () => {
  /** The button and the pill inside it, mounted as the feed mounts them. */
  function speaker() {
    const host = strip().el;
    const button = attach('meeting-speaker', { tag: 'button', parent: host });
    const pill = attach('meeting-speaker-pill', { tag: 'span', parent: button });
    return { strip: styleOf(host), button: styleOf(button), pill: styleOf(pill) };
  }

  it('reads as a tag: muted, smaller than the words it labels, and clickable', () => {
    const { strip: bar, button, pill } = speaker();
    expect(button.cursor).toBe('pointer');
    // The look lives on the pill inside it; see the split below.
    expect(pill.color).toBe(token('--fg-muted'));
    expect(px(pill.fontSize)).toBeLessThan(px(bar.fontSize));
    expect(pill.borderRadius).toBe(token('--radius-pill'));
  });

  /**
   * The split IS the fix (see the stylesheet's own comment on it): the
   * button is a transparent box whose PADDING is the tap target, and the
   * pill inside carries every visual and the only overflow. Nothing in the
   * new design clips the feed to a fixed-height window the way the old
   * `.meeting-caption` did — `.meeting-feed` has no explicit height, so the
   * button's own box is the whole story now. Still measured rather than
   * trusted on the ingredients alone: two rounds of review were lost to a
   * pseudo-element hit area that a clip on any ancestor (including the
   * button's own) silently ate down to 19px.
   */
  it('the tap target MEASURES at least 36px — the pill plus the button padding', () => {
    const { button, pill } = speaker();
    const pillHeight = px(pill.fontSize) * Number(pill.lineHeight) + 2 * px(pill.borderTopWidth);
    expect(Number.isFinite(pillHeight) && pillHeight > 0, 'read nothing off the pill').toBe(true);
    const hit = pillHeight + 2 * px(button.paddingTop);
    expect(
      hit,
      `hit ${hit} from a ${pillHeight}px pill and ${px(button.paddingTop)}px padding`,
    ).toBeGreaterThanOrEqual(36);
  });

  it('keeps the target and the clip on separate elements', () => {
    // The split IS the fix: the button holds the padding and nothing that
    // clips; the pill holds every visual and the only overflow. Collapse them
    // and the ellipsis clips the tap target again.
    const { button, pill } = speaker();
    expect(button.overflow).toBe('');
    expect(button.textOverflow).toBe('');
    expect(button.backgroundColor).toBe('none');
    expect(px(button.borderTopWidth)).toBe(0);
    // The line box must not grow by the padding, or the feed's line moves.
    expect(px(button.marginTop)).toBe(-px(button.paddingTop));
    // Control: the pill beside it IS the element that clips.
    expect(pill.overflow).toBe('hidden');
  });

  it('caps the tag so naming a voice cannot push every tag out of the window', () => {
    // A 60-character name rendered a 335px pill, wrapped the line, and hid
    // every tag — naming a speaker turned the labels off. The cap is written
    // in `em`, which happy-dom does not convert, so what is asserted is that
    // a cap is in force and that the ellipsis machinery around it is too.
    const { pill } = speaker();
    expect(pill.maxWidth === '' || pill.maxWidth === 'none').toBe(false);
    expect(pill.overflow).toBe('hidden');
    expect(pill.textOverflow).toBe('ellipsis');
  });

  it('looks like a control at rest, where there is no hover to reveal it', () => {
    // `cursor: pointer` and the title attribute are both hover-only, so on the
    // iPad nothing said the pill was tappable. The pencil that sits in front
    // of the name is `::before` content, which happy-dom cannot resolve — the
    // underline is the half that reads here.
    expect(speaker().pill.textDecoration).toBe('underline dotted');
  });
});

describe('the strip itself: one flex row, blinker · clock · flowing feed', () => {
  it('is a single flex row at least 36px tall, at every width', () => {
    for (const width of [1180, 600, 430]) {
      setViewport({ width, height: 900 });
      const bar = strip().style;
      expect(bar.display, `not a flex row at ${width}px`).toBe('flex');
      expect(bar.alignItems).toBe('center');
      expect(px(bar.minHeight)).toBeGreaterThanOrEqual(36);
      // The old chrome stacked into a column narrow; the new one never does.
      expect(bar.flexDirection, `stacks into a column at ${width}px`).not.toBe('column');
    }
  });

  it('reads as chrome against the prose, not as more document', () => {
    const bar = strip().style;
    expect(bar.backgroundColor).toBe(token('--bg-panel'));
    expect(px(bar.borderBottomWidth)).toBe(1);
    expect(bar.borderBottomColor).toBe(token('--border'));
    // Compared against the token the cascade resolves, not a copied stack;
    // whitespace is normalised because the computed value re-spaces the list.
    const flat = (v: string) => v.replace(/["'\s]/g, '');
    expect(flat(bar.fontFamily)).toBe(flat(token('--sans')));
  });

  it('flows the feed on one line with a fade at the tail, newest words at the right', () => {
    const host = strip().el;
    const feed = styleOf(attach('meeting-feed', { parent: host }));
    expect(feed.whiteSpace).toBe('nowrap');
    expect(feed.getPropertyValue('mask-image')).toContain('linear-gradient');
    expect(styleOf(attach('meeting-feed-inner', { parent: host })).float).toBe('right');
  });

  it('lets a held note wrap instead of forcing the flowing-feed treatment on it', () => {
    // A note is read left-to-right from its start and may need two lines —
    // the mask/nowrap treatment is for words that arrive forever, not for
    // one sentence with an audience.
    const host = strip().el;
    const feed = attach('meeting-feed', { parent: host });
    attach('meeting-note', { parent: feed });
    const withNote = styleOf(feed);
    expect(withNote.whiteSpace).toBe('normal');
    expect(withNote.getPropertyValue('mask-image')).toBe('none');
  });

  it('gives the announcement reading size and colour, since someone reads it ALOUD', () => {
    // Every other string in the strip is a readout glanced at by the one
    // person holding the device. This one is a script read out to a room off
    // an iPad at arm's length.
    const bar = strip();
    const note = styleOf(attach('meeting-note-dismiss', { tag: 'button', parent: bar.el }));
    expect(px(note.fontSize)).toBeGreaterThanOrEqual(16);
    expect(px(note.fontSize)).toBeGreaterThan(px(bar.style.fontSize));
    expect(note.color).toBe(token('--fg'));
    expect(note.backgroundColor).toBe('none');
    expect(px(note.borderTopWidth)).toBe(0);
    expect(note.cursor).toBe('pointer');
  });

  it('gives a held announcement the room instead of clipping it at the bar height', () => {
    const bar = strip();
    expect(bar.style.getPropertyValue('padding-block')).toBe('');
    attach('meeting-note-dismiss', { tag: 'button', parent: bar.el });
    expect(px(styleOf(bar.el).getPropertyValue('padding-block'))).toBeGreaterThan(0);
  });

  it('narrows without stacking — only the record button, gap and padding move', () => {
    // A computed style is LIVE against the current viewport, so the wide
    // numbers are read out to primitives before the viewport moves.
    setViewport(IPAD);
    const wideStyle = strip().style;
    const wide = { gap: px(wideStyle.gap), padLeft: px(wideStyle.paddingLeft) };
    setViewport({ width: 600, height: 900 });
    const host = strip();
    expect(px(host.style.gap)).toBeLessThan(wide.gap);
    expect(px(host.style.paddingLeft)).toBeLessThan(wide.padLeft);
    expect(px(styleOf(attach('meeting-record', { tag: 'button', parent: host.el })).fontSize)).toBe(
      12,
    );
    // The popovers become an edge-to-edge sheet under the bar there.
    expect(styleOf(attach('meeting-sheet')).left).toBe('6px');
  });

  it('yields to an open keyboard at phone width — layout only, never the live mic', () => {
    setViewport({ width: 700, height: 900 });
    expect(strip().style.display).toBe('flex'); // control: shown by default
    document.body.setAttribute('data-edit-viewport', 'hidden');
    expect(strip().style.display).toBe('none');
    // …and only where the keyboard covers the page: the same flag on the iPad
    // leaves the strip alone.
    setViewport(IPAD);
    expect(strip().style.display).toBe('flex');
  });
});

describe('motion', () => {
  it('blinks the dot only while actually recording', () => {
    const live = attach('meeting-strip', { attrs: { 'data-state': 'live' } });
    expect(styleOf(attach('meeting-blinker', { parent: live })).animation).toContain(
      'meeting-blink',
    );
    // Requesting/bot-not-live/settled-failure states hold it still — a
    // blinking dot beside "the mic was refused" claims a recording that is
    // not happening.
    const dead = attach('meeting-strip', { attrs: { 'data-state': 'unavailable' } });
    expect(styleOf(attach('meeting-blinker', { parent: dead })).animation).toBe('none');
  });

  it('flashes only the word the model rewrote', () => {
    const line = attach('meeting-caption-line');
    expect(styleOf(attach('w is-fixed', { tag: 'span', parent: line })).animation).toContain(
      'meeting-fix',
    );
    // Control: a word the model did not rewrite carries no animation.
    expect(styleOf(attach('w', { tag: 'span', parent: line })).animation).toBe('');
  });
});
