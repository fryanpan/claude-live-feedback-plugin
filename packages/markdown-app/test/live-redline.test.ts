import { prose } from '@feedback/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  type LiveRedlineSurface,
  createLiveRedlineEditor,
} from '../src/redline/live-redline-editor.ts';

/**
 * The EDITABLE redline surface: a real collaborative Tiptap editor over the
 * companion doc's prose fragment, with ins/del markup vs baseText computed
 * live as DECORATIONS — never baked into the document content. Built exactly
 * the way the learnings prescribe: Collaboration.configure({ document }) over
 * a real Y.Doc, no provider needed.
 */

const open: Array<{ surface: LiveRedlineSurface; parent: HTMLElement }> = [];
afterEach(() => {
  for (const o of open.splice(0)) {
    o.surface.destroy();
    o.parent.remove();
  }
});

function mount(baseText: string, md: string, debounceMs = 0) {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  if (md !== '') fragment.push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const surface = createLiveRedlineEditor({
    parent,
    ydoc,
    awareness: new Awareness(ydoc),
    baseText,
    debounceMs,
  });
  open.push({ surface, parent });
  return { ydoc, fragment, parent, surface };
}

/** Let the (0ms in tests) debounce fire and the view repaint. */
const tick = () => new Promise((r) => setTimeout(r, 25));

describe('createLiveRedlineEditor — editable collaborative surface', () => {
  it('mounts an EDITABLE editor whose typing lands in the prose fragment', async () => {
    const { fragment, parent, surface } = mount('Hello.\n', 'Hello.\n');
    await tick();
    const pm = parent.querySelector('.ProseMirror');
    expect(pm?.getAttribute('contenteditable')).toBe('true');
    // Typing goes through the Collaboration binding into the SAME Yjs
    // fragment the server write-back and the agent tools operate on.
    surface.handle.editor.commands.insertContentAt(1, 'Typed! ');
    expect(prose.serializeFragmentToMarkdown(fragment)).toContain('Typed!');
  });

  it('exposes thread anchoring against the companion fragment (getSelectionRel/resolveRel)', async () => {
    const { surface } = mount('Alpha.\n\nBravo.\n', 'Alpha.\n\nBravo.\n');
    await tick();
    surface.handle.editor.commands.setTextSelection({ from: 1, to: 6 });
    const sel = surface.getSelectionRel();
    expect(sel).not.toBeNull();
    const range = surface.resolveRel(
      (sel as { start: Uint8Array }).start,
      (sel as { end: Uint8Array }).end,
    );
    expect(range).toEqual({ from: 1, to: 6 });
  });
});

describe('createLiveRedlineEditor — live ins markup', () => {
  it('marks an inserted paragraph with the existing lf-ins styling, as a decoration', async () => {
    const { parent, surface } = mount('Alpha.\n', 'Alpha.\n\nBrand new paragraph.\n');
    await tick();
    const ins = parent.querySelector('ins.lf-ins');
    expect(ins?.textContent).toContain('Brand new paragraph.');
    // Decoration, not content: the document itself carries no redline marks.
    const md = surface.handle.getMarkdown();
    expect(md).not.toContain('lf-ins');
    expect(md).toContain('Brand new paragraph.');
  });

  it('marks only the inserted words inside a reworded paragraph', async () => {
    const { parent } = mount('The quick brown fox.\n', 'The quick red brown fox.\n');
    await tick();
    const marked = Array.from(parent.querySelectorAll('ins.lf-ins'))
      .map((e) => e.textContent ?? '')
      .join(' ');
    expect(marked).toContain('red');
    expect(marked).not.toContain('brown');
  });

  it('recomputes markup live when a REMOTE edit lands in the Yjs doc', async () => {
    const { fragment, parent } = mount('The quick brown fox.\n', 'The quick brown fox.\n');
    await tick();
    expect(parent.querySelector('ins.lf-ins')).toBeNull();
    // A concurrent editor / agent applies a change straight to the fragment —
    // the same path apply_markdown / find_and_replace use on the server.
    prose.applyMarkdownToFragment(fragment, 'The quick brown fox.\n\nAdded remotely.\n');
    await tick();
    expect(parent.querySelector('ins.lf-ins')?.textContent).toContain('Added remotely.');
  });

  it('refresh() recomputes synchronously without waiting out the debounce', async () => {
    const { fragment, parent, surface } = mount('Alpha.\n', 'Alpha.\n', 60_000);
    await tick();
    prose.applyMarkdownToFragment(fragment, 'Alpha.\n\nNot yet marked.\n');
    await tick(); // debounce is 60s — nothing recomputed yet
    expect(parent.querySelector('ins.lf-ins')).toBeNull();
    surface.refresh();
    expect(parent.querySelector('ins.lf-ins')?.textContent).toContain('Not yet marked.');
  });
});

describe('createLiveRedlineEditor — added file (empty base)', () => {
  it('renders clean with no ins markup and no deletions', async () => {
    const { parent, surface } = mount('', '# New file\n\nBody.\n');
    await tick();
    expect(parent.textContent).toContain('New file');
    expect(parent.querySelector('ins.lf-ins')).toBeNull();
    expect(surface.getDeletions()).toEqual([]);
  });
});

describe('createLiveRedlineEditor — getDeletions', () => {
  it('lists a deleted block with its markdown and its live-doc position', async () => {
    const { parent, surface } = mount('A.\n\nGone paragraph.\n\nC.\n', 'A.\n\nC.\n');
    await tick();
    const dels = surface.getDeletions();
    expect(dels).toHaveLength(1);
    expect(dels[0].deletedMarkdown).toContain('Gone paragraph.');
    // The deletion anchors where the content was: the position of the block
    // that now follows it ('C.').
    let cPos = -1;
    surface.handle.editor.state.doc.forEach((node, pos) => {
      if (node.textContent === 'C.') cPos = pos;
    });
    expect(cPos).toBeGreaterThan(0);
    expect(dels[0].pos).toBe(cPos);
    // Deletions are NOT rendered inline (the margin owns them, commit 3).
    expect(parent.querySelector('del.lf-del')).toBeNull();
    expect(parent.textContent).not.toContain('Gone paragraph.');
  });

  it('extracts an inline deletion from a reworded paragraph instead of rendering it', async () => {
    const { parent, surface } = mount('The quick brown fox.\n', 'The quick fox.\n');
    await tick();
    const dels = surface.getDeletions();
    expect(dels.length).toBeGreaterThan(0);
    expect(dels.map((d) => d.deletedMarkdown).join(' ')).toContain('brown');
    expect(dels[0].pos).toBeGreaterThan(0);
    expect(parent.querySelector('del.lf-del')).toBeNull();
  });

  it('anchors a trailing deletion at the end of the document', async () => {
    const { surface } = mount('A.\n\nDoomed final paragraph.\n', 'A.\n');
    await tick();
    const dels = surface.getDeletions();
    expect(dels).toHaveLength(1);
    expect(dels[0].deletedMarkdown).toContain('Doomed');
    const size = surface.handle.editor.state.doc.content.size;
    expect(dels[0].pos).toBeGreaterThan(0);
    expect(dels[0].pos).toBeLessThanOrEqual(size);
  });
});
