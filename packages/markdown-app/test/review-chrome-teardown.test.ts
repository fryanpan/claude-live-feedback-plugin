import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, mountReviewChrome } from '../src/review-chrome.ts';
import type { ReviewSurface } from '../src/review-surface.ts';

// Minimal DOM skeleton with every element id mountReviewChrome's el<T>() calls
// require, plus the shell/panes it reads via getElementById.
function mountChromeDom(): void {
  document.body.innerHTML = `
    <div id="shell">
      <aside id="set-pane"></aside>
      <main id="editor-pane"></main>
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

function opts(scope: MountScope, docId = 'd1'): ChromeOpts {
  return {
    docId,
    user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
    ydoc: new Y.Doc(),
    surface: fakeSurface(),
    // Fire immediately: these mounts assert against threads that are already
    // present, so they are testing the post-sync world.
    whenSynced: (cb) => cb(),
    selectHint: '',
    reanchorHint: '',
    getSelection: () => null,
    scope,
  };
}

const toggle = () => document.getElementById('toggle-threads') as HTMLButtonElement;
const isOpen = () =>
  (document.getElementById('shell') as HTMLElement).classList.contains('threads-open');
const clickToggle = () =>
  toggle().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

describe('mountReviewChrome teardown', () => {
  beforeEach(() => mountChromeDom());

  it('stops handling the drawer toggle after the scope is disposed', () => {
    const scope = new MountScope();
    mountReviewChrome(opts(scope));
    const s0 = isOpen();
    clickToggle();
    expect(isOpen()).toBe(!s0); // sanity: the click toggled the drawer pre-dispose

    scope.dispose();
    const before = isOpen();
    clickToggle();
    expect(isOpen()).toBe(before); // listener gone — no further toggle
  });

  it('destroy() empties the threads list so the next mount starts clean', () => {
    const scope = new MountScope();
    const chrome = mountReviewChrome(opts(scope));
    (document.getElementById('threads-list') as HTMLElement).innerHTML = '<li>stale</li>';
    chrome.destroy();
    expect((document.getElementById('threads-list') as HTMLElement).innerHTML).toBe('');
  });

  it('does not double-bind across a dispose + remount (single click toggles once)', () => {
    // Simulate navigation: mount doc A, dispose it, mount doc B on the same
    // persistent shell elements. A leaked toggle listener from A would fire
    // alongside B's, so one click would toggle twice (net no change).
    const a = new MountScope();
    mountReviewChrome(opts(a, 'a'));
    a.dispose();

    const b = new MountScope();
    mountReviewChrome(opts(b, 'b'));
    const before = isOpen();
    clickToggle();
    expect(isOpen()).toBe(!before); // exactly one toggle, not two
  });

  it('does not append a second resize handle on remount', () => {
    const a = new MountScope();
    mountReviewChrome(opts(a, 'a'));
    a.dispose();
    const b = new MountScope();
    mountReviewChrome(opts(b, 'b'));
    const pane = document.getElementById('threads-pane') as HTMLElement;
    expect(pane.querySelectorAll('.threads-resize').length).toBe(1);
  });
});
