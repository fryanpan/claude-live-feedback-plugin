/**
 * Commenting on a review item like a doc (approved on the mock, 2026-08-29).
 *
 * The old "Tell me more" box is gone from the walkthrough card. In its place:
 * select a phrase of a ticket-borne item's detail and a comment pill appears;
 * tapping it opens a thread card quoting the phrase; sending the question
 * creates a thread anchored to THAT phrase of THAT item, and the card stays
 * where it is with a "Waiting on <owner>" note. When the owner revises the
 * item, the queue shows it again marked Revised, quoting the question, with
 * the revised phrase highlighted and a way to the thread.
 *
 * All fixtures are synthetic — invented names and ids throughout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ReviewStripHandlers,
  homeReviewData,
  mountHomeReviewIsland,
} from '../src/hub/home-review-island.tsx';
import {
  type ReviewItem,
  type ReviewQueue,
  type ReviewThreadItem,
  holdWaitingItem,
  reviewItemAskRequest,
  reviewQueue,
  revisedPhrase,
} from '../src/hub/hub-model.ts';
import {
  type WalkthroughHandlers,
  type WalkthroughView,
  mountWalkthroughIsland,
  walkthroughData,
} from '../src/hub/walkthrough-island.tsx';

const NOW = 1_700_000_000_000;
const DETAIL = 'The mockup shows one and the build ships the other. Which do we keep?';

/** A ticket-borne review item, as the review-items route ships it. */
function ticketRow(over: Partial<ReviewThreadItem> = {}): ReviewThreadItem {
  return {
    kind: 'task-review',
    band: 'declared',
    review: { shape: 'review', headline: 'Green or blue?', detail: DETAIL },
    taskId: 'tk-1',
    reviewItemId: 'r-1',
    title: 'Ship the widget',
    ask: 'Green or blue?',
    askedBy: 'Helper',
    since: NOW - 60_000,
    direct: true,
    askedAt: NOW - 60_000,
    ...over,
  } as unknown as ReviewThreadItem;
}

/** The same item after the owner revised it in answer to a question. */
function revisedRow(over: Partial<ReviewThreadItem> = {}): ReviewThreadItem {
  const detail = 'The mockup shows one and the build ships the OTHER (blue). Which do we keep?';
  const start = detail.indexOf('the OTHER (blue)');
  return ticketRow({
    review: { shape: 'review', headline: 'Green or blue?', detail },
    state: 'revised',
    revisedAt: NOW - 10_000,
    question: 'Which other?',
    threadId: 'th-ask',
    revisedRange: { start, end: start + 'the OTHER (blue)'.length },
    ...over,
  } as Partial<ReviewThreadItem>);
}

/** A DECLARED thread-borne item — no review item id, so nothing to anchor to. */
function threadRow(): ReviewThreadItem {
  return {
    kind: 'task-thread',
    band: 'declared',
    docId: 'task:tk-1',
    threadId: 'th-1',
    taskId: 'tk-1',
    title: 'Ship the widget',
    ask: 'Green or blue?',
    askedBy: 'Helper',
    since: NOW - 60_000,
    commentId: 'c-1',
    review: { shape: 'review', headline: 'Green or blue?', detail: DETAIL },
  };
}

