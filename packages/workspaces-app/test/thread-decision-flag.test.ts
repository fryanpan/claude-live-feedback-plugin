import type { Comment, ReviewPayload, Thread, User } from '@feedback/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ThreadPanel } from '../src/threads.ts';

/**
 * The "decision needed" indicator on a thread's COLLAPSED card.
 *
 * A decision is the one thing in a thread a reader must not scroll past, and
 * until now nothing on the folded card said one was there: the kind chip lives
 * inside the item card, which is on the detail face, which is `inert` and
 * invisible until the thread is opened. So a decision waiting on somebody
 * looked exactly like any other comment in the column.
 *
 * The flag sits on its own row above `.thread-head`, outside both folding
 * slots — so it is there in both states, expanding never rebuilds or moves it,
 * and it shares no horizontal space with the author's name.
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

const decisionPayload = (over: Partial<ReviewPayload> = {}): ReviewPayload => ({
  shape: 'decision',
  headline: 'Pick a cache strategy',
  options: [
    { id: 'a', label: 'Write through' },
    { id: 'b', label: 'Write behind' },
  ],
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

const flagOf = (card: HTMLElement): HTMLElement | null =>
  card.querySelector<HTMLElement>('.thread-decision-flag');

describe('the decision flag', () => {
  it('is absent from an ordinary thread', () => {
    expect(flagOf(render(thread([comment('Looks good to me')])))).toBe(null);
  });

  it('is absent from a thread carrying a plain question', () => {
    const question: ReviewPayload = { shape: 'review', headline: 'Read this' };
    expect(flagOf(render(thread([comment('Have a look', question)])))).toBe(null);
  });

  it('says a decision is needed while one is unanswered', () => {
    const flag = flagOf(render(thread([comment('Which one?', decisionPayload())])));
    expect(flag?.textContent).toBe('Decision needed');
  });

  it('drops the "needed" once somebody has answered', () => {
    const answered = decisionPayload({ answeredAt: ts, answerText: 'Write through' });
    const flag = flagOf(render(thread([comment('Which one?', answered)])));
    expect(flag?.textContent).toBe('Decision');
    expect(flag?.classList.contains('is-answered')).toBe(true);
  });

  it('sits outside both slots, so it survives the fold', () => {
    const card = render(thread([comment('Which one?', decisionPayload())]));
    expect(flagOf(card)?.closest('.thread-face')).toBe(null);
  });

  // Measured in the field at 1180px: the flag shared the head row with the
  // author, and a ~115px chip inside a 300px column clipped the name to about
  // seven characters. Two people asking for two different decisions rendered
  // as the same truncated string, so the column could no longer say WHO was
  // waiting — which is most of what a decision flag is for.
  it('gets its own row, so it cannot squeeze the author name', () => {
    const card = render(thread([comment('Which one?', decisionPayload())]));
    const flag = flagOf(card);
    expect(flag?.closest('.thread-head')).toBe(null);
    expect(flag?.parentElement?.classList.contains('thread-flag-row')).toBe(true);
    // Above the identity line rather than below it: the reader meets the
    // reason the card is in their queue before the name attached to it.
    expect(flag?.parentElement?.nextElementSibling?.classList.contains('thread-head')).toBe(true);
  });

  it('adds no row to a thread that carries no decision', () => {
    const card = render(thread([comment('Looks good to me')]));
    expect(card.querySelector('.thread-flag-row')).toBe(null);
  });

  it('is announced, not left as a bare colour', () => {
    const flag = flagOf(render(thread([comment('Which one?', decisionPayload())])));
    expect(flag?.getAttribute('title')).toBeTruthy();
  });
});

/**
 * What an ANSWERED decision says on the folded card.
 *
 * Reported from a walkthrough of the build: an answered decision's collapsed
 * card led with "No replies yet", which is true — an answer is a payload on
 * the item, not a reply — and useless. The one fact worth scanning a column
 * for is what was decided, and it was two folds away, inside the answered
 * record on the detail face.
 *
 * It rides on the decision row rather than replacing the discussion line: the
 * discussion line's job is where the conversation GOT TO, and a thread with an
 * answer and three replies still has a last reply worth showing.
 */
const outcomeOf = (card: HTMLElement): HTMLElement | null =>
  card.querySelector<HTMLElement>('.thread-decision-outcome');

describe('the decided outcome', () => {
  it('names the chosen option on the folded card', () => {
    const answered = decisionPayload({
      answeredAt: ts,
      answeredWith: 'a',
      answerText: 'Write through',
    });
    const card = render(thread([comment('Which one?', answered)]));
    expect(outcomeOf(card)?.textContent).toBe('Write through');
    // On the decision row, outside both slots — the whole point is that it is
    // readable without opening anything.
    expect(outcomeOf(card)?.closest('.thread-flag-row')).not.toBe(null);
    expect(outcomeOf(card)?.closest('.thread-face')).toBe(null);
  });

  // An answer tapped before `answerText` existed recorded only the option id.
  it('falls back to the tapped option label when no words were recorded', () => {
    const answered = decisionPayload({ answeredAt: ts, answeredWith: 'b' });
    const card = render(thread([comment('Which one?', answered)]));
    expect(outcomeOf(card)?.textContent).toBe('Write behind');
  });

  it('says nothing while the decision is still open', () => {
    expect(outcomeOf(render(thread([comment('Which one?', decisionPayload())])))).toBe(null);
  });

  it('says nothing on a thread that carries no decision', () => {
    expect(outcomeOf(render(thread([comment('Looks good to me')])))).toBe(null);
  });

  // Plain text: an answer is a person's words, and this row is not the place
  // that escapes them.
  it('renders the words as text, never as markup', () => {
    const answered = decisionPayload({
      answeredAt: ts,
      answerText: '<img src=x onerror=1> write through',
    });
    const card = render(thread([comment('Which one?', answered)]));
    expect(outcomeOf(card)?.querySelector('img')).toBe(null);
  });
});
