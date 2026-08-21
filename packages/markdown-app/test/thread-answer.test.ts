import type { Comment, ReviewPayload, Thread, User } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThreadPanel, type ThreadPanelOpts } from '../src/threads.ts';

/**
 * Answering a review item from the DOC, not just from Home.
 *
 * The doc thread panel rendered a review declaration and then posted every
 * reply as an ordinary comment, so a person could read the ask, answer it in
 * their own words, and watch the item sit in the queue unchanged. On
 * `board-review-2026-08-19` that is four declared items, four human replies
 * and zero `answeredAt` stamps.
 *
 * The panel is the half that knows WHICH comment is being answered, so that
 * is what these assert: the id it hands back, and the fact that the control
 * says so before it is pressed.
 */

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const bot: User = { id: 'a1', name: 'Stable Agent', kind: 'known', color: '#b0cb4d' };

let ts = 1_700_000_000_000;
function comment(author: User, text: string, review?: ReviewPayload): Comment {
  ts += 1000;
  return { id: `c${ts}`, author, text, ts, ...(review ? { review } : {}) };
}

const ask = (over: Partial<ReviewPayload> = {}): ReviewPayload => ({
  shape: 'review',
  headline: 'Read the stall rota before Thursday',
  why: 'The rota goes out Thursday and nobody has checked it',
  ...over,
});

function makeThread(comments: Comment[]): Thread {
  return {
    id: 't1',
    status: 'open',
    anchor: { kind: 'element', fingerprint: undefined as never, snippet: { text: 'the anchor' } },
    commentCount: comments.length,
    lastActivity: comments[comments.length - 1]?.ts ?? ts,
    createdBy: comments[0]?.author ?? alice,
    comments,
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
  vi.restoreAllMocks();
});

function mountPanel(over: Partial<ThreadPanelOpts> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  cleanups.push(() => container.remove());
  const replies: Array<[string, string, string | undefined]> = [];
  const panel = new ThreadPanel({
    container,
    currentUser: alice,
    onThreadClick: () => {},
    onReply: (id, text, answersCommentId) => {
      replies.push([id, text, answersCommentId]);
    },
    onResolve: () => {},
    onReopen: () => {},
    onReanchor: () => {},
    ...over,
  });
  return { panel, container, replies };
}

/** Type into the card's reply box and press its primary control. */
function replyWith(container: HTMLElement, words: string): string {
  const ta = container.querySelector<HTMLTextAreaElement>('.thread-reply textarea');
  if (!ta) throw new Error('no reply box rendered');
  ta.value = words;
  const button = container.querySelector<HTMLElement>('.thread-actions button');
  if (!button) throw new Error('no primary control rendered');
  const label = (button.textContent ?? '').trim();
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return label;
}

