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
  type NotesCorrection,
  type NotesReattribution,
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
 * A scheduler the test advances by hand. `fire()` runs whatever is armed;
 * `fireAt(ms)` runs only the timer set for that delay, which is how a test
 * says "the speaker never went quiet" while still letting the cadence clock
 * run out. The ticker keeps at most one timer per delay, and re-arming one
 * replaces it.
 */
class ManualScheduler implements TickScheduler {
  private fns = new Map<number, { fn: () => void; ms: number }>();
  private n = 0;
  cleared = 0;
  set(fn: () => void, ms: number): unknown {
    this.n++;
    this.fns.set(this.n, { fn, ms });
    return this.n;
  }
  clear(handle: unknown): void {
    if (this.fns.delete(handle as number)) this.cleared++;
  }
  get armed(): number {
    return this.fns.size;
  }
  /** The live handles for a given delay — identity, so a test can tell a
   *  timer left running from one that was cleared and re-armed. */
  handlesAt(ms: number): number[] {
    return [...this.fns].filter(([, t]) => t.ms === ms).map(([handle]) => handle);
  }
  armedAt(ms: number): number {
    return this.handlesAt(ms).length;
  }
  /**
   * Runs everything armed, SHORTEST DELAY FIRST — a real clock reaches the
   * quiet threshold before the cadence ceiling, and firing in the order the
   * timers happened to be set would let the ceiling win a race it never wins
   * in a meeting.
   */
  fire(): void {
    const pending = [...this.fns.values()].sort((a, b) => a.ms - b.ms);
    this.fns.clear();
    for (const t of pending) t.fn();
  }
  /** Runs only the timers armed for `ms`. Returns how many ran. */
  fireAt(ms: number): number {
    const due = [...this.fns].filter(([, t]) => t.ms === ms);
    for (const [handle] of due) this.fns.delete(handle);
    for (const [, t] of due) t.fn();
    return due.length;
  }
}

