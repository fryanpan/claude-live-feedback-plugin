import { describe, expect, test } from 'bun:test';
import {
  IDEAL_TITLE_CHARS,
  MAX_TITLE_CHARS,
  bodyDrift,
  bodyHead,
  clipToWordBoundary,
  titleGapMessage,
  titleShapeGaps,
} from '../src/task-title';

describe('titleShapeGaps — length', () => {
  test("Bryan's own examples of a good title carry no SHAPE gap", () => {
    // Note the first one is 74 characters — his stated ideal is 70, so his
    // own example trips `over-ideal`. That is a real disagreement between the
    // two halves of the brief and not a bug here: the length rule is his
    // number, and it is reported as the mildest gap rather than as a defect.
    // What matters is that neither example lacks a persona, an action, or a
    // finished last word.
    const one = titleShapeGaps(
      'Bryan can review across tasks faster with clearer task descriptions and UX',
    );
    expect(one).toEqual(['over-ideal']);
    expect(titleShapeGaps('Agents can revise goal priority with a tool to reorder goals')).toEqual(
      [],
    );
  });

  test('over the ideal but under the max reports over-ideal alone', () => {
    // 71..100 chars, well-formed otherwise.
    const title = 'Reviewers can spot a stale task by a marker the board renders on every row now';
    expect(title.length).toBeGreaterThan(IDEAL_TITLE_CHARS);
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(titleShapeGaps(title)).toEqual(['over-ideal']);
  });

  test('over the max reports BOTH too-long and over-ideal', () => {
    const title = `Agents can ${'x'.repeat(120)} with a tool`;
    expect(title.length).toBeGreaterThan(MAX_TITLE_CHARS);
    const gaps = titleShapeGaps(title);
    expect(gaps).toContain('too-long');
    expect(gaps).toContain('over-ideal');
  });

  test('a title exactly at each boundary is NOT flagged — the limits are inclusive', () => {
    // Positive control for the two length gaps: the same builder one char
    // longer must flag, or "no gap" here proves nothing.
    const atIdeal = `Agents can ${'a'.repeat(IDEAL_TITLE_CHARS - 23)} with a tool`;
    expect(atIdeal.length).toBe(IDEAL_TITLE_CHARS);
    expect(titleShapeGaps(atIdeal)).toEqual([]);
    expect(titleShapeGaps(`${atIdeal}a`)).toEqual(['over-ideal']);
  });
});

describe('titleShapeGaps — persona and action', () => {
  test('an observation with no persona reports no-persona', () => {
    // Verbatim from the board, quoted in the task that asked for this.
    const gaps = titleShapeGaps('A decision-answered event promises a link checklist');
    expect(gaps).toContain('no-persona');
  });

  test('a persona with no means-clause reports no-action', () => {
    expect(titleShapeGaps('Bryan can review across tasks faster')).toEqual(['no-action']);
  });

  test('the means-clause must follow the persona clause, not merely appear', () => {
    // "with" sits BEFORE the `can`, so it is not the action this title
    // promises. A whole-string `includes` would wrongly pass this.
    const gaps = titleShapeGaps('With no warning a reviewer can lose the thread');
    expect(gaps).toContain('no-action');
  });

  test('each means marker is accepted after the persona clause', () => {
    for (const marker of ['by', 'with', 'via', 'using', 'so']) {
      expect(titleShapeGaps(`Agents can rank a backlog ${marker} reading the goal order`)).toEqual(
        [],
      );
    }
  });

  test('a persona clause too deep into the title does not count', () => {
    // `can` at word 12 is a coincidence of prose, not the standard's grammar.
    const gaps = titleShapeGaps(
      'A commit that is not a sha should not read as proof so nobody can trust it',
    );
    expect(gaps).toContain('no-persona');
  });
});

describe('titleShapeGaps — clipped', () => {
  test('a machine-clipped fragment ending in an ellipsis is reported', () => {
    // The exact failure mode quoted on the board.
    expect(titleShapeGaps('For tasks, I get dumped o…')).toContain('clipped');
    expect(titleShapeGaps('For tasks, I get dumped o...')).toContain('clipped');
  });

  test('a title ending in a function word reads as truncated', () => {
    expect(titleShapeGaps('Bryan can review a task by opening the')).toContain('clipped');
    expect(titleShapeGaps('Bryan can review a task with')).toContain('clipped');
  });

  test('a title ending in a trailing comma reads as truncated', () => {
    expect(titleShapeGaps('Bryan can review a task by opening it,')).toContain('clipped');
  });

  test('an ordinary well-formed ending is NOT clipped', () => {
    // Positive control for the absence above: same shape, complete last word.
    expect(titleShapeGaps('Bryan can review a task by opening the board')).not.toContain('clipped');
  });
});

describe('titleShapeGaps — empty', () => {
  test('a blank title is reported as empty and nothing else is asserted about it', () => {
    expect(titleShapeGaps('   ')).toEqual(['empty']);
    expect(titleShapeGaps('')).toEqual(['empty']);
  });
});

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

describe('bodyDrift — how much of the body changed', () => {
  test('an identical body has zero drift', () => {
    const b = 'Agents can rank a backlog by reading the goal order first.';
    expect(bodyDrift(b, b)).toBe(0);
  });

  test('a complete rewrite has full drift', () => {
    expect(bodyDrift('alpha beta gamma delta', 'whisky xray yankee zulu')).toBe(1);
  });

  test('a same-length paraphrase of the middle still registers drift', () => {
    // The case a first-line-only trigger would miss entirely, and the reason
    // drift is measured over words rather than over length.
    const prev = 'The reviewer opens the board and reads every row in order of goal.';
    const next = 'The reviewer opens the board and skips every row without a marker.';
    expect(bodyDrift(prev, next)).toBeGreaterThan(0.1);
  });

  test('drift is symmetric and bounded to 0..1', () => {
    const a = 'one two three four five six';
    const b = 'one two three';
    expect(bodyDrift(a, b)).toBe(bodyDrift(b, a));
    expect(bodyDrift(a, b)).toBeGreaterThan(0);
    expect(bodyDrift(a, b)).toBeLessThanOrEqual(1);
  });

  test('growing a body counts the added words as drift', () => {
    const prev = 'one two three four';
    const next = 'one two three four five six seven eight';
    expect(bodyDrift(prev, next)).toBeCloseTo(0.5, 5);
  });

  test('an undefined side is treated as an empty body, not as no change', () => {
    expect(bodyDrift(undefined, 'one two three')).toBe(1);
    expect(bodyDrift(undefined, undefined)).toBe(0);
  });
});

describe('titleGapMessage', () => {
  test('names every gap it was given', () => {
    const msg = titleGapMessage(['over-ideal', 'no-persona']) ?? '';
    expect(msg).toContain('70');
    expect(msg.toLowerCase()).toContain('who');
  });

  test('no gaps produces no message', () => {
    expect(titleGapMessage([])).toBeUndefined();
  });
});
