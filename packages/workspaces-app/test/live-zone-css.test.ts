import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COLLAPSE_MS, FADE_MS } from '../src/meeting-live-zone.ts';
import { IPAD, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The live zone's stylesheet contract (meeting-live-zone.ts).
 *
 * happy-dom lays nothing out, so what the browser measurement in the PR proves
 * — the transcript's first line within one prose line-height of the doc's last
 * line — is guarded here by the two declarations that produce it: the zone
 * brings no top margin of its own (the paragraph's bottom margin is the whole
 * gap), and the label floats into the corner instead of taking a row above the
 * words.
 *
 * Those two are read off the CASCADE now rather than out of the file's text. A
 * regex for `margin:` found the declaration wherever it sat and said nothing
 * about whether it survived to the element — a `margin-top` added later, or on
 * a compound selector, would have left the old test green and the gap back.
 *
 * SHEETS: the review shell links `styles.css` (then `tokens.css`, left out
 * here — the served file is a vendored Open Props subset plus `src/tokens.css`,
 * and the mapping half alone re-points every remapped token at an undefined
 * `var(--gray-N)`).
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('styles.css', 'doc.css');
  setViewport(IPAD);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('the transcript starts on the next line down from the doc', () => {
  it('the zone adds no top margin of its own', () => {
    const zone = styleOf(attach('live-zone'));
    // Positive control first: an element the cascade never reaches reads ''
    // for margin-top too, which would satisfy the assertion below by
    // measuring nothing.
    expect(zone.padding).toBe('2px 0px 8px');
    expect(zone.marginTop).toBe('0px');
  });

  it('the zone brings no frame and no side padding, so it shares the notes’ left edge', () => {
    const zone = styleOf(attach('live-zone'));
    // The dashed border and the panel fill are gone with the approved mock
    // (round 2); the side padding they took went with them, which is
    // what puts the transcript on the same left edge as the notes.
    expect(zone.paddingLeft).toBe('0px');
    expect(zone.paddingRight).toBe('0px');
    expect(zone.borderStyle === 'none' || zone.borderStyle === '').toBe(true);
    expect(zone.background).toBe('transparent'); // control: the rule is live
  });

  it('the transcript is smaller and greyer than the notes it feeds', () => {
    const prose = attach('ProseMirror', { parent: attach('', { attrs: { id: 'editor' } }) });
    const notes = styleOf(attach('', { tag: 'p', parent: prose }));
    const zone = attach('live-zone');
    const size = (el: Element): number => Number.parseFloat(styleOf(el).fontSize);
    const colour = (el: Element): string => styleOf(el).color;
    for (const cls of ['lz-lines', 'lz-chunk-lines']) {
      const el = attach(cls, { parent: zone });
      expect(size(el), cls).toBeLessThan(Number.parseFloat(notes.fontSize));
      // Greyer: --fg-muted, not the notes' --fg.
      expect(colour(el), cls).not.toBe(colour(prose));
      expect(colour(el), cls).toBe('#6e7781');
    }
  });

  it('the label floats into the corner rather than taking a row above the words', () => {
    const head = styleOf(attach('lz-head', { parent: attach('live-zone') }));
    expect(head.float).toBe('right');
    expect(head.display).toBe('flex'); // control: the rule is live
  });

  it('the split-off chunk has nothing drawn around it, and is not positioned', () => {
    const chunk = styleOf(attach('lz-chunk lz-chunk-lines', { parent: attach('live-zone') }));
    // Control that the rule is live, and the whole point of it: the chunk
    // fades, and that transition is the only thing it adds.
    expect(chunk.transition).toContain('opacity');
    // No card any more — no border, no fill, no padding of its own, so the
    // words land on the pixels they were already on when they split off.
    expect(chunk.borderLeftWidth).toBe('0px');
    expect(chunk.background).toBe('transparent');
    expect(chunk.padding).toBe('0px');
    // Unpositioned, so it cannot paint over the floated corner label.
    expect(chunk.position === 'static' || chunk.position === '').toBe(true);
  });

  it('the fade and the collapse are two beats, and the sheet agrees with the module', () => {
    const zone = attach('live-zone');
    const vars = styleOf(zone);
    // meeting-live-zone.ts waits these out between beats; the transitions are
    // here. A pair that drifts apart is a chunk removed mid-animation.
    expect(vars.getPropertyValue('--lz-fade-ms').trim()).toBe(`${FADE_MS}ms`);
    expect(vars.getPropertyValue('--lz-collapse-ms').trim()).toBe(`${COLLAPSE_MS}ms`);

    // The fade is opacity only — nothing that could move a word. (happy-dom
    // does not expand the shorthand, so the shorthand is what is read.)
    const chunk = styleOf(attach('lz-chunk lz-chunk-lines', { parent: zone }));
    expect(chunk.transition).toBe(`opacity ${FADE_MS}ms ease-out`);
    expect(styleOf(attach('lz-chunk lz-chunk-lines is-fading', { parent: zone })).opacity).toBe(
      '0',
    );

    // The collapse is height only, and it is withheld until the class lands:
    // an always-on `overflow: hidden` would make the slot a block formatting
    // context, which refuses to sit beside the floated label.
    expect(styleOf(attach('lz-slot', { parent: zone })).overflow).not.toBe('hidden');
    const collapsing = styleOf(attach('lz-slot is-collapsing', { parent: zone }));
    expect(collapsing.overflow).toBe('hidden');
    expect(collapsing.transition).toContain('height');
    expect(collapsing.transition).toContain(`${COLLAPSE_MS}ms`);
  });

  it('the spinner and its "writing" line are gone from the sheet too', () => {
    const zone = attach('live-zone');
    // Their rules going with the markup is what keeps a stray class from
    // resurrecting the box that shifted the words (owner, 2026-09-05).
    // Read on a span, whose UA default display is inline and reads '' here:
    // a div reads 'block' from the UA sheet whether a rule matched or not.
    for (const dead of ['lz-chunk-note', 'lz-spinner']) {
      const el = styleOf(attach(dead, { tag: 'span', parent: zone }));
      expect(el.display, dead).toBe('');
      expect(el.animation, dead).toBe('');
      expect(el.width, dead).toBe('');
    }
    // Control that this file can see a rule at all on that same chain.
    expect(styleOf(attach('lz-turn', { tag: 'span', parent: zone })).display).toBe('inline');
  });

  it('turns are inline and the stream has no per-turn block rule left', () => {
    const zone = attach('live-zone');
    // The one rule that must be there: a turn is a span in a run of text.
    expect(styleOf(attach('lz-turn', { tag: 'span', parent: zone })).display).toBe('inline');
    // …and the two classes the per-line layout used to own are unstyled, so a
    // span carrying them stays in the run rather than opening a block. A
    // reintroduced `display: block` on either would show up right here.
    for (const dead of ['lz-line', 'lz-ts']) {
      const el = styleOf(attach(dead, { tag: 'span', parent: zone }));
      expect(el.display, dead).toBe('');
      expect(el.margin, dead).toBe('');
    }
  });
});
