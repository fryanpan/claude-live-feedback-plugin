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
   * MEASURE THE OUTCOME, NOT THE INGREDIENTS. Two rounds of review were lost
   * here while a test passed: it asserted the pseudo-element that was meant
   * to buy the 36px, then the pseudo AND the caption's padding — and the real
   * target measured 19px both times, because a clip one level away ate it
   * (first .meeting-caption's, then the button's own, added for the
   * ellipsis). Declarations that SHOULD produce 36px are not the claim. So
   * this computes the hit box the way the browser does: the pill's height,
   * the button's padding around it, and then every clip between the button
   * and the strip, which is where both regressions actually happened.
   *
   * happy-dom resolves no layout, so the arithmetic is done here from the
   * stylesheet. It is the model that has to be honest: it walks the ancestor
   * chain and takes the SMALLEST clip, so any new `overflow` on any of them
   * fails this test rather than shipping.
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

  /**
   * The hit box is the INTERSECTION of the button with the clip, at both
   * widths. Three rounds, three variants of one lesson: round one asserted
   * the ingredients, round two the box but not its clip, round three the box
   * and the clip but not the OFFSET between them — the button was the 37.75px
   * designed and still measured 34, because it sat 4.3px above the clip with
   * 5.6px of clip unused below it. So this places the box before measuring
   * it.
   *
   * The placement it models is `vertical-align: middle`, asserted below: the
   * pill's margin box is centred on the text, so the room above and below it
   * inside the clip is symmetric and computable. Baseline alignment is what
   * put it off-centre, so the model would be a lie under it.
   */
  const hitBox = (captionBody: string): { hit: number; clip: number; room: number } => {
    const STRIP_FONT = px(decl(rule('.meeting-strip', declarationsOnly(SECTION)), 'font-size'), 16);
    const pill = rule('.meeting-speaker-pill', declarationsOnly(SECTION));
    const pillH =
      px(decl(pill, 'font-size'), STRIP_FONT) * Number(decl(pill, 'line-height')) +
      2 * px(/^([\d.]+px)/.exec(decl(pill, 'border') ?? '')?.[1], STRIP_FONT);
    const btnPad = Number(
      /padding:\s*([\d.]+)px/.exec(rule('.meeting-speaker', declarationsOnly(SECTION)))?.[1],
    );
    const content = px(decl(captionBody, 'height'), STRIP_FONT);
    const capPad = px(decl(captionBody, 'padding-block'), STRIP_FONT);
    // Centred pill: half the slack in the window, plus the caption's padding.
    const room = (content - pillH) / 2 + capPad;
    return { hit: pillH + 2 * Math.min(btnPad, room), clip: content + 2 * capPad, room };
  };

  it('the tap target MEASURES at least 36px at 1180x820, clip and offset included', () => {
    const capt = rule('.meeting-caption', declarationsOnly(SECTION));
    const { hit, clip } = hitBox(capt);
    expect(Number.isFinite(hit) && hit > 0, 'the model read nothing').toBe(true);
    // The 40px bar is the ceiling on the clip, which is the ceiling on the
    // target — there is no room here to buy slack with more padding.
    expect(clip).toBeLessThanOrEqual(
      px(decl(rule('.meeting-strip', declarationsOnly(SECTION)), 'height'), 16),
    );
    expect(hit, `hit ${hit} in a ${clip} clip`).toBeGreaterThanOrEqual(36);
  });

  it('the tap target MEASURES at least 36px at 430px too', () => {
    const narrow = block('@media (max-width: 720px)', SECTION);
    const capt = `${rule('.meeting-caption', declarationsOnly(SECTION))};${rule('.meeting-caption', declarationsOnly(narrow))}`;
    // The mobile block overrides only the window; the padding carries over.
    const { hit } = hitBox(capt);
    expect(hit).toBeGreaterThanOrEqual(36);
  });

  it('the model it measures against is the one the stylesheet uses', () => {
    // `middle` is a precondition of the arithmetic above, not a preference:
    // under `baseline` a clipping inline-block hangs off its bottom edge and
    // the "room each side" the model assumes is not symmetric.
    expect(rule('.meeting-speaker', declarationsOnly(SECTION))).toMatch(/vertical-align:\s*middle/);
  });

  it('is fully opaque everywhere the current line can paint', () => {
    // The caption's mask hides the line that has rolled off, which really does
    // paint: overflow: hidden clips to the PADDING box, not the content box.
    // So the transparent zone must be exactly the top padding and no more --
    // measured at 1180x820 the pill's top edge lands 0.38px inside the content
    // box, so a ramp of ANY length reaches into it. That is what rendered the
    // pill pale with no top border next to crisp words.
    const capt = rule('.meeting-caption', declarationsOnly(SECTION));
    const STRIP_FONT = px(decl(rule('.meeting-strip', declarationsOnly(SECTION)), 'font-size'), 16);
    const capPad = px(decl(capt, 'padding-block'), STRIP_FONT);
    const mask = decl(capt, 'mask-image') ?? '';
    expect(mask, 'no mask-image on the caption').toMatch(/linear-gradient/);
    const stops = [...mask.matchAll(/(transparent|#000)\s+([\d.]+)px/g)].map((m) => ({
      opaque: m[1] === '#000',
      at: Number(m[2]),
    }));
    const firstOpaque = stops.find((s) => s.opaque);
    expect(firstOpaque, 'the gradient never reaches opaque').toBeTruthy();
    expect(
      firstOpaque!.at,
      `opaque only at ${firstOpaque!.at}px, ${capPad}px of padding — the ramp is inside the pill`,
    ).toBeLessThanOrEqual(capPad);
    // Tighter, and the one that survives the next layout change: the cut must
    // sit at or above where the pill's top ACTUALLY lands, not merely at the
    // padding. Measured at 1180x820 the margin between them is 0.38px, and the
    // line box has already moved twice under this feature (19 -> 22.9px).
    // Either move would have eaten it silently; here it fails a test instead.
    const pill = rule('.meeting-speaker-pill', declarationsOnly(SECTION));
    const pillH =
      px(decl(pill, 'font-size'), STRIP_FONT) * Number(decl(pill, 'line-height')) +
      2 * px(/^([\d.]+px)/.exec(decl(pill, 'border') ?? '')?.[1], STRIP_FONT);
    const window = px(decl(capt, 'height'), STRIP_FONT);
    const pillTop = capPad + (window - pillH) / 2;
    expect(
      firstOpaque!.at,
      `cut at ${firstOpaque!.at}px, pill top at ${pillTop}px — the cut is inside the pill`,
    ).toBeLessThanOrEqual(pillTop);
    // And it must still be transparent right up to there, or the rolled-off
    // line stops being hidden and reappears above the current one.
    const lastClear = stops.filter((s) => !s.opaque).at(-1);
    expect(lastClear?.at).toBe(capPad);
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
    // The line box must not grow by the padding, or the caption's window
    // stops being one line and the words move.
    expect(btn).toMatch(/margin:\s*-\d+px/);
    // And no pseudo-element target survives to be clipped a third time.
    expect(rule('.meeting-speaker::before', declarationsOnly(SECTION))).toBe('');
  });

  it('caps the tag so naming a voice cannot push every tag out of the window', () => {
    // A 60-character name rendered a 335px pill, wrapped the caption line, and
    // hid all three tags — naming a speaker turned the labels off.
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
  });

  it('gives each turn its own line, so a tag never strands above its words', () => {
    // Inline, a turn started where the previous one ended and its tag landed
    // at the END of that line — on a phone, the faded one being clipped away.
    expect(rule('.meeting-turn', declarationsOnly(SECTION))).toMatch(/display:\s*block/);
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

  it('gives the only control the documented 36px tap-target minimum', () => {
    // design-mobile.md: interactive elements are at least 36x36px. The toggle
    // starts and stops, and on a phone it sits on the bottom edge.
    expect(rule('.meeting-toggle', SECTION)).toMatch(/min-height:\s*36px/);
  });

  it('flattens the micro-row so the line reads clock, words, controls', () => {
    const wide = block('@media (min-width: 721px)', SECTION);
    expect(wide, 'no wide-mode block for the strip').not.toBe('');
    expect(rule('.meeting-strip-row', declarationsOnly(wide))).toMatch(/display:\s*contents/);
    expect(rule('.meeting-meta', declarationsOnly(wide))).toMatch(/order:\s*1/);
    expect(rule('.meeting-caption', declarationsOnly(wide))).toMatch(/order:\s*2/);
    expect(rule('.meeting-mode', declarationsOnly(wide))).toMatch(/order:\s*3/);
    // "I'll say it" is a start button, so it belongs with the controls at the
    // end of the line — and it is the secondary one, so it sits BEFORE Start
    // rather than past it.
    expect(rule('.meeting-announce', declarationsOnly(wide))).toMatch(/order:\s*4/);
    expect(rule('.meeting-toggle', declarationsOnly(wide))).toMatch(/order:\s*5/);
  });

  it('gives the announce button the same 36px tap target as the two beside it', () => {
    // design-mobile.md: it sits on the phone's bottom edge in the same row as
    // Start, and a control that is harder to hit than its neighbour reads as
    // broken rather than as secondary.
    expect(rule('.meeting-announce', SECTION)).toMatch(/min-height:\s*36px/);
    // Two short words and an apostrophe, which must not stack — the same
    // reason the mode switch beside it is nowrap.
    expect(rule('.meeting-announce', SECTION)).toMatch(/white-space:\s*nowrap/);
  });

  it('makes the readable announcement look like the note it replaces', () => {
    // It is a <button> because it is dismissible and a dismissible thing has
    // to be reachable by more than a pointer — but the affordance is the
    // whole line, not a control someone has to go and find.
    const note = rule('.meeting-note-dismiss', SECTION);
    expect(note, 'no rule for the dismissible announcement').not.toBe('');
    expect(note).toMatch(/background:\s*none/);
    expect(note).toMatch(/border:\s*0/);
    expect(note).toMatch(/font:\s*inherit/);
    expect(note).toMatch(/color:\s*inherit/);
    expect(note).toMatch(/cursor:\s*pointer/);
  });

  it('says REC at every width while the mic is live, not only on the phone', () => {
    // A dot was enough while the strip only reported to the person holding
    // the device. It announces itself to a ROOM now, and somebody who was
    // told they are being recorded has to be able to look over and see that
    // they still are.
    expect(rule('.meeting-strip.is-live .meeting-status')).toMatch(/display:\s*inline/);
    // 11px text, so the 4.5:1 floor applies, not the 3:1 the dot gets:
    // --red measures 4.26:1 on --bg-panel and fails it; --red-strong is 5.0:1.
    expect(rule('.meeting-strip.is-live .meeting-status')).toMatch(/color:\s*var\(--red-strong\)/);
    // …and "Paused" still is not: the bar has no room for a word that says
    // nothing is happening.
    expect(rule('.meeting-status')).toMatch(/display:\s*none/);
  });

  it('gives the mode switch the same 36px tap target as the control beside it', () => {
    // design-mobile.md again: it sits on the phone's bottom edge next to
    // Start, and a switch that is harder to hit than its neighbour reads as
    // broken rather than as secondary.
    expect(rule('.meeting-mode', SECTION)).toMatch(/min-height:\s*36px/);
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
    // Two lines at the caption's 1.45 line-height — the WINDOW, not the box;
    // the caption's own padding sits outside it.
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

  it('does not pay for the tap target twice on the screen with the least room', () => {
    // The caption carries 9px of its own on each side now (that padding IS
    // the tag's hit area). The panel's own gap and bottom padding stand down
    // rather than stacking on top of it — otherwise the phone's strip grows a
    // full 18px to buy a target the iPad needed too.
    const strip = rule('.meeting-strip', declarationsOnly(narrow));
    expect(strip).toMatch(/gap:\s*0/);
    expect(strip).not.toMatch(/padding-bottom:\s*calc\(\s*\d/);
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
