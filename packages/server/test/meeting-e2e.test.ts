/**
 * The whole meeting pipeline, end to end through the real server: a scripted
 * meeting with pauses streams over the audio socket, and the doc gains notes
 * AT the pauses and nowhere else — never while speech is in progress, never
 * a partial, never the word an engine correction took back. Then the same
 * doc runs a SECOND meeting, because stop/start is how real meetings go and
 * the recording state, the meeting index, and the notes section all have to
 * come out of it consistent.
 *
 * The engine is the mock (per-chunk, no network), the composer is the stub
 * (deterministic, no network), the quiet timer is the manual scheduler — a
 * pause here is `schedule.fire()`, not elapsed time. Nothing in this file
 * can open a billed session.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CaptureMode,
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  meetingSocketPath,
  prose,
} from '@feedback/core';
import {
  type NotesUpdate,
  type TickScheduler,
  createStubNotesComposer,
} from '../src/meeting-notes.ts';
import { listMeetings, readTranscript } from '../src/meetings.ts';
import { LEGACY_TRANSCRIPT_HEADING } from '../src/notes-section.ts';
import { type ServerHandle, createServer } from '../src/server.ts';
import { type MockScriptTurn, createMockTranscriptionEngine } from '../src/transcribe.ts';
import { seedBoard } from './workspace-seed.ts';

/** Advanced by hand: `fire()` is the speaker going quiet. */
class ManualScheduler implements TickScheduler {
  private fns = new Map<number, () => void>();
  private n = 0;
  set(fn: () => void, _ms: number): unknown {
    this.n++;
    this.fns.set(this.n, fn);
    return this.n;
  }
  clear(handle: unknown): void {
    this.fns.delete(handle as number);
  }
  fire(): void {
    const pending = [...this.fns.values()];
    this.fns.clear();
    for (const fn of pending) fn();
  }
}

/**
 * The meeting script. The "sink" → "sync" correction is the point of turn
 * one: the wrong word is on the strip mid-turn, and the settled turn takes
 * it back — the doc must only ever see what it settled to.
 */
// Two voices, alternating and then returning to the first — so a rename has
// more than one turn to reach, which is the whole claim behind relabelling.
// The labels are the engine's own ('A', 'B', per MeetingServerMessage): the
// word "Speaker" is added by `speakerDisplayName`, never carried on the wire.
const SCRIPT: readonly MockScriptTurn[] = [
  {
    words: ['so', 'the', 'sink', 'is', 'the', 'bottleneck'],
    settled: 'So the sync is the bottleneck.',
    speaker: 'A',
  },
  { words: ['lets', 'measure', 'it'], settled: "Let's measure it first.", speaker: 'B' },
  { words: ['then', 'we', 'decide'], settled: 'Then we decide.', speaker: 'A' },
];

interface ServerFrame {
  type: string;
  [key: string]: unknown;
}

class AudioClient {
  readonly frames: ServerFrame[] = [];
  private constructor(readonly ws: WebSocket) {}

  static async open(wsBase: string, docId: string): Promise<AudioClient> {
    const ws = new WebSocket(`${wsBase}${meetingSocketPath(WS, docId)}`);
    ws.binaryType = 'arraybuffer';
    const client = new AudioClient(ws);
    ws.addEventListener('message', (ev) => {
      client.frames.push(JSON.parse(ev.data as string) as ServerFrame);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('audio socket refused')));
    });
    return client;
  }

  /** Solo by default, exactly like a client that never heard of modes. */
  start(mode: CaptureMode = 'solo'): void {
    this.ws.send(
      JSON.stringify({
        type: 'start',
        sampleRate: MEETING_SAMPLE_RATE,
        encoding: MEETING_AUDIO_ENCODING,
        mode,
      }),
    );
  }

  speak(chunks: number): void {
    for (let i = 0; i < chunks; i++) this.ws.send(new Uint8Array(640));
  }

  stop(): void {
    this.ws.send(JSON.stringify({ type: 'stop' }));
  }

  finals(): ServerFrame[] {
    return this.frames.filter((f) => f.type === 'transcript' && f.final === true);
  }
}

