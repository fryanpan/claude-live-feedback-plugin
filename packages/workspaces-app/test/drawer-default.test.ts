import { createThread, getContent } from '@feedback/core';
import { TextRange } from '@feedback/core/anchor';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { MountScope } from '../src/mount-scope.ts';
import { type ChromeOpts, initialDrawerOpen, mountReviewChrome } from '../src/review-chrome.ts';
import type { InlineThreadCard, ReviewSurface } from '../src/review-surface.ts';
import { sizeThreadSlots } from '../src/thread-morph.ts';

describe('initialDrawerOpen', () => {
  it('never opens on mobile', () => {
    expect(
      initialDrawerOpen({
        isDesktop: false,
        marginVisible: false,
        inlineVisible: true,
        stored: null,
      }),
    ).toBe(false);
    expect(
      initialDrawerOpen({
        isDesktop: false,
        marginVisible: false,
        inlineVisible: true,
        stored: 'open',
      }),
    ).toBe(false);
  });

  it('opens on desktop only when NEITHER always-on surface is showing (a code doc >1100px)', () => {
    expect(
      initialDrawerOpen({
        isDesktop: true,
        marginVisible: false,
        inlineVisible: false,
        stored: null,
      }),
    ).toBe(true);
  });

  /* 901–1100px used to be the gap: the balloon margin has collapsed and, before
     inline cards reached this width, nothing replaced it — so the drawer was
     the only comment surface and had to default open. Now inline cards cover
     it, and a drawer on top would be the same threads twice. */
  it('stays closed in the 901–1100px band, where inline cards are the surface', () => {
    expect(
      initialDrawerOpen({
        isDesktop: true,
        marginVisible: false,
        inlineVisible: true,
        stored: null,
      }),
    ).toBe(false);
  });

  it('stays closed on desktop when balloons already show the threads', () => {
    expect(
      initialDrawerOpen({
        isDesktop: true,
        marginVisible: true,
        inlineVisible: false,
        stored: null,
      }),
    ).toBe(false);
  });

  it('an explicit user toggle overrides the balloon default in both directions', () => {
    expect(
      initialDrawerOpen({
        isDesktop: true,
        marginVisible: true,
        inlineVisible: false,
        stored: 'open',
      }),
    ).toBe(true);
    expect(
      initialDrawerOpen({
        isDesktop: true,
        marginVisible: false,
        inlineVisible: false,
        stored: 'closed',
      }),
    ).toBe(false);
  });

  it('ignores garbage stored values', () => {
    expect(
      initialDrawerOpen({
        isDesktop: true,
        marginVisible: true,
        inlineVisible: false,
        stored: 'weird',
      }),
    ).toBe(false);
    expect(
      initialDrawerOpen({
        isDesktop: true,
        marginVisible: false,
        inlineVisible: false,
        stored: 'weird',
      }),
    ).toBe(true);
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
    whenSynced: (cb) => cb(),
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

  /* This band was the gap. The balloon margin hides at ≤1100px and inline
     cards used to start at ≤900px, so 901–1100 had NEITHER — the drawer was
     the only way to see a comment, which is why it defaulted open here.
     Inline cards now cover the same widths the margin doesn't, so the drawer
     goes back to being the second copy it is everywhere else. */
  it('defaults CLOSED at 901–1100px, where inline cards have taken over from the margin', () => {
    setViewportWidth(1000);
    mountChromeDom();
    mountReviewChrome(opts(new MountScope(), { hasBalloonMargin: true }));
    expect(shellOpen()).toBe(false);
  });

  it('defaults CLOSED at 901–1100px on a code doc too — inline does not need a margin', () => {
    setViewportWidth(1000);
    mountChromeDom();
    mountReviewChrome(opts(new MountScope()));
    expect(shellOpen()).toBe(false);
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

/**
 * The drawer default above is only half the rule. The other half is that
 * SOMETHING always shows the comments: inline cards cover exactly the widths
 * the balloon margin doesn't. Asserted through the real chrome, because the
 * gap was in the wiring — `mountMobileReview` was handed the phone predicate
 * (≤900px) while the margin hid at ≤1100px, so the band between them produced
 * no cards from either side.
 */
describe('inline cards cover every width the balloon margin does not', () => {
  function mountWithThread(width: number): {
    placed: () => InlineThreadCard[];
  } {
    setViewportWidth(width);
    mountChromeDom();
    const ydoc = new Y.Doc();
    const ytext = getContent(ydoc);
    ytext.insert(0, 'The retry loop swallows the error.');
    createThread(ydoc, {
      threadId: 't1',
      anchor: TextRange.createFromOffsets(ytext, 4, 14),
      createdBy: { id: 'u2', name: 'Bob', kind: 'known', color: '#c0392b' },
      firstComment: { id: 'c1', text: 'Please clarify this.' },
    });
    let cards: InlineThreadCard[] = [];
    const surface: ReviewSurface = {
      ...fakeSurface(),
      // Any resolvable range will do — the question is whether a card is
      // produced for it at all, not where it lands.
      resolveRel: () => ({ from: 4, to: 14 }),
      setInlineCards: (c) => {
        cards = c;
      },
    };
    const chrome = mountReviewChrome(opts(new MountScope(), { ydoc, surface }));
    chrome.redrawThreads();
    return { placed: () => cards };
  }

  it('places the card at 1000px, where the margin has already collapsed', () => {
    expect(
      mountWithThread(1000)
        .placed()
        .map((c) => c.id),
    ).toEqual(['t1']);
  });

  it('places it on a phone too', () => {
    expect(
      mountWithThread(430)
        .placed()
        .map((c) => c.id),
    ).toEqual(['t1']);
  });

  it('places none at 1400px, where the balloon margin owns the comments', () => {
    expect(mountWithThread(1400).placed()).toEqual([]);
  });
});
