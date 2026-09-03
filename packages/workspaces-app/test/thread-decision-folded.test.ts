import type { Comment, ReviewPayload, Thread, User } from '@feedback/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ThreadPanel } from '../src/threads.ts';

/**
 * What a COLLAPSED card says about a decision.
 *
 * The requirement has not moved: a decision is the one thing in a thread a
 * reader must not scroll past, and the kind chip that names it lives inside
 * the item card, which is on the detail face, which is `inert` until the
 * thread is opened. Something on the folded card has to carry it.
 *
 * What carries it has moved. It used to be a "Decision needed" flag on its
 * own row above the head, with the chosen outcome riding the same row once
 * answered. The collapsed redesign took that row out: on a one-line card the
 * flag was a third statement of a fact the amber glyph and the option buttons
 * already make, and it clipped the asker's name to about seven characters in
 * a 300px column. So the folded card now says it with the parts it already
 * has — the glyph for the state, the option buttons for what to do, and the
 * answered line for what was chosen.
 *
 * These tests assert THAT, not the row: an unanswered decision is
 * distinguishable from a comment without opening it, and an answered one
 * names what was decided without opening it.
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

const glyphOf = (card: HTMLElement): HTMLElement | null =>
  card.querySelector<HTMLElement>('.thread-head .thread-glyph');

const foldedFace = (card: HTMLElement): HTMLElement | null =>
  card.querySelector<HTMLElement>('.slot-a > .face-summary');

describe('an unanswered decision, folded', () => {
  it('is distinguishable from an ordinary comment by its glyph alone', () => {
    const asking = glyphOf(render(thread([comment('Which one?', decisionPayload())])));
    const chatting = glyphOf(render(thread([comment('Looks good to me')])));
    expect(asking?.className).toContain('lf-ic-question');
    expect(chatting?.className).toContain('lf-ic-comment');
  });

  it('offers the choice itself on the folded face, so answering costs no fold', () => {
    const card = render(thread([comment('Which one?', decisionPayload())]));
    const labels = Array.from(
      foldedFace(card)?.querySelectorAll<HTMLElement>('.thread-item-option') ?? [],
    ).map((b) => b.textContent);
    expect(labels).toEqual(['Write through', 'Write behind']);
  });

  it('spends no line on saying "decision" in words', () => {
    // The row this file was named after. It cost the card a whole line to
    // repeat what the glyph and the two buttons below it already say.
    const card = render(thread([comment('Which one?', decisionPayload())]));
    expect(card.querySelector('.thread-flag-row')).toBe(null);
    expect(card.querySelector('.thread-decision-flag')).toBe(null);
    expect(card.textContent).not.toContain('Decision needed');
  });

  it('keeps the glyph out of both folding faces, so opening never moves it', () => {
    const card = render(thread([comment('Which one?', decisionPayload())]));
    expect(glyphOf(card)?.closest('.thread-face')).toBe(null);
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
 */
const outcomeOf = (card: HTMLElement): HTMLElement | null =>
  card.querySelector<HTMLElement>('.slot-a > .face-summary .thread-answered-words');

describe('the decided outcome', () => {
  it('names the chosen option on the folded card', () => {
    const answered = decisionPayload({
      answeredAt: ts,
      answeredWith: 'a',
      answerText: 'Write through',
    });
    const card = render(thread([comment('Which one?', answered)]));
    expect(outcomeOf(card)?.textContent).toBe('Write through');
    // And the glyph has stopped asking.
    expect(glyphOf(card)?.className).toContain('lf-ic-done');
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

  // Plain text: an answer is a person's words, and this line is not the place
  // that escapes them.
  it('renders the words as text, never as markup', () => {
    const answered = decisionPayload({
      answeredAt: ts,
      answerText: '<img src=x onerror=1> write through',
    });
    const card = render(thread([comment('Which one?', answered)]));
    expect(outcomeOf(card)?.querySelector('img')).toBe(null);
    expect(outcomeOf(card)?.textContent).toContain('<img src=x onerror=1>');
  });
});
