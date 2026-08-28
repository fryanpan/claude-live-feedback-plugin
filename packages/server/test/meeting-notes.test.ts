/**
 * Pause-driven notes ticks: the quiet threshold, the delta each tick
 * carries, the composer seam, and the whole pipeline through the real
 * server's audio socket.
 *
 * Every timer is the injected manual scheduler — no test here waits for
 * real quiet, for the same reason the mock engine advances per chunk
 * instead of per second: the thing under test is a sequence, not a clock.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  meetingSocketPath,
  prose,
} from '@feedback/core';
import {
  type NotesComposeInput,
  type NotesComposer,
  type NotesTick,
  type NotesUpdate,
  type TickScheduler,
  beginNotesSession,
  createPauseTicker,
  createStubNotesComposer,
} from '../src/meeting-notes.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { createMockTranscriptionEngine } from '../src/transcribe.ts';

/**
 * A scheduler the test advances by hand. `fire()` runs whatever is armed —
 * the ticker keeps at most one timer, and re-arming replaces it.
 */
class ManualScheduler implements TickScheduler {
  private fns = new Map<number, () => void>();
  private n = 0;
  cleared = 0;
  set(fn: () => void, _ms: number): unknown {
    this.n++;
    this.fns.set(this.n, fn);
    return this.n;
  }
  clear(handle: unknown): void {
    if (this.fns.delete(handle as number)) this.cleared++;
  }
  get armed(): number {
    return this.fns.size;
  }
  fire(): void {
    const pending = [...this.fns.values()];
    this.fns.clear();
    for (const fn of pending) fn();
  }
}

describe('pause ticker', () => {
  const setup = (quietMs = 1000) => {
    const schedule = new ManualScheduler();
    const ticks: NotesTick[] = [];
    const ticker = createPauseTicker({ quietMs, schedule, onTick: (t) => ticks.push(t) });
    return { schedule, ticks, ticker };
  };

  it('quiet after settled turns emits one tick carrying exactly those turns', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'we should', final: false });
    ticker.onTurn({ turn: 0, text: 'We should measure first.', final: true });
    ticker.onTurn({ turn: 1, text: 'Agreed.', final: true });
    expect(ticks).toEqual([]); // no tick until the quiet elapses
    schedule.fire();
    expect(ticks).toEqual([
      {
        tick: 1,
        reason: 'pause',
        turns: [
          { turn: 0, text: 'We should measure first.' },
          { turn: 1, text: 'Agreed.' },
        ],
      },
    ]);
  });

  it('a partial re-arms the quiet timer: speech in progress is not a pause', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Done.', final: true });
    const clearedBefore = schedule.cleared;
    ticker.onTurn({ turn: 1, text: 'but', final: false });
    // The armed timer was replaced, not left running from the final.
    expect(schedule.cleared).toBe(clearedBefore + 1);
    expect(schedule.armed).toBe(1);
    expect(ticks).toEqual([]);
    schedule.fire();
    expect(ticks.length).toBe(1);
  });

  it('quiet with no new settled turns emits nothing', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Ship it.', final: true });
    schedule.fire();
    expect(ticks.length).toBe(1);
    // More quiet, nothing new said: no empty tick.
    ticker.onTurn({ turn: 1, text: 'um', final: false });
    schedule.fire();
    expect(ticks.length).toBe(1);
  });

  it('a turn settled twice lands in the delta once', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Once.', final: true });
    ticker.onTurn({ turn: 0, text: 'Once.', final: true });
    schedule.fire();
    expect(ticks[0]?.turns).toEqual([{ turn: 0, text: 'Once.' }]);
  });

  it('end() flushes the tail delta as an end tick, and only once', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'First.', final: true });
    schedule.fire();
    ticker.onTurn({ turn: 1, text: 'Last words.', final: true });
    ticker.end();
    ticker.end();
    expect(ticks.length).toBe(2);
    expect(ticks[1]).toEqual({
      tick: 2,
      reason: 'end',
      turns: [{ turn: 1, text: 'Last words.' }],
    });
    // Nothing armed survives the end.
    expect(schedule.armed).toBe(0);
  });

  it('end() with nothing pending emits nothing', () => {
    const { ticks, ticker } = setup();
    ticker.end();
    expect(ticks).toEqual([]);
  });
});