function walk(over: Partial<WalkthroughHandlers> = {}): WalkthroughHandlers {
  return {
    onAnswer: vi.fn(),
    onReply: vi.fn(),
    onAskOnItem: vi.fn(),
    onOpenItem: vi.fn(),
    onOpenThread: vi.fn(),
    onStep: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
}

function strip(over: Partial<ReviewStripHandlers> = {}): ReviewStripHandlers {
  return {
    onReview: vi.fn(),
    onOpen: vi.fn(),
    onOpenThread: vi.fn(),
    onWalkthrough: vi.fn(),
    ...over,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
/** The pill keys off `selectionchange`, debounced — wait it out. */
const settle = () => new Promise((r) => setTimeout(r, 160));

let root: HTMLElement;
let dispose: (() => void) | null = null;

function mountWalk(
  queue: ReviewQueue,
  handlers: WalkthroughHandlers,
  patch: Partial<WalkthroughView> = {},
): void {
  dispose?.();
  walkthroughData.value = {
    queue,
    index: 0,
    progress: { cleared: 0, last: null },
    now: NOW,
    handlers,
    ...patch,
  };
  dispose = mountWalkthroughIsland(root);
}

function mountHome(queue: ReviewQueue, handlers: ReviewStripHandlers): void {
  dispose?.();
  homeReviewData.value = { queue, settled: [], now: NOW };
  dispose = mountHomeReviewIsland(root, handlers);
}

/** Select `phrase` inside `el` the way a finger does, and let the pill hear. */
async function select(el: HTMLElement, phrase: string): Promise<void> {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Text | null = null;
  while (walker.nextNode()) {
    const t = walker.currentNode as Text;
    if (t.data.includes(phrase)) {
      node = t;
      break;
    }
  }
  if (!node) throw new Error(`no text node holds “${phrase}”`);
  const r = document.createRange();
  r.setStart(node, node.data.indexOf(phrase));
  r.setEnd(node, node.data.indexOf(phrase) + phrase.length);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
  document.dispatchEvent(new Event('selectionchange'));
  await settle();
}

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
  window.getSelection()?.removeAllRanges();
});
afterEach(() => {
  dispose?.();
  dispose = null;
});

describe('the model: where a question on an item goes, and what a revision carries', () => {
  it('builds the anchored thread create for a ticket-borne item', () => {
    const q = reviewQueue([], [ticketRow()], NOW);
    const req = reviewItemAskRequest(q.items[0] as ReviewItem, 'ships the other', 'Which other?');
    expect(req).toEqual({
      path: '/api/docs/task%3Atk-1/threads',
      body: {
        text: 'Which other?',
        anchor: { kind: 'review-item', reviewItemId: 'r-1', snippet: { text: 'ships the other' } },
      },
    });
  });

  it('has nowhere to send a question on a thread-borne item', () => {
    const q = reviewQueue([], [threadRow()], NOW);
    expect(reviewItemAskRequest(q.items[0] as ReviewItem, 'x', 'y')).toBeNull();
  });

  it('carries the revision onto the queue item, and slices the revised phrase', () => {
    const q = reviewQueue([], [revisedRow()], NOW);
    const item = q.items[0] as ReviewItem;
    expect(item.revision).toMatchObject({
      at: NOW - 10_000,
      question: 'Which other?',
      threadId: 'th-ask',
    });
    expect(revisedPhrase(item)).toBe('the OTHER (blue)');
    // An open row carries none — the card must not invent a revision.
    const open = reviewQueue([], [ticketRow()], NOW).items[0] as ReviewItem;
    expect(open.revision).toBeUndefined();
    expect(revisedPhrase(open)).toBeUndefined();
  });

  it('a revision whose range is unknown still quotes the question', () => {
    const q = reviewQueue([], [revisedRow({ revisedRange: undefined } as never)], NOW);
    const item = q.items[0] as ReviewItem;
    expect(item.revision?.question).toBe('Which other?');
    expect(revisedPhrase(item)).toBeUndefined();
  });

  it('holds an asked item on its card while the queue has dropped it', () => {
    const q = reviewQueue([], [ticketRow(), ticketRow({ reviewItemId: 'r-2' })], NOW);
    const asked = q.items[0] as ReviewItem;
    const after = reviewQueue([], [ticketRow({ reviewItemId: 'r-2' })], NOW);
    const held = holdWaitingItem(after, {
      key: asked.key,
      index: 0,
      item: { ...asked, waiting: { question: 'Which other?', owner: 'Helper' } },
    });
    expect(held.items.map((i) => i.key)).toEqual([asked.key, 'task-review:tk-1:r-2']);
    expect(held.items[0]?.waiting).toEqual({ question: 'Which other?', owner: 'Helper' });
    // The hold is a display ledger, not a queue row: the count stays honest.
    expect(held.total).toBe(after.total);
    // Once the item is back (revised), the hold defers to the real row.
    const back = reviewQueue([], [revisedRow(), ticketRow({ reviewItemId: 'r-2' })], NOW);
    const noHold = holdWaitingItem(back, { key: asked.key, index: 0, item: asked });
    expect(noHold).toBe(back);
    expect(holdWaitingItem(after, null)).toBe(after);
  });
});

describe('the walkthrough card: select a phrase, ask on it, wait', () => {
  it('the "Tell me more" box is gone from every card', () => {
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk());
    expect(root.querySelector('.hub-walk-info')).toBeNull();
    expect(root.querySelector('.hub-walk-more')).toBeNull();
  });

  it('a pill appears when a phrase of the detail is selected, and hides when it is not', async () => {
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk());
    const pill = root.querySelector('.hub-walk-pill') as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.classList.contains('comment-pill')).toBe(true);
    expect(pill.classList.contains('hidden')).toBe(true);
    await select(root.querySelector('.hub-walk-body') as HTMLElement, 'ships the other');
    expect(pill.classList.contains('hidden')).toBe(false);
    // A selection somewhere else on the page is not a phrase of the item.
    const elsewhere = document.createElement('p');
    elsewhere.textContent = 'unrelated words';
    document.body.append(elsewhere);
    await select(elsewhere, 'unrelated');
    expect(pill.classList.contains('hidden')).toBe(true);
  });

  it('offers no pill on an item with nothing to anchor to', () => {
    mountWalk(reviewQueue([], [threadRow()], NOW), walk());
    expect(root.querySelector('.hub-walk-body')).not.toBeNull();
    expect(root.querySelector('.hub-walk-pill')).toBeNull();
  });

  it('tapping the pill opens a thread card quoting the phrase; sending asks on it', async () => {
    const onAskOnItem = vi.fn().mockResolvedValue(true);
    const q = reviewQueue([], [ticketRow()], NOW);
    mountWalk(q, walk({ onAskOnItem }));
    await select(root.querySelector('.hub-walk-body') as HTMLElement, 'ships the other');
    (root.querySelector('.hub-walk-pill') as HTMLElement).click();
    await tick();
    const card = root.querySelector('.hub-walk-thread') as HTMLElement;
    expect(card).not.toBeNull();
    expect((card.querySelector('.hub-walk-thread-quote') as HTMLElement).textContent).toContain(
      'ships the other',
    );
    const form = card.querySelector('.hub-walk-thread-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Which other?';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onAskOnItem).toHaveBeenCalledWith(
      q.items[0],
      { text: 'ships the other' },
      'Which other?',
    );
    await tick();
    // The item STAYS on the card — no collapse, no advance — with the note.
    expect(root.querySelector('.hub-walk-card')).not.toBeNull();
    expect(root.querySelector('.hub-walk-thread')).toBeNull();
    const note = root.querySelector('.hub-walk-waiting') as HTMLElement;
    expect(note.textContent).toContain('Waiting on Helper');
    expect(note.textContent).toContain('Which other?');
    expect(root.querySelector('.hub-walk-answer')).not.toBeNull();
  });

  it('the thread card opens BESIDE the card, in its own margin column, not inside it', async () => {
    // The approved mock lays the walkthrough out as a two-column grid at
    // tablet/laptop widths: the card, and a margin column carrying the thread
    // (below the card at ≤1100px). That is a DOM fact before it is a CSS one:
    // the thread must be the stage's second child, never a child of the card.
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk());
    const stage = root.querySelector('.hub-walk-stage') as HTMLElement;
    expect(stage, 'the card sits on a stage').not.toBeNull();
    expect(stage.querySelector(':scope > .hub-walk-card')).not.toBeNull();
    // Nothing to the side until a phrase is asked on.
    expect(stage.querySelector(':scope > .hub-walk-margin')).toBeNull();
    await select(root.querySelector('.hub-walk-body') as HTMLElement, 'ships the other');
    (root.querySelector('.hub-walk-pill') as HTMLElement).click();
    await tick();
    const margin = stage.querySelector(':scope > .hub-walk-margin') as HTMLElement;
    expect(margin, 'the margin column appears with the thread').not.toBeNull();
    expect(margin.querySelector('.hub-walk-thread')).not.toBeNull();
    expect(root.querySelector('.hub-walk-card .hub-walk-thread')).toBeNull();
    // The margin follows the card in source order, so at ≤1100px (one
    // column) it stacks BELOW the card.
    expect(margin.previousElementSibling?.classList.contains('hub-walk-card')).toBe(true);
  });

  it('a refused ask keeps the thread card and the words', async () => {
    const onAskOnItem = vi.fn().mockResolvedValue(false);
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk({ onAskOnItem }));
    await select(root.querySelector('.hub-walk-body') as HTMLElement, 'ships the other');
    (root.querySelector('.hub-walk-pill') as HTMLElement).click();
    await tick();
    const form = root.querySelector('.hub-walk-thread-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Which other?';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(root.querySelector('.hub-walk-thread')).not.toBeNull();
    expect(root.querySelector('.hub-walk-waiting')).toBeNull();
    expect((form.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Which other?');
  });

  it('cancel puts the thread card away', async () => {
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk());
    await select(root.querySelector('.hub-walk-body') as HTMLElement, 'ships the other');
    (root.querySelector('.hub-walk-pill') as HTMLElement).click();
    await tick();
    (root.querySelector('.hub-walk-thread-cancel') as HTMLElement).click();
    await tick();
    expect(root.querySelector('.hub-walk-thread')).toBeNull();
  });

  it('the ask box keeps its draft across a repaint, like the answer box', async () => {
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk());
    await select(root.querySelector('.hub-walk-body') as HTMLElement, 'ships the other');
    (root.querySelector('.hub-walk-pill') as HTMLElement).click();
    await tick();
    const ta = root.querySelector('.hub-walk-thread-form textarea') as HTMLTextAreaElement;
    ta.value = 'Which oth';
    // A board event: the loader writes the signal, nothing is torn down.
    walkthroughData.value = { ...walkthroughData.value, now: NOW + 30_000 };
    await tick();
    const after = root.querySelector('.hub-walk-thread-form textarea') as HTMLTextAreaElement;
    expect(after).toBe(ta);
    expect(after.value).toBe('Which oth');
    expect(root.querySelector('.hub-walk-thread-quote')?.textContent).toContain('ships the other');
  });

  it('a held (waiting) item renders the note without any tap', () => {
    const q = reviewQueue([], [ticketRow()], NOW);
    const item = q.items[0] as ReviewItem;
    const held: ReviewQueue = {
      ...q,
      items: [{ ...item, waiting: { question: 'Which other?', owner: 'Helper' } }],
    };
    mountWalk(held, walk());
    const note = root.querySelector('.hub-walk-waiting') as HTMLElement;
    expect(note.textContent).toContain('Waiting on Helper');
    expect(root.querySelector('.hub-walk-thread')).toBeNull();
  });

  it('a held (waiting) item offers no pill, and a selection does nothing', async () => {
    const q = reviewQueue([], [ticketRow()], NOW);
    const item = q.items[0] as ReviewItem;
    const held: ReviewQueue = {
      ...q,
      items: [{ ...item, waiting: { question: 'Which other?', owner: 'Helper' } }],
    };
    mountWalk(held, walk());
    expect(root.querySelector('.hub-walk-pill')).toBeNull();
    await select(root.querySelector('.hub-walk-body') as HTMLElement, 'ships the other');
    expect(root.querySelector('.hub-walk-pill')).toBeNull();
    // The waiting note is unaffected by the selection.
    expect((root.querySelector('.hub-walk-waiting') as HTMLElement).textContent).toContain(
      'Waiting on Helper',
    );
  });

  it('after a successful ask the pill goes away for that item; a fresh item still gets one', async () => {
    const onAskOnItem = vi.fn().mockResolvedValue(true);
    const q = reviewQueue([], [ticketRow()], NOW);
    mountWalk(q, walk({ onAskOnItem }));
    await select(root.querySelector('.hub-walk-body') as HTMLElement, 'ships the other');
    expect(root.querySelector('.hub-walk-pill')).not.toBeNull();
    (root.querySelector('.hub-walk-pill') as HTMLElement).click();
    await tick();
    const form = root.querySelector('.hub-walk-thread-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Which other?';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    // Waiting now — no pill at all, and selecting again raises none.
    expect(root.querySelector('.hub-walk-pill')).toBeNull();
    await select(root.querySelector('.hub-walk-body') as HTMLElement, 'mockup shows');
    expect(root.querySelector('.hub-walk-pill')).toBeNull();

    // A fresh (not waiting) item still gets a pill.
    mountWalk(reviewQueue([], [ticketRow({ reviewItemId: 'r-2' })], NOW), walk());
    await select(root.querySelector('.hub-walk-body') as HTMLElement, 'ships the other');
    expect(root.querySelector('.hub-walk-pill')).not.toBeNull();
  });
});

