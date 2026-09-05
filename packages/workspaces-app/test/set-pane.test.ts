/**
 * The attachment-set sidebar: collapsed by default, opened by choice, no title row.
 *
 * Two rounds of Bryan's feedback on an iPad, 2026-08-19, and the second one
 * retired the first's mechanism:
 *
 *  1. *"In the doc viewer, please remove 'In this review'. Takes up too much
 *     room"* — the header cost ~36px of vertical space to name what the pane's
 *     own contents already say. Deleted; the accessible name survives as
 *     `aria-label` on the <aside>, so a reader who finds it in the markup and
 *     wants to re-add a visible twin meets this test first.
 *
 *  2. *"I actually zoom out a bit and the panel is back on my iPad"* — and
 *     then: *"On desktop, even at the resolutions I'd zoomed out above, would
 *     prefer to have more horizontal space and collapse the left bar."*
 *
 * The second one is why NO width gate HIDES this any more. Page zoom scales
 * the layout viewport: a 1366px iPad at 85% zoom reports 1607px, wider than any
 * laptop a media query could be aimed above. A breakpoint that hides the pane
 * on that iPad necessarily hides it on a 1512px MacBook too, so width cannot
 * express "iPad" at all — the previous fix picked 1367px and was defeated by a
 * pinch. Visibility is now a stored per-reviewer preference, default closed,
 * and width only decides whether the toggle is offered.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WIDE_SCREEN_QUERY, initialSetPaneOpen, wireSetPaneToggle } from '../src/doc/view-prefs.ts';
import { attach, installSheets, setViewport, styleOf } from './css-harness.ts';

const ROOT = resolve(import.meta.dirname, '..');
const HTML = readFileSync(resolve(ROOT, 'index.html'), 'utf8');

/**
 * The width the three sidebar rules agree on. Named once here and asserted
 * against the CASCADE below, rather than restated from `styles.css`: a media
 * query cannot read a custom property, so the number lives in three places in
 * the sheet and nothing in CSS makes the copies agree.
 */
const PANE_TIER = 1101;

/** The chrome the review page paints, at a stated width, with the reviewer's
 *  stored choice applied to <body> the way `wireSetPaneToggle` applies it. */
function chrome(width: number, open: boolean) {
  setViewport({ width, height: 820 });
  document.body.className = open ? 'has-set set-pane-open' : 'has-set';
  document.body.replaceChildren();
  const pane = attach('', { tag: 'aside', attrs: { id: 'set-pane' } });
  const list = attach('', { tag: 'ul', attrs: { id: 'set-pane-list' }, parent: pane });
  const handle = attach('set-resize', { parent: pane });
  const main = attach('', { attrs: { id: 'main' } });
  const toggle = attach('', { tag: 'button', attrs: { id: 'toggle-set-pane' } });
  return {
    pane: styleOf(pane).display,
    list: styleOf(list).padding,
    handle: styleOf(handle).display,
    columns: styleOf(main).gridTemplateColumns,
    toggle: styleOf(toggle).display,
  };
}

describe('attachment-set sidebar', () => {
  it('renders no title row above the doc list', () => {
    expect(HTML).not.toContain('set-pane-header');
    expect(HTML).not.toContain('In this review');
    // Positive control: this really is the file that holds the pane, so the
    // two absences above are absences and not a mis-resolved path.
    expect(HTML).toContain('id="set-pane"');
    expect(HTML).toContain('id="set-pane-list"');
  });

  it('drops the header’s stylesheet rule with it', () => {
    // A rule for markup nobody emits is how the header comes back: the next
    // person to add a heading finds it already styled and assumes it is wanted.
    // Asked of the cascade rather than of the file's text — an element with
    // that class must come out of the sheets carrying nothing.
    const sheets = installSheets('styles.css', 'doc.css');
    setViewport({ width: PANE_TIER, height: 820 });
    document.body.className = 'has-set set-pane-open';
    document.body.replaceChildren();
    const pane = attach('', { tag: 'aside', attrs: { id: 'set-pane' } });
    const header = attach('set-pane-header', { parent: pane });
    // A class the sheet has NEVER heard of, read the same way: the header must
    // be indistinguishable from it. (Only properties a rule would set —
    // inherited ones like `font-size` come down from `#set-pane` and say
    // nothing about whether a `.set-pane-header` rule exists.)
    const nonesuch = attach('set-pane-nonesuch', { parent: pane });
    const props = ['padding', 'margin', 'borderBottom', 'minHeight', 'fontWeight'] as const;
    const read = (el: HTMLElement) => {
      const style = styleOf(el);
      return props.map((k) => `${k}=${style[k]}`).join(' ');
    };
    expect(read(header)).toBe(read(nonesuch));
    // Positive control: the pane around them IS styled, so the sameness above
    // is the absence of a rule and not the absence of a stylesheet.
    expect(styleOf(pane).display).toBe('block');
    expect(styleOf(pane).overflowY).toBe('auto');
    sheets();
    document.body.className = '';
    document.body.replaceChildren();
    setViewport({ width: 1024, height: 768 });
  });

  it('gives the list the top gap the header used to supply', () => {
    // Without this the first doc sits flush against the topbar. The value is
    // deliberately smaller than the 14px the header had — the gap is now doing
    // one job (breathing room) instead of two (breathing room + a label).
    const sheets = installSheets('styles.css', 'doc.css');
    const padding = chrome(PANE_TIER, true).list;
    expect(padding, 'the #set-pane-list rule reached nothing').not.toBe('');
    expect(Number.parseFloat(padding)).toBeGreaterThan(0);
    sheets();
    document.body.className = '';
    document.body.replaceChildren();
    setViewport({ width: 1024, height: 768 });
  });
});

