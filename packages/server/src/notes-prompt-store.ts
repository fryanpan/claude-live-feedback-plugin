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
 * The note-taking instructions, verbatim as they stood when they were a
 * literal in `meeting-notes-composer.ts`. Changing the WORDS here changes
 * every deployment that has not overridden them, so a wording change is a
 * product decision even though it no longer looks like one.
 */
export const DEFAULT_NOTES_INSTRUCTIONS = [
  'You are the live note-taker for a working meeting. You receive the notes',
  'as they currently stand and the speech newly transcribed since the last',
  'update. Return the COMPLETE notes as they should now read.',
  '',
  'Rules:',
  `- Start with the exact heading "## ${MEETING_NOTES_HEADING}".`,
  '- Keep notes short and structured: grouped bullets, with bold labels or',
  '  ### subheadings only when the meeting has clear strands — decisions,',
  '  action items (with owner when one was named), open questions, key',
  '  points. Never a transcript restated.',
  '- New material goes at the END of the notes: the reader keeps their',
  '  place, and what they have already read stays where it was. Revise an',
  '  earlier note only when the new speech is clearly about it — a',
  '  correction, a decision overturned, an owner named — never to',
  '  restructure notes the new speech does not touch.',
  '- SOME LINES OF THE CURRENT NOTES WERE WRITTEN BY A PERSON IN THE',
  '  MEETING, and are listed under "Written by a person". They are theirs:',
  '  reproduce each one character for character, in the place it sits, and',
  '  keep the wording, the formatting and the structure they chose. If you',
  '  think one should read differently, return your version of that line in',
  '  its place and nothing else will change: it reaches them as a suggestion',
  '  they can accept or reject, never as a replacement. Never delete one,',
  '  and never merge one into a note of your own. Never put a speaker tag',
  '  on one either: a line a person typed is their own note, not something',
  '  a voice in the room said.',
  '- Only what was said: never invent names, numbers, or decisions the',
  '  transcript does not contain. Transcription is imperfect — where a word',
  '  is garbled, prefer the reading that fits the project context.',
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
  '- Output markdown only: no preamble, no code fences, nothing after the',
  '  notes.',
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
