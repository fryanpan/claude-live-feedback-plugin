/**
 * The live-meeting wire contract, shared by the browser capture and the
 * server relay.
 *
 * WHY AUDIO GETS ITS OWN SOCKET AND THE WORDS COME BACK DOWN IT. Doc events
 * already have a push channel — the SSE hub — but it keeps a replay buffer
 * of the last 200 events per channel so a reconnecting client can catch up.
 * A word-by-word transcript emits at conversational speed, which would evict
 * every real doc event from that buffer within a minute of a meeting. So the
 * transcript rides back down the same socket the audio went up: the client
 * that opened the mic is the one rendering the strip, nothing else needs the
 * partials, and no shared buffer is thrashed. Only the low-rate lifecycle
 * facts — a meeting started, a meeting stopped — go out over SSE, where
 * other viewers of the doc can see that recording is live.
 *
 * WHY THE SOCKET IS THE LIFECYCLE. Opening this socket starts the meeting and
 * closing it stops the meeting. A separate REST start/stop would introduce a
 * state the two halves can disagree about — a meeting marked live whose audio
 * socket never connected, or a socket streaming into a meeting the server
 * thinks ended. There is one fact here and one owner of it.
 */

/** The audio the capture promises to send: mono, little-endian signed 16-bit. */
export const MEETING_AUDIO_ENCODING = 'pcm_s16le' as const;

/**
 * The sample rate the browser resamples to before sending. 16 kHz is the
 * floor every streaming speech model is trained at, and sending more than the
 * model uses only buys bandwidth.
 */
export const MEETING_SAMPLE_RATE = 16_000;

/** The WebSocket path for a doc's meeting audio. */
export function meetingSocketPath(docId: string): string {
  return `/audio/${encodeURIComponent(docId)}`;
}

/**
 * Who the microphone is expected to hear.
 *
 * `solo` is the default and the common case — Bryan talking to himself over a
 * doc — and it is the CHEAP one: diarization is a per-session surcharge on
 * top of the streaming rate ($0.12/hr against $0.15, so a 1.8x bill), and
 * guessing at a second speaker who is not in the room buys nothing. Nothing
 * announces an in-person conversation, so `conversation` is asked for: a
 * button that says this is a conversation, or the strip's own switch.
 */
export type CaptureMode = 'solo' | 'conversation';

/** The mode a capture runs in when nobody said otherwise. */
export const DEFAULT_CAPTURE_MODE: CaptureMode = 'solo';

/** Whether this mode pays for speaker labels. The one place that decides. */
export function detectsSpeakers(mode: CaptureMode): boolean {
  return mode === 'conversation';
}

/** A capture mode, or the default for anything else. */
export function parseCaptureMode(raw: unknown): CaptureMode {
  return raw === 'conversation' ? 'conversation' : DEFAULT_CAPTURE_MODE;
}

/**
 * How many people the room holds, and why the engine is TOLD.
 *
 * AssemblyAI's streaming diarization takes a `max_speakers` alongside
 * `speaker_labels` — "a hard cap on the number of speaker labels (1-10). If
 * more people speak than this value, the additional speakers are merged into
 * the closest existing label" (streaming/label-speakers-and-separate-channels,
 * read 2026-08-30). Left absent it is unbounded, and an unbounded diarizer in
 * a room where two people share ONE far-field microphone is free to answer a
 * change of posture with a new letter: the failure this cap exists to stop is
 * a model inventing people, not a model missing one.
 *
 * The docs also say to "give the model a little headroom above the number of
 * speakers you expect; setting it too high can cause over-splitting". We do
 * not take the headroom by default, because the two failures are not
 * symmetrical here: a third voice merged into the closest label costs one
 * misattributed turn, while an invented Speaker C costs the reader their
 * belief that the labels mean anything. The number is a knob (`?speakers=3`
 * on the doc address) precisely so a room that really holds three says so
 * rather than being guessed at.
 */
export const DEFAULT_ROOM_SPEAKERS = 2;

/** The range AssemblyAI accepts for `max_speakers`. Not ours to widen. */
export const MIN_ROOM_SPEAKERS = 1;
export const MAX_ROOM_SPEAKERS = 10;

/**
 * A room size, clamped into the engine's range, or nothing.
 *
 * Nothing — rather than the default — is the answer for an absent or
 * unreadable field, so the caller can tell "nobody said" from "somebody said
 * two" and apply the default in ONE place.
 */
export function parseRoomSpeakers(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n)) return undefined;
  const rounded = Math.round(n);
  if (rounded < MIN_ROOM_SPEAKERS) return MIN_ROOM_SPEAKERS;
  if (rounded > MAX_ROOM_SPEAKERS) return MAX_ROOM_SPEAKERS;
  return rounded;
}

/**
 * The cap this capture asks the engine for, or nothing when it asks for no
 * labels at all. A solo session sends neither parameter: an unpriced session
 * is one that never asked, and a cap on a feature that is off is noise on the
 * URL that a reader would have to work out is inert.
 */
