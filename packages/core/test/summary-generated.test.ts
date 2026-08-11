/**
 * The generation seam: what a card shows once a generated summary exists.
 *
 * The rule under test throughout is that a stored summary is used ONLY while
 * it still describes the thread. Every assertion that a summary is *ignored*
 * is paired with one proving it would otherwise have been *used* — a stale
 * summary and an absent one look identical from the outside, so without the
 * positive control these tests would pass against a function that ignored
 * stored summaries entirely.
 */

import {
  PROMPT_CHARS_MAX,
  buildSummaryPrompt,
  needsCall,
  parseSummaryResponse,
} from '@feedback/core/summary-prompt';
import { describe, expect, it } from 'vitest';
import {
  NO_REPLIES_TEXT,
  readStoredSummary,
  summaryHash,
  summaryKey,
  threadLines,
} from '../src/thread-summary.ts';
import type { Thread, User } from '../src/types.ts';

const alice: User = { id: 'u1', name: 'Alice', kind: 'known', color: '#111111' };
const bob: User = { id: 'u2', name: 'Bob', kind: 'known', color: '#222222' };

function thread(over: Partial<Thread> = {}): Thread {
  const comments = over.comments ?? [
    { id: 'c1', author: alice, text: 'The retry loop swallows the error.', ts: 1 },
    { id: 'c2', author: bob, text: 'Agreed, fixing it now.', ts: 2 },
  ];
  return {
    id: 't1',
    status: 'open',
    anchor: { kind: 'element', fingerprint: 'x' as never, snippet: { text: 'catch (e) {}' } },
    createdBy: alice,
    commentCount: comments.length,
    lastActivity: 2,
    comments,
    ...over,
  } as Thread;
}

describe('threadLines with a generated summary', () => {
  it('prefers the stored lines when the hash still matches', () => {
    const t = thread();
    const withSummary = {
      ...t,
      summary: {
        topic: 'Retry loop swallows errors',
        discussion: 'Agreed; fix underway',
        hash: summaryHash(t),
      },
    };
    const lines = threadLines(withSummary);
    expect(lines.topic).toBe('Retry loop swallows errors');
    expect(lines.discussion).toBe('Agreed; fix underway');
  });

  it('ignores a summary whose thread has moved on, and falls back cleanly', () => {
    const t = thread();
    const stored = {
      topic: 'Retry loop swallows errors',
      discussion: 'Agreed; fix underway',
      hash: summaryHash(t),
    };
    // Positive control: as it stands, the summary IS used.
    expect(threadLines({ ...t, summary: stored }).topic).toBe('Retry loop swallows errors');

    // A new reply lands. The stored hash now describes a thread that no
    // longer exists, so the card must not keep asserting the old state.
    const moved = thread({
      comments: [
        ...t.comments,
        { id: 'c3', author: alice, text: 'Actually this is a duplicate, closing.', ts: 3 },
      ],
    });
    const lines = threadLines({ ...moved, summary: stored });
    expect(lines.topic).not.toBe('Retry loop swallows errors');
    expect(lines.discussion).toContain('duplicate');
  });

  it('an edited ANCHOR invalidates the summary, not just a new comment', () => {
    // The topic line is derived from the anchor snippet, which moves
    // independently of the comments. Hashing comments alone would strand an
    // edited anchor with a topic describing text that is no longer there.
    const t = thread();
    const stored = { topic: 'Old topic', discussion: 'Old discussion', hash: summaryHash(t) };
    expect(threadLines({ ...t, summary: stored }).topic).toBe('Old topic');

    const reanchored = thread({
      anchor: {
        kind: 'element',
        fingerprint: 'x' as never,
        snippet: { text: 'catch (e) { report(e); }' },
      } as Thread['anchor'],
    });
    expect(summaryHash(reanchored)).not.toBe(stored.hash);
    expect(threadLines({ ...reanchored, summary: stored }).topic).not.toBe('Old topic');
  });

  it('never lets a generated line invent a discussion on a thread with no replies', () => {
    const solo = thread({
      comments: [{ id: 'c1', author: alice, text: 'Is this still needed?', ts: 1 }],
    });
    const lines = threadLines({
      ...solo,
      summary: {
        topic: 'Whether the helper is still needed',
        // A model that ignores the "return an empty string" instruction must
        // still not be able to put words in an empty thread's mouth.
        discussion: 'Team agreed to delete it',
        hash: summaryHash(solo),
      },
    });
    expect(lines.topic).toBe('Whether the helper is still needed');
    expect(lines.discussion).toBe(NO_REPLIES_TEXT);
    expect(lines.discussionKind).toBe('none');
  });

  it('falls back per-line when the model returned a blank', () => {
    const t = thread();
    const lines = threadLines({
      ...t,
      summary: { topic: '', discussion: 'Agreed; fix underway', hash: summaryHash(t) },
    });
    expect(lines.topic).toBe('catch (e) {}'); // deterministic topic survives
    expect(lines.discussion).toBe('Agreed; fix underway');
  });
});

