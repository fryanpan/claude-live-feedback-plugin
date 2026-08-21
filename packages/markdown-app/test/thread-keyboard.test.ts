import type { Comment, ReviewPayload, Thread, User } from '@feedback/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ThreadPanel } from '../src/threads.ts';

/**
 * Opening a thread from the keyboard.
 *
 * The whole card is the tap target, and a tap is not a gesture a keyboard has.
 * What carries the keyboard is `.thread-caret` — a real `<button>` in the head
 * row, outside both slots, so it is reachable while the detail face is `inert`.
 * A field review read the collapsed card as having no keyboard path at all;
 * the first three cases here are the regression guards that say otherwise, and
 * they are the reason the fix below is a NAME rather than a second tab stop.
 *
 * The genuine gap the same review pointed at: every caret on every card
 * announced the identical "Toggle comment thread". A sighted reader tells the
 * cards apart by the name and the flag; a keyboard or screen-reader user
 * arrives at a column of identical buttons and cannot tell which thread they
 * are on, or which one is holding a decision.
 */

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const bob: User = { id: 'u2', name: 'Bob', kind: 'known', color: '#d72e7d' };

let ts = 1_700_000_000_000;
function comment(author: User, text: string, review?: ReviewPayload): Comment {
  ts += 1000;
  return { id: `c${ts}`, author, text, ts, ...(review ? { review } : {}) };
}

function thread(id: string, comments: Comment[]): Thread {
  return {
    id,
    status: 'open',
    anchor: { kind: 'element', fingerprint: undefined as never, snippet: { text: 'anchor' } },
    commentCount: comments.length,
    lastActivity: comments[comments.length - 1]?.ts ?? ts,
    createdBy: comments[0]?.author ?? alice,
    comments,
  };
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

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

interface Rendered {
  card: HTMLElement;
  caret: HTMLButtonElement;
  clicked: string[];
  panel: ThreadPanel;
}

function render(t: Thread, active?: string): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  cleanups.push(() => container.remove());
  const clicked: string[] = [];
  const panel = new ThreadPanel({
    container,
    currentUser: alice,
    onThreadClick: (id) => clicked.push(id),
    onReply: () => {},
    onResolve: () => {},
    onReopen: () => {},
    onReanchor: () => {},
  });
  if (active) panel.setActive(active);
  const card = panel.renderThread(t);
  container.appendChild(card);
  const caret = card.querySelector<HTMLButtonElement>('.thread-caret');
  if (!caret) throw new Error('no caret — the card has no keyboard control at all');
  return { card, caret, clicked, panel };
}

describe('the collapsed card from a keyboard', () => {
  // Enter and Space on a <button> raise a click; nothing here needs to
  // synthesize a key for that, and synthesizing one would be testing happy-dom
  // rather than the card. What has to be true is that it IS a button.
  it('offers a real button, which is what makes Enter and Space work at all', () => {
    const { caret } = render(thread('t1', [comment(alice, 'Have a look')]));
    expect(caret.tagName).toBe('BUTTON');
    expect(caret.type).toBe('button');
    expect(caret.hasAttribute('disabled')).toBe(false);
  });

  it('routes that press through the same handler a tap uses', () => {
    const { caret, clicked } = render(thread('t1', [comment(alice, 'Have a look')]));
    caret.click();
    // `onThreadClick`, not a caret-local toggle: it is the one route the
    // chrome watches to decide inline card, modal, or bottom sheet.
    expect(clicked).toEqual(['t1']);
  });

  it('states whether the thread it opens is already open', () => {
    const t = thread('t1', [comment(alice, 'Have a look')]);
    expect(render(t).caret.getAttribute('aria-expanded')).toBe('false');
    expect(render(t, 't1').caret.getAttribute('aria-expanded')).toBe('true');
  });

  it('names the thread it belongs to, so a column of them is navigable', () => {
    const one = render(thread('t1', [comment(alice, 'Have a look')])).caret;
    const two = render(thread('t2', [comment(bob, 'And this one')])).caret;
    const nameOf = (b: HTMLButtonElement) => b.getAttribute('aria-label') ?? '';
    expect(nameOf(one)).toContain('Alice');
    expect(nameOf(two)).toContain('Bob');
    expect(nameOf(one)).not.toBe(nameOf(two));
  });

  it('says a decision is waiting, which the flag says only in colour', () => {
    const t = thread('t1', [comment(alice, 'Which one?', decisionPayload)]);
    expect(render(t).caret.getAttribute('aria-label')).toMatch(/decision/i);
  });

  // The control: the two cases above are worth nothing if every caret matches
  // them for a reason that has nothing to do with the thread.
  it('leaves the decision out of the name when there is no decision', () => {
    const { caret } = render(thread('t1', [comment(alice, 'Have a look')]));
    expect(caret.getAttribute('aria-label')).not.toMatch(/decision/i);
  });
});
