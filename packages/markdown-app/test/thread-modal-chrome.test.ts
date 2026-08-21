import { type ReviewPayload, createThread, postReply } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { LONG_THREAD_WORDS } from '../src/long-thread.ts';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, type ReviewChrome, mountReviewChrome } from '../src/review-chrome.ts';
import type { ReviewSurface } from '../src/review-surface.ts';

/**
 * Which threads the chrome sends to the modal, and which it still expands in
 * place.
 *
 * The rule itself is unit-tested in `long-thread.test.ts`; what this covers is
 * the seam — that opening a thread consults it at all, that the width test
 * happens (a phone already opens a full-width inline card and must not get a
 * dialog on top of a sheet), and that closing the modal hands the selection
 * back so the anchor highlight and every other copy of the card fold with it.
 *
 * All fixtures synthetic.
 */

const bob = { id: 'u2', name: 'Bob', kind: 'known' as const, color: '#c0392b' };

/** happy-dom's viewport width drives `window.matchMedia`, which is the same
 *  1100px query the stylesheet uses. Default is 1024px — BELOW it — so any
 *  test about the desktop treatment has to widen it first. */
function setViewportWidth(w: number): void {
  (
    window as unknown as { happyDOM: { setInnerWidth: (w: number) => void } }
  ).happyDOM.setInnerWidth(w);
}

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

function opts(extra?: Partial<ChromeOpts>): ChromeOpts {
  return {
    docId: 'd1',
    user: { id: 'u', name: 'U', kind: 'known', color: '#000' },
    ydoc: new Y.Doc(),
    surface: fakeSurface(),
    whenSynced: (cb) => cb(),
    selectHint: '',
    reanchorHint: '',
    getSelection: () => null,
    scope: new MountScope(),
    ...extra,
  };
}

/** N words of synthetic prose — never a real quotation. */
function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
}

const decisionPayload: ReviewPayload = {
  shape: 'decision',
  headline: 'Pick a cache strategy',
  why: 'The rollout is blocked on it',
  options: [
    { id: 'a', label: 'Write through' },
    { id: 'b', label: 'Write behind' },
  ],
};

const scopes: MountScope[] = [];
function harness(firstComment: { text: string; review?: ReviewPayload }): {
  chrome: ReviewChrome;
  ydoc: Y.Doc;
} {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 200 })));
  mountChromeDom();
  const ydoc = new Y.Doc();
  createThread(ydoc, {
    threadId: 't1',
    anchor: { kind: 'element', fingerprint: 'x' as never, snippet: { text: 'the anchor' } },
    createdBy: bob,
    firstComment: { id: 'c1', ...firstComment },
  });
  const scope = new MountScope();
  scopes.push(scope);
  const chrome = mountReviewChrome(opts({ ydoc, scope }));
  chrome.redrawThreads();
  return { chrome, ydoc };
}

