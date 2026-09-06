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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNotesPrompt, createHaikuNotesComposer } from '../src/meeting-notes-composer.ts';
import type { NotesComposeInput } from '../src/meeting-notes.ts';
import { DEFAULT_NOTES_INSTRUCTIONS, NOTES_PROMPT_FILENAME } from '../src/notes-prompt-store.ts';
import { PROMPTS_FILENAME, createPromptStore } from '../src/prompt-store.ts';

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
 * WHAT USED TO BE HERE, and why it is not. This block held a second copy of
 * the instructions, frozen as the composer shipped them, so the move out of
 * `buildNotesPrompt` could be proved to have changed nothing. The move is
 * long done, and the words have since been rewritten into the notetaking
 * behaviour (`notetaker-behaviour.test.ts`) — a frozen copy would now make
 * every tuning change a two-file edit that asserts only that somebody edited
 * both files. What is worth pinning here is the WIRING: the default is what
 * an unconfigured store returns, and it is what reaches the model.
 */
describe('the default instructions', () => {
  it('are what buildNotesPrompt sends when nothing overrides them', () => {
    expect(buildNotesPrompt(input).system).toBe(DEFAULT_NOTES_INSTRUCTIONS);
  });

  it('are what an empty data dir resolves to', () => {
    expect(createPromptStore({ dataDir: tempDataDir() }).read('meeting-notes')).toBe(
      DEFAULT_NOTES_INSTRUCTIONS,
    );
  });
});

/**
 * `notes-prompt.md` was the whole override surface before the settings page
 * existed, and a deployment that had edited it must not silently go back to
 * the shipped words on the day the page ships. These cover the one-shot move
 * into `prompts.json` and the rules the old file's store established.
 */
describe('an override in the data dir', () => {
  it('is read at call time, so an edit reaches the next tick', () => {
    const dataDir = tempDataDir();
    const store = createPromptStore({ dataDir });
    expect(store.read('meeting-notes')).toBe(DEFAULT_NOTES_INSTRUCTIONS);
    store.write('meeting-notes', 'Write the notes as haiku.');
    expect(store.read('meeting-notes')).toBe('Write the notes as haiku.');
    store.write('meeting-notes', 'Write the notes as a limerick.');
    expect(store.read('meeting-notes')).toBe('Write the notes as a limerick.');
  });

  it('brings the operator’s notes-prompt.md forward, once', () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, NOTES_PROMPT_FILENAME), 'Write the notes as haiku.\n');
    expect(createPromptStore({ dataDir }).read('meeting-notes')).toBe('Write the notes as haiku.');
    // Migrated, so it is in the JSON — and the markdown file is left alone.
    const file = JSON.parse(readFileSync(join(dataDir, PROMPTS_FILENAME), 'utf8')) as {
      prompts: Record<string, { value?: string }>;
    };
    expect(file.prompts['meeting-notes']?.value).toBe('Write the notes as haiku.');
    expect(readFileSync(join(dataDir, NOTES_PROMPT_FILENAME), 'utf8')).toContain('haiku');
    // And a later edit through the store wins over the file it came from.
    const store = createPromptStore({ dataDir });
    store.write('meeting-notes', 'Write the notes as a limerick.');
    writeFileSync(join(dataDir, NOTES_PROMPT_FILENAME), 'Ignore me.\n');
    expect(createPromptStore({ dataDir }).read('meeting-notes')).toBe(
      'Write the notes as a limerick.',
    );
  });

  it('falls back to the default when the file is blank', () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, NOTES_PROMPT_FILENAME), '   \n\n');
    expect(createPromptStore({ dataDir }).read('meeting-notes')).toBe(DEFAULT_NOTES_INSTRUCTIONS);
  });

  it('names the file it would read, so an operator can find it', () => {
    const dataDir = tempDataDir();
    expect(createPromptStore({ dataDir }).path).toBe(join(dataDir, PROMPTS_FILENAME));
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
    const store = createPromptStore({ dataDir: tempDataDir() });
    const composer = createHaikuNotesComposer({
      apiKey: 'test-key',
      fetchImpl: impl,
      instructions: () => store.read('meeting-notes'),
    });
    await composer?.compose(input);
    expect(bodies[0]?.system).toBe(DEFAULT_NOTES_INSTRUCTIONS);
  });

  it('sends the override the moment it is saved, with no restart', async () => {
    const { bodies, impl } = captureFetch();
    const dataDir = tempDataDir();
    const store = createPromptStore({ dataDir });
    const composer = createHaikuNotesComposer({
      apiKey: 'test-key',
      fetchImpl: impl,
      instructions: () => store.read('meeting-notes'),
    });
    // Saved AFTER the composer was built — which is the whole promise the
    // Save button makes: the next call uses this.
    store.write(
      'meeting-notes',
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
