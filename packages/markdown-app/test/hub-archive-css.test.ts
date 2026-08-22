import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The archive feature's LAYOUT rules — the half no DOM test can see, because
 * happy-dom resolves no layout.
 *
 * Two properties are load-bearing rather than cosmetic, and both are about the
 * 430px end of the range. The restore row WRAPS, so a long reason drops the
 * Restore button to its own line instead of squeezing the title to nothing;
 * and every control this feature adds clears the 36px thumb floor from
 * design-mobile.md — the Undo especially, since it is the only thing standing
 * in for the confirm dialog this design deliberately does not ask for.
 */
const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function rule(selector: string, within: string = declarationsOnly(CSS)): string {
  const at = new RegExp(
    `(^|\\n|\\{)\\s*${selector.replace(/[.+*[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(within);
  return at?.[2] ?? '';
}

describe('archive CSS', () => {
  it('the restore row wraps, so the button drops rather than crushing the title', () => {
    const row = rule('.hub-archived-row');
    expect(row).toContain('flex-wrap: wrap');
    // Positive control: the selector really was found, not silently empty.
    expect(row).toContain('display: flex');
  });

  it('the archived title can shrink — min-width:0 is what allows the ellipsis', () => {
    expect(rule('.hub-archived-title')).toContain('min-width: 0');
  });

  it('every added control clears the 36px thumb floor', () => {
    for (const sel of ['.hub-archived-restore', '.hub-toast-action']) {
      expect(rule(sel), sel).toContain('min-height: 36px');
    }
  });

  it('the toast lays its action out beside the text rather than under it', () => {
    const toast = rule('.hub-toast');
    expect(toast).toContain('display: flex');
    expect(toast).toContain('align-items: center');
  });

  it('the board meta line is right-aligned, away from the first goal title', () => {
    expect(rule('.hub-board-meta')).toContain('justify-content: flex-end');
  });

  it('the archived note reuses the parked note`s neutral wash, not an alarm colour', () => {
    const note = rule('.hub-archived-note');
    expect(note).toContain('color-mix(in srgb, var(--fg-muted) 6%, transparent)');
  });
});
