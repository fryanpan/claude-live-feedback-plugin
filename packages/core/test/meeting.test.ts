import { describe, expect, it } from 'vitest';
import {
  MEETING_AUDIO_ENCODING,
  RECORDING_ANNOUNCEMENT,
  announcesRecording,
  detectsSpeakers,
  parseAnnouncedBy,
  parseCaptureMode,
  parseMeetingClientMessage,
  speakerDisplayName,
} from '../src/meeting.ts';

describe('parseMeetingClientMessage', () => {
  it('accepts start and stop', () => {
    expect(
      parseMeetingClientMessage(
        JSON.stringify({ type: 'start', sampleRate: 16_000, encoding: MEETING_AUDIO_ENCODING }),
      ),
      // No mode named: solo, which is the mode that spends nothing. A client
      // built before modes existed sends exactly this frame.
    ).toEqual({
      type: 'start',
      sampleRate: 16_000,
      encoding: MEETING_AUDIO_ENCODING,
      mode: 'solo',
    });
    expect(parseMeetingClientMessage(JSON.stringify({ type: 'stop' }))).toEqual({ type: 'stop' });
  });

  it('carries a conversation mode, and falls back to solo for anything else', () => {
    const start = (mode: unknown) =>
      parseMeetingClientMessage(
        JSON.stringify({
          type: 'start',
          sampleRate: 16_000,
          encoding: MEETING_AUDIO_ENCODING,
          mode,
        }),
      );
    expect(start('conversation')).toMatchObject({ mode: 'conversation' });
    // A mode nobody recognises must not be READ as a conversation: the
    // fallback is the one that cannot run up a bill.
    expect(start('multi')).toMatchObject({ mode: 'solo' });
    expect(start(7)).toMatchObject({ mode: 'solo' });
    expect(start(undefined)).toMatchObject({ mode: 'solo' });
  });

  it('accepts a speaker name, trimmed, and refuses an empty or oversized one', () => {
    expect(
      parseMeetingClientMessage(
        JSON.stringify({ type: 'name_speaker', speaker: 'A', name: '  Jordan  ' }),
      ),
    ).toEqual({ type: 'name_speaker', speaker: 'A', name: 'Jordan' });
    expect(
      parseMeetingClientMessage(JSON.stringify({ type: 'name_speaker', speaker: 'A', name: '  ' })),
    ).toBeNull();
    expect(
      parseMeetingClientMessage(JSON.stringify({ type: 'name_speaker', speaker: '', name: 'J' })),
    ).toBeNull();
    expect(
      parseMeetingClientMessage(
        JSON.stringify({ type: 'name_speaker', speaker: 'A', name: 'x'.repeat(200) }),
      ),
    ).toBeNull();
    expect(
      parseMeetingClientMessage(JSON.stringify({ type: 'name_speaker', speaker: 'A' })),
    ).toBeNull();
  });
});

describe('capture mode', () => {
  it('only a conversation buys diarization', () => {
    expect(detectsSpeakers('conversation')).toBe(true);
    expect(detectsSpeakers('solo')).toBe(false);
  });

  it('reads a stored mode, defaulting anything unreadable to solo', () => {
    expect(parseCaptureMode('conversation')).toBe('conversation');
    expect(parseCaptureMode('solo')).toBe('solo');
    expect(parseCaptureMode(null)).toBe('solo');
  });
});

describe('speakerDisplayName', () => {
  it('is the given name, or "Speaker <label>" until one is given', () => {
    expect(speakerDisplayName('A', {})).toBe('Speaker A');
    expect(speakerDisplayName('A', { A: 'Jordan' })).toBe('Jordan');
    expect(speakerDisplayName('B', { A: 'Jordan' })).toBe('Speaker B');
  });
});

describe('the recording announcement', () => {
  it('is one fixed sentence, short enough to be said over a conversation', () => {
    // Fixed because it is the thing anyone would be asked to show afterwards:
    // a sentence composed per meeting is one nobody can quote back.
    expect(RECORDING_ANNOUNCEMENT).toMatch(/recorded/i);
    expect(RECORDING_ANNOUNCEMENT.split(/[.!?]/).filter((s) => s.trim()).length).toBe(1);
    expect(RECORDING_ANNOUNCEMENT.length).toBeLessThan(120);
  });

  it('says nothing about WHO is recording, so either mouth can say it', () => {
    // The device says these words and so does a person reading them off the
    // strip. A first-person sentence would need a second sentence.
    expect(RECORDING_ANNOUNCEMENT).not.toMatch(/\bI\b|\bmy\b/);
  });

  it('is made only where there is a room to make it to', () => {
    expect(announcesRecording('conversation')).toBe(true);
    expect(announcesRecording('solo')).toBe(false);
  });
});

describe('parseAnnouncedBy', () => {
  it('reads the two paths', () => {
    expect(parseAnnouncedBy('device')).toBe('device');
    expect(parseAnnouncedBy('spoken')).toBe('spoken');
  });

  it('answers UNDEFINED for anything else rather than defaulting', () => {
    // The direction matters: this field is the evidence a room was told, so
    // an unreadable value has to mean "no claim", never a claim nobody made.
    expect(parseAnnouncedBy(undefined)).toBeUndefined();
    expect(parseAnnouncedBy(null)).toBeUndefined();
    expect(parseAnnouncedBy('')).toBeUndefined();
    expect(parseAnnouncedBy('DEVICE')).toBeUndefined();
    expect(parseAnnouncedBy(true)).toBeUndefined();
  });
});

describe('the announcement on the wire', () => {
  const startFrame = (extra: Record<string, unknown>) =>
    parseMeetingClientMessage(
      JSON.stringify({
        type: 'start',
        sampleRate: 16_000,
        encoding: MEETING_AUDIO_ENCODING,
        mode: 'conversation',
        ...extra,
      }),
    );

  it('is NEVER carried by the start frame', () => {
    // A claim made when the microphone opened is a claim about something
    // that has not happened yet, and a meeting stopped mid-sentence would
    // leave it standing. The parser drops the field outright.
    const frame = startFrame({ announced: 'device' });
    expect(frame).toMatchObject({ mode: 'conversation' });
    expect(frame && 'announced' in frame).toBe(false);
  });

  it('is its own frame, sent after the room has actually been told', () => {
    expect(parseMeetingClientMessage(JSON.stringify({ type: 'announced', by: 'spoken' }))).toEqual({
      type: 'announced',
      by: 'spoken',
    });
    expect(parseMeetingClientMessage(JSON.stringify({ type: 'announced', by: 'device' }))).toEqual({
      type: 'announced',
      by: 'device',
    });
  });

  it('drops a frame that names no path rather than defaulting one', () => {
    expect(parseMeetingClientMessage(JSON.stringify({ type: 'announced' }))).toBeNull();
    expect(
      parseMeetingClientMessage(JSON.stringify({ type: 'announced', by: 'shouted' })),
    ).toBeNull();
  });
});
