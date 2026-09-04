import { type User, prose } from '@feedback/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { wireDocGates } from '../src/doc/doc-gates.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * The last phase of a document's boot (doc/doc-gates.ts): what this browser
 * is allowed to do with the surface.
 *
 * Three things settle one question, and the ORDER is the whole reason they
 * share a module. The format bar and the mode toggles have to exist before
 * the read-only lock can drive them, because the lock works through the
 * handle they hand back. A browser the server will not accept writes from
 * gets neither the edit toggle nor the Suggesting one — they are the same
 * door — and it must be shut synchronously, with no window in which the doc
 * is live and the answer is outstanding.
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
  document.body.className = '';
  localStorage.clear();
});

beforeEach(() => {
  document.body.innerHTML = `
    <div id="doc-title"></div>
    <span id="save-state" class="save-state--saved">All changes saved</span>
    <button id="toggle-format" aria-pressed="false">Aa</button>
    <div id="format-bar" class="is-collapsed"></div>
    <button id="toggle-edit-mode" data-write-control></button>
    <button id="toggle-suggest-mode" data-write-control></button>
    <div id="editor"></div>`;
});

const testUser: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function wire(canWrite: boolean) {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks('A paragraph.\n'));
  const editor: EditorHandle = createEditor({
    parent: byId('editor'),
    ydoc,
    awareness: new Awareness(ydoc),
  });
  const scope = new MountScope();
  wireDocGates({
    editor,
    scope,
    els: {
      toggleEditMode: byId<HTMLButtonElement>('toggle-edit-mode'),
      toggleSuggestMode: byId<HTMLButtonElement>('toggle-suggest-mode'),
      formatBar: byId('format-bar'),
      toggleFormat: byId<HTMLButtonElement>('toggle-format'),
    },
    docId: 'd1',
    user: testUser,
    canWrite,
    justStarted: false,
  });
  open.push(() => {
    scope.dispose();
    editor.destroy();
  });
  return { editor, scope };
}

describe('the format bar', () => {
  it('opens and closes from the Aa button, saying which it is', () => {
    wire(true);
    const bar = byId('format-bar');
    const aa = byId<HTMLButtonElement>('toggle-format');
    expect(bar.classList.contains('is-collapsed')).toBe(true);

    aa.click();
    expect(bar.classList.contains('is-collapsed')).toBe(false);
    expect(aa.getAttribute('aria-pressed')).toBe('true');

    aa.click();
    expect(bar.classList.contains('is-collapsed')).toBe(true);
    expect(aa.getAttribute('aria-pressed')).toBe('false');
  });

  it('answers the ⌘⇧F hotkey from anywhere on the page', () => {
    wire(true);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F', metaKey: true, shiftKey: true, bubbles: true }),
    );
    expect(byId('format-bar').classList.contains('is-collapsed')).toBe(false);
  });

  it('stops answering it once the mount is torn down', () => {
    const { scope } = wire(true);
    scope.dispose();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'f', metaKey: true, shiftKey: true, bubbles: true }),
    );
    expect(byId('format-bar').classList.contains('is-collapsed')).toBe(true);
  });
});

describe('a browser the server accepts writes from', () => {
  it('gets both doors, and can open the editor', () => {
    const { editor } = wire(true);
    expect(byId<HTMLButtonElement>('toggle-edit-mode').disabled).toBe(false);
    expect(byId<HTMLButtonElement>('toggle-suggest-mode').disabled).toBe(false);
    byId('toggle-edit-mode').click();
    expect(editor.editor.isEditable).toBe(true);
    expect(document.body.classList.contains('view-mode')).toBe(false);
  });
});

describe('a browser the server will not accept writes from', () => {
  it('gets neither door — they are the same door', () => {
    wire(false);
    for (const id of ['toggle-edit-mode', 'toggle-suggest-mode']) {
      const btn = byId<HTMLButtonElement>(id);
      expect(btn.disabled).toBe(true);
      expect(btn.getAttribute('aria-label')).toBe('Sign in to edit this doc');
    }
  });

  it('is left reading, synchronously, with nothing editable in between', () => {
    const { editor } = wire(false);
    expect(editor.editor.isEditable).toBe(false);
    expect(document.body.classList.contains('view-mode')).toBe(true);
  });

  it('is told nothing about saving on a surface that cannot save', () => {
    wire(false);
    // "All changes saved" beside a locked editor is a true sentence about a
    // thing that is not happening.
    expect(byId('save-state').textContent).toBe('');
    expect(byId('save-state').classList.contains('save-state--saved')).toBe(false);
  });

  it('cannot open the editor by clicking the locked toggle anyway', () => {
    const { editor } = wire(false);
    byId('toggle-edit-mode').click();
    expect(editor.editor.isEditable).toBe(false);
  });
});
