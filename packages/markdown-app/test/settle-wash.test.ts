import { prose } from '@feedback/core';
import type { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';

/**
 * The settle wash (settle-wash.ts): a REMOTE insert into the "Meeting notes"
 * section, while a meeting is live, decorates the arrived block with
 * `.settle-wash` — and nothing else does: not a local edit, not an insert
 * outside the section, not a doc with no meeting. Runs through the REAL
 * createEditor so the gate is tested against the same y-sync meta key the
 * Collaboration extension registers (the import-source trap editor.ts's
 * comment pins).
 */

const open: Array<{ handle: EditorHandle; parent: HTMLElement }> = [];
afterEach(() => {
  for (const o of open.splice(0)) {
    o.handle.destroy();
    o.parent.remove();
  }
});

function mountEditor(md: string, live: { on: boolean }, onNotesInsert?: () => void) {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  if (md !== '') fragment.push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = createEditor({
    parent,
    ydoc,
    awareness: new Awareness(ydoc),
    settleWash: {
      isLive: () => live.on,
      ...(onNotesInsert ? { onNotesInsert } : {}),
    },
  });
  open.push({ handle, parent });
  return { handle, parent, view: handle.editor.view as EditorView };
}

const DOC = '# Plan\n\nThe agenda paragraph.\n\n## Meeting notes\n\n- an earlier note\n';

/** Append one bullet at the end of the doc, flagged (or not) as remote. */
function appendNote(view: EditorView, text: string, remote: boolean): void {
  const { state } = view;
  const li = state.schema.nodes.listItem.create(
    null,
    state.schema.nodes.paragraph.create(null, state.schema.text(text)),
  );
  const list = state.schema.nodes.bulletList.create(null, li);
  let tr = state.tr.insert(state.doc.content.size, list);
  // The same key Collaboration registers under; a local keystroke never
  // carries this meta, which is the whole authorship signal.
  if (remote) tr = tr.setMeta(ySyncPluginKey, { isChangeOrigin: true });
  view.dispatch(tr);
}

const washed = (parent: HTMLElement): string[] =>
  [...parent.querySelectorAll<HTMLElement>('.settle-wash')].map((el) => el.textContent ?? '');

describe('the settle wash', () => {
  it('washes a remote insert into the notes section while the meeting is live', () => {
    let landed = 0;
    const { view, parent } = mountEditor(DOC, { on: true }, () => landed++);
    appendNote(view, 'the freshly composed note', true);
    const hits = washed(parent);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.join(' ')).toContain('the freshly composed note');
    // …and ONLY the arrived block, not the whole section.
    expect(hits.join(' ')).not.toContain('an earlier note');
    expect(landed).toBe(1);
  });

  it('a local edit is never washed — the meta is the authorship signal', () => {
    const { view, parent } = mountEditor(DOC, { on: true });
    appendNote(view, 'typed by a person', false);
    expect(washed(parent)).toEqual([]);
  });

  it('a remote edit with no live meeting is never washed', () => {
    const { view, parent } = mountEditor(DOC, { on: false });
    appendNote(view, 'a collaborator, later', true);
    expect(washed(parent)).toEqual([]);
  });

  it('a remote insert ABOVE the notes section is never washed', () => {
    const { view, parent } = mountEditor(DOC, { on: true });
    const { state } = view;
    const p = state.schema.nodes.paragraph.create(null, state.schema.text('remote preamble'));
    // Position 0: before the title, well above the notes heading.
    view.dispatch(state.tr.insert(0, p).setMeta(ySyncPluginKey, { isChangeOrigin: true }));
    expect(washed(parent)).toEqual([]);
  });

  it('a doc with no "Meeting notes" heading washes nothing', () => {
    const { view, parent } = mountEditor('# Plan\n\nJust prose.\n', { on: true });
    appendNote(view, 'remote words', true);
    expect(washed(parent)).toEqual([]);
  });
});
