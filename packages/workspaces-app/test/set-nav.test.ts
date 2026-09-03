import { describe, expect, it } from 'vitest';
import { type SetDoc, selectSetSiblings, setDocsUrl } from '../src/set-nav.ts';

/**
 * The legacy flat-setId sidebar's two decisions, pulled out of `renderSetNav`
 * so they can be measured: what it ASKS the server for, and what it keeps.
 *
 * Both used to be one expression inside the render closure, and the cost was
 * invisible there — the client fetched `/api/docs` whole (4,205,683 bytes for
 * 4,062 rows, measured 2026-08-21) and filtered 6 out of it in a `.filter`
 * nobody could see the size of.
 */

const doc = (docId: string, extra: Partial<SetDoc> = {}): SetDoc => ({
  docId,
  type: 'markdown',
  ...extra,
});

describe('setDocsUrl', () => {
  it('asks the server for one set, not for every doc', () => {
    expect(setDocsUrl('qb-4128')).toBe('/api/docs?setId=qb-4128');
  });

  it('escapes an id that would otherwise change the query', () => {
    expect(setDocsUrl('a&b=c')).toBe('/api/docs?setId=a%26b%3Dc');
  });
});

describe('selectSetSiblings', () => {
  it('keeps the markdown docs of this set and nothing else', () => {
    const docs = [
      doc('a', { setId: 'S', title: 'Alpha' }),
      doc('b', { setId: 'other', title: 'Beta' }),
      doc('c', { setId: 'S', type: 'mockup', title: 'Gamma' }),
    ];
    expect(selectSetSiblings(docs, 'S').map((d) => d.docId)).toEqual(['a']);
  });

  it('still filters when the server ignored the query param', () => {
    // A new client can reach an older server that does not know `?setId=`,
    // which answers with the whole listing. The client-side filter is what
    // keeps that a slow correct render rather than a wrong one, so it stays.
    const docs = [doc('mine', { setId: 'S' }), doc('theirs', { setId: 'T' })];
    expect(selectSetSiblings(docs, 'S').map((d) => d.docId)).toEqual(['mine']);
  });

  it('sorts by title, falling back to the source basename then the id', () => {
    const docs = [
      doc('z-doc', { setId: 'S', title: 'Zebra' }),
      doc('a-doc', { setId: 'S', sourceUrl: '/tmp/api-notes.md' }),
      doc('m-doc', { setId: 'S', title: 'Middle' }),
    ];
    expect(selectSetSiblings(docs, 'S').map((d) => d.docId)).toEqual(['a-doc', 'm-doc', 'z-doc']);
  });

  it('reads the deprecated workspaceId spelling as the set id', () => {
    // Same fallback `reviewIdOf` applies server-side; a doc written before the
    // rename must not drop out of its own sidebar.
    const docs = [doc('old', { workspaceId: 'S' }), doc('other', { workspaceId: 'T' })];
    expect(selectSetSiblings(docs, 'S').map((d) => d.docId)).toEqual(['old']);
  });

  it('returns nothing when the set has no markdown members', () => {
    // The caller uses this emptiness to decide NOT to reserve the sidebar
    // column, so it has to be reachable rather than merely rare.
    expect(selectSetSiblings([doc('only', { setId: 'S', type: 'mockup' })], 'S')).toEqual([]);
  });
});
