import type { Comment, ReviewPayload, Thread, User } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type HintItem,
  chipSentence,
  hintParts,
  hintSentence,
  mountCommentHints,
  splitOffscreen,
} from '../src/comment-hints.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * Off-screen comment counts (comments mock 3). The tally is pure and pinned
 * here; the mount is exercised against a hand-measured DOM because happy-dom
 * lays nothing out — every rect below is stubbed.
 */

const item = (id: string, top: number, over: Partial<HintItem> = {}): HintItem => ({
  id,
  kind: 'comment',
  isNew: false,
  top,
  bottom: top + 20,
  ...over,
});

describe('splitOffscreen', () => {
  const view = { top: 0, bottom: 600 };

  it('counts what is wholly above and wholly below, and leaves the visible alone', () => {
    const split = splitOffscreen(
      [item('a', -100), item('b', -30), item('c', 100), item('d', 590), item('e', 700)],
      view,
    );
    expect(split.above.comments).toBe(2);
    expect(split.below.comments).toBe(1);
    // `d` straddles the bottom edge — still visible.
    expect(split.inView).toEqual(['c', 'd']);
  });

  it('separates questions from comments, and counts new ones', () => {
    const split = splitOffscreen(
      [
        item('a', -100, { kind: 'question' }),
        item('b', -50, { isNew: true }),
        item('c', 700, { kind: 'answered', isNew: true }),
        item('d', 800, { kind: 'resolved' }),
      ],
      view,
    );
    expect(split.above).toEqual({ comments: 1, questions: 1, fresh: 1 });
    // Answered and resolved are comments as far as the count goes — nothing
    // is waiting on the reader there.
    expect(split.below).toEqual({ comments: 2, questions: 0, fresh: 1 });
  });

  it('names the NEAREST off-screen thread in each direction', () => {
    const split = splitOffscreen(
      [item('a', -300), item('b', -100), item('c', 700), item('d', 900)],
      view,
    );
    expect(split.nearestAbove).toBe('b');
    expect(split.nearestBelow).toBe('c');
  });

  it('has no nearest when nothing is off-screen', () => {
    const split = splitOffscreen([item('a', 10)], view);
    expect(split.nearestAbove).toBe(null);
    expect(split.nearestBelow).toBe(null);
  });
});

describe('the words', () => {
  it('reads as a sentence on a wide screen', () => {
    expect(hintSentence({ comments: 4, questions: 1, fresh: 0 }, 'above')).toBe(
      '4 comments & 1 question above',
    );
    expect(hintSentence({ comments: 1, questions: 2, fresh: 1 }, 'below')).toBe(
      '1 comment & 2 questions below · 1 new',
    );
    expect(hintSentence({ comments: 0, questions: 0, fresh: 0 }, 'below')).toBe('');
  });

  it('carries the red dot on the comment glyph, never on the question', () => {
    const parts = hintParts({ comments: 2, questions: 1, fresh: 1 });
    expect(parts.map((p) => [p.glyph, p.count, p.fresh])).toEqual([
      ['comment', 2, true],
      ['question', 1, false],
    ]);
  });

  it('the chip says how many are waiting on you, naming no kind', () => {
    // It counts questions AND decisions under one glyph, so saying "questions"
    // was a kind-chip in the top bar — the marking the cards themselves lost.
    expect(chipSentence(1)).toBe('1 waiting on you');
    expect(chipSentence(3)).toBe('3 waiting on you');
    expect(chipSentence(0)).toBe('Nothing waiting on you');
    expect(chipSentence(3)).not.toMatch(/question/i);
  });
});

// --- the mount -------------------------------------------------------------

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };
let ts = 1_700_000_000_000;
function comment(text: string, review?: ReviewPayload): Comment {
  ts += 1000;
  return { id: `c${ts}`, author: alice, text, ts, ...(review ? { review } : {}) };
}
function thread(id: string, comments: Comment[], status: Thread['status'] = 'open'): Thread {
  return {
    id,
    status,
    anchor: { kind: 'subject' },
    commentCount: comments.length,
    lastActivity: comments[comments.length - 1]?.ts ?? ts,
    createdBy: alice,
    comments,
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  vi.useRealTimers();
});

