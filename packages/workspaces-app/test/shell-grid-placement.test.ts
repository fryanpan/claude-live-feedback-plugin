import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { showSignInBar } from '../src/signin/write-gate.ts';

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
 * The fix is explicit `grid-row` on the in-flow children. What this file
 * guards is that PLACEMENT — which row each child resolves to — not the text
 * of any rule. A regex asserting `grid-row: 3` appears somewhere would pass on
 * a stylesheet where the declarations had been deleted and re-added against
 * the wrong children; running the placement algorithm cannot.
 *
 * TWO POSTURES, because the same band came back through a selector this file
 * could not see. A browser that may not write mounts `.signin-bar` as a FOURTH
 * in-flow child and `body.signin-gated #shell` re-declares the track list.
 * `rulesFor` matched a selector only when it was spelled EXACTLY `#shell`, so
 * `body.signin-gated #shell` matched nothing and every assertion below ran
 * against the signed-in stylesheet while the signed-out one shipped `#main` in
 * row 3 of a four-track grid — the `1fr` track last and empty, `#main` ending
 * 3px above the bottom at 1180x820 and 55px at 430px, that band hit-testing to
 * `#shell` again. A model that cannot see the posture is not a weaker guard,
 * it is a guard pointed at the wrong page. So every read below takes a
 * POSTURE, and the signed-out one resolves `body.signin-gated <sel>` over the
 * bare selector the way the cascade does.
 *
 * Scope, stated honestly: this models which ROW each child lands in, not how
 * TALL the rows come out. happy-dom resolves no layout, so track geometry is
 * measured elsewhere: by hand in headless Chrome when this fix was written
 * (recorded in the `#shell` comment), and nightly since 2026-09-05 by
 * `shell-main-reaches-bottom` in scripts/ui-nightly-lib.ts, which fails with
 * the same 40px / 100px band this file's comment names. The row index is the
 * part that regresses silently; the geometry follows from it.
 *
 * PERMANENT SOURCE-SHAPE SITE, and counted as such. One of the audit's
 * source-shape floor lives here (scripts/test-audit.baseline.json names all
 * three). Grid auto-placement needs a real layout engine, and the only browser this repo
 * has is `bun run ui:shot`. Since 2026-09-05 that browser DOES run in CI —
 * but NIGHTLY, from .github/workflows/nightly-ui.yml, and deliberately not on
 * pull requests, because installing a browser and rendering six real pages is
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
 * Which shell the reader is looking at. `signed-out` is a browser the server
 * will not take writes from: `showSignInBar` mounts `.signin-bar` into
 * `#shell` and puts `signin-gated` on `<body>`.
 */
type Posture = 'signed-in' | 'signed-out';

/** How the signed-out sheet spells an override of `selector`. */
const gatedForm = (selector: string) => `body.signin-gated ${selector}`;

/**
 * The one value `selector` declares for `prop`, asserting the stylesheet is
 * unanimous about it. A responsive override would make a single row index
 * wrong at some widths, and this model has no width — so rather than pick a
 * winner silently, disagreement fails and sends someone back here.
 */
