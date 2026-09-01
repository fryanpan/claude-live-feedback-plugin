import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The doc editor's list indent (meeting-notes UX plan AC 3a): at the first
 * nesting level the bullet marker must sit clearly RIGHT of where body
 * paragraph text starts — the whole list block is indented relative to
 * prose. happy-dom resolves no layout, so the value is read off the CSS
 * text the way the other *-css suites do.
 *
 * Comments are stripped BEFORE parsing, and a selector that cannot be found
 * throws — a lookup that answered empty must fail the test, never pass
 * vacuously (learnings.md: "A hand-rolled CSS parser … disarms itself").
 */
const CSS = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** Body of the rule whose selector list is exactly `selectors`; throws if absent. */
function rule(selectors: string[]): string {
  const pattern = selectors.map((s) => s.replace(/[.+*[\]()>]/g, '\\$&')).join(',\\s*');
  const match = new RegExp(`(^|\\n|\\})\\s*${pattern}\\s*\\{([^}]*)\\}`).exec(CSS);
  if (!match) throw new Error(`rule not found for selectors: ${selectors.join(', ')}`);
  return match[2];
}

describe('editor list indent', () => {
  it('indents editor lists clearly right of the body-paragraph text margin', () => {
    const body = rule(['#editor > .ProseMirror ul', '#editor > .ProseMirror ol']);
    const padding = /padding-left:\s*(\d+)px/.exec(body);
    if (!padding) throw new Error(`no px padding-left in editor list rule: ${body.trim()}`);
    // An outside marker occupies roughly 22px left of the item's text edge
    // at the editor's 16px base size, so anything under ~36px leaves the
    // level-1 marker visually flush with the paragraph margin instead of
    // clearly right of it.
    expect(Number(padding[1])).toBeGreaterThanOrEqual(36);
  });
});
