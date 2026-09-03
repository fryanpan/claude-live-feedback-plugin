import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The goal band's stylesheet half (Bryan's live mockup review, 2026-08-23).
 *
 * These used to read `hub.css` as TEXT — a `ruleBody` regex, a `mediaBlocks`
 * brace-walker and an `effectiveRight` hand-rolled cascade that re-implemented
 * "which declaration wins" in the test. That machine is gone: the sheets are
 * installed, the band is built at each viewport, and the browser's own cascade
 * answers. The avatar-column arithmetic in particular is now the sum of three
 * COMPUTED paddings rather than three parsed shorthands, so an override
 * anywhere — a new media block, a compound selector, a later file — lands in
 * the number instead of slipping past the parser.
 *
 * What is still out of reach is the rendered geometry: happy-dom lays nothing
 * out, so the paddings below are declared values in the same units, not
 * measured columns. The 430px check CLAUDE.md mandates is what confirms the
 * avatars actually line up.
 *
 * The class chains (`.hub-band` › `.hub-goal-row` / `.hub-band-tasks` ›
 * `.hub-task-row`, plus `.is-collapsed`, `.hub-band-done`, `.hub-band-triage`
 * and `.hub-band-reserved`) are what the board island renders;
 * `hub-render.test.ts` pins that.
 *
 * SHEETS: `hub.css` before `styles.css` is the order `renderHubShell` links
 * them in. `tokens.css` is deliberately left out — the file the server serves
 * is a vendored Open Props subset PLUS the mapping in `src/tokens.css`, so
 * installing the mapping half alone would re-point `--accent`, `--border` and
 * friends at an undefined `var(--gray-N)` and every colour read below would
 * come back empty.
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('hub.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/**
 * Every property this file reads, snapshotted the moment it is taken.
 *
 * happy-dom's computed style resolves LAZILY and stays live: hold a
 * declaration across a `setViewport` and every property re-answers for the new
 * viewport, so an iPad reading compared against a phone reading silently
 * compares the phone against itself. (`styleOf` drops the element's cache; it
 * cannot freeze the object it hands back.) These snapshots are plain strings,
 * so a value read at 1180 stays the value read at 1180.
 */
const PROPS = [
  'display',
  'opacity',
  'padding-right',
  'padding-left',
  'grid-template-columns',
  'white-space',
  '-webkit-line-clamp',
  'color',
  'font-size',
  'background-color',
  'border-radius',
  'border-width',
  'border-left-color',
] as const;

type Snap = Record<(typeof PROPS)[number], string>;

function snap(el: Element): Snap {
  const s = styleOf(el);
  return Object.fromEntries(PROPS.map((p) => [p, s.getPropertyValue(p)])) as Snap;
}

/** A band as the board renders it: goal row, then the tasks rail with a row
 *  in it. `bandClasses` picks the flavour (done, triage, reserved, collapsed). */
function band(vp: { width: number; height: number }, bandClasses = 'hub-band') {
  setViewport(vp);
  const root = attach(bandClasses);
  const goal = attach('hub-goal-row', { parent: root });
  const rail = attach('hub-band-tasks', { parent: root });
  const task = attach('hub-task-row', { parent: rail });
  return {
    goal: snap(goal),
    rail: snap(rail),
    task: snap(task),
    goalTitle: snap(attach('hub-goal-title-text', { tag: 'span', parent: goal })),
    goalOpen: snap(attach('hub-goal-open', { tag: 'button', parent: goal })),
    due: snap(attach('hub-due', { tag: 'span', parent: goal })),
    doneNote: snap(attach('hub-done-note', { tag: 'span', parent: goal })),
    triageNote: snap(attach('hub-triage-note', { tag: 'span', parent: goal })),
  };
}

const px = (v: string) => Number.parseFloat(v);

describe('the goal band stylesheet', () => {
  it('hides a folded band’s tasks — the goal row is all a collapsed band shows', () => {
    // Positive control: an OPEN band's rail is on screen and carries its own
    // rule, so `none` below is a real difference rather than an empty read.
    expect(band(IPAD).rail.display).not.toBe('none');
    expect(band(IPAD).rail['padding-left']).toBe('34px');
    expect(band(IPAD, 'hub-band is-collapsed').rail.display).toBe('none');
  });

  // Decision 8: the goal row's owner avatar sits in the same column as the
  // task rows'. That is arithmetic across three rules — the goal row's right
  // padding must equal the tasks' rail padding plus the task row's own — and
  // nothing else enforces it, so it is pinned here as the sum.
  it('keeps the avatar columns aligned: goal-row right pad = rail pad + task-row pad', () => {
    const b = band(IPAD);
    expect(px(b.goal['padding-right'])).toBe(
      px(b.rail['padding-right']) + px(b.task['padding-right']),
    );
  });

  // The same arithmetic where the ≤900 block tightens the task row's padding:
  // the sum has to be re-taken from the values the cascade applies THERE,
  // because the base sum stays true while the phone breaks. (Shipped broken
  // once: the ≤900 block shrank .hub-task-row to 2px and left the goal row at
  // 14px — a 4px drift at the 430px check CLAUDE.md mandates.)
  it('keeps the avatar columns aligned at 430px, where the task row tightens', () => {
    const wide = band(IPAD);
    const phone = band(PHONE);
    // Positive control: the phone really does move the task row's padding —
    // otherwise this re-checks the base sum and proves nothing new.
    expect(px(phone.task['padding-right'])).not.toBe(px(wide.task['padding-right']));
    expect(px(phone.goal['padding-right'])).toBe(
      px(phone.rail['padding-right']) + px(phone.task['padding-right']),
    );
  });

  it('hides the goal caret on mobile, where the whole row already opens', () => {
    // On a pointer that can hover the caret is a hover affordance — present
    // in the grid, invisible until the row is under the cursor…
    const wide = band(IPAD);
    expect(wide.goalOpen.opacity).toBe('0');
    expect(wide.goalOpen.display).not.toBe('none');
    // …and the ≤1100 block removes it outright: a tap cannot hover, and its
    // 16px belong to the title there. The grid loses the track with it, which
    // is the visible consequence and is read here rather than assumed.
    const phone = band(PHONE);
    expect(phone.goalOpen.display).toBe('none');
    expect(wide.goal['grid-template-columns'].split(' ').length).toBeGreaterThan(
      phone.goal['grid-template-columns'].split(' ').length,
    );
  });

  it('lets the mobile title wrap to two clamped lines instead of crushing to ellipsis', () => {
    const wide = band(IPAD).goalTitle;
    const phone = band(PHONE).goalTitle;
    expect(wide['white-space']).toBe('nowrap'); // control: one ellipsized line
    expect(phone['white-space']).toBe('normal');
    expect(phone['-webkit-line-clamp']).toBe('2');
  });

  // The done note is the hover-free half of a done band's treatment, and it
  // must not become a chip: it shares the due date's rule outright, so the
  // three can only ever be styled alike.
  it('draws the done and triage notes as the due date’s own plain muted text — one rule, no chip', () => {
    const b = band(IPAD);
    // Positive control: the muted colour is a rule talking, not an empty read
    // — an element the cascade never reaches inherits the body's own ink.
    const plain = snap(attach('not-a-goal-band-class', { tag: 'span' }));
    expect(b.due.color).not.toBe('');
    expect(b.due.color).not.toBe(plain.color);
    for (const note of [b.doneNote, b.triageNote]) {
      expect(note.color).toBe(b.due.color);
      expect(note['font-size']).toBe(b.due['font-size']);
      expect(note['white-space']).toBe(b.due['white-space']);
      // No chip may grow on any of them.
      expect(note['background-color']).toBe('');
      expect(note['border-radius']).toBe('');
      expect(note['border-width']).toBe('');
    }
  });

  it('mutes a done or triage band’s title, and neutralises the reserved band’s accent', () => {
    const open = band(IPAD);
    for (const flavour of ['hub-band hub-band-done', 'hub-band hub-band-triage']) {
      const muted = band(IPAD, flavour).goalTitle;
      expect(muted.color, flavour).toBe(open.due.color); // the muted token
      expect(muted.color, flavour).not.toBe(open.goalTitle.color); // control
    }
    // Backlog is drawn as NOT a goal: the accent rail goes neutral.
    const reserved = band(IPAD, 'hub-band hub-band-reserved').goal;
    expect(open.goal['border-left-color']).not.toBe(''); // control: the accent is live
    expect(reserved['border-left-color']).not.toBe('');
    expect(reserved['border-left-color']).not.toBe(open.goal['border-left-color']);
  });
});
