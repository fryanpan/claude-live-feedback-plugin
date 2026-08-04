import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { getProseFragment, parseMarkdownBlocks } from '../../core/src/prose.ts';
import {
  SUGGEST_DELETE_MARK,
  SUGGEST_INSERT_MARK,
  type SuggestionAttrs,
} from '../../core/src/suggest.ts';
import { createLiveRedlineEditor } from '../src/redline/live-redline-editor.ts';
import { SuggestDelete, SuggestInsert } from '../src/suggest-marks.ts';

/**
 * The suggestion marks must be registered in the editor schema that opens the
 * collaborative prose fragment: y-prosemirror drops marks the schema doesn't
 * know, so an agent-written suggestion would be silently destroyed by the
 * first browser that opened the doc. This renders through the same
 * Collaboration → y-prosemirror path the app uses (see heading-render.test.ts
 * for the pattern and the attribute-type learnings that motivate it).
 */

const sattrs = (sid: string): SuggestionAttrs => ({
  sid,
  authorId: 'agent-1',
  authorName: 'Docs Agent',
  authorColor: '#7c5cff',
  ts: 1754200000000,
});

function editorOver(ydoc: Y.Doc): Editor {
  return new Editor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      SuggestInsert,
      SuggestDelete,
      Collaboration.configure({ document: ydoc, field: 'prose' }),
    ],
  });
}

function docWith(md: string): { ydoc: Y.Doc; text: Y.XmlText } {
  const ydoc = new Y.Doc();
  const fragment = getProseFragment(ydoc);
  fragment.push(parseMarkdownBlocks(md));
  const text = (fragment.get(0) as Y.XmlElement).toArray()[0] as Y.XmlText;
  return { ydoc, text };
}

describe('suggestion marks in the live editor schema', () => {
  it('renders a Yjs suggestInsert span with its attribution attrs', () => {
    const { ydoc, text } = docWith('Alpha gamma.\n');
    text.insert('Alpha '.length, 'beta ', { [SUGGEST_INSERT_MARK]: sattrs('s1') });
    const editor = editorOver(ydoc);
    const html = editor.getHTML();
    expect(html).toContain('data-lf-suggest="ins"');
    expect(html).toContain('data-sid="s1"');
    expect(html).toContain('data-author-name="Docs Agent"');
    editor.destroy();
  });

  it('renders a Yjs suggestDelete span without removing the text', () => {
    const { ydoc, text } = docWith('Alpha beta gamma.\n');
    text.format('Alpha '.length, 'beta '.length, { [SUGGEST_DELETE_MARK]: sattrs('s2') });
    const editor = editorOver(ydoc);
    const html = editor.getHTML();
    expect(html).toContain('data-lf-suggest="del"');
    expect(html).toContain('beta');
    editor.destroy();
  });

  it('carries the author color onto the rendered span so CSS can tint per author', () => {
    const { ydoc, text } = docWith('Alpha beta gamma.\n');
    text.insert('Alpha '.length, 'new ', { [SUGGEST_INSERT_MARK]: sattrs('s-ins') });
    text.format('Alpha new '.length, 'beta '.length, { [SUGGEST_DELETE_MARK]: sattrs('s-del') });
    const editor = editorOver(ydoc);
    const html = editor.getHTML();
    // Both marks expose the author color as a CSS custom property inline —
    // the stylesheet's underline/strikethrough/tint rules read it.
    const spans = html.match(/--lf-suggest-color: #7c5cff/g) ?? [];
    expect(spans.length).toBe(2);
    editor.destroy();
  });

  it('omits the inline style when the author color is not a safe hex color', () => {
    const { ydoc, text } = docWith('Alpha gamma.\n');
    text.insert('Alpha '.length, 'beta ', {
      [SUGGEST_INSERT_MARK]: { ...sattrs('s-bad'), authorColor: 'red; background:url(x)' },
    });
    const editor = editorOver(ydoc);
    expect(editor.getHTML()).not.toContain('--lf-suggest-color');
    editor.destroy();
  });

  it('keeps the mark and its attribute TYPES intact through the editor (ts stays a number)', () => {
    const { ydoc, text } = docWith('Alpha gamma.\n');
    text.insert('Alpha '.length, 'beta ', { [SUGGEST_INSERT_MARK]: sattrs('s3') });
    const editor = editorOver(ydoc);
    // A local edit elsewhere forces a PM→Yjs write-back pass; an unregistered
    // mark would be dropped from the Yjs state here, not just from the HTML.
    editor.commands.insertContentAt(1, 'X');
    const delta = text.toDelta() as Array<{
      insert?: string;
      attributes?: Record<string, unknown>;
    }>;
    const marked = delta.find((op) => op.attributes?.[SUGGEST_INSERT_MARK] != null);
    expect(marked?.insert).toBe('beta ');
    const attrs = marked?.attributes?.[SUGGEST_INSERT_MARK] as SuggestionAttrs;
    expect(attrs.sid).toBe('s3');
    expect(typeof attrs.ts).toBe('number');
    editor.destroy();
  });
});

describe('suggestion marks in the REDLINE lens', () => {
  it('a pending proposal is visible in the redline surface too — never invisible in any lens', () => {
    const md = 'Alpha gamma.\n';
    const ydoc = new Y.Doc();
    const fragment = getProseFragment(ydoc);
    fragment.push(parseMarkdownBlocks(md));
    const text = (fragment.get(0) as Y.XmlElement).toArray()[0] as Y.XmlText;
    text.insert('Alpha '.length, 'beta ', { [SUGGEST_INSERT_MARK]: sattrs('s-lens') });
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const surface = createLiveRedlineEditor({
      parent,
      ydoc,
      awareness: new Awareness(ydoc),
      baseText: md,
      debounceMs: 0,
    });
    const html = parent.innerHTML;
    expect(html).toContain('data-lf-suggest="ins"');
    expect(html).toContain('--lf-suggest-color: #7c5cff');
    surface.destroy();
    parent.remove();
  });
});
