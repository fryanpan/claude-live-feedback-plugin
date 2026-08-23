import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The goal band's stylesheet half (Bryan's live mockup review, 2026-08-23).
 *
 * These read `styles.css` as text because none of what they pin is reachable
 * from a DOM assertion in a layout-free test runner: what hides a folded
 * band's tasks, which numbers keep the avatar columns aligned, and what the
 * ≤1100 block does to the row. Each parse asserts it FOUND something before
 * judging it, so a renamed selector fails loudly rather than passing empty.
 */

const CSS = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8');

/** The body of the first `selector { … }` rule whose declarations match `has`. */
function ruleBody(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(CSS);
  return m?.[1] ?? '';
}

/** The right-hand padding of a `padding:` shorthand, in px. */
function rightPadding(selector: string): number {
  const body = ruleBody(selector);
  const decl = /(?:^|;)\s*padding:\s*([^;]+)/.exec(body)?.[1]?.trim() ?? '';
  expect(decl, `${selector} has no padding shorthand`).not.toBe('');
  const parts = decl.split(/\s+/).map((p) => Number.parseFloat(p));
  // 1 value: all sides; 2+: the second value is the right side.
  const right = parts.length === 1 ? parts[0] : parts[1];
  expect(Number.isNaN(right)).toBe(false);
  return right as number;
}

/** Every `@media <query> { … }` block's inner text, brace-matched — the
 *  stylesheet has several blocks per breakpoint and a rule may sit in any
 *  of them. */
function mediaBlocks(query: string): string {
  const out: string[] = [];
  let idx = 0;
  for (;;) {
    const at = CSS.indexOf(`@media ${query}`, idx);
    if (at === -1) break;
    const open = CSS.indexOf('{', at);
    let depth = 1;
    let i = open + 1;
    while (i < CSS.length && depth > 0) {
      if (CSS[i] === '{') depth += 1;
      else if (CSS[i] === '}') depth -= 1;
      i += 1;
    }
    out.push(CSS.slice(open + 1, i - 1));
    idx = i;
  }
  expect(out, `no @media ${query} block found`).not.toHaveLength(0);
  return out.join('\n');
}

/** The right padding a rule body declares — `padding-right` first, then the
 *  `padding` shorthand — or null when it declares neither. */
function declaredRight(body: string): number | null {
  const pr = /(?:^|;)\s*padding-right:\s*([^;]+)/.exec(body)?.[1];
  if (pr !== undefined) return Number.parseFloat(pr);
  const p = /(?:^|;)\s*padding:\s*([^;]+)/.exec(body)?.[1]?.trim();
  if (p === undefined) return null;
  const parts = p.split(/\s+/).map((x) => Number.parseFloat(x));
  const right = parts.length === 1 ? parts[0] : parts[1];
  return right === undefined || Number.isNaN(right) ? null : right;
}

/** The EFFECTIVE right padding of `selector` inside the given media blocks:
 *  the cascade's answer — an override in the block if one declares padding,
 *  else the base value. */
function effectiveRight(blocks: string, selector: string): number {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A rule can be preceded by a close-brace, a comma, a comment, or sit at
  // the start of its line — `^…m` covers the last two without letting the
  // selector match as the TAIL of a compound like `.hub-band .hub-task-row`
  // (`\s*` cannot consume the compound's head).
  const re = new RegExp(`(?:^|[},])\\s*${esc}\\s*\\{([^}]*)\\}`, 'gm');
  let effective = rightPadding(selector);
  for (let m = re.exec(blocks); m !== null; m = re.exec(blocks)) {
    const declared = declaredRight(m[1] ?? '');
    if (declared !== null) effective = declared;
  }
  return effective;
}

describe('the goal band stylesheet', () => {
  it('hides a folded band’s tasks — the goal row is all a collapsed band shows', () => {
    // Positive control: the tasks container has a rule at all.
    expect(ruleBody('.hub-band-tasks')).not.toBe('');
    expect(ruleBody('.hub-band.is-collapsed .hub-band-tasks')).toMatch(/display:\s*none/);
  });

  // Decision 8: the goal row's owner avatar sits in the same column as the
  // task rows'. That is arithmetic across three rules — the goal row's right
  // padding must equal the tasks' rail padding plus the task row's own —
  // and nothing else enforces it, so it is pinned here as the sum.
  it('keeps the avatar columns aligned: goal-row right pad = rail pad + task-row pad', () => {
    const goalRight = rightPadding('.hub-goal-row');
    const railRight = rightPadding('.hub-band-tasks');
    const taskRight = rightPadding('.hub-task-row');
    expect(goalRight).toBe(railRight + taskRight);
  });

  // The same arithmetic holds where the ≤900 block tightens the task row's
  // padding: the sum must be re-taken from the values the cascade actually
  // applies there, because the base sum stays true while the phone breaks.
  // (Shipped broken once: the ≤900 block shrank .hub-task-row to 2px and left
  // the goal row at 14px — a 4px drift at the 430px check CLAUDE.md mandates.)
  it('keeps the avatar columns aligned at ≤900px, where the task row tightens', () => {
    const blocks = mediaBlocks('(max-width: 900px)');
    const taskRight = effectiveRight(blocks, '.hub-task-row');
    // Positive control: the block really does move the task row's padding —
    // otherwise this test re-checks the base sum and proves nothing new.
    expect(taskRight).not.toBe(rightPadding('.hub-task-row'));
    expect(effectiveRight(blocks, '.hub-goal-row')).toBe(
      effectiveRight(blocks, '.hub-band-tasks') + taskRight,
    );
  });

  it('hides the goal caret on mobile, where the whole row already opens', () => {
    // The base caret is a hover affordance…
    expect(ruleBody('.hub-goal-open')).toMatch(/opacity:\s*0/);
    // …and the ≤1100 block removes it outright — a tap cannot hover, and its
    // 16px belong to the title there.
    expect(CSS).toMatch(/\.hub-goal-open\s*\{[^}]*display:\s*none/);
  });

  it('lets the mobile title wrap to two clamped lines instead of crushing to ellipsis', () => {
    expect(CSS).toMatch(/\.hub-goal-title-text\s*\{[^}]*-webkit-line-clamp:\s*2/);
  });

  it('mutes a done band’s title, and neutralises the reserved band’s accent', () => {
    expect(ruleBody('.hub-band-done .hub-goal-title-text')).toMatch(/color:\s*var\(--fg-muted\)/);
    expect(ruleBody('.hub-band-reserved .hub-goal-row')).toMatch(
      /border-left-color:\s*var\(--border\)/,
    );
  });
});
