/**
 * Unit coverage for `ThreadRequestDedup` in isolation — the route-level
 * behaviour (the actual HTTP contract) is `double-comment-submit.test.ts`.
 * This file pins the TTL, the anchor/text mismatch guard, and the
 * concurrent-reservation race directly, without spinning up a server.
 */
import { describe, expect, it } from 'bun:test';
import { ThreadRequestDedup } from '../src/thread-request-dedup.ts';

describe('ThreadRequestDedup', () => {
  it('runs create() once for a request never seen before', async () => {
    const d = new ThreadRequestDedup<string | null>();
    const { value, deduped } = await d.dedupe('doc1', 'r1', 'hello', 'anchor-a', async () => 't1');
    expect(value).toBe('t1');
    expect(deduped).toBe(false);
  });

  it('a matching repeat reuses the recorded result and does not call create() again', async () => {
    const d = new ThreadRequestDedup<string | null>();
    let calls = 0;
    const make = async () => {
      calls++;
      return 't1';
    };
    await d.dedupe('doc1', 'r1', 'hello', 'anchor-a', make);
    const { value, deduped } = await d.dedupe('doc1', 'r1', 'hello', 'anchor-a', make);
    expect(value).toBe('t1');
    expect(deduped).toBe(true);
    expect(calls).toBe(1);
  });

  it('a different docId does not match — requestIds are not globally unique', async () => {
    const d = new ThreadRequestDedup<string | null>();
    await d.dedupe('doc1', 'r1', 'hello', 'anchor-a', async () => 't1');
    const { deduped } = await d.dedupe('doc2', 'r1', 'hello', 'anchor-a', async () => 't2');
    expect(deduped).toBe(false);
  });

  it('a reused requestId with different text is a new comment, not a collision', async () => {
    const d = new ThreadRequestDedup<string | null>();
    await d.dedupe('doc1', 'r1', 'hello', 'anchor-a', async () => 't1');
    const { value, deduped } = await d.dedupe(
      'doc1',
      'r1',
      'goodbye',
      'anchor-a',
      async () => 't2',
    );
    expect(value).toBe('t2');
    expect(deduped).toBe(false);
  });

  it('a reused requestId with a different anchor is a new comment', async () => {
    const d = new ThreadRequestDedup<string | null>();
    await d.dedupe('doc1', 'r1', 'hello', 'anchor-a', async () => 't1');
    const { deduped } = await d.dedupe('doc1', 'r1', 'hello', 'anchor-b', async () => 't2');
    expect(deduped).toBe(false);
  });

  it('no requestId always runs create() — old clients get no dedup, not a refusal', async () => {
    const d = new ThreadRequestDedup<string | null>();
    let calls = 0;
    const make = async () => {
      calls++;
      return 't1';
    };
    await d.dedupe('doc1', undefined, 'hello', 'anchor-a', make);
    await d.dedupe('doc1', undefined, 'hello', 'anchor-a', make);
    expect(calls).toBe(2);
  });

  it('a failed create (null) is not remembered — a real retry gets a fresh attempt', async () => {
    const d = new ThreadRequestDedup<string | null>();
    let calls = 0;
    await d.dedupe('doc1', 'r1', 'hello', 'anchor-a', async () => {
      calls++;
      return null;
    });
    const { value, deduped } = await d.dedupe('doc1', 'r1', 'hello', 'anchor-a', async () => {
      calls++;
      return 't1';
    });
    expect(value).toBe('t1');
    expect(deduped).toBe(false);
    expect(calls).toBe(2);
  });

  it('a rejected create is not remembered — a retry after a thrown error gets a fresh attempt', async () => {
    const d = new ThreadRequestDedup<string | null>();
    let calls = 0;
    await expect(
      d.dedupe('doc1', 'r1', 'hello', 'anchor-a', async () => {
        calls++;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { value, deduped } = await d.dedupe('doc1', 'r1', 'hello', 'anchor-a', async () => {
      calls++;
      return 't1';
    });
    expect(value).toBe('t1');
    expect(deduped).toBe(false);
    expect(calls).toBe(2);
  });

  it('expires after the TTL', async () => {
    const d = new ThreadRequestDedup<string | null>(10);
    await d.dedupe('doc1', 'r1', 'hello', 'anchor-a', async () => 't1');
    const start = Date.now();
    while (Date.now() - start < 15) {
      // busy-wait past the 10ms TTL — deterministic, no fake timers needed
      // for a window this short.
    }
    const { deduped } = await d.dedupe('doc1', 'r1', 'hello', 'anchor-a', async () => 't2');
    expect(deduped).toBe(false);
  });

  it('a requestId reused for a distinct payload does not evict the original — a later retry of the original still finds it', async () => {
    // Codex review: a single-slot map meant reusing a requestId for a
    // genuinely different comment (allowed — see "a reused requestId with
    // different text/anchor" above) overwrote the FIRST entry outright. A
    // later retry of the original comment then found nothing recorded and
    // created a duplicate.
    const d = new ThreadRequestDedup<string | null>();
    let calls = 0;
    const first = await d.dedupe('doc1', 'r1', 'hello', 'anchor-a', async () => {
      calls++;
      return 't1';
    });
    expect(first.value).toBe('t1');

    const second = await d.dedupe('doc1', 'r1', 'goodbye', 'anchor-a', async () => {
      calls++;
      return 't2';
    });
    expect(second.value).toBe('t2');
    expect(calls).toBe(2);

    // A retry of the FIRST comment's exact payload, same requestId.
    const retry = await d.dedupe('doc1', 'r1', 'hello', 'anchor-a', async () => {
      calls++;
      return 't1-duplicate';
    });
    expect(retry.value).toBe('t1');
    expect(retry.deduped).toBe(true);
    expect(calls).toBe(2);
  });

  it('an in-flight create outlives the TTL — the clock only starts at completion', async () => {
    // Codex review: the TTL used to run from RESERVATION, so a create()
    // slower than the TTL could be pruned mid-flight, and a concurrent
    // duplicate arriving after that would miss the reservation and create a
    // second thread even though the first was still running.
    const d = new ThreadRequestDedup<string | null>(10);
    let resolveFirst: ((v: string) => void) | undefined;
    const first = d.dedupe(
      'doc1',
      'r1',
      'hello',
      'anchor-a',
      () => new Promise<string>((resolve) => (resolveFirst = resolve)),
    );
    const start = Date.now();
    while (Date.now() - start < 15) {
      // busy-wait well past the 10ms TTL while the first create is still
      // unresolved.
    }
    let secondCalls = 0;
    const second = d.dedupe('doc1', 'r1', 'hello', 'anchor-a', async () => {
      secondCalls++;
      return 't2';
    });
    resolveFirst?.('t1');
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.value).toBe('t1');
    expect(secondResult.value).toBe('t1');
    expect(secondResult.deduped).toBe(true);
    expect(secondCalls).toBe(0);
  });

  it('a completed entry is remembered for the full TTL measured from completion, not from reservation', async () => {
    const d = new ThreadRequestDedup<string | null>(15);
    let resolveFirst: ((v: string) => void) | undefined;
    const first = d.dedupe(
      'doc1',
      'r1',
      'hello',
      'anchor-a',
      () => new Promise<string>((resolve) => (resolveFirst = resolve)),
    );
    const start = Date.now();
    while (Date.now() - start < 20) {
      // The reservation is already older than the 15ms TTL — if the clock
      // ran from reservation, the entry below would already be gone.
    }
    resolveFirst?.('t1');
    await first;
    const { value, deduped } = await d.dedupe('doc1', 'r1', 'hello', 'anchor-a', async () => 't2');
    expect(value).toBe('t1');
    expect(deduped).toBe(true);
  });

  /**
   * The race codex flagged in review: a naive check-then-create (look up,
   * `await create()`, THEN record) lets two requests that both arrive while
   * the first is still in flight both see nothing recorded and both create.
   * The fix reserves the entry — with the in-flight PROMISE — synchronously,
   * before `create` is ever awaited, so a concurrent second call always
   * finds the reservation and awaits the first call's own promise instead of
   * starting a second one.
   */
  it('two concurrent calls for the same request only ever run create() once', async () => {
    const d = new ThreadRequestDedup<string | null>();
    let calls = 0;
    let resolveFirst: ((v: string) => void) | undefined;
    const create = () => {
      calls++;
      if (calls === 1) {
        return new Promise<string>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve('t2');
    };
    const first = d.dedupe('doc1', 'r1', 'hello', 'anchor-a', create);
    // Fired before the first call's create() has resolved — the reservation
    // must already be in place from the synchronous part of `dedupe`.
    const second = d.dedupe('doc1', 'r1', 'hello', 'anchor-a', create);
    resolveFirst?.('t1');
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(a.value).toBe('t1');
    expect(b.value).toBe('t1');
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
  });
});