describe('answering a review item from the doc thread', () => {
  it('hands back the declaring comment id, so the reply can be routed to /answer', () => {
    const declaring = comment(bot, 'Which way do you want the rota to read?', ask());
    const { panel, container, replies } = mountPanel();
    panel.setThreads([makeThread([declaring])]);
    panel.setActive('t1');
    replyWith(container, 'Alphabetical by stall, please.');
    expect(replies).toEqual([['t1', 'Alphabetical by stall, please.', declaring.id]]);
  });

  it('says Answer on the control, so the person can see it will clear the item', () => {
    const { panel, container } = mountPanel();
    panel.setThreads([makeThread([comment(bot, 'Which way?', ask())])]);
    panel.setActive('t1');
    expect(replyWith(container, 'Alphabetical.')).toBe('Answer');
  });

  it('leaves an ordinary thread alone — no id, and the control still says Reply', () => {
    const { panel, container, replies } = mountPanel();
    panel.setThreads([makeThread([comment(alice, 'This paragraph reads oddly.')])]);
    panel.setActive('t1');
    expect(replyWith(container, 'Agreed, rewriting it.')).toBe('Reply');
    expect(replies).toEqual([['t1', 'Agreed, rewriting it.', undefined]]);
  });

  it('stops offering to answer once the item is answered', () => {
    const settled = comment(bot, 'Which way?', ask({ answeredAt: ts }));
    const { panel, container, replies } = mountPanel();
    panel.setThreads([makeThread([settled, comment(alice, 'Alphabetical.')])]);
    panel.setActive('t1');
    expect(replyWith(container, 'One more thought.')).toBe('Reply');
    expect(replies[0]?.[2]).toBeUndefined();
  });

  it('targets the newer ask when an agent asked a second time', () => {
    const first = comment(bot, 'Which way?', ask({ answeredAt: ts }));
    const second = comment(bot, 'And the feed order?', ask({ headline: 'Feed order' }));
    const { panel, container, replies } = mountPanel();
    panel.setThreads([makeThread([first, second])]);
    panel.setActive('t1');
    expect(replyWith(container, 'Oldest first.')).toBe('Answer');
    expect(replies[0]?.[2]).toBe(second.id);
  });

  // The two cases where this panel used to disagree with the server's queue
  // (review-queue.ts) about whether anything is pending. Both read
  // `pendingDeclaration` from core now — the doc surface must never offer an
  // Answer composer for an item Home has retired, because answering it
  // stamps a comment no queue was showing.

  it('an answered NEWER ask retires a buried unanswered one — Reply, not Answer', () => {
    const buried = comment(bot, 'Which way?', ask());
    const settled = comment(
      bot,
      'Scratch that — feed order?',
      ask({ headline: 'Feed order', answeredAt: ts, answerText: 'Oldest first.' }),
    );
    const { panel, container, replies } = mountPanel();
    panel.setThreads([makeThread([buried, settled])]);
    panel.setActive('t1');
    expect(replyWith(container, 'One more thought.')).toBe('Reply');
    expect(replies[0]?.[2]).toBeUndefined();
  });

  it('a resolved thread has nothing pending, even with an unanswered declaration', () => {
    const declaring = comment(bot, 'Which way?', ask());
    const resolved: Thread = { ...makeThread([declaring]), status: 'resolved' };
    const { panel, container, replies } = mountPanel();
    panel.setTab('resolved');
    panel.setThreads([resolved]);
    panel.setActive('t1');
    expect(replyWith(container, 'Still wondering.')).toBe('Reply');
    expect(replies[0]?.[2]).toBeUndefined();
  });

  it('a retired decision keeps its card but not its tappable options', () => {
    const buriedDecision = comment(
      bot,
      'Which way?',
      ask({
        shape: 'decision',
        options: [
          { id: 'o1', label: 'Alphabetical' },
          { id: 'o2', label: 'By arrival' },
        ],
      }),
    );
    const resolved: Thread = { ...makeThread([buriedDecision]), status: 'resolved' };
    const { panel, container } = mountPanel();
    panel.setTab('resolved');
    panel.setThreads([resolved]);
    panel.setActive('t1');
    // The card still renders (the record of what was asked)…
    expect(container.querySelector('.thread-item-card')).not.toBeNull();
    // …but a tap that would answer a retired item is not offered.
    expect(container.querySelector('.thread-item-option')).toBeNull();
  });
});

describe('the full item interface in the carrying thread', () => {
  const decision = (over: Partial<ReviewPayload> = {}): ReviewPayload => ({
    shape: 'decision',
    headline: 'Pick the rota order',
    why: 'The rota goes out Thursday.',
    options: [
      { id: 'o1', label: 'Alphabetical', detail: 'By stall name.' },
      { id: 'o2', label: 'By arrival', detail: 'First come, first listed.' },
    ],
    ...over,
  });

  it('a tapped option answers with the label, the declaring comment id AND the option id', () => {
    const declaring = comment(bot, 'Which way?', decision());
    const all: Array<[string, string, string | undefined, string | undefined]> = [];
    const { panel, container } = mountPanel({
      onReply: (id, text, answersCommentId, optionId) => {
        all.push([id, text, answersCommentId, optionId]);
      },
    });
    panel.setThreads([makeThread([declaring])]);
    panel.setActive('t1');
    const option = container.querySelector<HTMLButtonElement>('.thread-item-option');
    if (!option) throw new Error('no option button rendered');
    option.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(all).toEqual([['t1', 'Alphabetical', declaring.id, 'o1']]);
  });

  it('a typed answer carries no option id — typed is not a lesser answer', () => {
    const declaring = comment(bot, 'Which way?', decision());
    const all: Array<[string, string, string | undefined, string | undefined]> = [];
    const { panel, container } = mountPanel({
      onReply: (id, text, answersCommentId, optionId) => {
        all.push([id, text, answersCommentId, optionId]);
      },
    });
    panel.setThreads([makeThread([declaring])]);
    panel.setActive('t1');
    replyWith(container, 'Neither — group by aisle.');
    expect(all).toEqual([['t1', 'Neither — group by aisle.', declaring.id, undefined]]);
  });

  it('Undo on the answered record hands back the thread and the declaring comment', () => {
    const settled = comment(
      bot,
      'Which way?',
      decision({ answeredAt: ts, answeredBy: 'Alice', answerText: 'Alphabetical.' }),
    );
    const undos: Array<[string, string]> = [];
    const { panel, container } = mountPanel({
      onUndoAnswer: (threadId, commentId) => undos.push([threadId, commentId]),
    });
    panel.setThreads([makeThread([settled, comment(alice, 'Alphabetical.')])]);
    panel.setActive('t1');
    const undo = container.querySelector<HTMLButtonElement>('.thread-answer-undo');
    if (!undo) throw new Error('no Undo rendered on the answered record');
    undo.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(undos).toEqual([['t1', settled.id]]);
  });

  it('renders the record without an Undo when nothing is wired to take the answer back', () => {
    const settled = comment(
      bot,
      'Which way?',
      decision({ answeredAt: ts, answeredBy: 'Alice', answerText: 'Alphabetical.' }),
    );
    const { panel, container } = mountPanel();
    panel.setThreads([makeThread([settled])]);
    panel.setActive('t1');
    expect(container.querySelector('.thread-answered')).not.toBeNull();
    expect(container.querySelector('.thread-answer-undo')).toBeNull();
  });
});