describe('pause ticker', () => {
  const QUIET_MS = 1000;
  const CADENCE_MS = 5000;
  const setup = (quietMs = QUIET_MS, cadenceMs = CADENCE_MS) => {
    const schedule = new ManualScheduler();
    const ticks: NotesTick[] = [];
    const ticker = createPauseTicker({
      quietMs,
      cadenceMs,
      schedule,
      onTick: (t) => ticks.push(t),
    });
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
    // The armed quiet timer was replaced, not left running from the final.
    expect(schedule.cleared).toBe(clearedBefore + 1);
    expect(schedule.armedAt(QUIET_MS)).toBe(1);
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

  it('nobody pauses: the cadence fires while the quiet countdown is still being pushed back', () => {
    const { schedule, ticks, ticker } = setup();
    // A continuous stretch of speech: every settled sentence is followed by
    // the next one's partial, so the quiet countdown is replaced before it
    // can ever elapse. This is the meeting that produced nothing until it
    // ended.
    ticker.onTurn({ turn: 0, text: 'we should measure', final: false });
    ticker.onTurn({ turn: 0, text: 'We should measure first.', final: true });
    ticker.onTurn({ turn: 1, text: 'and then decide', final: false });
    ticker.onTurn({ turn: 1, text: 'And then decide.', final: true });
    ticker.onTurn({ turn: 2, text: 'the numbers say', final: false });
    expect(ticks).toEqual([]);
    // The quiet timer is still armed and is deliberately never fired here.
    expect(schedule.armedAt(QUIET_MS)).toBe(1);
    expect(schedule.fireAt(CADENCE_MS)).toBe(1);
    expect(ticks).toEqual([
      {
        tick: 1,
        reason: 'cadence',
        turns: [
          { turn: 0, text: 'We should measure first.' },
          { turn: 1, text: 'And then decide.' },
        ],
      },
    ]);
  });

  it('a cadence tick carries finished sentences only — the turn still being spoken waits', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Ship the fix.', final: true });
    ticker.onTurn({ turn: 1, text: 'but only once we have', final: false });
    schedule.fireAt(CADENCE_MS);
    // Turn 1 is mid-clause and unpunctuated; it is not a sentence yet.
    expect(ticks[0]?.turns).toEqual([{ turn: 0, text: 'Ship the fix.' }]);
    // It lands whole in the next tick, once the engine settles it.
    ticker.onTurn({ turn: 1, text: 'But only once we have the numbers.', final: true });
    schedule.fireAt(CADENCE_MS);
    expect(ticks[1]?.turns).toEqual([{ turn: 1, text: 'But only once we have the numbers.' }]);
  });

  it('the cadence clock runs from the first unwritten sentence and speech does not reset it', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'One.', final: true });
    const [armed] = schedule.handlesAt(CADENCE_MS);
    expect(armed).toBeDefined();
    // Frames keep arriving. If any of them re-armed the cadence, the handle
    // would change and the oldest sentence's wait would restart — which is
    // the pause timer's bug, not a fix for it.
    ticker.onTurn({ turn: 1, text: 'two', final: false });
    ticker.onTurn({ turn: 1, text: 'Two.', final: true });
    ticker.onTurn({ turn: 2, text: 'three', final: false });
    expect(schedule.handlesAt(CADENCE_MS)).toEqual([armed]);
    expect(ticks).toEqual([]);
  });

  it('a pause tick disarms the cadence, and new words arm a fresh one', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Quiet after this.', final: true });
    const [first] = schedule.handlesAt(CADENCE_MS);
    schedule.fireAt(QUIET_MS);
    expect(ticks.map((t) => t.reason)).toEqual(['pause']);
    // Nothing unwritten is waiting, so no cadence tick is owed.
    expect(schedule.armedAt(CADENCE_MS)).toBe(0);
    expect(schedule.fireAt(CADENCE_MS)).toBe(0);
    expect(ticks.length).toBe(1);
    ticker.onTurn({ turn: 1, text: 'More.', final: true });
    expect(schedule.armedAt(CADENCE_MS)).toBe(1);
    expect(schedule.handlesAt(CADENCE_MS)).not.toEqual([first]);
  });

  it('a partial alone never owes a cadence tick', () => {
    const { schedule, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'still talking', final: false });
    // Nothing has settled, so there is no finished sentence to write and no
    // clock counting down towards an empty tick.
    expect(schedule.armedAt(CADENCE_MS)).toBe(0);
  });

  it('end() leaves no cadence timer armed', () => {
    const { schedule, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'Last words.', final: true });
    expect(schedule.armedAt(CADENCE_MS)).toBe(1);
    ticker.end();
    expect(schedule.armed).toBe(0);
  });

  it('cadence ticks and pause ticks share one numbering', () => {
    const { schedule, ticks, ticker } = setup();
    ticker.onTurn({ turn: 0, text: 'One.', final: true });
    schedule.fireAt(CADENCE_MS);
    ticker.onTurn({ turn: 1, text: 'Two.', final: true });
    schedule.fireAt(QUIET_MS);
    expect(ticks.map((t) => [t.tick, t.reason])).toEqual([
      [1, 'cadence'],
      [2, 'pause'],
    ]);
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
      {
        docId: ids.docId,
        meetingId: ids.meetingId,
        label: 'B',
        from: 'Speaker B',
        to: 'Marisol',
        rewriteUntagged: true,
      },
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
      {
        docId: ids.docId,
        meetingId: ids.meetingId,
        label: 'A',
        from: 'Speaker A',
        to: 'Devi',
        rewriteUntagged: true,
      },
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

  it('narrows to tagged mentions when two voices share the name, rather than reattributing one', async () => {
    // Two people called Alex. The WORDS "Alex" in the notes do not say which
    // of them, so correcting one must not move the other's words — but an
    // inline tag carries the label, so it does say, and it still renames.
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
    // All three go out — including the correction, which the tags can carry.
    expect(relabels.map((r) => `${r.from}->${r.to}`)).toEqual([
      'Speaker A->Alex',
      'Speaker B->Alex',
      'Alex->Sam',
    ]);
    // But the correction is marked: the untagged sweep, which can only match
    // the word "Alex", is switched off for it. The first two were
    // unambiguous when made and keep it.
    expect(relabels.map((r) => r.rewriteUntagged)).toEqual([true, true, false]);
    expect(relabels[2]?.label).toBe('A');
    expect(errors.join(' ')).toContain('only tagged mentions');
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
    expect(relabels.map((r) => `${r.from}->${r.to}`)).toEqual([
      'Speaker A->Speaker B',
      'Speaker B->Sam',
    ]);
    expect(relabels.map((r) => r.rewriteUntagged)).toEqual([true, false]);
    expect(errors.join(' ')).toContain('only tagged mentions');
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
    // The second tick builds on the first. It is asserted through the WORDS
    // rather than through tick 1's exact string: `previous` is now the live
    // section as the doc renders it (heading and all), not the composer's
    // own last reply, so that the person's writing is in front of it.
    expect(updates[1]?.notes).toContain('So the sync is the bottleneck.');
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
        captureIntents: (input) => {
          captured.push({ docId: input.docId, turns: input.turns.map((t) => t.text) });
          return Promise.resolve({ tasks: [], docs: [] });
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

  it('hands each pass the previous tick’s words, under any name given since', async () => {
    // The boundary case: an ask spoken across two ticks. The second pass has
    // to see the first tick's speech or it is reading a pointer with nothing
    // to point at — and it must see it under the name the voice has NOW.
    const schedule = new ManualScheduler();
    const passes: Array<{ turns: string[]; prior: string[] }> = [];
    const session = beginNotesSession(
      {
        composer: createStubNotesComposer(),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        captureIntents: (input) => {
          passes.push({
            turns: input.turns.map((t) => `${t.speaker ?? '?'}: ${t.text}`),
            prior: input.priorTurns.map((t) => `${t.speaker ?? '?'}: ${t.text}`),
          });
          return Promise.resolve({ tasks: [], docs: [] });
        },
      },
      ids,
    );
    session.onTurn({
      turn: 0,
      text: 'That retry loop is the real cost.',
      final: true,
      speaker: 'A',
    });
    schedule.fire();
    await Promise.resolve();
    session.nameSpeaker('A', 'Priya');
    session.onTurn({ turn: 1, text: 'File a ticket for that one.', final: true, speaker: 'A' });
    schedule.fire();
    await session.end();
    expect(passes).toHaveLength(2);
    // Nothing came before the first tick.
    expect(passes[0]?.prior).toEqual([]);
    expect(passes[0]?.turns).toEqual(['Speaker A: That retry loop is the real cost.']);
    // The second pass sees the first tick's line, mapped through the rename
    // that landed in between — raw labels are kept and mapped at use, so the
    // window never reads "Speaker A" beside "Priya" for the same voice.
    expect(passes[1]?.prior).toEqual(['Priya: That retry loop is the real cost.']);
    expect(passes[1]?.turns).toEqual(['Priya: File a ticket for that one.']);
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
        captureIntents: () => {
          calls++;
          if (calls === 1) {
            return Promise.resolve({
              tasks: [
                { title: 'Strip overlaps navbar', url: '/workspaces/w-b?task=t-9', status: 'todo' },
              ],
              docs: [
                {
                  title: 'Huddle 2026-08-24 14:05',
                  url: '/workspaces/w-b/docs/d-h',
                  when: 'last week',
                },
              ],
            });
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
    expect(inputs[0]?.docLinks).toEqual([
      { title: 'Huddle 2026-08-24 14:05', url: '/workspaces/w-b/docs/d-h', when: 'last week' },
    ]);
    // Tick 2's capture failed: the notes still composed, linkless, and the
    // failure was reported rather than swallowed.
    expect(inputs[1]?.taskLinks).toBeUndefined();
    expect(inputs[1]?.docLinks).toBeUndefined();
    expect(updates.map((u) => u.notes)).toEqual(['notes 1', 'notes 2']);
    expect(errors).toEqual(['capture refused']);
  });
});

describe('the composer reads the LIVE section, not only its own last answer', () => {
  const ids = { docId: 'doc-live', meetingId: 'm-live' };

  it('previous is what the doc now says, and the person’s lines are named', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const composer: NotesComposer = {
      name: 'capture',
      compose(input) {
        inputs.push(input);
        return Promise.resolve('## Meeting notes\n\n- composed');
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        readSection: () => ({
          markdown: '## Meeting notes\n\n- composed\n- typed by hand',
          items: ['composed', 'typed by hand'],
          human: ['typed by hand'],
        }),
        onNotes: () => {},
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'First.', final: true });
    schedule.fire();
    session.onTurn({ turn: 1, text: 'Second.', final: true });
    await session.end();
    // Tick one starts clean — a doc's section may still hold the LAST
    // meeting's notes, and no meeting is a continuation of that one.
    expect(inputs[0]?.previous).toBeNull();
    // Tick two reads the doc: not "## Meeting notes\n\n- composed", the
    // composer's own last answer, but the section as it now stands, with the
    // person's line in it and named as theirs.
    expect(inputs[1]?.previous).toBe('## Meeting notes\n\n- composed\n- typed by hand');
    // Human lines are gated with `previous`: on tick one the ones in the
    // section are the last meeting's, and telling a from-scratch compose to
    // reproduce them verbatim would copy them into these notes.
    expect(inputs[0]?.humanNotes).toBeUndefined();
    expect(inputs[1]?.humanNotes).toEqual(['typed by hand']);
  });

  it('the update carries the items the compose READ, for the sink’s race check', async () => {
    const schedule = new ManualScheduler();
    const updates: NotesUpdate[] = [];
    // Reads change between ticks, the way a doc being typed into does.
    const reads = [
      { markdown: 'a', items: ['a'], human: [] as string[] },
      { markdown: 'b', items: ['a', 'b'], human: ['b'] },
    ];
    let call = 0;
    const session = beginNotesSession(
      {
        composer: { name: 's', compose: async () => '## Meeting notes\n\n- n' },
        quietMs: 1000,
        schedule,
        readSection: () => reads[Math.min(call++, reads.length - 1)]!,
        onNotes: (u) => updates.push(u),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'First.', final: true });
    schedule.fire();
    session.onTurn({ turn: 1, text: 'Second.', final: true });
    await session.end();
    expect(updates.map((u) => u.basedOn)).toEqual([['a'], ['a', 'b']]);
  });

  it('a section that cannot be read costs the tick its awareness, never its notes', async () => {
    const schedule = new ManualScheduler();
    const updates: NotesUpdate[] = [];
    const errors: string[] = [];
    const session = beginNotesSession(
      {
        composer: { name: 's', compose: async () => 'notes' },
        quietMs: 1000,
        schedule,
        readSection: () => {
          throw new Error('doc gone');
        },
        onNotes: (u) => updates.push(u),
        onError: (m) => errors.push(m),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'First.', final: true });
    await session.end();
    expect(updates.length).toBe(1);
    expect(updates[0]?.basedOn).toBeUndefined();
    expect(errors).toEqual(['doc gone']);
  });
});

describe('inline speaker tags', () => {
  const ids = { docId: 'doc-tags', meetingId: 'm-tags' };

  /** A composer that returns whatever the test hands it, and records what it
   *  was given. */
  const scripted = (replies: string[], inputs: NotesComposeInput[]): NotesComposer => ({
    name: 'scripted',
    compose(input) {
      inputs.push(input);
      return Promise.resolve(replies.shift() ?? '## Meeting notes');
    },
  });

  it('hands the composer the label beside the name, so it can tag the mention', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const session = beginNotesSession(
      { composer: scripted([], inputs), quietMs: 1000, schedule, onNotes: () => {} },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    await session.end();
    expect(inputs[0]?.tick.turns[0]).toMatchObject({
      speaker: 'Speaker B',
      speakerLabel: 'B',
    });
  });

  it('a turn with no voice carries no label either', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const session = beginNotesSession(
      { composer: scripted([], inputs), quietMs: 1000, schedule, onNotes: () => {} },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true });
    await session.end();
    expect(inputs[0]?.tick.turns[0]?.speakerLabel).toBeUndefined();
    expect(inputs[0]?.tick.turns[0]?.speaker).toBeUndefined();
  });

  it('re-renders a tag from the name map rather than trusting the model to spell it', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const updates: NotesUpdate[] = [];
    const session = beginNotesSession(
      {
        composer: scripted(
          ['## Meeting notes\n\n- [@speaker b](speaker:B) wants the gate moved.'],
          inputs,
        ),
        quietMs: 1000,
        schedule,
        onNotes: (u) => updates.push(u),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    await session.end();
    expect(updates[0]?.notes).toContain('[@Speaker B](speaker:B?t=0) wants the gate moved.');
  });

  it('unwraps a tag naming a voice the meeting never carried, and says so', async () => {
    // The deterministic gate on a model-made claim. The words stay; the
    // attribution — the only part that was invented — goes.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const updates: NotesUpdate[] = [];
    const errors: string[] = [];
    const session = beginNotesSession(
      {
        composer: scripted(
          ['## Meeting notes\n\n- [@Priya](speaker:C) volunteered to run it.'],
          inputs,
        ),
        quietMs: 1000,
        schedule,
        onNotes: (u) => updates.push(u),
        onError: (m) => errors.push(m),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Somebody should run it.', final: true, speaker: 'B' });
    await session.end();
    expect(updates[0]?.notes).toContain('- Priya volunteered to run it.');
    expect(updates[0]?.notes).not.toContain('speaker:C');
    expect(errors.join(' ')).toContain('no such voice');
  });

  it('a tag survives the round trip into the next compose', async () => {
    // The positive control for the gate above: a tag for a voice the meeting
    // DID carry is left alone, so `previous` still carries the attribution.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const session = beginNotesSession(
      {
        composer: scripted(
          [
            '## Meeting notes\n\n- [@Speaker B](speaker:B) wants the gate moved.',
            '## Meeting notes\n\n- [@Speaker B](speaker:B) wants the gate moved, by Friday.',
          ],
          inputs,
        ),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    session.onTurn({ turn: 1, text: 'By Friday.', final: true, speaker: 'B' });
    await session.end();
    expect(inputs[1]?.previous).toContain('[@Speaker B](speaker:B?t=0)');
  });

  it('a rename rewrites the tags in the session memory and names the label to the sink', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const relabels: NotesRelabel[] = [];
    const session = beginNotesSession(
      {
        composer: scripted(
          [
            '## Meeting notes\n\n- [@Speaker B](speaker:B) wants the gate moved.',
            '## Meeting notes\n\n- more',
          ],
          inputs,
        ),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onRelabel: (r) => relabels.push(r),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    session.nameSpeaker('B', 'Devi');
    session.onTurn({ turn: 1, text: 'By Friday.', final: true, speaker: 'B' });
    await session.end();

    expect(relabels[0]).toMatchObject({ label: 'B', from: 'Speaker B', to: 'Devi' });
    expect(inputs[1]?.previous).toContain('[@Devi](speaker:B?t=0) wants the gate moved.');
    expect(inputs[1]?.previous).not.toContain('Speaker B');
  });

  it('extends a name in the session memory without saying it twice', async () => {
    // "Devi" survives inside "Devi Raman", so the untagged sweep has to run
    // before the retag rather than after it — otherwise it finds the old name
    // inside the tag the retag has just written. Same order, same reason, as
    // the doc side.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const session = beginNotesSession(
      {
        composer: scripted(
          [
            '## Meeting notes\n\n- [@Devi](speaker:B) wants it. Devi will file it.',
            '## Meeting notes\n\n- more',
          ],
          inputs,
        ),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
      },
      ids,
    );
    session.nameSpeaker('B', 'Devi');
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    session.nameSpeaker('B', 'Devi Raman');
    session.onTurn({ turn: 1, text: 'By Friday.', final: true, speaker: 'B' });
    await session.end();

    expect(inputs[1]?.previous).toContain('[@Devi Raman](speaker:B?t=0) wants it.');
    expect(inputs[1]?.previous).toContain('Devi Raman will file it.');
    expect(inputs[1]?.previous).not.toContain('Raman Raman');
  });

  it('leaves a line the person wrote exactly as they wrote it', async () => {
    // The composer is asked to reproduce their line verbatim and the merge
    // recognises it by exact text. Normalizing a tag inside it would break
    // that match and land a second copy of their own note beside it.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const updates: NotesUpdate[] = [];
    const mine = '[@speaker b](speaker:B) — my own wording';
    const session = beginNotesSession(
      {
        composer: scripted(
          [
            '## Meeting notes\n\n- notes',
            `## Meeting notes\n\n- ${mine}\n- [@speaker b](speaker:B) said it.`,
          ],
          inputs,
        ),
        quietMs: 1000,
        schedule,
        readSection: () => ({
          markdown: `## Meeting notes\n\n- ${mine}`,
          items: [`item ${mine}`],
          human: [mine],
        }),
        onNotes: (u) => updates.push(u),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'One.', final: true, speaker: 'B' });
    schedule.fire();
    await new Promise((r) => setTimeout(r, 0));
    session.onTurn({ turn: 1, text: 'Two.', final: true, speaker: 'B' });
    await session.end();
    expect(updates[1]?.notes).toContain(`- ${mine}`);
    expect(updates[1]?.notes).toContain('- [@Speaker B](speaker:B?t=1) said it.');
  });
});

describe('a tagged meeting through the audio socket', () => {
  let handle: ServerHandle;
  let dataDir: string;
  const schedule = new ManualScheduler();
  const updates: NotesUpdate[] = [];

  /** Two voices, so a rename has something it must NOT touch. */
  const script = [
    { words: ['move', 'the', 'gate'], settled: 'Move the gate.', speaker: 'A' },
    { words: ['not', 'before', 'friday'], settled: 'Not before Friday.', speaker: 'B' },
  ];

  /** Writes one tagged bullet per new turn, the way the real composer is
   *  asked to. Everything downstream of the model is under test here; what
   *  the model would have produced is not. */
  const taggingComposer: NotesComposer = {
    name: 'tagging',
    compose(input) {
      const bullets = input.tick.turns.map(
        (t) => `- [@${t.speaker}](speaker:${t.speakerLabel}) said "${t.text}"`,
      );
      const head = input.previous ?? '## Meeting notes';
      return Promise.resolve([head, ...bullets].join('\n'));
    },
  };

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-tags-'));
    handle = createServer({
      port: 0,
      dataDir,
      transcription: createMockTranscriptionEngine(script),
      meetingNotes: {
        composer: taggingComposer,
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

  it('writes tags into the doc, and a rename moves one voice and not the other', async () => {
    const base = `http://localhost:${handle.port}`;
    const path = join(dataDir, 'huddle.md');
    writeFileSync(path, '# huddle\n');
    const res = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'huddle', sourceUrl: path, title: 'huddle' }),
    });
    expect(res.status).toBe(200);

    const ws = new WebSocket(`ws://localhost:${handle.port}${meetingSocketPath('huddle')}`);
    ws.binaryType = 'arraybuffer';
    const frames: { type: string; final?: boolean; mode?: string }[] = [];
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
    const docMarkdown = (): string =>
      prose.serializeFragmentToMarkdown(prose.getProseFragment(handle.rooms.get('huddle')!.ydoc));

    // A conversation, explicitly. Since #501 diarization is opt-in per
    // capture and solo is the default, so a capture that does not ask gets
    // no speaker labels — and a note with no voice has nothing to tag.
    ws.send(
      JSON.stringify({
        type: 'start',
        sampleRate: MEETING_SAMPLE_RATE,
        encoding: MEETING_AUDIO_ENCODING,
        mode: 'conversation',
      }),
    );
    await waitFor(() => frames.some((f) => f.type === 'ready'), 'ready');
    // The mode the SERVER opened, not the one asked for: every tag below is
    // only meaningful if diarization actually reached the engine.
    expect(frames.find((f) => f.type === 'ready')?.mode).toBe('conversation');
    // Both turns settle: four chunks each (three words, then the settle).
    for (let i = 0; i < 8; i++) ws.send(new Uint8Array(640));
    await waitFor(
      () => frames.filter((f) => f.type === 'transcript' && f.final).length === 2,
      'both settled turns',
    );
    schedule.fire();
    await waitFor(() => updates.length === 1, 'the pause tick');

    // 1. The notes in the DOC carry a tag per mention, one per voice.
    const tagged = docMarkdown();
    // Each tag also carries the turn it was composed from, which is what a
    // later engine revision of who spoke has to aim at.
    expect(tagged).toContain('[@Speaker A](speaker:A?t=0) said "Move the gate."');
    expect(tagged).toContain('[@Speaker B](speaker:B?t=1) said "Not before Friday."');

    // 2. Naming a voice renames its tags where they already stand — the
    //    label, not the words, is what the rename matched on.
    ws.send(JSON.stringify({ type: 'name_speaker', speaker: 'A', name: 'Dana' }));
    await waitFor(
      () => docMarkdown().includes('[@Dana](speaker:A?t=0)'),
      'the rename to reach the tag already written',
    );
    const renamed = docMarkdown();
    // The rename moved the NAME and left the provenance exactly where it was.
    expect(renamed).toContain('[@Dana](speaker:A?t=0) said "Move the gate."');
    // 3. And the other voice is untouched: it was never this label.
    expect(renamed).toContain('[@Speaker B](speaker:B?t=1) said "Not before Friday."');
    expect(renamed).not.toContain('speaker:A) said "Not before Friday."');

    // 4. THE DISCRIMINATOR. Everything above would also pass on the old
    //    text-only rewrite, because the tag's own text spelled "Speaker A".
    //    So: call the second voice Dana as well, then correct the first to
    //    "Dana Ruiz". Now the words "Dana" name two voices, the untagged
    //    sweep is switched off, and only a rename keyed on the LABEL can
    //    reach anything at all.
    ws.send(JSON.stringify({ type: 'name_speaker', speaker: 'B', name: 'Dana' }));
    await waitFor(
      () => docMarkdown().includes('[@Dana](speaker:B?t=1)'),
      'the second voice to take the same name',
    );
    ws.send(JSON.stringify({ type: 'name_speaker', speaker: 'A', name: 'Dana Ruiz' }));
    await waitFor(
      () => docMarkdown().includes('[@Dana Ruiz](speaker:A?t=0)'),
      'the ambiguous correction to reach the tag it belongs to',
    );
    const corrected = docMarkdown();
    // The other Dana kept her tag. A text sweep for "Dana" would have taken
    // this one too — that it did not is the proof the label did the work.
    expect(corrected).toContain('[@Dana](speaker:B?t=1) said "Not before Friday."');

    ws.send(JSON.stringify({ type: 'stop' }));
    await waitFor(() => frames.some((f) => f.type === 'stopped'), 'stopped');
    ws.close();
  });
});

describe('a spoken correction riding the notes session', () => {
  const ids = { docId: 'doc-fix', meetingId: 'm-doc-fix-1' };

  it('reaches the doc BEFORE the section is read for the compose', async () => {
    // Ordering is the whole design: the note being corrected was written on
    // an earlier tick and is already in the doc, so the correction lands
    // first and this tick's compose reads the corrected words as `previous`.
    // Land it after the compose instead and the composer echoes the old
    // wording back, and the merge has to fight over which one wins.
    const schedule = new ManualScheduler();
    const order: string[] = [];
    const session = beginNotesSession(
      {
        composer: {
          name: 'recording-stub',
          compose: () => {
            order.push('compose');
            return Promise.resolve('## Meeting notes\n\n- noted');
          },
        },
        quietMs: 1000,
        schedule,
        onNotes: () => order.push('write'),
        readSection: () => {
          order.push('read');
          return null;
        },
        captureIntents: () =>
          Promise.resolve({
            tasks: [],
            docs: [],
            corrections: [{ wrong: 'Tuesday', right: 'Thursday' }],
          }),
        onCorrection: (c) => {
          order.push(`correct ${c.wrong}->${c.right}`);
          return 'revised';
        },
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'No, I said Thursday.', final: true });
    schedule.fire();
    await session.end();
    expect(order).toEqual(['correct Tuesday->Thursday', 'read', 'compose', 'write']);
  });

  it('carries the meeting’s ids so the sink knows which doc to correct', async () => {
    const schedule = new ManualScheduler();
    const seen: NotesCorrection[] = [];
    const session = beginNotesSession(
      {
        composer: createStubNotesComposer(),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        captureIntents: () =>
          Promise.resolve({
            tasks: [],
            docs: [],
            corrections: [{ wrong: 'Tuesday', right: 'Thursday' }],
          }),
        onCorrection: (c) => {
          seen.push(c);
          return 'revised';
        },
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'No, I said Thursday.', final: true });
    schedule.fire();
    await session.end();
    expect(seen).toEqual([
      { docId: 'doc-fix', meetingId: 'm-doc-fix-1', wrong: 'Tuesday', right: 'Thursday' },
    ]);
  });

  it('a sink that throws costs the correction, never the tick’s notes', async () => {
    const schedule = new ManualScheduler();
    const updates: NotesUpdate[] = [];
    const errors: string[] = [];
    const session = beginNotesSession(
      {
        composer: createStubNotesComposer(),
        quietMs: 1000,
        schedule,
        onNotes: (u) => updates.push(u),
        onError: (m) => errors.push(m),
        captureIntents: () =>
          Promise.resolve({
            tasks: [],
            docs: [],
            corrections: [{ wrong: 'Tuesday', right: 'Thursday' }],
          }),
        onCorrection: () => {
          throw new Error('doc write refused');
        },
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'No, I said Thursday.', final: true });
    schedule.fire();
    await session.end();
    expect(errors).toContain('doc write refused');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.notes).toContain('No, I said Thursday.');
  });

  it('a pass that returns no corrections asks the sink nothing', async () => {
    const schedule = new ManualScheduler();
    let calls = 0;
    const session = beginNotesSession(
      {
        composer: createStubNotesComposer(),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        captureIntents: () => Promise.resolve({ tasks: [], docs: [] }),
        onCorrection: () => {
          calls++;
          return 'none';
        },
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Ordinary speech about the gate.', final: true });
    schedule.fire();
    await session.end();
    expect(calls).toBe(0);
  });
});

describe('a late speaker correction reaches notes already written', () => {
  const ids = { docId: 'doc-late', meetingId: 'm-late' };

  /** A composer that returns whatever the test hands it, and records what it
   *  was given. */
  const scripted = (replies: string[], inputs: NotesComposeInput[]): NotesComposer => ({
    name: 'scripted',
    compose(input) {
      inputs.push(input);
      return Promise.resolve(replies.shift() ?? '## Meeting notes');
    },
  });

  /** Let the compose chain drain. Every step is a microtask on one promise
   *  chain, so a macrotask turn is enough for all of them. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('moves a mention when the engine revises the only turn behind it', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const corrections: NotesReattribution[] = [];
    const session = beginNotesSession(
      {
        composer: scripted(
          [
            '## Meeting notes\n\n- [@Speaker B](speaker:B) wants the gate moved.',
            '## Meeting notes\n\n- more',
          ],
          inputs,
        ),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onReattribute: (r) => corrections.push(r),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    schedule.fire();
    await settle();

    // The end-of-session pass: turn 0 was C, not B. Same turn id, same
    // words, a different voice — exactly how the adapter re-emits one.
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'C' });
    await settle();

    expect(corrections).toHaveLength(1);
    expect([...corrections[0]!.revisions]).toEqual([[0, 'C']]);

    session.onTurn({ turn: 1, text: 'By Friday.', final: true, speaker: 'C' });
    await session.end();
    // The session's own memory of the notes is corrected too, so the next
    // compose does not put the old voice straight back.
    expect(inputs[1]?.previous).toContain('[@Speaker C](speaker:C?t=0) wants the gate moved.');
    expect(inputs[1]?.previous).not.toContain('speaker:B');
  });

  it('takes the batch as one, so a mention whose turns all moved is moved', async () => {
    // The engine sends ONE SpeakerRevision naming every turn it changed its
    // mind about, and the adapter re-emits them in a synchronous loop.
    // Applying them one at a time would move this mention on the first and
    // then find it disagreeing with itself on the second.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const session = beginNotesSession(
      {
        composer: scripted(
          [
            '## Meeting notes\n\n- [@Speaker B](speaker:B) wants the gate moved.',
            '## Meeting notes\n\n- more',
          ],
          inputs,
        ),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    session.onTurn({ turn: 1, text: 'Before merge.', final: true, speaker: 'B' });
    schedule.fire();
    await settle();
    expect(inputs[0]).toBeDefined();

    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'C' });
    session.onTurn({ turn: 1, text: 'Before merge.', final: true, speaker: 'C' });
    await settle();

    session.onTurn({ turn: 2, text: 'By Friday.', final: true, speaker: 'C' });
    await session.end();
    expect(inputs[1]?.previous).toContain('[@Speaker C](speaker:C?t=0,1) wants the gate moved.');
    expect(inputs[1]?.previous).not.toContain('unsure');
  });

  it('marks what it cannot place, and says so, rather than guessing', async () => {
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const errors: string[] = [];
    const session = beginNotesSession(
      {
        composer: scripted(
          [
            '## Meeting notes\n\n- [@Speaker B](speaker:B) wants the gate moved.',
            '## Meeting notes\n\n- more',
          ],
          inputs,
        ),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onError: (m) => errors.push(m),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    session.onTurn({ turn: 1, text: 'Before merge.', final: true, speaker: 'B' });
    schedule.fire();
    await settle();

    // Only ONE of the two turns behind the mention moved.
    session.onTurn({ turn: 1, text: 'Before merge.', final: true, speaker: 'C' });
    await settle();

    session.onTurn({ turn: 2, text: 'By Friday.', final: true, speaker: 'C' });
    await session.end();
    expect(inputs[1]?.previous).toContain('(speaker:B?t=0,1&unsure=1)');
    expect(errors.join(' ')).toContain('marked unsure');
  });

  it('a turn still waiting on a tick is not a correction at all', async () => {
    // It composes under the new label by itself; nothing in the doc is
    // wrong yet, so nothing needs rewriting.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const corrections: NotesReattribution[] = [];
    const session = beginNotesSession(
      {
        composer: scripted(['## Meeting notes\n\n- one'], inputs),
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onReattribute: (r) => corrections.push(r),
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'C' });
    await session.end();
    expect(corrections).toHaveLength(0);
    expect(inputs[0]?.tick.turns[0]).toMatchObject({ speakerLabel: 'C' });
  });

  it('corrects a compose that was in flight when the revision arrived', async () => {
    // That compose read the old label and will return notes written the old
    // way. The correction is queued behind it on the same chain, so it lands
    // ON those notes rather than under them.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    let release: () => void = () => {};
    const thinking = new Promise<void>((resolve) => {
      release = resolve;
    });
    const composer: NotesComposer = {
      name: 'deferred',
      async compose(input) {
        inputs.push(input);
        if (inputs.length === 1) {
          await thinking;
          return '## Meeting notes\n\n- [@Speaker B](speaker:B) wants the gate moved.';
        }
        return '## Meeting notes\n\n- more';
      },
    };
    const session = beginNotesSession(
      { composer, quietMs: 1000, schedule, onNotes: () => {} },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    schedule.fire();
    await settle();
    expect(inputs).toHaveLength(1);

    // The revision arrives while the first compose is still thinking.
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'C' });
    release();
    await settle();

    session.onTurn({ turn: 1, text: 'By Friday.', final: true, speaker: 'C' });
    await session.end();
    expect(inputs[1]?.previous).toContain('speaker:C?t=0');
    expect(inputs[1]?.previous).not.toContain('speaker:B');
  });

  it('re-labels a carried turn instead of correcting words nobody has read', async () => {
    // The compose FAILED, so those words are not in the doc: they are in
    // `carry`, waiting for another attempt. Rewriting mentions of them would
    // find nothing; taking the new label into the retry is the whole fix.
    const schedule = new ManualScheduler();
    const inputs: NotesComposeInput[] = [];
    const corrections: NotesReattribution[] = [];
    let first = true;
    const composer: NotesComposer = {
      name: 'fails-once',
      compose(input) {
        inputs.push(input);
        if (first) {
          first = false;
          return Promise.reject(new Error('composer down'));
        }
        return Promise.resolve('## Meeting notes\n\n- [@Speaker C](speaker:C) wants the gate.');
      },
    };
    const session = beginNotesSession(
      {
        composer,
        quietMs: 1000,
        schedule,
        onNotes: () => {},
        onReattribute: (r) => corrections.push(r),
        onError: () => {},
      },
      ids,
    );
    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'B' });
    schedule.fire();
    await settle();

    session.onTurn({ turn: 0, text: 'Move the gate.', final: true, speaker: 'C' });
    await settle();
    await session.end();

    expect(corrections).toHaveLength(0);
    // The retry composed the carried turn under the voice the revision gave it.
    expect(inputs[1]?.tick.turns[0]).toMatchObject({ turn: 0, speakerLabel: 'C' });
  });
});
