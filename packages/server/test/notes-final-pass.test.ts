/**
 * Stopping a meeting is a notes moment of its own.
 *
 * THE BUG THIS PINS. The two clocks that fire a tick — a pause of four
 * seconds, a ceiling of fifteen — both need the meeting to keep going. The
 * sentence somebody is in the middle of when they press stop is waiting on a
 * tick that never comes: the pause clock is disarmed by the stop, the ceiling
 * with it, and the turn had never settled, so the flush at `end()` found an
 * empty delta and wrote nothing. Everything said in the last stretch of a
 * meeting went into the transcript and never into the notes.
 *
 * So the final pass takes the turns that were still being SPOKEN as well as
 * the ones that had settled, and the composer is told which is which.
 *
 * The second half of this file is the merge invariant that the final pass
 * must not cost: a person types in the notes section while the meeting runs,
 * and the next bullet — the last one included — still appends under their
 * line rather than replacing it or opening a section of its own.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import { prose } from '@feedback/core';
import * as Y from 'yjs';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { MEETING_NOTES_HEADING, findNotesSection } from '../src/notes-section.ts';
import { createNotesTickHarness, notesItems } from './notes-tick-harness.ts';

/** Everything the composer was handed for a tick, as one string — the cheapest
 *  way to ask "did these words reach the model at all". */
const transcriptOf = (input: NotesComposeInput): string =>
  input.tick.turns.map((t) => t.text).join('\n');

/** Type a bullet at the end of the notes section, the way a person would. */
function typeInNotes(ydoc: Y.Doc, line: string): void {
  const fragment = prose.getProseFragment(ydoc);
  const span = findNotesSection(fragment, MEETING_NOTES_HEADING);
  if (!span) throw new Error('no notes section to type in');
  fragment.insert(span.endExclusive, prose.parseMarkdownBlocks(`- ${line}`));
}

describe('the final pass over a meeting that stopped mid-sentence', () => {
  it('the interrupted sentence reaches the composer, marked unfinished', async () => {
    const seen: NotesComposeInput[] = [];
    const h = createNotesTickHarness({
      compose: (input) => {
        seen.push(input);
        return `## Meeting notes\n\n${input.tick.turns.map((t) => `- ${t.text}`).join('\n')}\n`;
      },
    });

    await h.speak('The rollout is blocked on the migration.');
    // She keeps talking, and the recording stops before the turn settles.
    h.sayPartial('and the thing I still want before Friday is a rollback');
    const final = await h.end();

    expect(final).not.toBeNull();
    expect(final?.tick).toBe(2);
    const last = seen[seen.length - 1];
    expect(transcriptOf(last as NotesComposeInput)).toContain('a rollback');
    // Flagged, so the note-taker knows it is holding a fragment.
    expect(last?.tick.turns.at(-1)?.partial).toBe(true);
    expect(last?.tick.reason).toBe('end');
  });

  it('and it is in the doc when the meeting is over', async () => {
    const h = createNotesTickHarness({
      compose: (input) =>
        `## Meeting notes\n\n${input.tick.turns
          .map((t) => `- ${t.text.toLowerCase()}`)
          .join('\n')}\n`,
    });

    await h.speak('We agreed on the smaller scope.');
    h.sayPartial('and the one thing I still want is a rollback');
    await h.end();

    expect(h.notes()).toContain('a rollback');
    expect(h.countHeadings(MEETING_NOTES_HEADING)).toBe(1);
  });

  it('a stop with nothing but an unfinished sentence still writes a note', async () => {
    const h = createNotesTickHarness({
      compose: (input) =>
        `## Meeting notes\n\n${input.tick.turns.map((t) => `- ${t.text}`).join('\n')}\n`,
    });

    // No pause ever came: the whole meeting is one turn, cut off.
    h.sayPartial('so the plan is we cut the export dialog and ship the rest on');
    const final = await h.end();

    expect(final).not.toBeNull();
    expect(h.notes()).toContain('cut the export dialog');
  });

  it('a meeting that ended in silence writes nothing extra', async () => {
    const h = createNotesTickHarness({
      compose: () => '## Meeting notes\n\n- the one point\n',
    });

    await h.speak('That is everything.');
    const before = h.markdown();
    const final = await h.end();

    expect(final).toBeNull();
    expect(h.markdown()).toBe(before);
    expect(h.errors).toEqual([]);
  });

  it('a sentence that settled before the stop is carried as settled, not as a fragment', async () => {
    const seen: NotesComposeInput[] = [];
    const h = createNotesTickHarness({
      compose: (input) => {
        seen.push(input);
        return `## Meeting notes\n\n- ${input.tick.turns.length} turns\n`;
      },
    });

    await h.speak('One.');
    // `say` is a partial and then the settle of that same turn, which is what
    // a clean stop on the microphone path produces: the engine's flush turns
    // the sentence in progress into a final before the notes are ended.
    h.say('Two.');
    await h.end();

    const last = seen[seen.length - 1];
    // Once, and as finished speech: the fragment it passed through is not a
    // second turn beside it.
    expect(last?.tick.turns).toEqual([{ turn: 1, text: 'Two.' }]);
  });
});

describe('a person typing in the notes while the meeting runs', () => {
  it('a new bullet appends under their line instead of replacing it', async () => {
    const h = createNotesTickHarness({
      compose: (_input, tick) =>
        `## Meeting notes\n\n${['- the sync is the bottleneck', '- Devi owns the rollout']
          .slice(0, tick)
          .join('\n')}\n`,
    });

    await h.speak('The sync is the bottleneck.');
    typeInNotes(h.ydoc, 'MY OWN line, in my words');

    const second = await h.speak('Devi owns the rollout.');

    const items = notesItems(h.ydoc);
    expect(items).toContain('MY OWN line, in my words');
    expect(items).toContain('Devi owns the rollout');
    expect(items).toContain('the sync is the bottleneck');
    // His line survives exactly once, and no second section opened.
    expect(second.markdown.split('MY OWN line, in my words').length).toBe(2);
    expect(h.countHeadings(MEETING_NOTES_HEADING)).toBe(1);
  });

  it('and the FINAL pass appends under it too', async () => {
    const h = createNotesTickHarness({
      compose: (_input, tick) =>
        `## Meeting notes\n\n${['- the sync is the bottleneck', '- rollback before Friday']
          .slice(0, tick)
          .join('\n')}\n`,
    });

    await h.speak('The sync is the bottleneck.');
    typeInNotes(h.ydoc, 'MY OWN line, in my words');

    h.sayPartial('and I want a rollback before');
    await h.end();

    const items = notesItems(h.ydoc);
    expect(items).toContain('MY OWN line, in my words');
    expect(items).toContain('rollback before Friday');
    expect(h.markdown().split('MY OWN line, in my words').length).toBe(2);
    expect(h.countHeadings(MEETING_NOTES_HEADING)).toBe(1);
  });
});
