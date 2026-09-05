import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import * as realChunk from '../src/md-composer-chunk.ts';
import {
  attachMarkdownComposer,
  focusMarkdownComposer,
  isComposerFocused,
  setComposerEditorLoader,
} from '../src/md-composer.ts';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, mountReviewChrome } from '../src/review-chrome.ts';
import type { ReviewSurface } from '../src/review-surface.ts';

/**
 * The composer's caret cannot outlive the composer.
 *
 * It used to be scheduled 30ms after the composer opened, and that timer
 * could outlive what it was aimed at: a test file that opened a composer and
 * finished inside those 30ms had the focus land after vitest deleted the
 * environment's globals, where Tiptap's focus command reaches for a
 * `requestAnimationFrame` that is no longer defined. A run in which all 310
 * files passed still failed, on one unhandled `ReferenceError` naming nothing
 * a person could act on.
 *
 * THE TIMER IS GONE (2026-09-04): the focus is synchronous inside
 * `openComposer`, because iOS raises the keyboard only for a focus that
 * happens inside the gesture that asked for it and a caret 30ms behind the
 * tap cost the reader a second one. That removes the hazard structurally —
 * there is no longer anything scheduled that could land anywhere. So this
 * file no longer proves the cancellation; it proves the two things the
 * cancellation was buying, which are still true and are now somebody's job:
 * a dismissed or torn-down composer gives the caret BACK (`hideComposer`
 * blurs, and the mount's cleanup closes the composer), and a focus that
 * reaches a page with no `requestAnimationFrame` still declines to run.
 *
 * That the focus lands in the click's own tick is asserted in
 * `pill-comment-focus.test.ts`, on the pill that asks for it.
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
  setComposerEditorLoader(null);
  document.body.innerHTML = '';
});

describe('a composer that goes away gives the caret back', () => {
  it('positive control: a composer left open ends up with the caret', () => {
    vi.useFakeTimers();
    const { chrome } = harness();
    expect(isComposerFocused(composerText())).toBe(false);
    chrome.openComposer();
    // The composer's own focus is synchronous now, but the editor is LIVE in
    // this file — importing the chunk at the top makes vitest hand it back
    // without a promise — and Tiptap moves the DOM focus into a frame for
    // every user agent that is not iOS, iPadOS or Safari. happy-dom is none
    // of them, so the caret lands one frame out here and the advance below
    // is that frame, not a timer of ours. `pill-comment-focus.test.ts` is
    // where the same-tick claim is asserted, against a composer whose chunk
    // has not landed yet.
    vi.advanceTimersByTime(200);
    expect(isComposerFocused(composerText())).toBe(true);
  });

  it('a dismissed composer does not keep swallowing what is typed next', () => {
    vi.useFakeTimers();
    const { chrome } = harness();
    chrome.openComposer();
    chrome.hideComposer();
    expect(isComposerFocused(composerText())).toBe(false);
    vi.advanceTimersByTime(200);
    expect(isComposerFocused(composerText())).toBe(false);
  });

  it('a disposed mount leaves no open composer wired to the document it left', () => {
    vi.useFakeTimers();
    const { chrome, scope } = harness();
    chrome.openComposer();
    scope.dispose();
    // `#composer` is shell DOM and outlives the mount, so "closed" is the
    // only state that cannot post a comment to the previous docId.
    expect(document.getElementById('composer')?.classList.contains('hidden')).toBe(true);
    expect(isComposerFocused(composerText())).toBe(false);
    vi.advanceTimersByTime(200);
    expect(isComposerFocused(composerText())).toBe(false);
  });
});

describe('the focus itself', () => {
  it('declines to run where there is no requestAnimationFrame, rather than throwing', () => {
    // Driven against a LIVE editor, which is the only surface that reaches
    // the guard: the plain textarea's `focus()` needs no frame. The guard
    // used to be reached through the composer's 30ms timer, which is gone.
    setComposerEditorLoader(() => realChunk);
    const ta = document.createElement('textarea');
    document.body.append(ta);
    attachMarkdownComposer(ta);
    removeAnimationFrame();
    expect(() => focusMarkdownComposer(ta, null, { scroll: false })).not.toThrow();
  });
});
