/**
 * Asking a question on a review item (approved on the mock, 2026-08-29; the
 * link added 2026-08-31).
 *
 * The old "Tell me more" box is gone from the walkthrough card. Two ways to
 * ask stand in its place, and they make the SAME thread: select a phrase of
 * a ticket-borne item's detail and a comment pill appears, opening a thread
 * card that quotes the phrase; or tap "I have a question" and the card turns
 * into a question box, no selection needed — the thread then quotes the
 * item's headline. Either way the item is the owner's turn: it LEAVES the
 * queue on the loader's re-read and the next card takes its place (Bryan,
 * 2026-08-31: the card that stayed put with a "Waiting on…" note read as "I
 * hit submit and then nothing happens"). When the owner revises the item,
 * the queue shows it again marked Revised, quoting the question, with the
 * revised phrase highlighted and a way to the thread.
 *
 * All fixtures are synthetic — invented names and ids throughout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelReviewItem } from '../src/board/board-detail-render.ts';
import { type BoardTask, CHORES_ID } from '../src/board/board-model.ts';
import {
  type ReviewItem,
  type ReviewQueue,
  type ReviewThreadItem,
  decisionRows,
  reviewItemAskRequest,
  reviewItemQuestionRequest,
  reviewQueue,
  revisedPhrase,
  wholeItemPhrase,
} from '../src/board/board-review-model.ts';
import {
  type ReviewStripHandlers,
  homeReviewData,
  mountHomeReviewIsland,
} from '../src/board/home-review-island.tsx';
import { taskDetailData } from '../src/board/task-detail-island.tsx';
import {
  type WalkthroughHandlers,
  type WalkthroughView,
  mountWalkthroughIsland,
  walkthroughData,
} from '../src/board/walkthrough-island.tsx';
import {
  type Booted,
  WS,
  boardRow,
  bootTestBoard,
  resetBoardServer,
  server,
  settle as settleBoot,
} from './support/board-drive.ts';

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
    onQuestionOnItem: vi.fn(),
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
  // The board every route in this file is built under — `api()` reads it off
  // the address bar, and the boot harness puts the same one there.
  history.replaceState(null, '', `/workspaces/${WS}/home`);
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
      path: `/workspaces/${WS}/docs/task%3Atk-1/threads`,
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

  it('a question about the whole item goes to the SAME route, quoting the headline', () => {
    // The link has no phrase to pin the question on, and the thread still
    // needs one to quote — the headline is what the item IS. Same shape the
    // server itself makes when a question is typed into the answer box, so
    // the two whole-item asks land identically.
    const q = reviewQueue([], [ticketRow()], NOW);
    const item = q.items[0] as ReviewItem;
    expect(wholeItemPhrase(item)).toBe('Green or blue?');
    expect(reviewItemQuestionRequest(item, 'Which other?')).toEqual(
      reviewItemAskRequest(item, 'Green or blue?', 'Which other?'),
    );
    expect(reviewItemQuestionRequest(item, 'Which other?')?.path).toBe(
      `/workspaces/${WS}/docs/task%3Atk-1/threads`,
    );
    // Not the more-info route: that one records no thread, and only a
    // THREADED question takes the item off the queue (`reviewItemState`).
    expect(reviewItemQuestionRequest(item, 'x')?.path).not.toContain('more-info');
    // Nowhere to send it on a thread-borne item, same as the phrase flow.
    const t = reviewQueue([], [threadRow()], NOW);
    expect(reviewItemQuestionRequest(t.items[0] as ReviewItem, 'x')).toBeNull();
  });
});

describe('the walkthrough card: select a phrase, ask on it, wait', () => {
  it('the "Tell me more" box is gone from every card', () => {
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk());
    expect(root.querySelector('.board-walk-info')).toBeNull();
    expect(root.querySelector('.board-walk-more')).toBeNull();
  });

  it('a pill appears when a phrase of the detail is selected, and hides when it is not', async () => {
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk());
    const pill = root.querySelector('.board-walk-pill') as HTMLElement;
    expect(pill).not.toBeNull();
    expect(pill.classList.contains('comment-pill')).toBe(true);
    expect(pill.classList.contains('hidden')).toBe(true);
    await select(root.querySelector('.board-walk-body') as HTMLElement, 'ships the other');
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
    expect(root.querySelector('.board-walk-body')).not.toBeNull();
    expect(root.querySelector('.board-walk-pill')).toBeNull();
  });

  it('tapping the pill opens a thread card quoting the phrase; sending asks on it', async () => {
    const onAskOnItem = vi.fn().mockResolvedValue(true);
    const q = reviewQueue([], [ticketRow()], NOW);
    mountWalk(q, walk({ onAskOnItem }));
    await select(root.querySelector('.board-walk-body') as HTMLElement, 'ships the other');
    (root.querySelector('.board-walk-pill') as HTMLElement).click();
    await tick();
    const card = root.querySelector('.board-walk-thread') as HTMLElement;
    expect(card).not.toBeNull();
    expect((card.querySelector('.board-walk-thread-quote') as HTMLElement).textContent).toContain(
      'ships the other',
    );
    const form = card.querySelector('.board-walk-thread-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Which other?';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onAskOnItem).toHaveBeenCalledWith(
      q.items[0],
      { text: 'ships the other' },
      'Which other?',
    );
    await tick();
    // The thread card closes. The island holds NOTHING back: whether the
    // card stays is the queue's call, and the loader's re-read drops an
    // asked-on item (see "the card leaves the queue" below). No note
    // either — the toast carries the word, and the card is gone.
    expect(root.querySelector('.board-walk-thread')).toBeNull();
    expect(root.querySelector('.board-walk-waiting')).toBeNull();
  });

  it('the thread card opens BESIDE the card, in its own margin column, not inside it', async () => {
    // The approved mock lays the walkthrough out as a two-column grid at
    // tablet/laptop widths: the card, and a margin column carrying the thread
    // (below the card at ≤1100px). That is a DOM fact before it is a CSS one:
    // the thread must be the stage's second child, never a child of the card.
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk());
    const stage = root.querySelector('.board-walk-stage') as HTMLElement;
    expect(stage, 'the card sits on a stage').not.toBeNull();
    expect(stage.querySelector(':scope > .board-walk-card')).not.toBeNull();
    // Nothing to the side until a phrase is asked on — and no column reserved
    // for it either: the stage only widens to two columns while it is open.
    expect(stage.querySelector(':scope > .board-walk-margin')).toBeNull();
    expect(stage.classList.contains('board-walk-stage-open')).toBe(false);
    await select(root.querySelector('.board-walk-body') as HTMLElement, 'ships the other');
    (root.querySelector('.board-walk-pill') as HTMLElement).click();
    await tick();
    const margin = stage.querySelector(':scope > .board-walk-margin') as HTMLElement;
    expect(margin, 'the margin column appears with the thread').not.toBeNull();
    expect(stage.classList.contains('board-walk-stage-open')).toBe(true);
    expect(margin.querySelector('.board-walk-thread')).not.toBeNull();
    expect(root.querySelector('.board-walk-card .board-walk-thread')).toBeNull();
    // The margin follows the card in source order, so at ≤1100px (one
    // column) it stacks BELOW the card.
    expect(margin.previousElementSibling?.classList.contains('board-walk-card')).toBe(true);
  });

  it('a refused ask keeps the thread card and the words', async () => {
    const onAskOnItem = vi.fn().mockResolvedValue(false);
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk({ onAskOnItem }));
    await select(root.querySelector('.board-walk-body') as HTMLElement, 'ships the other');
    (root.querySelector('.board-walk-pill') as HTMLElement).click();
    await tick();
    const form = root.querySelector('.board-walk-thread-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Which other?';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(root.querySelector('.board-walk-thread')).not.toBeNull();
    expect(root.querySelector('.board-walk-waiting')).toBeNull();
    expect((form.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Which other?');
  });

  it('cancel puts the thread card away', async () => {
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk());
    await select(root.querySelector('.board-walk-body') as HTMLElement, 'ships the other');
    (root.querySelector('.board-walk-pill') as HTMLElement).click();
    await tick();
    (root.querySelector('.board-walk-thread-cancel') as HTMLElement).click();
    await tick();
    expect(root.querySelector('.board-walk-thread')).toBeNull();
  });

  it('the ask box keeps its draft across a repaint, like the answer box', async () => {
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk());
    await select(root.querySelector('.board-walk-body') as HTMLElement, 'ships the other');
    (root.querySelector('.board-walk-pill') as HTMLElement).click();
    await tick();
    const ta = root.querySelector('.board-walk-thread-form textarea') as HTMLTextAreaElement;
    ta.value = 'Which oth';
    // A board event: the loader writes the signal, nothing is torn down.
    walkthroughData.value = { ...walkthroughData.value, now: NOW + 30_000 };
    await tick();
    const after = root.querySelector('.board-walk-thread-form textarea') as HTMLTextAreaElement;
    expect(after).toBe(ta);
    expect(after.value).toBe('Which oth');
    expect(root.querySelector('.board-walk-thread-quote')?.textContent).toContain(
      'ships the other',
    );
  });

  it('the card leaves the queue in the same interaction: the loader’s re-read drops it and the next card takes its place', async () => {
    // What `askOnReviewItem` does after a landed write is re-read the queue;
    // the server has dropped the waiting item, so the re-read arrives
    // without it. The island is keyed on the item, so the asked-on card
    // unmounts and the one that was next stands at the same position — no
    // hold, no "Waiting on…" copy kept in front of the reader.
    const q = reviewQueue([], [ticketRow(), ticketRow({ reviewItemId: 'r-2' })], NOW);
    const after = reviewQueue([], [ticketRow({ reviewItemId: 'r-2' })], NOW);
    const onAskOnItem = vi.fn().mockImplementation(async () => {
      walkthroughData.value = { ...walkthroughData.value, queue: after };
      return true;
    });
    mountWalk(q, walk({ onAskOnItem }));
    await select(root.querySelector('.board-walk-body') as HTMLElement, 'ships the other');
    (root.querySelector('.board-walk-pill') as HTMLElement).click();
    await tick();
    const form = root.querySelector('.board-walk-thread-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Which other?';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(onAskOnItem).toHaveBeenCalledTimes(1);
    const card = root.querySelector('.board-walk-card') as HTMLElement;
    expect(card).not.toBeNull();
    // The card on screen is r-2's — the asked-on one is gone, not held.
    expect(card.querySelector('.board-walk-answer textarea')?.getAttribute('data-keep')).toBe(
      'walk-answer:task-review:tk-1:r-2',
    );
    expect(root.querySelector('.board-walk-waiting')).toBeNull();
    expect(root.querySelector('.board-walk-thread')).toBeNull();
    // Nothing about the queue is faked: the stepper counts the server's one.
    expect((root.querySelector('.board-walk-nav') as HTMLElement).textContent).toContain('1 of 1');
    // Asking on the LAST item lands on the finished screen — not a stale card.
    const onlyOne = reviewQueue([], [ticketRow()], NOW);
    const empty = reviewQueue([], [], NOW);
    mountWalk(
      onlyOne,
      walk({
        onAskOnItem: vi.fn().mockImplementation(async () => {
          walkthroughData.value = { ...walkthroughData.value, queue: empty };
          return true;
        }),
      }),
    );
    await select(root.querySelector('.board-walk-body') as HTMLElement, 'ships the other');
    (root.querySelector('.board-walk-pill') as HTMLElement).click();
    await tick();
    const last = root.querySelector('.board-walk-thread-form') as HTMLFormElement;
    (last.querySelector('textarea') as HTMLTextAreaElement).value = 'Which other?';
    last.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(root.querySelector('.board-walk-card')).toBeNull();
    expect(root.querySelector('.board-walk-done')).not.toBeNull();
  });
});

describe('the walkthrough card: "I have a question" — asking without selecting a phrase', () => {
  const link = () => root.querySelector('.board-walk-question-link') as HTMLElement | null;
  const box = () => root.querySelector('.board-walk-question-box') as HTMLElement | null;
  const answering = () => root.querySelector('.board-walk-answering') as HTMLElement;

  it('every ticket-borne card shows the link, beside Skip', () => {
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk());
    const l = link();
    expect(l).not.toBeNull();
    expect(l?.textContent).toBe('I have a question');
    expect(l?.closest('.board-walk-actions')).not.toBeNull();
    expect(
      l?.closest('.board-walk-actions')?.querySelector('.board-walk-skip-link'),
    ).not.toBeNull();
    // A revised item coming back is a fresh ask: it gets the link too.
    mountWalk(reviewQueue([], [revisedRow()], NOW), walk());
    expect(link()).not.toBeNull();
  });

  it('no link on an item with nowhere for a question to land', () => {
    mountWalk(reviewQueue([], [threadRow()], NOW), walk());
    expect(root.querySelector('.board-walk-answer')).not.toBeNull();
    expect(link()).toBeNull();
  });

  it('tapping it turns the card into a question box: textarea, Send, Cancel — no selection needed', async () => {
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk());
    expect(box()).toBeNull();
    expect(answering().classList.contains('hidden')).toBe(false);
    link()?.click();
    await tick();
    const b = box();
    expect(b).not.toBeNull();
    expect(b?.querySelector('.board-walk-question-form textarea')).not.toBeNull();
    expect(b?.querySelector('.board-walk-question-form button[type="submit"]')?.textContent).toBe(
      'Send',
    );
    expect(b?.querySelector('.board-walk-question-cancel')?.textContent).toBe('Cancel');
    expect(b?.querySelector('.board-walk-question-hint')?.textContent).toContain('Ask Helper');
    // The box stands IN the card, where the answer furniture was — which is
    // hidden rather than gone (a half-typed answer survives), and the phrase
    // pill is off while the box is up: one way of asking at a time.
    expect(b?.closest('.board-walk-card')).not.toBeNull();
    expect(answering().classList.contains('hidden')).toBe(true);
    expect(root.querySelector('.board-walk-answer')).not.toBeNull();
    expect(root.querySelector('.board-walk-pill')).toBeNull();
    expect(root.querySelector('.board-walk-thread')).toBeNull();
  });

  it('opening the box puts the caret in it — the link that opened it has left the tab order', async () => {
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk());
    // Control: before the tap nothing on the card holds focus.
    expect(document.activeElement).toBe(document.body);
    link()?.click();
    await tick();
    // The caret is in the box's field — the editor's surface once the editor
    // has mounted (it has, here), the textarea until then.
    const form = box()?.querySelector<HTMLFormElement>('.board-walk-question-form');
    expect(form).not.toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(form?.contains(document.activeElement)).toBe(true);
  });

  it('Send on an empty box says so instead of doing nothing', async () => {
    const onQuestionOnItem = vi.fn().mockResolvedValue(true);
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk({ onQuestionOnItem }));
    link()?.click();
    await tick();
    const form = box()?.querySelector<HTMLFormElement>('.board-walk-question-form');
    expect(form).not.toBeNull();
    expect(form?.querySelector('.board-form-error')).toBeNull();
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    expect(onQuestionOnItem).not.toHaveBeenCalled();
    expect(form?.querySelector('.board-form-error')?.textContent).toBe('Write a question first');
    // The note goes the moment the reader starts typing.
    const ta = form?.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'W';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(form?.querySelector('.board-form-error')).toBeNull();
    // Positive control: the same submit with words in the box reaches the handler.
    ta.value = 'Which build?';
    form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    expect(onQuestionOnItem).toHaveBeenCalledTimes(1);
  });

  it('Send asks about the whole item — the question handler, with the item and the words', async () => {
    const onQuestionOnItem = vi.fn().mockResolvedValue(true);
    const onAskOnItem = vi.fn().mockResolvedValue(true);
    const q = reviewQueue([], [ticketRow()], NOW);
    mountWalk(q, walk({ onQuestionOnItem, onAskOnItem }));
    link()?.click();
    await tick();
    const form = root.querySelector('.board-walk-question-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Which other?';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onQuestionOnItem).toHaveBeenCalledWith(q.items[0], 'Which other?');
    // Not through the phrase handler: there is no phrase.
    expect(onAskOnItem).not.toHaveBeenCalled();
    await tick();
    // The box closes and the answer furniture is back — for the case where
    // the card is still here; normally the loader's re-read removes it.
    expect(box()).toBeNull();
    expect(answering().classList.contains('hidden')).toBe(false);
  });

  it('the card leaves the queue in the same interaction, exactly as the phrase flow does', async () => {
    const q = reviewQueue([], [ticketRow(), ticketRow({ reviewItemId: 'r-2' })], NOW);
    const after = reviewQueue([], [ticketRow({ reviewItemId: 'r-2' })], NOW);
    const onQuestionOnItem = vi.fn().mockImplementation(async () => {
      walkthroughData.value = { ...walkthroughData.value, queue: after };
      return true;
    });
    mountWalk(q, walk({ onQuestionOnItem }));
    link()?.click();
    await tick();
    const form = root.querySelector('.board-walk-question-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Which other?';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    const card = root.querySelector('.board-walk-card') as HTMLElement;
    expect(card.querySelector('.board-walk-answer textarea')?.getAttribute('data-keep')).toBe(
      'walk-answer:task-review:tk-1:r-2',
    );
    // The next card arrives in answer mode, its own link ready.
    expect(box()).toBeNull();
    expect(link()).not.toBeNull();
    expect(root.querySelector('.board-walk-waiting')).toBeNull();
  });

  it('a refused send keeps the box and the words', async () => {
    const onQuestionOnItem = vi.fn().mockResolvedValue(false);
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk({ onQuestionOnItem }));
    link()?.click();
    await tick();
    const form = root.querySelector('.board-walk-question-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Which other?';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await tick();
    expect(box()).not.toBeNull();
    expect((form.querySelector('textarea') as HTMLTextAreaElement).value).toBe('Which other?');
  });

  it('Cancel puts the box away and the answer furniture back, draft intact', async () => {
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk());
    const answer = root.querySelector('.board-walk-answer textarea') as HTMLTextAreaElement;
    answer.value = 'Blue, I think';
    link()?.click();
    await tick();
    (root.querySelector('.board-walk-question-cancel') as HTMLElement).click();
    await tick();
    expect(box()).toBeNull();
    expect(answering().classList.contains('hidden')).toBe(false);
    const after = root.querySelector('.board-walk-answer textarea') as HTMLTextAreaElement;
    expect(after).toBe(answer);
    expect(after.value).toBe('Blue, I think');
  });

  it('the question box keeps its draft across a repaint, like the answer box', async () => {
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk());
    link()?.click();
    await tick();
    const ta = root.querySelector('.board-walk-question-form textarea') as HTMLTextAreaElement;
    ta.value = 'Which oth';
    walkthroughData.value = { ...walkthroughData.value, now: NOW + 30_000 };
    await tick();
    const after = root.querySelector('.board-walk-question-form textarea') as HTMLTextAreaElement;
    expect(after).toBe(ta);
    expect(after.value).toBe('Which oth');
  });

  it('POSITIVE CONTROL: the phrase flow still submits through the phrase handler', async () => {
    const onAskOnItem = vi.fn().mockResolvedValue(true);
    const onQuestionOnItem = vi.fn().mockResolvedValue(true);
    const q = reviewQueue([], [ticketRow()], NOW);
    mountWalk(q, walk({ onAskOnItem, onQuestionOnItem }));
    await select(root.querySelector('.board-walk-body') as HTMLElement, 'ships the other');
    (root.querySelector('.board-walk-pill') as HTMLElement).click();
    await tick();
    const form = root.querySelector('.board-walk-thread-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Which other?';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(onAskOnItem).toHaveBeenCalledWith(
      q.items[0],
      { text: 'ships the other' },
      'Which other?',
    );
    expect(onQuestionOnItem).not.toHaveBeenCalled();
  });
});

// ── The boot, driven ───────────────────────────────────────────────────────
//
// This used to be read out of the boot's source: the two card surfaces were
// pinned by the arrow they were declared with, and the panel's by the name of
// the function it called. What is asserted below instead is the request each
// surface actually put on the wire, the toast it raised, and the queue it
// left behind — the whole of "one POST, and nothing held back", driven.
describe('every asking surface makes the same request and lets the item go', () => {
  /** A ticket-borne item: the only kind with an anchor to ask on. */
  const TICKET: ReviewThreadItem = {
    kind: 'task-review',
    taskId: 't-1',
    reviewItemId: 'r-1',
    docId: '',
    threadId: '',
    title: 'Fit the hob',
    ask: 'Which hob?',
    askedBy: 'Helper',
    since: NOW - 60_000,
    band: 'declared',
    review: {
      shape: 'review',
      headline: 'Ship the blue one',
      detail: 'the build ships the OTHER (blue).',
    },
  };
  const THREAD_PATH = `/workspaces/${WS}/docs/task%3At-1/threads`;

  beforeEach(() => {
    resetBoardServer();
    server.on(`/workspaces/${WS}/review-items`, { items: [TICKET] });
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  /** Boot into a sitting on the ticket item, and arrange for the re-read
   *  after the write to answer the way the server would: it is the owner's
   *  turn now, so the item is not on the queue any more. */
  async function sitting(): Promise<{ board: Booted; view: WalkthroughView; item: ReviewItem }> {
    const board = await bootTestBoard({
      url: `https://board.test/workspaces/${WS}/home?walk=1`,
      tasks: [boardRow('t-1', { title: 'Fit the hob' })],
    });
    const view = walkthroughData.value;
    const item = view.queue.items[view.index];
    if (!item) throw new Error('the sitting opened on nothing');
    server.on(`/workspaces/${WS}/review-items`, { items: [] });
    return { board, view, item };
  }

  const posts = () => server.calls.filter((c) => c.method === 'POST' && c.url === THREAD_PATH);
  const toast = () => document.getElementById('board-toast')?.textContent ?? '';

  it('the selection pill asks on the phrase, and the item leaves the queue', async () => {
    const { view, item } = await sitting();
    await view.handlers.onAskOnItem(item, { text: 'the OTHER (blue)' }, 'Which other?');
    await settleBoot();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.body).toMatchObject({
      text: 'Which other?',
      anchor: { kind: 'review-item', reviewItemId: 'r-1', snippet: { text: 'the OTHER (blue)' } },
    });
    // The re-read is what takes the item off every surface, so it has to
    // follow the write rather than merely happen sometime.
    const after = server.calls.slice(server.calls.findIndex((c) => c.url === THREAD_PATH));
    expect(after.some((c) => c.url.endsWith('/review-items'))).toBe(true);
    // Nothing held back: no card, no waiting note, and the toast is the only
    // thing left saying where the question went.
    expect(walkthroughData.value.queue.items).toHaveLength(0);
    expect(document.querySelector('.board-walk-waiting')).toBeNull();
    expect(toast()).toBe(
      'Asked — waiting on Helper. It comes back to your queue when they revise it.',
    );
  });

  it('“I have a question” makes the same request, quoting the headline', async () => {
    const { view, item } = await sitting();
    await view.handlers.onQuestionOnItem(item, 'Which other?');
    await settleBoot();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.body).toMatchObject({
      text: 'Which other?',
      anchor: { kind: 'review-item', reviewItemId: 'r-1', snippet: { text: 'Ship the blue one' } },
    });
    expect(walkthroughData.value.queue.items).toHaveLength(0);
  });

  it('the task panel’s card goes through the same POST', async () => {
    const { board, view } = await sitting();
    const task = boardRow('t-1', { title: 'Fit the hob' });
    const panelItem: PanelReviewItem = {
      id: 'r-1',
      source: 'task-review',
      shape: 'review',
      headline: 'Ship the blue one',
      detail: 'the build ships the OTHER (blue).',
      askedBy: 'Helper',
      since: NOW - 60_000,
      reviewItemId: 'r-1',
      declared: true,
    };
    // The panel's handler, off the panel's own view — the walkthrough is only
    // here because booting into it is how this board gets a queue.
    const ask = taskDetailData.value.handlers.onAskOnPanelItem;
    expect(ask, 'the panel wires no asking handler').toBeTruthy();
    await ask?.(task, panelItem, 'Which other?');
    await settleBoot();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.body).toMatchObject({
      text: 'Which other?',
      anchor: { kind: 'review-item', reviewItemId: 'r-1', snippet: { text: 'Ship the blue one' } },
    });
    expect(toast()).toContain('waiting on Helper');
    expect(view.queue.items).toHaveLength(1); // the paint that opened, untouched
    expect(board.location.navigations).toEqual([]);
  });
});

