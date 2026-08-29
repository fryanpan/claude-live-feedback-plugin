import { prose } from '@feedback/core';
import { Editor } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { AGENT_WASH_COLOR, EditWash, type EditWashAuthor, editWashKey } from '../src/edit-wash.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';

/**
 * Recent-edit washes on a huddle doc: each participant's last three edited
 * top-level sections carry a pastel wash in that participant's color.
 *
 * The wash is a ProseMirror node decoration — render-time only. Nothing here
 * may reach the Yjs fragment or the markdown on disk, and the last two
 * suites pin exactly that.
 */

const BRYAN: EditWashAuthor = { name: 'Bryan', color: '#2e7dd7' };
const AGENT: EditWashAuthor = { name: 'Agent', color: '#e36f1e' };

const FIVE = '<p>one</p><p>two</p><p>three</p><p>four</p><p>five</p>';

const open: Array<{ destroy: () => void }> = [];
afterEach(() => {
  for (const o of open.splice(0)) o.destroy();
});

function mount(content: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      EditWash.configure({
        authorOf: (tr: Transaction) => (tr.getMeta('author') as EditWashAuthor | null) ?? null,
      }),
    ],
    content,
  });
  open.push({ destroy: () => editor.destroy() });
  return editor;
}

/** Position just inside top-level block `i` (its first text position). */
function insideBlock(doc: ProseNode, i: number): number {
  let pos = 0;
  for (let k = 0; k < i; k++) pos += doc.child(k).nodeSize;
  return pos + 1;
}

function typeIn(editor: Editor, block: number, text: string, author: EditWashAuthor | null) {
  const tr = editor.state.tr.insertText(text, insideBlock(editor.state.doc, block));
  if (author) tr.setMeta('author', author);
  editor.view.dispatch(tr);
}

interface Wash {
  text: string;
  author: string;
  color: string;
  rank: string;
}

/** Every washed top-level block, in document order. */
function washes(editor: Editor): Wash[] {
  const state = editWashKey.getState(editor.state);
  if (!state) return [];
  return state.deco.find().map((d) => {
    const attrs = (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs;
    return {
      text: editor.state.doc.textBetween(d.from, d.to),
      author: attrs['data-edit-author'],
      color: /--edit-color:\s*(#[0-9a-f]{6})/i.exec(attrs.style ?? '')?.[1] ?? '',
      rank: attrs['data-edit-rank'],
    };
  });
}

describe('recent-edit wash', () => {
  it('washes the last three sections a person edited, most recent strongest', () => {
    const editor = mount(FIVE);
    typeIn(editor, 0, 'a', BRYAN);
    typeIn(editor, 1, 'b', BRYAN);
    typeIn(editor, 2, 'c', BRYAN);
    expect(washes(editor)).toEqual([
      { text: 'aone', author: 'Bryan', color: '#2e7dd7', rank: '3' },
      { text: 'btwo', author: 'Bryan', color: '#2e7dd7', rank: '2' },
      { text: 'cthree', author: 'Bryan', color: '#2e7dd7', rank: '1' },
    ]);
  });

  it('a fourth edit drops that person’s oldest wash', () => {
    const editor = mount(FIVE);
    for (const [i, ch] of ['a', 'b', 'c', 'd'].entries()) typeIn(editor, i, ch, BRYAN);
    expect(washes(editor).map((w) => w.text)).toEqual(['btwo', 'cthree', 'dfour']);
  });

  it('re-editing an already washed section refreshes it instead of spending a slot', () => {
    const editor = mount(FIVE);
    typeIn(editor, 0, 'a', BRYAN);
    typeIn(editor, 1, 'b', BRYAN);
    typeIn(editor, 2, 'c', BRYAN);
    typeIn(editor, 0, 'x', BRYAN);
    expect(washes(editor).map((w) => [w.text, w.rank])).toEqual([
      ['xaone', '1'],
      ['btwo', '3'],
      ['cthree', '2'],
    ]);
  });

  it('each person is washed in their own color, three slots each', () => {
    const editor = mount(FIVE);
    typeIn(editor, 0, 'a', BRYAN);
    typeIn(editor, 1, 'b', AGENT);
    typeIn(editor, 2, 'c', BRYAN);
    typeIn(editor, 3, 'd', AGENT);
    typeIn(editor, 4, 'e', BRYAN);
    expect(washes(editor).map((w) => [w.author, w.color])).toEqual([
      ['Bryan', '#2e7dd7'],
      ['Agent', '#e36f1e'],
      ['Bryan', '#2e7dd7'],
      ['Agent', '#e36f1e'],
      ['Bryan', '#2e7dd7'],
    ]);
  });

  it('the later editor wins a section two people touched', () => {
    const editor = mount(FIVE);
    typeIn(editor, 0, 'a', BRYAN);
    typeIn(editor, 0, 'b', AGENT);
    expect(washes(editor)).toEqual([
      { text: 'baone', author: 'Agent', color: '#e36f1e', rank: '1' },
    ]);
  });

  it('an unattributed change (initial sync) washes nothing', () => {
    const editor = mount(FIVE);
    typeIn(editor, 0, 'a', null);
    expect(washes(editor)).toEqual([]);
  });

  it('a wash stays on its section when a block is added above it', () => {
    const editor = mount(FIVE);
    typeIn(editor, 2, 'c', BRYAN);
    const para = editor.state.schema.nodes.paragraph.create(null, editor.state.schema.text('new'));
    editor.view.dispatch(editor.state.tr.insert(0, para).setMeta('author', AGENT));
    expect(washes(editor).map((w) => [w.text, w.author])).toEqual([
      ['new', 'Agent'],
      ['cthree', 'Bryan'],
    ]);
  });

  it('a deleted section takes its wash with it', () => {
    const editor = mount(FIVE);
    typeIn(editor, 0, 'a', BRYAN);
    typeIn(editor, 1, 'b', BRYAN);
    const first = editor.state.doc.child(0).nodeSize;
    editor.view.dispatch(editor.state.tr.delete(0, first).setMeta('author', BRYAN));
    expect(washes(editor).map((w) => w.text)).toEqual(['btwo']);
  });

  it('never enters the document: the HTML and markdown carry no wash', () => {
    const editor = mount(FIVE);
    typeIn(editor, 0, 'a', BRYAN);
    expect(washes(editor)).toHaveLength(1);
    expect(editor.getHTML()).not.toContain('edit-wash');
    expect(editor.getHTML()).not.toContain('edit-color');
    // The rendered DOM does carry it — that is the whole feature.
    expect(editor.view.dom.querySelector('.edit-wash')).not.toBeNull();
  });
});

/** Two editors over two Y.Docs relayed to each other — a browser and a peer. */
function pair(md: string, opts: { huddle: boolean }) {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const fragment = prose.getProseFragment(a);
  if (md) fragment.push(prose.parseMarkdownBlocks(md));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), 'seed');
  a.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') Y.applyUpdate(b, u, 'relay');
  });
  b.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'relay') Y.applyUpdate(a, u, 'relay');
  });
  const awarenessA = new Awareness(a);
  const awarenessB = new Awareness(b);
  const ready: Array<() => void> = [];
  const mountOne = (ydoc: Y.Doc, awareness: Awareness, user: EditWashAuthor, huddle: boolean) => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handle: EditorHandle = createEditor({
      parent,
      ydoc,
      awareness,
      user,
      recentEdits: huddle ? { whenSynced: (cb) => ready.push(cb) } : undefined,
    });
    open.push({ destroy: () => handle.destroy() });
    return handle;
  };
  const local = mountOne(a, awarenessA, BRYAN, opts.huddle);
  const peer = mountOne(b, awarenessB, { name: 'Agent Smith', color: '#e36f1e' }, false);
  const synced = () => {
    for (const cb of ready.splice(0)) cb();
  };
  const sharePeerAwareness = (user: EditWashAuthor | null) => {
    awarenessB.setLocalStateField('user', user);
    applyAwarenessUpdate(awarenessA, encodeAwarenessUpdate(awarenessB, [b.clientID]), 'test');
  };
  return { local, peer, synced, sharePeerAwareness };
}

