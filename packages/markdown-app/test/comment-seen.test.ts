import { describe, expect, it } from 'vitest';
import {
  type SeenStorage,
  createSeenTracker,
  isNewThread,
  seenStorageKey,
} from '../src/comment-seen.ts';

/**
 * The red "new" dot: a comment that arrived since the reader last viewed
 * (comments mock 3). Per doc, per browser, in localStorage, and every storage
 * call survives a store that throws.
 */

function memoryStorage(
  seed: Record<string, string> = {},
): SeenStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

describe('isNewThread — the pure rule', () => {
  const view = { firstVisit: false, mountedAt: 1000 };

  it('an unseen thread is new on a return visit', () => {
    expect(isNewThread({ threads: {} }, { id: 'a', lastActivity: 500 }, view)).toBe(true);
  });

  it('a seen thread is new again once it has newer activity', () => {
    const record = { threads: { a: 500 } };
    expect(isNewThread(record, { id: 'a', lastActivity: 500 }, view)).toBe(false);
    expect(isNewThread(record, { id: 'a', lastActivity: 700 }, view)).toBe(true);
  });

  it('a first visit marks nothing that was already there…', () => {
    const first = { firstVisit: true, mountedAt: 1000 };
    expect(isNewThread({ threads: {} }, { id: 'a', lastActivity: 500 }, first)).toBe(false);
  });

  it('…but a thread born during the first visit is still new', () => {
    const first = { firstVisit: true, mountedAt: 1000 };
    expect(isNewThread({ threads: {} }, { id: 'a', lastActivity: 1500 }, first)).toBe(true);
  });
});

describe('createSeenTracker', () => {
  it('keys the record per doc', () => {
    expect(seenStorageKey('d-1')).toBe('lf:seen:d-1');
    expect(seenStorageKey('d-2')).not.toBe(seenStorageKey('d-1'));
  });

  it('first visit: nothing is new, and seeing one thread does not make the others new', () => {
    const storage = memoryStorage();
    const tracker = createSeenTracker({ docId: 'd', storage, now: () => 1000 });
    const a = { id: 'a', lastActivity: 100 };
    const b = { id: 'b', lastActivity: 200 };
    expect(tracker.isNew(a)).toBe(false);
    expect(tracker.markSeen(a)).toBe(false); // nothing changed — it was not new
    expect(tracker.isNew(b)).toBe(false);
  });

  it('return visit: unseen threads are new until they have sat in view', () => {
    const storage = memoryStorage({
      [seenStorageKey('d')]: JSON.stringify({ threads: { a: 100 } }),
    });
    const tracker = createSeenTracker({ docId: 'd', storage, now: () => 1000 });
    const b = { id: 'b', lastActivity: 200 };
    expect(tracker.isNew({ id: 'a', lastActivity: 100 })).toBe(false);
    expect(tracker.isNew(b)).toBe(true);
    expect(tracker.markSeen(b)).toBe(true);
    expect(tracker.isNew(b)).toBe(false);
    // …and the record was written for next time.
    expect(JSON.parse(storage.data.get(seenStorageKey('d')) ?? '{}')).toEqual({
      threads: { a: 100, b: 200 },
    });
  });

  it('a reply on a seen thread makes it new again', () => {
    const storage = memoryStorage({
      [seenStorageKey('d')]: JSON.stringify({ threads: { a: 100 } }),
    });
    const tracker = createSeenTracker({ docId: 'd', storage, now: () => 1000 });
    expect(tracker.isNew({ id: 'a', lastActivity: 300 })).toBe(true);
  });

  it('survives a store that throws, and a corrupt record', () => {
    const throwing: SeenStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const tracker = createSeenTracker({ docId: 'd', storage: throwing, now: () => 1000 });
    expect(tracker.isNew({ id: 'a', lastActivity: 100 })).toBe(false);
    expect(() => tracker.markSeen({ id: 'a', lastActivity: 100 })).not.toThrow();

    const corrupt = memoryStorage({ [seenStorageKey('d')]: '{not json' });
    const t2 = createSeenTracker({ docId: 'd', storage: corrupt, now: () => 1000 });
    expect(t2.isNew({ id: 'a', lastActivity: 100 })).toBe(false);

    // A record with junk in it keeps only the numbers.
    const junk = memoryStorage({
      [seenStorageKey('d')]: JSON.stringify({ threads: { a: 100, b: 'nope' } }),
    });
    const t3 = createSeenTracker({ docId: 'd', storage: junk, now: () => 1000 });
    expect(t3.isNew({ id: 'a', lastActivity: 100 })).toBe(false);
    expect(t3.isNew({ id: 'b', lastActivity: 100 })).toBe(true);
  });
});
