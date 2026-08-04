import { type Thread, type User, createThread, prose } from '@feedback/core';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { MountScope } from '../src/mount-scope.ts';
import type { RedlineDeletion } from '../src/redline/live-markup.ts';
import {
  type LiveRedlineSurface,
  createLiveRedlineEditor,
} from '../src/redline/live-redline-editor.ts';
import { groupDeletions, mountMarkupMargin } from '../src/redline/markup-margin.ts';
import { mountReviewChrome } from '../src/review-chrome.ts';

/**
 * The markup margin: Word's balloon column for deletions AND open comment
 * threads. jsdom/happy-dom can't do real layout, so these tests assert DOM
 * structure, classes, and (where the test cares about ordering) explicitly
 * mocked measurements — the pixel math itself lives in layoutBalloons
 * (unit-tested separately, and the real-browser pass is a manual step per
 * the plan).
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
});

function mountSurface(baseText: string, md: string) {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  if (md !== '') fragment.push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  parent.id = 'editor';
  document.body.appendChild(parent);
  const surface = createLiveRedlineEditor({
    parent,
    ydoc,
    awareness: new Awareness(ydoc),
    baseText,
    debounceMs: 0,
  });
  open.push(() => {
    surface.destroy();
    parent.remove();
  });
  return { parent, surface };
}

function mountMargin(
  parent: HTMLElement,
  surface: LiveRedlineSurface,
  getDeletions?: () => RedlineDeletion[],
) {
  const scope = new MountScope();
  const margin = mountMarkupMargin({
    editorEl: parent,
    view: surface.handle.editor.view,
    getDeletions: getDeletions ?? (() => surface.getDeletions()),
    scope,
  });
  open.push(() => scope.dispose());
  return { scope, margin };
}

// --- comment-balloon fixtures: a real mountReviewChrome + real ThreadPanel,
// so "reuses the drawer card" and "dispatches to chrome handlers" are
// exercised against the actual chrome, not a stand-in. ---------------------

function mountChromeDom(): void {
  document.body.innerHTML = `
    <div id="shell">
      <aside id="set-pane"></aside>
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
}

const testUser: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };

/** The editable redline surface (deletions + comments) wired to a real chrome. */
function mountRedlineWithChrome(baseText: string, md: string) {
  mountChromeDom();
  const parent = document.getElementById('editor') as HTMLElement;
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  if (md !== '') fragment.push(prose.parseMarkdownBlocks(md));
  const surface = createLiveRedlineEditor({
    parent,
    ydoc,
    awareness: new Awareness(ydoc),
    baseText,
    debounceMs: 0,
  });
  const scope = new MountScope();
  const chrome = mountReviewChrome({
    docId: 'd1',
    user: testUser,
    ydoc,
    surface,
    scope,
    selectHint: '',
    reanchorHint: '',
    getSelection: () => surface.getSelectionRel(),
  });
  open.push(() => {
    scope.dispose();
    surface.destroy();
  });
  return { ydoc, fragment, parent, surface, chrome, scope };
}

/** The plain markdown surface (no deletions, no baseText) wired to a real
 *  chrome — matches how app.ts mounts the margin on a non-diff review doc. */
function mountPlainWithChrome(md: string) {
  mountChromeDom();
  const parent = document.getElementById('editor') as HTMLElement;
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  if (md !== '') fragment.push(prose.parseMarkdownBlocks(md));
  const editor: EditorHandle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc) });
  const scope = new MountScope();
  const chrome = mountReviewChrome({
    docId: 'd1',
    user: testUser,
    ydoc,
    surface: editor,
    scope,
    selectHint: '',
    reanchorHint: '',
    getSelection: () => editor.getSelectionRel(),
  });
  open.push(() => {
    scope.dispose();
    editor.destroy();
  });
  return { ydoc, fragment, parent, editor, chrome, scope };
}

/** Select a range, then create a real open thread anchored to it (same shape
 *  the server's REST route builds) — synchronously updates the ThreadPanel
 *  and the ThreadDecorations DOM via the ydoc's threads-map observer. */
