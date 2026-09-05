/**
 * The two taps: accepting the note-taker's question, and taking a wrong link
 * back off.
 *
 * WHAT MAKES THESE WORTH THEIR RUNTIME. Both gestures change the STORED doc,
 * which is the opposite of the status chips next door — those are render-time
 * and their load-bearing promise is that nothing is written. So the
 * assertions here are on the markdown that is left behind, and on the order:
 * a write that never reached the server must not edit the note, or the doc
 * ends up citing a row that never heard about it.
 *
 * All fixtures are synthetic; the repo is public.
 */

import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NotesLinkAffordance,
  notesLinkAffordanceKey,
  refreshNotesLinkAffordances,
} from '../src/notes-link-affordance.ts';

const TASK = 't-wheel';
const TASK_URL = `/workspaces/w-r?task=${TASK}`;
const SUGGEST_URL = `${TASK_URL}&suggest=1`;

interface Calls {
  linked: string[];
  unlinked: string[];
}

function mount(
  content: string,
  opts: { linked?: string[]; answer?: boolean } = {},
): { editor: Editor; calls: Calls; linkedSet: Set<string> } {
  const calls: Calls = { linked: [], unlinked: [] };
  const linkedSet = new Set(opts.linked ?? []);
  const answer = opts.answer ?? true;
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ undoRedo: false, link: { openOnClick: false } }),
      NotesLinkAffordance.configure({
        docId: 'd-standup',
        linkedTasks: () => linkedSet,
        link: (taskId) => {
          calls.linked.push(taskId);
          if (answer) linkedSet.add(taskId);
          return Promise.resolve(answer);
        },
        unlink: (taskId) => {
          calls.unlinked.push(taskId);
          if (answer) linkedSet.delete(taskId);
          return Promise.resolve(answer);
        },
      }),
    ],
    content,
  });
  return { editor, calls, linkedSet };
}

/** A real click on the anchor carrying this href, the way a reader taps it. */
function tap(editor: Editor, selector: string): void {
  const el = editor.view.dom.querySelector(selector) as HTMLElement | null;
  if (!el) throw new Error(`nothing to tap for ${selector}`);
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

/** The promise chain behind a tap is one microtask deep; let it drain. */
const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function undoControls(editor: Editor): string[] {
  const state = notesLinkAffordanceKey.getState(editor.state);
  const deco = (state as { deco?: { find: () => Array<{ spec: { key?: string } }> } })?.deco;
  return (deco?.find() ?? []).map((d) => d.spec.key ?? '');
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('accepting the question', () => {
  it('writes the ref and turns the question into the citation it asked about', async () => {
    const { editor, calls } = mount(
      `<ul><li>Scrolling overshoots. <a href="${SUGGEST_URL}">related: Menu wheel navigation?</a></li></ul>`,
    );
    tap(editor, `a[href="${SUGGEST_URL}"]`);
    await settled();

    expect(calls.linked).toEqual([TASK]);
    const anchor = editor.view.dom.querySelector('a') as HTMLAnchorElement;
    // The marker is gone and the words are the row's name — the link the
    // reader touched is the link they are left with.
    expect(anchor.getAttribute('href')).toBe(TASK_URL);
    expect(anchor.textContent).toBe('Menu wheel navigation');
    editor.destroy();
  });

  it('leaves the note exactly as it was when the write did not land', async () => {
    const { editor, calls } = mount(
      `<p><a href="${SUGGEST_URL}">related: Menu wheel navigation?</a></p>`,
      { answer: false },
    );
    const before = editor.getHTML();
    tap(editor, `a[href="${SUGGEST_URL}"]`);
    await settled();

    expect(calls.linked).toEqual([TASK]); // positive control: it was tried
    // A doc that cited a row the board never heard about is the one outcome
    // worse than no link at all.
    expect(editor.getHTML()).toBe(before);
    editor.destroy();
  });

  it('leaves an ordinary task link alone', async () => {
    const { editor, calls } = mount(`<p><a href="${TASK_URL}">Menu wheel navigation</a></p>`);
    const before = editor.getHTML();
    tap(editor, `a[href="${TASK_URL}"]`);
    await settled();

    expect(calls.linked).toEqual([]);
    expect(editor.getHTML()).toBe(before);
    editor.destroy();
  });

  it('gains its own undo once the ref exists', async () => {
    const { editor } = mount(`<p><a href="${SUGGEST_URL}">related: Menu wheel navigation?</a></p>`);
    expect(undoControls(editor)).toEqual([]); // a question has nothing to undo
    tap(editor, `a[href="${SUGGEST_URL}"]`);
    await settled();
    expect(undoControls(editor)).toEqual([`unlink|${TASK}`]);
    editor.destroy();
  });
});

describe('the undo control', () => {
  it('is drawn only where the doc actually holds a ref', () => {
    const withRef = mount(`<p><a href="${TASK_URL}">Menu wheel navigation</a></p>`, {
      linked: [TASK],
    });
    expect(undoControls(withRef.editor)).toEqual([`unlink|${TASK}`]);
    withRef.editor.destroy();

    // Same link, no ref: an ordinary pasted row, and nothing to take back.
    const without = mount(`<p><a href="${TASK_URL}">Menu wheel navigation</a></p>`);
    expect(undoControls(without.editor)).toEqual([]);
    without.editor.destroy();
  });

  it('removes the ref and the link, and keeps what was said', async () => {
    const { editor, calls } = mount(
      `<p>We sized the <a href="${TASK_URL}">volume buttons</a> again.</p>`,
      { linked: [TASK] },
    );
    tap(editor, '.note-unlink');
    await settled();

    expect(calls.unlinked).toEqual([TASK]);
    expect(editor.view.dom.querySelector('a')).toBeNull();
    // The composer weaves a row's title into the middle of a sentence;
    // deleting the words to remove a citation would take a clause of the
    // meeting record with it.
    expect(editor.getText()).toBe('We sized the volume buttons again.');
    editor.destroy();
  });

  it('leaves the note alone when the server refused', async () => {
    const { editor, calls } = mount(`<p><a href="${TASK_URL}">Menu wheel navigation</a></p>`, {
      linked: [TASK],
      answer: false,
    });
    const before = editor.getHTML();
    tap(editor, '.note-unlink');
    await settled();

    expect(calls.unlinked).toEqual([TASK]); // positive control
    expect(editor.getHTML()).toBe(before);
    editor.destroy();
  });

  it('goes away with the ref it was undoing', async () => {
    const { editor } = mount(`<p><a href="${TASK_URL}">Menu wheel navigation</a></p>`, {
      linked: [TASK],
    });
    expect(undoControls(editor)).toHaveLength(1); // positive control
    tap(editor, '.note-unlink');
    await settled();
    expect(undoControls(editor)).toEqual([]);
    editor.destroy();
  });
});

describe('the linked set the plugin is told about', () => {
  it('draws controls that were not there when the editor was built', () => {
    const { editor, linkedSet } = mount(`<p><a href="${TASK_URL}">Menu wheel navigation</a></p>`);
    expect(undoControls(editor)).toEqual([]);
    // The doc's backlinks land one round trip after the mount; this is the
    // call that lets them reach the editor.
    linkedSet.add(TASK);
    refreshNotesLinkAffordances(editor.view, linkedSet);
    expect(undoControls(editor)).toEqual([`unlink|${TASK}`]);
    editor.destroy();
  });
});
