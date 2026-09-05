import type { Comment, Thread, User } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PLACEMENT_PREF_KEY,
  applyPlacement,
  cardPlacement,
  effectiveSurface,
  inlineCardsVisible,
  otherPlacement,
  placementToggleLabel,
  setCardPlacement,
} from '../src/card-placement.ts';
import {
  type MobileReviewOpts,
  centreScrollTop,
  mountMobileReview,
  stepIndex,
} from '../src/mobile-review.ts';
import type { InlineThreadCard } from '../src/review-surface.ts';
import { ThreadPanel } from '../src/threads.ts';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * Mobile review: comments inline in the document/source, the over-doc sheet
 * the comment badge opens, and the ‹ › nav that walks the inline cards.
 *
 * happy-dom has no layout, so the geometry lives behind a pure function
 * (`centreScrollTop`) which is tested on its own; the DOM tests assert the
 * WIRING — which threads get an inline card, which scroller is moved, and
 * that a fold reaches both copies of the same thread.
 */

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const bob: User = { id: 'u2', name: 'Bob', kind: 'known', color: '#e36f1e' };

let seq = 1_700_000_000_000;
function comment(author: User, text: string): Comment {
  seq += 1000;
  return { id: `c${seq}`, author, text, ts: seq };
}

function thread(id: string, over: Partial<Thread> = {}): Thread {
  const comments = over.comments ?? [comment(alice, `opening ${id}`)];
  return {
    id,
    status: 'open',
    anchor: {
      kind: 'text-range',
      startRel: new Uint8Array(),
      endRel: new Uint8Array(),
      snippet: { text: `snippet ${id}` },
    } as Thread['anchor'],
    createdBy: alice,
    commentCount: comments.length,
    lastActivity: comments[comments.length - 1]?.ts ?? seq,
    comments,
    ...over,
  };
}

const orphanThread = (id: string): Thread =>
  thread(id, {
    anchor: {
      kind: 'orphan',
      original: {
        kind: 'text-range',
        startRel: new Uint8Array(),
        endRel: new Uint8Array(),
        snippet: { text: `snippet ${id}` },
      },
      lastSeenAt: seq,
    } as Thread['anchor'],
  });

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

interface Harness {
  panel: ThreadPanel;
  sheetList: HTMLElement;
  placed: () => InlineThreadCard[];
  mobile: ReturnType<typeof mountMobileReview>;
  sheetOpen: () => boolean;
  editor: HTMLElement;
  /** Put the placed cards in the document, the way a real surface would. */
  mountPlaced: () => void;
  scrolledTo: number[];
}

function harness(
  threads: Thread[],
  over: Partial<MobileReviewOpts> = {},
  positions?: Record<string, number>,
): Harness {
  document.body.innerHTML = `
    <div id="shell">
      <div id="editor"></div>
      <button id="prev-comment" title="Previous comment">‹</button>
      <button id="next-comment" title="Next comment">›</button>
      <div id="threads-pane"><div id="threads-list"></div></div>
    </div>`;
  const editor = document.getElementById('editor') as HTMLElement;
  const sheetList = document.getElementById('threads-list') as HTMLElement;
  const shell = document.getElementById('shell') as HTMLElement;

  const panel = new ThreadPanel({
    container: sheetList,
    currentUser: alice,
    onThreadClick: () => {},
    onReply: () => {},
    onResolve: () => {},
    onReopen: () => {},
    onReanchor: () => {},
  });

  let placed: InlineThreadCard[] = [];
  const scrolledTo: number[] = [];
  const listeners: Array<() => void> = [];
  const mobile = mountMobileReview({
    inlineVisible: () => true,
    threads: () => threads,
    resolveRange: (id) => {
      const t = threads.find((x) => x.id === id);
      if (!t || t.anchor.kind !== 'text-range') return null;
      const from = positions?.[id] ?? threads.findIndex((x) => x.id === id) * 10;
      return { from, to: from + 5 };
    },
    renderCard: (t, pending) => panel.renderThread(t, pending),
    surface: {
      setInlineCards: (cards) => {
        placed = cards;
      },
      scrollToPos: (pos) => scrolledTo.push(pos),
    },
    setActive: (id) => panel.setActive(id),
    getActive: () => panel.getActive(),
    revealInSheet: (id) => panel.revealThread(id),
    openSheet: () => shell.classList.add('threads-open'),
    closeSheet: () => shell.classList.remove('threads-open'),
    isSheetOpen: () => shell.classList.contains('threads-open'),
    listen: (target, type, handler) => {
      target.addEventListener(type, handler);
      listeners.push(() => target.removeEventListener(type, handler));
    },
    ...over,
  });
  cleanups.push(() => {
    for (const off of listeners) off();
  });

  panel.setThreads(threads);
  mobile.refresh();

  return {
    panel,
    sheetList,
    placed: () => placed,
    mobile,
    editor,
    scrolledTo,
    sheetOpen: () => shell.classList.contains('threads-open'),
    mountPlaced: () => {
      for (const c of placed) editor.appendChild(c.el);
    },
  };
}

