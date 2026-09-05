/**
 * The loose matcher: what a spoken "link that to the existing task" reaches
 * for, and what it refuses to guess at.
 *
 * The strict matcher next door (`notes-references.test.ts`) pins the opposite
 * bar — an unprompted citation needs the title's own words. Everything here
 * is about the case that one is deliberately bad at: an instruction, given
 * with a description rather than a name.
 *
 * The board below is invented, and its rows carry bodies the way real rows
 * do. The bodies matter to the answer, so they are written the way somebody
 * filing the ticket would write them — never as a restatement of the speech
 * the test then feeds in. Where a row has no body at all it is there to prove
 * the title alone still reaches.
 */

import { describe, expect, it } from 'bun:test';
import {
  ASK_AMBIGUITY_MARGIN,
  ASK_LINK_MIN_SCORE,
  MAX_SUGGESTIONS,
  SUGGEST_MIN_SCORE,
  appendSuggestions,
  detectLinkAsk,
  linkAskQuery,
  resolveNoteLinks,
  suggestionHref,
} from '../src/notes-link-intent.ts';
import type { NoteReference } from '../src/notes-references.ts';

const row = (id: string, title: string, body?: string): NoteReference => ({
  kind: 'task',
  id,
  title,
  url: `/workspaces/w-eval?task=${id}`,
  ...(body !== undefined ? { body } : {}),
});

const BOARD: NoteReference[] = [
  row(
    't-vol',
    'Volume buttons',
    'The up and down keys sit under the thumb. Sizing, spacing and the travel of each press.',
  ),
  row('t-chan', 'Channel buttons', 'Numeric entry plus the rocker for stepping one at a time.'),
  row(
    't-speech',
    'Speech recognition',
    'Voice control in the handset: a wake word, a microphone, and what happens when it mishears.',
  ),
  row(
    't-colour',
    'Corporate colour scheme',
    'The house yellow and grey have to appear on the casing.',
  ),
  row('t-cost', 'Production cost target', 'Twelve euro fifty per unit at the factory gate.'),
  // No body: the title is all this one has, and it still has to be reachable.
  row('t-lcd', 'LCD screen'),
];

const titles = (refs: readonly NoteReference[]): string[] => refs.map((r) => r.title);

describe('detectLinkAsk', () => {
  it('hears the ask however it is phrased', () => {
    for (const said of [
      'Link that to the existing task.',
      'Can you link this to the ticket we already have?',
      'Attach that to the existing ticket, please.',
      'Hook this up to the existing issue.',
      'Tie that back to the card on the board.',
      'Associate this with the existing story.',
    ]) {
      expect(detectLinkAsk(said), said).toBe(true);
    }
  });

  it('does not hear an ask in speech that merely mentions a row', () => {
    for (const said of [
      'The volume buttons task is still open.',
      'We should link the design doc in the notes.',
      'That ticket has been sitting there for weeks.',
      'Somebody linked the wrong thing last time.',
    ]) {
      expect(detectLinkAsk(said), said).toBe(false);
    }
  });

  it('refuses an ask that says the row does not exist yet', () => {
    // "Link this to a new ticket" is a create, and the extractor's request
    // intent owns it. Answering it with an existing row attaches the
    // discussion to the wrong work AND swallows the row somebody asked for.
    expect(detectLinkAsk('Link this to a new ticket.')).toBe(false);
    expect(detectLinkAsk('Attach that to a separate task.')).toBe(false);
  });

  it('will not join a verb in one sentence to a noun in the next', () => {
    expect(detectLinkAsk('We should link it. The ticket is closed anyway.')).toBe(false);
  });

  it('reads the noun only after the verb, so a description is not an instruction', () => {
    expect(detectLinkAsk('The new task should link to the design doc.')).toBe(false);
  });
});

