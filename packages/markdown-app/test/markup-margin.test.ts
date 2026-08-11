import { type Thread, type User, createThread, prose, suggestOps } from '@feedback/core';
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
import { mountReviewChrome, wireThreadRangeClicks } from '../src/review-chrome.ts';

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

/** Balloons rest collapsed (Word-style) — expand one the way a user does:
 *  click it. Rebuilds the margin DOM, so re-query the balloon afterwards. */
function clickToExpand(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

const suggestAuthor = { id: 'agent-1', name: 'Docs Agent', color: '#7c5cff' };

/** A pure INSERT proposal at the start of the doc's first block — there is
 *  no `suggestReplace`-style creation primitive for a zero-length find, so
 *  this builds the same zero-length Y.RelativePosition pair
 *  `suggestRewriteRange` expects (mirrors the pattern in
 *  packages/core/test/suggest-ops.test.ts). */
function suggestPureInsert(ydoc: Y.Doc, replacement: string): { sid: string } {
  const frag = prose.getProseFragment(ydoc);
  const block = frag.toArray()[0] as Y.XmlElement;
  const text = block.toArray()[0] as Y.XmlText;
  const rel = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, 0));
  const res = suggestOps.suggestRewriteRange(ydoc, {
    startRel: rel,
    endRel: rel,
    replacement,
    author: suggestAuthor,
  });
  if (!res.ok) throw new Error('suggestPureInsert failed to create a proposal');
  return res;
}

/** happy-dom's viewport width drives `window.matchMedia` — the same query
 *  the source uses to mirror the styles.css `max-width: 1100px` breakpoint
 *  that hides the balloon column. Default is 1024px, i.e. BELOW the
 *  breakpoint, so any test about visible balloons must widen it. */