describe('the walkthrough card: a revised item comes back marked', () => {
  it('shows the Revised badge, the question, the highlighted phrase and the way to the thread', () => {
    const onOpenThread = vi.fn();
    const q = reviewQueue([], [revisedRow()], NOW);
    mountWalk(q, walk({ onOpenThread }));
    expect((root.querySelector('.board-walk-k-revised') as HTMLElement).textContent).toBe(
      'Revised',
    );
    expect((root.querySelector('.board-walk-question') as HTMLElement).textContent).toContain(
      'Which other?',
    );
    const mark = root.querySelector('.board-walk-body .thread-range.resolved') as HTMLElement;
    expect(mark).not.toBeNull();
    expect(mark.textContent).toBe('the OTHER (blue)');
    // The words around the mark are untouched — highlighting is presentation.
    expect((root.querySelector('.board-walk-body') as HTMLElement).textContent).toContain(
      'the build ships the OTHER (blue). Which do we keep?',
    );
    (root.querySelector('.board-walk-thread-link') as HTMLElement).click();
    expect(onOpenThread).toHaveBeenCalledWith(q.items[0]);
    // No waiting note: it is the reader's turn again.
    expect(root.querySelector('.board-walk-waiting')).toBeNull();
  });

  it('marks a revised phrase that crosses inline formatting, shedding the source’s markdown', () => {
    const detail = 'The mockup shows **one** and the build ships the OTHER. Which do we keep?';
    const start = detail.indexOf('**one** and');
    const row = revisedRow({
      review: { shape: 'review', headline: 'Green or blue?', detail },
      revisedRange: { start, end: start + '**one** and'.length },
    } as Partial<ReviewThreadItem>);
    mountWalk(reviewQueue([], [row], NOW), walk());
    const mark = root.querySelector('.board-walk-body .thread-range.resolved') as HTMLElement;
    expect(mark).not.toBeNull();
    // The rendered words, across the <strong> boundary — two marks, one phrase.
    const marks = Array.from(root.querySelectorAll('.board-walk-body .thread-range.resolved'));
    expect(marks.map((m) => m.textContent).join('')).toBe('one and');
    expect((root.querySelector('.board-walk-body') as HTMLElement).textContent).toContain(
      'The mockup shows one and the build ships the OTHER.',
    );
  });

  it('an unknown range still quotes the question, with no mark', () => {
    mountWalk(reviewQueue([], [revisedRow({ revisedRange: undefined } as never)], NOW), walk());
    expect(root.querySelector('.board-walk-k-revised')).not.toBeNull();
    expect(root.querySelector('.board-walk-body .thread-range')).toBeNull();
    expect((root.querySelector('.board-walk-question') as HTMLElement).textContent).toContain(
      'Which other?',
    );
  });

  it('an open item carries none of it', () => {
    mountWalk(reviewQueue([], [ticketRow()], NOW), walk());
    expect(root.querySelector('.board-walk-k-revised')).toBeNull();
    expect(root.querySelector('.board-walk-question')).toBeNull();
    expect(root.querySelector('.board-walk-thread-link')).toBeNull();
  });
});