describe('summaryKey covers generated text', () => {
  // The documented failure mode: a card repaints only when its render key
  // moves, so a summary that changes no keyed term is generated, stored,
  // synced — and never seen.
  it('moves when a summary lands', () => {
    const t = thread();
    const before = summaryKey(t);
    const after = summaryKey({
      ...t,
      summary: {
        topic: 'Retry loop swallows errors',
        discussion: 'Agreed; fix underway',
        hash: summaryHash(t),
      },
    });
    expect(after).not.toBe(before);
  });

  it('does NOT move for a stale summary, because nothing on screen changed', () => {
    const t = thread();
    const stale = { topic: 'Something else', discussion: 'Something else', hash: 'deadbeef' };
    expect(summaryKey({ ...t, summary: stale })).toBe(summaryKey(t));
  });
});

describe('needsCall', () => {
  it('is true with no stored summary and false once one matches', () => {
    const t = thread();
    expect(needsCall(t, null)).toBe(true);
    expect(needsCall(t, { topic: 'a', discussion: 'b', hash: summaryHash(t) })).toBe(false);
    expect(needsCall(t, { topic: 'a', discussion: 'b', hash: 'stale' })).toBe(true);
  });

  it('is false for a thread with nothing in it', () => {
    expect(needsCall(thread({ comments: [] }), null)).toBe(false);
  });
});

describe('parseSummaryResponse', () => {
  it('reads a clean object', () => {
    expect(parseSummaryResponse('{"topic":"A topic","discussion":"A discussion"}')).toEqual({
      topic: 'A topic',
      discussion: 'A discussion',
    });
  });

  it('tolerates a code fence and a lead-in sentence', () => {
    const raw = 'Sure! Here you go:\n```json\n{"topic":"A topic","discussion":"A discussion"}\n```';
    expect(parseSummaryResponse(raw)?.topic).toBe('A topic');
  });

  it('strips wrapping quotes and trailing sentence punctuation', () => {
    expect(parseSummaryResponse('{"topic":"\\"A topic\\".","discussion":"Done."}')).toEqual({
      topic: 'A topic',
      discussion: 'Done',
    });
  });

  it('leaves an over-long line intact for the browser to ellipsize', () => {
    // We used to cut at 80/120 chars and append our own "…", which put a
    // literal ellipsis in the STORED text at a width unrelated to the row it
    // renders in — and then the row's `text-overflow: ellipsis` truncated it
    // again. One truncation, at the real width, done by the browser.
    const long = 'word '.repeat(60).trim();
    const out = parseSummaryResponse(JSON.stringify({ topic: long, discussion: long }));
    expect(out?.topic).toBe(long);
    expect(out?.discussion).toBe(long);
    expect(out?.topic.includes('…')).toBe(false);
  });

  it('returns null on anything that is not a usable summary', () => {
    expect(parseSummaryResponse('no json here')).toBeNull();
    expect(parseSummaryResponse('{"topic":"only"}')).toBeNull();
    expect(parseSummaryResponse('{"topic":5,"discussion":"x"}')).toBeNull();
    expect(parseSummaryResponse('{"topic":"  ","discussion":"x"}')).toBeNull();
    expect(parseSummaryResponse('{ broken')).toBeNull();
  });
});

