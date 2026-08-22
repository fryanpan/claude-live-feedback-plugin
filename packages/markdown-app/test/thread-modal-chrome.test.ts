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
 * The mic and an open comment card no longer want the same corner.
 *
 * They used to. `.voice-mic` was `position: fixed` bottom-left over the
 * document, and a thread at ≤1100px opens as a FULL-WIDTH inline card whose
 * reply box reaches that corner too, so the 44px launcher sat on the composer.
 * The chrome answered by putting `body.thread-card-open` on the document
 * whenever a card was open in that band, and the stylesheet hid the mic.
 *
 * The mic is docked in the topbar now (`.doc-nav-dock`), which no card can
 * reach — so the class described a collision that cannot happen, and its only
 * remaining effect was to take voice away from a reader mid-conversation. The
 * chrome sets nothing; these assert that it stays that way, because a
 * reappearing stand-down would be invisible from the outside.
 */
const micHidden = (): boolean => document.body.classList.contains('thread-card-open');

describe('the doc mic stays put while a card is open', () => {
  it('keeps the mic at phone width, where the card is full-width', () => {
    setViewportWidth(430);
    harness({ text: 'Looks good to me' });
    tapCard();
    expect(micHidden()).toBe(false);
  });

  it('keeps the mic on a desktop width too', () => {
    setViewportWidth(1180);
    harness({ text: 'Looks good to me' });
    tapCard();
    expect(micHidden()).toBe(false);
  });

  it('does not start hiding it when the viewport crosses the band', () => {
    // Page zoom moves a reviewer across this line, so the transition is real
    // rather than hypothetical — it is what used to make the mic vanish
    // mid-sentence.
    setViewportWidth(1180);
    harness({ text: 'Looks good to me' });
    tapCard();
    setViewportWidth(430);
    window.matchMedia('(max-width: 1100px)').dispatchEvent(new Event('change'));
    expect(micHidden()).toBe(false);
  });

  // Positive control: the harness really does open a card, so the assertions
  // above are measuring a state rather than an inert page.
  it('really has a card open when it says so', () => {
    setViewportWidth(430);
    const { chrome } = harness({ text: 'Looks good to me' });
    tapCard();
    expect(chrome.threadsPanel.getActive()).not.toBeNull();
  });
});

/**
 * One conversation, rendered once.
 *
 * The panel's selection used to mean two things at once — this thread is
 * chosen, and this thread's card is unfolded — and the modal made that wrong:
 * the same conversation rendered in the dialog, again in the margin balloon it
 * came out of, and again in the drawer row, all dimmed under the scrim but all
 * still there to be scrolled past.
 */
function harness2(): { chrome: ReviewChrome; ydoc: Y.Doc } {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 200 })));
  mountChromeDom();
  const ydoc = new Y.Doc();
  for (const [id, text] of [
    ['t1', words(LONG_THREAD_WORDS + 20)],
    ['t2', words(LONG_THREAD_WORDS + 20)],
  ] as const) {
    createThread(ydoc, {
      threadId: id,
      anchor: { kind: 'element', fingerprint: 'x' as never, snippet: { text: `anchor ${id}` } },
      createdBy: bob,
      firstComment: { id: `c-${id}`, text },
    });
  }
  const scope = new MountScope();
  scopes.push(scope);
  const chrome = mountReviewChrome(opts({ ydoc, scope }));
  chrome.redrawThreads();
  return { chrome, ydoc };
}

/** Every copy of a thread's card OUTSIDE the dialog. */
function cardsBehind(id: string): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(`.thread[data-thread-id="${id}"]`),
  ).filter((el) => el.closest('.thread-modal') === null);
}

