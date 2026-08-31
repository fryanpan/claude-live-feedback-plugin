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

import type { MeetingTimingMark } from './meeting-timing.ts';

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

/**
 * What the room hears when an in-person capture starts.
 *
 * ONE SENTENCE, FIXED, NOT LOCALIZED. It is the thing that makes a recording
 * defensible, so it must read the same every time and be quotable back — a
 * sentence composed per meeting is one nobody can point at afterwards. It is
 * deliberately passive about who is recording: the same words are correct
 * whether the device says them or the person in the room reads them aloud,
 * and a sentence that only worked in one of those mouths would need a second
 * sentence for the other.
 *
 * Short because it is spoken over the top of a conversation that has already
 * started, and because a long one gets talked over, which is the failure mode
 * an announcement cannot have.
 */
export const RECORDING_ANNOUNCEMENT =
  'Just so everyone knows, this conversation is being recorded and transcribed.';

/**
 * Whose mouth the announcement came out of.
 *
 * `device` is the default — the browser speaks it, which is the only path
 * that needs nothing of the person holding the iPad. `spoken` means the
 * sentence was put ON SCREEN for a human to read out instead, either because
 * they asked to say it themselves or because speech synthesis was unavailable
 * or refused.
 *
 * `spoken` is a weaker claim than `device` and the record must not be read as
 * if it were not: the client knows it displayed the sentence, and it cannot
 * know that anybody actually read it. Absent means no announcement was made
 * at all — a `solo` capture, or a client built before this existed.
 */
export type AnnouncedBy = 'device' | 'spoken';

/** The path taken when nobody asked for the other one. */
export const DEFAULT_ANNOUNCED_BY: AnnouncedBy = 'device';

/**
 * An announcement path, or `undefined` for anything else.
 *
 * Undefined rather than a default, and that is the whole point: this field is
 * the evidence that a room was told it was being recorded, so an unreadable
 * value has to come back as "nothing is claimed" rather than as a claim
 * nobody made. The permissive direction here would write a consent record out
 * of a typo.
 */
export function parseAnnouncedBy(raw: unknown): AnnouncedBy | undefined {
  return raw === 'device' || raw === 'spoken' ? raw : undefined;
}

/** Whether a capture in this mode announces itself. Only a room needs telling. */
export function announcesRecording(mode: CaptureMode): boolean {
  return mode === 'conversation';
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
      /**
       * Measure this meeting's stage latencies (`?timing=1` on the address).
       * Absent on every ordinary meeting, and a server that is not asked
       * allocates nothing and attaches nothing — see `meeting-timing.ts`.
       */
      timing?: boolean;
    }
  | { type: 'stop' }
  /**
   * One half of an NTP-style exchange, so the two network legs can be priced
   * across two clocks. Answered with `timing_pong` and nothing else; it never
   * touches the meeting's state.
   */
  | { type: 'timing_ping'; id: number; clientMs: number }
  /**
   * "Speaker A is Jordan." The engine labels voices within one session; the
   * person names a label once and every turn with it — on the strip, in the
   * record, in the notes — reads as the name from then on. Per meeting: the
   * same letter is a different person next time.
   */
  | { type: 'name_speaker'; speaker: string; name: string }
  /**
   * The room HAS been told, this way.
   *
   * Sent after the fact and never with the `start` frame, and that is the
   * whole design: a claim made at the moment the mic opened would be a claim
   * about something that had not happened yet, and a meeting stopped
   * mid-sentence would leave it standing. `device` goes up only once the
   * browser reports the utterance finished; `spoken` goes up the moment the
   * sentence is put on screen, which is all `spoken` has ever claimed. A
   * meeting that ends before either is a meeting whose record says nothing —
   * which is the honest answer.
   */
  | { type: 'announced'; by: AnnouncedBy };

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
  | {
      type: 'transcript';
      turn: number;
      text: string;
      final: boolean;
      speaker?: string;
      /** Stage marks for this frame, present only on a timing meeting. */
      timing?: MeetingTimingMark;
    }
  /** The answer to a `timing_ping`, carrying both server-side timestamps. */
  | {
      type: 'timing_pong';
      id: number;
      clientMs: number;
      serverRecvMs: number;
      serverSendMs: number;
    }
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
  if (m.type === 'announced') {
    const by = parseAnnouncedBy(m.by);
    // A frame that names no path says nothing, and the record says nothing
    // in turn — the permissive direction would write a consent claim out of
    // a typo.
    return by ? { type: 'announced', by } : null;
  }
  if (m.type === 'timing_ping') {
    if (typeof m.id !== 'number' || !Number.isFinite(m.id)) return null;
    if (typeof m.clientMs !== 'number' || !Number.isFinite(m.clientMs)) return null;
    return { type: 'timing_ping', id: m.id, clientMs: m.clientMs };
  }
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
      // Only the literal `true` opts in: a stray truthy value on this frame
      // should read as a client that does not know about timing, not as one
      // asking for it.
      ...(m.timing === true ? { timing: true } : {}),
    };
  }
  return null;
}
