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

/** The bodies of every `@media (max-width: 1100px)` block — the phone tier —
 *  joined, so `rule(sel, phoneTier())` reads what a selector gets there and
 *  nowhere else. Brace-walked rather than regexed: a media block nests rules. */
function phoneTier(): string {
  const css = declarationsOnly(CSS);
  const open = '@media (max-width: 1100px) {';
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(open, from);
    if (at < 0) break;
    let depth = 1;
    let i = at + open.length;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
    }
    bodies.push(css.slice(at + open.length, i - 1));
    from = i;
  }
  return bodies.join('\n');
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

  it('the board foot line is small and quiet, and a 44px thumb target on the phone tier', () => {
    // Bryan, 2026-08-29: the archived link moved from above the first goal
    // to after the last band. Down there it is a footnote — muted text, not a
    // button skin, no right-alignment pulling the eye — but the thing you tap
    // still has to clear the phone-tier floor from design-mobile.md.
    const foot = rule('.hub-board-foot');
    expect(foot).not.toBe('');
    expect(foot).not.toContain('flex-end');
    const link = rule('.hub-board-foot-archived');
    expect(link).toMatch(/font-size:\s*1[0-3](?:\.\d+)?px/);
    expect(rule('.hub-board-foot-archived', phoneTier())).toContain('min-height: 44px');
    // Positive control: the phone-tier reader really does see rules, and the
    // old top-of-board rule is gone rather than merely joined by a new one.
    expect(rule('.hub-quick-actions .hub-btn', phoneTier())).toContain('min-height: 44px');
    expect(rule('.hub-board-meta')).toBe('');
  });

  it('the archived note reuses the parked note`s neutral wash, not an alarm colour', () => {
    const note = rule('.hub-archived-note');
    expect(note).toContain('color-mix(in srgb, var(--fg-muted) 6%, transparent)');
  });
});