describe('linkAskQuery', () => {
  it('drops the words the ask itself contributed', () => {
    const q = linkAskQuery('Link that to the existing task about the volume keys.');
    expect(q).not.toMatch(/\blink\b/i);
    expect(q).not.toMatch(/\bexisting\b/i);
    expect(q).not.toMatch(/\btask\b/i);
    // What the sentence was ABOUT is exactly what survives.
    expect(q).toMatch(/volume keys/);
  });

  it('leaves speech that is not an ask alone', () => {
    const said = 'The volume keys are too small.';
    expect(linkAskQuery(said)).toBe(said);
  });
});

describe('resolveNoteLinks — an explicit ask', () => {
  it('links a row from a loose description that quotes none of its title', () => {
    // "Voice control … mishears" against a row called "Speech recognition":
    // not one word of the title is spoken. This is the case the strict
    // matcher cannot answer and the owner reported as not working.
    const out = resolveNoteLinks({
      spokenText:
        'Voice control keeps coming up and we still have not said what happens when it mishears. ' +
        'Link that to the existing ticket.',
      catalogue: BOARD,
    });
    expect(titles(out.linked)).toEqual(['Speech recognition']);
    expect(out.suggested).toEqual([]);
  });

  it('links a row that has no body, from its title alone', () => {
    const out = resolveNoteLinks({
      spokenText: 'Does the LCD screen survive the drop test? Link that to the existing task.',
      catalogue: BOARD,
    });
    expect(titles(out.linked)).toEqual(['LCD screen']);
  });

  it('offers the shortlist instead of guessing when two rows are neck and neck', () => {
    // Both rows are named, so either is a defensible answer and picking one
    // is a coin flip. A wrong citation is a claim nobody rereading the notes
    // can tell was a guess, so the ask becomes a question.
    const out = resolveNoteLinks({
      spokenText:
        'The volume and channel buttons both need rethinking. Link that to the existing task.',
      catalogue: BOARD,
    });
    expect(out.linked).toEqual([]);
    // Sorted: at an exact tie the scorer's order is its id tie-break, which
    // is arbitrary here and not what this test is about.
    expect(titles(out.suggested).sort()).toEqual(['Channel buttons', 'Volume buttons']);
  });

  it('answers nothing when the ask names nothing on the board', () => {
    const out = resolveNoteLinks({
      spokenText: 'Whose turn is it to bring the biscuits? Link that to the existing task.',
      catalogue: BOARD,
    });
    expect(out.linked).toEqual([]);
    expect(out.suggested).toEqual([]);
  });

  it('links a row the strict matcher already cited, so the row gets its ref', () => {
    // The citation was never the missing half — the strict matcher writes
    // that. What an ask adds is the ref on the ROW, and a person who says the
    // title out loud and then asks for a link deserves it as much as one who
    // described the work.
    const out = resolveNoteLinks({
      spokenText: 'The volume buttons are too small. Link that to the existing task.',
      catalogue: BOARD,
      named: [BOARD[0]!],
    });
    expect(titles(out.linked)).toContain('Volume buttons');
  });

  it('asks nothing more once the ask has been answered', () => {
    // A shortlist beside a link the note now carries is a question about
    // alternatives to something already decided.
    const out = resolveNoteLinks({
      spokenText: 'The volume buttons are too small. Link that to the existing task.',
      catalogue: BOARD,
      named: [BOARD[0]!],
    });
    expect(out.suggested).toEqual([]);
  });

  it('still never SUGGESTS a row the strict matcher already cited', () => {
    // The unasked direction is unchanged: a row already in the note is not
    // something to ask the reader about.
    const out = resolveNoteLinks({
      spokenText: 'The volume buttons sit under the thumb and the travel is too short.',
      catalogue: BOARD,
      named: [BOARD[0]!],
    });
    expect(titles(out.suggested)).not.toContain('Volume buttons');
  });
});

