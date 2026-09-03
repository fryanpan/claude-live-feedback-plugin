import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getProseFragment, parseMarkdownBlocks } from '../../core/src/prose.ts';

/**
 * The end of the chain the server-side fix exists for: a heading parsed from
 * markdown has to come out of the real Tiptap editor as <h1>/<h2>/<h3>.
 *
 * Tiptap's Heading extension picks its tag with
 * `options.levels.includes(node.attrs.level)` against the NUMBERS [1..6], and
 * y-prosemirror passes Yjs attributes through untouched — so a `level` stored
 * as the string '2' silently renders as <h1> and every heading in the review
 * view comes out the same size. This test renders through the same
 * Collaboration → y-prosemirror → Heading path the app uses.
 */
function htmlFor(markdown: string): string {
  const ydoc = new Y.Doc();
  getProseFragment(ydoc).push(parseMarkdownBlocks(markdown));
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document: ydoc, field: 'prose' }),
    ],
  });
  const html = editor.getHTML();
  editor.destroy();
  return html;
}

describe('heading rendering through the real editor', () => {
  it('renders each markdown heading level as its own tag', () => {
    const html = htmlFor('# One\n\n## Two\n\n### Three\n');
    expect(html).toContain('<h1>One</h1>');
    expect(html).toContain('<h2>Two</h2>');
    expect(html).toContain('<h3>Three</h3>');
  });
});
