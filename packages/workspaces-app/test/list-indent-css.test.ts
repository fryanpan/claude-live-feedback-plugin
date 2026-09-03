import { afterEach, describe, expect, it } from 'vitest';
import { IPAD, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The doc editor's list indent (meeting-notes UX plan AC 3a): at the first
 * nesting level the bullet marker must sit clearly RIGHT of where body
 * paragraph text starts — the whole list block is indented relative to prose.
 *
 * This used to read `styles.css` as text and regex the declaration out of the
 * rule body, which passes on a stylesheet where the rule is still written but
 * no longer reaches the element — a selector renamed above it, a later rule
 * overriding it, a media query that stopped matching. happy-dom runs the real
 * cascade over the installed sheet, so the number below is the one the
 * element actually resolves, and the control list proves the selector chain is
 * what puts it there rather than some blanket default.
 *
 * Geometry stays out of reach: happy-dom resolves no layout, so this asserts
 * the resolved padding, not the rendered position of the marker.
 */

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.innerHTML = '';
});

/** An editor-shaped tree: `#editor > .ProseMirror` with a list inside it. */
function editorList(tag: 'ul' | 'ol'): HTMLElement {
  const editor = attach('', { attrs: { id: 'editor' } });
  const surface = attach('ProseMirror', { parent: editor });
  return attach('', { tag, parent: surface });
}

describe('editor list indent', () => {
  it('indents editor lists clearly right of the body-paragraph text margin', () => {
    cleanup = installSheets('styles.css');
    setViewport(IPAD);

    for (const tag of ['ul', 'ol'] as const) {
      const padding = Number.parseFloat(styleOf(editorList(tag)).paddingLeft);
      // An outside marker occupies roughly 22px left of the item's text edge
      // at the editor's 16px base size, so anything under ~36px leaves the
      // level-1 marker visually flush with the paragraph margin instead of
      // clearly right of it.
      expect(padding, `${tag} padding-left`).toBeGreaterThanOrEqual(36);
    }
  });

  it('gets that indent from the editor rule, not from a default', () => {
    // The control. A list with the same tag outside `#editor > .ProseMirror`
    // must not arrive at the same number on its own — otherwise the assertion
    // above would pass against a stylesheet whose editor rule was deleted.
    cleanup = installSheets('styles.css');
    setViewport(IPAD);

    const loose = attach('', { tag: 'ul' });
    const inside = editorList('ul');

    const loosePadding = Number.parseFloat(styleOf(loose).paddingLeft || '0');
    const insidePadding = Number.parseFloat(styleOf(inside).paddingLeft);
    expect(insidePadding, `loose ul resolves ${loosePadding}px too`).toBeGreaterThan(loosePadding);
  });
});
