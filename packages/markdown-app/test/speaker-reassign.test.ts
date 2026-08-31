import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  getProseFragment,
  parseMarkdownBlocks,
  serializeFragmentToMarkdown,
} from '../../core/src/prose.ts';
import { findSpeakerTags } from '../../core/src/speaker-tags.ts';
import { applyReassign, findSpeakerTagAt } from '../src/speaker-reassign.ts';

/**
 * Driven through the real editor rather than a string, because the thing
 * under test is an edit to a MARK: the tag has to come out of a Yjs doc, be
 * changed in place, and serialize back to markdown a later rename can still
 * find. A string helper would prove none of that.
 */
let open: Editor | null = null;

function editorFor(markdown: string): { editor: Editor; ydoc: Y.Doc } {
  const ydoc = new Y.Doc();
  getProseFragment(ydoc).push(parseMarkdownBlocks(markdown));
  const editor = new Editor({
    extensions: [
      StarterKit.configure({
        undoRedo: false,
        link: { openOnClick: false, autolink: true, protocols: ['speaker'] },
      }),
      Collaboration.configure({ document: ydoc, field: 'prose' }),
    ],
  });
  open = editor;
  return { editor, ydoc };
}

afterEach(() => {
  open?.destroy();
  open = null;
});

const markdownOf = (ydoc: Y.Doc): string => serializeFragmentToMarkdown(getProseFragment(ydoc));

/** A document position inside the first text node containing `needle`. */
function posOf(editor: Editor, needle: string): number {
  let found: number | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found !== null || !node.isText) return;
    const at = (node.text ?? '').indexOf(needle);
    if (at >= 0) found = pos + at + 1;
  });
  expect(found).not.toBeNull();
  return found as unknown as number;
}

describe('findSpeakerTagAt', () => {
  it('finds the whole tag from a position inside it', () => {
    const { editor } = editorFor('- [@Devi](speaker:B) wants the gate moved.\n');
    const found = findSpeakerTagAt(editor.state, posOf(editor, 'Devi'));
    expect(found).toMatchObject({ label: 'B', text: '@Devi' });
    expect(editor.state.doc.textBetween(found!.from, found!.to)).toBe('@Devi');
  });

  it('finds nothing in ordinary prose or an ordinary link', () => {
    const { editor } = editorFor('- Filed as [the ticket](/w/w-1/t/t-1) today.\n');
    expect(findSpeakerTagAt(editor.state, posOf(editor, 'ticket'))).toBeNull();
    expect(findSpeakerTagAt(editor.state, posOf(editor, 'today'))).toBeNull();
  });
});

describe('applyReassign — one mention, and only one', () => {
  it('moves this mention to another voice and leaves the voice’s other mentions alone', () => {
    // The whole of AC2 in one assertion: two mentions of Devi, one of them
    // wrong. Correcting it must not become a rename.
    const { editor, ydoc } = editorFor(
      '- [@Devi](speaker:B) wants the gate moved.\n- [@Devi](speaker:B) will file it.\n',
    );
    const tag = findSpeakerTagAt(editor.state, posOf(editor, 'Devi'));
    expect(applyReassign(editor, tag!, { label: 'A', name: 'Marisol', lastSaid: '' })).toBe(true);
    const md = markdownOf(ydoc);
    expect(md).toContain('- [@Marisol](speaker:A) wants the gate moved.');
    expect(md).toContain('- [@Devi](speaker:B) will file it.');
  });

  it('leaves a tag a later rename can still find', () => {
    const { editor, ydoc } = editorFor('- [@Devi](speaker:B) asked.\n');
    const tag = findSpeakerTagAt(editor.state, posOf(editor, 'Devi'));
    applyReassign(editor, tag!, { label: 'A', name: 'Speaker A', lastSaid: '' });
    // The href is what every rename keys on; text alone would be a dead tag.
    expect(markdownOf(ydoc)).toContain('](speaker:A)');
  });

  it('"nobody" keeps the words and drops the claim', () => {
    const { editor, ydoc } = editorFor('- [@Devi](speaker:B) wants the gate moved.\n');
    const tag = findSpeakerTagAt(editor.state, posOf(editor, 'Devi'));
    expect(applyReassign(editor, tag!, null)).toBe(true);
    const md = markdownOf(ydoc);
    expect(md).toContain('Devi wants the gate moved.');
    expect(md).not.toContain('speaker:B');
    expect(md).not.toContain('@Devi');
  });

  it('reassigning to the voice it already names changes nothing', () => {
    const { editor, ydoc } = editorFor('- [@Devi](speaker:B) asked.\n');
    const before = markdownOf(ydoc);
    const tag = findSpeakerTagAt(editor.state, posOf(editor, 'Devi'));
    expect(applyReassign(editor, tag!, { label: 'B', name: 'Devi', lastSaid: '' })).toBe(false);
    expect(markdownOf(ydoc)).toBe(before);
  });

  it('reassigning to a name with brackets still writes a readable tag', () => {
    // Caught in a real browser, not by a unit test: the editor writes a link
    // by putting the display name between brackets, so a voice called
    // "Sam [PM]" produced `[@Sam [PM]](speaker:C)` on disk — no longer a tag,
    // so no later rename could ever reach it again.
    const { editor, ydoc } = editorFor('- [@Devi](speaker:B) asked.\n');
    const tag = findSpeakerTagAt(editor.state, posOf(editor, 'Devi'));
    applyReassign(editor, tag!, { label: 'C', name: 'Sam [PM]', lastSaid: '' });
    const md = markdownOf(ydoc);
    expect(md).toContain('[@Sam PM](speaker:C)');
    expect(findSpeakerTags(md)).toHaveLength(1);
    expect(findSpeakerTags(md)[0]?.label).toBe('C');
  });

  it('leaves the words around the tag untouched', () => {
    const { editor, ydoc } = editorFor('- Before [@Devi](speaker:B) after.\n');
    const tag = findSpeakerTagAt(editor.state, posOf(editor, 'Devi'));
    applyReassign(editor, tag!, { label: 'A', name: 'Marisol', lastSaid: '' });
    expect(markdownOf(ydoc)).toContain('- Before [@Marisol](speaker:A) after.');
  });
});
