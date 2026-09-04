import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { isComposerFocused } from '../src/md-composer.ts';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, mountReviewChrome } from '../src/review-chrome.ts';
import type { ReviewSurface } from '../src/review-surface.ts';

/**
 * Opening the composer schedules the caret 30ms out, so iOS's
 * auto-scroll-to-focus doesn't yank the page. That timer used to be able to
 * outlive what it was aimed at: a test file that opened a composer and
 * finished inside those 30ms had the focus land after vitest deleted the
 * environment's globals, where Tiptap's focus command reaches for a
 * `requestAnimationFrame` that is no longer defined. A run in which all 310
 * files passed still failed, on one unhandled `ReferenceError` naming nothing
 * a person could act on.
 *
 * Two things had to be true, and there is a test for each. The timer is
 * cancelled when the composer goes away, so nothing is pending to land — that
 * is also the behaviour a reader wants, since a dismissed composer taking the
 * caret is a bug on its own. And the focus itself declines to run where there
 * is no `requestAnimationFrame`, so the next stray timer from anywhere fails
 * quietly instead of failing the run.
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

function opts(scope: MountScope): ChromeOpts {
  return {
    docId: 'd1',
    user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
    ydoc: new Y.Doc(),
    surface: fakeSurface(),
    whenSynced: (cb) => cb(),
    canWrite: true,
    selectHint: 'Select some text first',
    reanchorHint: '',
    getSelection: () => ({
      start: new Uint8Array([1]),
      end: new Uint8Array([2]),
      snippet: 'the anchored words',
    }),
    scope,
  };
}

function harness() {
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
  mountChromeDom();
  const scope = new MountScope();
  return { scope, chrome: mountReviewChrome(opts(scope)) };
}

const composerText = () => document.getElementById('composer-text') as HTMLTextAreaElement;

/** The global Tiptap's focus command reaches for, gone the way a torn-down
 *  test environment takes it. */
function removeAnimationFrame(): void {
  vi.stubGlobal('requestAnimationFrame', undefined);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('the composer’s delayed focus cannot outlive the composer', () => {
  it('a composer dismissed before the 30ms focus lands never takes the caret', () => {
    vi.useFakeTimers();
    const { chrome } = harness();
    chrome.openComposer();
    chrome.hideComposer();
    vi.advanceTimersByTime(200);
    expect(isComposerFocused(composerText())).toBe(false);
  });

  it('a disposed mount never takes the caret', () => {
    vi.useFakeTimers();
    const { chrome, scope } = harness();
    chrome.openComposer();
    scope.dispose();
    vi.advanceTimersByTime(200);
    expect(isComposerFocused(composerText())).toBe(false);
  });

  it('a focus that lands where there is no requestAnimationFrame does not throw', () => {
    vi.useFakeTimers();
    const { chrome } = harness();
    chrome.openComposer();
    removeAnimationFrame();
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
  });

  it('positive control: a composer left open still gets the caret', () => {
    vi.useFakeTimers();
    const { chrome } = harness();
    expect(isComposerFocused(composerText())).toBe(false);
    chrome.openComposer();
    vi.advanceTimersByTime(200);
    expect(isComposerFocused(composerText())).toBe(true);
  });
});
