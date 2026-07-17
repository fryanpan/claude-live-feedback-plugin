import { describe, expect, it } from 'vitest';
import { __testing } from '../src/review-chrome.ts';

const { anchorBody } = __testing;

/**
 * The chrome hand-builds every anchor body field by field, so a field present
 * on ChromeSelection but not copied is silently dropped: the server accepts it,
 * returns 200, and the data is gone.
 *
 * This is where `deletedSnippet` first shipped broken. The HTTP-level test in
 * packages/server/test/deleted-snippet.test.ts passed the whole time because it
 * POSTs directly and never goes through this layer — the guard was at the wrong
 * altitude. `docs/process/learnings.md` records the same shape for `groups`.
 */
describe('anchorBody', () => {
  const sel = {
    start: new Uint8Array([1, 2]),
    end: new Uint8Array([3, 4]),
    snippet: 'some text',
  };

  it('serializes rel positions as plain arrays for the wire', () => {
    const body = anchorBody(sel);
    expect(body.kind).toBe('text-range');
    expect(body.startRel).toEqual([1, 2]);
    expect(body.endRel).toEqual([3, 4]);
    expect(body.snippet).toEqual({ text: 'some text' });
    // Must survive JSON.stringify as arrays, not as {"0":1,"1":2}.
    expect(JSON.parse(JSON.stringify(body)).startRel).toEqual([1, 2]);
  });

  it('forwards deletedSnippet when the comment was on base-only text', () => {
    const body = anchorBody({ ...sel, deletedSnippet: 'the removed words' });
    expect((body as { deletedSnippet?: string }).deletedSnippet).toBe('the removed words');
    expect(JSON.parse(JSON.stringify(body)).deletedSnippet).toBe('the removed words');
  });

  it('omits deletedSnippet entirely for an ordinary comment', () => {
    expect('deletedSnippet' in anchorBody(sel)).toBe(false);
  });

  it('omits an empty deletedSnippet rather than sending a blank hint', () => {
    expect('deletedSnippet' in anchorBody({ ...sel, deletedSnippet: '' })).toBe(false);
  });
});
