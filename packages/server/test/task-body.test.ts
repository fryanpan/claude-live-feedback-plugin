import { describe, expect, it } from 'bun:test';
import { type BodyGap, bodyGapMessage, bodyShapeGaps, firstParagraph } from '../src/task-body.ts';

/**
 * Fixtures are synthetic, but their SHAPES were measured against the 47 open
 * rows of a real board on 2026-08-17 before any of this was written — which
 * is the only reason the decision genre below exists. A first cut of the
 * story rule flagged 18 rows; the corrected one flags 6, and 4 of the
 * difference are decision tasks that open with their question and are
 * correctly shaped for what they are. Inventing fixtures alone would not
 * have produced that case, because nobody invents the input that breaks
 * their own rule.
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

describe('bodyShapeGaps', () => {
  it('reports empty for a body with no words at all', () => {
    expect(bodyShapeGaps('')).toEqual(['empty']);
    expect(bodyShapeGaps(undefined)).toEqual(['empty']);
    expect(bodyShapeGaps('   \n \n ')).toEqual(['empty']);
  });

  it('an empty body reports ONLY empty, not empty plus no-story', () => {
    // Two gaps naming one absence reads as two problems to fix.
    expect(bodyShapeGaps('')).toEqual(['empty']);
  });

  it('accepts a story opening', () => {
    expect(bodyShapeGaps(STORY)).toEqual([]);
  });

  it('accepts a story whose persona is not the first word', () => {
    // The recall bug caught on the corpus: requiring the persona at word one
    // and `can` at word two rejected a perfectly good story.
    const body =
      'Agent reading a `decision.answered` event can trust what the line tells it to do so that the event stops promising an affordance the record does not have.';
    expect(bodyShapeGaps(body)).toEqual([]);
  });

  it('accepts a story introduced by an article', () => {
    // "An agent pushing to this repo can trust..." — the article branch. It
    // has its own case because no other fixture reaches it, and a guard no
    // test can reach is a guard that silently stops working.
    const body =
      'An agent pushing to this repo can trust the scan verdict so that it stops reaching for the bypass flag.';
    expect(bodyShapeGaps(body)).toEqual([]);
  });

  it('accepts a story wrapped in markdown emphasis', () => {
    const body = '**Bryan** can scan the board **so that** he can check the ranking.';
    expect(bodyShapeGaps(body)).toEqual([]);
  });

  it('defers entirely on a row DECLARED as a decision', () => {
    // The measured false-positive class. A decision row is not a story and is
    // correct not to be; `decision-shape.ts` owns that field and already
    // refuses a decision body with no question in it.
    const body = [
      '**Should a board share transitively grant repo-file access?**',
      '',
      'Options: refuse, report, or scope per review.',
    ].join('\n');
    expect(bodyShapeGaps(body, 'decision')).toEqual([]);
  });

  it('defers on a decision row whose question is PLAIN PROSE, not a bold opener', () => {
    // The case a prose-sniffing rule gets wrong in the expensive direction.
    // Measured on the live board: inferring the genre found 4 decision rows
    // where there were 7, and two of the misses were being flagged deficient.
    const body =
      'The question: for the review on Wednesday, is the requirement read-only or full editing?';
    expect(bodyShapeGaps(body, 'decision')).toEqual([]);
    // Positive control: the SAME body on a non-decision row is still flagged,
    // so the deferral is the declared field talking and not the text.
    expect(bodyShapeGaps(body, 'action')).toEqual(['no-story']);
  });

  it('does not excuse a non-decision row just because it opens with a question', () => {
    // The other direction of the same proxy failure.
    expect(bodyShapeGaps('Should we ship the thing this week?')).toEqual(['no-story']);
  });

  it('reports no-story for a status report opening', () => {
    const body = 'Round 5 delivered: 133 candidates ranked and appended to the doc.';
    expect(bodyShapeGaps(body)).toEqual(['no-story']);
  });

  it('reports no-story when the goal clause is missing', () => {
    expect(bodyShapeGaps('Agents can rank a backlog by reading the goal order.')).toEqual([
      'no-story',
    ]);
  });

  it('reports no-story when the persona is missing', () => {
    // "so that" alone is prose, not a story.
    expect(bodyShapeGaps('The queue should be ordered so that the top row matters most.')).toEqual([
      'no-story',
    ]);
  });

  it('only reads the FIRST paragraph, so a story buried on page two does not count', () => {
    const buried = [
      'Some preamble that says nothing.',
      '',
      'Bryan can rank it so that he can plan.',
    ].join('\n');
    expect(bodyShapeGaps(buried)).toEqual(['no-story']);
    // Positive control: the same story, in the opening, is accepted — so the
    // assertion above is about POSITION rather than about the matcher failing
    // to read that sentence at all.
    expect(bodyShapeGaps('Bryan can rank it so that he can plan.')).toEqual([]);
  });
});

describe('bodyGapMessage', () => {
  it('is undefined when there is nothing to say', () => {
    expect(bodyGapMessage([])).toBeUndefined();
  });

  it('names the standard so a caller can act without looking it up', () => {
    const msg = bodyGapMessage(['no-story']) ?? '';
    expect(msg).toContain('so that');
  });

  it('has text for every gap the type allows', () => {
    // Guards the case where a new BodyGap is added and the message table is
    // not — which would render as a bare slug, the failure this repo has
    // already recorded once for event names.
    const all: BodyGap[] = ['empty', 'no-story'];
    for (const g of all) {
      const m = bodyGapMessage([g]);
      expect(m, `no message text for gap ${g}`).toBeDefined();
      expect(m).not.toContain(g);
    }
  });
});
