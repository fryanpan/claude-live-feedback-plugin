/**
 * Every settled turn of a meeting is accounted for: a note, or a skip on
 * purpose. Nothing may simply vanish.
 *
 * WHY AN AUDIT AND NOT MORE UNIT TESTS. The ways a meeting loses words are
 * spread across five modules — the ticker's delta, the compose chain's carry,
 * the composer's own reply, the ownership merge, and the section finder — and
 * each of them has tests that pass while the meeting as a whole drops a
 * stretch of conversation. The only statement that catches all five is about
 * the WHOLE meeting: run a scripted one end to end, then ask of every turn
 * that settled whether the notes say anything about it.
 *
 * HOW A SKIP IS LEGITIMATE. Most of what is said in a meeting is not a note —
 * greetings, thinking aloud, a point going round again — and the note-taker is
 * asked to filter hard. So the script declares, per utterance, either the note
 * it should produce or the reason it carries none. A turn with neither is the
 * failure this audit exists to find: words that went into the transcript, were
 * never deliberately dropped, and are in no note.
 *
 * THE SCRIPT IS CUT THE WAY THE CLOCKS CUT IT. Utterances run about six
 * seconds each and arrive in runs with a pause between them, which is what
 * the pause clock sees in a real meeting; `MEETING_SECONDS` below is that
 * arithmetic, asserted rather than claimed. The last run ends mid-sentence,
 * because that is how a person stops a recording.
 *
 * All speech here is synthetic. The repo is public.
 */

import { describe, expect, it } from 'bun:test';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { MEETING_NOTES_HEADING } from '../src/notes-section.ts';
import { createNotesTickHarness, notesItems } from './notes-tick-harness.ts';

/** One thing said, and what the notes owe it. */
interface Line {
  speaker: 'A' | 'B';
  said: string;
  /** The note this line should produce, or `null` when it is not a note. */
  note: string | null;
  /** Why it is not a note. Required whenever `note` is null. */
  skip?: string;
}

/** A run of speech with no pause in it. A pause follows every run but the last. */
type Run = Line[];

const note = (speaker: 'A' | 'B', said: string, note: string): Line => ({ speaker, said, note });
const filler = (speaker: 'A' | 'B', said: string, skip: string): Line => ({
  speaker,
  said,
  note: null,
  skip,
});

/**
 * Roughly how long each utterance takes to say, and how long the room is
 * quiet between runs. Not a timer — nothing here waits — just the arithmetic
 * that makes "a three-minute meeting" a checked statement rather than a
 * claim in a comment.
 */
const SECONDS_PER_LINE = 6;
const SECONDS_PER_PAUSE = 5;

const SCRIPT: Run[] = [
  [
    filler('A', 'Okay, are we recording? I think we are.', 'setting up the recording'),
    note(
      'A',
      'So the export dialog is still forgetting the range people picked.',
      'The export dialog loses the chosen date range.',
    ),
    note(
      'B',
      'Right, and it only does it when you come back to it a second time.',
      'It only reproduces on a second visit to the dialog.',
    ),
  ],
  [
    note(
      'A',
      'I think the state is being read before the stored preference loads.',
      'Likely cause: state read before the stored preference has loaded.',
    ),
    filler('B', 'Hm. Hm, yeah. Maybe.', 'thinking aloud, no content'),
    note(
      'B',
      'We could just await the preference read before the dialog paints.',
      'Option: await the preference read before first paint.',
    ),
    note(
      'A',
      'That would put a round trip in front of every open, which people would feel.',
      'That option costs a round trip on every open.',
    ),
  ],
  [
    note(
      'B',
      'The other way is to paint with the last known range and correct it.',
      'Option: paint the last known range, then correct it.',
    ),
    note(
      'A',
      'I would rather do that, and I will take it — the flicker is cheaper than the wait.',
      'Decision: A takes the paint-then-correct option, because a flicker beats a wait.',
    ),
    filler('B', 'Sounds good. Sounds good to me.', 'agreement with no new content'),
  ],
  [
    note(
      'A',
      'Second thing, the notes have been skipping chunks of the meeting.',
      'The meeting notes have been skipping stretches of conversation.',
    ),
    note(
      'B',
      'And everything after the last pause just never showed up at all.',
      'Everything after the final pause was missing entirely.',
    ),
    filler('A', 'Yeah, I saw that too, that is the same thing I saw.', 'restating the point above'),
    note(
      'B',
      'Do we have any way to tell which turns made it into a note?',
      'Open question from B: is there a way to tell which turns reached a note?',
    ),
  ],
  [
    note(
      'A',
      'Not today, but an audit over a scripted meeting would answer it every run.',
      'Next: an audit over a scripted meeting, checked on every run.',
    ),
    filler('B', 'Okay. Okay, good.', 'acknowledgement'),
    note(
      'A',
      'I will write that this week and put it in the server suite.',
      'A will write the audit this week and land it in the server suite.',
    ),
  ],
  [
    note(
      'B',
      'While you are out, does the export fix still go out on Friday?',
      'Open question from B: does the export fix still ship on Friday while A is away?',
    ),
    note(
      'A',
      'It should, the change is small and it will be on main by Wednesday.',
      'The export fix is small and lands on main by Wednesday.',
    ),
    filler('B', 'Right, right. Okay.', 'acknowledgement'),
    note(
      'A',
      'But somebody else has to watch the deploy, because I will not be here.',
      'Somebody other than A has to watch the deploy.',
    ),
    note(
      'B',
      'Let us put that on the board rather than leaving it in this conversation.',
      'Decision: the deploy-watch goes on the board rather than staying in conversation.',
    ),
  ],
  [
    note(
      'B',
      'Last thing before I have to go, about who is covering the release.',
      'Raised at the end: who covers the release.',
    ),
    note(
      'A',
      'I am out Thursday and Friday, so it cannot be me for that window.',
      'A is out Thursday and Friday and cannot cover the release then.',
    ),
  ],
];

