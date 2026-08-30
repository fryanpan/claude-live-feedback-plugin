/**
 * Unit coverage for `ThreadRequestDedup` in isolation — the route-level
 * behaviour (the actual HTTP contract) is `double-comment-submit.test.ts`.
 * This file pins the TTL and the anchor/text mismatch guard directly,
 * without spinning up a server.
 */
import { describe, expect, it } from 'bun:test';
import { ThreadRequestDedup } from '../src/thread-request-dedup.ts';

describe('ThreadRequestDedup', () => {
  it('returns null for a requestId never recorded', () => {
    const d = new ThreadRequestDedup();
    expect(d.matchExisting('doc1', 'r1', 'hello', 'anchor-a')).toBeNull();
  });

  it('returns the recorded thread id for a matching repeat', () => {
    const d = new ThreadRequestDedup();
    d.record('doc1', 'r1', 'hello', 'anchor-a', 't1');
    expect(d.matchExisting('doc1', 'r1', 'hello', 'anchor-a')).toBe('t1');
  });

  it('a different docId does not match — requestIds are not globally unique', () => {
    const d = new ThreadRequestDedup();
    d.record('doc1', 'r1', 'hello', 'anchor-a', 't1');
    expect(d.matchExisting('doc2', 'r1', 'hello', 'anchor-a')).toBeNull();
  });

  it('a reused requestId with different text does not match — a new comment, not a collision', () => {
    const d = new ThreadRequestDedup();
    d.record('doc1', 'r1', 'hello', 'anchor-a', 't1');
    expect(d.matchExisting('doc1', 'r1', 'goodbye', 'anchor-a')).toBeNull();
  });

  it('a reused requestId with a different anchor does not match', () => {
    const d = new ThreadRequestDedup();
    d.record('doc1', 'r1', 'hello', 'anchor-a', 't1');
    expect(d.matchExisting('doc1', 'r1', 'hello', 'anchor-b')).toBeNull();
  });

  it('no requestId never matches, and recording one is a no-op', () => {
    const d = new ThreadRequestDedup();
    d.record('doc1', undefined, 'hello', 'anchor-a', 't1');
    expect(d.matchExisting('doc1', undefined, 'hello', 'anchor-a')).toBeNull();
  });

  it('expires after the TTL', () => {
    const d = new ThreadRequestDedup(10);
    d.record('doc1', 'r1', 'hello', 'anchor-a', 't1');
    expect(d.matchExisting('doc1', 'r1', 'hello', 'anchor-a')).toBe('t1');
    const start = Date.now();
    while (Date.now() - start < 15) {
      // busy-wait past the 10ms TTL — deterministic, no fake timers needed
      // for a window this short.
    }
    expect(d.matchExisting('doc1', 'r1', 'hello', 'anchor-a')).toBeNull();
  });
});
