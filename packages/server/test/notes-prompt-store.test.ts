/**
 * The note-taking instructions come from a store, not from a literal.
 *
 * Two things have to hold. The DEFAULT must be what the composer used to say,
 * character for character — this move is meant to change where the words live
 * and nothing about what they are. And an override must actually reach the
 * model: not "the store returned it", but the request body the composer put on
 * the wire carried it.
 *
 * All fixtures are synthetic. The repo is public.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNotesPrompt, createHaikuNotesComposer } from '../src/meeting-notes-composer.ts';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import {
  DEFAULT_NOTES_INSTRUCTIONS,
  NOTES_PROMPT_FILENAME,
  createNotesPromptStore,
} from '../src/notes-prompt-store.ts';

const dirs: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-notes-prompt-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const input: NotesComposeInput = {
  docId: 'd1',
  meetingId: 'm1',
  tick: { tick: 1, reason: 'pause', turns: [{ turn: 0, text: 'We should measure first.' }] },
  previous: null,
};

/**
 * The instructions as the composer built them BEFORE the move — the array
 * literal that lived in `buildNotesPrompt`, copied here so the default is
 * pinned against a second copy rather than against itself. A drift in either
 * direction fails this test, which is the point: the words are the contract
 * now, not the file they sit in.
 */
const INSTRUCTIONS_AS_SHIPPED = [
  'You are the live note-taker for a working meeting. You receive the notes',
  'as they currently stand and the speech newly transcribed since the last',
  'update. Return the COMPLETE notes as they should now read.',
  '',
  'Rules:',
  '- Start with the exact heading "## Meeting notes".',
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

describe('the default instructions', () => {
  it('are the words the composer shipped, character for character', () => {
    expect(DEFAULT_NOTES_INSTRUCTIONS).toBe(INSTRUCTIONS_AS_SHIPPED);
  });

  it('are what buildNotesPrompt sends when nothing overrides them', () => {
    expect(buildNotesPrompt(input).system).toBe(INSTRUCTIONS_AS_SHIPPED);
  });

  it('are what an empty data dir resolves to', () => {
    expect(createNotesPromptStore({ dataDir: tempDataDir() }).read()).toBe(
      DEFAULT_NOTES_INSTRUCTIONS,
    );
  });
});

describe('an override in the data dir', () => {
  it('is read at call time, so an edit reaches the next tick', () => {
    const dataDir = tempDataDir();
    const store = createNotesPromptStore({ dataDir });
    expect(store.read()).toBe(DEFAULT_NOTES_INSTRUCTIONS);
    writeFileSync(join(dataDir, NOTES_PROMPT_FILENAME), 'Write the notes as haiku.\n');
    expect(store.read()).toBe('Write the notes as haiku.');
    writeFileSync(join(dataDir, NOTES_PROMPT_FILENAME), 'Write the notes as a limerick.\n');
    expect(store.read()).toBe('Write the notes as a limerick.');
  });

  it('falls back to the default when the file is blank', () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, NOTES_PROMPT_FILENAME), '   \n\n');
    expect(createNotesPromptStore({ dataDir }).read()).toBe(DEFAULT_NOTES_INSTRUCTIONS);
  });

  it('names the file it would read, so an operator can find it', () => {
    const dataDir = tempDataDir();
    expect(createNotesPromptStore({ dataDir }).path).toBe(join(dataDir, NOTES_PROMPT_FILENAME));
  });
});

describe('what the model actually receives', () => {
  /** The composer's HTTP seam, capturing the request body. */
  function captureFetch(): { bodies: Array<Record<string, unknown>>; impl: typeof fetch } {
    const bodies: Array<Record<string, unknown>> = [];
    const impl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ content: [{ text: '## Meeting notes\n\n- measure first' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    return { bodies, impl };
  }

  it('sends the stored default when there is no override', async () => {
    const { bodies, impl } = captureFetch();
    const store = createNotesPromptStore({ dataDir: tempDataDir() });
    const composer = createHaikuNotesComposer({
      apiKey: 'test-key',
      fetchImpl: impl,
      instructions: store.read,
    });
    await composer?.compose(input);
    expect(bodies[0]?.system).toBe(DEFAULT_NOTES_INSTRUCTIONS);
  });

  it('sends the override once the file is there', async () => {
    const { bodies, impl } = captureFetch();
    const dataDir = tempDataDir();
    const store = createNotesPromptStore({ dataDir });
    const composer = createHaikuNotesComposer({
      apiKey: 'test-key',
      fetchImpl: impl,
      instructions: store.read,
    });
    writeFileSync(
      join(dataDir, NOTES_PROMPT_FILENAME),
      'You are a notetaker. Fold new points into the headings that already cover them.',
    );
    await composer?.compose(input);
    expect(bodies[0]?.system).toBe(
      'You are a notetaker. Fold new points into the headings that already cover them.',
    );
    expect(bodies[0]?.system).not.toBe(DEFAULT_NOTES_INSTRUCTIONS);
  });

  it('a composer wired without a store still sends the default', async () => {
    const { bodies, impl } = captureFetch();
    const composer = createHaikuNotesComposer({ apiKey: 'test-key', fetchImpl: impl });
    await composer?.compose(input);
    expect(bodies[0]?.system).toBe(DEFAULT_NOTES_INSTRUCTIONS);
  });
});
