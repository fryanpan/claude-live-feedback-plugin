import { describe, expect, it } from 'bun:test';
import { firstParagraph } from '../src/task-body.ts';

/**
 * `firstParagraph` is the one extractor that survived the format-check
 * removal (the gap derivations moved into the reviewing skill's LLM
 * prompt, 2026-08-18) — `bodyHead` builds the capture record's stamp on
 * top of it.
 */

const STORY = [
  'Agents can rank a backlog by reading the goal order first so that the top',
  'of the queue is the work that matters most.',
  '',
  'Done when: next_tasks returns rows in goal order.',
].join('\n');

describe('firstParagraph', () => {
  it('takes the first paragraph, not the first line', () => {
    expect(firstParagraph(STORY)).toBe(
      'Agents can rank a backlog by reading the goal order first so that the top of the queue is the work that matters most.',
    );
  });

  it('skips leading blank lines rather than returning empty', () => {
    expect(firstParagraph('\n\n\nBryan can read it so that he can rank it.')).toBe(
      'Bryan can read it so that he can rank it.',
    );
  });

  it('is empty for a body that is only whitespace', () => {
    expect(firstParagraph('   \n\n  \n')).toBe('');
    expect(firstParagraph(undefined)).toBe('');
  });
});
