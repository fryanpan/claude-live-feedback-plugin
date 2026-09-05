import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { describe, expect, it } from 'vitest';
import { RedlineDel, RedlineIns, RedlineProvenance } from '../src/redline/redline-marks.ts';

function mount(content: string): Editor {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Markdown,
      RedlineIns,
      RedlineDel,
      RedlineProvenance,
    ],
    content: '',
  });
  editor.commands.setContent(content, { emitUpdate: false });
  return editor;
}

describe('redline marks', () => {
  it('renders ins and del marks from inline html in markdown', () => {
    const editor = mount('A <del>stale</del><ins>fresh</ins> line.\n');
    const html = editor.getHTML();
    expect(html).toContain('cw-del');
    expect(html).toContain('cw-ins');
    editor.destroy();
  });

  it('wins the del tag against StarterKit Strike', () => {
    // REGRESSION GUARD. Strike parses `del` at the default priority of 50, so
    // without priority 60 every deletion renders as ordinary strikethrough —
    // visually near-identical, so nobody would catch it by eye.
    const editor = mount('<del>gone</del>\n');
    const html = editor.getHTML();
    expect(html).toContain('cw-del');
    expect(html).not.toContain('<s>gone</s>');
    editor.destroy();
  });

  it('leaves real markdown strikethrough as Strike, not as a redline deletion', () => {
    // The flip side: outranking Strike must not mean stealing from it.
    const editor = mount('~~genuinely struck~~\n');
    const html = editor.getHTML();
    expect(html).not.toContain('cw-del');
    editor.destroy();
  });

  it('keeps markdown inside a wrapper parsed', () => {
    const editor = mount('<ins>**bold**</ins>\n');
    expect(editor.getHTML()).toContain('<strong>');
    editor.destroy();
  });

  it('lifts data-cw-from / data-cw-to onto a block node as numbers', () => {
    const editor = mount('<p data-cw-from="10" data-cw-to="25">Body.</p>');
    const node = editor.state.doc.child(0);
    expect(node.attrs.lfFrom).toBe(10);
    expect(node.attrs.lfTo).toBe(25);
    // Numbers, not strings — the heading-level bug in learnings.md was exactly
    // a string where a number was expected.
    expect(typeof node.attrs.lfFrom).toBe('number');
    editor.destroy();
  });

  it('lifts provenance onto a heading, not just a paragraph', () => {
    const editor = mount('<h2 data-cw-from="4" data-cw-to="9">Title</h2>');
    const node = editor.state.doc.child(0);
    expect(node.type.name).toBe('heading');
    expect(node.attrs.lfFrom).toBe(4);
    editor.destroy();
  });

  it('lifts provenance onto a list', () => {
    const editor = mount('<ul data-cw-from="0" data-cw-to="5"><li><p>x</p></li></ul>');
    const node = editor.state.doc.child(0);
    expect(node.type.name).toBe('bulletList');
    expect(node.attrs.lfFrom).toBe(0);
    editor.destroy();
  });

  it('defaults provenance attrs to null when absent', () => {
    const editor = mount('Plain paragraph.\n');
    expect(editor.state.doc.child(0).attrs.lfFrom).toBeNull();
    editor.destroy();
  });

  it('lifts data-cw-snap for deletion-only blocks', () => {
    const editor = mount('<p data-cw-snap="42">Gone.</p>');
    expect(editor.state.doc.child(0).attrs.lfSnap).toBe(42);
    editor.destroy();
  });

  it('ignores a non-numeric provenance attribute rather than storing NaN', () => {
    const editor = mount('<p data-cw-from="banana">x</p>');
    expect(editor.state.doc.child(0).attrs.lfFrom).toBeNull();
    editor.destroy();
  });

  it('round-trips lfChange into a styling class', () => {
    const editor = mount('<p data-cw-change="ins">New block.</p>');
    expect(editor.state.doc.child(0).attrs.lfChange).toBe('ins');
    expect(editor.getHTML()).toContain('cw-block-ins');
    editor.destroy();
  });

  it('keeps two adjacent lists separate when they arrive as HTML', () => {
    // The reason the renderer emits HTML at all: as markdown these merge into
    // ONE bulletList, which would shift every later anchor.
    const editor = mount(
      '<ul data-cw-from="0" data-cw-to="3"><li><p>a</p></li></ul>' +
        '<ul data-cw-from="5" data-cw-to="8"><li><p>b</p></li></ul>',
    );
    const kinds: string[] = [];
    editor.state.doc.forEach((n) => kinds.push(n.type.name));
    expect(kinds.filter((k) => k === 'bulletList')).toHaveLength(2);
    expect(editor.state.doc.child(0).attrs.lfFrom).toBe(0);
    expect(editor.state.doc.child(1).attrs.lfFrom).toBe(5);
    editor.destroy();
  });
});
