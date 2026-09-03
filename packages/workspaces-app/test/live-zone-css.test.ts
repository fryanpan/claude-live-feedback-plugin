import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  cleanup = installSheets('styles.css');
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
    expect(zone.padding).toBe('4px 14px 10px');
    expect(zone.marginTop).toBe('0px');
  });

  it('the label floats into the corner rather than taking a row above the words', () => {
    const head = styleOf(attach('lz-head', { parent: attach('live-zone') }));
    expect(head.float).toBe('right');
    expect(head.display).toBe('flex'); // control: the rule is live
  });

  it('the split-off card is not positioned, so it cannot paint over the floated label', () => {
    const chunk = styleOf(attach('lz-chunk', { parent: attach('live-zone') }));
    // Control: the card IS styled — it just declares no `position`, so the
    // computed value stays the static default (which happy-dom reports as '').
    expect(chunk.borderLeftWidth).toBe('3px');
    expect(chunk.position === 'static' || chunk.position === '').toBe(true);
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
