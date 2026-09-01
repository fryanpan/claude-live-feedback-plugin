import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The spin-off menu's two forms — popover on a pointer, bottom sheet on a
 * phone. Neither is visible to the DOM test beside this one: happy-dom
 * resolves no layout and evaluates no media query, so `mountSpinoffMenu`
 * builds the same five buttons at every width and cannot tell you that four
 * of them land off-screen.
 *
 * The failure this guards is specific. The menu hangs off a SELECTION, and a
 * selection on a phone is under a thumb near the bottom of the screen; a
 * popover placed under it opens below the fold with its last rows unreachable
 * and no scroll of its own. Every other menu in this app already solved that
 * by becoming a sheet at 560px, and the point of asserting it here is that the
 * newest menu does not quietly ship as the one exception.
 *
 * How it actually reads at 1180×820 and 430px is checked in a browser, with
 * the screenshots in the PR.
 */
const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

/** The width the app's menus become sheets at. Named once: a stale copy of
 *  the number would search a block that does not exist and pass on nothing. */
const SHEET = '(max-width: 560px)';

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of one rule, optionally scoped to a media block's text — the same
 *  selector is styled at both widths, and a file-wide search returns whichever
 *  the file happens to state first. */
function rule(selector: string, within: string = declarationsOnly(CSS)): string {
  const at = new RegExp(
    `(^|\\n|\\{)\\s*${selector.replace(/[.+*[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(within);
  return at?.[2] ?? '';
}

/** Every `@media` block with this query, concatenated, braces counted — the
 *  stylesheet holds more than one block per breakpoint. */
function media(query: string): string {
  const css = declarationsOnly(CSS);
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(`@media ${query}`, from);
    if (start < 0) break;
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        out.push(css.slice(start, i));
        from = i;
        break;
      }
    }
    if (from <= start) break;
  }
  return out.join('\n');
}

describe('at reading width it is a popover under the pill', () => {
  it('positions itself, and above the pill that opened it', () => {
    const menu = rule('.spinoff-menu');
    expect(menu, 'the menu has no rule at all').not.toBe('');
    expect(menu).toMatch(/position:\s*absolute/);
    // The pill sits at 800. A menu that opened BEHIND its own button would
    // look like a menu that failed to open.
    const z = Number(/z-index:\s*(\d+)/.exec(menu)?.[1] ?? '0');
    expect(z).toBeGreaterThan(800);
    expect(
      Number(/z-index:\s*(\d+)/.exec(rule('.spinoff-menu-scrim'))?.[1] ?? '0'),
    ).toBeGreaterThan(800);
    // …and under the menu, so a click on the scrim is a dismissal rather than
    // a click through a row.
    expect(z).toBeGreaterThan(
      Number(/z-index:\s*(\d+)/.exec(rule('.spinoff-menu-scrim'))?.[1] ?? '0'),
    );
  });

  it('cannot grow wider than the window it is placed in', () => {
    expect(rule('.spinoff-menu')).toMatch(/max-width:\s*min\(/);
  });

  it('gives every row a touch target even at a pointer’s width', () => {
    const item = rule('.spinoff-menu-item');
    const min = Number(/min-height:\s*(\d+)px/.exec(item)?.[1] ?? '0');
    expect(min).toBeGreaterThanOrEqual(44);
  });
});

describe(`at ${SHEET} it is a bottom sheet`, () => {
  const sheet = media(SHEET);

  it('has a block at that width at all', () => {
    // Positive control for every assertion below: they all search `sheet`,
    // and an empty `sheet` would make each of them pass by finding nothing.
    expect(sheet, `no @media ${SHEET} block in the stylesheet`).not.toBe('');
    expect(sheet).toContain('.spinoff-menu');
  });

  it('pins to the bottom edge across the full width', () => {
    const menu = rule('.spinoff-menu', sheet);
    expect(menu, 'the sheet block does not restyle the menu').not.toBe('');
    expect(menu).toMatch(/position:\s*fixed/);
    expect(menu).toMatch(/left:\s*0/);
    expect(menu).toMatch(/right:\s*0/);
    expect(menu).toMatch(/bottom:/);
    // The popover's inline `top`/`left` come from `place()` and would fight
    // the sheet if they were not beaten.
    expect(menu).toMatch(/top:\s*auto\s*!important/);
    expect(menu).toMatch(/left:\s*0\s*!important/);
  });

  it('scrolls itself rather than running off the top of the screen', () => {
    const menu = rule('.spinoff-menu', sheet);
    expect(menu).toMatch(/max-height:\s*\d+vh/);
    expect(menu).toMatch(/overflow-y:\s*auto/);
  });

  it('keeps its last row above the home indicator', () => {
    expect(rule('.spinoff-menu', sheet)).toMatch(/padding-bottom:\s*env\(safe-area-inset-bottom/);
  });

  it('rides above the keyboard when one is up', () => {
    // Every other sheet in this app reads `--kb-bottom`; a sheet pinned to a
    // literal 0 sits behind the keyboard on the surface where talking and
    // typing alternate.
    expect(rule('.spinoff-menu', sheet)).toMatch(/bottom:\s*var\(--kb-bottom/);
  });

  it('dims the page behind it, which the popover does not', () => {
    expect(rule('.spinoff-menu-scrim', sheet)).toMatch(/background:\s*rgba/);
    // The contrast is the claim: at a pointer the scrim is an invisible
    // click-catcher, and dimming the whole document for a menu hung off a
    // word would be a modal interruption of a reading gesture.
    expect(rule('.spinoff-menu-scrim')).not.toMatch(/background:/);
  });

  it('grows the touch targets for a thumb', () => {
    const item = rule('.spinoff-menu-item', sheet);
    const min = Number(/min-height:\s*(\d+)px/.exec(item)?.[1] ?? '0');
    expect(min).toBeGreaterThanOrEqual(48);
  });
});

describe('the stylesheet stays mergeable', () => {
  it('sits under a banner with more file after it, not appended at EOF', () => {
    // The project's standing rule: two branches that both append at the end
    // of this file conflict every single time. "Not at EOF" is checkable —
    // the block is introduced by a banner, and another banner follows it.
    const at = CSS.indexOf('.spinoff-menu {');
    expect(at).toBeGreaterThan(0);
    const banner = /\/\* =+ [^*]* =+ \*\//g;
    const before = CSS.slice(0, at).match(banner) ?? [];
    const after = CSS.slice(at).match(banner) ?? [];
    expect(before.length, 'no section banner precedes the block').toBeGreaterThan(0);
    expect(after.length, 'the block is the last thing in the file').toBeGreaterThan(0);
  });
});
