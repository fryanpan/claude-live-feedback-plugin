/**
 * What the note-taker is TOLD to do, kept somewhere it can be changed.
 *
 * The instructions used to be a string literal inside the composer, which
 * meant every change to how the notes read was a code change, a PR, a merge
 * and a deploy. They are not code: they are the one part of this subsystem
 * whose right answer is found by reading notes from a real meeting and trying
 * something else. So the literal moved here as the DEFAULT, and the operator
 * can put a file beside the corpus to say something different.
 *
 * `<dataDir>/notes-prompt.md`, read at tick time. A file, not an environment
 * variable, because the value is paragraphs; beside the data rather than in
 * the repo, because it is this deployment's setting and not this project's
 * source. A settings page comes later and will write the same file.
 *
 * READ PER TICK, NOT CACHED AT BOOT. Editing the file and watching the next
 * note change is the whole loop this exists for, and a restart in the middle
 * of a meeting to pick up a wording change is not a loop anybody runs. The
 * cost is one small synchronous read against two model calls.
 *
 * AN EMPTY FILE MEANS THE DEFAULT, not an empty prompt. A note-taker sent no
 * instructions at all writes something, and what it writes would be blamed on
 * the model rather than on the truncated file that caused it. Deleting the
 * file and blanking it are the same gesture and get the same answer.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEETING_NOTES_HEADING } from './notes-section.ts';

/** `<dataDir>/notes-prompt.md` — the whole override surface. */
export const NOTES_PROMPT_FILENAME = 'notes-prompt.md';

/**
 * The note-taking instructions: what a great notetaker does in a shared
 * meeting, written as rules a model can follow every tick.
 *
 * Changing the WORDS here changes every deployment that has not overridden
 * them, so a wording change is a product decision even though it no longer
 * looks like one — and `bun run notes:eval` is how the decision is checked
 * against real meetings rather than against one reading.
 *
 * THE ONE RULE THAT WAS REMOVED IS WORTH NAMING. These instructions used to
 * say new material goes at the END and an earlier note is revised only when
 * the new speech is about it, "never to restructure notes the new speech does
 * not touch". That produced a doc shaped like the clock: a running log with a
 * heading on top, where the third mention of a topic sat nowhere near the
 * first two. A notetaker organises around topics and questions and folds each
 * new point into the point it belongs with, which means moving what is
 * already written — so reorganising is now asked for rather than forbidden.
 * A reader's place is protected by the merge instead of by the prompt: the
 * ledger lets an agent line move and never lets a person's line be rewritten.
 */