function openThreadAt(
  ydoc: Y.Doc,
  tiptapEditor: { commands: { setTextSelection: (range: { from: number; to: number }) => void } },
  getSelectionRel: () => { start: Uint8Array; end: Uint8Array; snippet: string } | null,
  range: { from: number; to: number },
  text: string,
  threadId = `t-${Math.random().toString(36).slice(2)}`,
): Thread {
  tiptapEditor.commands.setTextSelection(range);
  const sel = getSelectionRel();
  if (!sel) throw new Error('selection did not resolve — check the range');
  return createThread(ydoc, {
    threadId,
    anchor: {
      kind: 'text-range',
      startRel: sel.start,
      endRel: sel.end,
      snippet: { text: sel.snippet },
    },
    createdBy: { id: 'u2', name: 'Bob', kind: 'known', color: '#c0392b' },
    firstComment: { id: `${threadId}-c1`, text },
  });
}

/** Let the (0ms in tests) markup debounce fire and the view repaint. */
const tick = () => new Promise((r) => setTimeout(r, 25));

describe('groupDeletions — consecutive same-paragraph deletions collapse', () => {
  it('returns an empty list for no deletions', () => {
    expect(groupDeletions([], () => 0)).toEqual([]);
  });

  it('collapses consecutive deletions with the same block key into one group', () => {
    const groups = groupDeletions(
      [
        { pos: 5, deletedMarkdown: 'beta' },
        { pos: 12, deletedMarkdown: 'delta' },
      ],
      () => 0,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].pos).toBe(5);
    expect(groups[0].deletedMarkdown).toContain('beta');
    expect(groups[0].deletedMarkdown).toContain('delta');
  });

  it('keeps deletions in different blocks as separate groups', () => {
    const groups = groupDeletions(
      [
        { pos: 5, deletedMarkdown: 'first' },
        { pos: 30, deletedMarkdown: 'second' },
      ],
      (pos) => (pos < 20 ? 0 : 2),
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].deletedMarkdown).toBe('first');
    expect(groups[1].deletedMarkdown).toBe('second');
  });
});

describe('mountMarkupMargin — balloon DOM', () => {
  it('renders one deletion balloon with the deleted markdown as plain text', async () => {
    const { parent, surface } = mountSurface(
      'Alpha.\n\nRemoved paragraph.\n\nBravo.\n',
      'Alpha.\n\nBravo.\n',
    );
    await tick();
    const { margin } = mountMargin(parent, surface);
    margin.relayout();

    expect(parent.classList.contains('redline-layout')).toBe(true);
    const marginEl = parent.querySelector('.markup-margin');
    expect(marginEl).not.toBeNull();
    const balloons = parent.querySelectorAll('.lf-balloon.lf-balloon-del');
    expect(balloons).toHaveLength(1);
    expect(balloons[0].querySelector('.lf-balloon-label')?.textContent).toBe('Deleted');
    expect(balloons[0].querySelector('.lf-balloon-text')?.textContent).toContain(
      'Removed paragraph.',
    );
    // One SVG overlay with one leader line per balloon.
    const overlay = parent.querySelectorAll('svg.lf-leader-overlay');
    expect(overlay).toHaveLength(1);
    expect(overlay[0].querySelectorAll('.lf-leader')).toHaveLength(1);
  });

  it('collapses two inline deletions in the same paragraph into one balloon', async () => {
    const { parent, surface } = mountSurface(
      'Alpha beta gamma delta epsilon.\n',
      'Alpha gamma epsilon.\n',
    );
    await tick();
    expect(surface.getDeletions().length).toBeGreaterThanOrEqual(2);
    const { margin } = mountMargin(parent, surface);
    margin.relayout();

    const balloons = parent.querySelectorAll('.lf-balloon');
    expect(balloons).toHaveLength(1);
    const text = balloons[0].querySelector('.lf-balloon-text')?.textContent ?? '';
    expect(text).toContain('beta');
    expect(text).toContain('delta');
  });

  it('renders separate balloons for deletions anchored in different paragraphs', async () => {
    const { parent, surface } = mountSurface(
      'One.\n\nFirst removed.\n\nTwo.\n\nSecond removed.\n\nThree.\n',
      'One.\n\nTwo.\n\nThree.\n',
    );
    await tick();
    const { margin } = mountMargin(parent, surface);
    margin.relayout();

    const balloons = parent.querySelectorAll('.lf-balloon');
    expect(balloons).toHaveLength(2);
    expect(parent.querySelectorAll('svg.lf-leader-overlay .lf-leader')).toHaveLength(2);
  });

  it('re-renders balloons when the deletions list changes', async () => {
    const { parent, surface } = mountSurface('Kept.\n', 'Kept.\n');
    await tick();
    const deletions: RedlineDeletion[] = [];
    const { margin } = mountMargin(parent, surface, () => deletions);
    margin.relayout();
    expect(parent.querySelectorAll('.lf-balloon')).toHaveLength(0);

    deletions.push({ pos: 1, deletedMarkdown: 'now gone' });
    margin.relayout();
    const balloons = parent.querySelectorAll('.lf-balloon');
    expect(balloons).toHaveLength(1);
    expect(balloons[0].textContent).toContain('now gone');
  });
});

