import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The stylesheet half of "editing on a phone is not broken".
 *
 * Two properties no DOM test can see, because happy-dom resolves no layout:
 *
 *  - `#editor`'s bottom padding covers an open keyboard, which is what gives
 *    the LAST line of a document somewhere to scroll to. Without it the
 *    scroller is already at its maximum and `caretScrollDelta` correctly
 *    returns 0 — the caret stays under the keyboard and the fix does nothing
 *    in exactly the case the bug was reported from.
 *  - The meeting strip yields its grid row while an editor has focus, and a
 *    RECORDING strip collapses rather than disappearing.
 *
 * Measured rects at 430x932 and 1180x820 are in the PR body.
 */
const SRC = resolve(import.meta.dirname, '../src');
const CSS = readFileSync(resolve(SRC, 'styles.css'), 'utf8');
const WIRING = readFileSync(resolve(SRC, 'edit-viewport.ts'), 'utf8');

/** Comments carry the same words the rules do; strip them before matching. */
const DECLS = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the rule whose selector is EXACTLY this — anchored at
 *  the start of a line so `body.code-mode #editor` cannot answer for
 *  `#editor`, which is what made the first draft of this file pass on the
 *  wrong rule. */
function rule(selector: string): string {
  const lit = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const at = new RegExp(`(^|\\n)[ ]*${lit}[ ]*\\{([^}]*)\\}`).exec(DECLS);
  return at?.[2] ?? '';
}

describe('the document has scroll runway for an open keyboard', () => {
  it('sizes #editor bottom padding by --kb-bottom at every width', () => {
    // Both declarations: the base rule and the ≤720px override, which
    // re-declares `padding` wholesale and would otherwise drop it.
    const decls = [...DECLS.matchAll(/(?:^|\n)[ ]*#editor[ ]*\{([^}]*)\}/g)].map((m) => m[1]);
    const withPadding = decls.filter((d) => /padding:/.test(d));
    expect(withPadding.length).toBe(2);
    for (const d of withPadding) {
      expect(d).toMatch(/max\(160px,\s*var\(--kb-bottom, 0px\)\)/);
    }
  });

  it('takes the LARGER of the resting gap and the keyboard, not their sum', () => {
    // `160px + --kb-bottom` would leave ~540px of empty document below the
    // last line whenever the keyboard is up.
    const base = rule('#editor');
    // A `not.toMatch` against an empty string passes for the wrong reason.
    expect(base).toMatch(/padding:/);
    expect(base).not.toMatch(/160px \+ var\(--kb-bottom/);
  });
});

describe('the voice strip yields while an editor has focus', () => {
  it('hides an idle strip only under the phone breakpoint', () => {
    const phone = /@media \(max-width: 720px\) \{([\s\S]*?)\n\}/g;
    const blocks = [...DECLS.matchAll(phone)].map((m) => m[1]);
    const yielding = blocks.find((b) => b.includes('data-edit-viewport'));
    expect(yielding, 'the yield rules must live inside the 720px block').toBeTruthy();
    expect(yielding).toMatch(
      /body\[data-edit-viewport="hidden"\]\s*\.meeting-strip\s*\{\s*display: none;/,
    );
  });

  it('collapses a RECORDING strip instead of hiding it', () => {
    const compact = rule('body[data-edit-viewport="compact"] .meeting-strip');
    expect(compact, 'no compact rule at all').not.toBe('');
    expect(compact).toMatch(/padding-bottom:/);
    // Still lifted clear of the keyboard and the home indicator while compact.
    expect(compact).toMatch(/var\(--kb-bottom, 0px\)/);
    // The caption is the part that goes; the meta row (dot, clock, Stop) stays.
    expect(rule('body[data-edit-viewport="compact"] .meeting-caption')).toMatch(/display: none;/);
    expect(DECLS).not.toMatch(/body\[data-edit-viewport="compact"\]\s*\.meeting-meta/);
  });

  it('yields in layout only — never by unmounting or setting [hidden]', () => {
    // `hidden` on the strip root already means "no meeting surface is
    // available here" (meeting-strip.ts sets it around availability). Reusing
    // it would let the strip's own logic un-yield mid-edit, and would end a
    // huddle's only surface for the duration of a keystroke.
    expect(WIRING).not.toMatch(/\.hidden\s*=/);
    expect(WIRING).not.toMatch(/destroy\(\)/);
    expect(WIRING).toContain('dataset.editViewport');
  });
});