/**
 * Visibility is a stored choice, not a viewport measurement.
 *
 * Bryan, 2026-08-19: *"On desktop, even at the resolutions I'd zoomed out
 * above, would prefer to have more horizontal space and collapse the left
 * bar."* Default closed on every screen; the topbar toggle opens it and the
 * choice is remembered.
 */
describe('initialSetPaneOpen', () => {
  it('starts collapsed on anything smaller than a 4K monitor', () => {
    // Bryan, 2026-08-19: *"let's consider anything below 1920px as a
    // tablet/laptop and my desktop is a 4k monitor … MacBook also shouldn't
    // have the sidebar for diff reviews — it's too much space."* An iPad, a
    // laptop and a small desktop window are one tier for this decision.
    expect(initialSetPaneOpen(null, false)).toBe(false);
  });

  it('starts open on a 4K monitor, where the width is not scarce', () => {
    expect(initialSetPaneOpen(null, true)).toBe(true);
  });

  it('lets a stored choice beat the tier in both directions', () => {
    expect(initialSetPaneOpen('open', false)).toBe(true);
    expect(initialSetPaneOpen('closed', true)).toBe(false);
  });

  it('falls back to the tier on a value it does not recognise', () => {
    // A stale or hand-edited key must not decide this: the preference is one
    // an older build could have written with a different vocabulary, and the
    // tier default is the answer that is right for the screen in front of us.
    expect(initialSetPaneOpen('true', false)).toBe(false);
    expect(initialSetPaneOpen('', true)).toBe(true);
  });

  it('names the 4K boundary once, above every laptop and tablet', () => {
    // 1921, not 1367: pinch-zoom made "is this an iPad" unanswerable from
    // width, so this line no longer tries to answer it. It asks a question
    // width CAN answer — is there enough room that a 320px column costs the
    // prose nothing — and every device below that shares one answer.
    const min = Number(WIDE_SCREEN_QUERY.match(/min-width:\s*(\d+)px/)?.[1]);
    expect(min).toBe(1921);
  });
});

/**
 * The rules that reserve the column and the rule that paints it agree.
 *
 * A media query cannot read a custom property, so the condition is written out
 * more than once and nothing in CSS makes the copies agree. Changing one is a
 * silent half-fix: gate only the pane and the grid still reserves a 320px
 * column with nothing in it; gate only the grid and the sidebar renders into a
 * track that no longer exists.
 */
