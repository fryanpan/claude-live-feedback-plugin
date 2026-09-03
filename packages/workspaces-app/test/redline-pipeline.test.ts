import { Editor, Mark } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { describe, expect, it } from 'vitest';

/**
 * Task 0 gate for the markdown redline (docs/product/plans/md-redline-plan.md).
 *
 * The whole rendering approach assumes tiptap-markdown passes inline HTML
 * through to the ProseMirror schema, so <ins>/<del> become marks and the
 * markdown INSIDE them still parses. If it doesn't, the renderer has to build
 * ProseMirror JSON directly and inline formatting inside changed text is lost.
 * Find out before building on top of it.
 */
const Ins = Mark.create({
  name: 'redlineIns',
  parseHTML: () => [{ tag: 'ins' }],
  renderHTML: () => ['ins', { class: 'lf-ins' }, 0],
});
// StarterKit's Strike mark parses `del` (alongside `s` and `strike`) at the
// default priority of 50, so a plain `{ tag: 'del' }` rule LOSES to it and the
// redline's deletions silently render as ordinary strikethrough. Outrank it,
// rather than disabling Strike — real `~~strikethrough~~` in the source must
// still render as itself.
const Del = Mark.create({
  name: 'redlineDel',
  parseHTML: () => [{ tag: 'del', priority: 60 }],
  renderHTML: () => ['del', { class: 'lf-del' }, 0],
});

describe('redline render pipeline', () => {
  it('passes inline <ins>/<del> through markdown into marks, keeping inner markdown', () => {
    const editor = new Editor({
      extensions: [StarterKit.configure({ undoRedo: false }), Markdown, Ins, Del],
      content: '',
    });
    editor.commands.setContent(
      '## A <del>stale</del><ins>**fresh**</ins> heading\n\nBody text.\n',
      { emitUpdate: false },
    );
    const html = editor.getHTML();
    // Log the real output so a failure is diagnosable without a rerun.
    console.log('[probe] getHTML() =>', html);
    expect(html).toContain('<h2>');
    // The del must be OUR mark, not StarterKit's Strike claiming the tag.
    expect(html).toContain('lf-del');
    expect(html).not.toContain('<s>stale</s>');
    expect(html).toContain('lf-ins');
    // Markdown INSIDE the wrapper still parses — this is what block-level
    // wrapping would have cost us.
    expect(html).toContain('<strong>');
    editor.destroy();
  });

  it('keeps a leading block marker literal while wrapping only inline text', () => {
    const editor = new Editor({
      extensions: [StarterKit.configure({ undoRedo: false }), Markdown, Ins, Del],
      content: '',
    });
    editor.commands.setContent('- <del>old</del><ins>new</ins> item\n', { emitUpdate: false });
    const html = editor.getHTML();
    console.log('[probe] list getHTML() =>', html);
    expect(html).toContain('<ul');
    expect(html).toContain('<li>');
    expect(html).toContain('lf-del');
    expect(html).toContain('lf-ins');
    editor.destroy();
  });
});
