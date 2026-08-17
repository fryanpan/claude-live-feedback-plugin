import { describe, expect, it, vi } from 'vitest';
import { applyRefresh, refreshReviewItems } from '../src/hub/hub-model.ts';

/**
 * What these cover: during a server restart the board's REST-backed regions
 * refresh against a server that isn't answering. `fetchJson` returns null on
 * any failure, so the old `res?.items ?? []` turned "I couldn't ask" into
 * "there is nothing waiting on you" — the board gutted itself at exactly the
 * moment it needed to look like it was coming back.
 */

const item = (id: string) =>
  ({ threadId: id, docId: 'd1', label: id, ts: 1 }) as unknown as Parameters<
    typeof refreshReviewItems
  >[0]['reviewItems'][number];

describe('applyRefresh', () => {
  it('takes the new value when the request actually answered', () => {
    // POSITIVE CONTROL: proves the helper can change anything at all, so the
    // "keeps the old value" case below isn't passing by never updating.
    expect(applyRefresh([1, 2], { items: [3] }, (r) => r.items)).toEqual([3]);
  });

  it('keeps the last good value when the request did not complete', () => {
    expect(applyRefresh([1, 2], null, (r: { items: number[] }) => r.items)).toEqual([1, 2]);
  });

  it('accepts a genuinely empty answer — an empty list is an answer', () => {
    // The guard must key on "did the request complete", never on "is the
    // result empty". A workspace whose last thread was resolved really does
    // have nothing waiting, and must be allowed to say so.
    expect(applyRefresh([1, 2], { items: [] }, (r) => r.items)).toEqual([]);
  });

  it('distinguishes a null payload from a null-valued field', () => {
    expect(applyRefresh('old', { v: null }, (r) => r.v)).toBeNull();
  });
});

describe('refreshReviewItems', () => {
  it('replaces the strip when the server answers', async () => {
    const state = { reviewItems: [item('a')] };
    await refreshReviewItems(state, async () => ({ items: [item('b'), item('c')] }));
    expect(state.reviewItems.map((i) => i.threadId)).toEqual(['b', 'c']);
  });

  it('survives a refresh that could not reach the server', async () => {
    const state = { reviewItems: [item('a'), item('b')] };
    const fetchItems = vi.fn(async () => null);

    await refreshReviewItems(state, fetchItems);

    expect(fetchItems).toHaveBeenCalledTimes(1); // the refresh really ran
    expect(state.reviewItems.map((i) => i.threadId)).toEqual(['a', 'b']);
  });

  it('clears the strip when the server says it is genuinely empty', async () => {
    const state = { reviewItems: [item('a')] };
    await refreshReviewItems(state, async () => ({ items: [] }));
    expect(state.reviewItems).toEqual([]);
  });

  it('treats a payload with no items key as empty, not as a failure', async () => {
    const state = { reviewItems: [item('a')] };
    await refreshReviewItems(state, async () => ({}));
    expect(state.reviewItems).toEqual([]);
  });
});