// --- the pure geometry --------------------------------------------------------

describe('centreScrollTop', () => {
  it('centres the card in the container', () => {
    // 400-tall viewport, a 100-tall card whose top sits at 1000 → its middle
    // (1050) should land at the viewport's middle (200 from the top).
    expect(
      centreScrollTop({ elTop: 1000, elHeight: 100, clientHeight: 400, scrollHeight: 5000 }),
    ).toBe(850);
  });

  it('clamps to the top rather than scrolling negative', () => {
    expect(
      centreScrollTop({ elTop: 10, elHeight: 40, clientHeight: 600, scrollHeight: 5000 }),
    ).toBe(0);
  });

  it('clamps to the bottom of the scrollable range', () => {
    // max scrollTop is 5000 - 600 = 4400; the wanted value is past it.
    expect(
      centreScrollTop({ elTop: 4900, elHeight: 40, clientHeight: 600, scrollHeight: 5000 }),
    ).toBe(4400);
  });

  it('is 0 when the content does not overflow (max clamps below 0)', () => {
    expect(
      centreScrollTop({ elTop: 100, elHeight: 40, clientHeight: 900, scrollHeight: 500 }),
    ).toBe(0);
  });
});

describe('stepIndex', () => {
  it('starts at the first item going forward and the last going back', () => {
    expect(stepIndex(-1, 1, 3)).toBe(0);
    expect(stepIndex(-1, -1, 3)).toBe(2);
  });

  it('wraps in both directions', () => {
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, -1, 3)).toBe(2);
  });

  it('survives an index left over from a longer list', () => {
    expect(stepIndex(9, 1, 3)).toBe(1);
  });

  it('reports "nothing to walk" for an empty list', () => {
    expect(stepIndex(-1, 1, 0)).toBe(-1);
  });
});

// --- which threads are inline -------------------------------------------------

