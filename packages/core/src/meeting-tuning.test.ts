import { describe, expect, it } from 'vitest';
import {
  liveTuningKeys,
  maxSpeakersFromTuning,
  parseRawTuning,
  pickLiveTuning,
  sanitizeTuning,
  tuningSpecsFor,
} from './meeting-tuning.ts';
import { parseMeetingClientMessage } from './meeting.ts';

describe('sanitizeTuning', () => {
  it('keeps known keys, clamps ranges, and drops the rest', () => {
    const clean = sanitizeTuning('assemblyai', {
      end_of_turn_confidence_threshold: 1.7,
      min_turn_silence: 50, // below the floor
      max_turn_silence: '2000', // numeric string is a number typed in a field
      vad_threshold: 0.25,
      not_a_knob: 12,
      sample_rate: 48_000, // never a tuning key — the pipeline owns it
    });
    expect(clean).toEqual({
      end_of_turn_confidence_threshold: 1,
      min_turn_silence: 100,
      max_turn_silence: 2000,
      vad_threshold: 0.25,
    });
  });

  it('rounds integer knobs and leaves float knobs alone', () => {
    const clean = sanitizeTuning('soniox', {
      endpoint_sensitivity: -0.35,
      max_endpoint_delay_ms: 1550.6,
      endpoint_latency_adjustment_level: 2.4,
    });
    expect(clean).toEqual({
      endpoint_sensitivity: -0.35,
      max_endpoint_delay_ms: 1551,
      endpoint_latency_adjustment_level: 2,
    });
  });

  it('an unknown engine (the mock) accepts nothing', () => {
    expect(sanitizeTuning('mock', { min_turn_silence: 500 })).toEqual({});
  });

  it('enum knobs take only their own choices', () => {
    expect(sanitizeTuning('assemblyai-pro', { mode: 'max_accuracy' })).toEqual({
      mode: 'max_accuracy',
    });
    expect(sanitizeTuning('assemblyai-pro', { mode: 'turbo' })).toEqual({});
    // The confidence knob is Universal Streaming only — pro has no such
    // parameter, so it must not survive onto a pro URL.
    expect(sanitizeTuning('assemblyai-pro', { end_of_turn_confidence_threshold: 0.5 })).toEqual({});
  });

  it('terms are trimmed, deduplicated, capped, and an empty list is dropped', () => {
    const clean = sanitizeTuning('assemblyai', {
      keyterms_prompt: ['  Yjs ', 'Yjs', '', 42, 'CRDT'],
    });
    expect(clean).toEqual({ keyterms_prompt: ['Yjs', 'CRDT'] });
    expect(sanitizeTuning('assemblyai', { keyterms_prompt: ['', '  '] })).toEqual({});
  });

  it('booleans are literal booleans, never truthiness', () => {
    expect(sanitizeTuning('assemblyai-pro', { continuous_partials: false })).toEqual({
      continuous_partials: false,
    });
    expect(sanitizeTuning('assemblyai-pro', { continuous_partials: 'yes' })).toEqual({});
  });
});

describe('the live set', () => {
  it('soniox has no live knobs at all — its protocol has no update message', () => {
    expect(liveTuningKeys('soniox').size).toBe(0);
  });

  it('assemblyai live set is the UpdateConfiguration turn-detection set', () => {
    expect([...liveTuningKeys('assemblyai')].sort()).toEqual([
      'end_of_turn_confidence_threshold',
      'keyterms_prompt',
      'max_turn_silence',
      'min_turn_silence',
      'vad_threshold',
    ]);
  });

  it('pro adds mode and continuous_partials; max_speakers is never live', () => {
    const live = liveTuningKeys('assemblyai-pro');
    expect(live.has('mode')).toBe(true);
    expect(live.has('continuous_partials')).toBe(true);
    expect(live.has('max_speakers')).toBe(false);
    expect(liveTuningKeys('assemblyai').has('max_speakers')).toBe(false);
  });

  it('pickLiveTuning filters an already-clean object to the live keys', () => {
    const picked = pickLiveTuning('assemblyai', {
      vad_threshold: 0.6,
      max_speakers: 4,
    });
    expect(picked).toEqual({ vad_threshold: 0.6 });
  });
});

describe('maxSpeakersFromTuning', () => {
  it('reads the cap when set and answers uncapped (undefined) otherwise', () => {
    expect(maxSpeakersFromTuning({ max_speakers: 4 })).toBe(4);
    expect(maxSpeakersFromTuning({})).toBeUndefined();
  });
});

describe('the wire frames', () => {
  it('a start frame carries tuning through, and an empty object survives', () => {
    const msg = parseMeetingClientMessage(
      JSON.stringify({
        type: 'start',
        sampleRate: 16_000,
        encoding: 'pcm_s16le',
        mode: 'solo',
        tuning: {},
      }),
    );
    expect(msg?.type === 'start' && msg.tuning).toEqual({});
  });

  it('a start frame without tuning parses with the field absent — the legacy path', () => {
    const msg = parseMeetingClientMessage(
      JSON.stringify({ type: 'start', sampleRate: 16_000, encoding: 'pcm_s16le', mode: 'solo' }),
    );
    expect(msg?.type === 'start' && 'tuning' in msg).toBe(false);
  });

  it('a tune frame parses; unreadable values are dropped, not fatal', () => {
    const msg = parseMeetingClientMessage(
      JSON.stringify({
        type: 'tune',
        settings: { vad_threshold: 0.5, nested: { no: true } },
      }),
    );
    expect(msg).toEqual({ type: 'tune', settings: { vad_threshold: 0.5 } });
  });

  it('parseRawTuning refuses non-objects and oversized values', () => {
    expect(parseRawTuning('vad=1')).toBeUndefined();
    expect(parseRawTuning(['a'])).toBeUndefined();
    expect(parseRawTuning({ big: 'x'.repeat(300) })).toEqual({});
  });
});

describe('spec sanity', () => {
  it('every engine names each key once', () => {
    for (const engine of ['soniox', 'assemblyai', 'assemblyai-pro']) {
      const keys = tuningSpecsFor(engine).map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