describe('buildSummaryPrompt', () => {
  it('includes the anchor text and every comment', () => {
    const { user } = buildSummaryPrompt(thread());
    expect(user).toContain('catch (e) {}');
    expect(user).toContain('The retry loop swallows the error.');
    expect(user).toContain('Agreed, fixing it now.');
    expect(user).toContain('[Alice]');
  });

  it('tells the model there is nothing to summarize on a reply-less thread', () => {
    const { user } = buildSummaryPrompt(
      thread({ comments: [{ id: 'c1', author: alice, text: 'One comment', ts: 1 }] }),
    );
    expect(user).toContain('No replies yet');
  });

  it('caps one enormous comment instead of paying to send it', () => {
    const huge = `START${'x'.repeat(500_000)}END`;
    const { user } = buildSummaryPrompt(
      thread({
        comments: [
          { id: 'c1', author: alice, text: huge, ts: 1 },
          { id: 'c2', author: bob, text: 'that was a lot', ts: 2 },
        ],
      }),
    );
    expect(user.length).toBeLessThanOrEqual(PROMPT_CHARS_MAX + 1_000);
    // Clipped from the END, so the comment is still recognisable...
    expect(user).toContain('START');
    expect(user).not.toContain('END');
    // ...and clipping the giant one must not evict the rest of the thread.
    expect(user).toContain('that was a lot');
  });

  it('keeps the opening comment and the latest ones when a thread runs long', () => {
    const comments = Array.from({ length: 400 }, (_, i) => ({
      id: `c${i}`,
      author: i % 2 ? bob : alice,
      text: `reply number ${i} ${'padding '.repeat(20)}`,
      ts: i + 1,
    }));
    comments[0] = { id: 'c0', author: alice, text: 'THE OPENING ASK', ts: 1 };
    const { user } = buildSummaryPrompt(thread({ comments }));

    expect(user.length).toBeLessThanOrEqual(PROMPT_CHARS_MAX + 1_000);
    // The topic line is made from the opening comment and the discussion line
    // from where the thread got to, so those are the two ends that must stay.
    expect(user).toContain('THE OPENING ASK');
    expect(user).toContain('reply number 399');
    // The middle is what goes, and it says so rather than pretending the
    // thread was always this short.
    expect(user).not.toContain('reply number 100 ');
    expect(user).toContain('omitted');
  });

  it('leaves an ordinary thread completely intact', () => {
    // The cap must not be doing anything on the threads people actually have —
    // otherwise the two tests above would pass against a function that always
    // elided.
    const { user } = buildSummaryPrompt(thread());
    expect(user).toContain('The retry loop swallows the error.');
    expect(user).toContain('Agreed, fixing it now.');
    expect(user).not.toContain('omitted');
  });
});

describe('readStoredSummary', () => {
  const good = { topic: 'a topic', discussion: 'a discussion', hash: 'deadbeef' };

  it('accepts a well-formed summary', () => {
    expect(readStoredSummary(good)).toEqual(good);
  });

  it('rejects a summary whose discussion is not a string', () => {
    // Any synced peer — a share visitor included — can write an arbitrary
    // shape into the thread's Y.Map; Yjs sync has no server-side write
    // authority. A truthy non-string `discussion` wins the
    // `stored.discussion || base.discussion` choice in `threadLines` and
    // reaches a card row typed `string`, rendering as '[object Object]'.
    expect(readStoredSummary({ ...good, discussion: { a: 1 } })).toBeUndefined();
    expect(readStoredSummary({ ...good, discussion: 42 })).toBeUndefined();
    expect(readStoredSummary({ topic: 'a topic', hash: 'deadbeef' })).toBeUndefined();
  });

  it('rejects a missing topic, a missing hash, and a non-object', () => {
    expect(readStoredSummary({ ...good, topic: undefined })).toBeUndefined();
    expect(readStoredSummary({ ...good, hash: 5 })).toBeUndefined();
    expect(readStoredSummary(null)).toBeUndefined();
    expect(readStoredSummary('a string')).toBeUndefined();
  });

  it('drops anything else riding on the stored value', () => {
    expect(readStoredSummary({ ...good, extra: 'not part of the contract' })).toEqual(good);
  });
});

describe('a malformed summary cannot reach the card', () => {
  it('leaves the deterministic discussion line in place', () => {
    const t = thread();
    const hash = summaryHash(t);
    // Positive control: a well-formed summary at this hash IS used.
    expect(threadLines({ ...t, summary: { topic: 'T', discussion: 'D', hash } }).discussion).toBe(
      'D',
    );
    const lifted = readStoredSummary({ topic: 'T', discussion: { evil: 1 }, hash });
    const lines = threadLines({ ...t, ...(lifted ? { summary: lifted } : {}) });
    expect(lines.discussion).toBe('Agreed, fixing it now.');
    expect(typeof lines.discussion).toBe('string');
  });
});