describe('inline placement', () => {
  it('places open, anchored threads in document order', () => {
    const h = harness([thread('t2'), thread('t1')], {}, { t1: 5, t2: 90 });
    expect(h.placed().map((c) => c.id)).toEqual(['t1', 't2']);
  });

  it('gives an orphaned thread NO inline card — the sheet is its only home; a resolved one keeps its card', () => {
    const h = harness([
      thread('open1'),
      orphanThread('orph1'),
      thread('done1', { status: 'resolved' }),
    ]);
    // Positive control first: the surface really does receive cards. The
    // resolved thread keeps a faint highlight and so keeps a (folded) card.
    expect(
      h
        .placed()
        .map((c) => c.id)
        .sort(),
    ).toEqual(['done1', 'open1']);
    // …and the orphan, which has nowhere to sit, is reachable in the sheet.
    const ids = (): string[] =>
      Array.from(h.sheetList.querySelectorAll('.thread'))
        .map((e) => e.getAttribute('data-thread-id') ?? '')
        .sort();
    expect(ids()).toEqual(['open1', 'orph1']);
    h.panel.setTab('all');
    expect(ids()).toEqual(['done1', 'open1', 'orph1']);
  });

  it('the sheet groups Open / Orphaned / Resolved', () => {
    const h = harness([
      thread('open1'),
      orphanThread('orph1'),
      thread('done1', { status: 'resolved' }),
    ]);
    h.panel.setTab('all');
    const headings = Array.from(h.sheetList.querySelectorAll('.section-heading')).map(
      (e) => e.textContent ?? '',
    );
    expect(headings).toEqual(['Open (1)', 'Orphaned (1) — re-anchor needed', 'Resolved (1)']);
  });

  it('reuses the SAME node when nothing the card displays changed', () => {
    const t = thread('t1');
    const h = harness([t]);
    const first = h.placed()[0].el;
    h.mobile.refresh();
    // A rebuilt node mounts at its final height and cannot morph, so identity
    // across an unrelated refresh is the whole contract.
    expect(h.placed()[0].el).toBe(first);
  });

  it('rebuilds the card when the anchor snippet changes (stale-topic regression)', () => {
    const t = thread('t1');
    const h = harness([t]);
    const before = h.placed()[0].el;
    expect(before.querySelector('.thread-topic')?.textContent).toBe('snippet t1');

    (t.anchor as { snippet: { text: string } }).snippet = { text: 'edited anchor' };
    h.mobile.refresh();
    expect(h.placed()[0].el).not.toBe(before);
    expect(h.placed()[0].el.querySelector('.thread-topic')?.textContent).toBe('edited anchor');
  });

  it('produces no inline cards at all where the balloon margin owns the comments', () => {
    const h = harness([thread('t1')], { inlineVisible: () => false });
    expect(h.placed()).toEqual([]);
  });

  it('carries an in-progress reply across a rebuild', () => {
    const t = thread('t1');
    const h = harness([t]);
    const ta = h.placed()[0].el.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'half a reply';

    t.comments = [...t.comments, comment(bob, 'someone else spoke')];
    t.commentCount = t.comments.length;
    t.lastActivity = t.comments[t.comments.length - 1].ts;
    h.mobile.refresh();

    const after = h.placed()[0].el.querySelector('textarea') as HTMLTextAreaElement;
    expect(after.value).toBe('half a reply');
  });
});

describe('an inline card repaints when its review item changes', () => {
  const ask = (over: Record<string, unknown> = {}) =>
    ({
      shape: 'review',
      headline: 'Read the stall rota',
      ...over,
    }) as NonNullable<Comment['review']>;

  it('drops the answered record when the answer is taken back', () => {
    // Undo un-stamps the declaration and touches nothing else — no comment
    // added, no clock moved — so a card key built from counts and timestamps
    // comes out identical and the reused node keeps saying "Answered by …".
    // On a phone the inline card IS the comment surface, so that is the whole
    // screen still showing a settled item the reader has just reopened.
    const declaring = { ...comment(bob, 'Which way?'), review: ask({ answeredAt: seq }) };
    const threads = [thread('t1', { comments: [declaring] })];
    const h = harness(threads);
    expect(h.placed()[0].el.querySelector('.thread-answered')).not.toBeNull();

    threads[0] = thread('t1', {
      comments: [{ ...declaring, review: ask() }],
      lastActivity: declaring.ts,
    });
    h.mobile.refresh();
    expect(h.placed()[0].el.querySelector('.thread-answered')).toBeNull();
  });
});

// --- shared expand state ------------------------------------------------------

describe('expand state is shared between the inline copy and the sheet copy', () => {
  it('one toggle drives BOTH copies', () => {
    const h = harness([thread('t1')]);
    h.mountPlaced();
    const inline = h.placed()[0].el;
    const inSheet = h.sheetList.querySelector('.thread[data-thread-id="t1"]') as HTMLElement;
    // Positive control: two distinct nodes for one thread.
    expect(inSheet).toBeTruthy();
    expect(inSheet).not.toBe(inline);
    expect(inline.classList.contains('expanded')).toBe(false);
    expect(inSheet.classList.contains('expanded')).toBe(false);

    h.mobile.showThread('t1');

    expect(inline.classList.contains('expanded')).toBe(true);
    expect(inSheet.classList.contains('expanded')).toBe(true);

    h.panel.setActive(null);
    expect(inline.classList.contains('expanded')).toBe(false);
    expect(inSheet.classList.contains('expanded')).toBe(false);
  });
});

