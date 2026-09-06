import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `#shell` is a three-row grid: topbar, meeting strip, main. The strip is
 * `display: none` on every doc that is not a meeting, and a `display: none`
 * element is not a grid item at all — it leaves the item list rather than
 * occupying a zero-height track. So under auto-placement `#main` took the
 * strip's `auto` track and the last track went empty, leaving `#main` short
 * of the bottom of the window by however much the doc's content failed to
 * fill: measured 40px at 1180x820, 105px at 430px wide, 272px at 2560x1400,
 * with that band hit-testing to `#shell` rather than to the editor.
 *
 * The fix is explicit `grid-row` on the three in-flow children. What this
 * file guards is that PLACEMENT — which row each child resolves to — not the
 * text of any rule. A regex asserting `grid-row: 3` appears somewhere would
 * pass on a stylesheet where the declarations had been deleted and re-added
 * against the wrong children; running the placement algorithm cannot.
 *
 * Scope, stated honestly: this models which ROW each child lands in, not how
 * TALL the rows come out. happy-dom resolves no layout and the repo has no
 * browser in CI, so track geometry was verified by hand in headless Chrome
 * against the running app and is recorded in the `#shell` comment. The row
 * index is the part that regresses silently; the geometry follows from it.
 *
 * PERMANENT SOURCE-SHAPE SITE, and counted as such. One of the audit's
 * source-shape floor lives here (scripts/test-audit.baseline.json names all
 * three). Grid auto-placement needs a real layout engine, and the only browser this repo
 * has is `bun run ui:shot`, which is a local dev tool: it wants a Chrome
 * binary and a running server, and CI runs neither. Moving this there would
 * not convert the test — it would retire it, swapping a gate that runs on
 * every PR for one nobody runs. It carries no `audit: not-source` marker
 * because it IS a source read; what it is not is an unconverted leftover.
 */

const SRC = resolve(import.meta.dirname, '../src');
const CSS = readFileSync(resolve(SRC, 'styles.css'), 'utf8');
const HTML = readFileSync(resolve(import.meta.dirname, '../index.html'), 'utf8');

// ---------------------------------------------------------------- CSS model

type Rule = { sel: string; body: string };

/** Flattens the stylesheet to (selector, declarations), descending at-rules. */
function parseRules(css: string): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  let mark = 0;
  while (i < css.length) {
    if (css[i] === '{') {
      const sel = css.slice(mark, i).trim();
      let depth = 1;
      let j = i + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth += 1;
        else if (css[j] === '}') depth -= 1;
        j += 1;
      }
      const body = css.slice(i + 1, j - 1);
      if (sel.startsWith('@')) out.push(...parseRules(body));
      else out.push({ sel, body });
      i = j;
      mark = j;
      continue;
    }
    if (css[i] === '}') mark = i + 1;
    i += 1;
  }
  return out;
}

