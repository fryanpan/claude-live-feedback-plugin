/**
 * The "Make a plan" doc's one line of guidance.
 *
 * The load-bearing promises: the placeholder is a render-time decoration the
 * STORED doc never contains; it appears only on a plan-kind huddle whose
 * body is unwritten; and it survives the sync-order reality that
 * `huddleKind` can land in doc meta after the editor has painted. All
 * fixtures synthetic; the repo is public.
 */
import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  PLAN_PLACEHOLDER_TEXT,
  PlanPlaceholder,
  planBodyIsEmpty,
} from '../src/plan-placeholder.ts';

function mount(opts: { kind?: 'plan' | 'discussion'; markdown?: string } = {}): {
  editor: Editor;
  ydoc: Y.Doc;
  el: HTMLElement;
} {
  const ydoc = new Y.Doc();
  if (opts.kind) ydoc.getMap('meta').set('huddleKind', opts.kind);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document: ydoc, field: 'prose' }),
      PlanPlaceholder.configure({ ydoc }),
    ],
  });
  if (opts.markdown !== undefined) {
    editor.commands.setContent(opts.markdown);
  }
  return { editor, ydoc, el };
}

const seedGoal = (editor: Editor): void => {
  editor.commands.setContent('<h1>Goal</h1><p></p>');
};

const placeholder = (el: HTMLElement): HTMLElement | null =>
  el.querySelector('.plan-placeholder');

afterEach(() => {
  document.body.innerHTML = '';
});

describe('planBodyIsEmpty', () => {
  it('is true for the seeded Goal heading with nothing under it', () => {
    const { editor } = mount({ kind: 'plan' });
    seedGoal(editor);
    expect(planBodyIsEmpty(editor.state.doc)).toBe(true);
    editor.destroy();
  });

  it('is false once a body line exists, and false with no heading at all', () => {
    const { editor } = mount({ kind: 'plan' });
    editor.commands.setContent('<h1>Goal</h1><p>Get notes flowing.</p>');
    expect(planBodyIsEmpty(editor.state.doc)).toBe(false);
    editor.commands.setContent('<p></p>');
    expect(planBodyIsEmpty(editor.state.doc)).toBe(false);
    editor.destroy();
  });
});

describe('the placeholder decoration', () => {
  it('renders under the Goal heading of an unwritten plan doc', () => {
    const { editor, el } = mount({ kind: 'plan' });
    seedGoal(editor);
    const line = placeholder(el);
    expect(line).not.toBeNull();
    expect(line?.textContent).toBe(PLAN_PLACEHOLDER_TEXT);
    editor.destroy();
  });

  it('never writes the text into the stored doc', () => {
    const { editor } = mount({ kind: 'plan' });
    seedGoal(editor);
    expect(editor.state.doc.textContent).not.toContain('Type or say');
    editor.destroy();
  });

  it('disappears the moment the body has content, and comes back when cleared', () => {
    const { editor, el } = mount({ kind: 'plan' });
    seedGoal(editor);
    expect(placeholder(el)).not.toBeNull();
    editor.commands.setContent('<h1>Goal</h1><p>Zoom notes to the board.</p>');
    expect(placeholder(el)).toBeNull();
    editor.commands.setContent('<h1>Goal</h1><p></p>');
    expect(placeholder(el)).not.toBeNull();
    editor.destroy();
  });

  it('shows nothing on a discussion doc or a doc with no kind', () => {
    for (const kind of ['discussion', undefined] as const) {
      const { editor, el } = mount(kind ? { kind } : {});
      seedGoal(editor);
      expect(placeholder(el), `kind=${kind}`).toBeNull();
      editor.destroy();
      document.body.innerHTML = '';
    }
  });

  it('appears when huddleKind arrives after mount — meta syncs on its own clock', () => {
    const { editor, ydoc, el } = mount();
    seedGoal(editor);
    expect(placeholder(el)).toBeNull();
    ydoc.getMap('meta').set('huddleKind', 'plan');
    expect(placeholder(el)).not.toBeNull();
    editor.destroy();
  });
});
