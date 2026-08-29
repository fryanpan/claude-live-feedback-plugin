import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Commenting on a review item, as LAYOUT: the pill, the thread card, the
 * "See thread" link and the revised-phrase mark, at the two sizes the
 * project verifies (1180×820 iPad landscape, where HEIGHT is the scarce
 * axis; 430px phone, where thumbs are).
 *
 * happy-dom has no layout engine, so this asserts the DECLARATIONS that give
 * the targets their floors and keep the card from spending height it does
 * not have. A browser measurement against a real build closes the criterion.
 */
const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The body of `selector`'s rule. At top level the selector must start its
 * line unindented — the same selector inside a media block is indented, and
 * is what `within` (a `media()` extract) is for.
 */
function rule(selector: string, within?: string): string {
  const escaped = selector.replace(/[.+*[\]()]/g, '\\$&');
  const at = new RegExp(
    within === undefined
      ? `(^|\\n)${escaped}\\s*\\{([^}]*)\\}`
      : `(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`,
  ).exec(within ?? declarationsOnly(CSS));
  return at?.[2] ?? '';
}

/** Every `@media <query> { … }` block in the sheet, joined — the hub writes
 *  several blocks for one query, one per section. */
function media(query: string): string {
  const src = declarationsOnly(CSS);
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = src.indexOf(`@media ${query}`, from);
    if (start < 0) break;
    let depth = 0;
    let end = -1;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end < 0) break;
    blocks.push(src.slice(start, end));
    from = end;
  }
  return blocks.join('\n');
}

describe('the review-item comment furniture is thumb-sized and height-frugal', () => {
  it('the See-thread link is an atomic box with a 36px floor', () => {
    const body = rule('.hub-walk-thread-link');
    expect(body, '.hub-walk-thread-link has no rule').not.toBe('');
    expect(body).toContain('inline-flex');
    expect(body).toMatch(/min-height:\s*36px/);
  });

  it('on the phone tier the pill and both thread links grow to 44px', () => {
    const phone = media('(max-width: 1100px)');
    expect(phone, 'no ≤1100px block').not.toBe('');
    for (const sel of ['.hub-walk-pill', '.hub-walk-thread-link', '.hub-review-thread-link']) {
      const body = rule(sel, phone);
      expect(body, `${sel} has no phone rule`).not.toBe('');
      expect(body, sel).toMatch(/min-height:\s*44px/);
    }
    expect(rule('.hub-walk-pill', phone)).toMatch(/min-width:\s*44px/);
  });

  it('the thread card takes no fixed height — 1180×820 has ~750px usable', () => {
    const card = rule('.hub-walk-thread');
    expect(card, '.hub-walk-thread has no rule').not.toBe('');
    expect(card).not.toMatch(/(^|[^-])height:/);
    expect(card).not.toMatch(/min-height:/);
  });

  it('the ask box stacks under a thumb like the answer box does', () => {
    // The stacked-composer rule the answer box has at ≤900px must name the
    // thread form too, or the field and its button sit side by side at 430px.
    const src = declarationsOnly(CSS);
    const at = src.indexOf('.hub-walk-answer,\n  .hub-walk-thread-form {');
    expect(at, 'the ≤900px stacking rule does not cover .hub-walk-thread-form').toBeGreaterThan(-1);
    expect(src.slice(at, at + 200)).toContain('flex-direction: column');
  });

  it('the revised phrase wears the editor’s resolved-range treatment inside the card body', () => {
    expect(rule('.hub-walk-body .thread-range')).not.toBe('');
    const resolved = rule('.hub-walk-body .thread-range.resolved');
    expect(resolved, 'no resolved rule for the card body').not.toBe('');
    expect(resolved).toMatch(/background:/);
  });

  it('the old “Tell me more” box left with its rules', () => {
    // Negative control on the positive assertions above: the extractor
    // reports an empty body for a selector that is genuinely gone.
    expect(rule('.hub-walk-more')).toBe('');
    expect(rule('.hub-walk-info')).toBe('');
  });
});
