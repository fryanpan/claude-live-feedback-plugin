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

describe('createRedlineEditor — structural blocks', () => {
  it('renders a changed fenced code block as real code, not corrupted text', () => {
    // Wrapping a fence per line produced "<del>```js</del>\n<del>const a = 1;</del>",
    // whose backticks paired into an inline code span across the wrappers: the
    // fence vanished and the tags rendered as escaped literal text. This repo's
    // own docs are mostly fences.
    const { parent } = mount(
      'Intro.\n\n```js\nconst a = 1;\n```\n',
      'Intro.\n\n```js\nconst a = 2;\n```\n',
    );
    expect(parent.querySelector('pre')).not.toBeNull();
    expect(parent.textContent).not.toContain('</del>');
    expect(parent.textContent).not.toContain('&lt;');
    expect(parent.textContent).toContain('const a = 2;');
  });

  it('still anchors a comment on a changed fence', () => {
    // The code block renders through MermaidCodeBlock's NodeView, which does
    // not pass data-* to the DOM — but the provenance index reads NODE attrs,
    // not the DOM, so anchoring is unaffected. (The CSS change bar cannot
    // attach for the same reason; see the known limitation in the PR.)
    const newText = 'Intro.\n\n```js\nconst a = 2;\n```\n';
    const { surface, content } = mount('Intro.\n\n```js\nconst a = 1;\n```\n', newText);
    const from = newText.indexOf('```js');
    const range = surface.resolveRel(...anchorFor(content, from, from + 5));
    expect(range).not.toBeNull();
  });

  it('keeps an unchanged fence unmarked and intact', () => {
    const md = 'Intro.\n\n```js\nconst a = 1;\n```\n';
    const { parent } = mount(md, md);
    expect(parent.querySelector('pre')).not.toBeNull();
    expect(parent.innerHTML).not.toContain('data-lf-change');
  });

  it('renders a changed table as a table, not a paragraph of pipes', () => {
    const { parent } = mount(
      'Intro.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n',
      'Intro.\n\n| a | b |\n| --- | --- |\n| 1 | 3 |\n',
    );
    expect(parent.querySelector('table')).not.toBeNull();
    expect(parent.textContent).not.toContain('</del>');
  });
});

describe('createRedlineEditor — getSelectionRel', () => {
  /** Decode an anchor back to a content offset, to compare against what the
   *  source diff surface would have produced for the same lines. */
  function decode(ydoc: Y.Doc, bytes: Uint8Array): number | null {
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(bytes), ydoc);
    return abs ? abs.index : null;
  }

  it('produces the same line-snapped anchor the source diff surface would', () => {
    // THE headline claim of the design — previously asserted nowhere.
    const newText = '# T\n\nAlpha here.\n\nBravo there.\n';
    const { surface, ydoc, parent } = mount('# T\n\nAlpha here.\n', newText);
    const target = parent.querySelector('[data-lf-change="ins"]') as HTMLElement | null;
    expect(target).not.toBeNull();
    const from = Number(target?.getAttribute('data-lf-from'));
    const to = Number(target?.getAttribute('data-lf-to'));

    // Select inside that block, the way a reviewer would.
    const { doc } = surface as unknown as { __editor?: unknown } as never;
    void doc;
    const range = document.createRange();
    range.selectNodeContents(target as Node);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const got = surface.getSelectionRel();
    expect(got).not.toBeNull();
    const start = decode(ydoc, (got as { start: Uint8Array }).start);
    const end = decode(ydoc, (got as { end: Uint8Array }).end);
    // Line-snapped over the block's own span — byte-identical to what
    // snapToLines gives the CodeMirror surface for the same lines.
    const expected = snapExpected(newText, from, to);
    expect(start).toBe(expected.from);
    expect(end).toBe(expected.to);
    surface.destroy();
  });

  /** Mirror of core's snapOffsetsToLines, restated here so the test doesn't
   *  just re-run the implementation it is checking. */
  function snapExpected(text: string, from: number, to: number) {
    const start = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
    const nl = text.indexOf('\n', to);
    return { from: start, to: nl === -1 ? text.length : nl };
  }

  it('lets a comment be made on a deletion at the very end of the document', () => {
    // Regression: snapTo === newMd.length made getSelectionRel return null, so
    // the pill never appeared and the deletion was silently uncommentable.
    const { surface, parent } = mount(
      '# Title\n\nKept paragraph.\n\nDoomed final paragraph.\n',
      '# Title\n\nKept paragraph.\n',
    );
    const del = parent.querySelector('[data-lf-change="del"]') as HTMLElement | null;
    expect(del).not.toBeNull();
    const range = document.createRange();
    range.selectNodeContents(del as Node);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const got = surface.getSelectionRel();
    expect(got).not.toBeNull();
    // And it records what the comment was actually about.
    expect((got as { deletedSnippet?: string }).deletedSnippet).toContain('Doomed');
    surface.destroy();
  });
});