afterEach(() => {
  for (const s of scopes.splice(0)) s.dispose();
  setViewportWidth(1024);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const modalOpen = (): boolean => {
  const el = document.querySelector('.thread-modal');
  return el != null && !el.classList.contains('hidden');
};
const modalThreadId = (): string | null =>
  document.querySelector('.thread-modal-body .thread')?.getAttribute('data-thread-id') ?? null;

/** Tap the drawer's card the way a reader does. By id, never by position:
 *  the list sorts by activity, so "the first card" is whichever thread was
 *  touched last. */
function tapCard(id = 't1'): void {
  const card = document.querySelector(`#threads-list .thread[data-thread-id="${id}"]`);
  if (!card) throw new Error(`no card rendered in the drawer for ${id}`);
  card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('opening a thread on a desktop/tablet width', () => {
  it('expands a short one in place, as it always did', () => {
    setViewportWidth(1180);
    const { chrome } = harness({ text: 'Looks good to me' });
    tapCard();
    expect(modalOpen()).toBe(false);
    expect(chrome.threadsPanel.getActive()).toBe('t1');
  });

  it('sends a long one to the modal instead', () => {
    setViewportWidth(1180);
    harness({ text: words(LONG_THREAD_WORDS + 20) });
    tapCard();
    expect(modalOpen()).toBe(true);
    expect(modalThreadId()).toBe('t1');
  });

  it('sends a short decision to the modal too', () => {
    setViewportWidth(1180);
    harness({ text: 'Which one?', review: decisionPayload });
    tapCard();
    expect(modalOpen()).toBe(true);
  });

  it('still selects the thread, so the anchor highlight follows', () => {
    setViewportWidth(1180);
    const { chrome } = harness({ text: words(LONG_THREAD_WORDS + 20) });
    tapCard();
    expect(chrome.threadsPanel.getActive()).toBe('t1');
  });

  it('hands the selection back when the modal closes', () => {
    setViewportWidth(1180);
    const { chrome } = harness({ text: words(LONG_THREAD_WORDS + 20) });
    tapCard();
    (document.querySelector('.thread-modal-close') as HTMLElement).click();
    expect(modalOpen()).toBe(false);
    expect(chrome.threadsPanel.getActive()).toBe(null);
  });

  it('closes when another thread is selected out from under it', () => {
    setViewportWidth(1180);
    const { chrome, ydoc } = harness({ text: words(LONG_THREAD_WORDS + 20) });
    createThread(ydoc, {
      threadId: 't2',
      anchor: { kind: 'element', fingerprint: 'y' as never, snippet: { text: 'elsewhere' } },
      createdBy: bob,
      firstComment: { id: 'c9', text: 'a short one' },
    });
    chrome.redrawThreads();
    tapCard();
    expect(modalOpen()).toBe(true);
    chrome.threadsPanel.setActive('t2');
    expect(modalOpen()).toBe(false);
  });

  it('Escape closes the dialog and stops there, not the drawer under it', () => {
    setViewportWidth(1180);
    const { chrome } = harness({ text: words(LONG_THREAD_WORDS + 20) });
    chrome.openDrawer();
    const shell = document.getElementById('shell') as HTMLElement;
    expect(shell.classList.contains('threads-open')).toBe(true);
    tapCard();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(modalOpen()).toBe(false);
    // The chrome's own Escape handler is on `document` as well, so only
    // stopImmediatePropagation keeps one press from closing two layers.
    expect(shell.classList.contains('threads-open')).toBe(true);
  });

  it('follows the conversation while it is open', () => {
    setViewportWidth(1180);
    const { chrome, ydoc } = harness({ text: words(LONG_THREAD_WORDS + 20) });
    tapCard();
    postReply(ydoc, 't1', { id: 'c2', author: bob, text: 'and one more thing' });
    chrome.redrawThreads();
    expect(modalOpen()).toBe(true);
    expect(
      document.querySelectorAll('.thread-modal-body .comments .comment').length,
    ).toBeGreaterThan(0);
  });
});

describe('narrow viewports keep the surface they already have', () => {
  it('does not open the modal on a phone — the inline card and sheet own it', () => {
    setViewportWidth(430);
    const { chrome } = harness({ text: words(LONG_THREAD_WORDS + 20) });
    tapCard();
    expect(modalOpen()).toBe(false);
    expect(chrome.threadsPanel.getActive()).toBe('t1');
  });

  it('does not open the modal for a decision on a phone either', () => {
    setViewportWidth(430);
    harness({ text: 'Which one?', review: decisionPayload });
    tapCard();
    expect(modalOpen()).toBe(false);
  });

  it('closes an open modal when the viewport crosses down into the phone tier', () => {
    setViewportWidth(1180);
    harness({ text: words(LONG_THREAD_WORDS + 20) });
    tapCard();
    expect(modalOpen()).toBe(true);
    setViewportWidth(430);
    window.matchMedia('(max-width: 1100px)').dispatchEvent(new Event('change'));
    expect(modalOpen()).toBe(false);
  });
});

/**
 * Escape means the same thing whichever surface the thread opened on.
 *
 * The dialog took Escape from the day it shipped; an inline-expanded card
 * never had it, so the gesture that dismissed a thread depended on its word
 * count — under the threshold you had to find the caret, over it you could
 * press a key. Nothing about the card tells a reader which one they are
 * looking at.
 */
function pressEscape(): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
}

describe('Escape dismisses the thread, whatever it opened in', () => {
  it('collapses a card that expanded in place', () => {
    setViewportWidth(1180);
    const { chrome } = harness({ text: 'Looks good to me' });
    tapCard();
    expect(chrome.threadsPanel.getActive()).toBe('t1');
    pressEscape();
    expect(chrome.threadsPanel.getActive()).toBe(null);
  });

  it('still closes the dialog, and still leaves nothing selected', () => {
    setViewportWidth(1180);
    const { chrome } = harness({ text: words(LONG_THREAD_WORDS + 20) });
    tapCard();
    expect(modalOpen()).toBe(true);
    pressEscape();
    expect(modalOpen()).toBe(false);
    expect(chrome.threadsPanel.getActive()).toBe(null);
  });

  it('collapses the card before it closes the drawer, innermost first', () => {
    setViewportWidth(1180);
    const { chrome } = harness({ text: 'Looks good to me' });
    chrome.openDrawer();
    tapCard();
    pressEscape();
    expect(chrome.threadsPanel.getActive()).toBe(null);
    // One press, one layer. The drawer is still the reader's list.
    expect(document.getElementById('shell')?.classList.contains('threads-open')).toBe(true);
    pressEscape();
    expect(document.getElementById('shell')?.classList.contains('threads-open')).toBe(false);
  });

  // The control: with nothing expanded, Escape must still reach the drawer on
  // the first press rather than being swallowed by an empty selection.
  it('goes straight to the drawer when no card is expanded', () => {
    setViewportWidth(1180);
    const { chrome } = harness({ text: 'Looks good to me' });
    chrome.openDrawer();
    pressEscape();
    expect(document.getElementById('shell')?.classList.contains('threads-open')).toBe(false);
  });
});

/**
 * The floating mic and an open comment card want the same corner.
 *
 * Measured at 430px: `.voice-mic` is `position: fixed` bottom-left over the
 * document, and a thread at that width opens as a FULL-WIDTH inline card whose
 * reply box reaches the bottom-left too — so the 44px launcher sat on top of
 * the composer. It is bottom-left precisely to stay out of the deep-work path,
 * which holds on a wide screen and stops holding when the card is the width of
 * the viewport.
 *
 * The class carries the width test rather than the stylesheet repeating the
 * 1100px constant: a second copy of that number is exactly the drift this
 * project has already been bitten by.
 */
const micHidden = (): boolean => document.body.classList.contains('thread-card-open');

describe('the doc mic yields to an open card where they would overlap', () => {
  it('stands down while a card is open at phone width', () => {
    setViewportWidth(430);
    harness({ text: 'Looks good to me' });
    tapCard();
    expect(micHidden()).toBe(true);
  });

  it('comes back when the card folds', () => {
    setViewportWidth(430);
    const { chrome } = harness({ text: 'Looks good to me' });
    tapCard();
    chrome.threadsPanel.setActive(null);
    expect(micHidden()).toBe(false);
  });

  // The control: on a wide screen the card opens in a 300px column nowhere
  // near the corner, so taking the mic away would be a loss for nothing.
  it('keeps the mic on a desktop width, where nothing overlaps', () => {
    setViewportWidth(1180);
    harness({ text: 'Looks good to me' });
    tapCard();
    expect(micHidden()).toBe(false);
  });

  it('follows the viewport when it crosses the band with a card open', () => {
    setViewportWidth(1180);
    harness({ text: 'Looks good to me' });
    tapCard();
    expect(micHidden()).toBe(false);
    setViewportWidth(430);
    window.matchMedia('(max-width: 1100px)').dispatchEvent(new Event('change'));
    expect(micHidden()).toBe(true);
  });

  it('leaves nothing stuck on the document after the chrome goes away', () => {
    setViewportWidth(430);
    harness({ text: 'Looks good to me' });
    tapCard();
    expect(micHidden()).toBe(true);
    for (const s of scopes.splice(0)) s.dispose();
    expect(micHidden()).toBe(false);
  });
});
