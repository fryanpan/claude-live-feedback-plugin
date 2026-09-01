import { describe, expect, it } from 'vitest';
import { parseThreadReviewItemId, threadReviewItemId } from './review-item-id.ts';

describe('threadReviewItemId', () => {
  it('round-trips an ordinary doc-thread address', () => {
    const id = threadReviewItemId('task:t-abc123', 'th-9f2', 'c-77aa');
    expect(id.startsWith('rt-')).toBe(true);
    expect(parseThreadReviewItemId(id)).toEqual({
      docId: 'task:t-abc123',
      threadId: 'th-9f2',
      commentId: 'c-77aa',
    });
  });

  it('is deterministic — the same address always derives the same id', () => {
    expect(threadReviewItemId('d1', 't1', 'c1')).toBe(threadReviewItemId('d1', 't1', 'c1'));
  });

  it('is URL-safe: no characters a path segment or query would mangle', () => {
    const id = threadReviewItemId('review/some doc+name', 'thread?x', 'c&d');
    expect(id).toMatch(/^rt-[A-Za-z0-9_-]+$/);
    expect(parseThreadReviewItemId(id)).toEqual({
      docId: 'review/some doc+name',
      threadId: 'thread?x',
      commentId: 'c&d',
    });
  });

  it('survives non-ASCII doc ids', () => {
    const id = threadReviewItemId('docs/план-№7.md', 't-1', 'c-2');
    expect(parseThreadReviewItemId(id)?.docId).toBe('docs/план-№7.md');
  });

  it('keeps the whole docId even when it contains a newline — the two minted ids split from the end', () => {
    const id = threadReviewItemId('weird\ndoc', 't-1', 'c-2');
    expect(parseThreadReviewItemId(id)).toEqual({
      docId: 'weird\ndoc',
      threadId: 't-1',
      commentId: 'c-2',
    });
  });

  it('two different addresses never derive the same id', () => {
    expect(threadReviewItemId('d', 't', 'c1')).not.toBe(threadReviewItemId('d', 't', 'c2'));
    expect(threadReviewItemId('d', 't1', 'c')).not.toBe(threadReviewItemId('d', 't2', 'c'));
  });
});

describe('parseThreadReviewItemId', () => {
  it('answers undefined for a ticket item id — those are opaque, not encoded addresses', () => {
    expect(parseThreadReviewItemId('r-4b2eXaY91Qwe')).toBeUndefined();
    expect(parseThreadReviewItemId('r-legacy')).toBeUndefined();
  });

  it('answers undefined for garbage after the prefix', () => {
    expect(parseThreadReviewItemId('rt-!!!not base64url')).toBeUndefined();
    expect(parseThreadReviewItemId('rt-')).toBeUndefined();
  });

  it('answers undefined when a decoded part is empty', () => {
    // 'a\n\nc' decodes but its threadId is empty — an address with a blank
    // segment addresses nothing.
    expect(parseThreadReviewItemId(threadReviewItemId('a', '', 'c'))).toBeUndefined();
    expect(parseThreadReviewItemId(threadReviewItemId('', 't', 'c'))).toBeUndefined();
    expect(parseThreadReviewItemId(threadReviewItemId('a', 't', ''))).toBeUndefined();
  });

  it('answers undefined for a decoded blob with no separators at all', () => {
    expect(parseThreadReviewItemId('rt-aGVsbG8')).toBeUndefined(); // "hello"
  });
});
