import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The task's Activity feed as LAYOUT: note rows, their kind label, the fold
 * on a long note, the marked phrase and the pill, at the two sizes the
 * project verifies (1180×820 iPad landscape, where HEIGHT is the scarce
 * axis; 430px phone, where thumbs are).
 *
 * happy-dom has no layout engine, so this asserts the DECLARATIONS. A
 * browser measurement against a real build closes the criterion.
 */
const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function rule(selector: string, within?: string): string {
  const escaped = selector.replace(/[.+*[\]()]/g, '\\$&');
  const at = new RegExp(
    within === undefined
      ? `(^|\\n)${escaped}\\s*\\{([^}]*)\\}`
      : `(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`,
  ).exec(within ?? declarationsOnly(CSS));
  return at?.[2] ?? '';
}

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

describe('the task Activity feed is height-frugal at the tablet tier', () => {
  it('a feed row and a note body take no fixed height', () => {
    for (const sel of ['.hub-hist-row', '.hub-note-body']) {
      const body = rule(sel);
      expect(body, `${sel} has no rule`).not.toBe('');
      expect(body, sel).not.toMatch(/(^|[^-])height:/);
      expect(body, sel).not.toMatch(/min-height:/);
    }
  });

  it('a folded note clips to a line budget rather than a pixel height, and the toggle is small', () => {
    const folded = rule('.hub-note-body.is-folded');
    expect(folded, 'no fold rule').not.toBe('');
    expect(folded).toMatch(/max-height:\s*[\d.]+(em|lh)/);
    expect(folded).toMatch(/overflow:\s*hidden/);
    const more = rule('.hub-note-more');
    expect(more, 'no .hub-note-more rule').not.toBe('');
    expect(more).not.toMatch(/(^|[^-])height:/);
  });

  it('the kind label is a small caps token beside the agent and the age', () => {
    const kind = rule('.hub-note-kind');
    expect(kind, 'no .hub-note-kind rule').not.toBe('');
    expect(kind).toMatch(/text-transform:\s*uppercase/);
    expect(kind).toMatch(/font-size:\s*1[01](\.\d+)?px/);
  });

  it('a note body wraps an unbroken token instead of widening the panel', () => {
    // A status note is posted raw (no reduction), so one 700-char hash or
    // path must wrap inside the row rather than scroll the whole panel.
    expect(rule('.hub-note-body')).toMatch(/overflow-wrap:\s*anywhere/);
    const code = rule('.cm-code');
    expect(code, 'no .cm-code rule').not.toBe('');
    expect(code).toMatch(/white-space:\s*pre-wrap/);
    expect(code).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('a status token is tinted so a milestone reads apart from a routine turn', () => {
    const status = rule('.hub-hist-row-status .hub-note-kind');
    expect(status, 'no status kind rule').not.toBe('');
    expect(status).toMatch(/color:/);
    expect(status).not.toBe(rule('.hub-hist-row-denial .hub-note-kind'));
  });

  it('the marked phrase in the feed wears the active thread-range treatment', () => {
    const mark = rule('.hub-detail-transitions .thread-range');
    expect(mark, 'no mark rule in the feed').not.toBe('');
    expect(mark).toMatch(/background:/);
  });
});

describe('the task Activity feed is thumb-sized on the phone tier', () => {
  it('the fold toggle and the pill grow to 44px at ≤1100px', () => {
    const phone = media('(max-width: 1100px)');
    expect(phone, 'no ≤1100px block').not.toBe('');
    expect(rule('.hub-note-more', phone)).toMatch(/min-height:\s*44px/);
    const pill = rule('.hub-hist-pill', phone);
    expect(pill, '.hub-hist-pill has no phone rule').not.toBe('');
    expect(pill).toMatch(/min-width:\s*44px/);
    expect(pill).toMatch(/min-height:\s*44px/);
  });

  it('negative control: a selector the sheet does not have reads as empty', () => {
    expect(rule('.hub-hist-nothing')).toBe('');
  });
});