/** A ticket filed with `needs: 'decision'` — the card whose only exit was Skip. */
function decisionTask(over: Partial<BoardTask> = {}): BoardTask {
  return {
    id: 'tk-9',
    title: 'Pick a retry budget',
    status: 'todo',
    assignee: 'human',
    needs: 'decision',
    goal: CHORES_ID,
    order: 1,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: 'task:tk-9',
    createdAt: NOW - 120_000,
    createdBy: 'Poller Bot',
    updatedAt: NOW - 120_000,
    body: 'Three tries costs a minute per failure; once loses the row on a blip.',
    options: [
      { id: 'o-3', label: 'Three' },
      { id: 'o-1', label: 'Once' },
    ],
    ...over,
  } as BoardTask;
}

describe('the model: a ticket’s own decision asks, waits and comes back like any item', () => {
  it('a question about the decision goes to the threads route anchored to r-legacy, quoting the title', () => {
    const [item] = reviewQueue([decisionTask()], [], NOW).items;
    expect(item?.kind).toBe('decision');
    expect(wholeItemPhrase(item as ReviewItem)).toBe('Pick a retry budget');
    expect(reviewItemQuestionRequest(item as ReviewItem, 'What does a blip cost?')).toEqual({
      path: `/workspaces/${WS}/docs/task%3Atk-9/threads`,
      body: {
        text: 'What does a blip cost?',
        anchor: {
          kind: 'review-item',
          reviewItemId: 'r-legacy',
          snippet: { text: 'Pick a retry budget' },
        },
      },
    });
  });

  it('a WAITING decision is off the queue; a REVISED one is on it, marked and quoting the question', () => {
    expect(decisionRows([decisionTask({ decisionState: 'waiting' })])).toEqual([]);
    expect(reviewQueue([decisionTask({ decisionState: 'waiting' })], [], NOW).items).toEqual([]);
    // Control: open, and answered, read as before.
    expect(decisionRows([decisionTask()]).length).toBe(1);
    expect(
      decisionRows([decisionTask({ answer: { text: 'Three', by: 'Jordan', ts: NOW } })]),
    ).toEqual([]);
    const revised = decisionTask({
      decisionState: 'revised',
      decisionRevision: {
        at: NOW - 30_000,
        question: 'What does a blip cost?',
        threadId: 'th-9',
        range: { start: 0, end: 5 },
      },
    });
    const [item] = reviewQueue([revised], [], NOW).items;
    expect(item?.revision).toEqual({
      at: NOW - 30_000,
      question: 'What does a blip cost?',
      threadId: 'th-9',
      range: { start: 0, end: 5 },
    });
  });
});

