import { getContent } from '@feedback/core';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { type RedlineSurface, createRedlineEditor } from '../src/redline/redline-editor.ts';

const open: Array<{ surface: RedlineSurface; parent: HTMLElement }> = [];
afterEach(() => {
  for (const o of open.splice(0)) {
    o.surface.destroy();
    o.parent.remove();
  }
});

function mount(baseText: string, newText: string) {
  const ydoc = new Y.Doc();
  if (newText) getContent(ydoc).insert(0, newText);
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const surface = createRedlineEditor({ parent, ydoc, baseText });
  open.push({ surface, parent });
  return { ydoc, parent, surface, content: getContent(ydoc) };
}

/** Build an anchor the way the CodeMirror source-diff surface does: CM offsets
 *  are byte-identical to `content` indices, so this is literally what
 *  code-editor.getSelectionRel() produces for the same lines. */
function anchorFor(content: Y.Text, from: number, to: number): [Uint8Array, Uint8Array] {
  return [
    Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(content, from)),
    Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(content, to)),
  ];
}

describe('createRedlineEditor', () => {
  it('renders prose as prose with inline ins/del', () => {
    const { parent } = mount('The quick brown fox.\n', '# T\n\nThe quick red fox.\n');
    expect(parent.innerHTML).toContain('<h1 ');
    expect(parent.innerHTML).toContain('lf-del');
    expect(parent.innerHTML).toContain('lf-ins');
  });

  it('does not emit blank filler paragraphs between blocks', () => {
    // Regression: the scratch editor appends a trailing empty paragraph per
    // block, which rendered as filler AND inherited the block's provenance.
    const { parent } = mount('# T\n\nBody.\n', '# T\n\nBody.\n');
    expect(parent.innerHTML).not.toContain('ProseMirror-trailingBreak');
    const empties = (parent.innerHTML.match(/<p[^>]*><\/p>/g) ?? []).length;
    expect(empties).toBe(0);
  });

  it('gives each block its own distinct provenance', () => {
    const newText = '# T\n\nBody.\n';
    const { surface, content } = mount('# T\n\nBody.\n', newText);
    const h = surface.resolveRel(...anchorFor(content, 0, 3));
    const b = surface.resolveRel(
      ...anchorFor(content, newText.indexOf('Body.'), newText.length - 1),
    );
    expect(h).not.toBeNull();
    expect(b).not.toBeNull();
    expect(h).not.toEqual(b);
  });

  it('shows no change marks when base equals content', () => {
    const { parent } = mount('# T\n\nBody.\n', '# T\n\nBody.\n');
    expect(parent.innerHTML).not.toContain('lf-del');
    expect(parent.innerHTML).not.toContain('lf-ins');
    expect(parent.innerHTML).toContain('Body.');
  });

  it('resolves an anchor created by the source diff surface to a prose range', () => {
    // THE interoperability property: one thread, two renderings.
    const newText = '# T\n\nAlpha.\n\nBravo.\n';
    const { surface, content } = mount('# T\n\nAlpha.\n', newText);
    const from = newText.indexOf('Bravo.');
    const range = surface.resolveRel(...anchorFor(content, from, from + 'Bravo.'.length));
    expect(range).not.toBeNull();
    expect((range as { from: number; to: number }).to).toBeGreaterThan(
      (range as { from: number }).from,
    );
  });

  it('resolves anchors on different lines to different prose ranges', () => {
    const newText = '# T\n\nAlpha.\n\nBravo.\n';
    const { surface, content } = mount('# T\n\nAlpha.\n\nBravo.\n', newText);
    const a = newText.indexOf('Alpha.');
    const b = newText.indexOf('Bravo.');
    const ra = surface.resolveRel(...anchorFor(content, a, a + 6));
    const rb = surface.resolveRel(...anchorFor(content, b, b + 6));
    expect(ra).not.toBeNull();
    expect(rb).not.toBeNull();
    expect(ra).not.toEqual(rb);
  });

  it('returns null for an anchor that no longer resolves', () => {
    const { surface } = mount('A.\n', 'A.\n');
    const orphan = new Uint8Array([1, 2, 3, 4]);
    expect(() => surface.resolveRel(orphan, orphan)).not.toThrow();
  });

  it('re-renders when content changes (an agent save)', () => {
    const { ydoc, parent } = mount('Old text.\n', 'Old text.\n');
    expect(parent.innerHTML).not.toContain('lf-ins');
    const content = getContent(ydoc);
    ydoc.transact(() => {
      content.delete(0, content.length);
      content.insert(0, 'New text.\n');
    });
    expect(parent.innerHTML).toContain('lf-ins');
  });

  it('renders content that arrives AFTER mount', () => {
    // The empty-at-mount case: Yjs syncs after the surface mounts, so anything
    // derived only at mount leaves the view permanently empty. Same class as
    // the collapseUnchanged compartment bug.
    const ydoc = new Y.Doc();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const surface = createRedlineEditor({ parent, ydoc, baseText: '' });
    open.push({ surface, parent });
    expect(parent.textContent ?? '').not.toContain('Arrived late');
    getContent(ydoc).insert(0, '# Arrived late\n');
    expect(parent.textContent ?? '').toContain('Arrived late');
  });

  it('renders a whole-file insertion when the base is empty (added file)', () => {
    const { parent } = mount('', '# New file\n\nBody.\n');
    expect(parent.innerHTML).toContain('lf-ins');
    expect(parent.textContent).toContain('New file');
  });

  it('keeps deleted blocks visible with a snap target', () => {
    const { parent } = mount('A.\n\nGone.\n\nC.\n', 'A.\n\nC.\n');
    expect(parent.textContent).toContain('Gone.');
    expect(parent.innerHTML).toContain('lf-del');
  });

  it('reports a 1-based content line for a prose position', () => {
    const { surface } = mount('A.\n', 'A.\n\nB.\n');
    const line = surface.lineForPos?.(1);
    expect(typeof line).toBe('number');
    expect(line).toBeGreaterThanOrEqual(1);
  });

  it('does not throw on pulseRange or setThreadRanges', () => {
    const { surface } = mount('A.\n', 'A.\n');
    expect(() => surface.pulseRange(0, 1)).not.toThrow();
    expect(() => surface.setThreadRanges([], null)).not.toThrow();
  });

  it('survives two adjacent lists without losing provenance', () => {
    // The merge case the HTML renderer exists to defuse: a rewritten list is a
    // deleted list followed by an inserted list.
    const newText = '- c\n- d\n';
    const { surface, content } = mount('- a\n- b\n', newText);
    const range = surface.resolveRel(...anchorFor(content, 0, 3));
    expect(range).not.toBeNull();
  });
});
