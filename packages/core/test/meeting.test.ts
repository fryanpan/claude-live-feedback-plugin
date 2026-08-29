import { describe, expect, it } from 'vitest';
import { MEETING_AUDIO_ENCODING, parseMeetingClientMessage, speakerDisplayName } from '../src/meeting.ts';

describe('parseMeetingClientMessage', () => {
  it('accepts start and stop', () => {
    expect(
      parseMeetingClientMessage(
        JSON.stringify({ type: 'start', sampleRate: 16_000, encoding: MEETING_AUDIO_ENCODING }),
      ),
    ).toEqual({ type: 'start', sampleRate: 16_000, encoding: MEETING_AUDIO_ENCODING });
    expect(parseMeetingClientMessage(JSON.stringify({ type: 'stop' }))).toEqual({ type: 'stop' });
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

describe('speakerDisplayName', () => {
  it('is the given name, or "Speaker <label>" until one is given', () => {
    expect(speakerDisplayName('A', {})).toBe('Speaker A');
    expect(speakerDisplayName('A', { A: 'Jordan' })).toBe('Jordan');
    expect(speakerDisplayName('B', { A: 'Jordan' })).toBe('Speaker B');
  });
});
