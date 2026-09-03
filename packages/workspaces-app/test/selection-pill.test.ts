/**
 * The shared selection → pill helpers the walkthrough card and the activity
 * pane both use. The hook itself is exercised through those two islands'
 * tests; this file covers the pure word-boundary helper behind "tap a word
 * to select it".
 */
import { describe, expect, it } from 'vitest';
import { wordRangeAt } from '../src/hub/selection-pill.ts';

describe('wordRangeAt', () => {
  it('finds the word under an offset', () => {
    expect(wordRangeAt('adding the route next', 8)).toEqual({ start: 7, end: 10 });
    expect(wordRangeAt('adding the route next', 0)).toEqual({ start: 0, end: 6 });
    expect(wordRangeAt('adding the route next', 21)).toEqual({ start: 17, end: 21 });
  });

  it('answers null on whitespace and on an empty string', () => {
    expect(wordRangeAt('adding the route', 6)).toBeNull();
    expect(wordRangeAt('', 0)).toBeNull();
  });

  it('leaves trailing punctuation out of the word', () => {
    expect(wordRangeAt('done; next.', 1)).toEqual({ start: 0, end: 4 });
    expect(wordRangeAt('done; next.', 8)).toEqual({ start: 6, end: 10 });
  });
});
