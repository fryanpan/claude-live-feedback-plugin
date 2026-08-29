import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The recent-edit wash (edit-wash.ts) is a pastel of the editor's OWN color,
 * light enough to read through, and it never prints — a printed huddle doc
 * is the record, not the live session.
 *
 * Stylesheet properties — happy-dom resolves no layout, so these are read
 * off the CSS text the way the other *-css suites do.
 */
const CSS = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

function rule(selector: string, within: string = CSS): string {
  const at = new RegExp(
    `(^|\\n|\\{)\\s*${selector.replace(/[.+*[\]()>]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(within);
  return at?.[2] ?? '';
}

function media(query: string): string {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = CSS.indexOf(`@media ${query}`, from);
    if (start < 0) break;
    let depth = 0;
    for (let i = CSS.indexOf('{', start); i < CSS.length; i++) {
      if (CSS[i] === '{') depth++;
      else if (CSS[i] === '}' && --depth === 0) {
        out.push(CSS.slice(start, i));
        from = i;
        break;
      }
    }
    if (from <= start) break;
  }
  return out.join('\n');
}

describe('recent-edit wash styling', () => {
  const wash = rule('#editor > .ProseMirror .edit-wash');

  it('tints the block with the editor’s own color at a light alpha', () => {
    expect(wash).toContain('var(--edit-color');
    expect(wash).toMatch(
      /background:\s*color-mix\(in srgb, var\(--edit-color.*\) var\(--edit-alpha\)/,
    );
    // Most recent = strongest; all three inside the ~10-12% pastel band.
    const alpha = (rank: number) =>
      Number(/--edit-alpha:\s*(\d+)%/.exec(rule(`#editor > .ProseMirror .edit-wash-${rank}`))?.[1]);
    expect(alpha(1)).toBeGreaterThan(alpha(2));
    expect(alpha(2)).toBeGreaterThan(alpha(3));
    expect(alpha(1)).toBeLessThanOrEqual(12);
    expect(alpha(3)).toBeGreaterThanOrEqual(6);
  });

  it('keeps the text where it was — the bar sits in the editor gutter', () => {
    expect(wash).toMatch(/margin-left:\s*-(\d+)px/);
    const gutter = Number(/margin-left:\s*-(\d+)px/.exec(wash)?.[1]);
    const pad = Number(/padding-left:\s*(\d+)px/.exec(wash)?.[1]);
    const bar = Number(/border-left:\s*(\d+)px/.exec(wash)?.[1]);
    expect(pad + bar).toBe(gutter);
  });

  it('does not print', () => {
    const printed = rule('#editor > .ProseMirror .edit-wash', media('print'));
    expect(printed).toMatch(/background:\s*(none|transparent)/);
    expect(printed).toMatch(/border-left:\s*(0|none)/);
  });
});
