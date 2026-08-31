import { describe, expect, it } from 'vitest';
import {
  MEETING_AUDIO_ENCODING,
  detectsSpeakers,
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