describe('the walkthrough card: a revised item comes back marked', () => {
  it('shows the Revised badge, the question, the highlighted phrase and the way to the thread', () => {
    const onOpenThread = vi.fn();
    const q = reviewQueue([], [revisedRow()], NOW);
    mountWalk(q, walk({ onOpenThread }));
    expect((root.querySelector('.hub-walk-k-revised') as HTMLElement).textContent).toBe('Revised');
    expect((root.querySelector('.hub-walk-question') as HTMLElement).textContent).toContain(
      'Which other?',
    );
    const mark = root.querySelector('.hub-walk-body .thread-range.resolved') as HTMLElement;
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('the OTHER (blue)');
    // The words around the mark are untouched — highlighting is presentation.
    expect((root.querySelector('.hub-walk-body') as HTMLElement).textContent).toContain(
      'the build ships the OTHER (blue). Which do we keep?',
    );
    (root.querySelector('.hub-walk-thread-link') as HTMLElement).click();
    expect(onOpenThread).toHaveBeenCalledWith(q.items[0]);
    // No waiting note: it is the reader's turn again.
    expect(root.querySelector('.hub-walk-waiting')).toBeNull();
  });

  it('marks a revised phrase that crosses inline formatting, shedding the source’s markdown', () => {
    const detail = 'The mockup shows **one** and the build ships the OTHER. Which do we keep?';
    const start = detail.indexOf('**one** and');
    const row = revisedRow({
      review: { shape: 'review', headline: 'Green or blue?', detail },
      revisedRange: { start, end: start + '**one** and'.length },
    } as Partial<ReviewThreadItem>);
    mountWalk(reviewQueue([], [row], NOW), walk());
    const mark = root.querySelector('.hub-walk-body .thread-range.resolved') as HTMLElement;
    expect(mark).not.toBeNull();
    // The rendered words, across the <strong> boundary — two marks, one phrase.
    const marks = Array.from(root.querySelectorAll('.hub-walk-body .thread-range.resolved'));
    expect(marks.map((m) => m.textContent).join('')).toBe('one and');
    expect((root.querySelector('.hub-walk-body') as HTMLElement).textContent).toContain(
      'The mockup shows one and the build ships the OTHER.',
    );
  });

  it('an unknown range still quotes the question, with no mark', () => {
    mountWalk(reviewQueue([], [revisedRow({ revisedRange: undefined } as never)], NOW), walk());
    expect(root.querySelector('.hub-walk-k-revised')).not.toBeNull();
    expect(root.querySelector('.hub-walk-body .thread-range')).toBeNull();
    expect((root.querySelector('.hub-walk-question') as HTMLElement).textContent).toContain(
      'Which other?',
    );
  });

  it('an open item carries none of it', () => {
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk());
    expect(root.querySelector('.hub-walk-k-revised')).toBeNull();
    expect(root.querySelector('.hub-walk-question')).toBeNull();
    expect(root.querySelector('.hub-walk-thread-link')).toBeNull();
  });
});