function harness(
  threads: Thread[],
  tops: Record<string, number>,
  opts: { margin?: boolean; dock?: number; cards?: Record<string, Element[]> } = {},
) {
  const pane = document.createElement('section');
  pane.id = 'editor-pane';
  pane.getBoundingClientRect = () =>
    ({ top: 0, bottom: 820, left: 0, right: 800, width: 800, height: 820 }) as DOMRect;
  const dock = document.createElement('div');
  dock.className = 'plan-float';
  dock.getBoundingClientRect = () =>
    ({ top: opts.dock ?? 0, bottom: (opts.dock ?? 0) + 60, height: opts.dock ? 60 : 0 }) as DOMRect;
  pane.appendChild(dock);
  const scroller = document.createElement('div');
  scroller.id = 'editor';
  pane.appendChild(scroller);
  const marginEl = document.createElement('div');
  marginEl.className = 'markup-margin';
  scroller.appendChild(marginEl);
  const chip = document.createElement('button');
  chip.id = 'doc-asks';
  chip.hidden = true;
  document.body.append(pane, chip);
  cleanups.push(() => {
    pane.remove();
    chip.remove();
  });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 600 });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600, left: 0, right: 800 }) as DOMRect;
  marginEl.getBoundingClientRect = () =>
    ({ top: 0, bottom: 600, left: 540, right: 800, width: 260 }) as DOMRect;
  const spans = new Map<string, HTMLElement>();
  for (const [id, top] of Object.entries(tops)) {
    const span = document.createElement('span');
    span.getBoundingClientRect = () => ({ top, bottom: top + 20 }) as DOMRect;
    spans.set(id, span);
  }
  const fresh = new Set(threads.filter((t) => t.id.startsWith('new')).map((t) => t.id));
  const seen: string[] = [];
  const jumps: string[] = [];
  const scope = new MountScope();
  cleanups.push(() => scope.dispose());
  const hints = mountCommentHints({
    scroller,
    marginEl: opts.margin === false ? null : marginEl,
    floatParent: pane,
    chipEl: chip,
    threads: () => threads,
    spanFor: (id) => spans.get(id) ?? null,
    isNew: (t) => fresh.has(t.id),
    markSeen: (t) => {
      const was = fresh.delete(t.id);
      if (was) seen.push(t.id);
      return was;
    },
    onSeen: () => {},
    onJump: (id) => jumps.push(id),
    dockEl: () => (opts.dock ? dock : null),
    cardsFor: (id) => opts.cards?.[id] ?? [],
    scope,
    dwellMs: 50,
    marginVisible: () => opts.margin !== false,
  });
  return { hints, pane, scroller, marginEl, chip, seen, jumps, threads };
}

const q = (): ReviewPayload => ({ shape: 'review', headline: 'Why?' });

