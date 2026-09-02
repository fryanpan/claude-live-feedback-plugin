import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The pointer pill's stylesheet contract. happy-dom resolves no layout and
 * evaluates no media query, so what `mountPointerPill` cannot prove about
 * itself is asserted against the CSS text: that the pill is positioned in
 * viewport coordinates (the placement function works in nothing else), that
 * hiding keeps its box (it is measured while hidden, and a tap that blurred
 * the editor first still has to land on it), that a finger gets a 44px
 * target on the touch tiers, and — the one this replaces — that there is NO
 * bottom-sheet form at any width. The previous menu became a sheet at 560px;
 * a pill that leaves the pointer for the bottom of the screen on a phone is
 * the reach the pointer anchor exists to remove.
 *
 * How it actually reads at 1180×820 and 430px is measured in a browser and
 * reported with the PR.
 */
const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function rule(selector: string, within: string = declarationsOnly(CSS)): string {
  const at = new RegExp(
    `(^|\\n|\\{)\\s*${selector.replace(/[.+*[\]():]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(within);
  return at?.[2] ?? '';
}

/** Every `@media` block with this query, concatenated, braces counted. */
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

describe('the pointer pill is placed in viewport coordinates', () => {
  it('is fixed, and above the comment pill that made the selection', () => {
    const pill = rule('.pointer-pill');
    expect(pill, 'the pill has no rule at all').not.toBe('');
    expect(pill).toMatch(/position:\s*fixed/);
    // The caret pill sits at 800; a pill that opened BEHIND it would look
    // like one that failed to open.
    expect(Number(/z-index:\s*(\d+)/.exec(pill)?.[1] ?? '0')).toBeGreaterThan(800);
  });

  it('keeps its layout box while hidden', () => {
    const hidden = rule('.pointer-pill.hidden');
    expect(hidden).not.toBe('');
    expect(hidden).toMatch(/opacity:\s*0/);
    expect(hidden).toMatch(/pointer-events:\s*none/);
    // The app's global `.hidden` is display:none; this one has to beat it.
    expect(hidden).toMatch(/display:\s*inline-flex\s*!important/);
  });

  it('draws the arrow at --arrow-x and hides it when not above the anchor', () => {
    expect(rule('.pointer-pill::after')).toMatch(/left:\s*var\(--arrow-x/);
    expect(rule('.pointer-pill.no-arrow::after')).toMatch(/display:\s*none/);
  });
});

describe('the buttons are targets, not text', () => {
  it('reach 44px on the touch tiers and stay clickable at a pointer', () => {
    const base = Number(/min-height:\s*(\d+)px/.exec(rule('.pointer-pill-btn'))?.[1] ?? '0');
    expect(base).toBeGreaterThanOrEqual(36);
    const mobile = media('(max-width: 1100px)');
    expect(mobile, 'no mobile-tier block').not.toBe('');
    const touch = Number(
      /min-height:\s*(\d+)px/.exec(rule('.pointer-pill-btn', mobile))?.[1] ?? '0',
    );
    expect(touch).toBeGreaterThanOrEqual(44);
  });
});

describe('there is no bottom sheet', () => {
  it('never restyles the pill at the sheet breakpoint the old menu used', () => {
    // Positive control: the breakpoint itself still exists for the menus
    // that ARE sheets, so an empty match here would be the pill's absence,
    // not the block's.
    const sheet = media('(max-width: 560px)');
    expect(sheet).not.toBe('');
    expect(sheet).not.toContain('.pointer-pill');
    // And the old menu is gone with its sheet — no selector left to style.
    expect(declarationsOnly(CSS)).not.toContain('.spinoff-menu');
  });
});

describe('the stylesheet stays mergeable', () => {
  it('sits under a banner with more file after it, not appended at EOF', () => {
    const at = CSS.indexOf('.pointer-pill {');
    expect(at).toBeGreaterThan(0);
    const banner = /\/\* =+ [^*]* =+ \*\//g;
    expect((CSS.slice(0, at).match(banner) ?? []).length).toBeGreaterThan(0);
    expect((CSS.slice(at).match(banner) ?? []).length).toBeGreaterThan(0);
  });
});