describe('resolveNoteLinks — nobody asked', () => {
  it('suggests a probable row rather than staying silent', () => {
    const out = resolveNoteLinks({
      spokenText: 'The up and down keys sit right under the thumb and the travel is too short.',
      catalogue: BOARD,
    });
    expect(out.linked).toEqual([]);
    expect(titles(out.suggested)).toEqual(['Volume buttons']);
  });

  it('suggests nothing when the speech is about nothing on the board', () => {
    const out = resolveNoteLinks({
      spokenText: 'Shall we break for ten minutes and pick this up after?',
      catalogue: BOARD,
    });
    expect(out.suggested).toEqual([]);
  });

  it('never links without being asked, however well a row scores', () => {
    // The same words that LINK under an ask only SUGGEST without one. An
    // unprompted citation is a claim about what the discussion was about.
    const words =
      'Voice control keeps coming up and we still have not said what happens when it mishears.';
    expect(resolveNoteLinks({ spokenText: words, catalogue: BOARD }).linked).toEqual([]);
    expect(
      resolveNoteLinks({
        spokenText: `${words} Link that to the existing ticket.`,
        catalogue: BOARD,
      }).linked,
    ).toHaveLength(1);
  });

  it('caps how many questions one tick may carry', () => {
    const out = resolveNoteLinks({
      spokenText:
        'The up down volume keys, the numeric channel entry rocker, the voice control wake word ' +
        'microphone, the house yellow grey casing colour scheme and the twelve fifty unit factory cost.',
      catalogue: BOARD,
    });
    expect(out.suggested.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
  });
});

describe('the thresholds say what they mean', () => {
  it('asks for less evidence to answer an ask than to raise one unprompted', () => {
    expect(ASK_LINK_MIN_SCORE).toBeLessThan(SUGGEST_MIN_SCORE);
  });
  it('keeps a real margin, so a near-tie can never resolve to a link', () => {
    expect(ASK_AMBIGUITY_MARGIN).toBeGreaterThan(0);
  });
});

describe('suggestionHref', () => {
  it('marks the row’s own URL rather than inventing a second link shape', () => {
    expect(suggestionHref('/workspaces/w-1?task=t-2')).toBe('/workspaces/w-1?task=t-2&suggest=1');
    expect(suggestionHref('/docs/d-1')).toBe('/docs/d-1?suggest=1');
  });
});

describe('appendSuggestions', () => {
  const suggestion = row('t-vol', 'Volume buttons');

  it('hangs the question off the last note, where what was just said landed', () => {
    const out = appendSuggestions('## Meeting notes\n\n- First point\n- Second point', [
      suggestion,
    ]);
    expect(out).toBe(
      '## Meeting notes\n\n- First point\n' +
        '- Second point [related: Volume buttons?](/workspaces/w-eval?task=t-vol&suggest=1)',
    );
  });

  it('writes a note of its own rather than dropping the question', () => {
    // A silent skip is the failure this path exists to remove, so a section
    // with no note of ours to hang it on gets the question as a note.
    const out = appendSuggestions('## Meeting notes', [suggestion]);
    expect(out).toContain('- [related: Volume buttons?]');
  });

  it('never appends to a line a person wrote', () => {
    const mine = '- I will check the mould tolerances';
    const out = appendSuggestions(`## Meeting notes\n\n- Ours\n${mine}`, [suggestion], {
      protect: [mine],
    });
    // The person's line is returned exactly as it was written…
    expect(out.split('\n')).toContain(mine);
    // …and the question went to the last line that was ours.
    expect(out.split('\n').find((l) => l.startsWith('- Ours'))).toContain('related:');
  });

  it('skips a row the notes already cite', () => {
    const already = `## Meeting notes\n\n- Sized the [buttons](${suggestion.url}) again`;
    expect(appendSuggestions(already, [suggestion])).toBe(already);
  });

  it('changes nothing when there is nothing to suggest', () => {
    const notes = '## Meeting notes\n\n- A point';
    expect(appendSuggestions(notes, [])).toBe(notes);
  });
});
