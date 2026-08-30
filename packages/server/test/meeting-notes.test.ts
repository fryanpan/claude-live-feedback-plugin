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
  type NotesRelabel,
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

  it("carries the engine's speaker label on a settled turn", () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Take it?', final: true, speaker: 'A' });
    ticker.onTurn({ turn: 1, text: 'Sure.', final: true });
    schedule.fire();
    expect(ticks[0]?.turns).toEqual([
      { turn: 0, text: 'Take it?', speaker: 'A' },
      { turn: 1, text: 'Sure.' },
    ]);
  });

  it('a revision relabels a turn still waiting to compose', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Take it?', final: true, speaker: 'A' });
    // The end-of-session pass changed its mind before the pause ever fired.
    ticker.onTurn({ turn: 0, text: 'Take it?', final: true, speaker: 'B' });
    // And can take the label away entirely, on turn 1.
    ticker.onTurn({ turn: 1, text: 'Sure.', final: true, speaker: 'C' });
    ticker.onTurn({ turn: 1, text: 'Sure.', final: true });
    schedule.fire();
    // Still one turn each — a revision revises, it never duplicates.
    expect(ticks[0]?.turns).toEqual([
      { turn: 0, text: 'Take it?', speaker: 'B' },
      { turn: 1, text: 'Sure.' },
    ]);
  });

  it('a revision of a turn already composed does not re-emit it', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Take it?', final: true, speaker: 'A' });
    schedule.fire();
    ticker.onTurn({ turn: 0, text: 'Take it?', final: true, speaker: 'B' });
    schedule.fire();
    // Those words are already in the doc under 'A'; the revision has nowhere
    // to land, and must not compose the same turn a second time.
    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.turns).toEqual([{ turn: 0, text: 'Take it?', speaker: 'A' }]);
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

  it('the composer sees speakers by the names given so far, and "Speaker A" until then', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const composer: NotesComposer = {
      name: 'capture',
      compose(input) {
        inputs.push(input);
        return Promise.resolve('notes');
      },
    };
    const session = beginNotesSession(
      { composer, quietMs: 1000, schedule, onNotes: () => {} },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Take it?', final: true, speaker: 'A' });
    session.onTurn({ turn: 1, text: 'Sure.', final: true, speaker: 'B' });
    session.nameSpeaker('A', 'Jordan');
    schedule.fire();
    // The compose runs on the chain's microtask; let it read the names as
    // they stand BEFORE the second one lands, so only later ticks read Sam.
    await new Promise((r) => setTimeout(r, 0));
    session.nameSpeaker('B', 'Sam');
    session.onTurn({ turn: 2, text: 'By Thursday.', final: true, speaker: 'B' });
    await session.end();
    expect(inputs.map((i) => i.tick.turns.map((t) => t.speaker))).toEqual([
      ['Jordan', 'Speaker B'],
      ['Sam'],
    ]);
  });

  it('naming a voice rewrites the notes already composed, and what the composer remembers', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const relabels: NotesRelabel[] = [];
    const composer: NotesComposer = {
      name: 'capture',
      compose(input) {
        inputs.push(input);
        // A composer that appends, so tick 2's notes carry tick 1's text —
        // the shape that makes a stale label visible.
        const line = input.tick.turns.map((t) => `- ${t.speaker}: ${t.text}`).join('\n');
        return Promise.resolve([input.previous, line].filter(Boolean).join('\n'));
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onRelabel: (r) => relabels.push(r),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Take it?', final: true, speaker: 'B' });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    // The notes now say "Speaker B" and the doc has them.
    expect(inputs[0]?.tick.turns[0]?.speaker).toBe('Speaker B');

    session.nameSpeaker('B', 'Marisol');
    session.onTurn({ turn: 1, text: 'By Thursday.', final: true, speaker: 'B' });
    schedule.fire();
    await session.end();

    // The sink was told exactly what to change, in the words the composer
    // had written — not the raw engine label.
    expect(relabels).toEqual([
      { docId: ids.docId, meetingId: ids.meetingId, from: 'Speaker B', to: 'Marisol' },
    ]);
    // And the session's memory of what it wrote was rewritten too, so the
    // next compose never sees the placeholder come back.
    expect(inputs[1]?.previous).toBe('- Marisol: Take it?');
    expect(inputs[1]?.previous).not.toContain('Speaker B');
  });

  it('a rename during a compose lands after it, not under it', async () => {
    // The compose in flight read `previous` before the rename and will
    // return notes written the old way. The rewrite has to be queued behind
    // it — ahead of it, the compose would put the placeholder straight back.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const relabels: NotesRelabel[] = [];
    const order: string[] = [];
    const composer: NotesComposer = {
      name: 'slow',
      async compose(input) {
        inputs.push(input);
        await new Promise((r) => setTimeout(r, 10));
        order.push('composed');
        return `${input.previous ? `${input.previous}\n` : ''}- ${input.tick.turns[0]?.speaker}: said it`;
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onRelabel: (r) => {
          order.push('relabelled');
          relabels.push(r);
        },
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'One.', final: true, speaker: 'A' });
    schedule.fire();
    // Let the chained compose actually START — a rename before that point is
    // the documented case where the name reaches the tick itself, which is a
    // different behaviour and would not test the queue at all.
    await new Promise((r) => setTimeout(r, 0));
    // Renamed while the 10ms compose is still running.
    session.nameSpeaker('A', 'Devi');
    await session.end();

    expect(order).toEqual(['composed', 'relabelled']);
    expect(relabels).toEqual([
      { docId: ids.docId, meetingId: ids.meetingId, from: 'Speaker A', to: 'Devi' },
    ]);
    // The compose that was in flight wrote "Speaker A"; the rewrite behind
    // it corrected the memory, so a later tick starts from the name.
    expect(inputs[0]?.tick.turns[0]?.speaker).toBe('Speaker A');
    session.onTurn({ turn: 1, text: 'Two.', final: true, speaker: 'A' });
  });

  it('correcting a name already given rewrites from that name, not from the label', async () => {
    const schedule = new ManualScheduler();
    const relabels: NotesRelabel[] = [];
    const composer: NotesComposer = {
      name: 'capture',
      compose: (input) =>
        Promise.resolve(`- ${input.tick.turns[0]?.speaker}: ${input.tick.turns[0]?.text}`),
    };
    const session = beginNotesSession(
      { composer, quietMs: 1000, schedule, onNotes: () => {}, onRelabel: (r) => relabels.push(r) },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Hello.', final: true, speaker: 'A' });
    session.nameSpeaker('A', 'Devi');
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    session.nameSpeaker('A', 'Devi Raman');
    await session.end();
    expect(relabels.map((r) => `${r.from}->${r.to}`)).toEqual([
      'Speaker A->Devi',
      'Devi->Devi Raman',
    ]);
  });

  it('refuses to rewrite when two voices share the name, rather than reattributing one', async () => {
    // Two people called Alex. "Alex" in the notes already written does not
    // say WHICH of them, so correcting one must not move the other's words.
    const schedule = new ManualScheduler();
    const relabels: NotesRelabel[] = [];
    const errors: string[] = [];
    const session = beginNotesSession(
      {
        composer: { name: 'x', compose: () => Promise.resolve('- Alex: both of them') },
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onRelabel: (r) => relabels.push(r),
        onError: (m) => errors.push(m),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'One.', final: true, speaker: 'A' });
    session.onTurn({ turn: 1, text: 'Two.', final: true, speaker: 'B' });
    session.nameSpeaker('A', 'Alex');
    session.nameSpeaker('B', 'Alex');
    // Correcting one of the two Alexes.
    session.nameSpeaker('A', 'Sam');
    await session.end();
    // The two naming steps went through — each was unambiguous when made.
    // The correction did not: nothing after "Speaker B -> Alex" is emitted.
    expect(relabels.map((r) => `${r.from}->${r.to}`)).toEqual([
      'Speaker A->Alex',
      'Speaker B->Alex',
    ]);
    expect(errors.join(' ')).toContain('more than one voice');
  });

  it('an unnamed voice counts as a voice when deciding the name is ambiguous', async () => {
    // B is unnamed, so it reads as "Speaker B". Someone types "Speaker B" as
    // A's name, then corrects it: the notes' "Speaker B" is now two voices,
    // and the `names` map alone would not have noticed.
    const schedule = new ManualScheduler();
    const relabels: NotesRelabel[] = [];
    const errors: string[] = [];
    const session = beginNotesSession(
      {
        composer: { name: 'x', compose: () => Promise.resolve('notes') },
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onRelabel: (r) => relabels.push(r),
        onError: (m) => errors.push(m),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'One.', final: true, speaker: 'A' });
    session.onTurn({ turn: 1, text: 'Two.', final: true, speaker: 'B' });
    session.nameSpeaker('A', 'Speaker B');
    session.nameSpeaker('A', 'Sam');
    await session.end();
    expect(relabels.map((r) => `${r.from}->${r.to}`)).toEqual(['Speaker A->Speaker B']);
    expect(errors.join(' ')).toContain('more than one voice');
  });

  it('an unrelated named voice does not make a rename ambiguous', async () => {
    // The positive control for the two tests above: without it, a guard that
    // refused every rename would pass both of them.
    const schedule = new ManualScheduler();
    const relabels: NotesRelabel[] = [];
    const errors: string[] = [];
    const session = beginNotesSession(
      {
        composer: { name: 'x', compose: () => Promise.resolve('notes') },
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onRelabel: (r) => relabels.push(r),
        onError: (m) => errors.push(m),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'One.', final: true, speaker: 'A' });
    session.onTurn({ turn: 1, text: 'Two.', final: true, speaker: 'B' });
    session.nameSpeaker('B', 'Rin');
    session.nameSpeaker('A', 'Sam');
    await session.end();
    expect(relabels.map((r) => `${r.from}->${r.to}`)).toEqual(['Speaker B->Rin', 'Speaker A->Sam']);
    expect(errors).toEqual([]);
  });

  it('renaming a voice to what it is already called changes nothing', async () => {
    const relabels: NotesRelabel[] = [];
    const session = beginNotesSession(
      {
        composer: { name: 'x', compose: () => Promise.resolve('notes') },
        quietMs: 1000,
        schedule: new ManualScheduler(),
        onNotes: () => {},
        onRelabel: (r) => relabels.push(r),
      },
      ids,
    );
    session.nameSpeaker('A', 'Speaker A');
    await session.end();
    expect(relabels).toEqual([]);
  });

  it('the stub composer writes the speaker before the words', async () => {
    const notes = await createStubNotesComposer().compose({
      docId: 'd',
      meetingId: 'm',
      tick: {
        tick: 1,
        reason: 'pause',
        turns: [
          { turn: 0, text: 'Take it?', speaker: 'Jordan' },
          { turn: 1, text: 'Sure.' },
        ],
      },
      previous: null,
    });
    expect(notes).toBe('## Notes\n- Jordan: Take it?\n- Sure.');
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

describe('task capture riding the notes session', () => {
  const ids = { docId: 'doc-c', meetingId: 'm-doc-c-1' };

  it('runs per tick and sees the settled words', async () => {
    const schedule = new ManualScheduler();
    const captured: Array<{ docId: string; turns: string[] }> = [];
    const session = beginNotesSession(
      {
        composer: createStubNotesComposer(),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        captureTasks: (input) => {
          captured.push({ docId: input.docId, turns: input.turns.map((t) => t.text) });
          return Promise.resolve([]);
        },
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'We should file a ticket for the strip.', final: true });
    schedule.fire();
    await session.end();
    expect(captured).toEqual([
      { docId: 'doc-c', turns: ['We should file a ticket for the strip.'] },
    ]);
  });

  it('links reach the composer, and a capture failure costs links, not notes', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const errors: string[] = [];
    const updates: NotesUpdate[] = [];
    const composer: NotesComposer = {
      name: 'recording-stub',
      compose(input) {
        inputs.push(input);
        return Promise.resolve(`notes ${input.tick.tick}`);
      },
    };
    let calls = 0;
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        onNotes: (u) => updates.push(u),
        onError: (m) => errors.push(m),
        captureTasks: () => {
          calls++;
          if (calls === 1) {
            return Promise.resolve([
              { title: 'Strip overlaps navbar', url: '/workspaces/w-b?task=t-9', status: 'todo' },
            ]);
          }
          return Promise.reject(new Error('capture refused'));
        },
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'File a ticket for the strip.', final: true });
    schedule.fire();
    await Promise.resolve();
    session.onTurn({ turn: 1, text: 'Moving on.', final: true });
    await session.end();
    // Tick 1 carried its captured link into the compose input.
    expect(inputs[0]?.taskLinks).toEqual([
      { title: 'Strip overlaps navbar', url: '/workspaces/w-b?task=t-9', status: 'todo' },
    ]);
    // Tick 2's capture failed: the notes still composed, linkless, and the
    // failure was reported rather than swallowed.
    expect(inputs[1]?.taskLinks).toBeUndefined();
    expect(updates.map((u) => u.notes)).toEqual(['notes 1', 'notes 2']);
    expect(errors).toEqual(['capture refused']);
  });
});
