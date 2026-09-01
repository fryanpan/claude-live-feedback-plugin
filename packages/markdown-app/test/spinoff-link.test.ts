/**
 * Writing a spun-off task back into the prose — and the duplication bug this
 * suite exists to keep out.
 *
 * A fresh-eyes review of the huddle flow selected four whole lines, spun each
 * one off, and got each line written into the document a SECOND time: the
 * source line, then the same words again carrying the task's link, then the
 * status chip. Four out of four, the H1 included, and it flushed to the bound
 * `.md`. The cause was insertion — the link's text was derived from the
 * selection, so selecting the thing you mean duplicates the thing you mean.
 *
 * So the assertions here are mostly negative, and the load-bearing one is the
 * first: after a spin-off over a whole line, the document's text is character
 * for character what it was, and it has no more blocks than it had. All
 * fixtures are synthetic; the repo is public.
 */
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { linkSpinoffRange, unlinkSpinoffHref } from '../src/spinoff-link.ts';

const HREF = '/workspaces/w-demo?task=t-77';

function mount(content: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [StarterKit.configure({ undoRedo: false })],
    content,
  });
}

/** Every block's text, in order — the shape a reader sees and the bound file
 *  gets. A duplicated line shows up here as a repeated entry. */
function lines(editor: Editor): string[] {
  const out: string[] = [];
  editor.state.doc.forEach((node) => out.push(node.textContent));
  return out;
}

/** The text carrying a link to `href`, and where it sits. */
function linked(editor: Editor, href: string): Array<{ text: string; from: number }> {
  const found: Array<{ text: string; from: number }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return;
    if (node.marks.some((m) => m.type.name === 'link' && m.attrs.href === href)) {
      found.push({ text: node.text ?? '', from: pos });
    }
  });
  return found;
}

/** The range covering one whole block's text, the way a select-the-line
 *  gesture leaves the selection. */
