/**
 * The decidable half of "did the note-taker behave", driven directly.
 *
 * `notes-quality.ts` exists so that the questions with a right answer —
 * how long a bullet reads, whether a topic was opened twice, whether a topic
 * was left running as a wall of bullets, whether a decision carries the voice
 * that made it, whether a named row was linked, whether a bullet was copied
 * out of the transcript — are settled in code that a unit test can drive,
 * instead of inside `scripts/notes-eval.ts` where only a paid run over real
 * meetings could ever exercise them. This file is that unit test. The eval
 * calls exactly these functions on notes a model wrote; here they are called
 * on notes nobody did.
 *
 * The other half of the behaviour — that the instructions asking for all this
 * reach the model, and that the pipeline keeps its promises whatever the
 * model returns — is `notetaker-behaviour.test.ts`.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import {
  MAX_BULLET_WORDS,
  MAX_FLAT_RUN_BULLETS,
  allBullets,
  bulletWords,
  decisionsWithoutSpeaker,
  duplicateTopics,
  flatBulletRuns,
  longFlatRuns,
  overlongBullets,
  parseNotesTopics,
  unlinkedReferences,
  verbatimBullets,
} from '../src/notes-quality.ts';

/* ===== The decidable checks the eval scores with ===== */

describe('the programmatic judges', () => {
  const notes = [
    '### Sync wakes too often',
    '',
    '- [@Priya](speaker:A) The sync wakes on a ninety-second retry loop.',
    '- [@Marcus](speaker:B) Decided: cap the backoff at ten minutes.',
    '- The team agreed to ship it Thursday.',
    '- Possibly related to the 0.4 rollout (unconfirmed).',
    '',
    '### Export range',
    '',
    '- The dialog forgets the range, which is a long-standing complaint that several people in the room repeated at some length again today.',
  ].join('\n');

  it('read topics and bullets out of a notes section', () => {
    expect(parseNotesTopics(notes).map((t) => t.heading)).toEqual([
      'Sync wakes too often',
      'Export range',
    ]);
    expect(allBullets(notes)).toHaveLength(5);
  });

  it('count a link by its label and a speaker tag not at all', () => {
    // The instructions promise the tag is free of the twenty-word budget, so
    // the judge that enforces the budget must not charge for it. Counting it
    // failed a nineteen-word bullet at 21 words on the first real eval run,
    // for carrying the attribution those same instructions demand.
    expect(bulletWords('[@Priya](speaker:A) The sync wakes on a ninety-second retry loop.')).toBe(
      8,
    );
    expect(bulletWords('The sync wakes on a ninety-second retry loop.')).toBe(8);
    // A citation still costs its title, and never its URL.
    expect(bulletWords('Fixed in [Retry loop wakes the sync](/workspaces/w-1?task=t-3).')).toBe(7);
  });

  it('find the bullet that ran past the bar and only that one', () => {
    const over = overlongBullets(notes);
    expect(over).toHaveLength(1);
    expect(over[0]?.bullet).toContain('long-standing complaint');
    expect(over[0]?.words).toBeGreaterThan(MAX_BULLET_WORDS);
  });

  it('find a decision written without the voice that made it', () => {
    const missing = decisionsWithoutSpeaker(notes);
    expect(missing).toEqual(['The team agreed to ship it Thursday.']);
  });

  it('see a second heading for a topic that already had one', () => {
    expect(duplicateTopics(notes)).toEqual([]);
    expect(duplicateTopics(`${notes}\n\n### export range!\n\n- More.`)).toEqual([
      'Sync wakes too often'.replace('Sync wakes too often', 'Export range'),
    ]);
  });

  it('see a row the notes name in prose without linking', () => {
    const board = [{ title: 'Export range', url: '/workspaces/w-1?task=t-7' }];
    expect(unlinkedReferences(notes, board)).toEqual(['Export range']);
    const linked = notes.replace(
      '### Export range',
      '### [Export range](/workspaces/w-1?task=t-7)',
    );
    expect(unlinkedReferences(linked, board)).toEqual([]);
  });

  it('count five flat bullets under one heading as a wall, and four as none', () => {
    const bullets = (n: number): string =>
      ['### Export range', '', ...Array.from({ length: n }, (_, i) => `- Point ${i + 1}.`)].join(
        '\n',
      );
    const five = longFlatRuns(bullets(5));
    expect(five).toHaveLength(1);
    expect(five[0]?.heading).toBe('Export range');
    expect(five[0]?.bullets).toHaveLength(5);
    expect(longFlatRuns(bullets(MAX_FLAT_RUN_BULLETS))).toEqual([]);
  });

  it('let a sub-bullet break the run, and drop its lead out of the count', () => {
    // Six bullets, one of them carrying a nested point: two runs of at most
    // three, so the topic reads as structure and nothing is reported. The
    // lead bullet leaves the run it introduces — counting it inside would
    // report the regrouped shape as the shape it replaced.
    const nested = [
      '### Export range',
      '',
      '- Point 1.',
      '- Point 2.',
      '- Point 3.',
      '  - The CSV path uses a different dialog.',
      '- Point 4.',
      '- Point 5.',
      '- Point 6.',
    ].join('\n');
    expect(longFlatRuns(nested)).toEqual([]);
    expect(flatBulletRuns(nested).map((r) => r.bullets.length)).toEqual([2, 3]);
  });

  it('let a subheading break the run', () => {
    const split = [
      '### Export range',
      '',
      '- Point 1.',
      '- Point 2.',
      '- Point 3.',
      '',
      '### Owner and timing',
      '',
      '- Point 4.',
      '- Point 5.',
      '- Point 6.',
    ].join('\n');
    expect(longFlatRuns(split)).toEqual([]);
    expect(flatBulletRuns(split).map((r) => r.heading)).toEqual([
      'Export range',
      'Owner and timing',
    ]);
  });

  it('count one wall per heading', () => {
    const two = [
      '### Export range',
      '',
      ...Array.from({ length: 5 }, (_, i) => `- Export point ${i + 1}.`),
      '',
      '### Sync wakes too often',
      '',
      ...Array.from({ length: 5 }, (_, i) => `- Sync point ${i + 1}.`),
    ].join('\n');
    expect(longFlatRuns(two).map((r) => r.heading)).toEqual([
      'Export range',
      'Sync wakes too often',
    ]);
  });

  it('count bullets written before any heading, which is the wall at its purest', () => {
    const headless = Array.from({ length: 5 }, (_, i) => `- Point ${i + 1}.`).join('\n');
    const runs = longFlatRuns(headless);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.heading).toBe('');
  });

  it('see a bullet that copied the transcript instead of paraphrasing it', () => {
    const transcript =
      'so the sync wakes on a ninety second retry loop and it has done that for weeks';
    const copied = '- so the sync wakes on a ninety second retry loop';
    expect(verbatimBullets(copied, transcript)).toHaveLength(1);
    expect(verbatimBullets('- The sync retries too eagerly.', transcript)).toEqual([]);
  });
});
