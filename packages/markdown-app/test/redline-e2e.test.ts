import { getContent } from '@feedback/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createRedlineEditor } from '../src/redline/redline-editor.ts';

/**
 * End-to-end shape check on a realistic document: a reworded sentence, a
 * deleted section, a changed list item, an added section, and an untouched
 * blockquote — the mix a real review doc actually contains.
 *
 * These exact bytes were produced by a live server (`POST /api/diffs` over a
 * throwaway repo, then `GET /api/docs/:id/diff`), so this pins the behaviour
 * the reviewer sees rather than a hand-tuned fixture.
 */
const BASE = `# Release notes

The quick brown fox jumps over the lazy dog.

## Removed section

This paragraph will be deleted entirely.

## Kept section

- alpha
- bravo

> A quote that stays put.
`;

const NEW = `# Release notes

The quick red fox vaults over the lazy dog.

## Kept section

- alpha
- charlie

> A quote that stays put.

## Brand new section

Added in this revision.
`;

function mount() {
  const ydoc = new Y.Doc();
  getContent(ydoc).insert(0, NEW);
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const surface = createRedlineEditor({ parent, ydoc, baseText: BASE });
  return { surface, parent, ydoc };
}

describe('redline end-to-end shape', () => {
  it('renders the document as prose, not as markdown source', () => {
    const { parent, surface } = mount();
    const html = parent.innerHTML;
    expect(html).toContain('<h1');
    expect(html).toContain('<h2');
    expect(html).toContain('<ul');
    expect(html).toContain('<blockquote');
    // The reviewer must never see raw markdown syntax in this view.
    expect(parent.textContent).not.toContain('## ');
    expect(parent.textContent).not.toContain('- alpha');
    surface.destroy();
    parent.remove();
  });

  it('word-diffs the reworded sentence instead of rewriting the paragraph', () => {
    const { parent, surface } = mount();
    const html = parent.innerHTML;
    // Only the changed words are marked; the rest of the sentence is bare.
    expect(html).toContain('>brown<');
    expect(html).toContain('>red<');
    expect(html).toContain('jumps');
    expect(html).toContain('vaults');
    const para = Array.from(parent.querySelectorAll('p')).find((p) =>
      (p.textContent ?? '').includes('fox'),
    );
    expect(para?.querySelector('del.lf-del')?.textContent).toBe('brown');
    expect(para?.querySelector('ins.lf-ins')?.textContent).toBe('red');
    // "The quick" and "over the lazy dog." are untouched, so unmarked.
    expect(para?.textContent).toContain('The quick');
    surface.destroy();
    parent.remove();
  });

  it('keeps the deleted section visible and struck through', () => {
    const { parent, surface } = mount();
    expect(parent.textContent).toContain('Removed section');
    expect(parent.textContent).toContain('This paragraph will be deleted entirely.');
    const deleted = Array.from(parent.querySelectorAll('[data-lf-change="del"]'));
    expect(deleted.length).toBeGreaterThan(0);
    // A deleted block has no new-side span, so it carries a snap target.
    expect(deleted.every((el) => el.hasAttribute('data-lf-snap'))).toBe(true);
    surface.destroy();
    parent.remove();
  });

  it('marks the added section as an insertion', () => {
    const { parent, surface } = mount();
    expect(parent.textContent).toContain('Brand new section');
    const added = Array.from(parent.querySelectorAll('[data-lf-change="ins"]'));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((el) => el.hasAttribute('data-lf-from'))).toBe(true);
    surface.destroy();
    parent.remove();
  });

  it('leaves the untouched blockquote unmarked', () => {
    const { parent, surface } = mount();
    const quote = parent.querySelector('blockquote');
    expect(quote?.textContent).toContain('A quote that stays put.');
    expect(quote?.hasAttribute('data-lf-change')).toBe(false);
    expect(quote?.querySelector('del')).toBeNull();
    expect(quote?.querySelector('ins')).toBeNull();
    surface.destroy();
    parent.remove();
  });

  it('changes only the one list item that changed', () => {
    const { parent, surface } = mount();
    const list = parent.querySelector('ul');
    expect(list?.textContent).toContain('alpha');
    expect(list?.querySelector('del.lf-del')?.textContent).toBe('bravo');
    expect(list?.querySelector('ins.lf-ins')?.textContent).toBe('charlie');
    // The list structure must survive — a wrapped "- " would stop being a list.
    expect(list?.querySelectorAll('li').length).toBe(2);
    surface.destroy();
    parent.remove();
  });

  it('anchors a comment on the redline to the same content line as the source view', () => {
    const { surface, ydoc } = mount();
    const content = getContent(ydoc);
    // What code-editor.getSelectionRel() produces for the "Added in this
    // revision." line must resolve in the redline too — one thread, two views.
    const from = NEW.indexOf('Added in this revision.');
    const rel = (o: number) =>
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(content, o));
    const range = surface.resolveRel(rel(from), rel(from + 'Added in this revision.'.length));
    expect(range).not.toBeNull();
    surface.destroy();
  });
});
