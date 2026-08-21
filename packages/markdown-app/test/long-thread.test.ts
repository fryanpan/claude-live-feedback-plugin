import type { Comment, ReviewPayload, Thread, User } from '@feedback/core';
import { describe, expect, it } from 'vitest';
import {
  LONG_THREAD_WORDS,
  threadDecision,
  threadNeedsModal,
  threadWordCount,
} from '../src/long-thread.ts';

/**
 * Which threads have outgrown the balloon column.
 *
 * Two rules, and they are deliberately independent: a thread is too long to
 * read in a 300px column, OR it carries a decision — which renders badly there
 * at any length, because the options are buttons and the buttons wrap.
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

/** N words of synthetic prose — never a real quotation. */
function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
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

const questionPayload = (over: Partial<ReviewPayload> = {}): ReviewPayload => ({
  shape: 'review',
  headline: 'Read the intro',
  why: 'It sets up everything after it',
  ...over,
});

describe('threadWordCount — everything the opened card would show', () => {
  it('counts the words in every comment, not just the opening one', () => {
    expect(threadWordCount(thread([comment(words(10)), comment(words(15))]))).toBe(25);
  });

  it('counts a declaration’s prose, because the item card renders all of it', () => {
    const bare = threadWordCount(thread([comment(words(5))]));
    const declared = threadWordCount(
      thread([comment(words(5), questionPayload({ detail: words(40), lookFor: words(6) }))]),
    );
    expect(declared).toBeGreaterThan(bare + 40);
  });

  it('counts the option labels and their detail — they are the tallest part', () => {
    const withDetail = threadWordCount(
      thread([
        comment(
          'x',
          decisionPayload({
            options: [
              { id: 'a', label: 'Write through', detail: words(30) },
              { id: 'b', label: 'Write behind', detail: words(30) },
            ],
          }),
        ),
      ]),
    );
    const withoutDetail = threadWordCount(thread([comment('x', decisionPayload())]));
    expect(withDetail - withoutDetail).toBe(60);
  });

  it('ignores the generated summary — it is a condensation of words already counted', () => {
    const t = thread([comment(words(10))], {
      summary: { topic: words(20), discussion: words(20), hash: 'h' },
    });
    expect(threadWordCount(t)).toBe(10);
  });

  it('treats runs of whitespace and newlines as one separator', () => {
    expect(threadWordCount(thread([comment('  one\n\ntwo   three \t four  ')]))).toBe(4);
  });

  it('is zero for a thread whose comments are all empty', () => {
    expect(threadWordCount(thread([comment('   ')]))).toBe(0);
  });
});

describe('threadDecision — what the indicator reports', () => {
  it('finds nothing on an ordinary thread', () => {
    expect(threadDecision(thread([comment(words(5))]))).toBe('none');
  });

  it('finds nothing on a thread carrying a plain question', () => {
    expect(threadDecision(thread([comment('x', questionPayload())]))).toBe('none');
  });

  it('reports a pending decision as needing one', () => {
    expect(threadDecision(thread([comment('x', decisionPayload())]))).toBe('pending');
  });

  it('reports an answered decision as settled, not as still needing one', () => {
    const answered = decisionPayload({ answeredAt: ts, answeredBy: 'Alice', answerText: 'A' });
    expect(threadDecision(thread([comment('x', answered)]))).toBe('answered');
  });

  it('a resolved thread has nothing pending, so its decision reads settled', () => {
    const t = thread([comment('x', decisionPayload())], { status: 'resolved' });
    expect(threadDecision(t)).toBe('answered');
  });

  it('a newer unanswered decision outranks an older settled one', () => {
    const settled = comment('x', decisionPayload({ answeredAt: ts, answerText: 'A' }));
    const asked = comment('y', decisionPayload());
    expect(threadDecision(thread([settled, asked]))).toBe('pending');
  });
});

describe('threadNeedsModal — which threads outgrow the balloon column', () => {
  it('leaves a short ordinary thread inline', () => {
    expect(threadNeedsModal(thread([comment(words(20))]))).toBe(false);
  });

  it('opens a thread longer than the threshold in the modal', () => {
    expect(threadNeedsModal(thread([comment(words(LONG_THREAD_WORDS + 1))]))).toBe(true);
  });

  it('leaves a thread sitting exactly on the threshold inline', () => {
    expect(threadNeedsModal(thread([comment(words(LONG_THREAD_WORDS))]))).toBe(false);
  });

  it('counts the whole conversation towards the threshold, not the longest comment', () => {
    const half = Math.ceil(LONG_THREAD_WORDS / 2) + 1;
    expect(threadNeedsModal(thread([comment(words(half)), comment(words(half))]))).toBe(true);
  });

  it('opens a short decision in the modal anyway — the options need the width', () => {
    const t = thread([comment('Which one?', decisionPayload())]);
    expect(threadWordCount(t)).toBeLessThan(LONG_THREAD_WORDS);
    expect(threadNeedsModal(t)).toBe(true);
  });

  it('keeps an answered decision in the modal — the record is the same card', () => {
    const answered = decisionPayload({ answeredAt: ts, answerText: 'Write through' });
    expect(threadNeedsModal(thread([comment('Which one?', answered)]))).toBe(true);
  });

  it('does not promote a short plain question', () => {
    expect(threadNeedsModal(thread([comment('Have a look', questionPayload())]))).toBe(false);
  });
});