const waitFor = async (pred: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** The board this file's docs, tasks and reviews are filed under. */
let WS = '';

describe('a meeting end to end: pauses become notes, stop/start stays consistent', () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let wsBase: string;
  let docId = '';
  const schedule = new ManualScheduler();
  const updates: NotesUpdate[] = [];

  const docMarkdown = (): string => {
    const doc = handle.docStore.get(docId);
    if (!doc) throw new Error(`no doc for ${docId}`);
    return prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
  };

  /**
   * What a reader meets in the doc. The whole doc, now that the meeting's own
   * words are not in it: the split guards the transitional case where a doc
   * still carries the section one release wrote, so a phrase counted here is
   * counted as a NOTE and "the section was replaced" stays distinguishable
   * from "the section was doubled".
   */
  const readerMarkdown = (): string =>
    docMarkdown().split(`## ${LEGACY_TRANSCRIPT_HEADING}`)[0] ?? '';

  const meetingsList = async (): Promise<{
    meetings: Array<{
      meetingId: string;
      startedAt: number;
      endedAt: number | null;
      turns?: number;
    }>;
    recording?: string;
  }> => (await (await fetch(`${base}/workspaces/${WS}/docs/${docId}/meetings`)).json()) as never;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-e2e-'));
    handle = createServer({
      port: 0,
      dataDir,
      transcription: createMockTranscriptionEngine(SCRIPT),
      meetingNotes: {
        composer: createStubNotesComposer(),
        quietMs: 1_000,
        schedule,
        onNotes: (u) => updates.push(u),
      },
    });
    base = `http://localhost:${handle.port}`;
    WS = await seedBoard(base);
    wsBase = `ws://localhost:${handle.port}`;
    const path = join(dataDir, 'plan-review.md');
    writeFileSync(path, '# Plan review\n\nThe agenda paragraph.\n');
    const res = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'plan-review', sourceUrl: path, title: 'Plan review' }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    docId = ((await res.json()) as { docId: string }).docId;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes notes into the doc at each pause and at no other moment', async () => {
    const client = await AudioClient.open(wsBase, docId);
    client.start();
    await waitFor(() => client.frames.some((f) => f.type === 'ready'), 'ready');

    // Turn one, still being spoken: six chunks reveal six words as partials,
    // the mis-heard "sink" among them. The strip is showing them; the doc
    // must not be.
    client.speak(6);
    await waitFor(() => client.frames.some((f) => String(f.text).includes('sink')), 'the partial');
    expect(docMarkdown()).not.toContain('Meeting notes');
    expect(docMarkdown()).not.toContain('sink');

    // The turn settles — the correction lands on the strip. Settled is still
    // not paused: the doc stays untouched until the quiet timer fires.
    client.speak(1);
    await waitFor(() => client.finals().length === 1, 'the settled turn');
    expect(docMarkdown()).not.toContain('Meeting notes');

    // The speaker goes quiet: the first pause, the first notes.
    schedule.fire();
    await waitFor(() => updates.length === 1, 'the first notes update');
    const v1 = docMarkdown();
    expect(v1).toContain('So the sync is the bottleneck.');
    expect(v1.split('## Meeting notes').length).toBe(2);
    // What the engine took back never reached the doc — the correction lived
    // and died on the strip.
    expect(v1).not.toContain('sink');
    // The doc's own content survived the append.
    expect(v1).toContain('The agenda paragraph.');

    // Turn two settles while the speaker keeps going: no pause, so the doc
    // still reads exactly as the first pause left it.
    client.speak(4);
    await waitFor(() => client.finals().length === 2, 'the second settled turn');
    expect(docMarkdown()).toBe(v1);

    // Second pause, second revision — the section is REPLACED, not doubled.
    schedule.fire();
    await waitFor(() => updates.length === 2, 'the second notes update');
    const v2 = docMarkdown();
    expect(v2).toContain('So the sync is the bottleneck.');
    expect(v2).toContain("Let's measure it first.");
    expect(v2.split('## Meeting notes').length).toBe(2);
    expect(readerMarkdown().split('So the sync is the bottleneck.').length).toBe(2);
    // And no verbatim record came with them (owner, 2026-09-03): the doc gets
    // the notes, the words go to the JSONL asserted at the end of this test
    // and to the `-raw-transcript.md` beside it.
    expect(v2).not.toContain(`## ${LEGACY_TRANSCRIPT_HEADING}`);

    // The socket heard about both ticks as they happened — composing when
    // the pause fired, written when the note landed — carrying the same turn
    // ids as the transcript frames, so a provisional surface can move
    // exactly those lines into "being written" and out again.
    await waitFor(
      () => client.frames.filter((f) => f.type === 'notes_progress').length >= 4,
      'the notes_progress frames',
    );
    expect(
      client.frames
        .filter((f) => f.type === 'notes_progress')
        .slice(0, 4)
        .map((f) => ({ phase: f.phase, tick: f.tick, turns: f.turns })),
    ).toEqual([
      { phase: 'composing', tick: 1, turns: [0] },
      { phase: 'written', tick: 1, turns: [0] },
      { phase: 'composing', tick: 2, turns: [1] },
      { phase: 'written', tick: 2, turns: [1] },
    ]);

    // Stop mid-sentence on turn three: only two of its words were spoken, so
    // the close flushes exactly the words actually said, and the end tick
    // folds them into the notes without waiting for a pause that never comes.
    client.speak(2);
    client.stop();
    await waitFor(() => client.frames.some((f) => f.type === 'stopped'), 'stopped');
    await waitFor(() => updates.length === 3, 'the end tick');
    expect(updates[2]?.tick.reason).toBe('end');
    const v3 = docMarkdown();
    expect(v3).toContain('then we');
    expect(v3).not.toContain('Then we decide.'); // words never spoken
    expect(v3.split('## Meeting notes').length).toBe(2);

    // The durable record kept every settled turn, corrections applied.
    const meetingId = String(client.frames.find((f) => f.type === 'ready')?.meetingId);
    const transcript = readTranscript(dataDir, docId, meetingId);
    expect(transcript.map((t) => t.text)).toEqual([
      'So the sync is the bottleneck.',
      "Let's measure it first.",
      'then we',
    ]);
    client.ws.close();
  });

  it('a second meeting on the same doc starts clean and leaves the record consistent', async () => {
    // The first meeting is over: nothing is recording.
    const between = await meetingsList();
    expect(between.recording).toBeUndefined();
    expect(between.meetings).toHaveLength(1);
    expect(between.meetings[0]?.endedAt).not.toBeNull();
    expect(between.meetings[0]?.turns).toBe(3);
    const firstMeetingId = between.meetings[0]?.meetingId ?? '';

    const client = await AudioClient.open(wsBase, docId);
    client.start();
    await waitFor(() => client.frames.some((f) => f.type === 'ready'), 'second ready');
    const ready = client.frames.find((f) => f.type === 'ready');
    const secondMeetingId = String(ready?.meetingId);
    // A NEW meeting, not the old one resumed.
    expect(secondMeetingId).not.toBe(firstMeetingId);

    // While live, the list says so — and says which meeting.
    const during = await meetingsList();
    expect(during.recording).toBe(secondMeetingId);
    expect(during.meetings).toHaveLength(2);
    expect(during.meetings.find((m) => m.meetingId === secondMeetingId)?.endedAt).toBeNull();

    // The fresh engine session replays the script from its first turn; the
    // fresh notes session starts from nothing — and the first meeting's notes
    // are FINISHED writing. Its session-start released the ledger's claims,
    // so the first pause APPENDS after them rather than replacing them: a
    // stop-and-restart never costs the doc the notes already written (the
    // owner's reported data loss, 2026-08-31).
    client.speak(7);
    await waitFor(() => client.finals().length === 1, 'the second meeting settled turn');
    schedule.fire();
    await waitFor(() => updates.length === 4, 'the second meeting notes');
    const md = docMarkdown();
    // One section still — the old one ended the doc, so this meeting joins
    // its end instead of opening a second heading mid-air.
    expect(md.split('## Meeting notes').length).toBe(2);
    // Every note the FIRST meeting wrote is still there, after stop/restart.
    expect(md).toContain('So the sync is the bottleneck.');
    expect(md).toContain("Let's measure it first.");
    expect(md).toContain('then we');
    // The second meeting re-spoke the first sentence; the merge recognises
    // the line already in the doc rather than writing it twice.
    expect(readerMarkdown().split('So the sync is the bottleneck.').length).toBe(2);
    // And the doc holds no verbatim record at all (owner, 2026-09-03): the
    // words said in both meetings are kept apart in the JSONL and the
    // `-raw-transcript.md` sister file, asserted below.
    expect(md).not.toContain(`## ${LEGACY_TRANSCRIPT_HEADING}`);

    client.stop();
    await waitFor(() => client.frames.some((f) => f.type === 'stopped'), 'second stopped');
    client.ws.close();

    // Both meetings closed, both counted, transcripts kept apart.
    const after = await meetingsList();
    expect(after.recording).toBeUndefined();
    expect(after.meetings).toHaveLength(2);
    for (const m of after.meetings) expect(m.endedAt).not.toBeNull();
    expect(after.meetings.map((m) => m.turns)).toEqual([3, 1]);
    expect(readTranscript(dataDir, docId, secondMeetingId).map((t) => t.text)).toEqual([
      'So the sync is the bottleneck.',
    ]);
    // The clocks are consistent: each meeting's span is non-negative, and
    // the list is ordered by start — the second meeting began after the
    // first did.
    const [first, second] = after.meetings;
    expect(second?.meetingId).toBe(secondMeetingId);
    for (const m of after.meetings) {
      expect(m.endedAt ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(m.startedAt);
    }
    expect(second?.startedAt ?? 0).toBeGreaterThanOrEqual(first?.startedAt ?? Number.MAX_VALUE);
  });
  it('a solo capture asks for no labels, and none arrive anywhere', async () => {
    // The mock diarizes only when the open said to (`transcribe.ts`), which
    // is what makes this a test of the FLAG rather than of the fixture: the
    // script below is the same two-voice script the next test uses, and the
    // labels are absent because nobody paid for them.
    const client = await AudioClient.open(wsBase, docId);
    client.start();
    await waitFor(() => client.frames.some((f) => f.type === 'ready'), 'ready');
    const ready = client.frames.filter((f) => f.type === 'ready').at(-1);
    const meetingId = String(ready?.meetingId);
    // The server says what it opened, and it is the cheap one.
    expect(ready?.mode).toBe('solo');

    client.speak(7);
    await waitFor(() => client.finals().length === 1, 'the first settled turn');
    client.speak(4);
    await waitFor(() => client.finals().length === 2, 'the second settled turn');

    // Words, yes. Voices, no — on the wire and in the durable record.
    expect(client.finals().map((f) => f.text)).toEqual([
      'So the sync is the bottleneck.',
      "Let's measure it first.",
    ]);
    expect(client.finals().every((f) => f.speaker === undefined)).toBe(true);
    expect(readTranscript(dataDir, docId, meetingId).every((t) => !t.speaker)).toBe(true);

    client.stop();
    await waitFor(() => client.frames.some((f) => f.type === 'stopped'), 'stopped');
    // What it cost is on the record: this meeting never bought labels.
    expect(listMeetings(dataDir, docId).find((m) => m.meetingId === meetingId)?.mode).toBe('solo');
    client.ws.close();
  });

  it("carries each turn's speaker through the socket, the record and the notes", async () => {
    // The gap this closes: diarization was tested at every layer and through
    // none of them. `MockScriptTurn.speaker` exists precisely so the mock can
    // diarize, and this script did not set it — so the one test that walks
    // socket -> store -> notes -> doc walked it unlabelled.
    //
    // Its OWN doc, not the shared one: the meetings above already wrote these
    // exact sentences there, and a restart never replaces prior-meeting notes
    // — the tagged rewrites would arrive as suggestions instead of the text
    // changes every assertion below reads.
    const path = join(dataDir, 'speaker-carry.md');
    writeFileSync(path, '# Speaker carry\n\nAgenda.\n');
    const created = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'speaker-carry', sourceUrl: path, title: 'Speaker carry' }),
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const carryDocId = ((await created.json()) as { docId: string }).docId;
    const carryMarkdown = (): string => {
      const doc = handle.docStore.get(carryDocId);
      if (!doc) throw new Error(`no doc for ${carryDocId}`);
      return prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
    };
    const client = await AudioClient.open(wsBase, carryDocId);
    // A conversation: the mode is what buys the labels every assertion below
    // is about.
    client.start('conversation');
    await waitFor(() => client.frames.some((f) => f.type === 'ready'), 'ready');
    const ready = client.frames.filter((f) => f.type === 'ready').at(-1);
    const meetingId = String(ready?.meetingId);
    expect(ready?.mode).toBe('conversation');

    // Two turns from two different voices settle.
    client.speak(7);
    await waitFor(() => client.finals().length === 1, 'the first settled turn');
    client.speak(4);
    await waitFor(() => client.finals().length === 2, 'the second settled turn');

    // 1. Two voices arrive as two distinct labels, on the wire.
    expect(client.finals().map((f) => f.speaker)).toEqual(['A', 'B']);

    // 2. The durable record keeps the label with the turn.
    expect(readTranscript(dataDir, carryDocId, meetingId).map((t) => t.speaker)).toEqual([
      'A',
      'B',
    ]);

    // 3. The notes name them. The composer stub renders `speaker: text`, and
    //    the speaker it renders has been through `speakerDisplayName` — so
    //    "Speaker A" in the doc means the label reached the composer's input,
    //    not just the strip.
    const before = updates.length;
    schedule.fire();
    await waitFor(() => updates.length > before, 'the notes update for this meeting');
    const named = carryMarkdown();
    expect(named).toContain('Speaker A: So the sync is the bottleneck.');
    expect(named).toContain("Speaker B: Let's measure it first.");

    // 4. Naming a voice is a mapping the meeting keeps, not a rewrite of the
    //    record: the transcript still says 'A' (it is what the engine heard),
    //    and every later render of that label resolves to the name.
    client.ws.send(JSON.stringify({ type: 'name_speaker', speaker: 'A', name: 'Dana' }));
    await waitFor(
      () =>
        listMeetings(dataDir, carryDocId).some((m) => m.meetingId === meetingId && m.speakers?.A),
      'the name to reach the meeting record',
    );
    expect(
      listMeetings(dataDir, carryDocId).find((m) => m.meetingId === meetingId)?.speakers,
    ).toEqual({
      A: 'Dana',
    });

    // 5. The rename reaches BACKWARDS, into notes already in the doc — the
    //    owner's call: not "Speaker A" above the rename and "Dana" below it.
    //    Asserted here, BEFORE any further tick, because a later compose
    //    replaces the whole section and would make this pass for the wrong
    //    reason.
    await waitFor(
      () => carryMarkdown().includes('Dana: So the sync is the bottleneck.'),
      'the rename to rewrite the note already written',
    );
    const rewritten = carryMarkdown();
    expect(rewritten).not.toContain('Speaker A');
    // Only that voice moved. B was not named and still reads as a label.
    expect(rewritten).toContain("Speaker B: Let's measure it first.");

    // Turn three is voice A again. It composes under the new name without
    // anyone renaming it a second time.
    client.speak(4);
    await waitFor(() => client.finals().length === 3, 'the third settled turn');
    const beforeRenamed = updates.length;
    schedule.fire();
    await waitFor(() => updates.length > beforeRenamed, 'the notes update after the rename');
    expect(carryMarkdown()).toContain('Dana: Then we decide.');
    // The record is unchanged by the naming — raw labels, all three turns.
    expect(readTranscript(dataDir, carryDocId, meetingId).map((t) => t.speaker)).toEqual([
      'A',
      'B',
      'A',
    ]);

    client.stop();
    await waitFor(() => client.frames.some((f) => f.type === 'stopped'), 'stopped');
    client.ws.close();
  });

  it('a rename AFTER the meeting stopped still reaches the record and the notes', async () => {
    // The gap this closes: the socket is the only live rename channel, and it
    // is gone the moment capture stops — which is exactly when a person on
    // the recording device gets around to naming the voices. The REST route
    // has to do what the socket did: index line, and the backwards rewrite.
    const path = join(dataDir, 'late-rename.md');
    writeFileSync(path, '# Late rename\n\nBody about Speaker B stays.\n');
    const created = await fetch(`${base}/workspaces/${WS}/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'late-rename', sourceUrl: path, title: 'Late rename' }),
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const lateDocId = ((await created.json()) as { docId: string }).docId;
    const lateMarkdown = (): string => {
      const doc = handle.docStore.get(lateDocId);
      if (!doc) throw new Error(`no doc for ${lateDocId}`);
      return prose.serializeFragmentToMarkdown(prose.getProseFragment(doc.ydoc));
    };

    // A two-voice conversation, composed into notes, then stopped.
    const client = await AudioClient.open(wsBase, lateDocId);
    client.start('conversation');
    await waitFor(() => client.frames.some((f) => f.type === 'ready'), 'ready');
    const ready = client.frames.filter((f) => f.type === 'ready').at(-1);
    const meetingId = String(ready?.meetingId);
    client.speak(7);
    await waitFor(() => client.finals().length === 1, 'the first settled turn');
    client.speak(4);
    await waitFor(() => client.finals().length === 2, 'the second settled turn');
    const before = updates.length;
    schedule.fire();
    await waitFor(() => updates.length > before, 'the notes for this meeting');
    expect(lateMarkdown()).toContain("Speaker B: Let's measure it first.");
    client.stop();
    await waitFor(() => client.frames.some((f) => f.type === 'stopped'), 'stopped');
    client.ws.close();

    // The rename, over HTTP — no socket exists any more.
    const renameUrl = `${base}/workspaces/${WS}/docs/${lateDocId}/meetings/${meetingId}/speakers`;
    const renamed = await fetch(renameUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ speaker: 'B', name: 'Priya' }),
    });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
    expect(((await renamed.json()) as { speakers: unknown }).speakers).toEqual({ B: 'Priya' });

    // 1. The record keeps the name, folded like a live rename's.
    expect(
      listMeetings(dataDir, lateDocId).find((m) => m.meetingId === meetingId)?.speakers,
    ).toEqual({ B: 'Priya' });
    // 2. The rename reaches BACKWARDS into notes already written…
    await waitFor(
      () => lateMarkdown().includes("Priya: Let's measure it first."),
      'the rename to rewrite the note already written',
    );
    const rewritten = lateMarkdown();
    // …and only into the notes section: the person's own paragraph keeps its
    // words, however it happens to spell a label.
    expect(rewritten).toContain('Body about Speaker B stays.');
    expect(rewritten).toContain('Speaker A: So the sync is the bottleneck.');
    // 3. The transcript still says 'B' — the engine's word is not rewritten.
    expect(readTranscript(dataDir, lateDocId, meetingId).map((t) => t.speaker)).toEqual(['A', 'B']);

    // The refusals, each with the status a strip can explain from:
    // a voice this meeting never carried…
    const nobody = await fetch(renameUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ speaker: 'C', name: 'Jordan' }),
    });
    expect(nobody.status).toBe(400);
    // …a meeting the doc never held…
    const missing = await fetch(
      `${base}/workspaces/${WS}/docs/${lateDocId}/meetings/never/speakers`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ speaker: 'B', name: 'Jordan' }),
      },
    );
    expect(missing.status).toBe(404);
    // …a name too long for the record (same cap the socket enforces)…
    const oversize = await fetch(renameUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ speaker: 'B', name: 'x'.repeat(80) }),
    });
    expect(oversize.status).toBe(400);
    // …and a meeting still LIVE, whose rename belongs to the socket.
    const second = await AudioClient.open(wsBase, lateDocId);
    second.start('conversation');
    await waitFor(() => second.frames.some((f) => f.type === 'ready'), 'the second ready');
    const liveId = String(second.frames.filter((f) => f.type === 'ready').at(-1)?.meetingId);
    const live = await fetch(
      `${base}/workspaces/${WS}/docs/${lateDocId}/meetings/${liveId}/speakers`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ speaker: 'A', name: 'Jordan' }),
      },
    );
    expect(live.status).toBe(409);
    second.stop();
    await waitFor(() => second.frames.some((f) => f.type === 'stopped'), 'the second stopped');
    second.ws.close();
  });
});