// --- nav ----------------------------------------------------------------------

describe('prev/next comment nav', () => {
  function stubScroller(h: Harness, metrics = { client: 600, scroll: 5000 }): number[] {
    const tops: number[] = [];
    Object.defineProperty(h.editor, 'clientHeight', { configurable: true, value: metrics.client });
    Object.defineProperty(h.editor, 'scrollHeight', { configurable: true, value: metrics.scroll });
    (h.editor as unknown as { scrollTo: (o: { top: number }) => void }).scrollTo = (o) => {
      tops.push(o.top);
    };
    return tops;
  }

  it('walks the inline threads in document order and wraps', () => {
    const h = harness([thread('a'), thread('b'), thread('c')], {}, { a: 1, b: 2, c: 3 });
    h.mountPlaced();
    stubScroller(h);

    h.mobile.step(1);
    expect(h.panel.getActive()).toBe('a');
    h.mobile.step(1);
    expect(h.panel.getActive()).toBe('b');
    h.mobile.step(1);
    expect(h.panel.getActive()).toBe('c');
    h.mobile.step(1);
    expect(h.panel.getActive()).toBe('a');
    h.mobile.step(-1);
    expect(h.panel.getActive()).toBe('c');
  });

  it('skips orphaned threads — they cannot be walked to', () => {
    const h = harness([thread('a'), orphanThread('o'), thread('b')], {}, { a: 1, b: 4 });
    h.mountPlaced();
    stubScroller(h);
    h.mobile.step(1);
    h.mobile.step(1);
    h.mobile.step(1);
    // Three steps over a two-item list wraps back to the first — it never
    // lands on the orphan.
    expect(h.panel.getActive()).toBe('a');
  });

  it("scrolls the card's OWN container and never calls scrollIntoView", () => {
    const h = harness([thread('a')]);
    h.mountPlaced();
    const tops = stubScroller(h);
    const card = h.placed()[0].el;
    Object.defineProperty(card, 'offsetHeight', { configurable: true, value: 100 });
    card.getBoundingClientRect = () => ({ top: 1000 }) as DOMRect;
    h.editor.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    h.editor.scrollTop = 0;
    const intoView = vi.fn();
    card.scrollIntoView = intoView;

    h.mobile.step(1);

    // 1000 - 600/2 + 100/2 = 750, inside [0, 4400].
    expect(tops).toEqual([750]);
    expect(intoView).not.toHaveBeenCalled();
  });

  it('disables the buttons when nothing is inline, and says why', () => {
    const h = harness([orphanThread('o')]);
    const prev = document.getElementById('prev-comment') as HTMLButtonElement;
    const next = document.getElementById('next-comment') as HTMLButtonElement;
    expect(h.placed()).toEqual([]);
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(true);
    expect(prev.title).toMatch(/No comments anchored/);

    // Positive control: with one inline thread they come back, with their
    // original titles.
    const h2 = harness([thread('a')]);
    expect(h2.placed()).toHaveLength(1);
    expect((document.getElementById('prev-comment') as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById('next-comment') as HTMLButtonElement).title).toBe(
      'Next comment',
    );
  });

  it('does nothing (rather than wrapping onto nothing) when there is no inline thread', () => {
    const h = harness([orphanThread('o')]);
    expect(() => h.mobile.step(1)).not.toThrow();
    expect(h.panel.getActive()).toBe(null);
  });

  it('the app-bar buttons are wired to the walk', () => {
    const h = harness([thread('a'), thread('b')], {}, { a: 1, b: 2 });
    h.mountPlaced();
    stubScroller(h);
    (document.getElementById('next-comment') as HTMLButtonElement).click();
    expect(h.panel.getActive()).toBe('a');
    (document.getElementById('prev-comment') as HTMLButtonElement).click();
    expect(h.panel.getActive()).toBe('b');
  });
});

// --- threads with no inline position ------------------------------------------