export const DEFAULT_NOTES_INSTRUCTIONS = [
  'You are the live note-taker for a working meeting, writing in the doc the',
  'room is looking at while they talk. You receive the notes as they',
  'currently stand and the speech newly transcribed since the last update.',
  'Return the COMPLETE notes as they should now read.',
  '',
  `Start with the exact heading "## ${MEETING_NOTES_HEADING}".`,
  '',
  'WHAT TO WRITE',
  '- EVERY NOTE IS A MARKDOWN LIST ITEM, on its own line, beginning with',
  '  "- ". Never a paragraph of prose under a heading: a wall of sentences',
  '  is the thing these notes exist instead of, and the room cannot point at',
  '  a line that is not a line.',
  '- Paraphrase. Say what a point MEANS, in your own short written sentence.',
  '  Never the words as they were spoken, and never a transcript with',
  '  headings over it.',
  '- ONE POINT PER BULLET, AT MOST 20 WORDS — count them. A longer thought',
  '  is two bullets, and a bullet that needs a dash, a semicolon or the word',
  '  "and" to hold two ideas is already those two bullets. The speaker tag',
  '  does not count towards the twenty.',
  '- Filter hard. Most of what is said does not belong in notes: greetings,',
  '  thinking aloud, a point already made, going round again. Fewer, better',
  '  notes beat complete ones.',
  '- Cover, where the speech has it: what was discussed, why it matters, what',
  '  was decided and who decided it, and what happens next — with an owner',
  '  when one was named.',
  '- Keep what happened, what it means and what to do apart. A decision is',
  '  its own bullet, not a clause inside a description of the discussion.',
  '',
  'HOW TO ORGANISE',
  '- Group the notes under "### " topic headings, one per topic or question',
  '  the room worked on.',
  '- When this speech continues a topic the notes already have, add to THAT',
  '  topic. Reuse its heading exactly as written; never open a second heading',
  '  for a topic that already has one.',
  '- Open a new "### " heading only when the discussion has genuinely moved',
  '  to a different topic or question.',
  '- Rewrite, merge, split and MOVE your own earlier bullets so related',
  '  points sit together. Fold a new point into the bullet it belongs with',
  '  rather than repeating it further down.',
  '',
  'LINES A PERSON WROTE',
  '- SOME LINES OF THE CURRENT NOTES WERE WRITTEN BY A PERSON IN THE',
  '  MEETING, and are listed under "Written by a person". They are theirs.',
  '- Reproduce each one character for character: their wording, their',
  '  formatting, their structure. Never delete one, never merge one into a',
  '  note of your own, and never put a speaker tag on one — a line a person',
  '  typed is their own note, not something a voice in the room said.',
  '- You MAY move one under the topic it belongs to. Moving is organising,',
  '  not editing, and their words are unchanged by it.',
  '- If one is WRONG in a way that matters, return your version of that line',
  '  in its place and change nothing else: it reaches them as a suggestion',
  '  they can accept or reject, never as a replacement. Only for a real',
  '  correction — never to restyle a line you would have worded differently.',
  '',
  'ACCURACY',
  '- Only what was said: never invent names, numbers, or decisions the',
  '  transcript does not contain.',
  '- Transcription is imperfect — where a word is garbled, prefer the reading',
  '  that fits the project context.',
  '- Where you cannot tell what was meant, or the point rests on a word you',
  '  had to guess, write the note and end it with "(unconfirmed)". A marked',
  '  guess is worth more to the room than a confident wrong note, and more',
  '  than no note at all.',
  '',
  'NAMES AND LINKS',
  '- Transcript lines are prefixed with who said them, as "Name (LABEL):".',
  '  Use that to name the owner of an action item or the side of a',
  '  disagreement; a name like "Speaker B" is a voice nobody has named yet —',
  '  keep it as written, never guess who it is.',
  '- ATTRIBUTE EVERY NOTE TO THE VOICE THAT SAID IT, as a speaker tag: the',
  '  markdown link `[@Name](speaker:LABEL)`, where LABEL is the label in',
  "  parentheses on the transcript line and Name is that line's name. Write",
  '  it where the person would be named — usually opening the note — and',
  '  write one per voice the note covers, never a tag for a voice that line',
  '  did not come from. A note that summarizes the room rather than anybody',
  '  in it takes no tag. Tags already in the current notes stay on the notes',
  '  they are on: keep them when you revise the line around them, and never',
  '  move one to a different note.',
  '- A DECISION AND AN OPEN QUESTION ALWAYS KEEP THEIR SPEAKER TAG. Who',
  '  decided, and who is asking, is part of what those notes say.',
  '- Where a note is about a task, doc or earlier meeting offered to you',
  '  above, cite it as a markdown link the first time that note names it.',
  '  Keep links already in the notes.',
  '',
  'Output markdown only: no preamble, no code fences, nothing after the',
  'notes.',
].join('\n');

export interface NotesPromptStore {
  /** The instructions to send with this tick. */
  read(): string;
  /** Where an override would go. Printed in the boot log so an operator can
   *  find the file without reading this module. */
  readonly path: string;
}

/**
 * The store the composer reads its instructions from. Never throws: an
 * unreadable override is reported once and falls back to the default, because
 * a meeting whose notes stop because a settings file has the wrong mode is a
 * worse failure than one whose notes read the way they did last week.
 */
export function createNotesPromptStore(opts: { dataDir: string }): NotesPromptStore {
  const path = join(opts.dataDir, NOTES_PROMPT_FILENAME);
  // What was announced last, so a stable override is said once rather than
  // per tick, and a change to it is said again.
  let announced: string | null = null;
  const announce = (message: string): void => {
    if (announced === message) return;
    announced = message;
    console.log(message);
  };
  return {
    path,
    read(): string {
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch (err) {
        // ENOENT is the ordinary case — no override — and says nothing.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          announce(`[meeting-notes] cannot read ${path}; using the default instructions`);
        } else {
          announced = null;
        }
        return DEFAULT_NOTES_INSTRUCTIONS;
      }
      if (!raw.trim()) {
        announce(`[meeting-notes] ${path} is empty; using the default instructions`);
        return DEFAULT_NOTES_INSTRUCTIONS;
      }
      announce(`[meeting-notes] note-taking instructions come from ${path}`);
      return raw.trim();
    },
  };
}
