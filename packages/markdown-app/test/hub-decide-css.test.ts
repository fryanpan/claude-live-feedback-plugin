import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The decision card's SPACING, which is the whole of what was reported.
 *
 * Bryan, 2026-08-18, about the same card on the Home review queue: *"options
 * crammed against their details, no spacing between the answer buttons, no
 * spacing between buttons and comment text, nothing aligned."* The task-detail
 * copy emitted `hub-detail-options` / `hub-detail-option` /
 * `hub-detail-option-label` / `hub-detail-option-detail` and the stylesheet had
 * **no rule for any of them** — so the browser's defaults stacked the options
 * edge to edge and jammed the answer box against them. That is a CSS absence,
 * which no DOM test can see: `hub-render.test.ts` asserts the structure the
 * rules hang off, and this asserts that the rules exist.
 *
 * happy-dom resolves no layout, so this reads the stylesheet as text. The
 * rendered result is checked in a browser against a real build; that is what
 * closes the criterion. What this file prevents is the state the report
 * described — classes emitted with nothing styling them — coming back silently.
 */
const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of one top-level rule, comments stripped. */
function rule(selector: string): string {
  const at = new RegExp(`(^|\\n)${selector.replace(/[.+*[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(
    declarationsOnly(CSS),
  );
  return at?.[2] ?? '';
}

describe('the decision card has the spacing it was reported for missing', () => {
  it('styles every class the card emits', () => {
    // POSITIVE CONTROL, and the regression itself: the reported bug was that
    // this list came back empty. An extractor that found nothing would let
    // every assertion below pass by measuring nothing, so it is asserted first
    // and by name.
    for (const sel of [
      '.hub-decide',
      '.hub-decide-head',
      '.hub-decide-kicker',
      '.hub-decide-headline',
      '.hub-decide-why',
      '.hub-decide-detail',
      '.hub-decide-lookfor',
      '.hub-decide-meta',
      '.hub-decide-walk',
      '.hub-decide-step',
      '.hub-decide-count',
      '.hub-decide-options',
      '.hub-decide-option',
      '.hub-decide-option-label',
      '.hub-decide-option-detail',
      '.hub-decide-form',
      '.hub-decide-form-hint',
    ]) {
      expect(rule(sel), `${sel} has no rule`).not.toBe('');
    }
  });

  it('lets the blurb run to as many lines as it needs', () => {
    // *"The blurb may run a few lines — design for that."* The failure this
    // guards is a one-liner: any of these three turns a three-line question
    // into a clipped one, and a clipped decision question is unanswerable.
    for (const sel of ['.hub-decide-headline', '.hub-decide-why']) {
      const r = rule(sel);
      expect(r, `${sel} clamps its line count`).not.toMatch(/-webkit-line-clamp/);
      expect(r, `${sel} hides its overflow`).not.toMatch(/overflow:\s*hidden/);
      expect(r, `${sel} refuses to wrap`).not.toMatch(/white-space:\s*nowrap/);
    }
    // And it wraps a long unbroken token rather than widening the panel.
    expect(rule('.hub-decide-headline')).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('puts the walkthrough beside the kicker without moving it', () => {
    // With one item there is no walk at all, and the requirement is that the
    // card then *"look like today's single card"* — which `space-between`
    // gives for free, leaving the kicker exactly where it was.
    const head = rule('.hub-decide-head');
    expect(head).toMatch(/display:\s*flex/);
    expect(head).toMatch(/justify-content:\s*space-between/);
    // A step control is a tap target — at design-mobile.md's 36px floor, not
    // the 32 it shipped with — and the count must not wrap mid-"2 of 3".
    expect(
      Number(/min-height:\s*(\d+)px/.exec(rule('.hub-decide-step'))?.[1]),
    ).toBeGreaterThanOrEqual(36);
    expect(rule('.hub-decide-count')).toMatch(/white-space:\s*nowrap/);
    // Only one card is on screen; the rest are hidden rather than unbuilt.
    expect(rule('.hub-decide-card.hidden')).toMatch(/display:\s*none/);
  });

  it('puts real space between the answer buttons', () => {
    // "No spacing between the answer buttons." A column with a gap, so the
    // spacing is a property of the group rather than a margin every button has
    // to remember — and one answer per row, since a row of pills puts two
    // answers under one thumb on a phone.
    const opts = rule('.hub-decide-options');
    expect(opts).toMatch(/display:\s*flex/);
    expect(opts).toMatch(/flex-direction:\s*column/);
    expect(opts).toMatch(/gap:\s*8px/);
  });

  it('gives each option padding, and its detail its own line', () => {
    // "Options crammed against their details." The label and the detail are
    // separate elements; without a column and a gap they render as one run of
    // text with a space in it, which is what "crammed" describes.
    const opt = rule('.hub-decide-option');
    expect(opt).toMatch(/padding:\s*12px/);
    expect(opt).toMatch(/flex-direction:\s*column/);
    expect(opt).toMatch(/gap:\s*4px/);
    // "Nothing aligned": a button's text centres by default, so a two-line
    // option would centre both lines against each other.
    expect(opt).toMatch(/text-align:\s*left/);
    expect(opt).toMatch(/align-items:\s*flex-start/);
    // The tap target design-mobile.md asks for.
    expect(opt).toMatch(/min-height:\s*44px/);
  });

  it('separates the free-text box from the options above it', () => {
    // "No spacing between buttons and comment text." Space AND a rule, because
    // the box is an alternative to the options rather than the next step after
    // them — and only when there are options for it to follow, which is why
    // this is the adjacent-sibling rule and not `.hub-decide-form` itself.
    const after = rule('.hub-decide-options + .hub-decide-form');
    expect(after).toMatch(/margin-top:\s*16px/);
    expect(after).toMatch(/padding-top:\s*16px/);
    expect(after).toMatch(/border-top:/);
  });

  it('is written to be reusable by the Home card, not scoped to the panel', () => {
    // The Home queue's copy of this card is a separate ticket, on hold. These
    // names are the point: it should adopt them rather than grow a second
    // layout that drifts. So no selector here may be scoped to the detail
    // panel, or adopting it elsewhere would silently style nothing. The
    // `body.hub-detail-full` exemption this pattern used to carry is gone with
    // the rule it existed for — the full-screen mic mitigation, which the
    // docked mic made unnecessary.
    const scoped = /\.hub-detail[a-z-]*\s+\.hub-decide/.exec(declarationsOnly(CSS));
    expect(scoped).toBeNull();
  });
});