const RULES = parseRules(CSS.replace(/\/\*[\s\S]*?\*\//g, ''));

/** Every rule whose selector list contains exactly `selector`. */
function rulesFor(selector: string): Rule[] {
  return RULES.filter((r) => r.sel.split(',').some((s) => s.trim() === selector));
}

function declValue(body: string, prop: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body);
  return m ? m[1].trim() : null;
}

/**
 * The declared value of `prop` for `selector`, asserting the stylesheet is
 * unanimous about it. A responsive override would make a single row index
 * wrong at some widths, and this model has no width — so rather than pick a
 * winner silently, disagreement fails and sends someone back here.
 */
function uniqueDecl(selector: string, prop: string): string | null {
  const values = rulesFor(selector)
    .map((r) => declValue(r.body, prop))
    .filter((v): v is string => v !== null);
  const distinct = [...new Set(values)];
  if (distinct.length > 1) {
    throw new Error(
      `${selector} declares ${prop} more than once with different values ` +
        `(${distinct.join(' | ')}). The placement model assumes one value at ` +
        'every width — revisit shell-grid-placement.test.ts before overriding.',
    );
  }
  return distinct[0] ?? null;
}

/** Splits a track list on top-level whitespace, keeping `minmax(0, 1fr)` whole. */
function splitTracks(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// ------------------------------------------------------------- markup model

/** `#shell`'s direct children, in document order, parsed as real DOM. */
function shellChildIds(): string[] {
  // happy-dom honours <link> and <script> on parse and tries to fetch them off
  // a dev server that is not running, filling the CI log with ECONNREFUSED.
  // Neither affects the element tree, so drop them before parsing.
  const markup = HTML.replace(/<link\b[^>]*>/gi, '').replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const doc = new DOMParser().parseFromString(markup, 'text/html');
  const shell = doc.getElementById('shell');
  if (!shell) throw new Error('index.html has no #shell');
  return [...shell.children].map((el, i) => {
    if (!el.id) throw new Error(`#shell child ${i} (<${el.tagName.toLowerCase()}>) has no id`);
    return el.id;
  });
}

/**
 * Children that are never grid items because they are taken out of flow.
 * Verified in a browser against the running app, not inferred here: each is
 * `position: fixed` or `position: absolute`, several via class rather than
 * id, and resolving that cascade in a test would be a worse lie than naming
 * them. This list is safe to keep by hand precisely BECAUSE of the fix — with
 * the three placements explicit, an entry that quietly returned to flow would
 * auto-place into an implicit row 4, not steal `#main`'s track.
 */
const OUT_OF_FLOW = [
  'suggestions-menu', // absolute — popover over the prose
  'doc-menu', // absolute — topbar dropdown
  'thread-view', // fixed — mobile thread sheet
  'composer-scrim', // fixed — full-window scrim
  'composer', // fixed — pinned above the keyboard
  'toast', // fixed — transient, bottom of window
];

// -------------------------------------------------------- placement algorithm

type Placement = { rowOf: (id: string) => number | null; displayed: (id: string) => boolean };

/**
 * CSS grid auto-placement for a single-column grid: explicitly placed items
 * claim their rows first, then the rest fill the lowest free row in document
 * order. Items that are not displayed are not in the item list at all — which
 * is the whole bug.
 */
function placeRows(children: string[], { rowOf, displayed }: Placement): Map<string, number> {
  const rows = new Map<string, number>();
  const taken = new Set<number>();
  const items = children.filter(displayed);
  for (const id of items) {
    const explicit = rowOf(id);
    if (explicit !== null) {
      rows.set(id, explicit);
      taken.add(explicit);
    }
  }
  let cursor = 1;
  for (const id of items) {
    if (rows.has(id)) continue;
    while (taken.has(cursor)) cursor += 1;
    rows.set(id, cursor);
    taken.add(cursor);
    cursor += 1;
  }
  return rows;
}

const IN_FLOW = ['topbar', 'meeting-strip', 'main'];
const inFlowOnly = (stripVisible: boolean) => (id: string) =>
  IN_FLOW.includes(id) && (id !== 'meeting-strip' || stripVisible);

const currentRowOf = (id: string) => {
  const v = uniqueDecl(`#${id}`, 'grid-row');
  return v === null ? null : Number.parseInt(v, 10);
};

// --------------------------------------------------------------------- tests

describe('#shell grid rows', () => {
  it('declares three tracks, the last shrinkable to zero', () => {
    const tracks = splitTracks(uniqueDecl('#shell', 'grid-template-rows') ?? '');
    expect(tracks).toHaveLength(3);
    // `1fr` is `minmax(auto, 1fr)`, whose min is content-driven. It happens to
    // work only because #main sets `overflow: hidden`, which zeroes an item's
    // automatic minimum size — a dependency 300 lines away. The explicit `0`
    // is what makes this rule stand on its own.
    const min = /^minmax\(\s*([^,]+),/.exec(tracks[2]);
    expect(min?.[1].trim(), `last track is \`${tracks[2]}\`, expected minmax(0, …)`).toBe('0');
  });

  it('pins the three in-flow children to rows 1, 2, 3', () => {
    expect(IN_FLOW.map(currentRowOf)).toEqual([1, 2, 3]);
  });

  it('keeps #main in the last row whether or not the strip is displayed', () => {
    const children = shellChildIds();
    for (const stripVisible of [false, true]) {
      const rows = placeRows(children, {
        rowOf: currentRowOf,
        displayed: inFlowOnly(stripVisible),
      });
      expect(rows.get('main'), `strip visible: ${stripVisible}`).toBe(3);
      expect(rows.get('topbar')).toBe(1);
    }
  });

  /**
   * The control for the test above. A placement model that always answered
   * "3" would pass it while checking nothing, so feed the same model the
   * pre-fix stylesheet — three tracks, no explicit placement anywhere — and
   * require it to reproduce the shipped bug: `#main` in row 2 with the strip
   * hidden, row 3 with the strip shown. If this ever passes with row 3 in
   * both, the model has stopped seeing placement and the test above is void.
   */
  it('control: without explicit placement, a hidden strip moves #main up a row', () => {
    const children = shellChildIds();
    const preFix = () => null;
    const hidden = placeRows(children, { rowOf: preFix, displayed: inFlowOnly(false) });
    const shown = placeRows(children, { rowOf: preFix, displayed: inFlowOnly(true) });
    expect(hidden.get('main')).toBe(2);
    expect(shown.get('main')).toBe(3);
  });

  /**
   * Placement only stays correct while every in-flow child has a row. A new
   * one added to the markup should force that decision rather than inherit
   * auto-placement, so the two lists have to account for the markup exactly.
   */
  it('accounts for every child of #shell', () => {
    expect([...shellChildIds()].sort()).toEqual([...IN_FLOW, ...OUT_OF_FLOW].sort());
  });
});