describe('showThread for a thread with no line to sit beside', () => {
  it('opens the sheet instead of jumping to nothing', () => {
    const h = harness([orphanThread('o')]);
    expect(h.sheetOpen()).toBe(false);
    const jumped = h.mobile.showThread('o');
    expect(jumped).toBe(false);
    expect(h.sheetOpen()).toBe(true);
    expect(h.panel.getActive()).toBe('o');
  });

  it('closes the sheet when the thread DOES have an inline card', () => {
    const h = harness([thread('a')]);
    h.mountPlaced();
    Object.defineProperty(h.editor, 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(h.editor, 'scrollHeight', { configurable: true, value: 5000 });
    (h.editor as unknown as { scrollTo: (o: { top: number }) => void }).scrollTo = () => {};
    h.mobile.showThread('a'); // opens nothing; sheet still closed
    (document.getElementById('shell') as HTMLElement).classList.add('threads-open');
    expect(h.mobile.showThread('a')).toBe(true);
    expect(h.sheetOpen()).toBe(false);
  });

  it('scrolls the surface first when the card exists but is off-viewport', () => {
    // CodeMirror renders only its viewport, so an inline card can be absent
    // from the DOM entirely. Placed but never mounted reproduces exactly that.
    const h = harness([thread('a')], {}, { a: 42 });
    expect(h.placed()).toHaveLength(1);
    expect(h.placed()[0].el.isConnected).toBe(false);
    expect(h.mobile.showThread('a')).toBe(true);
    expect(h.scrolledTo).toEqual([42]);
    expect(h.sheetOpen()).toBe(false);
  });
});

/**
 * The over-doc sheet has to ride the iOS keyboard.
 *
 * This branch moved the mobile reply box OUT of `#thread-view` (which is
 * pinned with `bottom: var(--kb-bottom, 0px)` and carries the comment
 * explaining why) and INTO the card, which on a phone lives inline and again
 * inside the sheet. A `position: fixed` sheet is layout-viewport-relative on
 * iOS, so with a plain `bottom: 0` the keyboard covers the textarea being
 * typed into and the Reply button under it — and nothing else in the suite
 * can see that, because it is entirely a stylesheet fact.
 */
describe('the mobile sheet rides the keyboard', () => {
  let sheets = () => {};
  afterEach(() => {
    sheets();
    document.documentElement.style.removeProperty('--kb-bottom');
    setViewport({ width: 1024, height: 768 });
    document.body.replaceChildren();
  });

  /** `#threads-pane` as the page resolves it, at a stated viewport and with
   *  the keyboard inset `wireKeyboardInset` publishes set to `kb`. Snapshotted
   *  rather than returned live: a computed style is bound to its element, and
   *  the next call detaches it. */
  function pane(viewport: { width: number; height: number }, kb: string) {
    setViewport(viewport);
    document.documentElement.style.setProperty('--kb-bottom', kb);
    document.body.replaceChildren();
    const style = styleOf(attach('x', { attrs: { id: 'threads-pane' } }));
    return { position: style.position, bottom: style.bottom, maxHeight: style.maxHeight };
  }

  it('pins #threads-pane to --kb-bottom, and caps its height against it too', () => {
    // Read off the cascade rather than out of the stylesheet's text. The old
    // version searched one slice of `styles.css` for the declarations, which
    // says nothing about whether they REACH the pane: they sit inside a
    // `max-width: 900px` block, and a text match holds at every width whether
    // or not the query does.
    sheets = installSheets('styles.css', 'doc.css');
    const down = pane(PHONE, '0px');
    expect(down.position).toBe('fixed');
    expect(down.bottom).toBe('0px');

    // The keyboard comes up. `bottom` follows it, and so does the height cap
    // — that second half is what stops the sheet growing off the TOP of the
    // screen as it is pushed up, and it is the one a `toMatch` on the source
    // could not tell from a copy of the variable's name.
    const up = pane(PHONE, '300px');
    expect(up.bottom).toBe('300px');
    expect(up.maxHeight).not.toBe(down.maxHeight);
    expect(up.maxHeight).toContain('300px');
    // happy-dom returns `min()` unevaluated, so the assertion is that the cap
    // SHRANK by the inset, spelled the way the browser would compute it.
    expect(down.maxHeight).toContain('- 0px - 56px');
    expect(up.maxHeight).toContain('- 300px - 56px');
  });

  it('leaves the desktop pane alone — the sheet is the phone tier only', () => {
    // The control the text read had no way to make: these declarations live
    // in a `max-width: 900px` block, so on the iPad the pane must NOT be a
    // fixed, keyboard-riding sheet. A grep for `position: fixed` passes here
    // either way.
    sheets = installSheets('styles.css', 'doc.css');
    const wide = pane(IPAD, '300px');
    expect(wide.position).not.toBe('fixed');
    expect(wide.bottom).not.toBe('300px');
  });
});

/**
 * The 430px sheet — the state the mock names and the one neither in-flow
 * surface covers.
 *
 * A reader who put their cards in the margin on a laptop has not changed
 * their mind by picking up a phone, so `cardPlacement` still reads `balloon`
 * there. But 430px has no margin to ride in, so the over-doc sheet becomes
 * the comment surface and NOTHING sits in the document flow. That is a state
 * with a real way to get everything wrong: build inline cards anyway and the
 * reader gets both surfaces at once; build none and disable the walk with
 * them and the comments become unreachable from the app bar.
 */
describe('the 430px sheet', () => {
  afterEach(() => {
    try {
      localStorage.removeItem(PLACEMENT_PREF_KEY);
    } catch {
      // nothing stored to clear
    }
    document.body.removeAttribute('data-cards');
    setViewport({ width: 1024, height: 768 });
  });

  it('builds no inline card, yet ‹ › still walks and lands the reader in the sheet', () => {
    setViewport(PHONE);
    setCardPlacement('balloon');
    const h = harness([thread('a'), thread('b')], { inlineVisible: inlineCardsVisible });
    expect(h.placed()).toEqual([]);
    // Disabling the walk along with the cards is the tempting mistake: the
    // buttons count ANCHORED THREADS, and stepping is exactly how a reader
    // reaches a thread whose only copy is in the sheet.
    const next = document.getElementById('next-comment') as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    next.click();
    expect(h.sheetOpen()).toBe(true);
    expect(h.panel.getActive()).toBe('a');
    next.click();
    expect(h.panel.getActive()).toBe('b');
  });

  it('keeps the choice the reader made, and offers to move the cards into the flow', () => {
    setViewport(PHONE);
    setCardPlacement('balloon');
    // What was chosen, what is on screen, and what the toggle offers are three
    // different answers here — and only the middle one changed.
    expect(cardPlacement()).toBe('balloon');
    expect(effectiveSurface()).toBe('sheet');
    expect(otherPlacement(cardPlacement())).toBe('inline');
    expect(placementToggleLabel(effectiveSurface()).title).toContain('sheet');
  });

  it('leaves nothing in the document flow, and no 260px track to scroll sideways past', () => {
    // Both sheets: the placement rules live in `doc.css` since the editor's
    // CSS became its own file, and a negative read against the base alone
    // would pass on a stylesheet that never had the rule.
    const off = installSheets('styles.css', 'doc.css');
    cleanups.push(off);
    setViewport(PHONE);
    setCardPlacement('balloon');
    applyPlacement();
    expect(document.body.dataset.cards).toBe('sheet');
    const editor = attach('redline-layout', { attrs: { id: 'editor' } });
    const margin = attach('markup-margin', { parent: editor });
    const inline = attach('cw-inline-card', { parent: editor });
    expect(styleOf(margin).display).toBe('none');
    expect(styleOf(inline).display).toBe('none');
    // Single-column flow: the two-track grid is what put a 260px column
    // beside 430px of prose and made the page scroll sideways.
    expect(styleOf(editor).display).toBe('block');
  });

  it('positive control: the same nodes at 1180 with balloons chosen do show the margin', () => {
    const off = installSheets('styles.css', 'doc.css');
    cleanups.push(off);
    setViewport(IPAD);
    setCardPlacement('balloon');
    applyPlacement();
    expect(document.body.dataset.cards).toBe('balloon');
    const editor = attach('redline-layout', { attrs: { id: 'editor' } });
    const margin = attach('markup-margin', { parent: editor });
    expect(styleOf(margin).display).not.toBe('none');
    expect(styleOf(editor).display).not.toBe('block');
  });
});