describe('the walkthrough card: a ticket’s own decision offers the link too', () => {
  const link = () => root.querySelector('.board-walk-question-link') as HTMLElement | null;
  const box = () => root.querySelector('.board-walk-question-box') as HTMLElement | null;
  const note = () => root.querySelector('.board-walk-question-note') as HTMLElement | null;

  it('shows "I have a question" beside Skip on the decision card', () => {
    mountWalk(reviewQueue([decisionTask()], [], NOW), walk());
    expect(root.querySelector('.board-walk-decision')).not.toBeNull();
    const l = link();
    expect(l?.textContent).toBe('I have a question');
    expect(
      l?.closest('.board-walk-actions')?.querySelector('.board-walk-skip-link'),
    ).not.toBeNull();
    expect(note()).toBeNull();
  });

  it('tapping it opens the question box in place of the answer furniture; Send asks about the decision', async () => {
    const onQuestionOnItem = vi.fn().mockResolvedValue(true);
    const onAnswer = vi.fn();
    const q = reviewQueue([decisionTask()], [], NOW);
    mountWalk(q, walk({ onQuestionOnItem, onAnswer }));
    link()?.click();
    await tick();
    const b = box();
    expect(b).not.toBeNull();
    expect(b?.querySelector('.board-walk-question-hint')?.textContent).toContain('Ask Poller Bot');
    expect(root.querySelector('.board-walk-answering')?.classList.contains('hidden')).toBe(true);
    const form = b?.querySelector('.board-walk-question-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'What does a blip cost?';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    expect(onQuestionOnItem).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'decision' }),
      'What does a blip cost?',
    );
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('a revised decision comes back marked, quoting the question, with the way to the thread', () => {
    const onOpenThread = vi.fn();
    const q = reviewQueue(
      [
        decisionTask({
          decisionState: 'revised',
          decisionRevision: {
            at: NOW - 30_000,
            question: 'What does a blip cost?',
            threadId: 'th-9',
          },
        }),
      ],
      [],
      NOW,
    );
    mountWalk(q, walk({ onOpenThread }));
    expect(root.querySelector('.board-walk-k-revised')?.textContent).toBe('Revised');
    expect(root.querySelector('.board-walk-question-text')?.textContent).toContain(
      'What does a blip cost?',
    );
    (root.querySelector('.board-walk-thread-link') as HTMLElement).click();
    expect(onOpenThread).toHaveBeenCalledWith(q.items[0]);
    // A fresh ask again: the link is there.
    expect(link()).not.toBeNull();
  });

  it('CONTROL: a thread-borne card gets no link, and one line saying where its questions go', () => {
    mountWalk(reviewQueue([], [threadRow()], NOW), walk());
    expect(link()).toBeNull();
    expect(note()?.textContent).toContain('Reply above');
    expect(note()?.closest('.board-walk-actions')).not.toBeNull();
  });
});

describe('the Home queue row: a revised item', () => {
  it('wears the badge, quotes the question, and links to the thread without leaving the row', () => {
    const onReview = vi.fn();
    const onOpenThread = vi.fn();
    const q = reviewQueue([], [revisedRow()], NOW);
    mountHome(q, strip({ onReview, onOpenThread }));
    const row = root.querySelector('.board-review-row') as HTMLElement;
    expect((row.querySelector('.board-review-row-badge') as HTMLElement).textContent).toBe(
      'Revised',
    );
    expect((row.querySelector('.board-review-row-quote') as HTMLElement).textContent).toContain(
      'Which other?',
    );
    (row.querySelector('.board-review-thread-link') as HTMLElement).click();
    expect(onOpenThread).toHaveBeenCalledWith(q.items[0]);
    expect(onReview).not.toHaveBeenCalled();
    row.click();
    expect(onReview).toHaveBeenCalledWith(q.items[0], 0);
  });

  it('an open row carries none of it', () => {
    mountHome(reviewQueue([], [ticketRow()], NOW), strip());
    const row = root.querySelector('.board-review-row') as HTMLElement;
    expect(row.querySelector('.board-review-row-badge')).toBeNull();
    expect(row.querySelector('.board-review-row-quote')).toBeNull();
    expect(row.querySelector('.board-review-thread-link')).toBeNull();
  });
});
