import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, mountReviewChrome } from '../src/review-chrome.ts';
import type { ReviewSurface } from '../src/review-surface.ts';

/**
 * The doc's NEW-comment composer is a markdown field too.
 *
 * Design point 4 (approved design, review-flow-mock-v1) is "every composer is
 * a markdown editor", and `attachMarkdownField` had four call sites — the
 * thread reply and three in the hub — none of which was this one. It is the
 * primary way a reviewer starts a comment on a doc: select text, press the
 * pill, type. Comments RENDER markdown, so this was the one box that took
 * markdown without saying so and without showing what the words would become.
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
const field = () => document.querySelector<HTMLElement>('.composer-inner .md-field');
const preview = () => document.querySelector<HTMLElement>('.composer-inner .md-preview');

/** Type the way a person does: value plus the event the browser fires. */
function type(value: string): void {
  const ta = composerText();
  ta.value = value;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('the doc’s new-comment composer', () => {
  it('says it speaks markdown, beside the cheat sheet', () => {
    mount();
    expect(field()).not.toBeNull();
    expect(field()?.querySelector('.md-affordance .md-badge')?.textContent).toBe('Markdown');
    expect(field()?.querySelector('.md-affordance .md-hint')?.textContent).toContain('**bold**');
  });

  it('keeps the textarea in the composer row — attaching decorates, it does not move', () => {
    mount();
    expect(composerText().closest('.composer-inner')).not.toBeNull();
    expect(composerText().parentElement?.className).toBe('md-field');
  });

  it('stays one control tall until something is typed, then previews it', () => {
    mount();
    expect(preview()?.hidden).toBe(true);
    type('**two hops**');
    expect(preview()?.hidden).toBe(false);
    expect(preview()?.innerHTML).toContain('<strong>two hops</strong>');
    type('');
    expect(preview()?.hidden).toBe(true);
  });

  it('clears the preview when the composer reopens on an empty box', () => {
    // `openComposer` empties the textarea programmatically, which fires no
    // input event — without the refresh the last comment's preview would sit
    // under a blank box.
    const chrome = mount();
    type('left over from **last** time');
    expect(preview()?.hidden).toBe(false);
    chrome.openComposer();
    expect(composerText().value).toBe('');
    expect(preview()?.hidden).toBe(true);
  });

  it('attaches exactly once across a navigation — the composer is shell DOM', () => {
    // mountReviewChrome runs per document; #composer does not. A second
    // attach would wrap the wrapper and stack a second affordance row and a
    // second preview under every composer.
    mountChromeDom();
    mountReviewChrome(opts());
    mountReviewChrome(opts());
    expect(document.querySelectorAll('.composer-inner .md-affordance')).toHaveLength(1);
    expect(document.querySelectorAll('.composer-inner .md-preview')).toHaveLength(1);
    expect(document.querySelectorAll('.composer-inner .md-field')).toHaveLength(1);
    // Still live after the second mount, not orphaned by it.
    type('**still** wired');
    expect(preview()?.hidden).toBe(false);
    expect(preview()?.innerHTML).toContain('<strong>still</strong>');
  });
});