describe('mountMarkupMargin — truncation & expand toggle', () => {
  const longMd = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'].join('\n');

  it('clamps long deletions and toggles expansion from the balloon', async () => {
    const { parent, surface } = mountSurface('Kept.\n', 'Kept.\n');
    await tick();
    const { margin } = mountMargin(parent, surface, () => [{ pos: 1, deletedMarkdown: longMd }]);
    margin.relayout();

    const balloon = parent.querySelector('.lf-balloon') as HTMLElement;
    const text = balloon.querySelector('.lf-balloon-text') as HTMLElement;
    const toggle = balloon.querySelector('.lf-balloon-expand') as HTMLButtonElement;
    expect(text.classList.contains('is-clamped')).toBe(true);
    expect(toggle).not.toBeNull();
    expect(toggle.textContent).toBe('Show more');

    toggle.click();
    expect(balloon.classList.contains('is-expanded')).toBe(true);
    expect(text.classList.contains('is-clamped')).toBe(false);
    expect(toggle.textContent).toBe('Show less');

    toggle.click();
    expect(balloon.classList.contains('is-expanded')).toBe(false);
    expect(text.classList.contains('is-clamped')).toBe(true);
  });

  it('shows no toggle for short deletions', async () => {
    const { parent, surface } = mountSurface('Kept.\n', 'Kept.\n');
    await tick();
    const { margin } = mountMargin(parent, surface, () => [{ pos: 1, deletedMarkdown: 'short' }]);
    margin.relayout();

    const balloon = parent.querySelector('.lf-balloon') as HTMLElement;
    expect(balloon.querySelector('.lf-balloon-expand')).toBeNull();
    expect(balloon.querySelector('.lf-balloon-text')?.classList.contains('is-clamped')).toBe(false);
  });
});

