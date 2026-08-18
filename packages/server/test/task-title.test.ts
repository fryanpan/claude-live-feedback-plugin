import { describe, expect, test } from 'bun:test';
import { bodyHead, clipToWordBoundary } from '../src/task-title';

/**
 * The two helpers that survived the format-check removal (the gap
 * derivations moved into the reviewing skill's LLM prompt, 2026-08-18):
 * the word-boundary clip `promote_to_task` uses to generate a title, and
 * the normalized body-head `applyTitle` stamps as part of the capture
 * record.
 */

describe('clipToWordBoundary', () => {
  test('a string under the limit is returned untouched', () => {
    expect(clipToWordBoundary('short enough', 40)).toBe('short enough');
  });

  test('clipping lands on a word boundary, never mid-word', () => {
    const out = clipToWordBoundary('For tasks, I get dumped onto the board with no context', 26);
    expect(out.endsWith('…')).toBe(true);
    // The whole point: the character before the ellipsis closes a word.
    expect(out).toBe('For tasks, I get dumped…');
    expect(out.length).toBeLessThanOrEqual(26);
  });

  test('a single word longer than the limit still gets clipped rather than returned whole', () => {
    const out = clipToWordBoundary('x'.repeat(50), 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
  });

  test('trailing punctuation is not left stranded before the ellipsis', () => {
    expect(clipToWordBoundary('one two, three four five', 14)).toBe('one two…');
  });
});

describe('bodyHead — the story line a title compresses', () => {
  test('the first non-empty paragraph is taken, normalized', () => {
    expect(bodyHead('\n\n**Bryan** can  scan the board\n\nmore text')).toBe(
      'bryan can scan the board',
    );
  });

  test('hard wrapping inside the first paragraph does not change the head', () => {
    // Load-bearing, not cosmetic. A body is stored hard-wrapped at creation
    // and comes back from the prosemirror serializer as one line per
    // paragraph, so a first-LINE head would stop matching itself after the
    // first edit of any wrapped task.
    const wrapped = 'Agents can rank a backlog by reading\nthe goal order first.\n\nDone when: x.';
    const flowed = 'Agents can rank a backlog by reading the goal order first.\n\nDone when: x.';
    expect(bodyHead(wrapped)).toBe(bodyHead(flowed));
  });

  test('a change to the story line DOES change the head', () => {
    // The positive control for the two equalities above: a head that never
    // changed would satisfy them and detect nothing.
    expect(bodyHead('Agents can rank a backlog.\n\nDone when: x.')).not.toBe(
      bodyHead('Reviewers can audit a backlog.\n\nDone when: x.'),
    );
  });

  test('later paragraphs do not reach the head', () => {
    expect(bodyHead('Agents can rank a backlog.\n\nDone when: x.')).toBe(
      bodyHead('Agents can rank a backlog.\n\nDone when: something else entirely.'),
    );
  });

  test('markdown heading markers and emphasis do not change the head', () => {
    expect(bodyHead('## Bryan can scan the board')).toBe(bodyHead('Bryan can *scan* the board'));
  });

  test('an empty body has an empty head', () => {
    expect(bodyHead('   \n\n ')).toBe('');
    expect(bodyHead(undefined)).toBe('');
  });
});
