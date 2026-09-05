import type { Comment, ReviewPayload, Thread, User } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThreadPanel, type ThreadPanelOpts } from '../src/threads.ts';

/**
 * The card as comments mock 3 has it (approved 2026-09-01): one glyph per
 * state in the head, the ASK as the folded line of a declared thread, the
 * ways to answer on the folded face, "Details ▾ / Less ▴" in words, and a
 * red "new" mark that clears in place.
 */

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };
const bryan: User = { id: 'u9', name: 'Bryan', kind: 'known', color: '#333' };

let ts = 1_700_000_000_000;
function comment(text: string, review?: ReviewPayload): Comment {
  ts += 1000;
  return { id: `c${ts}`, author: alice, text, ts, ...(review ? { review } : {}) };
}

function thread(comments: Comment[], over: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    status: 'open',
    // A real sentence, not two words: a snippet under
    // TOPIC_MIN_SNIPPET_WORDS never reaches the topic line, so a short
    // fixture would prove the fallback instead of the anchor path.
    anchor: {
      kind: 'element',
      fingerprint: undefined as never,
      snippet: { text: 'the sentence it hangs off' },
    },
    commentCount: comments.length,
    lastActivity: comments[comments.length - 1]?.ts ?? ts,
    createdBy: alice,
    comments,
    ...over,
  };
}

