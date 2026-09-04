import { type User, createThread, prose, suggestOps } from '@feedback/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { mountDocMargin } from '../src/doc/doc-margin.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { MountScope } from '../src/mount-scope.ts';
import { mountReviewChrome } from '../src/review-chrome.ts';
import { IPAD, setViewport } from './css-harness.ts';

/**
 * The margin phase of a document's boot (doc/doc-margin.ts): everything that
 * reports on comments the reader is not looking at.
 *
 * Three mounts and one jump, together because they are one loop — the
 * balloons, the doc-level suggestion count and the off-screen hints all have
 * to be told again after every editor transaction. That single listener is
 * the thing worth pinning: without it, an agent's edit lands and every one of
 * the three keeps reporting the document as it was.
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

beforeEach(() => {
  // The balloon column is display:none below 1100px, and `revealThreadBalloon`
  // reports that rather than silently eating the caller's drawer fallback —
  // so the width has to be a real one for the margin to be on screen at all.
  setViewport(IPAD);
  document.body.innerHTML = `
    <div id="shell">
      <main id="editor-pane"><div id="editor"></div></main>
      <aside id="threads-pane">
        <div class="threads-tabs">
          <button class="tab active" data-tab="open">Open</button>
          <button class="tab" data-tab="resolved">Resolved</button>
        </div>
        <button id="toggle-threads">☰</button>
        <span id="threads-count"></span>
        <button id="close-threads">×</button>
        <ol id="threads-list"></ol>
      </aside>
      <div id="threads-scrim"></div>
      <div id="doc-title"></div>
      <span id="doc-asks" class="hidden"></span>
      <button id="toggle-suggestions" class="hidden">✎<span id="suggestions-count">0</span></button>
      <div id="suggestions-menu" class="hidden">
        <button id="suggestions-accept-all">Accept all</button>
        <button id="suggestions-reject-all">Reject all</button>
      </div>
      <div id="composer" class="hidden">
        <div id="composer-avatar"></div>
        <div id="composer-quote"></div>
        <textarea id="composer-text"></textarea>
        <button id="composer-submit">Post</button>
      </div>
      <div id="composer-scrim" class="hidden"></div>
      <div id="thread-view" class="hidden">
        <button id="thread-view-close">×</button>
        <div id="thread-view-body"></div>
        <textarea id="thread-view-reply-text"></textarea>
        <button id="thread-view-reply-submit">Reply</button>
      </div>
      <div id="toast" class="hidden"></div>
    </div>`;
});

const testUser: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const suggester = { id: 'agent-1', name: 'Docs Agent', color: '#7c5cff' };

function mount(md = 'Alpha bravo gamma. Delta epsilon.\n') {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md));
  const editorMount = document.getElementById('editor') as HTMLElement;
  const editor: EditorHandle = createEditor({
    parent: editorMount,
    ydoc,
    awareness: new Awareness(ydoc),
  });
  const scope = new MountScope();
  const chrome = mountReviewChrome({
    docId: 'd1',
    user: testUser,
    ydoc,
    surface: editor,
    whenSynced: (cb) => cb(),
    scope,
    canWrite: true,
    selectHint: '',
    reanchorHint: '',
    getSelection: () => editor.getSelectionRel(),
    hasBalloonMargin: true,
  });
  const margin = mountDocMargin({ docId: 'd1', ydoc, scope, editor, editorMount, chrome });
  open.push(() => {
    scope.dispose();
    editor.destroy();
  });
  return { ydoc, editor, editorMount, chrome, scope, margin };
}

/** An open thread anchored to a real range, the shape the REST route builds. */
function openThreadAt(
  ydoc: Y.Doc,
  editor: EditorHandle,
  range: { from: number; to: number },
  threadId: string,
): void {
  editor.editor.commands.setTextSelection(range);
  const sel = editor.getSelectionRel();
  if (!sel) throw new Error('selection did not resolve — check the range');
  createThread(ydoc, {
    threadId,
    anchor: {
      kind: 'text-range',
      startRel: sel.start,
      endRel: sel.end,
      snippet: { text: sel.snippet },
    },
    createdBy: { id: 'u2', name: 'Bob', kind: 'known', color: '#c0392b' },
    firstComment: { id: `c-${threadId}`, text: 'is this right?' },
  });
}

const balloons = () => [...document.querySelectorAll('.markup-margin .lf-balloon')];
const suggestionCount = () => document.getElementById('suggestions-count')?.textContent;

/** An editor transaction — the one signal the whole margin loop rides. What it
 *  starts is debounced, so the caller polls for the result rather than waiting
 *  a fixed span. */
function transaction(editor: EditorHandle): void {
  editor.editor.emit('transaction', { editor: editor.editor } as never);
}

describe('the balloon margin', () => {
  it('is drawn into the editor, and carries a card per open thread', async () => {
    const { ydoc, editor } = mount();
    expect(document.querySelector('.markup-margin')).not.toBeNull();
    expect(balloons()).toHaveLength(0);

    openThreadAt(ydoc, editor, { from: 1, to: 6 }, 't-1');
    transaction(editor);
    await vi.waitFor(() => expect(balloons()).toHaveLength(1));
  });

  it('says whether a thread has a balloon to reveal', async () => {
    const { ydoc, editor, margin } = mount();
    openThreadAt(ydoc, editor, { from: 1, to: 6 }, 't-1');
    transaction(editor);
    await vi.waitFor(() => expect(balloons()).toHaveLength(1));
    expect(margin.revealThreadBalloon('t-1')).toBe(true);
    // A thread with no balloon — a stale link, a resolved thread — reports so
    // rather than pretending it scrolled somewhere.
    expect(margin.revealThreadBalloon('t-missing')).toBe(false);
  });
});

describe('the one transaction listener', () => {
  it('recounts the doc-level suggestions after an edit the module did not make', async () => {
    vi.useFakeTimers();
    const { ydoc, editor } = mount();
    expect(suggestionCount()).toBe('0');

    // A plain Yjs mutation, the way an agent's suggestion actually arrives.
    suggestOps.suggestReplace(ydoc, { find: 'gamma', replace: 'GAMMA', author: suggester });
    // The editor's transaction is the single signal all three mounts ride.
    transaction(editor);
    await vi.advanceTimersByTimeAsync(200);

    expect(suggestionCount()).toBe('1');
    expect(document.getElementById('toggle-suggestions')?.classList.contains('hidden')).toBe(false);
  });

  it('is detached on teardown, so the next document is not redrawn by this one', async () => {
    vi.useFakeTimers();
    const { ydoc, editor, scope } = mount();
    scope.dispose();

    suggestOps.suggestReplace(ydoc, { find: 'gamma', replace: 'GAMMA', author: suggester });
    transaction(editor);
    await vi.advanceTimersByTimeAsync(200);

    expect(suggestionCount()).toBe('0');
  });
});