describe('the Home queue row: a revised item', () => {
  it('wears the badge, quotes the question, and links to the thread without leaving the row', () => {
    const onReview = vi.fn();
    const onOpenThread = vi.fn();
    const q = reviewQueue([], [revisedRow()], NOW);
    mountHome(q, strip({ onReview, onOpenThread }));
    const row = root.querySelector('.hub-review-row') as HTMLElement;
    expect((row.querySelector('.hub-review-row-badge') as HTMLElement).textContent).toBe('Revised');
    expect((row.querySelector('.hub-review-row-quote') as HTMLElement).textContent).toContain(
      'Which other?',
    );
    (row.querySelector('.hub-review-thread-link') as HTMLElement).click();
    expect(onOpenThread).toHaveBeenCalledWith(q.items[0]);
    expect(onReview).not.toHaveBeenCalled();
    row.click();
    expect(onReview).toHaveBeenCalledWith(q.items[0], 0);
  });

  it('an open row carries none of it', () => {
    mountHome(reviewQueue([], [ticketRow()], NOW), strip());
    const row = root.querySelector('.hub-review-row') as HTMLElement;
    expect(row.querySelector('.hub-review-row-badge')).toBeNull();
    expect(row.querySelector('.hub-review-row-quote')).toBeNull();
    expect(row.querySelector('.hub-review-thread-link')).toBeNull();
  });
});
