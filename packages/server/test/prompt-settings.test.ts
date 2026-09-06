/**
 * The prompt settings: the store on disk and the three routes over it.
 *
 * What has to hold, and what each check would fail on:
 *
 *  - A SAVE REACHES THE NEXT CALL. `read` goes to disk every time, so a write
 *    made after the reader was built is what the next call sends. Cache the
 *    file at construction and the first test here fails.
 *  - RESTORE-DEFAULT NEVER DESTROYS. The words being replaced land in
 *    `previous`. Delete the record instead and the history assertion fails.
 *  - THE CAP FITS THE PROMPTS IT PROTECTS. The shipped notetaking
 *    instructions are 5,807 characters and meeting capture 4,594, both over
 *    the 4,000 this product used to enforce. The check walks the CATALOGUE
 *    rather than naming those two, so a prompt that grows past the cap later
 *    fails here rather than in Bryan's editor. Put 4,000 back and it fails.
 *  - READ-ONLY IS READ-ONLY. The thread summary is versioned and every edit
 *    marks ~900 stored summaries stale, so the route refuses the write rather
 *    than the page hiding the button.
 *  - A BOARD PROMPT IS NOT SERVED TWICE. The criteria and the effort prompt
 *    live on a board; asking for them here says so instead of answering with
 *    the shipped default, which would read as a working read of a value this
 *    route cannot see.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TASK_CAPTURE_SYSTEM } from '../src/meeting-capture-prompt.ts';
import { DEFAULT_NOTES_INSTRUCTIONS } from '../src/notes-prompt-store.ts';
import { PROMPT_CATALOG } from '../src/prompt-catalog.ts';
import { PROMPTS_FILENAME, PROMPT_MAX_CHARS, createPromptStore } from '../src/prompt-store.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

const author = { id: 'user-tester', name: 'Robin Vale' };

describe('the prompt store', () => {
  const dirs: string[] = [];
  const dataDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-prompts-'));
    dirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('sends a saved prompt on the very next read, with no restart', () => {
    const store = createPromptStore({ dataDir: dataDir() });
    expect(store.read('meeting-notes')).toBe(DEFAULT_NOTES_INSTRUCTIONS);
    expect(store.write('meeting-notes', 'Two bullets, no more.').ok).toBe(true);
    expect(store.read('meeting-notes')).toBe('Two bullets, no more.');
    expect(store.view('meeting-notes').isDefault).toBe(false);
  });

  it('keeps the old words when the default is restored', () => {
    const dir = dataDir();
    const store = createPromptStore({ dataDir: dir });
    store.write('meeting-notes', 'First wording.', author);
    store.write('meeting-notes', 'Second wording.', author);
    expect(store.write('meeting-notes', null, author).ok).toBe(true);
    expect(store.read('meeting-notes')).toBe(DEFAULT_NOTES_INSTRUCTIONS);
    const file = JSON.parse(readFileSync(join(dir, PROMPTS_FILENAME), 'utf8')) as {
      prompts: Record<string, { value?: string; previous?: Array<{ value: string }> }>;
    };
    const record = file.prompts['meeting-notes'];
    expect(record?.value).toBeUndefined();
    expect(record?.previous?.map((p) => p.value)).toEqual(['First wording.', 'Second wording.']);
  });

  it('refuses an empty prompt and a read-only one', () => {
    const store = createPromptStore({ dataDir: dataDir() });
    expect(store.write('meeting-notes', '   ')).toEqual({ ok: false, error: 'empty' });
    expect(store.write('thread-summary', 'Anything.')).toEqual({ ok: false, error: 'read-only' });
    expect(store.write('review-item-criteria', 'Anything.')).toEqual({
      ok: false,
      error: 'unknown-prompt',
    });
  });

  it('survives a file that is not JSON at all', () => {
    const dir = dataDir();
    Bun.write(join(dir, PROMPTS_FILENAME), '{ this is not json');
    const store = createPromptStore({ dataDir: dir });
    expect(store.read('meeting-notes')).toBe(DEFAULT_NOTES_INSTRUCTIONS);
  });

  /**
   * The cap regression, stated as the thing that actually broke: a prompt
   * this page SHOWS that the page cannot then SAVE. It walks the catalogue
   * rather than naming the two that are over 4,000 today, so a prompt that
   * grows past the cap later fails here instead of in Bryan's editor.
   *
   * The two controls beside it: two of the shipped defaults really are over
   * the old ceiling (or the round-trip proves nothing), and a cap still
   * exists (or "it saves" is not a fact about the cap at all).
   */
  it('round-trips every shipped default, which the old 4,000-char cap did not', () => {
    const editable = PROMPT_CATALOG.filter((p) => p.editable && p.scope === 'server');
    expect(editable.length).toBeGreaterThan(0);
    // Control: without this, a cap of 4,000 would pass the loop below.
    const overOldCap = PROMPT_CATALOG.filter((p) => p.default.length > 4_000).map((p) => p.id);
    expect(overOldCap).toEqual(['meeting-notes', 'meeting-capture']);

    const store = createPromptStore({ dataDir: dataDir() });
    for (const def of editable) {
      expect([def.id, store.write(def.id, def.default).ok]).toEqual([def.id, true]);
      expect(store.read(def.id)).toBe(def.default);
    }
    // Control: the ceiling is a ceiling, not an absence of one.
    expect(store.write('meeting-notes', 'x'.repeat(PROMPT_MAX_CHARS + 1))).toEqual({
      ok: false,
      error: 'too-long',
    });
  });

  it('names every prompt the server actually sends', () => {
    expect(PROMPT_CATALOG.map((p) => p.id)).toEqual([
      'meeting-notes',
      'meeting-capture',
      'thread-summary',
      'review-item-criteria',
      'effort-estimate',
      'waiting-on-you',
      'voice-router',
    ]);
    // Every default is real text, not an empty string somebody forgot to
    // wire — the list is a page of prompts, and an empty row reads as a bug
    // in the prompt rather than in the catalogue.
    for (const def of PROMPT_CATALOG) expect(def.default.length).toBeGreaterThan(100);
  });
});

