import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The review shell's back arrow as a TAP TARGET.
 *
 * design-mobile.md asks for the back arrow to stay tappable at ≥36px. The hub
 * topbar's arrow has had that rule since it was written (`.hub-topbar
 * .back-link`); the review app's arrow never did, and it is the one Bryan uses
 * — measured in a browser at a 440px viewport before this rule existed, the
 * review `←` was **26 × 20 CSS px**: a 16px glyph with `padding: 2px 6px` and
 * nothing else. The base rule is shared by both surfaces, so it cannot simply
 * grow: widening `.back-link` globally would relayout the hub arrow that
 * already has its own sizing.
 *
 * happy-dom resolves no media queries and has no layout engine, so this asserts
 * the CASCADE SHAPE — the rule exists, it is scoped to the phone block, and it
 * declares AFTER the base rule it has to beat. A media query adds no
 * specificity ("A media query adds no specificity" in learnings.md), so source
 * order is the whole of it. The rendered size is measured in a browser against
 * a real build; that is what closes the criterion.
 */
// The board's cascade is two files since the hub block moved to hub.css:
// styles.css keeps the shared chrome, hub.css carries the board's own rules,
// and the hub shell loads them in that order. A rule this suite pins may sit
// in either, so read the pair the page actually loads. Two reads on purpose:
// a one-line read is what `bun run test:audit` counts, and folding them into
// a loop would hide a source-shape site rather than remove one.
const CSS = [
  readFileSync(resolve('packages/workspaces-app/src/styles.css'), 'utf8'),
  readFileSync(resolve('packages/workspaces-app/src/hub.css'), 'utf8'),
].join('\n');

/** The review app's phone block, opened verbatim. */
const PHONE_CONDITION = '@media (max-width: 720px) {';

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Offset of the phone block that carries the topbar tightening group. */
function topbarPhoneBlockAt(): number {
  let from = 0;
  for (;;) {
    const at = CSS.indexOf(PHONE_CONDITION, from);
    if (at === -1) return -1;
    let depth = 1;
    let i = at + PHONE_CONDITION.length;
    const start = i;
    while (i < CSS.length && depth > 0) {
      if (CSS[i] === '{') depth++;
      else if (CSS[i] === '}') depth--;
      i++;
    }
    if (CSS.slice(start, i - 1).includes('.doc-path')) return at;
    from = at + PHONE_CONDITION.length;
  }
}

/** Body of that block, declarations only. */
function topbarPhoneBlock(): string {
  const at = topbarPhoneBlockAt();
  if (at === -1) return '';
  let depth = 1;
  let i = at + PHONE_CONDITION.length;
  const start = i;
  while (i < CSS.length && depth > 0) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}') depth--;
    i++;
  }
  return declarationsOnly(CSS.slice(start, i - 1));
}

describe("the review shell's back arrow on a phone", () => {
  it('is a rule in the topbar phone block at all', () => {
    // POSITIVE CONTROL for everything below: an extractor that came back empty
    // would let each assertion pass by measuring nothing.
    const body = topbarPhoneBlock();
    expect(body).not.toBe('');
    expect(body).toContain('.doc-path'); // it really is the topbar group
    expect(body).toContain('.doc-crumb .back-link');
  });

  it('reaches the 44px target in BOTH dimensions', () => {
    // 26 × 20 was the measured size, so a height-only fix would still leave a
    // thumb missing it horizontally. 36 was the first floor; 44 is the one
    // the phone's only navigation affordance gets (review of #564).
    const rule = /\.doc-crumb \.back-link\s*\{([^}]*)\}/.exec(topbarPhoneBlock())?.[1] ?? '';
    expect(rule).toMatch(/min-width:\s*44px/);
    expect(rule).toMatch(/min-height:\s*44px/);
  });

  it('keeps the crumb from collapsing under the toolbar in edit mode', () => {
    // Measured at 430px before the floor: the crumb was 8px wide with the
    // arrow and doc name clipped inside it. The floor holds the crumb open and
    // the toolbar is the side that yields — it may shrink and scroll, and it
    // must never push off-screen or clip the crumb.
    const block = topbarPhoneBlock();
    const crumb = /\n\s*\.doc-crumb\s*\{([^}]*)\}/.exec(block)?.[1] ?? '';
    expect(crumb).toMatch(/min-width:\s*\d+px/);
    const toolbar = /\n\s*\.toolbar\s*\{([^}]*)\}/.exec(block)?.[1] ?? '';
    expect(toolbar).toMatch(/flex:\s*0 1 auto/);
    expect(toolbar).toMatch(/min-width:\s*0/);
    expect(toolbar).toMatch(/overflow-x:\s*auto/);
  });

  it('centres the glyph in the grown box rather than letting it sit top-left', () => {
    // `min-height` on an inline element does nothing, and on a block it grows
    // the box while leaving the arrow at the top: the tap area would be right
    // and the arrow would visibly detach from the file path beside it.
    const rule = /\.doc-crumb \.back-link\s*\{([^}]*)\}/.exec(topbarPhoneBlock())?.[1] ?? '';
    expect(rule).toMatch(/display:\s*inline-flex/);
    expect(rule).toMatch(/align-items:\s*center/);
    expect(rule).toMatch(/justify-content:\s*center/);
  });

  it('declares AFTER the shared base rule, or it silently loses', () => {
    // `.doc-crumb .back-link` is two classes to the base rule's one, so it
    // wins on specificity today — this pins the ORDER anyway, because the
    // cheap future edit is to drop the `.doc-crumb ` prefix once someone
    // notices the base rule is the only other one, and at equal specificity a
    // media query contributes nothing and the later rule takes it.
    const base = CSS.search(/\n\.back-link\s*\{/);
    const phone = topbarPhoneBlockAt();
    expect(base).toBeGreaterThan(-1);
    expect(phone).toBeGreaterThan(-1);
    expect(phone).toBeGreaterThan(base);
  });

  it('leaves the desktop arrow and the hub arrow alone', () => {
    // A phone tap target, not a redesign: the base rule keeps its compact
    // padding for the desktop topbar, and the hub keeps the sizing it has had
    // since it was written.
    const base = /\n\.back-link\s*\{([^}]*)\}/.exec(declarationsOnly(CSS))?.[1] ?? '';
    expect(base).not.toMatch(/min-height/);
    expect(base).toMatch(/padding:\s*2px 6px/);
    const hub = /\.hub-topbar \.back-link\s*\{([^}]*)\}/.exec(declarationsOnly(CSS))?.[1] ?? '';
    expect(hub).toMatch(/min-height:\s*36px/);
  });
});