describe('attachment-set sidebar visibility', () => {
  let sheets = () => {};
  beforeEach(() => {
    sheets = installSheets('styles.css', 'doc.css');
  });
  afterEach(() => {
    sheets();
    document.body.className = '';
    document.body.replaceChildren();
    setViewport({ width: 1024, height: 768 });
  });

  it('paints the sidebar only when the reviewer has opened it', () => {
    // Two readings at the same width: the pane is a CHOICE, and the width
    // gate below only decides whether the choice can be made. A text read
    // could see the `.set-pane-open` in the selector; only the cascade can
    // say the pane is dark without it.
    expect(chrome(PANE_TIER, true).pane).toBe('block');
    expect(chrome(PANE_TIER, false).pane).toBe('none');
  });

  it('reserves the grid column under exactly the same condition', () => {
    // Gate only the pane and the grid still reserves a 320px column with
    // nothing in it; gate only the grid and the sidebar renders into a track
    // that no longer exists. Read as the two layouts a reader would get,
    // one pixel either side of the boundary.
    const wideOpen = chrome(PANE_TIER, true);
    const narrowOpen = chrome(PANE_TIER - 1, true);
    expect(wideOpen.pane).toBe('block');
    expect(wideOpen.columns.startsWith('320px')).toBe(true);
    expect(narrowOpen.pane).toBe('none');
    expect(narrowOpen.columns.startsWith('320px')).toBe(false);
    // …and a closed pane at the wide tier reserves no column either, which is
    // the fall-through the sheet relies on rather than a rule of its own.
    expect(chrome(PANE_TIER, false).columns).toBe(narrowOpen.columns);
  });

  it('offers the toggle only where the sidebar can actually open', () => {
    // Same width as the pane itself: a toggle that flips a class no stylesheet
    // acts on is a dead control, and it appears in the one place — a phone —
    // where there is no room for what it would reveal.
    expect(chrome(PANE_TIER, false).toggle).toBe('inline-flex');
    expect(chrome(PANE_TIER - 1, false).toggle).toBe('none');
    // The toggle does not wait for the pane to be open — it is what opens it.
    expect(chrome(PANE_TIER, true).toggle).toBe('inline-flex');
  });

  it('leaves no width gate that hides the sidebar on its own', () => {
    // The 1367px gate this replaces was defeated by pinch-zoom (see the file
    // header): a 1366px iPad at 85% zoom reports 1607px, so any gate high
    // enough to exclude that iPad also excludes a 1512px MacBook. Asserted as
    // the reading a zoomed-out reviewer actually gets, at every width the old
    // gate would have cut, rather than as the absence of two numbers from the
    // file — a third number would have satisfied that and not this.
    for (const width of [PANE_TIER, 1366, 1512, 1607, 1920, 2560]) {
      expect(chrome(width, true).pane, `hidden at ${width}px`).toBe('block');
    }
  });

  it('keeps the resize handle inside the pane rather than gating it separately', () => {
    // wireResizeHandle appends the handle to #set-pane, so `display: none` on
    // the pane takes the handle with it. The old standalone media query was a
    // third copy of the breakpoint that had to be kept in step by hand.
    // happy-dom does not inherit a hidden parent's display, so what is
    // asserted is that the handle has no width gate OF ITS OWN: its reading is
    // the same either side of the boundary that moves the pane.
    const wide = chrome(PANE_TIER, true);
    const narrow = chrome(PANE_TIER - 1, true);
    expect(wide.pane).not.toBe(narrow.pane); // control: the boundary is live
    expect(narrow.handle).toBe(wide.handle);
  });
});

/**
 * The control itself: present in the markup, and wired to something.
 *
 * The CSS above proves a stylesheet reacts to `.set-pane-open`. It cannot
 * prove anything ever adds that class, and the pure function above cannot
 * prove its answer reaches the DOM. This is the join between them.
 */
describe('doc-list toggle', () => {
  it('ships in the topbar with a state a screen reader can read', () => {
    expect(HTML).toContain('id="toggle-set-pane"');
    const btn = HTML.match(/<button[^>]*id="toggle-set-pane"[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(btn, 'the toggle went missing from index.html').not.toBe('');
    expect(btn).toContain('aria-pressed="false"');
    expect(btn).toContain('aria-label=');
  });

  it('opens the pane, persists the choice, and closes it again', () => {
    document.body.className = '';
    localStorage.clear();
    document.body.innerHTML =
      '<button type="button" id="toggle-set-pane" aria-pressed="false">▤</button>';
    const btn = document.getElementById('toggle-set-pane') as HTMLButtonElement;

    wireSetPaneToggle();
    // happy-dom's viewport is well under the 4K tier, so nothing stored means
    // closed — the state Bryan asked every laptop and tablet to start in.
    expect(document.body.classList.contains('set-pane-open')).toBe(false);

    btn.click();
    expect(document.body.classList.contains('set-pane-open')).toBe(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('lf:set-pane')).toBe('open');

    btn.click();
    expect(document.body.classList.contains('set-pane-open')).toBe(false);
    // 'closed' rather than a cleared key: an explicit close has to survive on
    // a 4K screen, where the absent-key default is open.
    expect(localStorage.getItem('lf:set-pane')).toBe('closed');
  });

  it('applies a stored open choice at startup, not just on click', () => {
    // Without this the initial state is asserted against a body that happened
    // to start clean — true whether or not anything read the preference.
    document.body.className = '';
    localStorage.clear();
    localStorage.setItem('lf:set-pane', 'open');
    document.body.innerHTML =
      '<button type="button" id="toggle-set-pane" aria-pressed="false">▤</button>';
    wireSetPaneToggle();
    expect(document.body.classList.contains('set-pane-open')).toBe(true);
    expect(document.getElementById('toggle-set-pane')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('wires each button once, however many docs are mounted', () => {
    // mountReviewChrome runs per navigation; a second listener on the same
    // button would flip the pane twice per click and land back where it was.
    document.body.className = '';
    localStorage.clear();
    document.body.innerHTML =
      '<button type="button" id="toggle-set-pane" aria-pressed="false">▤</button>';
    wireSetPaneToggle();
    wireSetPaneToggle();
    (document.getElementById('toggle-set-pane') as HTMLButtonElement).click();
    expect(document.body.classList.contains('set-pane-open')).toBe(true);
  });
});