describe('mountCommentHints', () => {
  it('renders one hint per direction in the pane, hidden when empty', () => {
    const h = harness([thread('a', [comment('x')]), thread('b', [comment('y')])], {
      a: -200,
      b: 300,
    });
    const top = h.pane.querySelector<HTMLElement>('.cw-offscreen-top');
    const bot = h.pane.querySelector<HTMLElement>('.cw-offscreen-bottom');
    expect(top?.hidden).toBe(false);
    expect(top?.dataset.n).toBe('1');
    expect(top?.title).toBe('1 comment above');
    expect(bot?.hidden).toBe(true);
    // Never inside the margin: a balloon there could land on top of it.
    expect(h.marginEl.querySelector('.cw-offscreen')).toBe(null);
  });

  it('lines the pair up over the balloon column on a wide screen, and lets go on a phone', () => {
    const wide = harness([thread('a', [comment('x')])], { a: -200 });
    const top = wide.pane.querySelector<HTMLElement>('.cw-offscreen-top');
    // margin spans x 540..800 inside a pane at x 0..800 → 6px in from each edge.
    expect(top?.style.left).toBe('546px');
    expect(top?.style.right).toBe('6px');
    const phone = harness([thread('a', [comment('x')])], { a: -200 }, { margin: false });
    const ptop = phone.pane.querySelector<HTMLElement>('.cw-offscreen-top');
    expect(ptop?.style.left).toBe('');
    expect(ptop?.style.right).toBe('');
  });

  it('a tap jumps to the nearest off-screen thread in that direction', () => {
    const h = harness(
      [thread('a', [comment('x')]), thread('b', [comment('y')]), thread('c', [comment('z')])],
      { a: -400, b: -100, c: 900 },
    );
    h.pane.querySelector<HTMLElement>('.cw-offscreen-top')?.click();
    h.pane.querySelector<HTMLElement>('.cw-offscreen-bottom')?.click();
    expect(h.jumps).toEqual(['b', 'c']);
  });

  it('the chip counts every open ask on the doc and starts at the first', () => {
    const h = harness(
      [
        thread('a', [comment('?', q())]),
        thread('b', [comment('?', q())]),
        thread('c', [comment('.')]),
      ],
      { a: 900, b: 100 },
    );
    expect(h.chip.hidden).toBe(false);
    expect(h.chip.title).toBe('2 waiting on you');
    expect(h.chip.querySelector('.cw-ic-question')).not.toBe(null);
    h.chip.click();
    // First in DOCUMENT order, not in thread order — `b` sits higher.
    expect(h.jumps).toEqual(['b']);
  });

  it('every further tap steps to the next open ask, and the last wraps', () => {
    // The chip used to jump to the first ask on every tap, which put three of
    // this reader's four asks out of reach of the only control that told them
    // the asks existed.
    const h = harness(
      [
        thread('a', [comment('?', q())]),
        thread('b', [comment('?', q())]),
        thread('c', [comment('?', q())]),
        thread('d', [comment('.')]),
      ],
      { a: 300, b: 100, c: 500, d: 200 },
    );
    h.chip.click();
    h.chip.click();
    h.chip.click();
    h.chip.click();
    expect(h.jumps).toEqual(['b', 'a', 'c', 'b']);
    expect(h.chip.getAttribute('aria-label')).toBe('3 waiting on you — step through them');
  });

  it('a single ask says jump, not step', () => {
    const h = harness([thread('a', [comment('?', q())])], { a: 100 });
    expect(h.chip.getAttribute('aria-label')).toBe('1 waiting on you — jump to it');
    h.chip.click();
    h.chip.click();
    // One ask taps to itself; the walk never runs off the end.
    expect(h.jumps).toEqual(['a', 'a']);
  });

  it('an ask with no highlight is still in the walk, after the anchored ones', () => {
    // A subject-anchored thread has nothing on the page to scroll to, and is
    // exactly the ask a reader is least likely to find on their own.
    const h = harness([thread('subject', [comment('?', q())]), thread('a', [comment('?', q())])], {
      a: 100,
    });
    h.chip.click();
    h.chip.click();
    h.chip.click();
    expect(h.jumps).toEqual(['a', 'subject', 'a']);
  });

  it('the chip hides when nothing is waiting', () => {
    const h = harness([thread('c', [comment('.')])], { c: 100 });
    expect(h.chip.hidden).toBe(true);
  });

  it('a new thread that sits in view stops being new after the dwell; a flick past does not', () => {
    vi.useFakeTimers();
    const h = harness([thread('new1', [comment('x')]), thread('new2', [comment('y')])], {
      new1: 100,
      new2: 900,
    });
    const bot = h.pane.querySelector<HTMLElement>('.cw-offscreen-bottom');
    expect(bot?.dataset.new).toBe('1');
    // Not yet — the dwell has not elapsed.
    expect(h.seen).toEqual([]);
    vi.advanceTimersByTime(60);
    expect(h.seen).toEqual(['new1']);
    // `new2` never entered the viewport, so it is still new.
    expect(bot?.dataset.new).toBe('1');
  });

  it('a card in view counts as seen even when its sentence scrolled off (the phone)', () => {
    vi.useFakeTimers();
    const card = document.createElement('div');
    card.getBoundingClientRect = () => ({ top: 40, bottom: 200, height: 160 }) as DOMRect;
    const h = harness(
      [thread('new1', [comment('x')])],
      { new1: -300 },
      { cards: { new1: [card] } },
    );
    const top = h.pane.querySelector<HTMLElement>('.cw-offscreen-top');
    // The COUNT still says the sentence is above…
    expect(top?.dataset.new).toBe('1');
    vi.advanceTimersByTime(60);
    // …but the reader has been looking at the card, so it is seen.
    expect(h.seen).toEqual(['new1']);
    expect(top?.dataset.new).toBe('0');
  });

  it('the bottom hint clears the action dock when one is showing', () => {
    const h = harness([thread('a', [comment('x')])], { a: 900 }, { dock: 700 });
    const bot = h.pane.querySelector<HTMLElement>('.cw-offscreen-bottom');
    // pane bottom 820 − (dock top 700 − 8) = 128px up from the pane's edge.
    expect(bot?.style.bottom).toBe('128px');
  });
});