function setViewportWidth(w: number): void {
  (
    window as unknown as { happyDOM: { setInnerWidth: (w: number) => void } }
  ).happyDOM.setInnerWidth(w);
}
afterEach(() => setViewportWidth(1024));

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
    let balloons = parent.querySelectorAll('.lf-balloon.lf-balloon-del');
    expect(balloons).toHaveLength(1);
    // Rests collapsed: label + one-line preview, full text behind a click.
    expect(balloons[0].classList.contains('lf-balloon-collapsed')).toBe(true);
    expect(balloons[0].querySelector('.lf-balloon-label')?.textContent).toBe('Deleted');
    clickToExpand(balloons[0]);
    balloons = parent.querySelectorAll('.lf-balloon.lf-balloon-del');
    expect(balloons[0].classList.contains('lf-balloon-collapsed')).toBe(false);
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

    let balloons = parent.querySelectorAll('.lf-balloon');
    expect(balloons).toHaveLength(1);
    clickToExpand(balloons[0]);
    balloons = parent.querySelectorAll('.lf-balloon');
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

    clickToExpand(parent.querySelector('.lf-balloon') as HTMLElement);
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

    clickToExpand(parent.querySelector('.lf-balloon') as HTMLElement);
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

    // Rests collapsed — but as the SAME node it will be expanded as. Both
    // faces are already built, because the morph cross-fades between two
    // things that both have to exist.
    const balloon = parent.querySelector('.lf-balloon.lf-balloon-comment') as HTMLElement;
    expect(balloon).not.toBeNull();
    expect(balloon.classList.contains('expanded')).toBe(false);
    expect(balloon.querySelector('.thread-topic')?.textContent).toBeTruthy();
    expect(balloon.textContent).toContain('Please clarify this.');
    expect(balloon.textContent).toContain('Bob');

    clickToExpand(balloon);
    // Expanding MUTATES that node — a rebuilt card mounts at its final
    // height and has nothing to morph out of.
    expect(parent.querySelector('.lf-balloon.lf-balloon-comment')).toBe(balloon);
    // It IS the drawer's thread card (ThreadPanel.renderThread).
    expect(balloon.classList.contains('thread')).toBe(true);
    expect(balloon.getAttribute('data-thread-id')).toBe(thread.id);
    expect(balloon.textContent).toContain('Please clarify this.');
    expect(balloon.textContent).toContain('Bob'); // the comment's author
    // ...with the streamlined card's own shape: both folding slots present,
    // the opening message in slot A, and the reply box in slot B.
    expect(balloon.classList.contains('expanded')).toBe(true);
    expect(balloon.querySelector('.slot-a .face-detail .thread-message')?.textContent).toContain(
      'Please clarify this.',
    );
    expect(balloon.querySelector('.slot-b .face-detail textarea')).not.toBeNull();

    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true }) as unknown as Promise<Response>);
    vi.stubGlobal('fetch', fetchSpy);
    try {
      // ONE resolve control, in the foot, outside both slots.
      const resolveBtn = balloon.querySelector<HTMLButtonElement>('.thread-foot .thread-resolve');
      expect(balloon.querySelectorAll('.thread-resolve')).toHaveLength(1);
      expect(resolveBtn?.getAttribute('aria-label')).toBe('Resolve thread');
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

    clickToExpand(parent.querySelector('.lf-balloon.lf-balloon-comment') as HTMLElement);
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

  it('repaints when only the anchor snippet moved — the topic line is keyed on it', async () => {
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
    clickToExpand(parent.querySelector('.lf-balloon.lf-balloon-comment') as HTMLElement);

    const topic = () =>
      (parent.querySelector('.lf-balloon-comment .thread-topic')?.textContent ?? '').trim();
    // Positive control: the topic line really is the anchor snippet.
    expect(topic()).toBe('Alpha');

    // A doc edit moves the snippet without touching status, commentCount,
    // lastActivity or the active/expanded flags — every other term in the key.
    const map = ydoc.getMap('threads').get(thread.id) as Y.Map<unknown>;
    const anchor = map.get('anchor') as Record<string, unknown>;
    map.set('anchor', { ...anchor, snippet: { text: 'Alpha bravo' } });
    margin.relayout();

    expect(topic()).toBe('Alpha bravo');
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

describe('mountMarkupMargin — collapsed balloons (Word-style)', () => {
  function mountTwoThreads() {
    const fixture = mountRedlineWithChrome('', 'Alpha bravo gamma delta echo.\n');
    const { parent, surface, ydoc, chrome, scope } = fixture;
    const t1 = openThreadAt(
      ydoc,
      surface.handle.editor,
      () => surface.getSelectionRel(),
      { from: 1, to: 6 },
      'First thread comment.',
    );
    const t2 = openThreadAt(
      ydoc,
      surface.handle.editor,
      () => surface.getSelectionRel(),
      { from: 13, to: 18 },
      'Second thread comment.',
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
    return { parent, chrome, margin, t1, t2 };
  }

  const balloonFor = (parent: HTMLElement, threadId: string): HTMLElement | null => {
    for (const el of Array.from(parent.querySelectorAll<HTMLElement>('.lf-balloon-comment'))) {
      if (el.getAttribute('data-thread-id') === threadId) return el;
      if (el.dataset.expandKey === `c:${threadId}`) return el;
    }
    return null;
  };

  it('expanding one balloon collapses the previously expanded one, in place', async () => {
    const { parent, t1, t2 } = mountTwoThreads();
    await tick();

    const b1 = balloonFor(parent, t1.id) as HTMLElement;
    const b2 = balloonFor(parent, t2.id) as HTMLElement;
    expect(b1.classList.contains('expanded')).toBe(false);
    expect(b2.classList.contains('expanded')).toBe(false);

    clickToExpand(b1);
    expect(b1.classList.contains('expanded')).toBe(true);
    expect(b2.classList.contains('expanded')).toBe(false);

    clickToExpand(b2);
    expect(b1.classList.contains('expanded')).toBe(false);
    expect(b2.classList.contains('expanded')).toBe(true);
    // Same two nodes throughout — expanding never rebuilds the column.
    expect(balloonFor(parent, t1.id)).toBe(b1);
    expect(balloonFor(parent, t2.id)).toBe(b2);
  });

  it('tapping an expanded balloon again folds it back into its two lines', async () => {
    const { parent, chrome, t1 } = mountTwoThreads();
    await tick();

    const card = balloonFor(parent, t1.id) as HTMLElement;
    clickToExpand(card);
    expect(card.classList.contains('expanded')).toBe(true);
    // There is no − button any more: the whole card is the tap target and
    // `✓ Resolve` is the only control in the footer.
    expect(card.querySelector('.lf-balloon-collapse')).toBeNull();

    clickToExpand(card);
    expect(card.classList.contains('expanded')).toBe(false);
    expect(chrome.threadsPanel.getActive()).toBeNull();
  });

  it('expanding a comment balloon makes it the active thread', async () => {
    const { parent, chrome, t1 } = mountTwoThreads();
    await tick();

    expect(chrome.threadsPanel.getActive()).not.toBe(t1.id);
    clickToExpand(balloonFor(parent, t1.id) as HTMLElement);
    expect(chrome.threadsPanel.getActive()).toBe(t1.id);
  });

  it('a collapsed multi-line deletion (e.g. a whole table) shows one bubble with a +N lines badge', async () => {
    const { parent, surface } = mountSurface('Kept.\n', 'Kept.\n');
    await tick();
    const table = '| Group | Modules |\n|---|---|\n| App | `app` |\n| Build | `tooling` |';
    const { margin } = mountMargin(parent, surface, () => [{ pos: 1, deletedMarkdown: table }]);
    margin.relayout();

    const balloons = parent.querySelectorAll('.lf-balloon-del');
    expect(balloons).toHaveLength(1); // ONE bubble for the whole table
    const balloon = balloons[0] as HTMLElement;
    expect(balloon.classList.contains('lf-balloon-collapsed')).toBe(true);
    expect(balloon.querySelector('.lf-collapsed-preview')?.textContent).toBe('| Group | Modules |');
    const badge = balloon.querySelector('.lf-collapsed-count') as HTMLElement;
    expect(badge.textContent).toBe('+3');
    expect(badge.title).toBe('3 more lines');
  });

  it('a collapsed comment shows its reply count in the foot, beside the one resolve control', async () => {
    const fixture = mountRedlineWithChrome('', 'Alpha bravo gamma.\n');
    const { parent, surface, ydoc, chrome, scope } = fixture;
    const t = openThreadAt(
      ydoc,
      surface.handle.editor,
      () => surface.getSelectionRel(),
      { from: 1, to: 6 },
      'Starter.',
    );
    const comments = (ydoc.getMap('threads').get(t.id) as Y.Map<unknown>).get(
      'comments',
    ) as Y.Array<Y.Map<unknown>>;
    const reply = new Y.Map<unknown>();
    reply.set('id', 'c2');
    reply.set('author', { id: 'u3', name: 'Cara', kind: 'known', color: '#333' });
    reply.set('text', 'A reply.');
    reply.set('ts', Date.now());
    comments.push([reply]);

    const margin = mountMarkupMargin({
      editorEl: parent,
      view: surface.handle.editor.view,
      getDeletions: () => [],
      threads: () => chrome.collectThreads(),
      chrome,
      scope,
    });
    margin.relayout();
    await tick();

    const balloon = parent.querySelector('.lf-balloon-comment') as HTMLElement;
    expect(balloon.classList.contains('expanded')).toBe(false);
    expect(balloon.querySelector('.thread-foot .thread-meta')?.textContent).toContain('1 reply');
    // The count lives in the foot, OUTSIDE both folding slots, so expanding
    // neither moves nor rebuilds it.
    expect(balloon.querySelector('.thread-foot')?.closest('.thread-slot')).toBeNull();
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
    setViewportWidth(1440); // balloon column visible (>1100px)
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

    // Reveal EXPANDS the balloon, which rebuilds its element — spy on the
    // prototype so the freshly-built card's scroll is still observed.
    const scrollSpy = vi
      .spyOn(HTMLElement.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    try {
      expect(margin.revealThreadBalloon(thread.id)).toBe(true);
      expect(scrollSpy).toHaveBeenCalled();
      const balloon = parent.querySelector('.lf-balloon-comment') as HTMLElement;
      expect(balloon.classList.contains('expanded')).toBe(true);
      expect(balloon.classList.contains('thread')).toBe(true);
      expect(margin.revealThreadBalloon('no-such-thread')).toBe(false);
    } finally {
      scrollSpy.mockRestore();
    }
  });

  it('returns false at or below the 1100px breakpoint that hides the column (even though the thread is rendered)', async () => {
    setViewportWidth(1440);
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
      'Hidden with the column.',
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
    // The balloon IS in the DOM — CSS (display:none on .markup-margin) is
    // what hides it below the breakpoint, so `rendered[]` membership alone
    // must not count as "revealed".
    expect(parent.querySelector('.lf-balloon-comment')).not.toBeNull();

    // 901–1100px: the iPad-portrait gap where chrome.isMobile() is false
    // but the balloon column is hidden — the width the original bug ate.
    setViewportWidth(1000);
    expect(margin.revealThreadBalloon(thread.id)).toBe(false);
  });

  it('click on a highlight in the 901–1100px gap falls through to the drawer instead of dead-ending', async () => {
    setViewportWidth(1000); // column hidden, but not chrome.isMobile()
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
      'Reach me via the drawer.',
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
    wireThreadRangeClicks({
      editorMount: parent,
      chrome,
      surface,
      scope,
      revealBalloon: (id) => margin.revealThreadBalloon(id),
    });

    chrome.closeDrawer();
    const span = parent.querySelector(`.thread-range[data-thread-id="${thread.id}"]`) as Element;
    expect(span).not.toBeNull();
    span.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    // The real revealThreadBalloon must decline so the shared wiring opens
    // the drawer — the thread-focus tests only mock revealBalloon, so this
    // is the one test that exercises the breakpoint end to end.
    expect(
      (document.getElementById('shell') as HTMLElement).classList.contains('threads-open'),
    ).toBe(true);
  });
});

describe('mountMarkupMargin — clearance under the floating view toggle', () => {
  it('floors the topmost balloon below a visible floating #view-toggle; leader line keeps the true anchor', async () => {
    setViewportWidth(1440);
    const { parent, surface } = mountSurface('Kept.\n', 'Kept.\n');
    await tick();

    // The Redline|Diff|File pill floats over the editor's top-right
    // (position:absolute, z-index:5 — styles.css) exactly where the margin
    // column starts. Simulate its rect: happy-dom has no layout, so rects
    // are zero unless mocked.
    const toggle = document.createElement('div');
    toggle.id = 'view-toggle';
    toggle.className = 'view-toggle';
    document.body.appendChild(toggle);
    vi.spyOn(toggle, 'getBoundingClientRect').mockReturnValue({
      top: 8,
      bottom: 48,
      left: 700,
      right: 900,
      width: 200,
      height: 40,
      x: 700,
      y: 8,
      toJSON() {},
    } as DOMRect);
    open.push(() => toggle.remove());

    const { margin } = mountMargin(parent, surface, () => [
      { pos: 1, deletedMarkdown: 'top-of-doc deletion' },
    ]);
    margin.relayout();

    const balloon = parent.querySelector('.lf-balloon') as HTMLElement;
    // Anchor Y is 0 (no layout) — without clearance the balloon would sit at
    // top:0 underneath the opaque toggle (bottom edge 48px + 8px gap).
    expect(Number.parseFloat(balloon.style.top)).toBeGreaterThanOrEqual(56);
    // The leader line still points at the deletion's real anchor.
    const line = parent.querySelector('svg.lf-leader-overlay .lf-leader') as SVGLineElement;
    expect(Number(line.getAttribute('y1'))).toBe(0);
  });

  it('ignores a hidden #view-toggle (plain markdown docs never show it)', async () => {
    setViewportWidth(1440);
    const { parent, surface } = mountSurface('Kept.\n', 'Kept.\n');
    await tick();

    const toggle = document.createElement('div');
    toggle.id = 'view-toggle';
    toggle.className = 'view-toggle hidden';
    document.body.appendChild(toggle);
    vi.spyOn(toggle, 'getBoundingClientRect').mockReturnValue({
      top: 8,
      bottom: 48,
      left: 700,
      right: 900,
      width: 200,
      height: 40,
      x: 700,
      y: 8,
      toJSON() {},
    } as DOMRect);
    open.push(() => toggle.remove());

    const { margin } = mountMargin(parent, surface, () => [{ pos: 1, deletedMarkdown: 'gone' }]);
    margin.relayout();

    const balloon = parent.querySelector('.lf-balloon') as HTMLElement;
    expect(Number.parseFloat(balloon.style.top)).toBe(0);
  });
});

describe('mountMarkupMargin — suggestion balloons', () => {
  it('renders an insert-only card: author, age, and only the new text underlined', async () => {
    const { parent, editor, ydoc, chrome, scope } = mountPlainWithChrome('Alpha bravo gamma.\n');
    await tick();
    suggestPureInsert(ydoc, 'NEW ');
    await tick();

    const margin = mountMarkupMargin({
      editorEl: parent,
      view: editor.editor.view,
      getDeletions: () => [],
      threads: () => chrome.collectThreads(),
      chrome,
      getSuggestions: () => suggestOps.listSuggestions(ydoc),
      docId: 'd1',
      scope,
    });
    margin.relayout();

    // Rests collapsed: author + preview + compact ✓/✕, no age line yet.
    let balloon = parent.querySelector('.lf-balloon.lf-balloon-suggestion') as HTMLElement;
    expect(balloon).not.toBeNull();
    expect(balloon.classList.contains('lf-balloon-collapsed')).toBe(true);
    expect(balloon.querySelector('.lf-collapsed-name')?.textContent).toBe('Docs Agent');
    expect(balloon.querySelector('.lf-suggest-old')).toBeNull();
    expect(balloon.querySelector('.lf-suggest-new')?.textContent).toBe('NEW ');

    clickToExpand(balloon);
    balloon = parent.querySelector('.lf-balloon.lf-balloon-suggestion') as HTMLElement;
    expect(balloon.classList.contains('lf-balloon-collapsed')).toBe(false);
    expect(balloon.querySelector('.lf-suggest-author')?.textContent).toBe('Docs Agent');
    expect(balloon.querySelector('.lf-suggest-age')?.textContent).toBe('just now');
    expect(balloon.querySelector('.lf-suggest-old')).toBeNull();
    expect(balloon.querySelector('.lf-suggest-new')?.textContent).toBe('NEW ');
  });

  it('renders a delete-only card: only the deleted text struck', async () => {
    const { parent, editor, ydoc, chrome, scope } = mountPlainWithChrome('Alpha bravo gamma.\n');
    await tick();
    suggestOps.suggestReplace(ydoc, { find: 'gamma', replace: '', author: suggestAuthor });
    await tick();

    const margin = mountMarkupMargin({
      editorEl: parent,
      view: editor.editor.view,
      getDeletions: () => [],
      threads: () => chrome.collectThreads(),
      chrome,
      getSuggestions: () => suggestOps.listSuggestions(ydoc),
      docId: 'd1',
      scope,
    });
    margin.relayout();

    const balloon = parent.querySelector('.lf-balloon.lf-balloon-suggestion') as HTMLElement;
    expect(balloon).not.toBeNull();
    expect(balloon.querySelector('.lf-suggest-new')).toBeNull();
    expect(balloon.querySelector('.lf-suggest-old')?.textContent).toBe('gamma');
  });

  it('renders a replace card: old text struck AND new text underlined', async () => {
    const { parent, editor, ydoc, chrome, scope } = mountPlainWithChrome('Alpha bravo gamma.\n');
    await tick();
    suggestOps.suggestReplace(ydoc, { find: 'gamma', replace: 'GAMMA', author: suggestAuthor });
    await tick();

    const margin = mountMarkupMargin({
      editorEl: parent,
      view: editor.editor.view,
      getDeletions: () => [],
      threads: () => chrome.collectThreads(),
      chrome,
      getSuggestions: () => suggestOps.listSuggestions(ydoc),
      docId: 'd1',
      scope,
    });
    margin.relayout();

    const balloon = parent.querySelector('.lf-balloon.lf-balloon-suggestion') as HTMLElement;
    expect(balloon.querySelector('.lf-suggest-old')?.textContent).toBe('gamma');
    expect(balloon.querySelector('.lf-suggest-new')?.textContent).toBe('GAMMA');
    // Plain textContent, never innerHTML — a hostile author name/snippet
    // can't inject markup into the card.
    expect(balloon.innerHTML).not.toContain('<script');
  });

  it('Accept posts to the accept endpoint and removes the card', async () => {
    const { parent, editor, ydoc, chrome, scope } = mountPlainWithChrome('Alpha bravo gamma.\n');
    await tick();
    const res = suggestOps.suggestReplace(ydoc, {
      find: 'gamma',
      replace: 'GAMMA',
      author: suggestAuthor,
    });
    expect(res.ok).toBe(true);
    await tick();

    const margin = mountMarkupMargin({
      editorEl: parent,
      view: editor.editor.view,
      getDeletions: () => [],
      threads: () => chrome.collectThreads(),
      chrome,
      getSuggestions: () => suggestOps.listSuggestions(ydoc),
      docId: 'd1',
      scope,
    });
    margin.relayout();

    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true }) as unknown as Promise<Response>);
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const balloon = parent.querySelector('.lf-balloon-suggestion') as HTMLElement;
      const acceptBtn = balloon.querySelector('.lf-suggest-accept') as HTMLButtonElement;
      acceptBtn.click();
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining(`/api/docs/d1/suggestions/${res.ok ? res.sid : ''}/accept`),
        expect.objectContaining({ method: 'POST' }),
      );
      // Optimistically removed on click — doesn't wait for the round trip.
      expect(parent.querySelectorAll('.lf-balloon-suggestion')).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('handles a { ok:false, error:"not-found" } reject response gracefully — card removed, no crash', async () => {
    const { parent, editor, ydoc, chrome, scope } = mountPlainWithChrome('Alpha bravo gamma.\n');
    await tick();
    suggestOps.suggestReplace(ydoc, { find: 'gamma', replace: 'GAMMA', author: suggestAuthor });
    await tick();

    const margin = mountMarkupMargin({
      editorEl: parent,
      view: editor.editor.view,
      getDeletions: () => [],
      threads: () => chrome.collectThreads(),
      chrome,
      getSuggestions: () => suggestOps.listSuggestions(ydoc),
      docId: 'd1',
      scope,
    });
    margin.relayout();

    const fetchSpy = vi.fn(
      () =>
        Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({ error: 'not-found' }),
        }) as unknown as Promise<Response>,
    );
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const balloon = parent.querySelector('.lf-balloon-suggestion') as HTMLElement;
      const rejectBtn = balloon.querySelector('.lf-suggest-reject') as HTMLButtonElement;
      expect(() => rejectBtn.click()).not.toThrow();
      await tick();
      expect(parent.querySelectorAll('.lf-balloon-suggestion')).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never renders a balloon for a proposal with no docId (accept/reject would have nowhere to post)', async () => {
    const { parent, editor, ydoc, chrome, scope } = mountPlainWithChrome('Alpha bravo gamma.\n');
    await tick();
    suggestOps.suggestReplace(ydoc, { find: 'gamma', replace: 'GAMMA', author: suggestAuthor });
    await tick();

    const margin = mountMarkupMargin({
      editorEl: parent,
      view: editor.editor.view,
      getDeletions: () => [],
      threads: () => chrome.collectThreads(),
      chrome,
      getSuggestions: () => suggestOps.listSuggestions(ydoc),
      // docId omitted on purpose
      scope,
    });
    margin.relayout();

    expect(parent.querySelectorAll('.lf-balloon-suggestion')).toHaveLength(0);
  });
});

describe('mountMarkupMargin — mobile suggestion chip opens the sheet with the same card', () => {
  it('one chip per sid; tapping it opens the sheet with Accept/Reject; closing hides it', async () => {
    const { parent, editor, ydoc, chrome, scope } = mountPlainWithChrome('Alpha bravo gamma.\n');
    await tick();
    const res = suggestOps.suggestReplace(ydoc, {
      find: 'gamma',
      replace: 'GAMMA',
      author: suggestAuthor,
    });
    expect(res.ok).toBe(true);
    await tick();

    mountMarkupMargin({
      editorEl: parent,
      view: editor.editor.view,
      getDeletions: () => [],
      threads: () => chrome.collectThreads(),
      chrome,
      getSuggestions: () => suggestOps.listSuggestions(ydoc),
      docId: 'd1',
      scope,
    });

    // The chip is a real (base-schema) ProseMirror decoration, independent
    // of the margin's own relayout — same "mobile fallback always in the
    // DOM, CSS decides visibility" contract as .lf-del-chip.
    const chips = parent.querySelectorAll('.lf-suggest-chip');
    expect(chips).toHaveLength(1);
    const chip = chips[0] as HTMLElement;
    expect(chip.dataset.lfSuggestSid).toBe(res.ok ? res.sid : '');

    const sheet = document.querySelector('.lf-suggest-sheet') as HTMLElement;
    expect(sheet).not.toBeNull();
    expect(sheet.classList.contains('hidden')).toBe(true);

    chip.click();
    expect(sheet.classList.contains('hidden')).toBe(false);
    expect(sheet.getAttribute('aria-hidden')).toBe('false');
    expect(sheet.querySelector('.lf-suggest-old')?.textContent).toBe('gamma');
    expect(sheet.querySelector('.lf-suggest-new')?.textContent).toBe('GAMMA');
    expect(sheet.querySelector('.lf-suggest-accept')).not.toBeNull();
    expect(sheet.querySelector('.lf-suggest-reject')).not.toBeNull();

    (sheet.querySelector('.thread-view-close') as HTMLElement).click();
    expect(sheet.classList.contains('hidden')).toBe(true);
  });

  it('Reject from inside the sheet closes it', async () => {
    const { parent, editor, ydoc, chrome, scope } = mountPlainWithChrome('Alpha bravo gamma.\n');
    await tick();
    suggestOps.suggestReplace(ydoc, { find: 'gamma', replace: 'GAMMA', author: suggestAuthor });
    await tick();

    mountMarkupMargin({
      editorEl: parent,
      view: editor.editor.view,
      getDeletions: () => [],
      threads: () => chrome.collectThreads(),
      chrome,
      getSuggestions: () => suggestOps.listSuggestions(ydoc),
      docId: 'd1',
      scope,
    });

    const chip = parent.querySelector('.lf-suggest-chip') as HTMLElement;
    chip.click();
    const sheet = document.querySelector('.lf-suggest-sheet') as HTMLElement;
    expect(sheet.classList.contains('hidden')).toBe(false);

    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true }) as unknown as Promise<Response>);
    vi.stubGlobal('fetch', fetchSpy);
    try {
      (sheet.querySelector('.lf-suggest-reject') as HTMLButtonElement).click();
      expect(fetchSpy).toHaveBeenCalled();
      expect(sheet.classList.contains('hidden')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('mountMarkupMargin — suggestion chip mobile-only class / 430px', () => {
  it('the chip carries the SAME class the deletion chip uses to hide ≥1100px (`.lf-suggest-chip`, styles.css)', async () => {
    setViewportWidth(415); // 430px-class viewport
    const { parent, editor, ydoc, chrome, scope } = mountPlainWithChrome('Alpha bravo gamma.\n');
    await tick();
    suggestOps.suggestReplace(ydoc, { find: 'gamma', replace: 'GAMMA', author: suggestAuthor });
    await tick();
    mountMarkupMargin({
      editorEl: parent,
      view: editor.editor.view,
      getDeletions: () => [],
      threads: () => chrome.collectThreads(),
      chrome,
      getSuggestions: () => suggestOps.listSuggestions(ydoc),
      docId: 'd1',
      scope,
    });
    const chip = parent.querySelector('.lf-suggest-chip') as HTMLElement;
    expect(chip).not.toBeNull();
    // ProseMirror adds its own `ProseMirror-widget` class to a widget
    // decoration's root node alongside ours — assert containment, not
    // full equality.
    expect(chip.classList.contains('lf-suggest-chip')).toBe(true);
    // The chip decoration exists in the DOM at every width — same "always
    // rendered, CSS decides visibility" contract as `.lf-del-chip`
    // (live-markup.ts): styles.css, not this test, is what actually hides
    // the balloon column and reveals the chip ≤1100px.
  });
});
