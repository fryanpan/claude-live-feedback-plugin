import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * How wide the dictation readout gets.
 *
 * The bubble is where a live transcript appears while someone talks, and at
 * 420px a spoken sentence wrapped into five or six short lines that re-flowed
 * on every interim result — the text moved faster than it could be read. The
 * ask was to roughly double it.
 *
 * A single number cannot do that on its own: doubled, it is wider than a
 * phone. So the width is a PAIR — a ceiling that gives the tablet and the
 * laptop the doubling, and a viewport-relative cap that keeps the phone's
 * bubble inside the screen. These are stylesheet facts; what a browser still
 * has to confirm is how the wider bubble READS, which is in the PR body.
 */
const CSS = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** The body of one rule. */
function rule(selector: string): string {
  const at = new RegExp(
    `(^|\\n|\\{)\\s*${selector.replace(/[.+*[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(CSS);
  return at?.[2] ?? '';
}

/** The `min(a, b)` a property resolves through, as its two raw arguments. */
function minArgs(decl: string, prop: string): [string, string] | null {
  const m = new RegExp(`${prop}:\\s*min\\(([^,]+),([^)]+)\\)`).exec(decl);
  return m?.[1] && m[2] ? [m[1].trim(), m[2].trim()] : null;
}

describe('the dictation readout is wide enough to follow', () => {
  const indicator = rule('.voice-indicator');

  it('caps at a width that reads as prose on a tablet or a laptop', () => {
    expect(indicator, 'the readout lost its rule').not.toBe('');
    const args = minArgs(indicator, 'max-width');
    expect(args, `max-width is not a viewport/ceiling pair: ${indicator}`).not.toBeNull();
    const ceiling = Number(/^(\d+)px$/.exec(args?.[1] ?? '')?.[1]);
    // Doubled from the 420px it sat at, and stated as the constant that made
    // the readout too narrow to follow in the first place.
    expect(ceiling).toBe(2 * 420);
  });

  it('still fits a phone, because the other half of the pair is the viewport', () => {
    const args = minArgs(indicator, 'max-width');
    const vw = Number(/^(\d+)vw$/.exec(args?.[0] ?? '')?.[1]);
    expect(vw, `the first argument is not a vw cap: ${args?.[0]}`).not.toBeNaN();
    // At 430px the ceiling is unreachable and this is what applies. It has to
    // leave room for the gutter the floating form sits in (`left: 16px`) on
    // both sides — and for a classic scrollbar, which `100vw` counts and the
    // client area does not.
    expect(vw).toBeLessThanOrEqual(92);
    // …and it must still be most of the screen, or the phone gains nothing.
    expect(vw).toBeGreaterThanOrEqual(80);
    expect((vw / 100) * 430 + 16).toBeLessThanOrEqual(430);
  });

  it('sizes itself from the sentence, so the cap above is not decorative', () => {
    // The pair above is a CEILING, and a ceiling only bites something that
    // wants to be taller. An absolutely positioned box with a `left` and no
    // `width` is shrink-to-fit, whose upper bound is the room left in its
    // containing block — the viewport while the mic floats, and the dock's own
    // column once it is docked. `max-width` cannot raise that bound, so on the
    // hub the two numbers above applied to nothing: measured 2026-08-21
    // against a full sentence, the readout came out 45px wide and 978px tall
    // in the collapsed rail — 49 lines of roughly one syllable, the top 248px
    // of it above the viewport. `max-content` is what makes the sentence, not
    // the column, decide.
    expect(indicator).toMatch(/width:\s*max-content/);
    // …stated on the SHARED rule, not on the docked copy. Every surface that
    // mounts this element positions it against something narrow eventually.
    expect(rule('.hub-nav-dock .voice-indicator')).not.toMatch(/width:\s*max-content/);
  });

  it('lets the docked copy inherit the width rather than restating it', () => {
    // The hub docks the same element in its nav (`.hub-nav-dock`), where it is
    // wider than the rail on purpose. Two hand-kept copies of a width is how
    // one surface gets the fix and the other keeps the bug.
    expect(rule('.hub-nav-dock .voice-indicator')).not.toMatch(/max-width/);
  });
});
