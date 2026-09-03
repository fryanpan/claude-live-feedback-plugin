import type { Comment, ReviewPayload, Thread, User } from '@feedback/core';
import { describe, expect, it } from 'vitest';
import { isOpenAsk, threadGlyph, threadKind } from '../src/thread-kind.ts';

/**
 * ONE glyph per state, everywhere a thread appears (comments mock 3, approved
 * 2026-09-01). This is the mapping every surface keys off — the highlight,
 * the card, the top-bar chip, the off-screen hints — so it is pinned here
 * once rather than re-derived in four places.
 */

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#2e7dd7' };

let ts = 1_700_000_000_000;
function comment(text: string, review?: ReviewPayload): Comment {
  ts += 1000;
  return { id: `c${ts}`, author: alice, text, ts, ...(review ? { review } : {}) };
}

function thread(comments: Comment[], status: Thread['status'] = 'open'): Thread {
  return {
    id: 't1',
    status,
    anchor: { kind: 'subject' },
    commentCount: comments.length,
    lastActivity: comments[comments.length - 1]?.ts ?? ts,
    createdBy: alice,
    comments,
  };
}

const question = (over: Partial<ReviewPayload> = {}): ReviewPayload => ({
  shape: 'review',
  headline: 'Does the phone get counts?',
  ...over,
});
const decision = (over: Partial<ReviewPayload> = {}): ReviewPayload => ({
  shape: 'decision',
  headline: 'Which calendar?',
  options: [
    { id: 'a', label: 'Work' },
    { id: 'b', label: 'Personal' },
  ],
  ...over,
});

describe('threadKind', () => {
  it('an ordinary conversation is a comment', () => {
    expect(threadKind(thread([comment('Looks fine.'), comment('Agreed.')]))).toBe('comment');
  });

  it('an open question is a question', () => {
    expect(threadKind(thread([comment('?', question())]))).toBe('question');
  });

  it('an open decision is ALSO a question — one glyph for every review item', () => {
    expect(threadKind(thread([comment('?', decision())]))).toBe('question');
    expect(threadGlyph(threadKind(thread([comment('?', decision())])))).toBe('question');
  });

  it('answered once somebody has answered', () => {
    const t = thread([comment('?', question({ answeredAt: ts, answerText: 'Yes' }))]);
    expect(threadKind(t)).toBe('answered');
    const d = thread([comment('?', decision({ answeredWith: 'a', answeredAt: ts }))]);
    expect(threadKind(d)).toBe('answered');
  });

  it('a withdrawn ask is not a question, and not answered either', () => {
    const t = thread([comment('?', question({ withdrawnAt: ts }))]);
    expect(threadKind(t)).toBe('comment');
  });

  it('a newer ask on an answered thread makes it a question again', () => {
    const t = thread([
      comment('?', question({ answeredAt: ts, answerText: 'Yes' })),
      comment('Follow-up?', question()),
    ]);
    expect(threadKind(t)).toBe('question');
  });

  it('resolved wins over everything — nothing is left to do', () => {
    expect(threadKind(thread([comment('?', question())], 'resolved'))).toBe('resolved');
    expect(threadKind(thread([comment('Hi')], 'resolved'))).toBe('resolved');
  });
});

describe('threadGlyph', () => {
  it('maps the four kinds onto three pictures', () => {
    expect(threadGlyph('comment')).toBe('comment');
    expect(threadGlyph('question')).toBe('question');
    expect(threadGlyph('answered')).toBe('done');
    expect(threadGlyph('resolved')).toBe('done');
  });
});

describe('isOpenAsk', () => {
  it('is true only while a person is on the hook', () => {
    expect(isOpenAsk(thread([comment('?', question())]))).toBe(true);
    expect(isOpenAsk(thread([comment('?', question({ answeredAt: ts }))]))).toBe(false);
    expect(isOpenAsk(thread([comment('?', question())], 'resolved'))).toBe(false);
    expect(isOpenAsk(thread([comment('plain')]))).toBe(false);
  });
});
