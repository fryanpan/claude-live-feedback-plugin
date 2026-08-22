import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderWorkspaceIdentity } from '../src/hub/hub-render.ts';

/**
 * The topbar's two mutable facts: the board's NAME and whether it has been
 * RETIRED.
 *
 * Both were impossible until now — `createWorkspace` set the name once and
 * nothing changed it, and there was no such thing as a retired board — so the
 * shell painted the header at boot and never again. This page does not
 * reload, so that is now a header that goes stale the moment either verb
 * lands.
 *
 * The badge is what the 2026-08-19 incident was missing. Two boards carried
 * one name and one lead agent, and the only way to tell the stale one from
 * the live one was to read both goal lists. A word in the header is the
 * cheapest form of that answer.
 *
 * The CSS half is read as TEXT, not measured: happy-dom has no layout engine,
 * so an assertion about a rendered pixel here would be an assertion about
 * nothing. What the rules have to guarantee is stated as rules — the badge
 * never grows the 48px topbar row (the iPad's scarce axis is HEIGHT), and the
 * NAME is what truncates when the row runs out of width at 430px, never the
 * badge.
 */
describe('renderWorkspaceIdentity', () => {
  let nameEl: HTMLElement;
  let badgeEl: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML =
      '<span class="hub-ws-name"><span id="n" class="hub-ws-name-text"></span>' +
      '<span id="b" class="hub-retired-badge hidden">Retired</span></span>';
    nameEl = document.getElementById('n') as HTMLElement;
    badgeEl = document.getElementById('b') as HTMLElement;
  });

  it('writes the name and leaves the badge hidden on a live board', () => {
    renderWorkspaceIdentity(nameEl, badgeEl, { name: 'harbor-relay' }, 'w-fallback');
    expect(nameEl.textContent).toBe('harbor-relay');
    expect(badgeEl.classList.contains('hidden')).toBe(true);
    expect(badgeEl.title).toBe('');
  });

  it('shows the badge on a retired board and puts the reason on it', () => {
    renderWorkspaceIdentity(
      nameEl,
      badgeEl,
      { name: 'harbor-relay', retiredAt: Date.UTC(2026, 7, 19), retiredReason: 'superseded' },
      'w-fallback',
    );
    expect(badgeEl.classList.contains('hidden')).toBe(false);
    // The reason is the only actionable half — usually the name of the board
    // that replaced this one — so losing it would leave a dead end.
    expect(badgeEl.title).toContain('superseded');
    expect(badgeEl.title).toContain('Retired');
  });

  it('un-retiring hides it again — the badge is state, not a tombstone', () => {
    const retired = { name: 'harbor-relay', retiredAt: Date.UTC(2026, 7, 19) };
    renderWorkspaceIdentity(nameEl, badgeEl, retired, 'w-fallback');
    expect(badgeEl.classList.contains('hidden')).toBe(false);
    renderWorkspaceIdentity(nameEl, badgeEl, { name: 'harbor-relay' }, 'w-fallback');
    expect(badgeEl.classList.contains('hidden')).toBe(true);
    expect(badgeEl.title).toBe('');
  });

  it('repaints the name when the board is renamed under the reader', () => {
    renderWorkspaceIdentity(nameEl, badgeEl, { name: 'harbor-relay' }, 'w-fallback');
    renderWorkspaceIdentity(nameEl, badgeEl, { name: 'harbor-relay-september' }, 'w-fallback');
    expect(nameEl.textContent).toBe('harbor-relay-september');
  });

  it('falls back to the id before the first read lands', () => {
    renderWorkspaceIdentity(nameEl, badgeEl, null, 'w-fallback');
    expect(nameEl.textContent).toBe('w-fallback');
    expect(badgeEl.classList.contains('hidden')).toBe(true);
  });
});

const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

/** The declarations of the first rule whose selector list contains `sel`. */
function block(sel: string): string {
  const at = CSS.indexOf(sel);
  expect(at, `no rule for ${sel}`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', at);
  return CSS.slice(open + 1, CSS.indexOf('}', open));
}

describe('the retired badge cannot break the topbar', () => {
  /**
   * The iPad in landscape has ~750px of usable height, about half a monitor,
   * so a row that grows by a few pixels is a real complaint there and
   * invisible on a desktop. The badge must therefore live INSIDE the existing
   * 48px row: a small font, hairline padding, and no block-level box of its
   * own.
   */
  it('sits inside the existing row rather than adding a line to it', () => {
    const badge = block('.hub-retired-badge {');
    expect(badge).toMatch(/font-size:\s*11px/);
    // 1px top/bottom against a 17px name in a 48px min-height row: the row's
    // height is set by the name and the 36px tap targets beside it, and this
    // is far below both.
    expect(badge).toMatch(/padding:\s*1px\s+7px/);
    expect(badge).not.toMatch(/display:\s*block/);
    // A wrapped badge would push the row taller; it stays on the name's line.
    expect(badge).toMatch(/white-space:\s*nowrap/);
  });

  /**
   * At 430px the name is what runs out of room. The badge must survive that,
   * because a board whose "Retired" is the thing that got ellipsised reads as
   * live — which is the failure, not a cosmetic one.
   */
  it('truncates the NAME and never the badge when width runs out', () => {
    const row = block('.hub-ws-name {');
    // The flex row can shrink below its content — without this the grid
    // column refuses to shrink and the whole cluster is pushed off-screen.
    expect(row).toMatch(/display:\s*flex/);
    expect(row).toMatch(/min-width:\s*0/);
    // The ellipsis moved OFF the row and onto the name text, which is the
    // half that makes the badge safe.
    expect(row).not.toMatch(/text-overflow/);

    const text = block('.hub-ws-name-text {');
    expect(text).toMatch(/text-overflow:\s*ellipsis/);
    expect(text).toMatch(/overflow:\s*hidden/);
    expect(text).toMatch(/white-space:\s*nowrap/);

    // `0 0 auto`: never grow, never SHRINK. The shrink half is the one that
    // matters — flex items default to shrinking, so without it the badge is
    // squeezed before the name is.
    expect(block('.hub-retired-badge {')).toMatch(/flex:\s*0\s+0\s+auto/);
  });
});
