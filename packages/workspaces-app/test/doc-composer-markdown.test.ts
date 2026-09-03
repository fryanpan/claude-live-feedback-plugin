import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { refreshMarkdownComposer } from '../src/md-composer.ts';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, mountReviewChrome } from '../src/review-chrome.ts';
import type { ReviewSurface } from '../src/review-surface.ts';
import { renderedHtml, surfaceOf } from './support/composer.ts';

/**
 * The doc's NEW-comment composer is a markdown editor too.
 *
 * Design point 4 (approved design, review-flow-mock-v1) is "every composer is
 * a markdown editor", and this is the one a reviewer reaches first: select
 * text, press the pill, type. Comments RENDER markdown, so the box they are
 * typed into edits it live.
 *
 * `#composer` is SHELL-level DOM, outliving every document, while
 * `mountReviewChrome` runs once per navigation — so "attach it" also has to
 * mean "attach it once".
 */

function mountChromeDom(): void {
  document.body.innerHTML = `
    <div id="shell">
      <main id="main">
        <section id="editor-pane"><div id="editor"></div></section>
        <aside id="threads-pane">
          <div class="threads-tabs">
            <button class="tab active" data-tab="open">Open</button>
          </div>
          <ol id="threads-list"></ol>
        </aside>
      </main>
      <button id="toggle-threads">☰</button>
      <span id="threads-count"></span>
      <button id="close-threads">×</button>
      <div id="threads-scrim"></div>
      <div id="doc-title"></div>
      <div id="composer" class="hidden">
        <div id="composer-quote" class="composer-quote"></div>
        <div class="composer-inner">
          <div id="composer-avatar" class="composer-avatar"></div>
          <textarea id="composer-text" placeholder="Add a comment…" rows="1"></textarea>
          <button id="composer-submit" class="submit-arrow">↑</button>
        </div>
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

function fakeSurface(): ReviewSurface {
  return {
    getSelectionRel: () => null,
    resolveRel: () => null,
    scrollToPos: () => {},
    pulseRange: () => {},
    setThreadRanges: () => {},
    destroy: () => {},
  };
}

/** A selection is what the composer refuses to open without. */
const selection = () => ({
  start: new Uint8Array([1]),
  end: new Uint8Array([2]),
  snippet: 'the anchored words',
});

function opts(extra?: Partial<ChromeOpts>): ChromeOpts {
  return {
    docId: 'd1',
    user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
    ydoc: new Y.Doc(),
    surface: fakeSurface(),
    whenSynced: (cb) => cb(),
    selectHint: 'Select some text first',
    reanchorHint: '',
    getSelection: () => selection(),
    scope: new MountScope(),
    ...extra,
  };
}

function mount() {
  mountChromeDom();
  return mountReviewChrome(opts());
}

const composerText = () => document.getElementById('composer-text') as HTMLTextAreaElement;
const field = () => document.querySelector<HTMLElement>('.composer-inner .md-composer');

/** Put words in the box the way the app does — value, then the editor. */
function type(value: string): void {
  const ta = composerText();
  ta.value = value;
  refreshMarkdownComposer(ta);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('the doc’s new-comment composer', () => {
  it('is a live markdown editor, not a box that takes markdown silently', () => {
    mount();
    expect(field()).not.toBeNull();
    expect(surfaceOf(composerText())?.querySelector('.ProseMirror')).not.toBeNull();
    type('**two hops**');
    expect(renderedHtml(composerText())).toContain('<strong>two hops</strong>');
  });

  it('keeps the textarea in the composer row — attaching decorates, it does not move', () => {
    mount();
    expect(composerText().closest('.composer-inner')).not.toBeNull();
    expect(composerText().parentElement?.className).toBe('md-composer md-composer-live');
  });

  it('opens empty on a new comment, not holding the last one', () => {
    // `openComposer` empties the textarea programmatically, which the editor
    // cannot see — without the refresh the previous comment sits in the box
    // the reviewer just opened for a new one.
    const chrome = mount();
    type('left over from **last** time');
    expect(renderedHtml(composerText())).toContain('<strong>last</strong>');
    chrome.openComposer();
    expect(composerText().value).toBe('');
    expect(renderedHtml(composerText())).not.toContain('last');
  });

  it('attaches exactly once across a navigation — the composer is shell DOM', () => {
    // mountReviewChrome runs per document; #composer does not. A second
    // attach would wrap the wrapper and stack a second editor under one box.
    mountChromeDom();
    mountReviewChrome(opts());
    mountReviewChrome(opts());
    expect(document.querySelectorAll('.composer-inner .md-composer')).toHaveLength(1);
    expect(document.querySelectorAll('.composer-inner .md-composer-surface')).toHaveLength(1);
    // Still live after the second mount, not orphaned by it.
    type('**still** wired');
    expect(renderedHtml(composerText())).toContain('<strong>still</strong>');
  });
});
