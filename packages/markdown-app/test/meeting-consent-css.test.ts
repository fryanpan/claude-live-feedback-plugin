import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The chooser's consent surface — the quoted announcement and the two start
 * verbs that replaced the "I'll ask for consent" checkbox.
 *
 * The layout half, which no DOM test can see: happy-dom has no layout engine,
 * so it will happily report two stacked sticky buttons as fine and a 20px tap
 * target as a button. What is asserted here is the cascade shape.
 *
 * The specific hazard, and the reason the footer exists at all: the red CTA
 * carries `position: sticky; bottom: 0` so it survives a chooser taller than
 * an iPad's ~750px of usable height. Adding a second button below it does not
 * inherit that — two elements each holding `bottom: 0` land on top of each
 * other, and the one that loses is the skip. So the pair sticks as a unit and
 * the button inside goes static.
 *
 * How it reads at 1180×820 and 430px is measured in a browser; screenshots in
 * the PR.
 */
const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of the LAST rule whose selector list ends with this selector. */
function rule(selector: string): string {
  const esc = selector.replace(/[.+*[\]()]/g, '\\$&');
  const at = new RegExp(`(^|\\n|\\{)\\s*${esc}\\s*\\{([^}]*)\\}`).exec(declarationsOnly(CSS));
  return at?.[2] ?? '';
}

describe('the two verbs stick as a pair', () => {
  it('puts the sticky on the footer, not on each button', () => {
    const footer = rule('.meeting-start-actions');
    expect(footer, 'no footer rule — the buttons stick individually').not.toBe('');
    expect(footer).toMatch(/position:\s*sticky/);
    expect(footer).toMatch(/bottom:\s*0/);
    // Opaque, or the content scrolling under it shows through and the cue
    // reads as a rendering bug rather than as a scroll.
    expect(footer).toMatch(/background:\s*var\(--bg\)/);
  });

  it('stands the red button down from sticking on its own inside it', () => {
    const inner = rule('.meeting-start-actions .meeting-start-cta');
    expect(inner, 'the CTA still sticks inside the footer that sticks').not.toBe('');
    expect(inner).toMatch(/position:\s*static/);
    // Positive control: the base rule really does still say sticky, so the
    // override above is overriding something. The Stop twin in the menu
    // stands alone and needs it.
    const base = CSS.slice(CSS.indexOf('.meeting-stop-cta,'));
    expect(base.slice(0, base.indexOf('}'))).toContain('position: sticky');
  });

  it('declares the override AFTER the base rule it has to beat', () => {
    // Both are class selectors on the same element; the descendant form wins
    // on specificity, but the ordering is stated too because a later edit
    // that flattened the selector would otherwise silently lose.
    expect(CSS.indexOf('.meeting-start-actions .meeting-start-cta')).toBeGreaterThan(
      CSS.indexOf('.meeting-stop-cta,'),
    );
  });
});

describe('the skip is a real target, and a quieter one', () => {
  it('meets the tap-target floor', () => {
    const skip = rule('.meeting-skip-cta');
    expect(skip, 'no rule for the skip button').not.toBe('');
    const min = Number(/min-height:\s*(\d+)px/.exec(skip)?.[1] ?? '0');
    // design-mobile.md's floor. A deliberate choice is not a small one.
    expect(min).toBeGreaterThanOrEqual(44);
  });

  it('reads as secondary to the red verb above it', () => {
    const skip = rule('.meeting-skip-cta');
    // The announcing path is the one a room is owed. Two buttons in the same
    // weight would read as two equal choices.
    expect(skip).not.toMatch(/background:\s*var\(--red/);
    expect(skip).toMatch(/color:\s*var\(--fg-muted\)/);
    expect(skip).toMatch(/border:\s*1px solid/);
  });

  it('rings on keyboard focus in the chrome’s own accent', () => {
    expect(rule('.meeting-skip-cta:focus-visible')).toMatch(/outline:\s*2px solid var\(--accent/);
  });

  it('says when it cannot be pressed', () => {
    // It shares `chooseBusy` with the red button; a disabled pair where only
    // one looks disabled reads as one button having broken.
    expect(rule('.meeting-skip-cta:disabled')).toMatch(/opacity/);
  });
});

describe('the announcement is quoted, not offered as a control', () => {
  it('is set as a quotation', () => {
    const quote = rule('.meeting-announce-quote');
    expect(quote, 'no rule for the quoted announcement').not.toBe('');
    expect(quote).toMatch(/font-style:\s*italic/);
    // A tinted card, so it reads as the words themselves rather than as more
    // of the chooser's own copy.
    expect(quote).toMatch(/background:/);
    expect(quote).toMatch(/border(-radius)?:/);
  });

  it('leaves nothing behind from the checkbox it replaced', () => {
    // `.meeting-consent` styled a control that no longer exists. Dead rules
    // in a 7000-line stylesheet are how the next reader concludes the old
    // surface is still reachable.
    expect(declarationsOnly(CSS)).not.toMatch(/\.meeting-consent\s*[,{]/);
    // Control: the sweep can see a rule that IS there, so the absence above
    // is a fact about the stylesheet and not about the regex.
    expect(declarationsOnly(CSS)).toMatch(/\.meeting-skip-cta\s*[,{]/);
  });
});