describe('the prompt routes', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;

  const local = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        host: `localhost:${handle.port}`,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });
  const put = (path: string, body: unknown) =>
    local(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-prompt-routes-'));
    handle = createServer({ port: 0, dataDir });
    base = `http://localhost:${handle.port}`;
  });
  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists the seven with a purpose apiece and no prompt text', async () => {
    const res = await local('/api/prompts');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      prompts: Array<{ id: string; name: string; purpose: string; editable: boolean }>;
    };
    expect(body.prompts).toHaveLength(7);
    for (const row of body.prompts) {
      expect(row.name.length).toBeGreaterThan(0);
      expect(row.purpose.length).toBeGreaterThan(0);
      // The list is metadata. Seven defaults is ~24 KB nobody asked for.
      expect(Object.hasOwn(row, 'default')).toBe(false);
      expect(Object.hasOwn(row, 'value')).toBe(false);
    }
    expect(body.prompts.find((r) => r.id === 'thread-summary')?.editable).toBe(false);
  });

  it('opens one prompt with its words, its default, and no override yet', async () => {
    const res = await local('/api/prompts/meeting-notes');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      value: string;
      isDefault: boolean;
      default: string;
      maxChars: number;
    };
    expect(body.value).toBe(DEFAULT_NOTES_INSTRUCTIONS);
    expect(body.default).toBe(DEFAULT_NOTES_INSTRUCTIONS);
    expect(body.isDefault).toBe(true);
    expect(body.maxChars).toBe(PROMPT_MAX_CHARS);
  });

  it('saves, reads back the words the SERVER holds, and restores', async () => {
    const saved = await put('/api/prompts/meeting-capture', {
      value: 'Only file a ticket when somebody says the word ticket.',
      author,
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ isDefault: false });

    const read = await local('/api/prompts/meeting-capture');
    const body = (await read.json()) as { value: string; isDefault: boolean; default: string };
    expect(body.value).toBe('Only file a ticket when somebody says the word ticket.');
    expect(body.isDefault).toBe(false);
    // The default is still there to compare against, which is what "Show the
    // default" is for on an edited prompt.
    expect(body.default).toBe(DEFAULT_TASK_CAPTURE_SYSTEM);

    const restored = await put('/api/prompts/meeting-capture', { value: null, author });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
      isDefault: true,
      value: DEFAULT_TASK_CAPTURE_SYSTEM,
    });
  });

  it('refuses a read-only prompt, an empty one, and one over the cap', async () => {
    expect((await put('/api/prompts/thread-summary', { value: 'nope', author })).status).toBe(403);
    expect((await put('/api/prompts/voice-router', { value: '  ', author })).status).toBe(400);
    const long = await put('/api/prompts/voice-router', {
      value: 'x'.repeat(PROMPT_MAX_CHARS + 1),
      author,
    });
    expect(long.status).toBe(400);
    expect(((await long.json()) as { message: string }).message).toContain(
      String(PROMPT_MAX_CHARS),
    );
  });

  it('sends a board prompt to the board rather than answering for it', async () => {
    const res = await local('/api/prompts/review-item-criteria');
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('/workspaces/<id>/settings');
    // The address it names has to be one the router can actually serve:
    // matchWorkspaceRoute accepts the bare '/workspaces/' prefix only, so an
    // /api/-prefixed hint sends the caller somewhere that cannot answer.
    expect(body.message).not.toContain('/api/workspaces/');
  });

  it('refuses a write with no author, so nothing is stored unattributed', async () => {
    const res = await put('/api/prompts/voice-router', { value: 'Route everything to the agent.' });
    expect(res.status).toBe(400);
  });

  it('404s an id nothing in the catalogue names', async () => {
    expect((await local('/api/prompts/not-a-prompt')).status).toBe(404);
  });

  /** The page itself: both addresses answer the same shell, so a pasted deep
   *  link opens that prompt instead of a 404. */
  it('serves the settings shell for the list and for one prompt', async () => {
    for (const path of ['/settings', '/settings/prompts', '/settings/prompts/meeting-notes']) {
      const res = await local(path);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="settings-root"');
      expect(html).toContain('settings.js');
    }
  });
});