describe('stub notes composer', () => {
  const tick: NotesTick = {
    tick: 1,
    reason: 'pause',
    turns: [
      { turn: 0, text: 'The sync is the bottleneck.' },
      { turn: 1, text: 'Measure before rewriting.' },
    ],
  };
  const input: NotesComposeInput = {
    docId: 'doc-a',
    meetingId: 'm-doc-a-1',
    tick,
    previous: null,
  };

  it('is deterministic: the same input composes the same notes', async () => {
    const composer = createStubNotesComposer();
    const a = await composer.compose(input);
    const b = await composer.compose(input);
    expect(a).toBe(b);
    expect(a).toContain('The sync is the bottleneck.');
  });

  it('grows previous notes instead of restating from nothing', async () => {
    const composer = createStubNotesComposer();
    const first = await composer.compose(input);
    const second = await composer.compose({
      ...input,
      previous: first,
      tick: { tick: 2, reason: 'pause', turns: [{ turn: 2, text: 'Agreed.' }] },
    });
    expect(second.startsWith(first)).toBe(true);
    expect(second).toContain('Agreed.');
  });
});

describe('notes session', () => {
  const ids = { docId: 'doc-b', meetingId: 'm-doc-b-1' };

  it('composes each tick in order, chaining previous notes through', async () => {
    const schedule = new ManualScheduler();
    const updates: NotesUpdate[] = [];
    const inputs: NotesComposeInput[] = [];
    // Resolves out of band so ordering is the chain's doing, not luck.
    const composer: NotesComposer = {
      name: 'slow-stub',
      async compose(input) {
        inputs.push(input);
        await new Promise((r) => setTimeout(r, 5));
        return `notes after tick ${input.tick.tick}`;
      },
    };
    const session = beginNotesSession(
      { composer, quietMs: 1000, schedule, onNotes: (u) => updates.push(u) },
      ids,
    );
    session.onTurn({ turn: 0, text: 'First.', final: true });
    schedule.fire();
    session.onTurn({ turn: 1, text: 'Second.', final: true });
    await session.end();
    expect(updates.map((u) => u.notes)).toEqual(['notes after tick 1', 'notes after tick 2']);
    expect(inputs[0]?.previous).toBeNull();
    expect(inputs[1]?.previous).toBe('notes after tick 1');
    expect(updates[1]?.tick.reason).toBe('end');
    expect(updates.every((u) => u.docId === ids.docId && u.meetingId === ids.meetingId)).toBe(true);
  });

  it('a failed compose reports the error and carries its words into the next tick', async () => {
    const schedule = new ManualScheduler();
    const updates: NotesUpdate[] = [];
    const errors: string[] = [];
    let failures = 1;
    const composer: NotesComposer = {
      name: 'flaky-stub',
      compose(input) {
        if (failures-- > 0) return Promise.reject(new Error('composer refused'));
        return Promise.resolve(input.tick.turns.map((t) => t.text).join(' | '));
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        onNotes: (u) => updates.push(u),
        onError: (m) => errors.push(m),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Lost?', final: true });
    schedule.fire();
    await Promise.resolve();
    session.onTurn({ turn: 1, text: 'Found.', final: true });
    await session.end();
    expect(errors).toEqual(['composer refused']);
    expect(updates.length).toBe(1);
    // The failed tick's words rode the next one — nothing dropped.
    expect(updates[0]?.notes).toBe('Lost? | Found.');
  });

  it('words held by a failure with no later pause still compose at end()', async () => {
    const schedule = new ManualScheduler();
    const updates: NotesUpdate[] = [];
    let failures = 1;
    const composer: NotesComposer = {
      name: 'flaky-stub',
      compose(input) {
        if (failures-- > 0) return Promise.reject(new Error('composer refused'));
        return Promise.resolve(input.tick.turns.map((t) => t.text).join(' | '));
      },
    };
    const session = beginNotesSession(
      { composer, quietMs: 1000, schedule, onNotes: (u) => updates.push(u) },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Almost lost.', final: true });
    schedule.fire();
    await session.end();
    expect(updates.length).toBe(1);
    expect(updates[0]?.notes).toBe('Almost lost.');
    expect(updates[0]?.tick.reason).toBe('end');
  });

  it('hands the project context through to the composer untouched', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const composer: NotesComposer = {
      name: 'spy-stub',
      compose(input) {
        inputs.push(input);
        return Promise.resolve('n');
      },
    };
    const context = { repoRoot: '/repo', docPaths: ['docs/product/vision.md'] };
    const session = beginNotesSession(
      { composer, quietMs: 1000, schedule, context, onNotes: () => {} },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Hi.', final: true });
    await session.end();
    expect(inputs[0]?.context).toEqual(context);
  });
});

describe('notes through the audio socket', () => {
  let handle: ServerHandle;
  let dataDir: string;
  const schedule = new ManualScheduler();
  const updates: NotesUpdate[] = [];
  /** What the composer was HANDED — the server resolves context per meeting. */
  const composed: NotesComposeInput[] = [];

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-notes-'));
    const stub = createStubNotesComposer();
    handle = createServer({
      port: 0,
      dataDir,
      transcription: createMockTranscriptionEngine(),
      meetingNotes: {
        composer: {
          name: stub.name,
          compose(input) {
            composed.push(input);
            return stub.compose(input);
          },
        },
        quietMs: 1000,
        schedule,
        onNotes: (u) => updates.push(u),
      },
    });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a real meeting pauses into a tick and flushes the tail at stop', async () => {
    const base = `http://localhost:${handle.port}`;
    const path = join(dataDir, 'planning.md');
    writeFileSync(path, '# planning\n');
    const res = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'planning', sourceUrl: path, title: 'planning' }),
    });
    expect(res.status).toBe(200);

    const ws = new WebSocket(`ws://localhost:${handle.port}${meetingSocketPath('planning')}`);
    ws.binaryType = 'arraybuffer';
    const frames: { type: string; final?: boolean; text?: string }[] = [];
    ws.addEventListener('message', (ev) => {
      frames.push(JSON.parse(ev.data as string) as (typeof frames)[number]);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('audio socket refused')));
    });
    const waitFor = async (pred: () => boolean, what: string): Promise<void> => {
      const deadline = Date.now() + 2000;
      while (!pred()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    ws.send(
      JSON.stringify({
        type: 'start',
        sampleRate: MEETING_SAMPLE_RATE,
        encoding: MEETING_AUDIO_ENCODING,
      }),
    );
    await waitFor(() => frames.some((f) => f.type === 'ready'), 'ready');
    // Seven chunks settle the mock's first turn (six words, then the settle).
    for (let i = 0; i < 7; i++) ws.send(new Uint8Array(640));
    await waitFor(() => frames.some((f) => f.type === 'transcript' && f.final), 'a settled turn');
    schedule.fire(); // the speaker goes quiet
    await waitFor(() => updates.length === 1, 'the pause tick');
    expect(updates[0]?.tick.reason).toBe('pause');
    expect(updates[0]?.notes).toContain('So the sync is the bottleneck.');

    // Half the second turn, then stop mid-sentence: the tail still composes.
    for (let i = 0; i < 3; i++) ws.send(new Uint8Array(640));
    ws.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => frames.some((f) => f.type === 'stopped'), 'stopped');
    await waitFor(() => updates.length === 2, 'the end tick');
    expect(updates[1]?.tick.reason).toBe('end');
    expect(updates[1]?.notes).toContain(updates[0]?.notes ?? '@@');
    ws.close();
  });

  it('the composed notes are IN the doc, as a replaceable named section', () => {
    const room = handle.rooms.get('planning');
    expect(room).toBeDefined();
    const md = prose.serializeFragmentToMarkdown(prose.getProseFragment(room!.ydoc));
    // The end tick's notes replaced the pause tick's — one section, current.
    expect(md.split('## Meeting notes').length).toBe(2);
    expect(md).toContain('So the sync is the bottleneck.');
    expect(md).toContain('# planning'); // the doc's own content survived
  });

  it('the composer was handed the doc as context, not a bare transcript', () => {
    expect(composed.length).toBeGreaterThan(0);
    expect(composed[0]?.context?.docTitle).toBe('planning');
  });
});
