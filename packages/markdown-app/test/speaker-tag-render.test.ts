import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getProseFragment, parseMarkdownBlocks } from '../../core/src/prose.ts';
import { SPEAKER_TAG_SCHEME } from '../../core/src/speaker-tags.ts';

/**
 * A speaker tag reaches the reader through Tiptap's Link mark, and Tiptap
 * DROPS an href whose scheme is not in its allow-list — it renders `href=""`
 * rather than refusing. That would erase the label the tag exists to carry
 * while the doc still looked right, so the editor declares the scheme.
 *
 * Rendered through the same Collaboration → y-prosemirror → Link path the app
 * uses, with the allow-list on and off, because the off case is what makes
 * the on case mean anything.
 */
function htmlFor(markdown: string, protocols: string[]): string {
  const ydoc = new Y.Doc();
  getProseFragment(ydoc).push(parseMarkdownBlocks(markdown));
  const editor = new Editor({
    extensions: [
      StarterKit.configure({
        undoRedo: false,
        link: {
          openOnClick: false,
          autolink: true,
          protocols,
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        },
      }),
      Collaboration.configure({ document: ydoc, field: 'prose' }),
    ],
  });
  const html = editor.getHTML();
  editor.destroy();
  return html;
}

const TAGGED = '- [@Devi](speaker:B) wants the gate moved.\n';
const SCHEME = SPEAKER_TAG_SCHEME.replace(':', '');

describe('a speaker tag through the real editor', () => {
  it('keeps the label in the href when the scheme is declared', () => {
    const html = htmlFor(TAGGED, [SCHEME]);
    expect(html).toContain('href="speaker:B"');
    expect(html).toContain('@Devi');
  });

  it('loses the label when it is not — the reason the editor declares it', () => {
    const html = htmlFor(TAGGED, []);
    expect(html).not.toContain('href="speaker:B"');
    expect(html).toContain('href=""');
  });

  it('leaves an ordinary link alone either way', () => {
    const html = htmlFor('- Filed as [the ticket](/w/w-1/t/t-1).\n', [SCHEME]);
    expect(html).toContain('href="/w/w-1/t/t-1"');
  });
});