function wholeLine(editor: Editor, index: number): { from: number; to: number } {
  let seen = 0;
  let range = { from: 0, to: 0 };
  editor.state.doc.forEach((node, offset) => {
    if (seen === index) range = { from: offset + 1, to: offset + 1 + node.content.size };
    seen += 1;
  });
  return range;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('spinning a whole line off', () => {
  const DOC = '<h1>Zoom notes to the board</h1><p>Check whether Access covers the mockup route</p>';

  it('leaves the source line exactly as it was and adds no line at all', () => {
    const editor = mount(DOC);
    const before = lines(editor);
    const range = wholeLine(editor, 1);

    expect(linkSpinoffRange(editor, range, HREF)).toBe(true);

    // The bug, stated: this used to be
    //   [..., 'Check whether…route', 'Check whether…route']
    expect(lines(editor)).toEqual(before);
    editor.destroy();
  });

  it('marks the line that was selected, once, as the task', () => {
    const editor = mount(DOC);
    const range = wholeLine(editor, 1);
    linkSpinoffRange(editor, range, HREF);

    // Exactly one run, starting where the selection started — the mark
    // covers the selected line and nothing on either side of it.
    expect(linked(editor, HREF)).toEqual([
      { text: 'Check whether Access covers the mockup route', from: range.from },
    ]);
    editor.destroy();
  });

  it('does the same for a heading — the H1 the reviewer saw duplicated', () => {
    const editor = mount(DOC);
    const before = lines(editor);

    linkSpinoffRange(editor, wholeLine(editor, 0), HREF);

    expect(lines(editor)).toEqual(before);
    expect(linked(editor, HREF).map((l) => l.text)).toEqual(['Zoom notes to the board']);
    editor.destroy();
  });

  it('marks a phrase without splitting the word beside it', () => {
    // The other half of the same bug: inserting at the end of a PHRASE
    // selection landed the link mid-word — "Cloudflare Acces[link]s covers".
    const editor = mount('<p>Check whether Access covers the mockup route</p>');
    const before = lines(editor);
    const from = 1 + 'Check whether '.length;

    linkSpinoffRange(editor, { from, to: from + 'Access'.length }, HREF);

    expect(lines(editor)).toEqual(before);
    expect(linked(editor, HREF).map((l) => l.text)).toEqual(['Access']);
    editor.destroy();
  });

  it('links only the FIRST line when the drag crossed several', () => {
    // A spin-off makes one row, and that row's title comes from the opening
    // sentence. Marking all four paragraphs would turn a page into a single
    // anchor pointing at a row that describes only its first line — and the
    // whole passage would navigate away on a click.
    const editor = mount('<p>One thing</p><p>Another thing</p><p>A third thing</p>');
    const before = lines(editor);
    const first = wholeLine(editor, 0);
    const last = wholeLine(editor, 2);

    expect(linkSpinoffRange(editor, { from: first.from, to: last.to }, HREF)).toBe(true);

    expect(lines(editor)).toEqual(before);
    expect(linked(editor, HREF).map((l) => l.text)).toEqual(['One thing']);
  });

  it('links only the first BULLET, not the whole list around it', () => {
    // A list is ONE top-level block holding many items, so "the first block"
    // read at top level would take every bullet. The line is the textblock.
    const editor = mount(
      '<ul><li><p>Ask about the tunnel</p></li><li><p>And the share links</p></li></ul><p>after</p>',
    );
    const before = lines(editor);

    // Everything, as a select-all would give it.
    linkSpinoffRange(editor, { from: 0, to: editor.state.doc.content.size }, HREF);

    expect(lines(editor)).toEqual(before);
    expect(linked(editor, HREF).map((l) => l.text)).toEqual(['Ask about the tunnel']);
  });

  it('clips a drag that STARTS mid-line to the rest of that line only', () => {
    const editor = mount('<p>Check whether Access covers it</p><p>Another thing</p>');
    const before = lines(editor);
    const from = 1 + 'Check whether '.length;

    linkSpinoffRange(editor, { from, to: wholeLine(editor, 1).to }, HREF);

    expect(lines(editor)).toEqual(before);
    expect(linked(editor, HREF).map((l) => l.text)).toEqual(['Access covers it']);
  });

  it('refuses an empty range rather than marking a caret', () => {
    const editor = mount(DOC);
    const before = lines(editor);

    expect(linkSpinoffRange(editor, { from: 3, to: 3 }, HREF)).toBe(false);

    expect(lines(editor)).toEqual(before);
    expect(linked(editor, HREF)).toEqual([]);
    editor.destroy();
  });

  it('re-spinning the same line points it at the new row, not both', () => {
    const editor = mount(DOC);
    const range = wholeLine(editor, 1);
    linkSpinoffRange(editor, range, HREF);
    linkSpinoffRange(editor, range, '/workspaces/w-demo?task=t-78');

    expect(linked(editor, HREF)).toEqual([]);
    expect(linked(editor, '/workspaces/w-demo?task=t-78').map((l) => l.text)).toEqual([
      'Check whether Access covers the mockup route',
    ]);
    editor.destroy();
  });
});

describe('undoing it', () => {
  const DOC = '<p>Check whether Access covers the mockup route</p>';

  it('takes the link off and leaves the words', () => {
    const editor = mount(DOC);
    const before = lines(editor);
    linkSpinoffRange(editor, wholeLine(editor, 0), HREF);

    expect(unlinkSpinoffHref(editor, HREF)).toBe(true);

    expect(linked(editor, HREF)).toEqual([]);
    expect(lines(editor)).toEqual(before);
    editor.destroy();
  });

  it('finds the link after the person has typed, because it goes by href', () => {
    // An undo sits in a toast for seconds, and people type in those seconds.
    // Positions captured at spin-off time are stale by then; the href is not.
    const editor = mount(DOC);
    linkSpinoffRange(editor, wholeLine(editor, 0), HREF);
    editor.commands.insertContentAt(1, 'Actually — ');

    expect(unlinkSpinoffHref(editor, HREF)).toBe(true);
    expect(linked(editor, HREF)).toEqual([]);
    editor.destroy();
  });

  it('leaves a DIFFERENT spin-off alone', () => {
    const editor = mount('<p>One thing</p><p>Another thing</p>');
    const other = '/workspaces/w-demo?task=t-99';
    linkSpinoffRange(editor, wholeLine(editor, 0), HREF);
    linkSpinoffRange(editor, wholeLine(editor, 1), other);

    unlinkSpinoffHref(editor, HREF);

    expect(linked(editor, HREF)).toEqual([]);
    expect(linked(editor, other).map((l) => l.text)).toEqual(['Another thing']);
    editor.destroy();
  });

  it('reports false when the link is already gone', () => {
    const editor = mount(DOC);
    expect(unlinkSpinoffHref(editor, HREF)).toBe(false);
    editor.destroy();
  });
});
