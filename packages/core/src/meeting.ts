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
       * How the room was told, when it was told at all. Absent on a `solo`
       * capture (nobody to tell) and on a client built before announcements.
       * It is the CHOICE at the moment the mic opened; an `announced` frame
       * later corrects it if that choice could not be carried out.
       */
      announced?: AnnouncedBy;
    }
  | { type: 'stop' }
  /**
   * "Speaker A is Jordan." The engine labels voices within one session; the
   * person names a label once and every turn with it — on the strip, in the
   * record, in the notes — reads as the name from then on. Per meeting: the
   * same letter is a different person next time.
   */
  | { type: 'name_speaker'; speaker: string; name: string }
  /**
   * The announcement path, revised after the fact. Sent when the device was
   * asked to speak and could not — no speech synthesis, a voice that never
   * started — and the strip fell back to putting the sentence on screen. The
   * record takes the last one, so what it ends up saying is what actually
   * happened rather than what was intended.
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
  if (m.type === 'announced') {
    const by = parseAnnouncedBy(m.by);
    // A frame that names no path says nothing; dropping it leaves the record
    // with the path the start frame claimed, which is the honest fallback.
    return by ? { type: 'announced', by } : null;
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
    return {
      type: 'start',
      sampleRate: Math.round(rate),
      encoding: MEETING_AUDIO_ENCODING,
      // A missing or unreadable mode is `solo` rather than a refused frame:
      // the field arrived after the meeting did, and the fallback is the one
      // that spends nothing.
      mode: parseCaptureMode(m.mode),
      // Spread, not a bare property: `announced: undefined` on the object
      // would serialize back out of the record as a field that exists, and
      // "the room was told nothing" has to stay absent rather than present
      // and empty.
      ...(parseAnnouncedBy(m.announced) ? { announced: parseAnnouncedBy(m.announced) } : {}),
    };
  }
  return null;
}
