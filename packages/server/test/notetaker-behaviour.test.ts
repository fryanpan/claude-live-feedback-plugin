/**
 * What the note-taker is now asked to do, and what the pipeline around it
 * guarantees whatever the model returns.
 *
 * The behaviour has two halves and they are tested differently on purpose.
 *
 * The PROMPT half — paraphrase, twenty words, mark a guess, cover what was
 * decided — is instruction, and no unit test can prove a model followed an
 * instruction. What is asserted here is that the instruction reaches the
 * model on every tick, which is the part that can silently stop being true.
 * Whether it is FOLLOWED is `bun run notes:eval`, against real meetings.
 *
 * The PIPELINE half is structural and is asserted properly: a person's line
 * survives a tick that rewrote it, a topic already in the notes does not get
 * a second heading, and a row this tick's speech named arrives at the
 * composer with its URL. Each of these fails on the behaviour that shipped
 * before this change.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { buildNotesPrompt } from '../src/meeting-notes-composer.ts';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import {
  MAX_BULLET_WORDS,
  allBullets,
  bulletWords,
  decisionsWithoutSpeaker,
  duplicateTopics,
  overlongBullets,
  parseNotesTopics,
  unlinkedReferences,
  verbatimBullets,
} from '../src/notes-quality.ts';
import { createNotesTickHarness } from './notes-tick-harness.ts';
import type { TickSnapshot } from './notes-tick-harness.ts';

/**
 * The compose input for a tick that definitely composed.
 *
 * `TickSnapshot.input` is optional because a coalesced or skipped tick has
 * none. Every tick in this file drives a compose, so absence here is a broken
 * test rather than a case to handle — and saying so out loud beats the cast
 * that used to live in the harness and crashed the eval instead of failing.
 */
const composeInput = (shot: TickSnapshot): NotesComposeInput => {
  if (!shot.input) throw new Error(`tick ${shot.tick} never reached the composer`);
  return shot.input;
};

const emptyInput: NotesComposeInput = {
  docId: 'd1',
  meetingId: 'm1',
  tick: { tick: 1, reason: 'pause', turns: [{ turn: 0, text: 'We should measure first.' }] },
  previous: null,
};

/* ===== The instruction reaches the model ===== */

