import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The review shell's mic is DOCKED in the topbar, not floating over the prose.
 *
 * The board finished this in #317 and the doc surface was deferred: it has no
 * nav rail and no tab bar, so its mic stayed a `position: fixed` launcher in
 * the bottom-left corner. Nothing under it was a control — which is why it
 * outlived the board's docking — but a fixed box over a scrolling document is
 * always over SOMETHING, and on this surface that something is the prose.
 * Measured on a staging build at 430, 1000x800, 1180x820 and 1440: the mic's
 * 44px box covered a paragraph at every width and every scroll position, and
 * at 1000x800 a section heading as well.
 *
 * The dock is `#topbar`'s toolbar. That row is a hard 48px (`#shell`'s
 * `grid-template-rows: 48px 1fr`), so a 44px control fits it whole and the
 * reading area loses nothing — which is the difference between docking and the
 * reservation it replaces: a reservation is a promise that nothing will ever be
 * laid out in one column, renewed at every width where it could be broken.
 *
 * These are stylesheet and markup properties — happy-dom resolves no layout, so
 * no DOM test can see them. What a browser has to confirm is in the commit
 * body: the rects at 1180x820 and 430px.
 */
const SRC = resolve(import.meta.dirname, '../src');
const CSS = readFileSync(resolve(SRC, 'styles.css'), 'utf8');
const MOUNT = readFileSync(resolve(SRC, 'voice-dock.ts'), 'utf8');
const SHELL = readFileSync(resolve(import.meta.dirname, '../index.html'), 'utf8');

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function rule(selector: string, within: string = declarationsOnly(CSS)): string {
  const at = new RegExp(
    `(^|\\n|\\{)\\s*${selector.replace(/[.+*[\]():]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(within);
  return at?.[2] ?? '';
}

describe('the doc mic mounts in the chrome, not on the document', () => {
  it('puts the mic and its readout in a dock inside the topbar toolbar', () => {
    expect(MOUNT).toContain('doc-nav-dock');
    expect(MOUNT).toContain("querySelector('#topbar .toolbar')");
    // Both the button and the readout go in the wrapper — the readout is
    // positioned against it, so leaving it on <body> would strand it at the
    // viewport corner the mic just left.
    expect(MOUNT).toMatch(/dock\.append\(button, indicator\)/);
    expect(MOUNT).toMatch(/toolbar\.prepend\(dock\)/);
    // The wrapper is what teardown removes, or an empty divider is left behind.
    expect(MOUNT).toMatch(/dock\.remove\(\)/);
  });

  it('keeps a <body> fallback for a shell with no toolbar', () => {
    expect(MOUNT).toMatch(/else document\.body\.append\(dock\)/);
  });

  it('positive control: the shell it targets really has that toolbar', () => {
    // The selector is a string, so nothing type-checks it against the markup.
    // If the topbar is renamed or the cluster loses its class, the mic
    // silently takes the <body> fallback and floats over the prose again —
    // which looks exactly like the bug this fixes.
    expect(SHELL).toContain('id="topbar"');
    expect(SHELL).toMatch(/<div class="toolbar">/);
    // …and the row it fits into is the fixed 48px one.
    expect(rule('#shell')).toMatch(/grid-template-rows:\s*48px/);
    expect(Number(/width:\s*(\d+)px/.exec(rule('.voice-mic'))?.[1])).toBeLessThanOrEqual(48);
  });
});

describe('the docked doc mic reads as a control, not as a doc action', () => {
  it('takes the mic out of the viewport-fixed layer', () => {
    const docked = rule('.doc-nav-dock .voice-mic');
    expect(docked, 'nothing styles the mic once it is docked').not.toBe('');
    expect(docked).toMatch(/position:\s*static/);
    // The FAB's offsets and layer mean nothing in flow, and leaving them set is
    // how a later reader concludes it is still floating.
    expect(docked).toMatch(/left:\s*auto/);
    expect(docked).toMatch(/bottom:\s*auto/);
    expect(docked).toMatch(/z-index:\s*auto/);
    // A docked control casts no shadow — the shadow is what read as hovering.
    expect(docked).toMatch(/box-shadow:\s*none/);
  });

  it('fences the mic off from the doc buttons beside it', () => {
    // *"keep it slightly separate … so it's clear it's not a navbar item"* —
    // in a left-to-right toolbar the rail's divider-below becomes a
    // divider-after, and a divider alone reads as a list separator, so the gap
    // comes with it.
    const dock = rule('.doc-nav-dock');
    expect(dock, 'the dock has no rule of its own').not.toBe('');
    expect(dock).toMatch(/border-right:\s*1px solid var\(--border\)/);
    expect(Number(/padding-right:\s*(\d+)px/.exec(dock)?.[1])).toBeGreaterThanOrEqual(6);
    // Positioned, or the readout below re-anchors to the viewport: `#topbar`
    // and `#shell` are both static, so there is no other containing block for
    // it to find.
    expect(dock).toMatch(/position:\s*relative/);
  });

  it('does not shrink the mic to fit the toolbar', () => {
    // 44px is the touch target, and the topbar's 48px row has the room. A
    // docked mic that is smaller than every other docked mic is a different
    // control as far as the reader is concerned.
    const docked = rule('.doc-nav-dock .voice-mic');
    expect(docked).not.toMatch(/width:\s*(\d|[123]\d)px/);
    expect(docked).not.toMatch(/height:\s*(\d|[123]\d)px/);
  });
});

describe('the readout follows the mic to the top of the window', () => {
  it('hangs below the topbar rather than above the window edge', () => {
    const readout = rule('.doc-nav-dock .voice-indicator');
    expect(readout, 'the readout was left at the viewport corner').not.toBe('');
    expect(readout).toMatch(/position:\s*absolute/);
    expect(readout).toMatch(/top:\s*calc\(100%/);
    expect(readout).toMatch(/bottom:\s*auto/);
    // Positive control: the floating form really does place it from the
    // BOTTOM, which is the declaration this overrides.
    expect(rule('.voice-indicator')).toMatch(/bottom:\s*calc\(/);
  });

  it('grows leftwards, into the page rather than off the right edge', () => {
    // The dock sits far along a wide topbar and the box is `width:
    // max-content` up to `min(92vw, 840px)`. Anchored left, a full sentence
    // would run past the right edge of the window.
    const readout = rule('.doc-nav-dock .voice-indicator');
    expect(readout).toMatch(/right:\s*0/);
    expect(readout).toMatch(/left:\s*auto/);
    // Positive control: it really is wide enough for that to matter.
    expect(rule('.voice-indicator')).toMatch(/max-width:\s*min\(92vw, 840px\)/);
  });
});