describe('mountMarkupMargin — teardown', () => {
  it('scope.dispose() removes the margin DOM and disconnects observers', async () => {
    const observed: unknown[] = [];
    const disconnected: number[] = [];
    class FakeResizeObserver {
      observe(el: unknown): void {
        observed.push(el);
      }
      unobserve(): void {}
      disconnect(): void {
        disconnected.push(1);
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    try {
      const { parent, surface } = mountSurface(
        'Alpha.\n\nRemoved.\n\nBravo.\n',
        'Alpha.\n\nBravo.\n',
      );
      await tick();
      const scope = new MountScope();
      const margin = mountMarkupMargin({
        editorEl: parent,
        view: surface.handle.editor.view,
        getDeletions: () => surface.getDeletions(),
        scope,
      });
      margin.relayout();
      expect(parent.querySelector('.markup-margin')).not.toBeNull();
      expect(observed.length).toBeGreaterThan(0);
      expect(document.querySelector('.lf-del-sheet')).not.toBeNull();

      scope.dispose();
      expect(parent.querySelector('.markup-margin')).toBeNull();
      expect(parent.querySelector('svg.lf-leader-overlay')).toBeNull();
      expect(parent.classList.contains('redline-layout')).toBe(false);
      expect(disconnected.length).toBeGreaterThan(0);
      expect(document.querySelector('.lf-del-sheet')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('mountMarkupMargin — comment balloons', () => {
  it('renders an open thread as the drawer card, and its Resolve button dispatches through chrome', async () => {
    const { parent, surface, ydoc, chrome, scope } = mountRedlineWithChrome(
      '',
      'Alpha bravo gamma.\n',
    );
    await tick();
    const thread = openThreadAt(
      ydoc,
      surface.handle.editor,
      () => surface.getSelectionRel(),
      { from: 1, to: 6 },
      'Please clarify this.',
    );

    const margin = mountMarkupMargin({
      editorEl: parent,
      view: surface.handle.editor.view,
      getDeletions: () => [],
      threads: () => chrome.collectThreads(),
      chrome,
      scope,
    });
    margin.relayout();

    const balloon = parent.querySelector('.lf-balloon.lf-balloon-comment') as HTMLElement;
    expect(balloon).not.toBeNull();
    // It IS the drawer's thread card (ThreadPanel.renderThread), not a copy.
    expect(balloon.classList.contains('thread')).toBe(true);
    expect(balloon.getAttribute('data-thread-id')).toBe(thread.id);
    expect(balloon.textContent).toContain('Please clarify this.');
    expect(balloon.textContent).toContain('Bob'); // the comment's author

    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true }) as unknown as Promise<Response>);
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const resolveBtn = Array.from(balloon.querySelectorAll('button')).find(
        (b) => b.textContent === 'Resolve',
      );
      expect(resolveBtn).toBeTruthy();
      resolveBtn?.click();
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/api/docs/d1/threads/${thread.id}/resolve`),
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('replies from the balloon post through the SAME chrome fetch call the drawer uses', async () => {
    const { parent, surface, ydoc, chrome, scope } = mountRedlineWithChrome(
      '',
      'Alpha bravo gamma.\n',
    );
    await tick();
    const thread = openThreadAt(
      ydoc,
      surface.handle.editor,
      () => surface.getSelectionRel(),
      { from: 1, to: 6 },
      'Original comment.',
    );

    const margin = mountMarkupMargin({
      editorEl: parent,
      view: surface.handle.editor.view,
      getDeletions: () => [],
      threads: () => chrome.collectThreads(),
      chrome,
      scope,
    });
    margin.relayout();

    const balloon = parent.querySelector('.lf-balloon.lf-balloon-comment') as HTMLElement;
    const textarea = balloon.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'A reply from the balloon';
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true }) as unknown as Promise<Response>);
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const replyBtn = Array.from(balloon.querySelectorAll('button')).find(
        (b) => b.textContent === 'Reply',
      );
      replyBtn?.click();
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/api/docs/d1/threads/${thread.id}/comments`),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('A reply from the balloon'),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not render a balloon for a resolved thread', async () => {
    const { parent, surface, ydoc, chrome, scope } = mountRedlineWithChrome(
      '',
      'Alpha bravo gamma.\n',
    );
    await tick();
    const thread = openThreadAt(
      ydoc,
      surface.handle.editor,
      () => surface.getSelectionRel(),
      { from: 1, to: 6 },
      'Already handled.',
    );
    (ydoc.getMap('threads').get(thread.id) as Y.Map<unknown>).set('status', 'resolved');

    const margin = mountMarkupMargin({
      editorEl: parent,
      view: surface.handle.editor.view,
      getDeletions: () => [],
      threads: () => chrome.collectThreads(),
      chrome,
      scope,
    });
    margin.relayout();

    expect(parent.querySelectorAll('.lf-balloon-comment')).toHaveLength(0);
  });
});

describe('mountMarkupMargin — mixed deletion + comment ordering', () => {
  it('shares one layoutBalloons pass: a comment anchored above a deletion gets a smaller top offset', async () => {
    const { parent, surface, ydoc, chrome, scope } = mountRedlineWithChrome(
      'Alpha.\n\nRemoved paragraph.\n\nBravo.\n',
      'Alpha.\n\nBravo.\n',
    );
    await tick();
    const thread = openThreadAt(
      ydoc,
      surface.handle.editor,
      () => surface.getSelectionRel(),
      { from: 1, to: 6 },
      'Comment near the top.',
    );

    const view = surface.handle.editor.view;
    // The deletion's anchor comes from coordsAtPos — pin it well below the
    // comment's decoration span regardless of happy-dom's (nonexistent) real
    // layout, so the assertion below tests ORDERING, not pixel geometry.
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({
      top: 200,
      bottom: 210,
      left: 0,
      right: 0,
    } as ReturnType<EditorView['coordsAtPos']>);
    const span = parent.querySelector(`[data-thread-id="${thread.id}"]`) as HTMLElement;
    expect(span).not.toBeNull();
    vi.spyOn(span, 'getBoundingClientRect').mockReturnValue({
      top: 10,
      bottom: 20,
      left: 0,
      right: 0,
      width: 0,
      height: 10,
      x: 0,
      y: 10,
      toJSON() {},
    } as DOMRect);

    const margin = mountMarkupMargin({
      editorEl: parent,
      view,
      getDeletions: () => surface.getDeletions(),
      threads: () => chrome.collectThreads(),
      chrome,
      scope,
    });
    margin.relayout();

    const commentEl = parent.querySelector('.lf-balloon-comment') as HTMLElement;
    const delEl = parent.querySelector('.lf-balloon-del') as HTMLElement;
    expect(commentEl).not.toBeNull();
    expect(delEl).not.toBeNull();
    // Both balloons live in the same margin column, positioned by one
    // combined layoutBalloons() call sorted by anchor Y.
    expect(commentEl.parentElement).toBe(delEl.parentElement);
    expect(Number.parseFloat(commentEl.style.top)).toBeLessThan(Number.parseFloat(delEl.style.top));
  });
});

describe('mountMarkupMargin — plain markdown doc (comments only, no deletions)', () => {
  it('shows comment balloons but never deletion balloons when there is no diff base', async () => {
    const { parent, editor, ydoc, chrome, scope } = mountPlainWithChrome('Alpha bravo gamma.\n');
    await tick();
    openThreadAt(
      ydoc,
      editor.editor,
      () => editor.getSelectionRel(),
      { from: 1, to: 6 },
      'A note on Alpha.',
    );

    const margin = mountMarkupMargin({
      editorEl: parent,
      view: editor.editor.view,
      getDeletions: () => [], // matches app.ts's plain-markdown wiring
      threads: () => chrome.collectThreads(),
      chrome,
      scope,
    });
    margin.relayout();

    expect(parent.classList.contains('redline-layout')).toBe(true);
    expect(parent.querySelectorAll('.lf-balloon-del')).toHaveLength(0);
    expect(parent.querySelectorAll('.lf-balloon-comment')).toHaveLength(1);
  });
});

describe('mountMarkupMargin — mobile deletion chip opens the bottom sheet', () => {
  it('tapping a chip opens the sheet with the deleted markdown; the close button hides it again', async () => {
    const { parent, surface } = mountSurface(
      'Alpha.\n\nRemoved paragraph.\n\nBravo.\n',
      'Alpha.\n\nBravo.\n',
    );
    await tick();
    mountMargin(parent, surface); // wires the chip → sheet click delegation

    const chip = parent.querySelector('.lf-del-chip') as HTMLElement;
    expect(chip).not.toBeNull();
    const sheet = document.querySelector('.lf-del-sheet') as HTMLElement;
    expect(sheet).not.toBeNull();
    expect(sheet.classList.contains('hidden')).toBe(true);

    chip.click();
    expect(sheet.classList.contains('hidden')).toBe(false);
    expect(sheet.getAttribute('aria-hidden')).toBe('false');
    expect(sheet.querySelector('.lf-del-sheet-text')?.textContent).toContain('Removed paragraph.');

    (sheet.querySelector('.thread-view-close') as HTMLElement).click();
    expect(sheet.classList.contains('hidden')).toBe(true);
    expect(sheet.getAttribute('aria-hidden')).toBe('true');
  });

  it('a click elsewhere in the editor does not open the sheet', async () => {
    const { parent, surface } = mountSurface(
      'Alpha.\n\nRemoved paragraph.\n\nBravo.\n',
      'Alpha.\n\nBravo.\n',
    );
    await tick();
    mountMargin(parent, surface);

    const sheet = document.querySelector('.lf-del-sheet') as HTMLElement;
    const pm = parent.querySelector('.ProseMirror') as HTMLElement;
    pm.click();
    expect(sheet.classList.contains('hidden')).toBe(true);
  });
});

describe('mountMarkupMargin — revealThreadBalloon', () => {
  it('scrolls a rendered comment balloon into view and returns true; false when not found', async () => {
    const { parent, surface, ydoc, chrome, scope } = mountRedlineWithChrome(
      '',
      'Alpha bravo gamma.\n',
    );
    await tick();
    const thread = openThreadAt(
      ydoc,
      surface.handle.editor,
      () => surface.getSelectionRel(),
      { from: 1, to: 6 },
      'Find me.',
    );

    const margin = mountMarkupMargin({
      editorEl: parent,
      view: surface.handle.editor.view,
      getDeletions: () => [],
      threads: () => chrome.collectThreads(),
      chrome,
      scope,
    });
    margin.relayout();

    const balloon = parent.querySelector('.lf-balloon-comment') as HTMLElement;
    const scrollSpy = vi.fn();
    balloon.scrollIntoView = scrollSpy;

    expect(margin.revealThreadBalloon(thread.id)).toBe(true);
    expect(scrollSpy).toHaveBeenCalled();
    expect(margin.revealThreadBalloon('no-such-thread')).toBe(false);
  });
});
