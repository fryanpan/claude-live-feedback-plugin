import { type User, prose } from '@feedback/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { ChromeSelection } from '../src/doc/anchor-body.ts';
import { createSpinoffRunner } from '../src/doc/doc-spinoff.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';

/**
 * Spinning selected words off a doc into work (doc/doc-spinoff.ts).
 *
 * Two things this module has to keep true. The board it files against is
 * `backTo`, not `workspaceId` — reading the wrong one posted to
 * `/workspaces//tasks` and the person saw a toast reading "404". And the
 * receipt has to match what was actually made: the toast names the column the
 * row landed in, and its Undo archives that same row and un-links the words
 * it linked. An Undo that reported one thing and did another is the failure
 * worth testing.
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

beforeEach(() => {
  document.body.innerHTML = '<div id="toast" class="hidden"></div><div id="editor"></div>';
});

const toast = () => document.getElementById('toast') as HTMLElement;
const toastText = () => (toast().firstChild?.textContent ?? '').toString();
const undoButton = () => toast().querySelector('button.toast-action') as HTMLButtonElement | null;

const testUser: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };

function runner(meta: { backTo?: { workspaceId?: string }; workspaceId?: string }) {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks('Ship the balloon margin\n'));
  const parent = document.getElementById('editor') as HTMLElement;
  const editor: EditorHandle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc) });
  open.push(() => editor.destroy());
  const take = createSpinoffRunner({ docId: 'd1', ydoc, user: testUser, editor, meta });
  return { take, editor, ydoc };
}

/** A selection over the doc's first line, in the shape the chrome hands over. */
function selectionOver(editor: EditorHandle, from: number, to: number): ChromeSelection {
  editor.editor.commands.setTextSelection({ from, to });
  const sel = editor.getSelectionRel();
  if (!sel) throw new Error('selection did not resolve — check the range');
  return sel;
}

/** Stub the network, recording every request. */
function stubFetch(reply: (url: string, body: unknown) => { ok: boolean; body: unknown }) {
  const calls: Array<{ url: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ url: String(url), body });
      const r = reply(String(url), body);
      return { ok: r.ok, json: async () => r.body } as Response;
    }),
  );
  return calls;
}

describe('a doc that is on no board', () => {
  it('says so instead of posting to a workspace-less address', async () => {
    const calls = stubFetch(() => ({ ok: true, body: {} }));
    const { take, editor } = runner({ workspaceId: '' });
    await take('task', selectionOver(editor, 1, 5), { from: 1, to: 5 });
    expect(toastText()).toBe('This doc is not on a board yet.');
    // The guard is the point: nothing was sent anywhere.
    expect(calls).toHaveLength(0);
  });
});

describe('creating a task from a selection', () => {
  it('files against the board the doc was reached FROM, not its grouping id', async () => {
    const calls = stubFetch(() => ({
      ok: true,
      body: { task: { id: 't-9', status: 'todo' } },
    }));
    const { take, editor } = runner({ backTo: { workspaceId: 'w-board' }, workspaceId: 'w-group' });
    await take('task', selectionOver(editor, 1, 24), { from: 1, to: 24 });
    expect(calls[0]?.url).toBe('/workspaces/w-board/tasks');
  });

  it('names the column the row landed in, and offers to take it back', async () => {
    stubFetch((url) =>
      url.includes('/archive')
        ? { ok: true, body: {} }
        : { ok: true, body: { task: { id: 't-9', status: 'todo' } } },
    );
    const { take, editor } = runner({ backTo: { workspaceId: 'w-board' } });
    await take('task', selectionOver(editor, 1, 24), { from: 1, to: 24 });
    expect(toastText()).toContain('added to To do');
    expect(undoButton()?.textContent).toBe('Undo');
    // The selected words became the row's link.
    expect(document.querySelector('a[href*="t-9"]')).not.toBeNull();
  });

  it('says Triage when that is where the row actually went', async () => {
    stubFetch(() => ({ ok: true, body: { task: { id: 't-9', status: 'triage' } } }));
    const { take, editor } = runner({ backTo: { workspaceId: 'w-board' } });
    await take('task', selectionOver(editor, 1, 24), { from: 1, to: 24 });
    expect(toastText()).toContain('sent to Triage');
  });

  it('archives the row and un-links the words when Undo is taken', async () => {
    const calls = stubFetch((url) =>
      url.includes('/archive')
        ? { ok: true, body: {} }
        : { ok: true, body: { task: { id: 't-9', status: 'todo' } } },
    );
    const { take, editor } = runner({ backTo: { workspaceId: 'w-board' } });
    await take('task', selectionOver(editor, 1, 24), { from: 1, to: 24 });

    undoButton()?.click();
    await vi.waitFor(() => expect(toastText()).toBe('Undone.'));
    const archive = calls.find((c) => c.url.includes('/archive'));
    // Archived, never deleted — the row may already have been read or ranked.
    expect(archive?.url).toBe('/api/tasks/t-9/archive');
    expect(document.querySelector('a[href*="t-9"]')).toBeNull();
  });

  it('reports the server’s own refusal rather than a bare failure', async () => {
    stubFetch(() => ({ ok: false, body: { error: 'that board is retired' } }));
    const { take, editor } = runner({ backTo: { workspaceId: 'w-board' } });
    await take('task', selectionOver(editor, 1, 24), { from: 1, to: 24 });
    expect(toastText()).toBe('that board is retired');
  });
});

describe('asking for research', () => {
  it('reports the section the doc now carries', async () => {
    stubFetch(() => ({
      ok: true,
      body: { threadId: 'th-1', section: 'Research: balloons', placeholder: true },
    }));
    const { take, editor } = runner({ backTo: { workspaceId: 'w-board' } });
    await take('research', selectionOver(editor, 1, 24), { from: 1, to: 24 });
    expect(toastText()).toContain('Research: balloons');
    // Nothing to undo: the receipt is prose in the doc, and deleting prose is
    // the editor's own verb.
    expect(undoButton()).toBeNull();
  });
});