const question = (over: Partial<ReviewPayload> = {}): ReviewPayload => ({
  shape: 'review',
  headline: 'Does the mockup cover the phone too?',
  detail: 'Inline cards already sit under the text on the phone.',
  ...over,
});
const decision = (over: Partial<ReviewPayload> = {}): ReviewPayload => ({
  shape: 'decision',
  headline: 'What does 45 s mean?',
  options: [
    { id: 'a', label: 'Cadence ceiling', detail: 'A tick fires at most every 45 s.' },
    { id: 'b', label: 'Pause threshold' },
  ],
  ...over,
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

function mount(over: Partial<ThreadPanelOpts> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  cleanups.push(() => container.remove());
  const onReply = vi.fn();
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
  return { panel, container, onReply };
}

function render(t: Thread, over: Partial<ThreadPanelOpts> = {}) {
  const h = mount(over);
  h.panel.setThreads([t]);
  const card = h.panel.renderThread(t);
  h.container.appendChild(card);
  return { ...h, card };
}

const glyphOf = (card: HTMLElement) => card.querySelector<HTMLElement>('.thread-glyph');

describe('the glyph', () => {
  it('a plain comment gets the bubble', () => {
    const { card } = render(thread([comment('Looks fine.')]));
    expect(card.classList.contains('thread-kind-comment')).toBe(true);
    expect(glyphOf(card)?.classList.contains('cw-ic-comment')).toBe(true);
  });

  it('an open question AND an open decision get the same question mark', () => {
    const q = render(thread([comment('?', question())]));
    const d = render(thread([comment('?', decision())]));
    expect(q.card.classList.contains('thread-kind-question')).toBe(true);
    expect(d.card.classList.contains('thread-kind-question')).toBe(true);
    expect(glyphOf(q.card)?.classList.contains('cw-ic-question')).toBe(true);
    expect(glyphOf(d.card)?.classList.contains('cw-ic-question')).toBe(true);
  });

  it('answered and resolved get the tick', () => {
    const a = render(thread([comment('?', question({ answeredAt: ts, answerText: 'Yes' }))]));
    const r = render(thread([comment('Hi')], { status: 'resolved' }));
    expect(glyphOf(a.card)?.classList.contains('cw-ic-done')).toBe(true);
    expect(glyphOf(r.card)?.classList.contains('cw-ic-done')).toBe(true);
    expect(r.card.classList.contains('thread-kind-resolved')).toBe(true);
  });
});

describe('the folded line of a declared thread', () => {
  it('is the headline, not the sentence it hangs off', () => {
    const { card } = render(thread([comment('?', question())]));
    expect(card.querySelector('.thread-topic')?.textContent).toBe(
      'Does the mockup cover the phone too?',
    );
  });

  it('a plain comment still leads with the anchored sentence', () => {
    const { card } = render(thread([comment('Looks fine.')]));
    expect(card.querySelector('.thread-topic')?.textContent).toBe('the sentence it hangs off');
  });
});

describe('answering from the folded face', () => {
  it('a decision offers its option labels, and tapping one answers with provenance', () => {
    const c = comment('?', decision());
    const { card, onReply } = render(thread([c]));
    const face = card.querySelector('.slot-b .face-summary');
    const buttons = Array.from(
      face?.querySelectorAll<HTMLButtonElement>('.thread-item-option-compact') ?? [],
    );
    expect(buttons.map((b) => b.textContent)).toEqual(['Cadence ceiling', 'Pause threshold']);
    // The option's reasoning rides as a title, not as a second line.
    expect(buttons[0]?.title).toBe('A tick fires at most every 45 s.');
    buttons[1]?.click();
    expect(onReply).toHaveBeenCalledWith('t1', 'Pause threshold', c.id, 'b');
  });

  it('a question offers a field to answer in, not a cue telling you to tap', () => {
    const { card } = render(thread([comment('?', question())]));
    const field = card.querySelector('.slot-b .face-summary .thread-answer-field');
    expect(field?.querySelector('.thread-answer-input')?.tagName).toBe('INPUT');
    expect(field?.querySelector('.thread-answer-send')?.textContent).toBe('Answer');
  });

  it('an answered question keeps a compact record: the words, who, when', () => {
    const { card } = render(
      thread([
        comment('?', question({ answeredAt: ts, answeredBy: 'Bryan', answerText: 'Yes, both.' })),
      ]),
    );
    const line = card.querySelector('.slot-b .face-summary .thread-answered-line');
    expect(line?.querySelector('.thread-answered-words')?.textContent).toBe('Yes, both.');
    expect(line?.querySelector('.thread-answered-who')?.textContent).toMatch(/you/i);
    expect(card.querySelector('.thread-options-compact')).toBe(null);
    expect(card.querySelector('.thread-answer-field')).toBe(null);
  });

  it('an answered decision states the outcome — no row above the head does it now', () => {
    const { card } = render(
      thread([
        comment(
          '?',
          decision({ answeredAt: ts, answeredWith: 'a', answerText: 'Cadence ceiling' }),
        ),
      ]),
    );
    expect(card.querySelector('.thread-decision-outcome')).toBe(null);
    expect(card.querySelector('.thread-answered-words')?.textContent).toBe('Cadence ceiling');
    expect(card.querySelector('.thread-answered-who')).not.toBe(null);
  });

  it('a plain comment gets none of it', () => {
    const { card } = render(thread([comment('Looks fine.')]));
    expect(card.querySelector('.thread-answered-line')).toBe(null);
    expect(card.querySelector('.thread-answer-field')).toBe(null);
    expect(card.querySelector('.thread-options-compact')).toBe(null);
  });
});

describe('the chevron', () => {
  /* It used to read "Details ▾" on a declared thread. That caption was one of
     the things this round removes: a folded card that already offers the
     options or the answer box does not need telling that there is more behind
     the fold — and the words made the caret a different width on every card in
     a 260px column. What it announces is unchanged. */
  it('is a chevron on a declared thread, and announces the fold state', () => {
    const { card, panel } = render(thread([comment('?', question())]));
    const caret = card.querySelector<HTMLElement>('.thread-caret');
    expect(caret?.textContent).toBe('›');
    expect(caret?.getAttribute('aria-expanded')).toBe('false');
    panel.setActive('t1');
    expect(caret?.getAttribute('aria-expanded')).toBe('true');
    panel.setActive(null);
    expect(caret?.getAttribute('aria-expanded')).toBe('false');
  });

  it('is the same chevron on a plain comment', () => {
    const { card } = render(thread([comment('Looks fine.')]));
    expect(card.querySelector('.thread-caret')?.textContent).toBe('›');
  });
});

describe('new since you last looked', () => {
  /* A dot ON the glyph rather than a "NEW" tag beside it. The tag was a word
     competing for a 260px row with the author, the clock and the caret; the
     dot costs no width at all. */
  it('stamps the card and dots the glyph when the panel says it is new', () => {
    const { card } = render(thread([comment('Hi')]), { isNew: () => true });
    expect(card.classList.contains('is-new')).toBe(true);
    expect(card.querySelector('.thread-glyph')?.classList.contains('is-new')).toBe(true);
    expect(card.querySelector('.thread-new-tag')).toBe(null);
  });

  it('leaves a seen thread alone', () => {
    const { card } = render(thread([comment('Hi')]), { isNew: () => false });
    expect(card.classList.contains('is-new')).toBe(false);
    expect(card.querySelector('.thread-glyph')?.classList.contains('is-new')).toBe(false);
  });
});
