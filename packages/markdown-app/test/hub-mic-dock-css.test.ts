import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The hold-to-talk mic is DOCKED in the workspace nav, not floating over the
 * page.
 *
 * Bryan, 2026-08-19: *"can we make a more durable fix for the mic? Place it in
 * a fixed location instead of floating. Put it in bottom left of left navbar in
 * desktop views. And in the bottom tab on mobile, and give it a distinct look
 * and keep it slightly separate from the navbar so it's clear it's not a
 * navbar item"*.
 *
 * The float is the bug. A `position: fixed` launcher in the bottom-left corner
 * lands on top of whatever the page happens to put there — at 430px it sat on
 * "Record answer", the one control the review queue exists to deliver. This
 * branch answered that twice by reserving space around the mic (152fb3f,
 * 50c9619); a reservation is a promise that nothing will ever be positioned
 * under one particular column, and it has to be renewed at every width where
 * the promise could be broken. Docking the mic makes the promise unnecessary:
 * the mic lives in the nav's own column and no page content is ever behind it.
 *
 * These are stylesheet and markup properties — no DOM test can see them,
 * because happy-dom resolves no layout. What a browser still has to confirm is
 * in the PR body: how the docked control READS at desktop and at 430px.
 */
const SRC = resolve(import.meta.dirname, '../src');
const CSS = readFileSync(resolve(SRC, 'styles.css'), 'utf8');
const HUB_APP = readFileSync(resolve(SRC, 'hub/hub-app.ts'), 'utf8');

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of one rule, optionally scoped to a media block's text. */
function rule(selector: string, within: string = declarationsOnly(CSS)): string {
  const at = new RegExp(
    `(^|\\n|\\{)\\s*${selector.replace(/[.+*[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(within);
  return at?.[2] ?? '';
}

/** Every `@media` block matching this query, concatenated. */
function media(query: string): string {
  const css = declarationsOnly(CSS);
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(`@media ${query}`, from);
    if (start < 0) break;
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        out.push(css.slice(start, i));
        from = i;
        break;
      }
    }
    if (from <= start) break;
  }
  return out.join('\n');
}

function px(decl: string, prop: string): number {
  return Number(new RegExp(`${prop}:\\s*(\\d+)px`).exec(decl)?.[1]);
}

/** The markup between `<nav id="hub-nav" …>` and its `</nav>`. */
function navMarkup(): string {
  const start = HUB_APP.indexOf('<nav id="hub-nav"');
  const end = HUB_APP.indexOf('</nav>', start);
  return start < 0 || end < 0 ? '' : HUB_APP.slice(start, end);
}

describe('the mic lives in the nav, not on top of the page', () => {
  it('mounts the mic and its indicator inside the nav element', () => {
    const nav = navMarkup();
    // Positive control: this really is the nav, and the items it has always
    // held are in the slice being read.
    expect(nav, 'the hub nav element moved or was renamed').not.toBe('');
    expect(nav).toContain('hub-nav-item');
    expect(nav).toContain('id="hub-nav-collapse"');

    expect(nav).toContain('id="hub-mic"');
    expect(nav).toContain('id="hub-voice"');
    // …and in a wrapper of its own, which is what carries the divider and the
    // gap that say "this is not one more page you can navigate to".
    expect(nav).toContain('hub-nav-dock');
    // At the END of the rail: after every nav item and after the collapse
    // toggle, so it reads as the rail's foot rather than as another tab.
    expect(nav.indexOf('id="hub-mic"')).toBeGreaterThan(nav.lastIndexOf('data-nav='));
    expect(nav.indexOf('id="hub-mic"')).toBeGreaterThan(nav.indexOf('id="hub-nav-collapse"'));
    // The mic keeps the hold-to-talk affordance it had as a FAB — the press is
    // the gesture, and the label is what a screen reader gets.
    expect(nav).toContain('aria-label="Hold to talk"');
  });

  it('takes the docked mic out of the viewport-fixed layer', () => {
    const docked = rule('.hub-nav-dock .voice-mic');
    expect(docked, 'nothing styles the mic once it is docked').not.toBe('');
    expect(docked).toMatch(/position:\s*static/);
    // The FAB's viewport offsets mean nothing in flow; leaving them set is how
    // a later reader concludes the mic is still fixed.
    expect(docked).toMatch(/left:\s*auto/);
    expect(docked).toMatch(/bottom:\s*auto/);
  });

  it('keeps the doc surface — which has no nav rail — on the floating mic', () => {
    // `.voice-mic` is shared by the hub and the /review/<docId> surface, and
    // that surface mounts it on <body> with no rail to dock into (voice-dock.ts).
    // Docking the base rule would strand it there, so the base stays the FAB
    // and only the nav's copy is un-fixed.
    const base = rule('.voice-mic');
    expect(base).toMatch(/position:\s*fixed/);
    expect(base).toMatch(/left:\s*16px/);
    // Nothing about the hub's bottom bar belongs in it any more: on the only
    // surface this rule now positions, that variable has never been defined.
    expect(base).not.toMatch(/--hub-bottom-bar/);
    expect(rule('.voice-indicator')).not.toMatch(/--hub-bottom-bar/);
    // It still rises with the on-screen keyboard, like every bottom-docked
    // element on that surface.
    expect(base).toMatch(/--kb-bottom/);
  });
});

describe('the docked mic reads as a control, not as a nav item', () => {
  it('separates the dock from the items with a divider and a gap', () => {
    const dock = rule('.hub-nav-dock');
    expect(dock, 'the dock has no rule of its own').not.toBe('');
    expect(dock).toMatch(/border-top:\s*1px solid var\(--border\)/);
    // *"keep it slightly separate from the navbar"* — the divider alone still
    // reads as a list separator; the gap is what sets it apart.
    expect(px(dock, 'padding-top')).toBeGreaterThanOrEqual(8);
    expect(px(dock, 'margin-top')).toBeGreaterThanOrEqual(8);
  });

  it('gives it a filled, bordered treatment the borderless nav items do not have', () => {
    // Nav items are borderless text rows on the rail's own panel colour. The
    // mic keeps the round bordered button it has always been, and takes the
    // page background so the circle is visible against the rail.
    expect(rule('.hub-nav-item')).toMatch(/border:\s*none/);
    expect(rule('.hub-nav-dock .voice-mic:not(.voice-active)')).toMatch(
      /background:\s*var\(--bg\)/,
    );
    expect(rule('.voice-mic')).toMatch(/border-radius:\s*50%/);
    expect(rule('.voice-mic')).toMatch(/border:\s*1px solid var\(--border\)/);
  });

  it('keeps both states the mic has always had', () => {
    // Recording: the same red. The docked background is written `:not(
    // .voice-active)` so it cannot out-specify the state that matters most.
    expect(rule('.voice-mic.voice-active')).toMatch(/background:\s*#c53030/);
    // Insecure origin: dimmed but still PRESSABLE — the press is how the
    // reason gets surfaced, so `disabled` would swallow the explanation.
    expect(rule('.voice-mic.voice-unavailable')).toMatch(/opacity:\s*0\.45/);
    expect(declarationsOnly(CSS)).not.toMatch(/\.voice-mic[^{]*\{[^}]*pointer-events:\s*none/);
  });

  it('stays a 44px touch target, and a hold rather than a scroll', () => {
    const base = rule('.voice-mic');
    expect(px(base, 'width')).toBeGreaterThanOrEqual(44);
    expect(px(base, 'height')).toBeGreaterThanOrEqual(44);
    // The hold IS the gesture — a docked mic inside a scrollable rail must not
    // start a scroll on touchmove.
    expect(base).toMatch(/touch-action:\s*none/);
    // Docking must not shrink it.
    const docked = rule('.hub-nav-dock .voice-mic');
    expect(docked).not.toMatch(/width:\s*(\d|[123]\d)px/);
    expect(docked).not.toMatch(/height:\s*(\d|[123]\d)px/);
  });

  it('still fits, whole, in the collapsed rail', () => {
    // The rail collapses to icons (`hub-nav--collapsed`, persisted). The mic is
    // already icon-only, so it stays exactly where it is — moving it on
    // collapse would put the one control back to "where did it go". What the
    // collapse has to buy is room: 44px of button inside the narrowed rail,
    // border-box, so the rail's border and padding come out of the width.
    const collapsed = rule('.hub-nav--collapsed');
    const width = px(collapsed, 'width');
    const pad = px(collapsed, 'padding-left');
    const border = 1; // .hub-nav's border-right, inside the border-box width
    expect(width - border - 2 * pad).toBeGreaterThanOrEqual(px(rule('.voice-mic'), 'width'));
    // …and it is not hidden with the labels.
    expect(rule('.hub-nav--collapsed .hub-nav-dock')).not.toMatch(/display:\s*none/);
  });
});

describe('the phone gets the mic in the bottom tab bar', () => {
  it('puts the dock at the bar’s left end, divided from the tabs', () => {
    // The horizontal treatment is written once, in the ≤1100px strip band, and
    // the ≤900px bar inherits it — the bar IS that strip, pinned to the
    // bottom. Both blocks are the same specificity, so this only holds while
    // ≤900 stays below ≤1100 in the file.
    const strip = media('(max-width: 1100px)');
    const dock = rule('.hub-nav-dock', strip);
    expect(dock, 'the dock is unstyled once the rail turns horizontal').not.toBe('');
    // The rail's top divider becomes a side one.
    expect(dock).toMatch(/border-top:\s*none/);
    expect(dock).toMatch(/border-right:\s*1px solid var\(--border\)/);
    // The mic has always been bottom-LEFT, and the feedback widget's pencil
    // owns the opposite corner; `order` puts it at the head of the bar without
    // moving it in the DOM, where it belongs after the pages it is not one of.
    expect(dock).toMatch(/order:\s*-1/);
    // …and it stays positioned, or the readout absolutely positioned against
    // it would silently re-anchor to the viewport.
    expect(dock).toMatch(/position:\s*relative/);

    const phone = media('(max-width: 900px)');
    // Positive control: this is the block that pins that strip to the bottom.
    expect(rule('.hub-nav', phone)).toMatch(/position:\s*fixed/);
    // Inset from the screen edge, and NOT `flex: 1` like the tabs beside it.
    expect(rule('.hub-nav-dock', phone)).toMatch(/padding:\s*0 10px/);
    expect(rule('.hub-nav-dock', phone)).not.toMatch(/flex:\s*1/);
  });

  it('leaves the bar no higher than the full-screen overlays, mic included', () => {
    // The whole point of docking: the mic is part of the bar now, so an
    // overlay that covers the bar covers the mic. It can no longer punch
    // through a panel from a higher layer — which is the defect the deleted
    // mitigations were compensating for. Equal z-index is enough, because the
    // detail overlay comes later in the shell markup.
    const z = (decl: string) => Number(/z-index:\s*(\d+)/.exec(decl)?.[1]);
    const bar = z(rule('.hub-nav', media('(max-width: 900px)')));
    expect(bar, 'the bar lost its layer').not.toBeNaN();
    expect(bar).toBeLessThanOrEqual(z(rule('.hub-detail')));
    // And the docked mic no longer carries a layer of its own at all.
    expect(rule('.hub-nav-dock .voice-mic')).toMatch(/z-index:\s*auto/);
  });
});

describe('the indicator follows the mic', () => {
  it('anchors the hub indicator to the dock rather than to the viewport corner', () => {
    // `.voice-indicator` rode directly above a mic pinned at the viewport's
    // bottom-left. On a centred 1500px hub the rail's foot is nowhere near
    // that corner, so a viewport-anchored indicator would point at the page
    // gutter. Anchoring it to the dock makes it follow the mic at every width.
    const docked = rule('.hub-nav-dock .voice-indicator');
    expect(docked, 'the indicator was left behind at the viewport corner').not.toBe('');
    expect(docked).toMatch(/position:\s*absolute/);
    expect(docked).toMatch(/bottom:\s*calc\(100%/);
    // The dock is the containing block it resolves against.
    expect(rule('.hub-nav-dock')).toMatch(/position:\s*sticky/);
  });

  it('is not clipped by the nav it now hangs off', () => {
    // The indicator is up to 420px wide and overflows a 170px rail by design.
    // An `overflow-x` on the nav would clip it — and would also make the nav a
    // scroll container, which silently breaks the dock's `position: sticky`.
    expect(rule('.hub-nav')).not.toMatch(/overflow/);
    expect(rule('.hub-nav', media('(max-width: 1100px)'))).not.toMatch(/overflow-x:\s*auto/);
  });
});

describe('the float-era mitigations are gone with the float', () => {
  it('drops the tail reservation the fixed mic forced on the task panel', () => {
    // 152fb3f and 50c9619 reserved 24+60px under the panel at every width the
    // panel's left edge reached the mic's column. Nothing is in that column
    // any more.
    expect(media('(max-width: 1023px)'), 'the mic-clearance media block survives').toBe('');
    expect(declarationsOnly(CSS)).not.toMatch(/24px \+ 60px/);
    // Positive control: the panel is still styled, and the phone's own page
    // tail still clears the bottom bar — that reservation is about the BAR,
    // which is still fixed, and is not one of the mic mitigations.
    expect(rule('.hub-detail-panel')).not.toBe('');
    expect(rule('#hub-root', media('(max-width: 900px)'))).toMatch(/var\(--hub-bottom-bar/);
    expect(rule('body.hub-body', media('(max-width: 900px)'))).toMatch(/--hub-bottom-bar:\s*58px/);
  });

  it('drops the right-aligned submits the fixed mic forced on every composer', () => {
    // The alignment existed only to keep a submit out of the mic's column. A
    // form is free to lay its buttons out however the form wants again.
    const submit = String.raw`button\[type=['"]submit['"]\]`;
    const aligned = new RegExp(`${submit}[^{}]*\\{[^}]*align-self:\\s*flex-end`).exec(
      declarationsOnly(CSS),
    );
    expect(aligned, 'a composer is still right-aligning to dodge the mic').toBeNull();
    // Positive control: the composers themselves are still styled.
    expect(rule('.hub-comment-form')).not.toBe('');
    expect(rule('.hub-decide-form')).not.toBe('');
  });

  it('deletes the comments that explained pixel intersections that cannot happen', () => {
    // A comment describing a measurement that no longer holds is worse than no
    // comment: it is what the next reader believes. These are the phrases the
    // two mitigation commits wrote into the stylesheet and the tests.
    for (const stale of [
      'Record answer',
      'scrollTop 195',
      'elementFromPoint',
      'mic-clearance',
      'the mic is LIFTED',
    ]) {
      expect(CSS, `a mitigation comment still explains "${stale}"`).not.toContain(stale);
    }
    // Positive control: the stylesheet's comments are still being read.
    expect(CSS).toContain('hold-to-talk');
  });
});
