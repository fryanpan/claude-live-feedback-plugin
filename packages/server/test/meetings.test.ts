/**
 * The durable half: what lands on disk, read back off disk rather than out of
 * the object that wrote it.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import {
  MeetingStore,
  listMeetings,
  meetingIndexPath,
  meetingTranscriptPath,
  readTranscript,
} from '../src/meetings.ts';

describe('meeting store', () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meetings-'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('starts a meeting, writes its turns, and reads them back off disk', () => {
    const store = new MeetingStore(dataDir);
    const meeting = store.start({ docId: 'plan-migration', engine: 'mock', sampleRate: 16_000 });
    expect(meeting).not.toBeNull();
    if (!meeting) return;
    meeting.recordTurn(0, 'The sync is the bottleneck.');
    meeting.recordTurn(1, "Let's measure it first.");
    const record = meeting.stop();
    expect(record.turns).toBe(2);
    expect(record.endedAt).toBeGreaterThanOrEqual(record.startedAt);

    // Read the FILE, not the store: the transcript is the deliverable.
    const path = meetingTranscriptPath(dataDir, 'plan-migration', meeting.meetingId);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      turn: 0,
      text: 'The sync is the bottleneck.',
    });
    expect(readTranscript(dataDir, 'plan-migration', meeting.meetingId).map((t) => t.text)).toEqual(
      ['The sync is the bottleneck.', "Let's measure it first."],
    );
  });

  it('refuses a second meeting while one is live, and allows one after it stops', () => {
    const store = new MeetingStore(dataDir);
    const first = store.start({ docId: 'one-at-a-time', engine: 'mock', sampleRate: 16_000 });
    expect(first).not.toBeNull();
    expect(store.start({ docId: 'one-at-a-time', engine: 'mock', sampleRate: 16_000 })).toBeNull();
    expect(store.active('one-at-a-time')?.meetingId).toBe(first?.meetingId);
    first?.stop();
    expect(store.active('one-at-a-time')).toBeUndefined();
    const second = store.start({ docId: 'one-at-a-time', engine: 'mock', sampleRate: 16_000 });
    expect(second).not.toBeNull();
    expect(second?.meetingId).not.toBe(first?.meetingId);
    second?.stop();
  });

  it('gives a second meeting on one doc its own file', () => {
    const store = new MeetingStore(dataDir);
    const a = store.start({ docId: 'two-meetings', engine: 'mock', sampleRate: 16_000 });
    a?.recordTurn(0, 'Morning standup.');
    a?.stop();
    const b = store.start({ docId: 'two-meetings', engine: 'mock', sampleRate: 16_000 });
    b?.recordTurn(0, 'Afternoon review.');
    b?.stop();
    expect(a?.meetingId).not.toBe(b?.meetingId);
    const pathA = meetingTranscriptPath(dataDir, 'two-meetings', a?.meetingId ?? '');
    const pathB = meetingTranscriptPath(dataDir, 'two-meetings', b?.meetingId ?? '');
    expect(pathA).not.toBe(pathB);
    expect(readFileSync(pathA, 'utf8')).toContain('Morning standup.');
    expect(readFileSync(pathA, 'utf8')).not.toContain('Afternoon review.');
    expect(readFileSync(pathB, 'utf8')).toContain('Afternoon review.');
  });

  it('enumerates a doc’s meetings by folding the append-only index', () => {
    const store = new MeetingStore(dataDir);
    const meetings = listMeetings(dataDir, 'two-meetings');
    expect(meetings).toHaveLength(2);
    expect(meetings[0]?.startedAt).toBeLessThanOrEqual(meetings[1]?.startedAt ?? 0);
    for (const m of meetings) {
      expect(m.endedAt).not.toBeNull();
      expect(m.engine).toBe('mock');
      expect(m.sampleRate).toBe(16_000);
      expect(m.turns).toBe(1);
    }
    // The index is append-only: start and stop are separate lines, not a
    // rewrite of the first one.
    const index = readFileSync(meetingIndexPath(dataDir, 'two-meetings'), 'utf8')
      .trim()
      .split('\n');
    expect(index).toHaveLength(4);
    expect(store.list('two-meetings')).toEqual(meetings);
  });

  it('reads a live meeting back with no end time', () => {
    const store = new MeetingStore(dataDir);
    const live = store.start({ docId: 'still-going', engine: 'mock', sampleRate: 16_000 });
    const [record] = listMeetings(dataDir, 'still-going');
    expect(record?.endedAt).toBeNull();
    expect(record?.turns).toBeUndefined();
    live?.stop();
  });

  it('creates the transcript file at start, so a silent meeting is empty not missing', () => {
    const store = new MeetingStore(dataDir);
    const quiet = store.start({ docId: 'nobody-spoke', engine: 'mock', sampleRate: 16_000 });
    if (!quiet) throw new Error('expected a meeting');
    expect(existsSync(meetingTranscriptPath(dataDir, 'nobody-spoke', quiet.meetingId))).toBe(true);
    quiet.stop();
    expect(readTranscript(dataDir, 'nobody-spoke', quiet.meetingId)).toEqual([]);
  });

  it('ignores a repeat of a turn already written, and anything after stop', () => {
    const store = new MeetingStore(dataDir);
    const meeting = store.start({ docId: 'no-doubles', engine: 'mock', sampleRate: 16_000 });
    if (!meeting) throw new Error('expected a meeting');
    meeting.recordTurn(0, 'Ship it Thursday.');
    meeting.recordTurn(0, 'Ship it Thursday.');
    meeting.stop();
    meeting.recordTurn(1, 'This one is too late.');
    expect(readTranscript(dataDir, 'no-doubles', meeting.meetingId).map((t) => t.text)).toEqual([
      'Ship it Thursday.',
    ]);
    // A second stop does not append a second closing line.
    meeting.stop();
    expect(listMeetings(dataDir, 'no-doubles')).toHaveLength(1);
  });

  it('keeps a docId that looks like a path inside the meetings directory', () => {
    const store = new MeetingStore(dataDir);
    const meeting = store.start({ docId: '../escape:me', engine: 'mock', sampleRate: 16_000 });
    if (!meeting) throw new Error('expected a meeting');
    meeting.recordTurn(0, 'Contained.');
    meeting.stop();
    const path = meetingTranscriptPath(dataDir, '../escape:me', meeting.meetingId);
    expect(path.startsWith(join(dataDir, 'meetings'))).toBe(true);
    // No segment of the resolved path is a parent hop — the sanitizer folded
    // the traversal into an ordinary directory name.
    expect(relative(join(dataDir, 'meetings'), resolve(path)).split(sep)).not.toContain('..');
    expect(readTranscript(dataDir, '../escape:me', meeting.meetingId)).toHaveLength(1);
  });

  it('skips a torn tail line rather than losing the transcript', () => {
    const store = new MeetingStore(dataDir);
    const meeting = store.start({ docId: 'torn-tail', engine: 'mock', sampleRate: 16_000 });
    if (!meeting) throw new Error('expected a meeting');
    meeting.recordTurn(0, 'First line survives.');
    meeting.stop();
    const path = meetingTranscriptPath(dataDir, 'torn-tail', meeting.meetingId);
    Bun.write(path, `${readFileSync(path, 'utf8')}{"turn":1,"text":"cut off`);
    expect(readTranscript(dataDir, 'torn-tail', meeting.meetingId).map((t) => t.text)).toEqual([
      'First line survives.',
    ]);
  });

  it('stopAll ends every live meeting — the shutdown path', () => {
    const store = new MeetingStore(dataDir);
    store.start({ docId: 'shutdown-a', engine: 'mock', sampleRate: 16_000 });
    store.start({ docId: 'shutdown-b', engine: 'mock', sampleRate: 16_000 });
    store.stopAll();
    expect(store.active('shutdown-a')).toBeUndefined();
    expect(store.active('shutdown-b')).toBeUndefined();
    expect(listMeetings(dataDir, 'shutdown-a')[0]?.endedAt).not.toBeNull();
  });
});
