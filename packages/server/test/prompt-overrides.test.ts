/**
 * A saved prompt reaches the model — asserted on the REQUEST BODY, not on
 * what the store returned.
 *
 * "The store gave back the new words" is the cheap half and it is already
 * covered next door. What this file pins is the wiring for each of the four
 * server-scoped prompts that are editable: the words a reader typed are the
 * `system` field of the call that actually goes out, and they get there
 * WITHOUT the process restarting — every store here is written to after the
 * caller was built, which is the promise the Save button makes.
 *
 * The notetaking instructions have this same test in
 * `notes-prompt-store.test.ts`, where the composer's own harness already
 * lives; the other three are here.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_TASK_CAPTURE_SYSTEM,
  buildTaskCapturePrompt,
} from '../src/meeting-capture-prompt.ts';
import { NOTE_ASK_SYSTEM, haikuNoteAskJudge } from '../src/note-ask-judge.ts';
import { createPromptStore } from '../src/prompt-store.ts';
import { DEFAULT_VOICE_SYSTEM, buildVoicePrompt } from '../src/voice-prompt.ts';

const dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-prompt-override-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An HTTP seam that records what was sent and answers plausibly. */
function captureFetch(reply: string): {
  bodies: Array<Record<string, unknown>>;
  impl: typeof fetch;
} {
  const bodies: Array<Record<string, unknown>> = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ content: [{ text: reply }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { bodies, impl };
}

describe('the meeting-capture instructions', () => {
  const input = {
    turns: [{ turn: 0, text: 'File a ticket for the export dialog.' }],
    candidates: [],
  };

  it('are the shipped words when nothing overrides them', () => {
    expect(buildTaskCapturePrompt(input).system).toBe(DEFAULT_TASK_CAPTURE_SYSTEM);
  });

  it('are whatever was saved, read at tick time', () => {
    const store = createPromptStore({ dataDir: dataDir() });
    const send = (): string => buildTaskCapturePrompt(input, store.read('meeting-capture')).system;
    expect(send()).toBe(DEFAULT_TASK_CAPTURE_SYSTEM);
    store.write('meeting-capture', 'Extract nothing. Answer {"items":[]}.');
    expect(send()).toBe('Extract nothing. Answer {"items":[]}.');
    // And the transcript still rides in the USER half, so an override does
    // not cost the speech the call was made about.
    expect(buildTaskCapturePrompt(input, store.read('meeting-capture')).user).toContain(
      'export dialog',
    );
  });
});

describe('the voice router prompt', () => {
  const index = { goals: [], tasks: [], docIds: [] };

  it('is the shipped words when nothing overrides them', () => {
    expect(buildVoicePrompt(index, 'open the export ticket').system).toBe(DEFAULT_VOICE_SYSTEM);
  });

  it('is whatever was saved, read per utterance', () => {
    const store = createPromptStore({ dataDir: dataDir() });
    store.write('voice-router', 'Always answer {"kind":"change"}.');
    const built = buildVoicePrompt(
      index,
      'open the export ticket',
      undefined,
      undefined,
      store.read('voice-router'),
    );
    expect(built.system).toBe('Always answer {"kind":"change"}.');
    // The fence and the utterance are in the user half, so an override
    // cannot accidentally remove the "this is DATA" boundary around
    // workspace text — that lives with the content it is fencing.
    expect(built.user).toContain('open the export ticket');
  });
});

describe('the waiting-on-you judge', () => {
  it('sends the shipped words when nothing overrides them', async () => {
    const { bodies, impl } = captureFetch('yes');
    const judge = haikuNoteAskJudge({ apiKey: 'test-key', fetchImpl: impl });
    await judge?.('Waiting on Bryan to pick an option.');
    expect(bodies[0]?.system).toBe(NOTE_ASK_SYSTEM);
  });

  it('sends words saved AFTER it was built, with no restart', async () => {
    const { bodies, impl } = captureFetch('no');
    const store = createPromptStore({ dataDir: dataDir() });
    const judge = haikuNoteAskJudge({
      apiKey: 'test-key',
      fetchImpl: impl,
      system: () => store.read('waiting-on-you'),
    });
    // Built first, edited second — the order the settings page creates.
    store.write('waiting-on-you', 'Answer no to everything.');
    await judge?.('Waiting on Bryan to pick an option.');
    expect(bodies[0]?.system).toBe('Answer no to everything.');
    expect(bodies[0]?.system).not.toBe(NOTE_ASK_SYSTEM);
  });
});
