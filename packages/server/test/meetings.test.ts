/**
 * The durable half: what lands on disk, read back off disk rather than out of
 * the object that wrote it.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    const meeting = store.start({
      docId: 'plan-migration',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
    });
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
    const first = store.start({
      docId: 'one-at-a-time',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
    });
    expect(first).not.toBeNull();
    expect(
      store.start({ docId: 'one-at-a-time', engine: 'mock', sampleRate: 16_000, mode: 'solo' }),
    ).toBeNull();
    expect(store.active('one-at-a-time')?.meetingId).toBe(first?.meetingId);
    first?.stop();
    expect(store.active('one-at-a-time')).toBeUndefined();
    const second = store.start({
      docId: 'one-at-a-time',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
    });
    expect(second).not.toBeNull();
    expect(second?.meetingId).not.toBe(first?.meetingId);
    second?.stop();
  });

  it('gives a second meeting on one doc its own file', () => {
    const store = new MeetingStore(dataDir);
    const a = store.start({
      docId: 'two-meetings',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
    });
    a?.recordTurn(0, 'Morning standup.');
    a?.stop();
    const b = store.start({
      docId: 'two-meetings',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
    });
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
    const live = store.start({
      docId: 'still-going',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
    });
    const [record] = listMeetings(dataDir, 'still-going');
    expect(record?.endedAt).toBeNull();
    expect(record?.turns).toBeUndefined();
    live?.stop();
  });

  it('creates the transcript file at start, so a silent meeting is empty not missing', () => {
    const store = new MeetingStore(dataDir);
    const quiet = store.start({
      docId: 'nobody-spoke',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
    });
    if (!quiet) throw new Error('expected a meeting');
    expect(existsSync(meetingTranscriptPath(dataDir, 'nobody-spoke', quiet.meetingId))).toBe(true);
    quiet.stop();
    expect(readTranscript(dataDir, 'nobody-spoke', quiet.meetingId)).toEqual([]);
  });

  it('ignores a repeat of a turn already written, and anything after stop', () => {
    const store = new MeetingStore(dataDir);
    const meeting = store.start({
      docId: 'no-doubles',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
    });
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
    const meeting = store.start({
      docId: '../escape:me',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
    });
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
    const meeting = store.start({
      docId: 'torn-tail',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
    });
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
    store.start({ docId: 'shutdown-a', engine: 'mock', sampleRate: 16_000, mode: 'solo' });
    store.start({ docId: 'shutdown-b', engine: 'mock', sampleRate: 16_000, mode: 'solo' });
    store.stopAll();
    expect(store.active('shutdown-a')).toBeUndefined();
    expect(store.active('shutdown-b')).toBeUndefined();
    expect(listMeetings(dataDir, 'shutdown-a')[0]?.endedAt).not.toBeNull();
  });
});

describe('meeting store: who said it', () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meetings-speakers-'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps the speaker label on each settled turn', () => {
    const store = new MeetingStore(dataDir);
    const meeting = store.start({
      docId: 'two-voices',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
    });
    if (!meeting) throw new Error('expected a meeting');
    meeting.recordTurn(0, 'Can you take the migration?', 'A');
    meeting.recordTurn(1, 'Sure.', 'B');
    meeting.recordTurn(2, 'Thanks.');
    meeting.stop();
    expect(readTranscript(dataDir, 'two-voices', meeting.meetingId)).toEqual([
      expect.objectContaining({ turn: 0, text: 'Can you take the migration?', speaker: 'A' }),
      expect.objectContaining({ turn: 1, text: 'Sure.', speaker: 'B' }),
      expect.objectContaining({ turn: 2, text: 'Thanks.' }),
    ]);
    expect('speaker' in (readTranscript(dataDir, 'two-voices', meeting.meetingId)[2] ?? {})).toBe(
      false,
    );
  });

  it('a relabel of a written turn is appended, never rewritten, and folds on read', () => {
    const store = new MeetingStore(dataDir);
    const meeting = store.start({
      docId: 'relabel',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
    });
    if (!meeting) throw new Error('expected a meeting');
    meeting.recordTurn(0, 'Sure.', 'A');
    // The end-of-session pass decided it was the other voice.
    meeting.recordTurn(0, 'Sure.', 'B');
    // Same label again is not news.
    meeting.recordTurn(0, 'Sure.', 'B');
    const record = meeting.stop();
    expect(record.turns).toBe(1);
    const lines = readFileSync(meetingTranscriptPath(dataDir, 'relabel', meeting.meetingId), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ turn: 0, text: 'Sure.', speaker: 'A' });
    expect(lines[1]).toMatchObject({ turn: 0, speaker: 'B' });
    expect('text' in (lines[1] ?? {})).toBe(false);
    expect(readTranscript(dataDir, 'relabel', meeting.meetingId)).toEqual([
      expect.objectContaining({ turn: 0, text: 'Sure.', speaker: 'B' }),
    ]);
  });

  it('a revision that takes the label away clears it, rather than leaving a stale one', () => {
    const store = new MeetingStore(dataDir);
    const meeting = store.start({
      docId: 'unlabel',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
    });
    if (!meeting) throw new Error('expected a meeting');
    meeting.recordTurn(0, 'Sure.', 'A');
    // The whole-session pass demoted the label to a placeholder, which the
    // engine adapter maps to no speaker at all. The strip drops its tag; the
    // durable record has to agree, or it keeps an attribution nobody saw.
    meeting.recordTurn(0, 'Sure.', undefined);
    // And having said nobody, it does not say it twice.
    meeting.recordTurn(0, 'Sure.', undefined);
    meeting.stop();
    const lines = readFileSync(meetingTranscriptPath(dataDir, 'unlabel', meeting.meetingId), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ turn: 0, speaker: null });
    const [turn] = readTranscript(dataDir, 'unlabel', meeting.meetingId);
    expect(turn).toMatchObject({ turn: 0, text: 'Sure.' });
    expect('speaker' in (turn ?? {})).toBe(false);
  });

  it('remembers the names a person gives the labels, on the meeting record', () => {
    const store = new MeetingStore(dataDir);
    const meeting = store.start({
      docId: 'named',
      engine: 'mock',
      sampleRate: 16_000,
      mode: 'solo',
    });
    if (!meeting) throw new Error('expected a meeting');
    meeting.nameSpeaker('A', 'Jordan');
    meeting.nameSpeaker('B', 'Sam');
    // Renaming replaces; the last word wins.
    meeting.nameSpeaker('A', 'Jordan Lee');
    expect(listMeetings(dataDir, 'named')[0]?.speakers).toEqual({ A: 'Jordan Lee', B: 'Sam' });
    const record = meeting.stop();
    expect(record.speakers).toEqual({ A: 'Jordan Lee', B: 'Sam' });
    expect(listMeetings(dataDir, 'named')[0]?.speakers).toEqual({ A: 'Jordan Lee', B: 'Sam' });
    // After stop the map is closed, like the transcript.
    meeting.nameSpeaker('C', 'Late');
    expect(listMeetings(dataDir, 'named')[0]?.speakers).toEqual({ A: 'Jordan Lee', B: 'Sam' });
  });
});

describe('meeting store: how the room was told', () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-announced-'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  const start = (docId: string, mode: 'solo' | 'conversation' = 'conversation') =>
    new MeetingStore(dataDir).start({ docId, engine: 'mock', sampleRate: 16_000, mode });

  const indexLines = (docId: string) =>
    readFileSync(meetingIndexPath(dataDir, docId), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it('claims NOTHING at start — an announcement is a thing that has happened', () => {
    // The load-bearing one. A claim written when the mic opened would stand
    // even for a meeting stopped mid-sentence, and this record is the thing
    // anybody would later be asked to show.
    const meeting = start('doc-just-started');
    expect(indexLines('doc-just-started')[0]).not.toHaveProperty('announced');
    const record = meeting?.stop();
    expect(record && 'announced' in record).toBe(false);
    const read = listMeetings(dataDir, 'doc-just-started')[0];
    expect(read && 'announced' in read).toBe(false);
  });

  it('writes the path once the room has been told, and reads it back off disk', () => {
    const meeting = start('doc-device');
    meeting?.setAnnounced('device');
    meeting?.stop();
    expect(listMeetings(dataDir, 'doc-device')[0]?.announced).toBe('device');
  });

  it('takes a LATER correction over an earlier one', () => {
    // The device was asked to speak, could not, and a person was asked to
    // read the sentence instead.
    const meeting = start('doc-fallback');
    meeting?.setAnnounced('device');
    meeting?.setAnnounced('spoken');
    expect(meeting?.stop().announced).toBe('spoken');
    expect(listMeetings(dataDir, 'doc-fallback')[0]?.announced).toBe('spoken');
    // Append-only: both lines are still there, in order.
    const announcements = indexLines('doc-fallback').filter((l) => 'announced' in l);
    expect(announcements.map((l) => l.announced)).toEqual(['device', 'spoken']);
  });

  it('writes no line when the claim repeats one already made', () => {
    const meeting = start('doc-noop');
    meeting?.setAnnounced('spoken');
    meeting?.setAnnounced('spoken');
    meeting?.stop();
    expect(indexLines('doc-noop').filter((l) => 'announced' in l)).toHaveLength(1);
  });

  it('ignores a claim after the meeting stopped', () => {
    const meeting = start('doc-late');
    meeting?.stop();
    meeting?.setAnnounced('spoken');
    const read = listMeetings(dataDir, 'doc-late')[0];
    expect(read && 'announced' in read).toBe(false);
  });

  it('does not invent a path from an unreadable index line', () => {
    // The permissive direction here would write a consent record out of a
    // typo, so an unknown value has to fold to "nothing is claimed".
    const meeting = start('doc-garbage');
    meeting?.setAnnounced('device');
    meeting?.stop();
    appendFileSync(
      meetingIndexPath(dataDir, 'doc-garbage'),
      `${JSON.stringify({ meetingId: meeting?.meetingId, announced: 'shouted' })}\n`,
    );
    expect(listMeetings(dataDir, 'doc-garbage')[0]?.announced).toBe('device');
  });

  it('REFUSES a claim on a solo meeting, however the frame got here', () => {
    // The frame is client-controlled and a solo capture had nobody to
    // announce to, so the invariant is enforced where the record is written
    // rather than trusted of whatever opened the socket.
    const meeting = start('doc-solo-claim', 'solo');
    meeting?.setAnnounced('device');
    const record = meeting?.stop();
    expect(record && 'announced' in record).toBe(false);
    expect(indexLines('doc-solo-claim').some((l) => 'announced' in l)).toBe(false);
    const read = listMeetings(dataDir, 'doc-solo-claim')[0];
    expect(read && 'announced' in read).toBe(false);
  });

  it('a solo meeting nobody claimed anything for reads back with no field', () => {
    const meeting = start('doc-solo', 'solo');
    meeting?.stop();
    const read = listMeetings(dataDir, 'doc-solo')[0];
    expect(read?.mode).toBe('solo');
    expect(read && 'announced' in read).toBe(false);
  });
});