/**
 * The sentence the recording cut off. It never settles — the person pressed
 * stop while they were still saying it — which is exactly the case that used
 * to reach no tick at all.
 */
const INTERRUPTED: Line = note(
  'B',
  'then I will take Thursday and we can find somebody for',
  'B takes Thursday; Friday still needs somebody.',
);

const LINES: Line[] = [...SCRIPT.flat(), INTERRUPTED];

const MEETING_SECONDS = LINES.length * SECONDS_PER_LINE + (SCRIPT.length - 1) * SECONDS_PER_PAUSE;

/**
 * A note-taker that behaves like the real one on this script: it returns the
 * WHOLE notes every tick, it writes a bullet for a line the script says is a
 * note, and it writes nothing for a line the script calls filler.
 *
 * Matching is by prefix so the interrupted sentence — which arrives as the
 * engine's raw partial — is recognised as the line it is the beginning of.
 */
function scriptedComposer(): {
  compose: (input: NotesComposeInput) => string;
  /** Every line the composer chose not to write a note for, in order. */
  readonly skipped: string[];
} {
  const written: string[] = [];
  const skipped: string[] = [];
  return {
    skipped,
    compose(input) {
      for (const turn of input.tick.turns) {
        const line = LINES.find((l) => l.said === turn.text || l.said.startsWith(turn.text.trim()));
        if (!line) continue;
        if (line.note === null) {
          if (!skipped.includes(line.said)) skipped.push(line.said);
          continue;
        }
        if (!written.includes(line.note)) written.push(line.note);
      }
      return `## ${MEETING_NOTES_HEADING}\n\n${written.map((n) => `- ${n}`).join('\n')}\n`;
    },
  };
}

/** One turn's verdict: the note that covers it, the reason it has none, or
 *  nothing at all — which is the failure. */
interface Verdict {
  said: string;
  outcome: 'noted' | 'skipped' | 'UNMAPPED';
  detail: string;
}

describe('turn coverage over a scripted three-minute meeting', () => {
  it('is three minutes of speech, cut the way the clocks cut it', () => {
    expect(MEETING_SECONDS).toBeGreaterThanOrEqual(150);
    expect(MEETING_SECONDS).toBeLessThanOrEqual(230);
    // Every filler line says why it is one; an unexplained skip is not a skip.
    for (const line of LINES) {
      if (line.note === null) expect(line.skip).toBeTruthy();
    }
  });

  it('maps every turn to a note or to a logged skip, and leaves none unmapped', async () => {
    const composer = scriptedComposer();
    const h = createNotesTickHarness({ compose: composer.compose });

    for (const run of SCRIPT) {
      for (const line of run) h.say({ speaker: line.speaker, text: line.said });
      await h.tick();
    }
    // Somebody is still talking when the recording stops.
    h.sayPartial(INTERRUPTED.said, INTERRUPTED.speaker);
    await h.end();

    const items = notesItems(h.ydoc);
    const verdicts: Verdict[] = LINES.map((line) => {
      if (line.note !== null && items.some((i) => i.includes(line.note as string))) {
        return { said: line.said, outcome: 'noted', detail: line.note };
      }
      if (line.note === null && composer.skipped.includes(line.said)) {
        return { said: line.said, outcome: 'skipped', detail: line.skip as string };
      }
      return {
        said: line.said,
        outcome: 'UNMAPPED',
        detail: line.note === null ? 'never reached the composer' : 'no note carries it',
      };
    });

    const unmapped = verdicts.filter((v) => v.outcome === 'UNMAPPED');
    // Named, not counted: a bare zero says nothing about which sentence went
    // missing when this fails.
    expect(unmapped.map((v) => `${v.said} — ${v.detail}`)).toEqual([]);
    expect(verdicts.filter((v) => v.outcome === 'noted').length).toBe(
      LINES.filter((l) => l.note !== null).length,
    );
    expect(verdicts.filter((v) => v.outcome === 'skipped').length).toBe(
      LINES.filter((l) => l.note === null).length,
    );
    expect(h.errors).toEqual([]);
    expect(h.countHeadings(MEETING_NOTES_HEADING)).toBe(1);
  });

  it('the last sentence of the meeting is one of the mapped turns', async () => {
    const composer = scriptedComposer();
    const h = createNotesTickHarness({ compose: composer.compose });

    for (const run of SCRIPT) {
      for (const line of run) h.say({ speaker: line.speaker, text: line.said });
      await h.tick();
    }
    h.sayPartial(INTERRUPTED.said, INTERRUPTED.speaker);
    await h.end();

    // The audit above would report exactly this line as UNMAPPED without the
    // final pass, so it is worth asserting on its own: this is the sentence
    // the ticket is about.
    expect(notesItems(h.ydoc).some((i) => i.includes(INTERRUPTED.note as string))).toBe(true);
  });
});