/**
 * Design point 4 (approved design, review-flow-mock-v1): the doc thread's
 * reply/answer box is the same markdown editor as every other composer —
 * affordance row, preview that fills in as you type, empty again on send.
 */
describe('the reply composer is a markdown field', () => {
  it('carries the affordance and previews what you type', () => {
    const { panel, container } = mountPanel();
    panel.setThreads([makeThread([comment(alice, 'This paragraph reads oddly.')])]);
    panel.setActive('t1');
    const reply = container.querySelector('.thread-reply') as HTMLElement;
    expect(reply.querySelector('.md-affordance .md-badge')?.textContent).toBe('Markdown');
    const ta = reply.querySelector('textarea') as HTMLTextAreaElement;
    const preview = reply.querySelector('.md-preview') as HTMLElement;
    expect(preview.hidden).toBe(true);
    ta.value = '**two hops**';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    expect(preview.hidden).toBe(false);
    expect(preview.innerHTML).toContain('<strong>two hops</strong>');
  });

  it('a refused send puts the words back — a retry must not mean retyping', async () => {
    // Every hub composer restores the text verbatim when the server refuses;
    // this box was the one composer that cleared first and toasted 'try
    // again' over an empty textarea.
    const { panel, container } = mountPanel({ onReply: () => Promise.resolve(false) });
    panel.setThreads([makeThread([comment(bot, 'Which way?', ask())])]);
    panel.setActive('t1');
    const ta = container.querySelector('.thread-reply textarea') as HTMLTextAreaElement;
    replyWith(container, 'Alphabetical, **final**.');
    // Cleared optimistically on send…
    expect(ta.value).toBe('');
    // …and restored once the post comes back refused.
    await Promise.resolve();
    await Promise.resolve();
    expect(ta.value).toBe('Alphabetical, **final**.');
    const preview = container.querySelector('.thread-reply .md-preview') as HTMLElement;
    expect(preview.hidden).toBe(false);
  });

  it('leaves fresh words alone when the refusal lands after more typing', async () => {
    let refuse: (v: boolean) => void = () => {};
    const { panel, container } = mountPanel({
      onReply: () =>
        new Promise<boolean>((r) => {
          refuse = r;
        }),
    });
    panel.setThreads([makeThread([comment(bot, 'Which way?', ask())])]);
    panel.setActive('t1');
    const ta = container.querySelector('.thread-reply textarea') as HTMLTextAreaElement;
    replyWith(container, 'First attempt.');
    ta.value = 'Second attempt, mid-typing.';
    refuse(false);
    await Promise.resolve();
    await Promise.resolve();
    // Restoring would stomp what the person is typing NOW.
    expect(ta.value).toBe('Second attempt, mid-typing.');
  });

  it('a send empties the preview with the box', () => {
    const { panel, container } = mountPanel();
    panel.setThreads([makeThread([comment(bot, 'Which way?', ask())])]);
    panel.setActive('t1');
    const ta = container.querySelector('.thread-reply textarea') as HTMLTextAreaElement;
    ta.value = 'Alphabetical, **final**.';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    replyWith(container, 'Alphabetical, **final**.');
    expect(ta.value).toBe('');
    const preview = container.querySelector('.thread-reply .md-preview') as HTMLElement;
    expect(preview.hidden).toBe(true);
  });
});
