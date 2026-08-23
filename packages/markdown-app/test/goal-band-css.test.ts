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
