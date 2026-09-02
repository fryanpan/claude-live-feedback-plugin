/**
 * The raw companion record a meeting leaves beside its doc: the
 * `<docname>-raw-transcript.md` a person reads to trace a bad note back to
 * what was said, the `.pcm` audio it was transcribed from, and the
 * `meeting.json` that ties both back to the doc.
 *
 * Everything is read back off disk. All fixtures are synthetic — invented
 * names in the jordan@partner.example register, and the "audio" is a byte
 * pattern, never a recording of anyone. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MeetingClient, MeetingRelay } from '../src/meeting-protocol.ts';
import {
  docNameFor,
  formatRawBullet,
  meetingJsonPath,
  rawTranscriptPath,
  readMeetingJson,
  segmentAudioFileName,
  speakerLineName,
} from '../src/meeting-raw.ts';
import { MeetingStore, meetingIndexPath } from '../src/meetings.ts';
import { createMockTranscriptionEngine } from '../src/transcribe.ts';

describe('raw transcript formatting', () => {
  it('names the companion file after the bound file, then the title, then the doc id', () => {
    expect(docNameFor('plan-q3', { path: '/repo/docs/product/plans/q3-plan.md' })).toBe('q3-plan');
    expect(docNameFor('plan-q3', { title: 'Q3 planning: the big one' })).toBe(
      'q3-planning-the-big-one',
    );
    expect(docNameFor('plan/q3', {})).toBe('plan_q3');
  });

  it('writes one plain bullet per turn: UTC clock, speaker, words', () => {
    // 2026-09-02T10:15:30.500Z — the millisecond is dropped, the Z stays.
    expect(
      formatRawBullet(Date.UTC(2026, 8, 2, 10, 15, 30, 500), 'Jordan', 'We ship Thursday.'),
    ).toBe('- [10:15:30Z] Jordan: We ship Thursday.');
  });

  it('keeps a multi-line turn on one bullet', () => {
    expect(formatRawBullet(0, 'Speaker A', 'one\ntwo')).toBe('- [00:00:00Z] Speaker A: one two');
  });

  it('picks the speaker: engine label (named or not), else participant, else Speaker 1', () => {
    expect(speakerLineName('A', { A: 'Jordan' }, undefined)).toBe('Jordan');
    expect(speakerLineName('B', { A: 'Jordan' }, undefined)).toBe('Speaker B');
    expect(speakerLineName(undefined, {}, 'Devi Raman')).toBe('Devi Raman');
    expect(speakerLineName(undefined, {}, undefined)).toBe('Speaker 1');
  });

  it('names audio files by segment and stream', () => {
    expect(segmentAudioFileName(3, 'mic')).toBe('segment-3-mic.pcm');
    expect(segmentAudioFileName(1, 'p7/../x')).toBe('segment-1-p7_.._x.pcm');
  });
});

describe('the companion record on disk', () => {
  let dataDir: string;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-raw-'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const docInfo = () => ({ path: '/repo/docs/product/plans/q3-plan.md', title: 'Q3 plan' });

  it('appends a segment per meeting with a header, an audio line, and one bullet per turn', () => {
    const store = new MeetingStore(dataDir, { docInfo });
    const docId = 'plan-q3';
    const first = store.start({
      docId,
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'conversation',
      source: 'mic',
      now: Date.UTC(2026, 8, 2, 10, 0, 0),
    });
    expect(first).not.toBeNull();
    if (!first) return;
    first.recordAudio(new Uint8Array([1, 2, 3, 4]));
    first.recordTurn(0, 'The sync is the bottleneck.', 'A');
    first.nameSpeaker('A', 'Jordan');
    first.recordTurn(1, 'Measure it first.', 'B');
    first.recordAudio(new Uint8Array([5, 6]));
    first.stop();

    const path = rawTranscriptPath(dataDir, docId, docNameFor(docId, docInfo()));
    expect(path.endsWith('/q3-plan-raw-transcript.md')).toBe(true);
    const md = readFileSync(path, 'utf8');
    expect(md).toContain('## Segment 1 — 2026-09-02T10:00:00.000Z');
    expect(md).toContain('Audio: segment-1-mic.pcm');
    expect(md).toMatch(/- \[\d\d:\d\d:\d\dZ\] Jordan: The sync is the bottleneck\./);
    expect(md).toMatch(/- \[\d\d:\d\d:\d\dZ\] Speaker B: Measure it first\./);

    // The audio is the bytes that arrived, in order, untouched.
    const pcm = readFileSync(join(dataDir, 'meetings', docId, 'segment-1-mic.pcm'));
    expect([...pcm]).toEqual([1, 2, 3, 4, 5, 6]);

    // A stop-and-restart appends a second segment rather than replacing.
    const second = store.start({
      docId,
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
      source: 'mic',
      participant: 'Devi Raman',
      now: Date.UTC(2026, 8, 2, 11, 0, 0),
    });
    if (!second) throw new Error('second meeting refused');
    second.recordTurn(0, 'Back again.');
    second.stop();
    const again = readFileSync(path, 'utf8');
    expect(again).toContain('## Segment 1 — 2026-09-02T10:00:00.000Z');
    expect(again).toContain('## Segment 2 — 2026-09-02T11:00:00.000Z');
    expect(again.indexOf('## Segment 1')).toBeLessThan(again.indexOf('## Segment 2'));
    // A solo capture has no engine label, so the person on the socket is the speaker.
    expect(again).toMatch(/- \[\d\d:\d\d:\d\dZ\] Devi Raman: Back again\./);
    // No audio arrived for the second meeting, so no audio line claims one.
    const seg2 = again.slice(again.indexOf('## Segment 2'));
    expect(seg2).not.toContain('Audio:');
    expect(existsSync(join(dataDir, 'meetings', docId, 'segment-2-mic.pcm'))).toBe(false);
  });

  it('ties the folder back to the doc in meeting.json, surviving the doc moving', () => {
    const docId = 'plan-q3';
    const json = readMeetingJson(dataDir, docId);
    expect(json?.docId).toBe(docId);
    expect(json?.path).toBe('/repo/docs/product/plans/q3-plan.md');
    expect(json?.title).toBe('Q3 plan');
    expect(json?.transcript).toBe('q3-plan-raw-transcript.md');
    expect(json?.segments.map((s) => s.n)).toEqual([1, 2]);
    expect(json?.segments[0]?.audio).toEqual([
      {
        stream: 'mic',
        file: 'segment-1-mic.pcm',
        codec: 'pcm_s16le',
        sampleRate: 16_000,
        channels: 1,
        bytes: 6,
      },
    ]);
    expect(json?.segments[0]?.source).toBe('mic');
    expect(existsSync(meetingJsonPath(dataDir, docId))).toBe(true);
  });

  it('a bot meeting gets a segment too, with participant names and no audio line', () => {
    const store = new MeetingStore(dataDir, { docInfo: () => ({ title: 'Standup' }) });
    const docId = 'standup';
    const m = store.start({
      docId,
      engine: 'recall+assemblyai',
      sampleRate: 16_000,
      mode: 'conversation',
      source: 'bot',
    });
    if (!m) throw new Error('refused');
    m.nameSpeaker('p7', 'Rowan Pike');
    m.recordTurn(0, 'Morning all.', 'p7');
    m.stop();
    const md = readFileSync(rawTranscriptPath(dataDir, docId, 'standup'), 'utf8');
    expect(md).toContain('## Segment 1 —');
    expect(md).toContain('Source: bot');
    expect(md).toMatch(/\] Rowan Pike: Morning all\./);
    expect(md).not.toContain('Audio:');
  });

  it('folds a revised turn and a relabel: one bullet, the last words, the last label', () => {
    const store = new MeetingStore(dataDir, { docInfo: () => ({}) });
    const docId = 'revisions';
    const m = store.start({ docId, engine: 'mock', sampleRate: 16_000, mode: 'conversation' });
    if (!m) throw new Error('refused');
    m.recordTurn(0, 'rough words', 'A');
    m.recordTurn(0, 'Rough words.', 'A');
    m.recordTurn(0, 'Rough words.', 'B');
    m.stop();
    const md = readFileSync(rawTranscriptPath(dataDir, docId, 'revisions'), 'utf8');
    const bullets = md.split('\n').filter((l) => l.startsWith('- ['));
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toMatch(/\] Speaker B: Rough words\.$/);
  });

  it('backfills a meeting the server died holding, so every meeting keeps a segment', () => {
    const docId = 'crashed';
    // A meeting recorded by a process that never reached stop(): its index
    // start line and turns are on disk, its segment is not.
    const dying = new MeetingStore(dataDir, { docInfo: () => ({}) });
    const m1 = dying.start({
      docId,
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
      now: Date.UTC(2026, 8, 1, 9, 0, 0),
    });
    if (!m1) throw new Error('refused');
    m1.recordTurn(0, 'Said before the crash.');
    const path = rawTranscriptPath(dataDir, docId, 'crashed');
    expect(existsSync(path)).toBe(false);

    // The next server's next meeting on the doc writes the missing segment
    // first, numbered by its place in the index, then its own.
    const next = new MeetingStore(dataDir, { docInfo: () => ({}) });
    const m2 = next.start({
      docId,
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
      now: Date.UTC(2026, 8, 2, 9, 0, 0),
    });
    if (!m2) throw new Error('refused');
    m2.recordTurn(0, 'Said after.');
    m2.stop();
    const md = readFileSync(path, 'utf8');
    expect(md.indexOf('## Segment 1 — 2026-09-01T09:00:00.000Z')).toBeGreaterThanOrEqual(0);
    expect(md.indexOf('## Segment 2 — 2026-09-02T09:00:00.000Z')).toBeGreaterThan(
      md.indexOf('## Segment 1'),
    );
    expect(md).toContain('Said before the crash.');
    expect(md).toContain('no recorded end');
    expect(readMeetingJson(dataDir, docId)?.segments.map((s) => s.n)).toEqual([1, 2]);
  });

  it('a failing companion write never takes the meeting record down with it', () => {
    // The resolver the server hands in throws — the store logs, names the
    // companion by doc id, and the JSONL record is untouched.
    const store = new MeetingStore(dataDir, {
      docInfo: () => {
        throw new Error('resolver exploded');
      },
    });
    const m = store.start({
      docId: 'resolver-fails',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
    });
    if (!m) throw new Error('refused');
    m.recordTurn(0, 'Still recorded.');
    const record = m.stop();
    expect(record.turns).toBe(1);
    expect(existsSync(meetingIndexPath(dataDir, 'resolver-fails'))).toBe(true);
  });
});

describe('the audio tee on the microphone socket', () => {
  let dataDir: string;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-tee-'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('writes every frame — those held during the handshake and those sent live — in order', async () => {
    const store = new MeetingStore(dataDir, { docInfo: () => ({ title: 'Tee' }) });
    const relay = new MeetingRelay({
      store,
      engines: [createMockTranscriptionEngine()],
      notes: null,
      broadcast: () => {},
    });
    const sent: string[] = [];
    const ws: MeetingClient = { data: { docId: 'tee' }, send: (p) => sent.push(p) };
    relay.onOpen(ws);
    relay.onText(
      ws,
      JSON.stringify({
        type: 'start',
        sampleRate: 16_000,
        encoding: 'pcm_s16le',
        mode: 'solo',
        participant: 'Devi Raman',
      }),
    );
    // Before the (microtask-deferred) handshake resolves: held, not dropped.
    relay.onAudio(ws, new Uint8Array([1, 1]));
    relay.onAudio(ws, new Uint8Array([2, 2]));
    await settle();
    await settle();
    relay.onAudio(ws, new Uint8Array([3, 3]));
    relay.onText(ws, JSON.stringify({ type: 'stop' }));
    await settle();
    await settle();

    const files = readdirSync(join(dataDir, 'meetings', 'tee'));
    expect(files).toContain('segment-1-mic.pcm');
    const pcm = readFileSync(join(dataDir, 'meetings', 'tee', 'segment-1-mic.pcm'));
    expect([...pcm]).toEqual([1, 1, 2, 2, 3, 3]);
    const md = readFileSync(join(dataDir, 'meetings', 'tee', 'tee-raw-transcript.md'), 'utf8');
    expect(md).toContain('Engine: mock');
    expect(md).toMatch(/\] Devi Raman: /);
    expect(sent.some((p) => JSON.parse(p).type === 'stopped')).toBe(true);
  });
});
