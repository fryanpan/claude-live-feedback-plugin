import type { Comment, ReviewPayload, Thread, User } from '@feedback/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ThreadPanel } from '../src/threads.ts';

/**
 * How a WITHDRAWN review item reads in the doc's thread pane.
 *
 * This is the only surface a retracted ask appears on at all — the queue drops
 * it and `pendingDeclaration` steps over it — so if it renders here as an
 * ordinary question, the reader answers a question nobody is asking. That is
 * the exact failure the verb exists to prevent: the words stay because
 * somebody may already have read them, and the marking is what turns them
 * from a live ask into history.
 *
 * The other half is the fallback card. A thread's item card falls back to the
 * newest declaration when nothing is pending, and a withdrawn one must not be
 * it — otherwise the card shows a retracted ask while the queue offers a live
 * one from the same thread.
 */

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };

let ts = 1_700_000_000_000;
function comment(text: string, review?: ReviewPayload): Comment {
  ts += 1000;
  return { id: `c${ts}`, author: alice, text, ts, ...(review ? { review } : {}) };
}

function thread(comments: Comment[], over: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    status: 'open',
    anchor: { kind: 'element', fingerprint: undefined as never, snippet: { text: 'anchor' } },
    commentCount: comments.length,
    lastActivity: comments[comments.length - 1]?.ts ?? ts,
    createdBy: alice,
    comments,
    ...over,
  };
}

const ask = (over: Partial<ReviewPayload> = {}): ReviewPayload => ({
  shape: 'review',
  headline: 'Should the call to action move above the gallery?',
  detail: 'At 430px it falls below the fold.',
  ...over,
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

function render(t: Thread): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  cleanups.push(() => container.remove());
  const panel = new ThreadPanel({
    container,
    currentUser: alice,
    onThreadClick: () => {},
    onReply: () => {},
    onResolve: () => {},
    onReopen: () => {},
    onReanchor: () => {},
  });
  const card = panel.renderThread(t);
  container.appendChild(card);
  return card;
}

const headerOf = (card: HTMLElement) => card.querySelector<HTMLElement>('.comment-review');
const withdrawnHeaders = (card: HTMLElement) =>
  card.querySelectorAll<HTMLElement>('.comment-review-withdrawn');

describe('a withdrawn declaration in the thread pane', () => {
  it('says Withdrawn where a live one says Question', () => {
    // A live ask is carried by the item card, which suppresses the header on
    // the comment row so the question is not stated twice. A withdrawn one has
    // no card, so the row header IS its only appearance — which is exactly why
    // that header has to say what it is.
    const live = render(thread([comment('Have a look', ask())]));
    expect(withdrawnHeaders(live).length).toBe(0);

    const gone = render(
      thread([comment('Have a look', ask({ withdrawnAt: ts, withdrawnBy: 'Cartographer' }))]),
    );
    const header = gone.querySelector<HTMLElement>('.comment-review-withdrawn');
    expect(header?.querySelector('.comment-review-k')?.textContent).toBe('Withdrawn');
    expect(headerOf(gone)).toBe(header);
  });

  it('names who took it back, and why when they said', () => {
    const card = render(
      thread([
        comment(
          'Have a look',
          ask({
            withdrawnAt: ts,
            withdrawnBy: 'Cartographer',
            withdrawnReason: 'Superseded — I measured it wrong.',
          }),
        ),
      ]),
    );
    const note = card.querySelector<HTMLElement>('.comment-review-withdrawn-note');
    expect(note?.textContent).toBe('Withdrawn by Cartographer — Superseded — I measured it wrong.');
  });

  it('still shows the words, because a reader may already have read them', () => {
    const card = render(
      thread([comment('Have a look', ask({ withdrawnAt: ts, withdrawnBy: 'Cartographer' }))]),
    );
    expect(card.textContent).toContain('Should the call to action move above the gallery?');
  });

  it('says nothing about a reason nobody gave', () => {
    const card = render(
      thread([comment('Have a look', ask({ withdrawnAt: ts, withdrawnBy: 'Cartographer' }))]),
    );
    expect(card.querySelector('.comment-review-withdrawn-note')?.textContent).toBe(
      'Withdrawn by Cartographer',
    );
  });

  it('leaves a live ask on the same thread unmarked', () => {
    const card = render(
      thread([
        comment('First try', ask({ headline: 'STALE', withdrawnAt: ts, withdrawnBy: 'C' })),
        comment('Corrected', ask({ headline: 'LIVE' })),
      ]),
    );
    expect(withdrawnHeaders(card).length).toBe(1);
  });
});

describe('the item card', () => {
  it('never falls back to a withdrawn declaration', () => {
    // Nothing is pending — the only declaration was taken back — so the
    // fallback runs, and it must come up empty rather than promoting a
    // retracted ask into the card.
    const card = render(
      thread([comment('Have a look', ask({ withdrawnAt: ts, withdrawnBy: 'C' }))]),
    );
    expect(card.querySelector('.thread-item-card')).toBe(null);
  });

  it('falls back past a withdrawn one to a settled record underneath', () => {
    const card = render(
      thread([
        comment('Answered one', ask({ headline: 'SETTLED', answeredAt: ts, answerText: 'Yes' })),
        comment('Retracted one', ask({ headline: 'RETRACTED', withdrawnAt: ts, withdrawnBy: 'C' })),
      ]),
    );
    const item = card.querySelector<HTMLElement>('.thread-item-card');
    expect(item?.textContent).toContain('SETTLED');
    expect(item?.textContent).not.toContain('RETRACTED');
  });
});
