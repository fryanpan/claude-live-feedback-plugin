import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { ReviewPayload } from './review-item.ts';
import { createThread, listThreads } from './schema.ts';

/**
 * The OTHER half of removing `why` and `lookFor`, and the half a route test
 * cannot reach.
 *
 * `review-item.test.ts` pins the folding function and the server's route tests
 * pin what happens to a payload written TODAY. Neither touches the thousands
 * of payloads already sitting in `.ydoc` state with both fields populated:
 * those were written before the removal, they never pass through the write
 * gate again, and this project does not rewrite stored user content to suit a
 * schema change. So the read has to be the tolerant end, and this asserts it
 * where a renderer actually gets its data — through the projection, not
 * through the pure function underneath it.
 *
 * Written against a Y.Doc rather than a fixture object on purpose: the claim
 * is about the WIRING (`readThread` calling `readReviewPayload`), and a test
 * that called the reader directly would pass just as happily against a
 * projection that had stopped calling it.
 */
describe('a payload stored before the removal still renders every word', () => {
  /** A comment written by a bundle from before 2026-08-25. */
  const legacy = {
    shape: 'decision',
    headline: 'Where should the trial banner live?',
    why: 'Blocks the onboarding rework; both screens are built either way.',
    lookFor: 'Whether moving it below the fold hides the price.',
    detail: 'Above the fold it competes with the sign-up button.',
    options: [
      { id: 'above', label: 'Keep above' },
      { id: 'below', label: 'Move below' },
    ],
  } as unknown as ReviewPayload;

  function storedReview(review: ReviewPayload): ReviewPayload | undefined {
    const doc = new Y.Doc();
    createThread(doc, {
      threadId: 'th-1',
      anchor: { kind: 'text', snippet: { text: 'trial banner' } } as never,
      createdBy: { id: 'a-1', name: 'Harbor agent', kind: 'known', color: '#888888' },
      firstComment: { id: 'c-1', text: 'Both screens are built.', review },
    });
    return listThreads(doc)[0]?.comments[0]?.review;
  }

  it('projects the legacy text into the one body, in the order it rendered in', () => {
    const read = storedReview(legacy);
    expect(read).toBeDefined();
    expect(read?.detail).toBe(
      'Blocks the onboarding rework; both screens are built either way.\n\n' +
        'Whether moving it below the fold hides the price.\n\n' +
        'Above the fold it competes with the sign-up button.',
    );
  });

  it('leaves neither retired name on what a renderer receives', () => {
    const read = storedReview(legacy) as object;
    expect(Object.hasOwn(read, 'why')).toBe(false);
    expect(Object.hasOwn(read, 'lookFor')).toBe(false);
  });

  it('keeps the rest of the item intact — this is a fold, not a rewrite', () => {
    const read = storedReview(legacy);
    expect(read?.headline).toBe('Where should the trial banner live?');
    expect(read?.shape).toBe('decision');
    expect(read?.options?.map((o) => o.id)).toEqual(['above', 'below']);
  });

  it('reads a legacy item whose only authored prose was the why', () => {
    // The common shape in stored data: `lookFor` was advisory and often
    // absent, and `detail` was too. Dropping the fold would leave these items
    // as a headline with nothing under it.
    const read = storedReview({
      shape: 'review',
      headline: 'Read the stall rota',
      why: 'It goes out Thursday and nobody has checked it.',
    } as unknown as ReviewPayload);
    expect(read?.detail).toBe('It goes out Thursday and nobody has checked it.');
  });

  it('leaves a payload written today exactly as its author wrote it', () => {
    // The positive control the four above need: the projection is not simply
    // rewriting every body it sees.
    const read = storedReview({
      shape: 'review',
      headline: 'Read the stall rota',
      detail: 'Draft is at the doc.',
    });
    expect(read?.detail).toBe('Draft is at the doc.');
  });
});