function domWashes(handle: EditorHandle): Array<{ text: string; author: string; color: string }> {
  return Array.from(handle.editor.view.dom.querySelectorAll('.edit-wash')).map((el) => ({
    text: el.textContent ?? '',
    author: el.getAttribute('data-edit-author') ?? '',
    color: (el as HTMLElement).style.getPropertyValue('--edit-color').trim(),
  }));
}

describe('recent-edit wash on a live huddle doc', () => {
  const MD = 'one\n\ntwo\n\nthree\n';

  it('a non-huddle doc has no wash at all', () => {
    const { local, synced } = pair(MD, { huddle: false });
    synced();
    typeIn(local.editor, 0, 'a', null);
    expect(editWashKey.getState(local.editor.state)).toBeUndefined();
    expect(domWashes(local)).toEqual([]);
  });

  it('washes the local person’s edits only after the first sync', () => {
    const { local, synced } = pair(MD, { huddle: true });
    typeIn(local.editor, 0, 'a', null);
    expect(domWashes(local)).toEqual([]);
    synced();
    typeIn(local.editor, 1, 'b', null);
    expect(domWashes(local)).toEqual([{ text: 'btwo', author: 'Bryan', color: '#2e7dd7' }]);
  });

  it('washes a peer’s remote edit in the color their awareness carries', () => {
    const { local, peer, synced, sharePeerAwareness } = pair(MD, { huddle: true });
    synced();
    sharePeerAwareness({ name: 'Agent Smith', color: '#aa55cc' });
    typeIn(peer.editor, 2, 'z', null);
    expect(local.editor.getText()).toContain('zthree');
    expect(domWashes(local)).toEqual([{ text: 'zthree', author: 'Agent Smith', color: '#aa55cc' }]);
  });

  it('a remote writer with no awareness state is the server — read as the agent', () => {
    const { local, peer, synced } = pair(MD, { huddle: true });
    synced();
    typeIn(peer.editor, 2, 'z', null);
    expect(domWashes(local)).toEqual([
      { text: 'zthree', author: 'Agent', color: AGENT_WASH_COLOR },
    ]);
  });

  it('the markdown on disk is what it was without the wash', () => {
    const { local, peer, synced, sharePeerAwareness } = pair(MD, { huddle: true });
    synced();
    sharePeerAwareness({ name: 'Agent Smith', color: '#e36f1e' });
    typeIn(local.editor, 0, 'a', null);
    typeIn(peer.editor, 2, 'z', null);
    expect(domWashes(local)).toHaveLength(2);
    // The peer has no wash plugin; both serialize the same content.
    expect(local.getMarkdown()).toBe(peer.getMarkdown());
    expect(local.getMarkdown()).not.toContain('edit-wash');
    expect(peer.editor.view.dom.querySelector('.edit-wash')).toBeNull();
  });
});
