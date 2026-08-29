import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The two buttons that replaced the Board's quick-add box, as stylesheet
 * facts — happy-dom resolves no layout, so the two numbers that matter are
 * asserted against the rules.
 *
 * At 1180×820 (the iPad, where HEIGHT is the scarce axis) the pair must cost
 * no more vertical room than the box it replaced; at 430px each button is a
 * thumb target. What a browser still has to confirm is in the PR body.
 */
const SRC = resolve(import.meta.dirname, '../src');
const CSS = readFileSync(resolve(SRC, 'styles.css'), 'utf8');

/** The box the buttons replaced: `.hub-quick-input { min-height: 40px }`. */
const OLD_BOX_MIN_HEIGHT = 40;

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function rule(selector: string, within: string = declarationsOnly(CSS)): string {
  const at = new RegExp(
    `(^|\\n|\\{)\\s*${selector.replace(/[.+*[\]():#-]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(within);
  return at?.[2] ?? '';
}

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

function px(decl: string, prop: string): number {
  return Number(new RegExp(`${prop}:\\s*(\\d+)px`).exec(decl)?.[1]);
}

/** Everything under one banner, up to the next banner. */
function section(banner: RegExp): string {
  const at = banner.exec(CSS);
  if (!at) return '';
  const rest = CSS.slice(at.index + at[0].length);
  const next = /\n\/\* =+ [A-Z]/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

describe('the quick-add box is gone from the stylesheet too', () => {
  it('has no rules for the box, its form, or its mic', () => {
    for (const sel of [
      '.hub-quick-input',
      '.hub-quick-form',
      '.hub-quick-mic',
      '.hub-quick-submit',
    ]) {
      expect(rule(sel), `${sel} is still styled`).toBe('');
    }
    // Positive control: the finder does see the rules that stayed.
    expect(rule('.hub-quick')).toMatch(/margin-bottom/);
  });
});

describe('the pair sits in the slot the box had', () => {
  it('is one wrapping row in the WORKSPACE HUB section', () => {
    const hub = section(/\/\* =+ WORKSPACE HUB =+/);
    expect(hub, 'the hub banner went missing').not.toBe('');
    expect(rule('.hub-quick-actions', declarationsOnly(hub))).toMatch(/display:\s*flex/);
    expect(rule('.hub-quick-actions', declarationsOnly(hub))).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.hub-quick-actions', declarationsOnly(hub))).toMatch(/gap:\s*\d+px/);
  });

  it('costs no more height than the box at 1180×820', () => {
    // The buttons are `.hub-btn`s; whichever rule sizes them on the tablet
    // tier must stay within the box's 40px. Both: the base, and any override
    // this section adds outside a media block.
    const base = px(rule('.hub-btn'), 'min-height');
    expect(base).toBeGreaterThan(0); // control: the base rule was found
    expect(base).toBeLessThanOrEqual(OLD_BOX_MIN_HEIGHT);
    const own = rule('.hub-quick-actions .hub-btn');
    expect(own, 'the pair has no rule of its own').not.toBe('');
    if (/min-height/.test(own)) {
      expect(px(own, 'min-height')).toBeLessThanOrEqual(OLD_BOX_MIN_HEIGHT);
    }
    // The slot's own spacing did not grow with the swap.
    expect(px(rule('.hub-quick'), 'margin-bottom')).toBeLessThanOrEqual(10);
  });

  it('is a 44px thumb target at 430px', () => {
    const mobile = media('(max-width: 1100px)');
    expect(mobile, 'no ≤1100px block').not.toBe('');
    expect(px(rule('.hub-quick-actions .hub-btn', mobile), 'min-height')).toBeGreaterThanOrEqual(
      44,
    );
  });

  it('sizes the huddle button’s mic glyph as a box, like every other mic', () => {
    const glyph = rule('.hub-huddle-start svg');
    expect(glyph).toMatch(/width:\s*\d+px/);
    expect(glyph).toMatch(/height:\s*\d+px/);
  });
});

describe('the editor names a huddle in its crumb', () => {
  it('styles the label in the TOP BAR section rather than at the end of the file', () => {
    const topbar = section(/\/\* =+ TOP BAR =+/);
    expect(topbar, 'the top bar banner went missing').not.toBe('');
    expect(rule('.doc-label-huddle', declarationsOnly(topbar))).not.toBe('');
  });
});