export function maxSpeakersFor(mode: CaptureMode, speakers?: number): number | undefined {
  if (!detectsSpeakers(mode)) return undefined;
  return parseRoomSpeakers(speakers) ?? DEFAULT_ROOM_SPEAKERS;
}

/** Client → server. Sent as a JSON text frame; audio is sent as binary frames. */
export type MeetingClientMessage =
  | {
      type: 'start';
      sampleRate: number;
      encoding: typeof MEETING_AUDIO_ENCODING;
      /**
       * Absent means `solo`: a client built before modes existed, and a
       * person who never asked for the surcharge, get the same cheap
       * session.
       */
      mode: CaptureMode;
      /**
       * How many people are in the room, when the client knows. Only the
       * browser can know it — nothing on the server can hear the room — and
       * it is absent from every solo capture and from any client built before
       * the cap existed, both of which fall back to `DEFAULT_ROOM_SPEAKERS`.
       */
      speakers?: number;
    }
  | { type: 'stop' }
  /**
   * "Speaker A is Jordan." The engine labels voices within one session; the
   * person names a label once and every turn with it — on the strip, in the
   * record, in the notes — reads as the name from then on. Per meeting: the
   * same letter is a different person next time.
   */
  | { type: 'name_speaker'; speaker: string; name: string };

/** Longest name a speaker label can be given. A name, not a bio. */
export const MAX_SPEAKER_NAME = 60;

/**
 * What a turn's speaker is called: the name the person gave that label, or
 * the label itself with "Speaker" in front until they do. One function, so
 * the strip, the record and the notes never disagree about it.
 */
export function speakerDisplayName(label: string, names: Readonly<Record<string, string>>): string {
  return names[label] ?? `Speaker ${label}`;
}

/**
 * Why a meeting cannot be transcribed. Separated from a generic error because
 * the strip renders these as a settled state rather than a failure: nothing
 * is retrying, and the words are never coming.
 */
export type MeetingUnavailableReason =
  /** No API key on the server — the documented "transcription not configured". */
  | 'not_configured'
  /** A key exists but the engine refused or dropped the connection. */
  | 'engine_unavailable'
  /** Another socket already holds this doc's meeting. */
  | 'already_recording';

/** Server → client. Always a JSON text frame. */
export type MeetingServerMessage =
  /**
   * Transcription is live; words follow. `mode` is what the SERVER opened,
   * echoed back so the strip reports the session that is actually running
   * (and being billed) rather than the one the client asked for.
   */
  | { type: 'ready'; meetingId: string; startedAt: number; engine: string; mode: CaptureMode }
  /** No words will follow. The socket stays open so the strip can say why. */
  | { type: 'unavailable'; reason: MeetingUnavailableReason; message: string }
  /**
   * One turn of speech. `text` is the WHOLE turn as currently understood, not
   * a delta — a later message with the same `turn` replaces the earlier text
   * in place, which is how a mis-heard word gets corrected after it is already
   * on screen. `final` marks the engine done revising that turn. `speaker` is
   * the engine's label for the voice (`"A"`, `"B"`), absent until it has
   * decided; display goes through `speakerDisplayName`.
   */
  | { type: 'transcript'; turn: number; text: string; final: boolean; speaker?: string }
  /** The meeting ended; its transcript is durable. */
  | { type: 'stopped'; meetingId: string; endedAt: number }
  /** Something went wrong mid-meeting. Distinct from `unavailable`. */
  | { type: 'error'; message: string };

/** Parse a client frame, returning null for anything malformed. */
export function parseMeetingClientMessage(raw: unknown): MeetingClientMessage | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  if (m.type === 'stop') return { type: 'stop' };
  if (m.type === 'name_speaker') {
    const speaker = typeof m.speaker === 'string' ? m.speaker.trim() : '';
    const name = typeof m.name === 'string' ? m.name.trim() : '';
    if (!speaker || speaker.length > 16 || !name || name.length > MAX_SPEAKER_NAME) return null;
    return { type: 'name_speaker', speaker, name };
  }
  if (m.type === 'start') {
    const rate = m.sampleRate;
    // A rate the engine cannot be told about is worse than no meeting: the
    // audio would transcribe as noise and look like a bad microphone.
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 8000 || rate > 48_000) {
      return null;
    }
    if (m.encoding !== MEETING_AUDIO_ENCODING) return null;
    const speakers = parseRoomSpeakers(m.speakers);
    return {
      type: 'start',
      sampleRate: Math.round(rate),
      encoding: MEETING_AUDIO_ENCODING,
      // A missing or unreadable mode is `solo` rather than a refused frame:
      // the field arrived after the meeting did, and the fallback is the one
      // that spends nothing.
      mode: parseCaptureMode(m.mode),
      // Same rule for the room size, one step further: out of range is
      // clamped rather than refused, because a bad number here is a knob
      // typed into an address bar and the meeting is worth more than the
      // typo.
      ...(speakers !== undefined ? { speakers } : {}),
    };
  }
  return null;
}
