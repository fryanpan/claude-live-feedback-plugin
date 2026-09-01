import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The top-bar overhaul moved the transcript strip out of `#editor-pane` and
 * into `#shell` itself — the strip is `#shell`'s second grid row, fused
 * directly under the bar the Record button sits in (the notch points at it),
 * so its height comes out of the editor below rather than sitting on top of
 * the prose. happy-dom resolves no real layout, so that placement and the
 * strip's own shape are asserted against the stylesheet and the shell markup,
 * same as before the redesign.
 *
 * One shape at both widths Bryan reads on (1180x820 and 430px) — a single
 * flex row that only tweaks its own padding/gap/notch position narrow; there
 * is no separate stacked-panel layout any more (the old chrome's mode/engine
 * switches, toggle button and status word are gone — every choice now lives
 * in the popovers behind the Record button).
 */
const SRC = resolve(import.meta.dirname, '../src');
const CSS = readFileSync(resolve(SRC, 'styles.css'), 'utf8');
const SHELL = readFileSync(resolve(import.meta.dirname, '../index.html'), 'utf8');
const MOUNT = readFileSync(resolve(SRC, 'meeting-strip.ts'), 'utf8');
const APP = readFileSync(resolve(SRC, 'app.ts'), 'utf8');

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function rule(selector: string, within: string = declarationsOnly(CSS)): string {
  const at = new RegExp(
    `(^|\\n|\\{)\\s*${selector.replace(/[.+*[\]():#-]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(within);
  return at?.[2] ?? '';
}

/** The body of a brace-balanced at-rule, so nested rules can be read out. */
function block(header: string, within = CSS): string {
  const start = within.indexOf(header);
  if (start < 0) return '';
  let depth = 0;
  for (let i = within.indexOf('{', start); i < within.length; i++) {
    if (within[i] === '{') depth += 1;
    else if (within[i] === '}') {
      depth -= 1;
      if (depth === 0) return within.slice(within.indexOf('{', start) + 1, i);
    }
  }
  return '';
}

/** Everything under the MEETING banner, up to the next banner. */
const SECTION = (() => {
  const at = /\/\* =+ MEETING RECORD CHROME =+/.exec(CSS);
  if (!at) return '';
  const rest = CSS.slice(at.index + at[0].length);
  const next = /\n\/\* =+ [A-Z]/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
})();

describe('the strip lives in its own section of the stylesheet', () => {
  it('has a banner of its own rather than being appended at the end', () => {
    expect(SECTION, 'no MEETING RECORD CHROME banner').not.toBe('');
    // Appending at EOF is what makes parallel branches conflict every time.
    expect(CSS.trimEnd().endsWith(SECTION.trimEnd())).toBe(false);
  });
});

describe('the shell reserves a row for the strip', () => {
  it('gives #shell three tracks: topbar, strip, main', () => {
    // The strip's `auto` track is what makes it RESERVE its height instead of
    // covering the prose. That track is not sufficient on its own: a hidden
    // strip is `display: none`, which drops it out of the grid's item list
    // rather than collapsing its track, so #main used to auto-place into the
    // strip's row and leave the last one empty. The three children are pinned
    // explicitly now — shell-grid-placement.test.ts owns that invariant and
    // the control that proves the bug is still detectable.
    expect(rule('#shell')).toMatch(/grid-template-rows:\s*48px auto minmax\(0,\s*1fr\)/);
  });

  it('no longer asks #editor-pane for that row — the strip left the pane', () => {
    // Two tracks only: the format bar and the document. The floating Approve
    // button and the view-controls toggle are `position: absolute` and claim
    // no track of their own.
    expect(rule('#editor-pane')).toMatch(/grid-template-rows:\s*auto 1fr\s*;/);
    expect(rule('#editor-pane')).not.toMatch(/auto 1fr auto/);
  });

  it('positive control: the shell really puts the strip between the bar and main', () => {
    const topbarEnd = SHELL.indexOf('</header>');
    const mainStart = SHELL.indexOf('<main');
    const stripAt = SHELL.indexOf('id="meeting-strip"');
    expect(topbarEnd).toBeGreaterThan(-1);
    expect(mainStart).toBeGreaterThan(-1);
    expect(stripAt, 'no #meeting-strip in the shell').toBeGreaterThan(-1);
    expect(stripAt).toBeGreaterThan(topbarEnd);
    expect(stripAt).toBeLessThan(mainStart);
  });

  it('is hidden until a markdown doc mounts it, so a diff review keeps its layout', () => {
    expect(SHELL).toMatch(/id="meeting-strip"[\s\S]{0,80}?hidden/);
    expect(MOUNT).toMatch(/root\.hidden = !stripVisible\(\)/);
    expect(MOUNT).toMatch(/root\.hidden = true/);
    // A hidden strip must not claim its grid row anyway — `display: flex`
    // out-specifies the UA's `[hidden]` rule, so this override is load-bearing.
    expect(rule('.meeting-strip[hidden]', declarationsOnly(SECTION))).toMatch(/display:\s*none/);
    // The diff surface's own floating controls are absolutely positioned, so
    // they claim no track — but only the markdown mount adds the strip at all.
    expect(APP).toMatch(/docType === 'markdown'/);
  });
});

describe('the speaker tag', () => {
  const tag = rule('.meeting-speaker', declarationsOnly(SECTION));

  it('lives in the strip section, muted and smaller than the words it labels', () => {
    expect(tag, 'no .meeting-speaker rule in the MEETING section').not.toBe('');
    expect(tag).toMatch(/cursor:\s*pointer/);
    // The look lives on the pill inside it; see the split below.
    const pill = rule('.meeting-speaker-pill', declarationsOnly(SECTION));
    expect(pill).toMatch(/color:\s*var\(--fg-muted\)/);
    expect(pill).toMatch(/font-size:\s*1[01](\.\d+)?px/);
    // A button that reads as a tag: no UA chrome.
    expect(pill).toMatch(/border-radius:\s*var\(--radius-pill\)/);
  });

  /**
   * The split IS the fix (see the stylesheet's own comment on it): the
   * button is a transparent box whose PADDING is the tap target, and the
   * pill inside carries every visual and the only overflow. Nothing in the
   * new design clips the feed to a fixed-height window the way the old
   * `.meeting-caption` did — `.meeting-feed` has no explicit height, so the
   * button's own box is the whole story now. Still measured rather than
   * trusted on the ingredients alone: two rounds of review were lost to a
   * pseudo-element hit area that a clip on any ancestor (including the
   * button's own) silently ate down to 19px.
   */
  const px = (v: string | undefined, emBase: number): number => {
    if (!v) return Number.NaN;
    const em = /^(-?[\d.]+)em$/.exec(v.trim());
    if (em) return Number(em[1]) * emBase;
    const n = /^(-?[\d.]+)px$/.exec(v.trim());
    return n ? Number(n[1]) : Number.NaN;
  };
  const decl = (body: string, prop: string): string | undefined =>
    new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(body)?.[1]?.trim();

  it('the tap target MEASURES at least 36px — the pill plus the button padding', () => {
    const STRIP_FONT = px(decl(rule('.meeting-strip', declarationsOnly(SECTION)), 'font-size'), 16);
    const pill = rule('.meeting-speaker-pill', declarationsOnly(SECTION));
    const pillH =
      px(decl(pill, 'font-size'), STRIP_FONT) * Number(decl(pill, 'line-height')) +
      2 * px(/^([\d.]+px)/.exec(decl(pill, 'border') ?? '')?.[1], STRIP_FONT);
    const btnPad = Number(
      /padding:\s*([\d.]+)px/.exec(rule('.meeting-speaker', declarationsOnly(SECTION)))?.[1],
    );
    expect(Number.isFinite(pillH) && pillH > 0, 'the model read nothing off the pill').toBe(true);
    const hit = pillH + 2 * btnPad;
    expect(hit, `hit ${hit} from a ${pillH}px pill and ${btnPad}px padding`).toBeGreaterThanOrEqual(
      36,
    );
  });

  it('keeps the target and the clip on separate elements', () => {
    // The split IS the fix: the button holds the padding and nothing that
    // clips; the pill holds every visual and the only overflow. Collapse them
    // and the ellipsis clips the tap target again.
    const btn = rule('.meeting-speaker', declarationsOnly(SECTION));
    expect(btn).not.toMatch(/overflow:/);
    expect(btn).not.toMatch(/text-overflow:/);
    expect(btn).toMatch(/background:\s*none/);
    expect(btn).toMatch(/border:\s*0/);
    // The line box must not grow by the padding, or the feed's line moves.
    expect(btn).toMatch(/margin:\s*-\d+px/);
    // And no pseudo-element target survives to be clipped a third time.
    expect(rule('.meeting-speaker::before', declarationsOnly(SECTION))).toBe('');
  });

  it('caps the tag so naming a voice cannot push every tag out of the window', () => {
    // A 60-character name rendered a 335px pill, wrapped the line, and hid
    // every tag — naming a speaker turned the labels off.
    const pill = rule('.meeting-speaker-pill', declarationsOnly(SECTION));
    expect(pill).toMatch(/max-width:\s*\d+(\.\d+)?em/);
    expect(pill).toMatch(/overflow:\s*hidden/);
    expect(pill).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('looks like a control at rest, where there is no hover to reveal it', () => {
    // `cursor: pointer` and the title attribute are both hover-only, so on the
    // iPad nothing said the pill was tappable.
    expect(rule('.meeting-speaker-pill', declarationsOnly(SECTION))).toMatch(
      /text-decoration:\s*underline dotted/,
    );
    // The pencil is at the START so the ellipsis on a long name can never
    // eat it, and it is CSS content rather than markup so the button's own
    // aria-label stays the accessible name.
    expect(rule('.meeting-speaker-pill::before', declarationsOnly(SECTION))).toMatch(
      /content:\s*["']✎ ["']/,
    );
  });
});

describe('the strip itself: one flex row, blinker · clock · flowing feed', () => {
  const strip = rule('.meeting-strip', declarationsOnly(SECTION));

  it('is a single flex row at least 36px tall, at every width', () => {
    expect(strip).toMatch(/display:\s*flex/);
    expect(strip).toMatch(/align-items:\s*center/);
    expect(strip).toMatch(/min-height:\s*36px/);
    expect(block('@media (max-width: 640px)', SECTION)).not.toMatch(/flex-direction:\s*column/);
  });

  it('reads as chrome against the prose, not as more document', () => {
    expect(strip).toMatch(/background:\s*var\(--bg-panel\)/);
    expect(strip).toMatch(/border-bottom:\s*1px solid var\(--border\)/);
    expect(strip).toMatch(/font-family:\s*var\(--sans\)/);
  });

  it('fuses to the Record button in the bar above with a notch', () => {
    const before = rule('.meeting-strip::before', declarationsOnly(SECTION));
    expect(before, 'no notch').not.toBe('');
    expect(before).toMatch(/transform:\s*rotate\(45deg\)/);
  });

  it('reads red while live — the button and the strip as one unit', () => {
    expect(rule('.meeting-strip.is-live', declarationsOnly(SECTION))).toMatch(
      /border-bottom-color:\s*color-mix/,
    );
    expect(strip).toMatch(/font-family:\s*var\(--sans\)/);
  });

  it('flows the feed on one line with a fade at the tail, newest words at the right', () => {
    const feed = rule('.meeting-feed', declarationsOnly(SECTION));
    expect(feed).toMatch(/white-space:\s*nowrap/);
    expect(feed).toMatch(/mask-image:\s*linear-gradient/);
    expect(rule('.meeting-feed-inner', declarationsOnly(SECTION))).toMatch(/float:\s*right/);
  });

  it('lets a held note wrap instead of forcing the flowing-feed treatment on it', () => {
    // A note is read left-to-right from its start and may need two lines —
    // the mask/nowrap treatment is for words that arrive forever, not for
    // one sentence with an audience.
    const withNote = rule('.meeting-feed:has(.meeting-note)', declarationsOnly(SECTION));
    expect(withNote).toMatch(/white-space:\s*normal/);
    expect(withNote).toMatch(/mask-image:\s*none/);
  });

  it('gives the announcement reading size and colour, since someone reads it ALOUD', () => {
    // Every other string in the strip is a readout glanced at by the one
    // person holding the device. This one is a script read out to a room off
    // an iPad at arm's length.
    const note = rule('.meeting-note-dismiss', declarationsOnly(SECTION));
    expect(note, 'no rule for the dismissible announcement').not.toBe('');
    const size = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(note);
    expect(size, 'the announcement has no size of its own').not.toBeNull();
    expect(Number(size?.[1])).toBeGreaterThanOrEqual(16);
    expect(note).toMatch(/color:\s*var\(--fg\)/);
    expect(note).toMatch(/background:\s*none/);
    expect(note).toMatch(/border:\s*0/);
    expect(note).toMatch(/cursor:\s*pointer/);
  });

  it('gives a held announcement the room instead of clipping it at the bar height', () => {
    expect(rule('.meeting-strip:has(.meeting-note-dismiss)', declarationsOnly(SECTION))).toMatch(
      /padding-block:\s*5px/,
    );
  });

  it('narrows without stacking into a column — only the record button, gap and notch move', () => {
    const narrow = declarationsOnly(block('@media (max-width: 640px)', SECTION));
    expect(narrow, 'no narrow-width block for the strip').not.toBe('');
    expect(rule('.meeting-strip', narrow)).toMatch(/gap:\s*8px/);
    expect(rule('.meeting-strip', narrow)).toMatch(/padding:\s*0 10px/);
    expect(rule('.meeting-record', narrow)).toMatch(/font-size:\s*12px/);
    // The popovers become an edge-to-edge sheet under the bar there.
    expect(narrow).toMatch(/\.meeting-pop,\s*\n?\s*\.meeting-sheet/);
  });

  it('yields to an open keyboard at phone width — layout only, never the live mic', () => {
    const yieldBlock = block('@media (max-width: 720px)', SECTION);
    expect(yieldBlock).toContain('data-edit-viewport="hidden"');
    expect(
      rule('body[data-edit-viewport="hidden"] .meeting-strip', declarationsOnly(yieldBlock)),
    ).toMatch(/display:\s*none/);
  });
});

describe('motion', () => {
  it('blinks the dot only while actually recording', () => {
    const blinker = rule('.meeting-blinker', declarationsOnly(SECTION));
    expect(blinker, 'no .meeting-blinker rule').not.toBe('');
    expect(blinker).toMatch(/animation:\s*meeting-blink/);
    expect(SECTION).toContain('@keyframes meeting-blink');
    // Requesting/bot-not-live/settled-failure states hold it still — a
    // blinking dot beside "the mic was refused" claims a recording that is
    // not happening.
    expect(SECTION).toMatch(
      /\.meeting-strip\[data-state="unavailable"\][\s\S]{0,260}animation:\s*none/,
    );
  });

  it('flashes only the word the model rewrote', () => {
    expect(rule('.meeting-caption-line .w.is-fixed', declarationsOnly(SECTION))).toMatch(
      /animation:\s*meeting-fix/,
    );
    expect(SECTION).toContain('@keyframes meeting-fix');
  });

  it('holds both still for a reader who asked for no motion', () => {
    const reduced = block('@media (prefers-reduced-motion: reduce)', SECTION);
    expect(reduced, 'the strip animates unconditionally').not.toBe('');
    expect(reduced).toContain('.meeting-blinker');
    expect(reduced).toContain('.w.is-fixed');
    expect(reduced).toMatch(/animation:\s*none/);
  });
});