describe('the dialog does not repeat what is behind it', () => {
  it('leaves the copies behind the scrim folded', () => {
    setViewportWidth(1180);
    harness({ text: words(LONG_THREAD_WORDS + 20) });
    tapCard();
    expect(modalOpen()).toBe(true);
    const behind = cardsBehind('t1');
    // The control first: there IS a copy behind, so the assertion below is
    // about its state rather than about an empty list.
    expect(behind.length).toBeGreaterThan(0);
    for (const el of behind) expect(el.classList.contains('expanded')).toBe(false);
  });

  it('still marks them selected, which is what lights the anchor', () => {
    setViewportWidth(1180);
    harness({ text: words(LONG_THREAD_WORDS + 20) });
    tapCard();
    for (const el of cardsBehind('t1')) expect(el.classList.contains('active')).toBe(true);
  });

  // The control: a thread that expands IN PLACE must keep doing exactly that.
  it('still expands a short thread in the column, as it always did', () => {
    setViewportWidth(1180);
    harness({ text: 'Looks good to me' });
    tapCard();
    const behind = cardsBehind('t1');
    expect(behind.length).toBeGreaterThan(0);
    expect(behind.some((el) => el.classList.contains('expanded'))).toBe(true);
  });

  it('hands the expansion back when the dialog closes', () => {
    setViewportWidth(1180);
    const { chrome } = harness({ text: words(LONG_THREAD_WORDS + 20) });
    tapCard();
    pressEscape();
    expect(modalOpen()).toBe(false);
    expect(chrome.threadsPanel.getActive()).toBe(null);
    // Re-opening has to work a second time — the state the dialog took must
    // have been given back, not merely dropped.
    tapCard();
    expect(modalOpen()).toBe(true);
    expect(modalThreadId()).toBe('t1');
  });
});

/**
 * Clicking another thread while the dialog is up.
 *
 * The click is not a miss — it lands exactly where it was aimed, on a scrim
 * covering the card. Reading the stack UNDER the point is what turns it into
 * what the reader meant by it.
 */
function clickScrimOver(card: Element | null): void {
  const stack = card ? [card] : [];
  (
    document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }
  ).elementsFromPoint = () => stack;
  document
    .querySelector('.thread-modal-scrim')
    ?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
    );
}

describe('switching threads takes one click, not two', () => {
  it('opens the thread whose card was under the click', () => {
    setViewportWidth(1180);
    harness2();
    tapCard('t1');
    expect(modalThreadId()).toBe('t1');
    clickScrimOver(document.querySelector('#threads-list .thread[data-thread-id="t2"]'));
    expect(modalOpen()).toBe(true);
    expect(modalThreadId()).toBe('t2');
  });

  it('moves the selection with it, so the anchor follows', () => {
    setViewportWidth(1180);
    const { chrome } = harness2();
    tapCard('t1');
    clickScrimOver(document.querySelector('#threads-list .thread[data-thread-id="t2"]'));
    expect(chrome.threadsPanel.getActive()).toBe('t2');
  });

  it('leaves the thread it came from folded behind the scrim', () => {
    setViewportWidth(1180);
    harness2();
    tapCard('t1');
    clickScrimOver(document.querySelector('#threads-list .thread[data-thread-id="t2"]'));
    // State the switch first. Without it this passes for the wrong reason:
    // a dismissal also leaves every card folded, so the assertions below
    // would hold on a build where the click never switched anything.
    expect(modalThreadId()).toBe('t2');
    for (const el of cardsBehind('t1')) expect(el.classList.contains('expanded')).toBe(false);
    for (const el of cardsBehind('t2')) expect(el.classList.contains('expanded')).toBe(false);
  });

  // The control, and the behaviour that must survive: a click on empty scrim
  // is still a dismiss. Without this the fix would have taken the gesture away.
  it('still dismisses on a click with no card under it', () => {
    setViewportWidth(1180);
    const { chrome } = harness2();
    tapCard('t1');
    clickScrimOver(null);
    expect(modalOpen()).toBe(false);
    expect(chrome.threadsPanel.getActive()).toBe(null);
  });

  it('dismisses on a click over the same thread, having nothing to switch to', () => {
    setViewportWidth(1180);
    harness2();
    tapCard('t1');
    clickScrimOver(document.querySelector('#threads-list .thread[data-thread-id="t1"]'));
    expect(modalOpen()).toBe(false);
  });
});
