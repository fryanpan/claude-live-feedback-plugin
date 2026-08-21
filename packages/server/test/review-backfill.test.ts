import { describe, expect, it } from 'bun:test';
import type { DocMeta } from '@feedback/core';
import { backfillReviewFiling, reviewIdsNeedingFiling } from '../src/review-backfill.ts';

const doc = (over: Partial<DocMeta>): DocMeta => ({
  docId: over.docId ?? 'd',
  type: 'markdown',
  createdAt: 0,
  ...over,
});

describe('reviewIdsNeedingFiling', () => {
  it('names each review exactly once, however many members it has', () => {
    const ids = reviewIdsNeedingFiling(
      [
        doc({ docId: 'r:a', setId: 'r', relPath: 'a.ts' }),
        doc({ docId: 'r:b', setId: 'r', relPath: 'b.ts' }),
        doc({ docId: 'r:c', setId: 'r', relPath: 'c.ts' }),
      ],
      () => false,
    );
    expect(ids).toEqual(['r']);
  });

  it('skips a review already filed on a workspace', () => {
    const docs = [doc({ docId: 'r:a', setId: 'r', relPath: 'a.ts' })];
    expect(reviewIdsNeedingFiling(docs, (id) => id === 'r')).toEqual([]);
  });

  it('skips a batch-registered set, which is not a review', () => {
    // setId without relPath: docs registered together for one sidebar. Filing
    // them would put rows on a board for things that are not reviews.
    const docs = [doc({ docId: 'n1', setId: 'notes' }), doc({ docId: 'n2', setId: 'notes' })];
    expect(reviewIdsNeedingFiling(docs, () => false)).toEqual([]);
  });

  it('skips standalone docs', () => {
    expect(reviewIdsNeedingFiling([doc({ docId: 'plain' })], () => false)).toEqual([]);
  });

  it('finds a member that carries only the deprecated field', () => {
    const docs = [doc({ docId: 'r:a', workspaceId: 'r', relPath: 'a.ts' })];
    expect(reviewIdsNeedingFiling(docs, () => false)).toEqual(['r']);
  });

  it('returns ids in a stable order so two boots agree', () => {
    const docs = [
      doc({ docId: 'z:a', setId: 'zeta', relPath: 'a.ts' }),
      doc({ docId: 'a:a', setId: 'alpha', relPath: 'a.ts' }),
      doc({ docId: 'm:a', setId: 'mu', relPath: 'a.ts' }),
    ];
    expect(reviewIdsNeedingFiling(docs, () => false)).toEqual(['alpha', 'mu', 'zeta']);
  });
});

describe('backfillReviewFiling', () => {
  it('files an orphan review and reports where it went', () => {
    const filed: Array<[string, string]> = [];
    const res = backfillReviewFiling({
      docs: () => [doc({ docId: 'r:a', setId: 'r', relPath: 'a.ts' })],
      isFiled: () => false,
      file: (id) => {
        filed.push([id, 'w-default']);
        return 'w-default';
      },
    });
    expect(filed).toEqual([['r', 'w-default']]);
    expect(res.filed).toEqual([{ reviewId: 'r', workspaceId: 'w-default' }]);
  });

  it('is a no-op on the second boot — the whole point, since it runs at every start', () => {
    const store = new Set<string>();
    const docs = () => [doc({ docId: 'r:a', setId: 'r', relPath: 'a.ts' })];
    const deps = {
      docs,
      isFiled: (id: string) => store.has(id),
      file: (id: string) => {
        store.add(id);
        return 'w-default';
      },
    };
    const first = backfillReviewFiling(deps);
    const second = backfillReviewFiling(deps);
    expect(first.filed).toHaveLength(1);
    expect(second.filed).toHaveLength(0);
    expect(store.size).toBe(1);
  });

  it('never writes when everything is already filed', () => {
    let writes = 0;
    const res = backfillReviewFiling({
      docs: () => [doc({ docId: 'r:a', setId: 'r', relPath: 'a.ts' })],
      isFiled: () => true,
      file: () => {
        writes += 1;
        return 'w';
      },
    });
    expect(writes).toBe(0);
    expect(res.filed).toEqual([]);
  });

  it('keeps going when one review fails to file', () => {
    // A single bad review must not stop the boot or strand the rest.
    const res = backfillReviewFiling({
      docs: () => [
        doc({ docId: 'a:x', setId: 'a', relPath: 'x.ts' }),
        doc({ docId: 'b:x', setId: 'b', relPath: 'x.ts' }),
      ],
      isFiled: () => false,
      file: (id) => {
        if (id === 'a') throw new Error('store unavailable');
        return 'w';
      },
    });
    expect(res.filed).toEqual([{ reviewId: 'b', workspaceId: 'w' }]);
    expect(res.failed).toEqual(['a']);
  });
});
