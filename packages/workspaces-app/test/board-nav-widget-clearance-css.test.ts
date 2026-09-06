import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Activity tab must hit-test to ITSELF on a phone with the feedback
 * widget loaded.
 *
 * The widget's launcher is a fixed 48px bubble in the bottom-right corner of
 * the viewport, in a shadow root at the maximum z-index — and at ≤900px the
 * board nav is a fixed bottom bar on the same edge. At 430px the bubble sat
 * exactly over the centre of the rightmost tab (Activity), so tapping it
 * reached CLAUDE-FEEDBACK-WIDGET instead. The bar cannot win a z-order
 * contest it should not win (the bubble has to stay tappable), so the tabs
 * END before the bubble's column: right padding on the bar equal to the
 * bubble's inset + diameter + slack, applied only when a widget is actually
 * on the page (a share visitor's board ships no widget and keeps the
 * full-width bar).
 *
 * These are stylesheet properties — happy-dom resolves no layout, so no DOM
 * hit-test can see them. This test instead ties the reservation to the
 * widget's OWN fab geometry, so growing the bubble or its inset fails here
 * rather than silently re-covering the tab. The tap itself — every visible tab
 * hit-tested at 430px with the widget on the page — is asserted nightly by
 * `nav-clears-widget` in scripts/ui-nightly-lib.ts; before that it lived only
 * in this fix's commit body.
 *
 * PERMANENT SOURCE-SHAPE SITES, and counted as such. Two of the audit's
 * source-shape floor lives here (scripts/test-audit.baseline.json names all
 * three). A `calc()` of `max()` and `env()`, which happy-dom discards whole, needs a real layout engine, and the only browser this repo
 * has is `bun run ui:shot`. Since 2026-09-05 that browser DOES run in CI —
 * but NIGHTLY, from .github/workflows/nightly-ui.yml, and deliberately not on
 * pull requests, because installing a browser and rendering four real pages is
 * the expensive kind of job (Bryan's call, 2026-09-05). That schedule is
 * exactly why this test stays here. Moving it would take a check that runs on
 * EVERY PR and put it on one that runs once a day: the regression would land,
 * merge, and surface tomorrow. Not a conversion, a downgrade. The nightly run
 * stands BEHIND this test on the same subject, asserting in a real layout
 * engine what this file can only read as text — see scripts/ui-nightly-lib.ts.
 * It carries no `audit: not-source` marker
 * because it IS a source read; what it is not is an unconverted leftover.
 */
const SRC = resolve(import.meta.dirname, '../src');
const CSS = readFileSync(resolve(SRC, 'board.css'), 'utf8');
const WIDGET_STYLES = readFileSync(
  resolve(import.meta.dirname, '../../widget/src/styles.ts'),
  'utf8',
);

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of one rule, optionally scoped to a media block's text. */
function rule(selector: string, within: string = declarationsOnly(CSS)): string {
  const at = new RegExp(
    `(^|\\n|\\{)\\s*${selector.replace(/[.+*[\]():]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
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

/** The widget fab's real geometry, read from the widget's own stylesheet —
 *  the reservation below must track it, not a copy of it. */
function fabGeometry(): { inset: number; width: number } {
  const fab = /\.fab\s*\{([^}]*)\}/.exec(WIDGET_STYLES)?.[1] ?? '';
  const inset = Number(/right:\s*max\((\d+)px/.exec(fab)?.[1]);
  const width = Number(/width:\s*(\d+)px/.exec(fab)?.[1]);
  return { inset, width };
}

describe('the bottom tab bar ends before the feedback bubble', () => {
  const phone = media('(max-width: 900px)');

  it('positive control: the ≤900px band really fixes the nav to the bottom edge', () => {
    const nav = rule('.board-nav', phone);
    expect(nav).toContain('position: fixed');
    expect(nav).toContain('bottom: 0');
  });

  it('positive control: the widget fab geometry is readable from its stylesheet', () => {
    const { inset, width } = fabGeometry();
    expect(inset).toBeGreaterThan(0);
    expect(width).toBeGreaterThan(0);
  });

  it('reserves the bubble column, gated on a widget actually being present', () => {
    const clearance = rule('body:has(claude-feedback-widget) .board-nav', phone);
    // Safe-area aware, like the fab's own `right`.
    expect(clearance).toContain('env(safe-area-inset-right)');
    // The reservation covers the fab's inset + diameter (plus slack), derived
    // from the widget's own numbers so a bigger bubble fails this test.
    const { inset, width } = fabGeometry();
    const nums = [...clearance.matchAll(/(\d+)px/g)].map((m) => Number(m[1]));
    const reserved = nums.reduce((a, b) => a + b, 0);
    expect(nums[0]).toBeGreaterThanOrEqual(inset);
    expect(reserved).toBeGreaterThanOrEqual(inset + width);
  });

  it('stays out of the 901–1100px band, where the strip sits at the top', () => {
    // In that band the nav is an in-flow strip above the content — the bubble
    // shares no edge with it, so a reservation there would be dead weight.
    expect(media('(max-width: 1100px)')).not.toContain(':has(claude-feedback-widget)');
    // And the desktop rail carries none of it either.
    const css = declarationsOnly(CSS);
    const firstMedia = css.indexOf('@media');
    expect(css.slice(0, firstMedia)).not.toContain(':has(claude-feedback-widget)');
  });
});
