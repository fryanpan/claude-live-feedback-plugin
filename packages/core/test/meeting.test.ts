import { describe, expect, it } from 'vitest';
import { parseMeetingTranscriptEvent } from '../src/meeting-bot.ts';
import {
  DEFAULT_ROOM_SPEAKERS,
  MAX_ROOM_SPEAKERS,
  MAX_SPEAKER_NAME,
  MEETING_AUDIO_ENCODING,
  MIN_ROOM_SPEAKERS,
  RECORDING_CONSENT_NOTE,
  detectsSpeakers,
  maxSpeakersFor,
  parseCaptureMode,
  parseEngineName,
  parseMeetingClientMessage,
  parseRoomSpeakers,
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

describe('room speaker cap', () => {
  it('caps a conversation at the room it was told about, and at two when it was told nothing', () => {
    expect(maxSpeakersFor('conversation')).toBe(DEFAULT_ROOM_SPEAKERS);
    expect(maxSpeakersFor('conversation', 4)).toBe(4);
  });

  it('asks for no cap at all on a solo capture', () => {
    // Not "a cap of one": a solo session sends no `speaker_labels` either, so
    // a cap would be a parameter with nothing to apply. Both directions
    // matter — a builder that always returned a number and one that always
    // returned undefined each pass half of this.
    expect(maxSpeakersFor('solo')).toBeUndefined();
    expect(maxSpeakersFor('solo', 4)).toBeUndefined();
  });

  it('clamps a room size into the range the engine accepts rather than refusing it', () => {
    // The number reaches here from an address bar. Out of range, the engine
    // refuses the whole session, which would read as "transcription is
    // broken" rather than "that number is silly".
    expect(parseRoomSpeakers(0)).toBe(MIN_ROOM_SPEAKERS);
    expect(parseRoomSpeakers(99)).toBe(MAX_ROOM_SPEAKERS);
    expect(parseRoomSpeakers('3')).toBe(3);
    expect(parseRoomSpeakers(2.4)).toBe(2);
  });

  it('says nothing for a room size nobody gave, so the default lives in one place', () => {
    expect(parseRoomSpeakers(undefined)).toBeUndefined();
    // `?speakers=` with the value deleted. `Number('')` is 0, which would
    // clamp to ONE label and merge the room into a single voice — the
    // opposite of the cap's purpose, from a parameter that said nothing.
    expect(parseRoomSpeakers('')).toBeUndefined();
    expect(parseRoomSpeakers('   ')).toBeUndefined();
    expect(parseRoomSpeakers('two')).toBeUndefined();
    expect(parseRoomSpeakers(null)).toBeUndefined();
  });

  it('carries a room size on the start frame, and leaves it off when unreadable', () => {
    const start = (over: Record<string, unknown>) =>
      parseMeetingClientMessage(
        JSON.stringify({
          type: 'start',
          sampleRate: 16_000,
          encoding: MEETING_AUDIO_ENCODING,
          mode: 'conversation',
          ...over,
        }),
      );
    expect(start({ speakers: 3 })).toMatchObject({ speakers: 3 });
    expect(start({ speakers: 40 })).toMatchObject({ speakers: MAX_ROOM_SPEAKERS });
    // A frame from a client built before the cap existed is a valid frame,
    // not a refused one — it just says nothing about the room.
    expect(start({})).not.toHaveProperty('speakers');
    expect(start({ speakers: 'lots' })).not.toHaveProperty('speakers');
  });

  it('carries a chosen engine on the start frame, and drops an unknown one', () => {
    const start = (over: Record<string, unknown>) =>
      parseMeetingClientMessage(
        JSON.stringify({
          type: 'start',
          sampleRate: 16_000,
          encoding: MEETING_AUDIO_ENCODING,
          mode: 'solo',
          ...over,
        }),
      );
    expect(start({ engine: 'soniox' })).toMatchObject({ engine: 'soniox' });
    expect(start({ engine: 'assemblyai' })).toMatchObject({ engine: 'assemblyai' });
    // A frame from a client built before the choice existed says nothing, and
    // an unknown name says nothing rather than refusing the meeting — absent
    // is the server's default, decided in one place.
    expect(start({})).not.toHaveProperty('engine');
    expect(start({ engine: 'mock' })).not.toHaveProperty('engine');
    expect(start({ engine: 42 })).not.toHaveProperty('engine');
  });
});

describe('parseEngineName', () => {
  it('reads the engines a client may name, and nothing else', () => {
    expect(parseEngineName('assemblyai')).toBe('assemblyai');
    expect(parseEngineName('assemblyai-pro')).toBe('assemblyai-pro');
    expect(parseEngineName('soniox')).toBe('soniox');
    // The mock is deliberately not nameable from a browser: a wordless
    // meeting must not be one a client can talk a server into.
    expect(parseEngineName('mock')).toBeUndefined();
    expect(parseEngineName('')).toBeUndefined();
    expect(parseEngineName(null)).toBeUndefined();
  });
});

describe('the recording consent note', () => {
  it('is one fixed line, addressed to whoever is recording', () => {
    // Fixed because it is the whole of what replaced a consent STEP: a line
    // composed per meeting would be one nobody could point at afterwards,
    // and the one this replaced was a sentence spoken to the room. This one
    // is second-person — it tells the person holding the device that the
    // asking is theirs to do.
    expect(RECORDING_CONSENT_NOTE).toMatch(/consent/i);
    expect(RECORDING_CONSENT_NOTE).toMatch(/\byou(?:'ve|r|)\b/i);
    expect(RECORDING_CONSENT_NOTE.split(/[.!?]/).filter((s) => s.trim()).length).toBe(1);
  });

  it('claims nothing on anybody’s behalf', () => {
    // The step it replaced ended in a RECORD — "the room was told, this
    // way" — and the whole reason it came out is that the client could not
    // stand behind that claim. This line must not sound like one either: it
    // says what the person confirms by recording, never that a room was
    // told or that anyone agreed.
    expect(RECORDING_CONSENT_NOTE).not.toMatch(
      /\b(?:everyone|the room|has been|were) (?:knows|told|notified)\b/i,
    );
    expect(RECORDING_CONSENT_NOTE).toMatch(/^By recording/);
  });
});

/**
 * The consent step's own frame is gone, and this is the negative control for
 * that: `announced` was a client→server message with a parse branch of its
 * own, and a parser that still answered it would keep the removed step alive
 * on the wire even with every button off the screen.
 */
describe('the announcement frame is gone from the wire', () => {
  it('drops an `announced` frame the way it drops any unknown type', () => {
    expect(
      parseMeetingClientMessage(JSON.stringify({ type: 'announced', by: 'device' })),
    ).toBeNull();
    expect(
      parseMeetingClientMessage(JSON.stringify({ type: 'announced', by: 'spoken' })),
    ).toBeNull();
    expect(
      parseMeetingClientMessage(JSON.stringify({ type: 'announced', by: 'skipped' })),
    ).toBeNull();
  });

  it('still reads the frames that were never part of it', () => {
    // The positive control. Without it the assertions above pass just as
    // well against a parser that has stopped reading anything at all.
    expect(parseMeetingClientMessage(JSON.stringify({ type: 'stop' }))).toEqual({ type: 'stop' });
    expect(
      parseMeetingClientMessage(
        JSON.stringify({ type: 'name_speaker', speaker: 'A', name: 'Jordan' }),
      ),
    ).toEqual({ type: 'name_speaker', speaker: 'A', name: 'Jordan' });
  });

  it('never let the start frame carry one either, and still does not', () => {
    const frame = parseMeetingClientMessage(
      JSON.stringify({
        type: 'start',
        sampleRate: 16_000,
        encoding: MEETING_AUDIO_ENCODING,
        mode: 'conversation',
        announced: 'device',
      }),
    );
    expect(frame).toMatchObject({ mode: 'conversation' });
    expect(frame && 'announced' in frame).toBe(false);
  });
});

describe('parseMeetingTranscriptEvent — the bot path’s live turn on the doc stream', () => {
  it('reads the SSE data line into the shared transcript shape, name and all', () => {
    const raw = JSON.stringify({
      event: 'meeting.transcript',
      docId: 'doc-1',
      meetingId: 'm-1',
      turn: 3,
      text: 'So the sync.',
      final: true,
      speaker: 'p7',
      speakerName: 'Rowan Pike',
    });
    expect(parseMeetingTranscriptEvent(raw)).toEqual({
      event: 'meeting.transcript',
      docId: 'doc-1',
      meetingId: 'm-1',
      turn: 3,
      text: 'So the sync.',
      final: true,
      speaker: 'p7',
      speakerName: 'Rowan Pike',
    });
  });

  it('tolerates what the socket frame tolerates: no speaker, no name, a missing final', () => {
    expect(parseMeetingTranscriptEvent({ turn: 0, text: 'hi' })).toEqual({
      event: 'meeting.transcript',
      docId: '',
      meetingId: '',
      turn: 0,
      text: 'hi',
      final: false,
    });
  });

  it('refuses a frame without a turn number or text — the two facts a fold needs', () => {
    expect(parseMeetingTranscriptEvent({ text: 'hi' })).toBeNull();
    expect(parseMeetingTranscriptEvent({ turn: 1 })).toBeNull();
    expect(parseMeetingTranscriptEvent({ turn: Number.NaN, text: 'x' })).toBeNull();
    expect(parseMeetingTranscriptEvent('not json')).toBeNull();
    expect(parseMeetingTranscriptEvent(null)).toBeNull();
  });
});

describe('the participant on the start frame', () => {
  const start = (extra: Record<string, unknown>) =>
    parseMeetingClientMessage(
      JSON.stringify({ type: 'start', sampleRate: 16_000, encoding: 'pcm_s16le', ...extra }),
    );

  it('carries the signed-in name, trimmed and bounded, and drops an empty one', () => {
    expect(start({ participant: '  Devi Raman ' })).toMatchObject({ participant: 'Devi Raman' });
    expect(start({ participant: '   ' })).not.toHaveProperty('participant');
    expect(start({ participant: 42 })).not.toHaveProperty('participant');
    expect(start({})).not.toHaveProperty('participant');
    const long = start({ participant: 'x'.repeat(200) }) as { participant?: string } | null;
    expect(long?.participant?.length).toBe(MAX_SPEAKER_NAME);
  });
});
