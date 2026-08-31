import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The reassign menu's SHAPE, asserted in the stylesheet.
 *
 * happy-dom resolves no media queries and lays nothing out, so what a test
 * can hold here is the cascade: that the phone block exists, that it turns
 * the menu into a bottom sheet, and that the base rules it has to beat are
 * declared before it (a media query adds no specificity — source order is
 * the whole of it). The rendered result is measured in a real browser at
 * 1180x820 and 430px; that is what closes the criterion.
 */
const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');
const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The body of the `@media` block for `cond` that mentions `needle`.
 *
 * By needle rather than by "the first one": the stylesheet already has
 * several blocks at this width — the hub's is 20k characters earlier — and a
 * helper that took the first would assert against somebody else's rules and
 * pass or fail for reasons that have nothing to do with this menu.
 */
function mediaBlock(cond: string, needle: string): string {
  const open = `@media ${cond} {`;
  for (let from = 0; ; ) {
    const at = CSS.indexOf(open, from);
    expect(at, `no ${open} block containing ${needle}`).toBeGreaterThanOrEqual(0);
    let depth = 1;
    let i = at + open.length;
    while (i < CSS.length && depth > 0) {
      if (CSS[i] === '{') depth++;
      else if (CSS[i] === '}') depth--;
      i++;
    }
    const body = CSS.slice(at + open.length, i - 1);
    if (body.includes(needle)) return body;
    from = i;
  }
}

/** Where the block asserted above starts, for source-order checks. */
function mediaBlockStart(cond: string, needle: string): number {
  const body = mediaBlock(cond, needle);
  return CSS.indexOf(body);
}

describe('the reassign menu in the stylesheet', () => {
  it('lives in the editor section, not appended at the end of the file', () => {
    // Parallel branches that both append at EOF conflict every time.
    const menuAt = CSS.indexOf('.speaker-menu {');
    expect(menuAt).toBeGreaterThanOrEqual(0);
    expect(menuAt).toBeLessThan(CSS.lastIndexOf('/* ================='));
  });

  it('becomes a bottom sheet at phone width', () => {
    const phone = withoutComments(mediaBlock('(max-width: 560px)', '.speaker-menu'));
    expect(phone).toContain('.speaker-menu');
    expect(phone).toMatch(/position:\s*fixed/);
    // Pinned to the bottom and riding above the keyboard, like the threads
    // sheet — a menu behind the keyboard cannot be tapped.
    expect(phone).toMatch(/bottom:\s*var\(--kb-bottom/);
    // The inline placement JS writes top/left; the sheet has to win.
    expect(phone).toMatch(/top:\s*auto\s*!important/);
    expect(phone).toMatch(/left:\s*0\s*!important/);
  });

  it('declares the sheet AFTER the base rule it overrides', () => {
    expect(mediaBlockStart('(max-width: 560px)', '.speaker-menu')).toBeGreaterThan(
      CSS.indexOf('.speaker-menu {'),
    );
  });

  it('dims the page behind the sheet, and only there', () => {
    const phone = withoutComments(mediaBlock('(max-width: 560px)', '.speaker-menu'));
    expect(phone).toMatch(/\.speaker-menu-scrim\s*\{[^}]*background/);
    // On a pointer the scrim only catches the dismissing click; a dimmed
    // page for a small menu next to the cursor would be a modal, and this
    // is not one.
    const base = withoutComments(CSS).match(/\.speaker-menu-scrim\s*\{[^}]*\}/)?.[0] ?? '';
    expect(base).not.toMatch(/background/);
  });

  it('makes the tag itself look like the control it now is', () => {
    const chip =
      withoutComments(CSS).match(
        /#editor > \.ProseMirror a\[href\^='?"?speaker:'?"?\]\s*\{[^}]*\}/,
      )?.[0] ?? '';
    expect(chip).toMatch(/cursor:\s*pointer/);
  });

  it('grows the tag’s hit box on a touch pointer only', () => {
    // Measured at 430px: 18.4px of ink, 38px of hit box with this rule.
    // The same overlay on a mouse would reach into neighbouring lines and
    // steal their tags' clicks, so it is touch-only.
    const coarse = withoutComments(mediaBlock('(pointer: coarse)', 'speaker:'));
    expect(coarse).toContain('speaker:');
    expect(coarse).toMatch(/inset:\s*-10px/);
  });
});
