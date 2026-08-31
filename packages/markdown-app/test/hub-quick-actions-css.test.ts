import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The buttons that replaced the Board's quick-add box, as stylesheet
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

/**
 * The block whose selector LIST contains this selector — `rule()` above only
 * finds a selector that is the last one before the brace, which silently
 * stops seeing a rule the moment somebody adds another selector after it.
 */
function ruleWith(
  selector: string,
  within: string = declarationsOnly(CSS),
): { selectors: string; decls: string } {
  for (const m of within.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = (m[1] ?? '').split(',').map((s) => s.trim());
    if (sels.includes(selector)) return { selectors: m[1] ?? '', decls: m[2] ?? '' };
  }
  return { selectors: '', decls: '' };
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

describe('the buttons sit in the slot the box had', () => {
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

  it('sizes EVERY quick-action glyph as a box, like every other mic', () => {
    // Measured in headless Chromium, 2026-08-30: the conversation button's
    // two-person glyph was left out of this rule and rendered at its
    // intrinsic 24px, which stretched the whole row from 44px to 71px — on
    // the tier where height is the scarce axis. A grouped rule is easy to
    // add a button beside and forget, so this asserts the LIST.
    const glyph = ruleWith('.hub-conversation-start svg');
    expect(glyph.decls).toMatch(/width:\s*\d+px/);
    expect(glyph.decls).toMatch(/height:\s*\d+px/);
    for (const sel of [
      '.hub-quick-new svg',
      '.hub-huddle-start svg',
      '.hub-conversation-start svg',
    ]) {
      expect(glyph.selectors, `${sel} is not sized`).toContain(sel);
    }
    // Control: the finder answers nothing for a selector nobody styles.
    expect(ruleWith('.hub-nonexistent-button svg').decls).toBe('');
  });
});

describe('an unnamed task reads as a stand-in, not a title', () => {
  it('mutes the placeholder in the WORKSPACE HUB section', () => {
    // task-detail-island toggles this class while `task.untitled` is set;
    // happy-dom cannot see whether a rule exists for it, so this does.
    const hub = section(/\/\* =+ WORKSPACE HUB =+/);
    const placeholder = rule('.hub-detail-title-placeholder', declarationsOnly(hub));
    expect(placeholder, 'the placeholder class has no rule').not.toBe('');
    expect(placeholder).toMatch(/color:\s*var\(--fg-muted\)/);
    // Control: the title rule it modifies is in the same section.
    expect(rule('.hub-detail-title', declarationsOnly(hub))).toMatch(/font-weight/);
  });
});

describe('the editor names a huddle in its crumb', () => {
  it('styles the label in the TOP BAR section rather than at the end of the file', () => {
    const topbar = section(/\/\* =+ TOP BAR =+/);
    expect(topbar, 'the top bar banner went missing').not.toBe('');
    expect(rule('.doc-label-huddle', declarationsOnly(topbar))).not.toBe('');
  });
});
