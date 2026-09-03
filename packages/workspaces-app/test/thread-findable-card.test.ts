import type { Comment, ReviewPayload, Thread, User } from '@feedback/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThreadPanel, type ThreadPanelOpts } from '../src/threads.ts';

/**
 * The card as the round-3 mock has it (approved 2026-09-02): one glyph per
 * state on line one, the ASK as the folded line of a declared thread, the
 * ways to answer on the folded face, one chevron in both states, and a red
 * "new" mark on the glyph that clears in place.
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
    anchor: { kind: 'element', fingerprint: undefined as never, snippet: { text: 'the sentence' } },
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
    expect(glyphOf(card)?.classList.contains('lf-ic-comment')).toBe(true);
  });

  it('an open question AND an open decision get the same question mark', () => {
    const q = render(thread([comment('?', question())]));
    const d = render(thread([comment('?', decision())]));
    expect(q.card.classList.contains('thread-kind-question')).toBe(true);
    expect(d.card.classList.contains('thread-kind-question')).toBe(true);
    expect(glyphOf(q.card)?.classList.contains('lf-ic-question')).toBe(true);
    expect(glyphOf(d.card)?.classList.contains('lf-ic-question')).toBe(true);
  });

  it('answered and resolved get the tick', () => {
    const a = render(thread([comment('?', question({ answeredAt: ts, answerText: 'Yes' }))]));
    const r = render(thread([comment('Hi')], { status: 'resolved' }));
    expect(glyphOf(a.card)?.classList.contains('lf-ic-done')).toBe(true);
    expect(glyphOf(r.card)?.classList.contains('lf-ic-done')).toBe(true);
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
    expect(card.querySelector('.thread-topic')?.textContent).toBe('the sentence');
  });
});

describe('answering from the folded face', () => {
  it('a decision offers its option labels, and tapping one answers with provenance', () => {
    const c = comment('?', decision());
    const { card, onReply } = render(thread([c]));
    const face = card.querySelector('.slot-a .face-summary');
    const buttons = Array.from(
      face?.querySelectorAll<HTMLButtonElement>('.thread-item-option-compact') ?? [],
    );
    expect(buttons.map((b) => b.textContent)).toEqual(['Cadence ceiling', 'Pause threshold']);
    // The option's reasoning rides as a title, not as a second line.
    expect(buttons[0]?.title).toBe('A tick fires at most every 45 s.');
    buttons[1]?.click();
    expect(onReply).toHaveBeenCalledWith('t1', 'Pause threshold', c.id, 'b');
  });

  it('a question shows where to tap — a cue, not a control', () => {
    const { card } = render(thread([comment('?', question())]));
    const cue = card.querySelector('.slot-a .face-summary .thread-answer-cta');
    expect(cue?.textContent).toBe('Answer');
    expect(cue?.tagName).not.toBe('BUTTON');
  });

  it('an answered question keeps a compact record: the words, who, when', () => {
    const { card } = render(
      thread([
        comment('?', question({ answeredAt: ts, answeredBy: 'Bryan', answerText: 'Yes, both.' })),
      ]),
    );
    const line = card.querySelector('.slot-a .face-summary .thread-answered-line');
    expect(line?.querySelector('.thread-answered-words')?.textContent).toBe('Yes, both.');
    expect(line?.querySelector('.thread-answered-who')?.textContent).toMatch(/you/i);
    expect(card.querySelector('.thread-options-compact')).toBe(null);
    expect(card.querySelector('.thread-answer-cta')).toBe(null);
  });

  it('an answered decision names what was decided, on the folded card', () => {
    // It used to be suppressed here because a "Decision" flag row above the
    // head carried the outcome. That row went with the collapsed redesign, so
    // this line is now the only place a folded card can say what was chosen —
    // without it the card folded to "✓ — decided by you", which names
    // everything except the decision.
    const { card } = render(
      thread([
        comment(
          '?',
          decision({ answeredAt: ts, answeredWith: 'a', answerText: 'Cadence ceiling' }),
        ),
      ]),
    );
    expect(card.querySelector('.thread-decision-outcome')).toBe(null);
    const line = card.querySelector('.slot-a .face-summary .thread-answered-line');
    expect(line?.querySelector('.thread-answered-words')?.textContent).toBe('Cadence ceiling');
    expect(line?.querySelector('.thread-answered-who')).not.toBe(null);
  });

  it('a plain comment gets none of it', () => {
    const { card } = render(thread([comment('Looks fine.')]));
    expect(card.querySelector('.thread-answered-line')).toBe(null);
    expect(card.querySelector('.thread-answer-cta')).toBe(null);
    expect(card.querySelector('.thread-options-compact')).toBe(null);
  });
});

describe('the chevron', () => {
  it('is one glyph in both states, on a declared thread and a plain one alike', () => {
    // It used to read "Details ▾ / Less ▴" on a declared thread. The words
    // were a second label on a row that already carries a topic and a name,
    // and `aria-expanded` is what actually announces the fold — in both.
    const declared = render(thread([comment('?', question())]));
    const plain = render(thread([comment('Looks fine.')]));
    for (const { card, panel } of [declared, plain]) {
      const caret = card.querySelector<HTMLElement>('.thread-caret');
      expect(caret?.textContent).toBe('›');
      expect(caret?.getAttribute('aria-expanded')).toBe('false');
      panel.setActive('t1');
      expect(caret?.textContent).toBe('›');
      expect(caret?.getAttribute('aria-expanded')).toBe('true');
      panel.setActive(null);
    }
  });
});

describe('new since you last looked', () => {
  it('marks the glyph rather than tagging the head', () => {
    // A "New" word competed with the topic for the one line the card has.
    // The dot rides the glyph, where it costs no width in a 300px column.
    const { card } = render(thread([comment('Hi')]), { isNew: () => true });
    expect(card.classList.contains('is-new')).toBe(true);
    expect(card.querySelector('.thread-new-tag')).toBe(null);
    const dot = card.querySelector('.thread-new-dot');
    expect(dot).not.toBe(null);
    expect(dot?.closest('.thread-glyph')).not.toBe(null);
  });

  it('leaves a seen thread alone', () => {
    const { card } = render(thread([comment('Hi')]), { isNew: () => false });
    expect(card.classList.contains('is-new')).toBe(false);
    expect(card.querySelector('.thread-new-dot')).toBe(null);
  });
});
