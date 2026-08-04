import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, mountReviewChrome, wireThreadRangeClicks } from '../src/review-chrome.ts';
import type { ReviewSurface } from '../src/review-surface.ts';

/**
 * wireThreadRangeClicks: the shared "click a highlighted range in the
 * editor, focus its thread" wiring used by BOTH the plain markdown mount and
 * the redline mount (redline had no equivalent before this commit). One
 * implementation so the balloon-aware behaviour can't drift between them.
 */

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

function fakeSurface(pulseRange = vi.fn()): ReviewSurface {
  return {
    getSelectionRel: () => null,
    resolveRel: () => null,
    scrollToPos: () => {},
    pulseRange,
    setThreadRanges: () => {},
    destroy: () => {},
  };
}

function opts(scope: MountScope, docId = 'd1'): ChromeOpts {
  return {
    docId,
    user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
    ydoc: new Y.Doc(),
    surface: fakeSurface(),
    selectHint: '',
    reanchorHint: '',
    getSelection: () => null,
    scope,
  };
}

function clickSpan(span: Element): void {
  span.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

const isOpen = () =>
  (document.getElementById('shell') as HTMLElement).classList.contains('threads-open');

describe('wireThreadRangeClicks', () => {
  it('ignores clicks that are not on a .thread-range span', () => {
    mountChromeDom();
    const scope = new MountScope();
    const chrome = mountReviewChrome(opts(scope));
    chrome.closeDrawer();
    const editorMount = document.getElementById('editor') as HTMLElement;
    editorMount.innerHTML = '<p>no highlight here</p>';
    wireThreadRangeClicks({ editorMount, chrome, surface: fakeSurface(), scope });

    clickSpan(editorMount.querySelector('p') as Element);
    expect(isOpen()).toBe(false);
  });

  it('opens the drawer and pulses the range when no balloon claims the click', () => {
    mountChromeDom();
    const scope = new MountScope();
    const chrome = mountReviewChrome(opts(scope));
    chrome.closeDrawer();
    const editorMount = document.getElementById('editor') as HTMLElement;
    editorMount.innerHTML = '<span class="thread-range" data-thread-id="t1">hi</span>';
    const pulseRange = vi.fn();
    wireThreadRangeClicks({ editorMount, chrome, surface: fakeSurface(pulseRange), scope });

    clickSpan(editorMount.querySelector('.thread-range') as Element);
    expect(isOpen()).toBe(true); // fell back to the drawer
  });

  it('skips the drawer fallback when revealBalloon handles the thread', () => {
    mountChromeDom();
    const scope = new MountScope();
    const chrome = mountReviewChrome(opts(scope));
    chrome.closeDrawer();
    const editorMount = document.getElementById('editor') as HTMLElement;
    editorMount.innerHTML = '<span class="thread-range" data-thread-id="t1">hi</span>';
    const revealBalloon = vi.fn(() => true);
    wireThreadRangeClicks({
      editorMount,
      chrome,
      surface: fakeSurface(),
      scope,
      revealBalloon,
    });

    clickSpan(editorMount.querySelector('.thread-range') as Element);
    expect(revealBalloon).toHaveBeenCalledWith('t1');
    expect(isOpen()).toBe(false); // the balloon handled it — no drawer fallback
  });

  it('falls back to the drawer when revealBalloon declines (e.g. the thread has no balloon)', () => {
    mountChromeDom();
    const scope = new MountScope();
    const chrome = mountReviewChrome(opts(scope));
    chrome.closeDrawer();
    const editorMount = document.getElementById('editor') as HTMLElement;
    editorMount.innerHTML = '<span class="thread-range" data-thread-id="t1">hi</span>';
    const revealBalloon = vi.fn(() => false);
    wireThreadRangeClicks({
      editorMount,
      chrome,
      surface: fakeSurface(),
      scope,
      revealBalloon,
    });

    clickSpan(editorMount.querySelector('.thread-range') as Element);
    expect(revealBalloon).toHaveBeenCalledWith('t1');
    expect(isOpen()).toBe(true);
  });

  it('stops handling clicks once the scope is disposed', () => {
    mountChromeDom();
    const scope = new MountScope();
    const chrome = mountReviewChrome(opts(scope));
    chrome.closeDrawer();
    const editorMount = document.getElementById('editor') as HTMLElement;
    editorMount.innerHTML = '<span class="thread-range" data-thread-id="t1">hi</span>';
    wireThreadRangeClicks({ editorMount, chrome, surface: fakeSurface(), scope });

    scope.dispose();
    clickSpan(editorMount.querySelector('.thread-range') as Element);
    expect(isOpen()).toBe(false);
  });
});
