import { describe, expect, it } from 'vitest';
import type { DocMeta } from '../src/types.ts';
import { isReviewMember, reviewIdOf } from '../src/review.ts';

const meta = (over: Partial<DocMeta>): DocMeta => ({
  docId: 'd1',
  type: 'markdown',
  createdAt: 0,
  ...over,
});

describe('reviewIdOf', () => {
  it('reads setId, the field a bind writes today', () => {
    expect(reviewIdOf(meta({ setId: 'repo-abc1234-live' }))).toBe('repo-abc1234-live');
  });

  it('falls back to the deprecated workspaceId so a doc written before setId still resolves', () => {
    expect(reviewIdOf(meta({ workspaceId: 'repo-abc1234-live' }))).toBe('repo-abc1234-live');
  });

  it('prefers setId when both are present', () => {
    // Every bind writes the two fields to the same string (binds.ts), so this
    // only ever fires on data no writer produces. Pinned anyway: the fallback
    // must never be able to win, or removing `workspaceId` later changes an
    // answer.
    expect(reviewIdOf(meta({ setId: 'new', workspaceId: 'old' }))).toBe('new');
  });

  it('is undefined for a standalone doc', () => {
    expect(reviewIdOf(meta({}))).toBeUndefined();
  });
});

describe('isReviewMember', () => {
  it('is true for a bind member, which always carries relPath', () => {
    expect(isReviewMember(meta({ setId: 's', relPath: 'src/a.ts' }))).toBe(true);
  });

  it('is false for a batch-registered set with no relPath', () => {
    // 129 such docs exist in the live data dir (measured 2026-08-21): docs
    // registered together by create_review_doc for one sidebar, never a folder
    // or a diff. They must not surface as reviews.
    expect(isReviewMember(meta({ setId: 'sprint-notes' }))).toBe(false);
  });

  it('is false for a standalone doc', () => {
    expect(isReviewMember(meta({ relPath: 'src/a.ts' }))).toBe(false);
    expect(isReviewMember(meta({}))).toBe(false);
  });

  it('accepts a legacy member that carries relPath under the old field only', () => {
    expect(isReviewMember(meta({ workspaceId: 's', relPath: 'src/a.ts' }))).toBe(true);
  });
});
