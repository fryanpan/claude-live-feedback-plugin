/**
 * Which of the board's names this tick's speech actually said.
 *
 * The rule the matcher exists to hold is PRECISION: a citation in the room's
 * shared record is a claim that this discussion was about that work, and a
 * reader cannot tell a guessed link from a right one. So the interesting
 * tests here are the refusals — the generic word pair every row on a board
 * shares, the title that merely overlaps, the row nobody mentioned.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import {
  MAX_TICK_REFERENCES,
  type NoteReference,
  matchReferences,
  namesReference,
  referenceDate,
  referenceTokens,
} from '../src/notes-references.ts';

const task = (title: string, id = 't-1'): NoteReference => ({
  kind: 'task',
  title,
  url: `/workspaces/w-1?task=${id}`,
});

const titles = (found: readonly NoteReference[]): string[] => found.map((r) => r.title);

describe('a title spoken in the meeting', () => {
  it('is found when the words are said as the row spells them', () => {
    const board = [task('Retry loop wakes the sync every ninety seconds')];
    const found = matchReferences(
      'So the retry loop wakes the sync again, every ninety seconds.',
      board,
    );
    expect(titles(found)).toEqual(['Retry loop wakes the sync every ninety seconds']);
  });

  it('is found across the filler words speech puts inside it', () => {
    // The row reads "Balloons on the goal bar"; nobody says a title aloud
    // the way it is written, and the words between the ones that matter are
    // exactly what varies.
    const board = [task('Balloons on the goal bar')];
    const found = matchReferences('Did we ship the balloons for the goal bar yet?', board);
    expect(titles(found)).toEqual(['Balloons on the goal bar']);
  });

  it('is found when the speech pluralises or contracts it', () => {
    const board = [task('Export dialog forgets the chosen range')];
    const found = matchReferences("The export dialog's forgetting the chosen range.", board);
    expect(titles(found)).toEqual(['Export dialog forgets the chosen range']);
  });

  it('brings its URL with it, so no later stage has to rebuild one', () => {
    const board = [task('Lantern badge counts stale invites', 't-9')];
    const [found] = matchReferences('The lantern badge counts stale invites.', board);
    expect(found?.url).toBe('/workspaces/w-1?task=t-9');
  });
});

describe('a title the meeting did not say', () => {
  it('is refused when nothing overlaps', () => {
    const board = [task('Export dialog forgets the chosen range')];
    expect(matchReferences('We should measure the latency first.', board)).toEqual([]);
  });

  it('is refused on a generic pair every row on the board shares', () => {
    // "meeting notes" is two significant words, and it is two words of a
    // six-word title. A matcher that linked on any pair would put this
    // citation on half the bullets of a meeting that is ABOUT meeting notes.
    const board = [task('Meeting notes reorganise around topics not the clock')];
    expect(matchReferences('Let us look at the meeting notes so far.', board)).toEqual([]);
  });

  it('is accepted on the same pair when the pair is most of the title', () => {
    // The refusal above is about coverage, not about the words: when the row
    // IS "Meeting notes", saying "meeting notes" names it.
    const board = [task('Meeting notes')];
    expect(titles(matchReferences('Let us look at the meeting notes.', board))).toEqual([
      'Meeting notes',
    ]);
  });

  it('is refused on a single short word, and accepted on a long distinctive one', () => {
    expect(matchReferences('Check the gate before you merge.', [task('Gate')])).toEqual([]);
    expect(
      titles(matchReferences('Check the lanternbadge first.', [task('Lanternbadge')])),
    ).toEqual(['Lanternbadge']);
  });

  it('is refused when only stopwords match', () => {
    const board = [task('When the sync is on and the retry is in flight')];
    expect(matchReferences('It is on the way and in the doc.', board)).toEqual([]);
  });
});

describe('several titles at once', () => {
  it('puts the longer, more specific match first', () => {
    const board = [task('Goal bar', 't-1'), task('Goal bar remainder is wrong', 't-2')];
    const found = matchReferences('The goal bar remainder is wrong again.', board);
    expect(titles(found)[0]).toBe('Goal bar remainder is wrong');
  });

  it('is capped, so one tick cannot carry a whole board', () => {
    const board = Array.from({ length: MAX_TICK_REFERENCES + 3 }, (_, i) =>
      task(`Distinctive rowname${i} problem here`, `t-${i}`),
    );
    const spoken = board.map((r) => r.title).join('. ');
    expect(matchReferences(spoken, board)).toHaveLength(MAX_TICK_REFERENCES);
  });

  it('finds nothing in silence, and nothing on an empty board', () => {
    expect(matchReferences('', [task('Anything at all here')])).toEqual([]);
    expect(matchReferences('Anything at all here.', [])).toEqual([]);
  });
});

describe('the pieces the matcher is built from', () => {
  it('splits on punctuation and drops apostrophes rather than splitting on them', () => {
    expect(referenceTokens("Don't — the goal-bar's v2!")).toEqual([
      'dont',
      'the',
      'goal',
      'bars',
      'v2',
    ]);
  });

  it('judges a row by its own significant words', () => {
    const row = task('The state of the export');
    expect(namesReference(row, referenceTokens('what is the state of the export'))).toBe(true);
    expect(namesReference(row, referenceTokens('the state of the union'))).toBe(false);
  });

  it('dates a doc the way the lookup does, so the two read alike', () => {
    expect(referenceDate(Date.UTC(2026, 8, 3, 12))).toMatch(/^2026-09-0[23]$/);
  });
});