describe('the notetaking instructions', () => {
  const system = buildNotesPrompt(emptyInput).system;

  it('ask for paraphrase rather than a transcript with headings', () => {
    expect(system).toMatch(/Paraphrase/);
    expect(system).toMatch(/transcript with/i);
  });

  it('state the twenty-word bar the eval measures', () => {
    expect(system).toContain(`AT MOST ${MAX_BULLET_WORDS} WORDS`);
  });

  it('ask for list items, which is what the model does not do unprompted', () => {
    // Measured, not guessed. Run against real AMI speech, the instructions
    // without this rule came back as PARAGRAPHS under the topic headings —
    // good content, well organised, and not a set of notes: every
    // bullet-shaped check downstream read zero bullets, and a reader cannot
    // point at a line that is not a line. Naming the markdown is the fix.
    expect(system).toContain('MARKDOWN LIST ITEM');
    expect(system).toMatch(/beginning with[\s\S]{0,40}"- "/);
  });

  it('name the four things a note should carry', () => {
    for (const asked of ['discussed', 'why it matters', 'decided', 'happens next']) {
      expect(system).toContain(asked);
    }
  });

  it('ask for topic headings that are reused rather than reopened', () => {
    expect(system).toMatch(/### /);
    expect(system).toMatch(/never open a second heading/i);
  });

  it('ask for a guess to be marked rather than dropped or asserted', () => {
    expect(system).toContain('(unconfirmed)');
  });

  it('keep a decision and an open question attributed', () => {
    expect(system).toMatch(/DECISION AND AN OPEN QUESTION ALWAYS KEEP THEIR SPEAKER TAG/);
  });

  it('let the note-taker move and merge its OWN bullets', () => {
    // The rule that shipped before this said the opposite — new material at
    // the end, "never to restructure notes the new speech does not touch" —
    // which is the behaviour this row was filed to replace.
    expect(system).toMatch(/Rewrite, merge, split and MOVE your own earlier bullets/);
    expect(system).not.toMatch(/never to restructure/);
  });

  it("let it move a person's line but never rewrite one", () => {
    expect(system).toMatch(/Moving is organising/);
    expect(system).toMatch(/never as a replacement/);
  });
});

/* ===== References: the search reaches the prompt with URLs ===== */

describe('a board row this tick named', () => {
  it('reaches the composer as a link it is told to cite', () => {
    const prompt = buildNotesPrompt({
      ...emptyInput,
      references: [
        { kind: 'task', title: 'Retry loop wakes the sync', url: '/workspaces/w-1?task=t-3' },
        { kind: 'doc', title: 'Last Tuesday', url: '/workspaces/w-1/docs/d-9', when: '2026-08-25' },
      ],
    });
    expect(prompt.user).toContain('[Retry loop wakes the sync](/workspaces/w-1?task=t-3)');
    expect(prompt.user).toContain('[Last Tuesday](/workspaces/w-1/docs/d-9)');
    expect(prompt.user).toContain('met 2026-08-25');
    expect(prompt.user).toMatch(/write its name as a markdown link/);
  });

  it('says nothing at all on a tick that named nothing', () => {
    expect(buildNotesPrompt(emptyInput).user).not.toMatch(/already on the board/);
  });

  it('is found from the board and handed to the compose, end to end', async () => {
    const harness = createNotesTickHarness({
      workspaceId: 'w-1',
      tasks: [
        { id: 't-3', title: 'Retry loop wakes the sync every ninety seconds', status: 'todo' },
        { id: 't-4', title: 'Lantern badge counts stale invites', status: 'todo' },
      ],
      boardDocs: [{ docId: 'd-9', title: 'Backoff design note', meetingAt: Date.UTC(2026, 7, 25) }],
      compose: () => '## Meeting notes\n\n- A note.',
    });
    const shot = await harness.speak({
      speaker: 'A',
      text: 'The retry loop wakes the sync every ninety seconds, per the backoff design note.',
    });
    await harness.end();

    const cited = (composeInput(shot).references ?? []).map((r) => r.title);
    expect(cited).toContain('Retry loop wakes the sync every ninety seconds');
    expect(cited).toContain('Backoff design note');
    // The row nobody said stays off the prompt: that is the whole point of
    // searching rather than listing.
    expect(cited).not.toContain('Lantern badge counts stale invites');
    expect(composeInput(shot).references?.[0]?.url).toBe('/workspaces/w-1?task=t-3');
  });

  it('is absent when the doc belongs to no board', async () => {
    const harness = createNotesTickHarness({
      tasks: [
        { id: 't-3', title: 'Retry loop wakes the sync every ninety seconds', status: 'todo' },
      ],
      compose: () => '## Meeting notes\n\n- A note.',
    });
    const shot = await harness.speak('The retry loop wakes the sync every ninety seconds.');
    await harness.end();
    expect(composeInput(shot).references ?? []).toEqual([]);
  });
});

/* ===== Topics: the same topic keeps one heading ===== */

describe('topic headings across a sequence of ticks', () => {
  it('stay single when the note-taker keeps writing under one', async () => {
    const harness = createNotesTickHarness({
      compose: (_input, tick) =>
        [
          '## Meeting notes',
          '',
          '### Sync wakes too often',
          '',
          '- The sync wakes on a ninety-second retry loop.',
          ...(tick > 1 ? ['- Cause: the backoff never resets after a success.'] : []),
          ...(tick > 2 ? ['', '### Export range', '', '- The dialog forgets the range.'] : []),
        ].join('\n'),
    });
    await harness.speak('The sync wakes every ninety seconds.');
    await harness.speak('That is the backoff not resetting.');
    const third = await harness.speak('Separately, the export dialog forgets the range.');
    await harness.end();

    expect(harness.countHeadings('Sync wakes too often')).toBe(1);
    expect(harness.countHeadings('Export range')).toBe(1);
    expect(duplicateTopics(third.notes)).toEqual([]);
    expect(parseNotesTopics(third.notes).map((t) => t.heading)).toEqual([
      'Sync wakes too often',
      'Export range',
    ]);
    expect(harness.errors).toEqual([]);
  });

  it('let a later tick move a bullet under the topic it belongs to', async () => {
    // The behaviour that shipped before forbade exactly this: new material at
    // the end, and no restructuring the new speech did not touch.
    const harness = createNotesTickHarness({
      compose: (_input, tick) =>
        tick === 1
          ? '## Meeting notes\n\n- The sync wakes every ninety seconds.\n- The export dialog forgets the range.'
          : [
              '## Meeting notes',
              '',
              '### Sync',
              '',
              '- The sync wakes every ninety seconds.',
              '- Cause: the backoff never resets.',
              '',
              '### Export',
              '',
              '- The export dialog forgets the range.',
            ].join('\n'),
    });
    await harness.speak('The sync wakes every ninety seconds. The export dialog forgets.');
    const second = await harness.speak('The backoff never resets after a success.');
    await harness.end();

    const bullets = allBullets(second.notes);
    // Moved, not duplicated: each point appears once, under its topic.
    expect(bullets.filter((b) => b.includes('ninety seconds'))).toHaveLength(1);
    expect(bullets.filter((b) => b.includes('forgets the range'))).toHaveLength(1);
    expect(parseNotesTopics(second.notes).map((t) => t.heading)).toEqual(['Sync', 'Export']);
  });
});

/* ===== Consensus: a person's bullet is never edited ===== */

describe('a bullet a person wrote', () => {
  const humanLine = '- I think this predates the 0.4 rollout';

  it('survives a tick whose compose rewrote it, and comes back as a suggestion', async () => {
    const harness = createNotesTickHarness({
      doc: `## Meeting notes\n\n${humanLine}\n`,
      compose: (_input, tick) =>
        tick === 1
          ? '## Meeting notes\n\n- The sync wakes every ninety seconds.'
          : // The model has decided it knows better. It may propose; it may
            // not replace.
            '## Meeting notes\n\n- This postdates the 0.4 rollout\n- The sync wakes every ninety seconds.',
    });
    await harness.speak('The sync wakes every ninety seconds.');
    const second = await harness.speak('It started after the rollout, I think.');
    await harness.end();

    // The ACCEPTED text — what serializes to disk and what the room reads —
    // still says what the person typed.
    expect(second.notes).toContain('I think this predates the 0.4 rollout');
    expect(allBullets(second.notes).filter((b) => b.includes('predates'))).toHaveLength(1);
    expect(second.notes).not.toContain('This postdates the 0.4 rollout');
    expect(harness.errors).toEqual([]);
  });

  it('is handed to the compose as theirs to reproduce', async () => {
    const harness = createNotesTickHarness({
      doc: `## Meeting notes\n\n${humanLine}\n`,
      compose: () => '## Meeting notes\n\n- A note.',
    });
    await harness.speak('First words.');
    const second = await harness.speak('More words.');
    await harness.end();
    expect(composeInput(second).humanNotes).toContain('I think this predates the 0.4 rollout');
    expect(buildNotesPrompt(composeInput(second)).user).toContain('Written by a person');
  });

  it('is not duplicated when the compose returns it in a new position', async () => {
    const harness = createNotesTickHarness({
      doc: `## Meeting notes\n\n${humanLine}\n`,
      compose: (_input, tick) =>
        tick === 1
          ? '## Meeting notes\n\n- The sync wakes every ninety seconds.'
          : [
              '## Meeting notes',
              '',
              '### Rollout',
              '',
              '- I think this predates the 0.4 rollout',
              '',
              '### Sync',
              '',
              '- The sync wakes every ninety seconds.',
            ].join('\n'),
    });
    await harness.speak('The sync wakes every ninety seconds.');
    const second = await harness.speak('About the rollout.');
    await harness.end();
    expect(allBullets(second.notes).filter((b) => b.includes('predates'))).toHaveLength(1);
  });
});

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

  it('see a bullet that copied the transcript instead of paraphrasing it', () => {
    const transcript =
      'so the sync wakes on a ninety second retry loop and it has done that for weeks';
    const copied = '- so the sync wakes on a ninety second retry loop';
    expect(verbatimBullets(copied, transcript)).toHaveLength(1);
    expect(verbatimBullets('- The sync retries too eagerly.', transcript)).toEqual([]);
  });
});
