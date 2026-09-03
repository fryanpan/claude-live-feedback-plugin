import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderWorkspaceIdentity } from '../src/hub/hub-render.ts';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

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
 * The CSS half is measured, not read as text. happy-dom lays nothing out, so
 * the rendered pixel is still a browser check (`bun run ui:shot`) — but the
 * DECLARED values the browser would lay out with are the cascade's answer,
 * and reading them off the rendered badge catches what a text read cannot: a
 * rule a later one overrides, a selector the badge no longer carries, a
 * declaration inside a media query that does not match. What has to hold is
 * that the badge never grows the 48px topbar row (the iPad's scarce axis is
 * HEIGHT), and that the NAME is what truncates when the row runs out of width
 * at 430px, never the badge.
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

/**
 * The identity cluster the topbar actually paints, at a stated viewport.
 *
 * Both tiers are checked because the whole point of the badge rules is that
 * they hold where width runs out: happy-dom's default is 1024px, which sits
 * inside this project's MOBILE tier, so a test that never states a viewport is
 * reading the phone cascade while looking like it reads the desktop one.
 */
function paintIdentity(viewport: { width: number; height: number }) {
  setViewport(viewport);
  document.body.innerHTML =
    '<span class="hub-ws-name"><span id="n" class="hub-ws-name-text"></span>' +
    '<span id="b" class="hub-retired-badge hidden">Retired</span></span>';
  const name = document.getElementById('n') as HTMLElement;
  const badge = document.getElementById('b') as HTMLElement;
  renderWorkspaceIdentity(
    name,
    badge,
    { name: 'harbor-relay', retiredAt: Date.UTC(2026, 7, 19), retiredReason: 'superseded' },
    'w-fallback',
  );
  // The badge is only measurable once the renderer has shown it: `.hidden`
  // carries `display: none !important`, so a hidden badge would answer every
  // question below with the styles of a box nobody draws.
  expect(badge.classList.contains('hidden')).toBe(false);
  return {
    row: document.querySelector('.hub-ws-name') as HTMLElement,
    name,
    badge,
  };
}

describe('the retired badge cannot break the topbar', () => {
  let sheets = () => {};
  beforeEach(() => {
    sheets = installSheets('hub.css', 'styles.css');
  });
  afterEach(() => {
    sheets();
    setViewport({ width: 1024, height: 768 });
    document.body.replaceChildren();
  });

  /**
   * The iPad in landscape has ~750px of usable height, about half a monitor,
   * so a row that grows by a few pixels is a real complaint there and
   * invisible on a desktop. The badge must therefore live INSIDE the existing
   * 48px row: a small font, hairline padding, and no block-level box of its
   * own.
   */
  it('sits inside the existing row rather than adding a line to it', () => {
    const { badge, name } = paintIdentity(IPAD);
    const style = styleOf(badge);
    expect(style.fontSize).toBe('11px');
    // 1px top/bottom against a 17px name in a 48px min-height row: the row's
    // height is set by the name and the 36px tap targets beside it, and this
    // is far below both.
    expect(style.padding).toBe('1px 7px');
    // A wrapped badge would push the row taller; it stays on the name's line.
    expect(style.whiteSpace).toBe('nowrap');
    // …and it claims no line box of its own. An unset `display` computes to
    // `''` here, so this needs the controls: the name beside it IS 17px, and
    // the badge's own 11px above proves the cascade reached this element.
    expect(style.display).not.toBe('block');
    expect(styleOf(name.parentElement as HTMLElement).fontSize).toBe('17px');
  });

  /**
   * At 430px the name is what runs out of room. The badge must survive that,
   * because a board whose "Retired" is the thing that got ellipsised reads as
   * live — which is the failure, not a cosmetic one.
   */
  it('truncates the NAME and never the badge when width runs out', () => {
    const { row, name, badge } = paintIdentity(PHONE);
    // The flex row can shrink below its content — without this the grid
    // column refuses to shrink and the whole cluster is pushed off-screen.
    expect(styleOf(row).display).toBe('flex');
    expect(Number.parseFloat(styleOf(row).minWidth)).toBe(0);
    // The ellipsis lives on the name text, not on the row — that is the half
    // that makes the badge safe. The row's own `text-overflow` is unset, and
    // the name's value beside it is the control that says this reader can see
    // the property at all.
    expect(styleOf(row).textOverflow).not.toBe('ellipsis');
    const text = styleOf(name);
    expect(text.textOverflow).toBe('ellipsis');
    expect(text.overflow).toBe('hidden');
    expect(text.whiteSpace).toBe('nowrap');

    // `0 0 auto`: never grow, never SHRINK. The shrink half is the one that
    // matters — flex items default to shrinking, so without it the badge is
    // squeezed before the name is.
    expect(styleOf(badge).flex).toBe('0 0 auto');
  });

  it('keeps both readings at the tablet tier too — no media query undoes them', () => {
    // The pair above is deliberately split across the two viewports this
    // project verifies, which leaves each rule unproven at the other. This is
    // the crossing check, and it is exactly what a text read could never make:
    // a `@media` block that un-shrinks the badge or moves the ellipsis back
    // onto the row would still contain every string the old assertions looked
    // for.
    const ipad = paintIdentity(IPAD);
    expect(styleOf(ipad.badge).flex).toBe('0 0 auto');
    expect(styleOf(ipad.name).textOverflow).toBe('ellipsis');
    const phone = paintIdentity(PHONE);
    expect(styleOf(phone.badge).fontSize).toBe('11px');
    expect(styleOf(phone.badge).whiteSpace).toBe('nowrap');
  });
});
