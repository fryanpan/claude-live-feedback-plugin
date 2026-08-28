import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The transcript strip RESERVES its height — it is a grid row of the editor
 * pane, not a box floating over the prose. That is the whole layout claim, and
 * happy-dom resolves no layout, so it is asserted against the stylesheet and
 * the shell markup the way the docked mic is.
 *
 * Two shapes, checked at the widths Bryan reads on: one 40px bar at 1180x820,
 * and a stacked panel of a micro-row over two rolling lines at 430px. The
 * mockup expressed the switch as a CONTAINER query; this stylesheet has none,
 * so it is a media query at the same 720px breakpoint — which leaves a
 * 721–900px band where the doc is already single-column and the strip is still
 * the bar, so the bar has to survive that block untouched.
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
  const at = /\/\* =+ MEETING TRANSCRIPT STRIP =+/.exec(CSS);
  if (!at) return '';
  const rest = CSS.slice(at.index + at[0].length);
  const next = /\n\/\* =+ [A-Z]/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
})();

describe('the strip lives in its own section of the stylesheet', () => {
  it('has a banner of its own rather than being appended at the end', () => {
    expect(SECTION, 'no MEETING TRANSCRIPT STRIP banner').not.toBe('');
    // Appending at EOF is what makes parallel branches conflict every time.
    expect(CSS.trimEnd().endsWith(SECTION.trimEnd())).toBe(false);
  });
});

describe('the editor pane reserves a row for the strip', () => {
  it('gives #editor-pane a third, content-sized track', () => {
    expect(rule('#editor-pane')).toMatch(/grid-template-rows:\s*auto 1fr auto/);
  });

  it('positive control: the shell really puts the strip in that pane, after the editor', () => {
    const pane = SHELL.slice(SHELL.indexOf('<section id="editor-pane">'));
    const paneEnd = pane.indexOf('</section>');
    const inside = pane.slice(0, paneEnd);
    expect(inside).toContain('id="meeting-strip"');
    // Last child: the editor keeps the 1fr track, so the strip's height comes
    // OUT of the scrolling area rather than sitting on top of it.
    expect(inside.indexOf('id="meeting-strip"')).toBeGreaterThan(inside.indexOf('id="editor"'));
  });

  it('is hidden until a markdown doc mounts it, so a diff review keeps its layout', () => {
    expect(SHELL).toMatch(/id="meeting-strip"[\s\S]{0,200}?hidden/);
    expect(MOUNT).toMatch(/root\.hidden = false/);
    expect(MOUNT).toMatch(/root\.hidden = true/);
    // The diff surface's own floating controls are absolutely positioned, so
    // they claim no track — but only the markdown mount adds the strip at all.
    expect(APP).toMatch(/docType === 'markdown'/);
  });
});

describe('at 1180x820 the strip is one 40px bar', () => {
  const strip = rule('.meeting-strip', declarationsOnly(SECTION));

  it('is a single flex row of a fixed 40px', () => {
    expect(strip).toMatch(/height:\s*40px/);
    expect(strip).toMatch(/display:\s*flex/);
    expect(strip).toMatch(/align-items:\s*center/);
    // `flex: none` — the pane's auto track must not be squeezed by the editor.
    expect(strip).toMatch(/flex:\s*none/);
    expect(strip).not.toMatch(/flex-direction:\s*column/);
  });

  it('reads as chrome against the prose, not as more document', () => {
    expect(strip).toMatch(/background:\s*var\(--bg-panel\)/);
    expect(strip).toMatch(/border-top:\s*1px solid var\(--border\)/);
    expect(strip).toMatch(/font-family:\s*var\(--sans\)/);
  });

  it('flattens the micro-row so the line reads clock, words, control', () => {
    const wide = block('@media (min-width: 721px)', SECTION);
    expect(wide, 'no wide-mode block for the strip').not.toBe('');
    expect(rule('.meeting-strip-row', declarationsOnly(wide))).toMatch(/display:\s*contents/);
    expect(rule('.meeting-meta', declarationsOnly(wide))).toMatch(/order:\s*1/);
    expect(rule('.meeting-caption', declarationsOnly(wide))).toMatch(/order:\s*2/);
    expect(rule('.meeting-toggle', declarationsOnly(wide))).toMatch(/order:\s*3/);
  });

  it('survives the 721-900px band, where the doc is single-column but the strip is not', () => {
    // Nothing between 721 and 900 may restyle the strip — the bar has to hold
    // all the way down to the mobile breakpoint.
    expect(block('@media (max-width: 900px)', SECTION)).toBe('');
    expect(block('@media (max-width: 1100px)', SECTION)).toBe('');
  });
});

describe('at 430px the strip is its own stacked panel', () => {
  const narrow = block('@media (max-width: 720px)', SECTION);

  it('stacks a micro-row over about two lines of rolling transcript', () => {
    expect(narrow, 'no mobile block for the strip').not.toBe('');
    const strip = rule('.meeting-strip', declarationsOnly(narrow));
    expect(strip).toMatch(/height:\s*auto/);
    expect(strip).toMatch(/flex-direction:\s*column/);
    expect(strip).toMatch(/align-items:\s*stretch/);
    // Two lines at the caption's 1.45 line-height.
    expect(rule('.meeting-caption', declarationsOnly(narrow))).toMatch(/height:\s*2\.9em/);
    // The REC/Paused word only exists here; the bar has the room for a clock
    // and nothing else.
    expect(rule('.meeting-status', declarationsOnly(narrow))).toMatch(/display:\s*inline/);
    expect(rule('.meeting-status')).toMatch(/display:\s*none/);
  });

  it('sits at the true bottom edge, clear of the home indicator and the keyboard', () => {
    const strip = rule('.meeting-strip', declarationsOnly(narrow));
    expect(strip).toMatch(/padding-bottom:\s*calc\([^)]*var\(--safe-bottom\)/);
    expect(strip).toMatch(/var\(--kb-bottom, 0px\)/);
  });

  it('does not reserve room for a bottom navbar the doc surface does not have', () => {
    // `--hub-bottom-bar` is only defined under `body.hub-body`; using it here
    // would resolve to nothing and read as a deliberate zero.
    expect(SECTION).not.toContain('--hub-bottom-bar');
    expect(SECTION).not.toContain('hub-nav');
  });
});

describe('motion', () => {
  it('pulses the dot only while live', () => {
    expect(rule('.meeting-strip.is-live .meeting-dot', declarationsOnly(SECTION))).toMatch(
      /animation:\s*meeting-pulse/,
    );
    expect(SECTION).toContain('@keyframes meeting-pulse');
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
    expect(reduced).toContain('.meeting-dot');
    expect(reduced).toContain('.w.is-fixed');
    expect(reduced).toMatch(/animation:\s*none/);
  });
});
