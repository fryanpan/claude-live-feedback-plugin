import { createThread } from '@feedback/core';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, initialDrawerOpen, mountReviewChrome } from '../src/review-chrome.ts';
import type { ReviewSurface } from '../src/review-surface.ts';
import { sizeThreadSlots } from '../src/thread-morph.ts';

describe('initialDrawerOpen', () => {
  it('never opens on mobile', () => {
    expect(initialDrawerOpen({ isDesktop: false, marginVisible: false, stored: null })).toBe(false);
    expect(initialDrawerOpen({ isDesktop: false, marginVisible: false, stored: 'open' })).toBe(
      false,
    );
  });

  it('opens on desktop when no balloon margin is visible (code surface, 901–1100px)', () => {
    expect(initialDrawerOpen({ isDesktop: true, marginVisible: false, stored: null })).toBe(true);
  });

  it('stays closed on desktop when balloons already show the threads', () => {
    expect(initialDrawerOpen({ isDesktop: true, marginVisible: true, stored: null })).toBe(false);
  });

  it('an explicit user toggle overrides the balloon default in both directions', () => {
    expect(initialDrawerOpen({ isDesktop: true, marginVisible: true, stored: 'open' })).toBe(true);
    expect(initialDrawerOpen({ isDesktop: true, marginVisible: false, stored: 'closed' })).toBe(
      false,
    );
  });

  it('ignores garbage stored values', () => {
    expect(initialDrawerOpen({ isDesktop: true, marginVisible: true, stored: 'weird' })).toBe(
      false,
    );
    expect(initialDrawerOpen({ isDesktop: true, marginVisible: false, stored: 'weird' })).toBe(
      true,
    );
  });
});

// --- mount-level behaviour ----------------------------------------------------
// The pure function above decides; these assert the mount actually APPLIES the
// decision to the shell (the original ship of this feature toggled a class no
// desktop CSS read — a pure-function test alone can't catch that layer).

function mountChromeDom(): void {
  document.body.innerHTML = `
    <div id="shell">
      <main id="main">
        <aside id="set-pane"></aside>
        <section id="editor-pane"><div id="editor"></div></section>
        <aside id="threads-pane">
          <div class="threads-tabs">
            <button class="tab active" data-tab="open">Open</button>
            <button class="tab" data-tab="resolved">Resolved</button>
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

function opts(scope: MountScope, extra?: Partial<ChromeOpts>): ChromeOpts {
  return {
    docId: 'd1',
    user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
    ydoc: new Y.Doc(),
    surface: fakeSurface(),
    selectHint: '',
    reanchorHint: '',
    getSelection: () => null,
    scope,
    ...extra,
  };
}

function setViewportWidth(w: number): void {
  (
    window as unknown as { happyDOM: { setInnerWidth: (w: number) => void } }
  ).happyDOM.setInnerWidth(w);
}

const shellOpen = () =>
  (document.getElementById('shell') as HTMLElement).classList.contains('threads-open');

describe('mountReviewChrome drawer default', () => {
  afterEach(() => {
    setViewportWidth(1024);
    sessionStorage.removeItem('lf:drawer');
  });

  it('defaults CLOSED at balloon widths when the surface has a margin', () => {
    setViewportWidth(1400);
    mountChromeDom();
    mountReviewChrome(opts(new MountScope(), { hasBalloonMargin: true }));
    expect(shellOpen()).toBe(false);
  });

  it('defaults OPEN at balloon widths when the surface has no margin (code)', () => {
    setViewportWidth(1400);
    mountChromeDom();
    mountReviewChrome(opts(new MountScope()));
    expect(shellOpen()).toBe(true);
  });

  it('defaults OPEN at 901–1100px even with a margin surface (margin collapsed)', () => {
    setViewportWidth(1000);
    mountChromeDom();
    mountReviewChrome(opts(new MountScope(), { hasBalloonMargin: true }));
    expect(shellOpen()).toBe(true);
  });

  it('a session preference overrides the balloon default, and toggling stores it', () => {
    setViewportWidth(1400);
    mountChromeDom();
    mountReviewChrome(opts(new MountScope(), { hasBalloonMargin: true }));
    expect(shellOpen()).toBe(false);

    // User opens the drawer — preference stored, next mount starts open.
    (document.getElementById('toggle-threads') as HTMLElement).click();
    expect(shellOpen()).toBe(true);
    expect(sessionStorage.getItem('lf:drawer')).toBe('open');

    mountChromeDom();
    mountReviewChrome(opts(new MountScope(), { hasBalloonMargin: true }));
    expect(shellOpen()).toBe(true);
  });

  it('closes a drawer left open by the previous doc when the default is closed', () => {
    setViewportWidth(1400);
    mountChromeDom();
    (document.getElementById('shell') as HTMLElement).classList.add('threads-open');
    mountReviewChrome(opts(new MountScope(), { hasBalloonMargin: true }));
    expect(shellOpen()).toBe(false);
  });

  /* The card's folding slots have no intrinsic height — the morph engine
     measures the showing face and writes it. A drawer that defaults CLOSED is
     `display: none` on desktop (styles.css, `#shell:not(.threads-open)
     #threads-pane`), so every card rendered into it while it was closed
     measured zero. Opening the drawer only flips a class: unless it also
     re-measures, the drawer opens showing an author row and a ✓ Resolve with
     nothing at all in between. */
  it('re-measures the cards when the drawer opens (they were rendered hidden)', () => {
    setViewportWidth(1400);
    mountChromeDom();
    const ydoc = new Y.Doc();
    createThread(ydoc, {
      threadId: 't1',
      anchor: { kind: 'element', fingerprint: 'x' as never, snippet: { text: 'the anchor' } },
      createdBy: { id: 'u2', name: 'Bob', kind: 'known', color: '#c0392b' },
      firstComment: { id: 'c1', text: 'Please clarify this.' },
    });
    const chrome = mountReviewChrome(opts(new MountScope(), { ydoc, hasBalloonMargin: true }));
    expect(shellOpen()).toBe(false);
    chrome.redrawThreads();

    const card = document.querySelector('#threads-list .thread') as HTMLElement;
    expect(card).not.toBeNull(); // positive control: there IS a card to measure
    const slots = Array.from(card.querySelectorAll<HTMLElement>('.thread-slot'));
    expect(slots).toHaveLength(2);

    // Stand in for the layout happy-dom doesn't have: a subtree inside a
    // `display: none` pane measures 0, and measures for real once it isn't.
    const shell = document.getElementById('shell') as HTMLElement;
    for (const face of Array.from(card.querySelectorAll<HTMLElement>('.thread-face'))) {
      Object.defineProperty(face, 'offsetHeight', {
        configurable: true,
        get: () => (shell.classList.contains('threads-open') ? 24 : 0),
      });
    }
    // Measure it while the pane is closed — directly, because a second
    // `redrawThreads()` short-circuits on an unchanged render key and would
    // never reach the measurement at all, leaving the assertion below true
    // for the wrong reason.
    sizeThreadSlots(document);
    // Nothing believable was measurable while it was closed, so nothing was
    // written: a slot pinned to `0px` here would survive the class flip and
    // open the drawer on a card clipped to its head and its foot.
    for (const s of slots) expect(s.style.height).toBe('');

    chrome.openDrawer();
    for (const s of slots) expect(s.style.height).toBe('24px');
  });
});
