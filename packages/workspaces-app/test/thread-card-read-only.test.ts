import type { Comment, ReviewPayload, Thread, User } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThreadPanel } from '../src/threads.ts';

/**
 * What a comment card offers a reader the server will not let write.
 *
 * Found in a walkthrough of PR 674: under the "You are reading only" banner
 * the card rendered in full working order. Tapping a decision option did
 * nothing at all — no answer, no error, not even the "try again" toast a
 * refused post shows, because the tap never reached a route that could refuse
 * it. A control that takes a press and swallows it is worse than no control:
 * the reader cannot tell whether they were denied or the product is broken.
 *
 * The rule this file holds: every control on a card that POSTS is `disabled`
 * plus `aria-disabled` when `canWrite` is false, and nothing else changes.
 * The card still says what is being asked, and the caret still opens it —
 * reading is not writing.
 */

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const bryan: User = { id: 'u2', name: 'Bryan', kind: 'known', color: '#b25e09' };

let ts = 1_700_000_000_000;
function comment(text: string, review?: ReviewPayload): Comment {
  ts += 1000;
  return { id: `c${ts}`, author: alice, text, ts, ...(review ? { review } : {}) };
}

function thread(comments: Comment[]): Thread {
  return {
    id: 't1',
    status: 'open',
    anchor: { kind: 'element', fingerprint: undefined as never, snippet: { text: 'anchor' } },
    commentCount: comments.length,
    lastActivity: comments[comments.length - 1]?.ts ?? ts,
    createdBy: alice,
    comments,
  };
}

const decision: ReviewPayload = {
  shape: 'decision',
  headline: 'Pick a tick clock',
  options: [
    { id: 'a', label: 'Cadence ceiling' },
    { id: 'b', label: 'Pause threshold' },
  ],
};
const question: ReviewPayload = {
  shape: 'review',
  headline: 'Should the strip stay after the meeting ends?',
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

function render(t: Thread, over: Record<string, unknown> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  cleanups.push(() => container.remove());
  const onReply = vi.fn(() => true);
  const panel = new ThreadPanel({
    container,
    currentUser: bryan,
    onThreadClick: () => {},
    onReply,
    onResolve: () => {},
    onReopen: () => {},
    onReanchor: () => {},
    ...over,
  });
  const card = panel.renderThread(t);
  container.appendChild(card);
  return { card, panel, onReply };
}

describe('a reader who cannot write is offered nothing that would do nothing', () => {
  const readOnly = { canWrite: false };
  const locked = (el: Element | null | undefined) =>
    el instanceof HTMLButtonElement ||
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement
      ? [el.disabled, el.getAttribute('aria-disabled')]
      : ['no such control', null];

  it('the folded decision options are disabled, and clicking one posts nothing', () => {
    const { card, onReply } = render(thread([comment('Which clock?', decision)]), readOnly);
    const opts = Array.from(
      card.querySelectorAll<HTMLButtonElement>('.face-summary .thread-item-option-compact'),
    );
    expect(opts.length).toBe(2);
    for (const o of opts) expect(locked(o)).toEqual([true, 'true']);
    opts[0]?.click();
    expect(onReply).not.toHaveBeenCalled();
  });

  it('and the same options are live for a reader who can write', () => {
    const { card, onReply } = render(thread([comment('Which clock?', decision)]));
    const first = card.querySelector<HTMLButtonElement>(
      '.face-summary .thread-item-option-compact',
    );
    expect(locked(first)).toEqual([false, null]);
    first?.click();
    expect(onReply).toHaveBeenCalledWith('t1', 'Cadence ceiling', expect.any(String), 'a');
  });

  it('the folded answer field and its send button are both disabled', () => {
    const { card } = render(thread([comment('Well?', question)]), readOnly);
    expect(locked(card.querySelector('.thread-answer-input'))).toEqual([true, 'true']);
    expect(locked(card.querySelector('.thread-answer-send'))).toEqual([true, 'true']);
  });

  it('the expanded card’s composer, its options and ✓ Resolve are disabled too', () => {
    const { card, panel } = render(thread([comment('Which clock?', decision)]), readOnly);
    panel.setActive('t1');
    const detail = card.querySelector('.slot-b .face-detail');
    expect(locked(detail?.querySelector('.thread-reply textarea'))).toEqual([true, 'true']);
    expect(locked(detail?.querySelector('.thread-actions button'))).toEqual([true, 'true']);
    expect(locked(detail?.querySelector('.thread-item-options .thread-item-option'))).toEqual([
      true,
      'true',
    ]);
    expect(locked(detail?.querySelector('.thread-resolve'))).toEqual([true, 'true']);
  });

  it('but the caret still opens the card — reading is not writing', () => {
    const { card, panel } = render(thread([comment('Which clock?', decision)]), readOnly);
    const caret = card.querySelector<HTMLButtonElement>('.thread-caret');
    expect(caret?.disabled).toBe(false);
    panel.setActive('t1');
    expect(card.querySelector('.face-detail')?.hasAttribute('inert')).toBe(false);
  });
});