function unanimousDecl(selector: string, prop: string): string | null {
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

/**
 * The declared value of `prop` for `selector` IN A POSTURE.
 *
 * The signed-out sheet overrides by prefixing `body.signin-gated`, which
 * outranks the bare selector on specificity and comes later in the file, so a
 * gated declaration WINS rather than conflicting with the base one. Modelling
 * that as an override is what lets `#main` legitimately say row 3 in one
 * posture and row 4 in the other without `unanimousDecl` calling it a
 * disagreement — the two values are not rival answers to one question.
 */
function uniqueDecl(selector: string, prop: string, posture: Posture = 'signed-in'): string | null {
  if (posture === 'signed-out') {
    const gated = unanimousDecl(gatedForm(selector), prop);
    if (gated !== null) return gated;
  }
  return unanimousDecl(selector, prop);
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

/**
 * How a child is named here and in the stylesheet: by id where it has one,
 * else by its first class. The same convention scripts/ui-nightly-probe.js
 * uses, so a failure here and a failure in the nightly name the same child —
 * and the sign-in bar has no id, which is why the model cannot key on ids.
 */
function selectorOf(el: Element, i: number): string {
  if (el.id) return `#${el.id}`;
  const cls = String(el.className).split(/\s+/)[0];
  if (cls) return `.${cls}`;
  throw new Error(`#shell child ${i} (<${el.tagName.toLowerCase()}>) has neither id nor class`);
}

/** index.html's `#shell`, live in the test document, with its scripts dropped. */
function mountShell(): HTMLElement {
  // happy-dom honours <link> and <script> on parse and tries to fetch them off
  // a dev server that is not running, filling the CI log with ECONNREFUSED.
  // Neither affects the element tree, so drop them before parsing.
  const markup = HTML.replace(/<link\b[^>]*>/gi, '').replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const doc = new DOMParser().parseFromString(markup, 'text/html');
  const shell = doc.getElementById('shell');
  if (!shell) throw new Error('index.html has no #shell');
  document.body.appendChild(document.importNode(shell, true));
  return document.getElementById('shell') as HTMLElement;
}

afterEach(() => {
  document.body.replaceChildren();
  document.body.className = '';
});

/**
 * `#shell`'s direct children in a posture, in document order.
 *
 * The signed-out list is NOT written down here. `showSignInBar()` — the app's
 * own mount — is called against index.html's real markup and the child list is
 * read back afterwards, so where the bar lands is whatever the shipped code
 * does. A hand-kept list would have been a second place to state the DOM
 * order, and this whole bug is what happens when two places state it and one
 * of them is stale: `mountSignInBar`'s own comment still called `#shell` "a
 * two-row grid (`48px 1fr`)" while it had three tracks and shipped four.
 */
function shellChildren(posture: Posture = 'signed-in'): string[] {
  const shell = mountShell();
  if (posture === 'signed-out') {
    showSignInBar();
    if (!document.body.classList.contains('signin-gated')) {
      throw new Error(
        'showSignInBar() did not put `signin-gated` on <body>, so the gated ' +
          'stylesheet this posture models would never apply — the model lost its subject',
      );
    }
  }
  return [...shell.children].map(selectorOf);
}

/**
 * Children that are never grid items because they are taken out of flow.
 * Verified in a browser against the running app, not inferred here: each is
 * `position: fixed` or `position: absolute`, several via class rather than
 * id, and resolving that cascade in a test would be a worse lie than naming
 * them. This list is safe to keep by hand precisely BECAUSE of the fix — with
 * every in-flow child placed explicitly, an entry that quietly returned to
 * flow would auto-place into a visible implicit row, not steal `#main`'s
 * track.
 */
const OUT_OF_FLOW = [
  '#suggestions-menu', // absolute — popover over the prose
  '#doc-menu', // absolute — topbar dropdown
  '#thread-view', // fixed — mobile thread sheet
  '#composer-scrim', // fixed — full-window scrim
  '#composer', // fixed — pinned above the keyboard
  '#toast', // fixed — transient, bottom of window
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

/**
 * The children that are grid items, per posture, in document order.
 *
 * `.signin-bar` sits SECOND because that is where `mountSignInBar` puts it —
 * `topbar.insertAdjacentElement('afterend', bar)`. It used to go in first
 * while the grid painted it second, and this comment used to say so and leave
 * it there: the grid is what a sighted reader sees, but tab order and the
 * accessibility tree follow the DOM, so the bar's link was the FIRST focus
 * stop on a page that painted it under the topbar (WCAG 1.3.2, meaningful
 * sequence). The two orders agree now, and `document order is row order`
 * below is what keeps them agreeing.
 */
const IN_FLOW: Record<Posture, string[]> = {
  'signed-in': ['#topbar', '#meeting-strip', '#main'],
  'signed-out': ['#topbar', '.signin-bar', '#meeting-strip', '#main'],
};

const inFlowOnly = (posture: Posture, stripVisible: boolean) => (sel: string) =>
  IN_FLOW[posture].includes(sel) && (sel !== '#meeting-strip' || stripVisible);

const rowOfIn = (posture: Posture) => (sel: string) => {
  const v = uniqueDecl(sel, 'grid-row', posture);
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
    expect(IN_FLOW['signed-in'].map(rowOfIn('signed-in'))).toEqual([1, 2, 3]);
  });

  it('keeps #main in the last row whether or not the strip is displayed', () => {
    const children = shellChildren();
    for (const stripVisible of [false, true]) {
      const rows = placeRows(children, {
        rowOf: rowOfIn('signed-in'),
        displayed: inFlowOnly('signed-in', stripVisible),
      });
      expect(rows.get('#main'), `strip visible: ${stripVisible}`).toBe(3);
      expect(rows.get('#topbar')).toBe(1);
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
    const children = shellChildren();
    const preFix = () => null;
    const hidden = placeRows(children, {
      rowOf: preFix,
      displayed: inFlowOnly('signed-in', false),
    });
    const shown = placeRows(children, { rowOf: preFix, displayed: inFlowOnly('signed-in', true) });
    expect(hidden.get('#main')).toBe(2);
    expect(shown.get('#main')).toBe(3);
  });

  /**
   * Placement only stays correct while every in-flow child has a row. A new
   * one added to the markup should force that decision rather than inherit
   * auto-placement, so the two lists have to account for the markup exactly.
   */
  it('accounts for every child of #shell', () => {
    expect([...shellChildren()].sort()).toEqual([...IN_FLOW['signed-in'], ...OUT_OF_FLOW].sort());
  });
});

/**
 * The signed-out shell. Same model, one more child and a re-declared track
 * list — and until this block existed, nothing in the repo read either.
 */
describe('#shell grid rows, signed out', () => {
  it('mounts the sign-in bar as a fourth in-flow child of #shell', () => {
    // The control for every assertion below it. A posture whose extra child
    // never arrived would satisfy the placement checks by being the signed-in
    // page under another name.
    const children = shellChildren('signed-out');
    expect(children).toContain('.signin-bar');
    expect([...children].sort()).toEqual([...IN_FLOW['signed-out'], ...OUT_OF_FLOW].sort());
  });

  it('declares four tracks, the last shrinkable to zero', () => {
    const tracks = splitTracks(uniqueDecl('#shell', 'grid-template-rows', 'signed-out') ?? '');
    expect(tracks).toHaveLength(4);
    // The same `minmax(0, …)` the signed-in track list spells out, for the
    // same reason. The gated rule shipped a bare `1fr` here, which is
    // `minmax(auto, 1fr)` — a floor set by content rather than by the author.
    const min = /^minmax\(\s*([^,]+),/.exec(tracks[3]);
    expect(min?.[1].trim(), `last track is \`${tracks[3]}\`, expected minmax(0, …)`).toBe('0');
  });

  it('gives the topbar the same track it has signed in', () => {
    // Not incidental. The gated rule opened its list with `auto`, and since
    // `#topbar { grid-row: 1 }` still held, the topbar took that `auto` track
    // and rendered 37px tall at 1180x820 and 45px at 430px against the 48px
    // every other page gives it — a second thing the same rule changed and
    // nobody asked for.
    const signedIn = splitTracks(uniqueDecl('#shell', 'grid-template-rows') ?? '');
    const signedOut = splitTracks(uniqueDecl('#shell', 'grid-template-rows', 'signed-out') ?? '');
    expect(signedOut[0]).toBe(signedIn[0]);
  });

  it('pins the four in-flow children to rows 1, 2, 3, 4', () => {
    // Document order and ROW order are both topbar, bar, strip, main. They
    // used to disagree by one — see the test below, which is the guard.
    expect(IN_FLOW['signed-out'].map(rowOfIn('signed-out'))).toEqual([1, 2, 3, 4]);
  });

  /**
   * Document order IS row order — what a reader sees is the order a keyboard
   * walks.
   *
   * The one invariant the rest of this file could not see. Every check above
   * asks which ROW a child lands in, and rows are all `mountSignInBar` had to
   * get right for the page to LOOK correct: the bar went in as `#shell`'s
   * first child, `grid-row: 2` painted it under the topbar, and three comments
   * in this repo wrote the mismatch down as a curiosity.
   *
   * It was not a curiosity. Tab order and the accessibility tree follow the
   * DOM, so the bar's "Sign in to comment or edit" link was the FIRST focus
   * stop on the page — a keyboard user landed in the bar, then tabbed BACKWARDS
   * up the screen into the topbar. Measured in headless Chrome on a cold load
   * at 1180x820 and at 430px, both. WCAG 1.3.2, meaningful sequence.
   *
   * Read from `shellChildren`, which calls the app's own mount, so this fails
   * on the insertion point rather than on a list somebody kept by hand — and
   * it is the check the two lists above cannot substitute for, since a
   * reordered `IN_FLOW` would satisfy them both.
   */
  it('mounts every in-flow child in the order the grid paints it', () => {
    const children = shellChildren('signed-out').filter(inFlowOnly('signed-out', true));
    const rows = children.map(rowOfIn('signed-out'));
    expect(
      rows,
      `#shell's in-flow children in DOM order are ${children.join(', ')} — rows ${rows.join(
        ', ',
      )}. A row that goes backwards is a focus stop above the one before it`,
    ).toEqual([...rows].sort((a, b) => (a ?? 0) - (b ?? 0)));
    // Named, not just monotonic: an ordering check alone would pass on a shell
    // whose children had all lost their placement.
    expect(children).toEqual(['#topbar', '.signin-bar', '#meeting-strip', '#main']);
    expect(rows).toEqual([1, 2, 3, 4]);
  });

  it('keeps #main in the last row whether or not the strip is displayed', () => {
    const children = shellChildren('signed-out');
    const tracks = splitTracks(uniqueDecl('#shell', 'grid-template-rows', 'signed-out') ?? '');
    for (const stripVisible of [false, true]) {
      const rows = placeRows(children, {
        rowOf: rowOfIn('signed-out'),
        displayed: inFlowOnly('signed-out', stripVisible),
      });
      expect(rows.get('#main'), `strip visible: ${stripVisible}`).toBe(tracks.length);
      expect(rows.get('#topbar')).toBe(1);
      expect(rows.get('.signin-bar')).toBe(2);
    }
  });

  /**
   * The control, and the shape of the bug this posture actually shipped.
   *
   * Feed the model the gated stylesheet as it was — the bar unplaced, the
   * other three still pinned 1/2/3 by the signed-in rules — and it must
   * reproduce what a browser measured: the bar auto-placing into row 2 (the
   * lowest free row from the cursor, since the hidden strip vacates it),
   * `#main` in row 3, and the fourth and only flexible track holding nothing.
   * That empty track is the dead band, 3px at 1180x820 and 55px at 430px.
   */
  it('control: with the bar unplaced, the last track goes empty', () => {
    const children = shellChildren('signed-out');
    const asShipped = (sel: string) => (sel === '.signin-bar' ? null : rowOfIn('signed-in')(sel));
    const rows = placeRows(children, {
      rowOf: asShipped,
      displayed: inFlowOnly('signed-out', false),
    });
    expect(rows.get('.signin-bar')).toBe(2);
    expect(rows.get('#main')).toBe(3);
    expect([...rows.values()]).not.toContain(4);
  });
});
