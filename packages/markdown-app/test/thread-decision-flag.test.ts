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
 * The flag sits in `.thread-head`, which is outside both folding slots — so it
 * is there in both states and expanding never rebuilds or moves it.
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
  why: 'The rollout is blocked on it',
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
    const question: ReviewPayload = { shape: 'review', headline: 'Read this', why: 'It matters' };
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

  it('sits in the head row, so it survives the fold', () => {
    const card = render(thread([comment('Which one?', decisionPayload())]));
    const flag = flagOf(card);
    expect(flag?.closest('.thread-head')).not.toBe(null);
    expect(flag?.closest('.thread-face')).toBe(null);
  });

  it('is announced, not left as a bare colour', () => {
    const flag = flagOf(render(thread([comment('Which one?', decisionPayload())])));
    expect(flag?.getAttribute('title')).toBeTruthy();
  });
});
