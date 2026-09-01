/**
 * The meeting chrome: one Record Audio button in the top bar that owns
 * everything audio, the live transcript strip fused under it, and the two
 * popovers behind the button — the speaker menu while recording, the start
 * chooser while not.
 *
 * IT IS THE ONLY SURFACE A MEETING HAS. The transcript is never written into
 * the document — the notes agent does that later, from the durable transcript
 * the server keeps — so every state a meeting can be left in has to arrive as
 * words here: a mic that was refused, an origin the browser will not give a
 * mic on at all, a server with no transcription key. A strip that renders
 * nothing in those cases is a Start button that does nothing when pressed,
 * which is the failure this file exists to avoid.
 *
 * IT RESERVES HEIGHT. The strip is the shell's second grid row, directly
 * under the top bar it grows out of, so the editor below is shorter by
 * exactly its height rather than running underneath it. Hidden, the row is
 * zero. Layout rules live in styles.css under MEETING RECORD CHROME and are
 * asserted in `meeting-strip-css.test.ts`, because no DOM test resolves
 * layout.
 *
 * EVERY CHOICE HAPPENS AT START TIME. The chooser collects the source
 * (microphone, or a bot sent to a Zoom / Google Meet call), whether the room
 * has one voice or several, and who tells the room about the recording — and
 * nothing after Start offers a knob: a streaming session's configuration IS
 * its connect URL, so switching mid-meeting would mean a second session and a
 * second bill for the same conversation. Stop and start again is the whole
 * story, and the menu says nothing else.
 *
 * IT ANNOUNCES A ROOM CAPTURE, AND THE ANNOUNCEMENT IS PART OF THE RECORDING.
 * A `conversation` capture is the one with other people in it, so it says so
 * out loud before anything else is said. The order is the point and it is the
 * opposite of the obvious one: the microphone opens FIRST and the sentence is
 * spoken into it, so the announcement is in the captured audio and in the
 * transcript rather than in a moment before the recording that nothing can be
 * shown afterwards. The "I'll ask for consent" checkbox starts the same
 * capture and puts the sentence on screen instead, for a person who would
 * rather say it themselves — and it is also where a device that cannot speak
 * ends up. A `solo` capture announces nothing; there is nobody to tell.
 *
 * CORRECTIONS LAND ON THE WORD ALREADY ON SCREEN. A `transcript` frame carries
 * the WHOLE turn as currently understood, so a later frame for the same turn
 * is the engine revising itself. `diffTurnWords` finds which words actually
 * moved and only those are rewritten and flashed — redrawing the line instead
 * would make every partial look like a correction.
 */

import {
  type AnnouncedBy,
  type CaptureMode,
  DEFAULT_ANNOUNCED_BY,
  DEFAULT_CAPTURE_MODE,
  MAX_SPEAKER_NAME,
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  type MeetingBotStatus,
  type MeetingServerMessage,
  type MeetingTimingMark,
  type MeetingUnavailableReason,
  RECORDING_ANNOUNCEMENT,
  announcesRecording,
  describeBotState,
  meetingSocketPath,
  parseCaptureMode,
  speakerDisplayName,
} from '@feedback/core';
import { type Announcer, createAnnouncer } from './meeting-announce.ts';
import {
  type MeetingCapture,
  type MeetingCaptureStart,
  ROOM_AUDIO_DEFAULT,
  type RoomAudioProcessing,
  captureConstraints,
  startMeetingCapture,
} from './meeting-audio.ts';
import type { MeetingBotClient } from './meeting-bot-client.ts';
import { type TimingSession, createTimingSession } from './meeting-timing-client.ts';
import type { DocSpeakers } from './speaker-voices.ts';

/**
 * How many turns stay on the strip. Three is what the flowing line holds
 * before the mask has faded the oldest out anyway.
 */
export const TRANSCRIPT_KEEP = 3;

/** How often the elapsed clock is redrawn. Twice a second: a second-resolution
 *  readout that ticks once a second visibly stalls whenever the two clocks
 *  drift out of phase. */
const CLOCK_MS = 500;

export interface TranscriptTurn {
  turn: number;
  text: string;
  final: boolean;
  /** The engine's label for the voice; the tag shows the name given to it. */
  speaker?: string;
}

/**
 * Fold one transcript frame into the rolling window.
 *
 * A turn already on the strip is replaced WHERE IT IS — that is the whole
 * correction mechanism. A turn that has already rolled off is dropped rather
 * than re-added, because appending it would put an old line at the live end of
 * the strip, which reads as the speaker repeating themselves.
 */
export function rollTranscript(
  turns: readonly TranscriptTurn[],
  next: TranscriptTurn,
  keep = TRANSCRIPT_KEEP,
): TranscriptTurn[] {
  const at = turns.findIndex((t) => t.turn === next.turn);
  if (at >= 0) {
    const out = turns.slice();
    out[at] = next;
    return out;
  }
  const newest =
    turns.length > 0 ? Math.max(...turns.map((t) => t.turn)) : Number.NEGATIVE_INFINITY;
  if (next.turn < newest) return turns.slice();
  return [...turns, next].slice(-keep);
}

/**
 * Which words of a turn the engine actually changed.
 *
 * Compared by position, which is what makes "check list" → "checklist" read
 * correctly: the word count moved, so everything from the change onward is
 * genuinely different text in a different place. A word past the end of the
 * previous text is NEW, not corrected — flashing it would mean flashing every
 * word as it is spoken.
 */
export function diffTurnWords(
  before: string,
  after: string,
): Array<{ text: string; changed: boolean }> {
  const old = before.split(/\s+/).filter((w) => w.length > 0);
  return after
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((text, i) => ({ text, changed: i < old.length && old[i] !== text }));
}

/** mm:ss, zero-padded, counting past an hour rather than wrapping. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/**
 * The optional timing block, all-or-nothing.
 *
 * A partial block would produce a sample with a leg computed from a missing
 * number, which is worse than no sample: it would land in the percentiles
 * looking like a measurement. Absent on every ordinary meeting.
 */
export function parseTimingMark(raw: unknown): MeetingTimingMark | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const t = raw as Record<string, unknown>;
  const keys = [
    'seq',
    'audioEndMs',
    'chunkAudioEndMs',
    'recvMs',
    'fwdMs',
    'engineMs',
    'sendMs',
  ] as const;
  const out = {} as Record<(typeof keys)[number], number>;
  for (const key of keys) {
    const v = t[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[key] = v;
  }
  return out;
}

/** Parse a server frame, returning null for anything malformed. */
export function parseMeetingServerMessage(raw: unknown): MeetingServerMessage | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  switch (m.type) {
    case 'ready':
      return {
        type: 'ready',
        meetingId: str(m.meetingId),
        startedAt: typeof m.startedAt === 'number' ? m.startedAt : 0,
        engine: str(m.engine),
        // The server's word on what it opened, not the client's on what it
        // asked for — those differ if a server built before modes existed
        // answers, and the one that is billed is this one.
        mode: parseCaptureMode(m.mode),
      };
    case 'unavailable': {
      const reason = m.reason;
      if (
        reason !== 'not_configured' &&
        reason !== 'engine_unavailable' &&
        reason !== 'already_recording'
      ) {
        return null;
      }
      return { type: 'unavailable', reason, message: str(m.message) };
    }
    case 'transcript': {
      if (typeof m.turn !== 'number' || typeof m.text !== 'string') return null;
      const timing = parseTimingMark(m.timing);
      return {
        type: 'transcript',
        turn: m.turn,
        text: m.text,
        final: m.final === true,
        ...(typeof m.speaker === 'string' && m.speaker ? { speaker: m.speaker } : {}),
        ...(timing ? { timing } : {}),
      };
    }
    case 'timing_pong': {
      const num = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null;
      const id = num(m.id);
      const clientMs = num(m.clientMs);
      const serverRecvMs = num(m.serverRecvMs);
      const serverSendMs = num(m.serverSendMs);
      if (id === null || clientMs === null || serverRecvMs === null || serverSendMs === null) {
        return null;
      }
      return { type: 'timing_pong', id, clientMs, serverRecvMs, serverSendMs };
    }
    case 'stopped':
      return {
        type: 'stopped',
        meetingId: str(m.meetingId),
        endedAt: typeof m.endedAt === 'number' ? m.endedAt : 0,
      };
    case 'error':
      return { type: 'error', message: str(m.message) };
    default:
      return null;
  }
}

/** What the meeting machinery is doing. */
export type StripState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'recording'; startedAt: number }
  | { kind: 'unavailable'; reason: MeetingUnavailableReason; message: string }
  /** The browser will not hand over a mic: an insecure origin, or a refusal. */
  | { kind: 'blocked'; message: string }
  | { kind: 'error'; message: string };

/** The slice of a WebSocket the strip uses — injectable so every state above
 *  can be driven in a test without a server. */
export interface MeetingSocket {
  send(data: string | ArrayBufferView): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

/** The doc's audio socket on this host. Same scheme rule as the Yjs socket. */
export function meetingSocketUrl(docId: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${meetingSocketPath(docId)}`;
}

/**
 * A transcription engine the chooser could offer.
 *
 * The Engine row renders only when there is more than one — a row with a
 * single answer is a fact wearing a control's clothes. Today the server runs
 * one engine and no caller passes two; the seam exists so the engine
 * integration that is in flight can slot its list in without reshaping the
 * chooser.
 */
export interface MeetingEngineChoice {
  id: string;
  label: string;
}

export interface MeetingStripOpts {
  docId: string;
  /** The shell element the strip renders into — `#meeting-strip`. */
  root: HTMLElement;
  /**
   * Where the Record Audio button docks — `#topbar .toolbar`. The strip
   * grows out of this button, which is why the button belongs to this mount
   * rather than to the static shell: they are one control in two boxes, and
   * they come and go together. Falls back to `root` where the shell has no
   * toolbar (a stripped embed, a test).
   */
  toolbar?: HTMLElement | null;
  /**
   * The doc's meeting-bot lifecycle, when the caller mounted one. Its verbs
   * (invite, leave) are behind the chooser and the menu; its state renders in
   * the strip. Absent — or present but unconfigured on this server — the
   * chooser simply never offers the bot source.
   */
  bot?: MeetingBotClient;
  /** The engines the chooser may offer; see `MeetingEngineChoice`. */
  engines?: MeetingEngineChoice[];
  /**
   * What the bot-name field starts as — "<who>'s Claude Code Agent" from the
   * signed-in identity. Absent, the server's configured default stands and
   * the field shows it as a placeholder-shaped fact rather than a value.
   */
  botNamePrefill?: string;
  now?: () => number;
  /** Run `fn` every `ms`; returns a canceller. Injectable so the clock is
   *  deterministic in tests. */
  interval?: (fn: () => void, ms: number) => () => void;
  openSocket?: (url: string) => MeetingSocket;
  startCapture?: (opts: {
    onFrame: (pcm: Int16Array) => void;
    mode: CaptureMode;
    room?: RoomAudioProcessing;
  }) => Promise<MeetingCaptureStart>;
  /**
   * Ask for the mic on mount, without a press — the Board's "Start a planning
   * huddle" button was the press, on a page that is gone by the time this
   * mounts. A browser that wants the gesture INSIDE this page refuses the
   * mic exactly the way it refuses a real denial; the strip cannot tell them
   * apart, so it offers a "tap to start the mic" note rather than reporting a
   * refusal nobody made. A tap is a gesture, so a refusal after that is
   * reported as what it is.
   */
  autoStart?: boolean;
  /**
   * What this capture expects to hear. `solo` opens a cheap session with no
   * diarization; `conversation` pays for speaker labels. The Board's "Record
   * a conversation" button carries it in on the address; the chooser's
   * Just me / Multiple Speakers choice sets it for a press made here.
   */
  mode?: CaptureMode;
  /**
   * How many people the room holds, and which microphone processors to ask
   * for. Both ride the address (`?speakers=3&mic=ec1-ns0-agc0`) and both are
   * about the ROOM, so neither means anything to a solo capture: the count
   * only reaches the engine when the mode pays for labels, and the processing
   * only replaces the defaults for a `conversation`.
   */
  speakers?: number;
  room?: RoomAudioProcessing;
  /**
   * Ask the person what to call a speaker; `current` is what the row says
   * now. Null or blank means leave it. Defaults to `window.prompt` — a name
   * is typed once per voice per meeting.
   */
  promptName?: (current: string) => string | null;
  /**
   * The last meeting's cast, asked for once at mount — what the chooser's
   * rename rows show on a doc opened AFTER its meeting ended. Null means
   * the doc has never held one. Absent, a reloaded chooser starts bare.
   */
  loadSpeakers?: () => Promise<DocSpeakers | null>;
  /**
   * Name a voice on a meeting whose audio socket is gone — the rename
   * channel once capture has stopped. Resolves true when the server recorded
   * it; false is a refusal the strip must not paper over, because a name
   * that only ever landed on screen reads as saved.
   */
  postName?: (meetingId: string, speaker: string, name: string) => Promise<boolean>;
  /**
   * Says the announcement out loud. Injectable because no test environment
   * has speech synthesis, and because the interesting cases here are the ones
   * where it does not work.
   */
  announcer?: Announcer;
  /**
   * Measure this meeting and show the running numbers (`?timing=1`). Off on
   * every ordinary load: nothing is constructed, no clock is read per audio
   * frame, and the `start` frame is byte-for-byte what it was. See
   * `meeting-timing-client.ts`.
   */
  timing?: boolean;
}

/**
 * A typed name the server will actually accept. Past MAX_SPEAKER_NAME its
 * parser drops the frame without answering, so an unclipped name would sit on
 * the row while the record and the notes never heard it. The clip falls back
 * to a word boundary and SAYS it happened: cut mid-word and silent, "VP of
 * Platform Engineering, EMEA" came back as "…VP of Platform Engi", which
 * reads as a typo rather than as a name that was too long.
 */
export function clipSpeakerName(name: string): string {
  if (name.length <= MAX_SPEAKER_NAME) return name;
  const room = MAX_SPEAKER_NAME - 1;
  const cut = name.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  // Only honour a word boundary that leaves a name behind, never one that
  // clips back to a single word.
  const kept = lastSpace > room / 2 ? cut.slice(0, lastSpace) : cut;
  return `${kept.trimEnd()}…`;
}

export interface MeetingStripHandle {
  destroy(): void;
  state(): StripState;
  /** What the next (or current) capture listens for. */
  mode(): CaptureMode;
  /**
   * How this capture told the room, as far as it has actually happened.
   * Undefined for a solo capture, before the first start, and while the
   * device is still mid-sentence.
   */
  announced(): AnnouncedBy | undefined;
}

/** What to say when the server sends an `unavailable` with no message. */
function unavailableFallback(reason: MeetingUnavailableReason): string {
  switch (reason) {
    case 'not_configured':
      return 'Transcription is not configured on this server, so no words will appear.';
    case 'engine_unavailable':
      return 'The transcription engine is not answering right now.';
    case 'already_recording':
      return 'Another session is already recording this doc.';
  }
}

function defaultOpenSocket(url: string): MeetingSocket {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  return ws as unknown as MeetingSocket;
}

function defaultInterval(fn: () => void, ms: number): () => void {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
}

function defaultPromptName(current: string): string | null {
  return window.prompt('Who is this?', current);
}

/**
 * The announcement as the strip shows it, which is not the same job in the two
 * paths: the device's is a caption for something the room is already hearing,
 * and the person's is a line to READ, so it has to carry the instruction.
 * Both quote the sentence itself, because the sentence is the record.
 */
export function announcementNote(by: AnnouncedBy | 'tap'): string {
  const said = `“${RECORDING_ANNOUNCEMENT}”`;
  // A third job, and the only one that is an INSTRUCTION TO THE DEVICE: the
  // device was handed the sentence and never began it, and one tap is what
  // its speech queue is waiting for. The sentence is quoted here too, so
  // somebody who would rather just say it can, and never has to find out why
  // a tap was being asked for.
  if (by === 'tap') return `Tap to announce it out loud: ${said}`;
  return by === 'device' ? `Announcing: ${said}` : `Say this out loud: ${said}`;
}

/** The speaker icon on the idle Record Audio button. */
const RECORD_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 6.5v3h2.6L9 12.6V3.4L5.6 6.5H3z" fill="currentColor"/><path d="M10.8 5.2a3.4 3.4 0 0 1 0 5.6M12.4 3.4a5.8 5.8 0 0 1 0 9.2" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round"/></svg>`;

/** Which popover the Record button has open, if any. */
type PopView = 'none' | 'menu' | 'chooser';

export function mountMeetingStrip(opts: MeetingStripOpts): MeetingStripHandle {
  const { docId, root } = opts;
  const now = opts.now ?? Date.now;
  const interval = opts.interval ?? defaultInterval;
  const openSocket = opts.openSocket ?? defaultOpenSocket;
  const startCapture = opts.startCapture ?? startMeetingCapture;
  const promptName = opts.promptName ?? defaultPromptName;
  const announcer = opts.announcer ?? createAnnouncer();
  const bot = opts.bot;
  const engines = opts.engines ?? [];

  // ---- the Record Audio button, docked in the top bar -----------------------
  const record = document.createElement('button');
  record.type = 'button';
  record.className = 'meeting-record';
  record.setAttribute('aria-haspopup', 'menu');
  record.setAttribute('aria-expanded', 'false');
  const recordGlyph = document.createElement('span');
  recordGlyph.className = 'meeting-record-glyph';
  recordGlyph.innerHTML = RECORD_ICON;
  const recordDot = document.createElement('span');
  recordDot.className = 'meeting-record-dot';
  recordDot.setAttribute('aria-hidden', 'true');
  recordDot.hidden = true;
  const recordLabel = document.createElement('span');
  recordLabel.className = 'meeting-record-label';
  recordLabel.textContent = 'Record Audio';
  record.append(recordGlyph, recordDot, recordLabel);

  // ---- the strip: blinker, clock, flowing feed ------------------------------
  const blinker = document.createElement('span');
  blinker.className = 'meeting-blinker';
  blinker.setAttribute('aria-hidden', 'true');
  const elapsed = document.createElement('span');
  elapsed.className = 'meeting-elapsed';
  const feed = document.createElement('div');
  feed.className = 'meeting-feed';
  const line = document.createElement('div');
  line.className = 'meeting-feed-inner meeting-caption-line';
  line.setAttribute('aria-live', 'polite');
  feed.append(line);

  // ---- the popovers: scrim + one panel that is menu or chooser --------------
  const scrim = document.createElement('div');
  scrim.className = 'meeting-scrim';
  scrim.hidden = true;
  const pop = document.createElement('div');
  pop.className = 'meeting-pop';
  pop.hidden = true;

  /**
   * Built only for a measured meeting. A row of its own, present only under
   * the flag, so it cannot crowd the feed.
   */
  const timing: TimingSession | null = opts.timing
    ? createTimingSession({ now, send: (json) => socket?.send(json) })
    : null;

  root.classList.add('meeting-strip');
  root.classList.toggle('has-timing', timing !== null);
  root.replaceChildren(
    ...(timing
      ? [blinker, elapsed, feed, timing.element, scrim, pop]
      : [blinker, elapsed, feed, scrim, pop]),
  );
  // After the strip children are set: the no-toolbar fallback docks the
  // button in `root` itself, where a replaceChildren above would eat it.
  (opts.toolbar ?? root).append(record);

  let state: StripState = { kind: 'idle' };
  let view: PopView = 'none';
  let turns: TranscriptTurn[] = [];
  let capture: MeetingCapture | null = null;
  let socket: MeetingSocket | null = null;
  let socketOpen = false;
  let stopClock: (() => void) | null = null;
  let disposed = false;
  /**
   * Which attempt to start is the live one. A permission prompt can stay up
   * for as long as the person looks at it, and Stop (or a navigation, or a
   * second Start) during that window has to leave the mic that eventually
   * arrives with nowhere to go — otherwise it opens behind a strip that says
   * nothing is happening.
   */
  let generation = 0;
  /**
   * Solo unless this capture was asked to listen for a room. Set by the
   * chooser at start time and held across start/stop within one mount; never
   * persisted beyond it — a mode remembered from yesterday spends money on a
   * session nobody chose it for.
   */
  let mode: CaptureMode = opts.mode ?? DEFAULT_CAPTURE_MODE;
  /** The auto-start was refused in the way a missing gesture is: the note in
   *  the strip is the tap that supplies one, and says so. Cleared by any
   *  press. */
  let tapToStart = false;
  /**
   * Who is meant to say the sentence for this capture. Undefined when there
   * is nobody to tell. This is an INTENTION — it is not what the record is
   * told.
   */
  let announceBy: AnnouncedBy | undefined;
  /**
   * What has actually been claimed, which is a strictly later and smaller
   * thing. `device` is set only once the browser reports the utterance
   * finished, `spoken` the moment the sentence is on screen for a person.
   * A meeting stopped mid-sentence leaves this undefined and the record
   * saying nothing — which is correct: nobody heard the whole sentence, and
   * a consent record must never claim more than happened.
   */
  let announced: AnnouncedBy | undefined;
  /**
   * The announcement prompt owns the feed line and will not be pushed off
   * it by words. A person reading the sentence aloud needs it to STAY there:
   * a partial from an air conditioner would otherwise wipe the sentence out
   * from under them a moment after it appeared. So while this holds,
   * transcript turns accumulate in `turns` but are not drawn. It lifts on a
   * SETTLED turn — a whole utterance has finished, which is the earliest
   * evidence the sentence has been said — or on a tap, whichever comes first.
   */
  let holdAnnouncement = false;
  /**
   * Which tap is currently being spoken, or 0 for none.
   *
   * One at a time, and it is the double-tap that makes it necessary rather
   * than tidiness: a second `speak()` cancels the first mid-sentence, and the
   * FIRST call's own continuation then restores echo cancellation and puts the
   * read-it-yourself line up while the second utterance is still going — the
   * announcement taken back out of the recording by the tap that asked for it.
   * Held by attempt rather than as a flag so a stale announcement resolving
   * late cannot unlock the next meeting's offer.
   */
  let sayingAttempt = 0;

  /** Live word spans per turn, so a correction rewrites the span that is
   *  already on screen instead of redrawing the line under the reader. */
  const rendered = new Map<
    number,
    { span: HTMLElement; tag: HTMLButtonElement | null; words: HTMLElement[]; text: string }
  >();
  /**
   * Engine label → what the person calls that voice. Belongs to ONE meeting:
   * the engine hands out "A" afresh each session, so the map is emptied when
   * a meeting starts, never carried into the next.
   */
  let names: Record<string, string> = {};
  /**
   * Every label this meeting has shown, whether or not its turn is still on
   * the three-turn window — the cast the menu's rename rows list. Emptied
   * with `names` when a meeting starts; seeded from the last meeting's
   * record on a doc opened after its meeting ended.
   */
  let seen = new Set<string>();
  /**
   * The meeting a post-stop rename is addressed to. Survives `stopped` — it
   * is only useful once the socket is gone — and is replaced when a new
   * capture opens or the last meeting's record loads.
   */
  let lastMeetingId: string | null = null;

  // ---- bot presence ---------------------------------------------------------
  /** Whether this mount has seen the bot alive — a terminal state found
   *  already-terminal at load is history, not news, and is not shown. */
  let sawLiveBot = false;
  /** A terminal bot state the person tapped away. */
  let botNoteDismissed = false;

  /** The bot's status while it will still act, or null. */
  function liveBot(): MeetingBotStatus | null {
    return bot?.live() ?? null;
  }

  /** The terminal state worth a line: the bot WAS alive under this mount. */
  function botFarewell(): string | null {
    const s = bot?.status();
    if (!s || !sawLiveBot || botNoteDismissed) return null;
    if (bot?.live()) return null;
    return describeBotState(s.state);
  }

  // ---- chooser form state ---------------------------------------------------
  /** The chooser's source choice. Mic unless the last press said otherwise. */
  let chooseSource: 'mic' | 'bot' = 'mic';
  /**
   * The chooser's speaker choice. Multiple by default — this product's
   * ordinary meeting has other people in it, and the approved mock preselects
   * it; "Just me" is the deliberate cheaper pick. An address that says solo
   * (a Board solo huddle) presets it the other way.
   */
  let chooseMode: CaptureMode = opts.mode ?? 'conversation';
  /** "I'll ask for consent" — the person says the sentence, not the device. */
  let chooseConsent = false;
  /** The engine picked, only meaningful when more than one was offered. */
  let chooseEngine: string | undefined = engines.length > 1 ? engines[0]?.id : undefined;
  let chooseBotUrl = '';
  let chooseBotName = opts.botNamePrefill ?? '';
  /** Why the last chooser press did not start, shown in the sheet. */
  let chooseError = '';
  /** An invite is in flight; the CTA must not send a second bot. */
  let chooseBusy = false;

  /**
   * The button every rename surface uses. The pill is a child so the button
   * itself can stay free of the overflow that clipping a long name needs — a
   * clip anywhere on the button eats its own tap target.
   */
  function speakerButton(): HTMLButtonElement {
    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'meeting-speaker';
    tag.title = 'Tap to name this speaker';
    const pill = document.createElement('span');
    pill.className = 'meeting-speaker-pill';
    tag.append(pill);
    tag.addEventListener('click', () => nameSpeaker(tag.dataset.speaker ?? ''));
    return tag;
  }

  /** The tag every turn with this label wears, as it should read now. The
   *  name goes on the PILL, never on the button: the button is the tap
   *  target and holds nothing but padding (see the stylesheet). */
  function renderTag(entry: { tag: HTMLButtonElement | null }, label: string): void {
    const tag = entry.tag;
    if (!tag) return;
    const shown = speakerDisplayName(label, names);
    tag.dataset.speaker = label;
    const pill = tag.querySelector('.meeting-speaker-pill');
    if (pill) pill.textContent = shown;
    tag.setAttribute('aria-label', `Name ${shown}`);
  }

  function nameSpeaker(label: string): void {
    const current = speakerDisplayName(label, names);
    const answer = clipSpeakerName(promptName(current)?.trim() ?? '');
    if (!answer || answer === current) return;
    const hadName = label in names;
    names[label] = answer;
    for (const entry of rendered.values()) {
      if (entry.tag?.dataset.speaker === label) renderTag(entry, label);
    }
    renderFeed();
    renderPop();
    if (socketOpen) {
      socket?.send(JSON.stringify({ type: 'name_speaker', speaker: label, name: answer }));
    } else if (lastMeetingId && opts.postName) {
      // The socket died with the capture; the rename rides HTTP to the
      // meeting it belongs to. A refusal takes the name back off the screen —
      // shown-but-unsaved is the bug this channel exists to close.
      void opts
        .postName(lastMeetingId, label, answer)
        .catch(() => false)
        .then((tookIt) => {
          if (disposed || tookIt) return;
          // Only undo THIS answer: a newer rename may already be in flight.
          if (names[label] !== answer) return;
          if (hadName) names[label] = current;
          else delete names[label];
          for (const entry of rendered.values()) {
            if (entry.tag?.dataset.speaker === label) renderTag(entry, label);
          }
          renderFeed();
          renderPop();
        });
    }
  }

  /** The cast so far: every voice this meeting (or the last one) has shown. */
  function cast(): string[] {
    return [...new Set([...seen, ...Object.keys(names)])].sort((a, b) => a.localeCompare(b));
  }

  function renderFeed(): void {
    if (state.kind !== 'idle' && state.kind !== 'recording') return;
    // The announcement holds the line against the words; see `holdAnnouncement`.
    if (holdAnnouncement) return;
    // A note and a transcript share the line, so the reason the last attempt
    // gave has to go when words start arriving.
    line.querySelector('.meeting-note')?.remove();
    if (state.kind === 'idle') {
      // An idle strip with a live bot narrates the bot; with a farewell, the
      // farewell; otherwise the strip is hidden and the line stays empty.
      const live = liveBot();
      if (live) {
        clearTurnSpans();
        const who = live.speakers.length ? ` · ${live.speakers.join(', ')}` : '';
        const note = document.createElement('span');
        note.className = 'meeting-note meeting-bot-note';
        note.textContent = `${describeBotState(live.state)}${who}`;
        line.append(note);
        return;
      }
      const farewell = botFarewell();
      if (farewell) {
        clearTurnSpans();
        const note = document.createElement('button');
        note.type = 'button';
        note.className = 'meeting-note meeting-note-dismiss meeting-bot-note';
        note.textContent = farewell;
        note.title = 'Tap to dismiss';
        note.addEventListener('click', () => {
          botNoteDismissed = true;
          render();
        });
        line.append(note);
        return;
      }
      clearTurnSpans();
      return;
    }
    for (const [turn, entry] of rendered) {
      if (!turns.some((t) => t.turn === turn)) {
        entry.span.remove();
        rendered.delete(turn);
      }
    }
    for (const turn of turns) {
      let entry = rendered.get(turn.turn);
      if (!entry) {
        const span = document.createElement('span');
        span.className = 'meeting-turn';
        line.append(span);
        entry = { span, tag: null, words: [], text: '' };
        rendered.set(turn.turn, entry);
      }
      // The tag comes and goes with the label — the engine attributes a turn
      // once it has heard enough of it, and may reattribute it at the end.
      const label = turn.speaker;
      if (label === undefined) {
        entry.tag?.remove();
        entry.tag = null;
      } else {
        if (!entry.tag) {
          const tag = speakerButton();
          entry.span.prepend(tag);
          entry.tag = tag;
        }
        renderTag(entry, label);
      }
      if (entry.text === turn.text) continue;
      const words = diffTurnWords(entry.text, turn.text);
      for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (!word) continue;
        let el = entry.words[i];
        if (!el) {
          el = document.createElement('span');
          el.className = 'w';
          entry.span.append(el);
          entry.words[i] = el;
        }
        // A leading space on every word, never a generated one: a ::before
        // cannot line-break, and at the start of a line a real space
        // collapses away.
        el.textContent = ` ${word.text}`;
        el.classList.remove('is-fixed');
        if (word.changed) {
          // Reading the box restarts the animation for a word corrected twice.
          void el.offsetWidth;
          el.classList.add('is-fixed');
        }
      }
      for (const extra of entry.words.splice(words.length)) extra.remove();
      entry.text = turn.text;
    }
  }

  function clearTurnSpans(): void {
    rendered.clear();
    line.replaceChildren();
  }

  function showNote(text: string): void {
    clearTurnSpans();
    const note = document.createElement('span');
    note.className = 'meeting-note';
    note.textContent = text;
    line.append(note);
  }

  /**
   * The sentence, held on the line until it has been said. Always a button:
   * whatever the tap does here — give the line back, or spend a gesture on
   * the speech queue — it has to be reachable by more than a pointer.
   */
  function holdLine(text: string, hint: string, onTap: () => void, extra?: string): void {
    holdAnnouncement = true;
    clearTurnSpans();
    const note = document.createElement('button');
    note.type = 'button';
    note.className = extra
      ? `meeting-note meeting-note-dismiss ${extra}`
      : 'meeting-note meeting-note-dismiss';
    note.textContent = text;
    note.title = hint;
    note.setAttribute('aria-label', `${text} (${hint.toLowerCase()})`);
    note.addEventListener('click', onTap);
    line.append(note);
  }

  /** The line a person reads, dismissible once they have. */
  function showAnnouncement(text: string): void {
    holdLine(text, 'Tap to dismiss', releaseAnnouncement);
  }

  /**
   * The line that is itself the fix.
   *
   * Shown only where a tap can still work: the device was given the sentence,
   * never began it, and no gesture has ever reached its speech queue — which
   * is exactly the state a meeting auto-started by the Board's button arrives
   * in on iOS. The tap unlocks the queue and says the sentence into the
   * microphone that is already open, so the announcement still lands in the
   * recording. It looks like the read-it-yourself line because it IS that
   * line with one more thing on offer: someone who would rather say it
   * themselves can, and the quoted sentence is right there.
   */
  function offerToSpeak(attempt: number): void {
    holdLine(
      announcementNote('tap'),
      'Say it out loud',
      () => void sayItNow(attempt),
      'meeting-note-speak',
    );
  }

  /** Give the line back to the transcript, and draw whatever arrived. */
  function releaseAnnouncement(): void {
    if (!holdAnnouncement) return;
    holdAnnouncement = false;
    clearTurnSpans();
    renderFeed();
  }

  function tickClock(): void {
    elapsed.textContent =
      state.kind === 'recording' ? formatElapsed(now() - state.startedAt) : formatElapsed(0);
    // The menu head quotes the same clock; a menu left open must keep pace.
    if (view === 'menu') {
      const head = pop.querySelector('.meeting-pop-headline');
      if (head) head.textContent = menuHeadline();
    }
  }

  // ---- popover rendering ----------------------------------------------------

  /** `Recording · microphone · 2 speakers · 12:47` — the menu's one line of
   *  facts, every one settled at start time except the clock. */
  function menuHeadline(): string {
    const live = liveBot();
    if (live) {
      const parts = [describeBotState(live.state), 'meeting bot'];
      if (live.speakers.length > 0) {
        parts.push(`${live.speakers.length} speaker${live.speakers.length === 1 ? '' : 's'}`);
      }
      return parts.join(' · ');
    }
    const parts = [state.kind === 'recording' ? 'Recording' : 'Starting…', 'microphone'];
    const voices = cast().length;
    if (mode === 'conversation') {
      parts.push(voices > 0 ? `${voices} speaker${voices === 1 ? '' : 's'}` : 'multiple speakers');
    }
    if (state.kind === 'recording') parts.push(formatElapsed(now() - state.startedAt));
    return parts.join(' · ');
  }

  /** One rename row: the display name (label until renamed, then only the
   *  name — never both) and the Rename affordance. */
  function speakerRow(label: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'meeting-pop-speaker';
    const name = document.createElement('span');
    name.className = 'meeting-pop-speaker-name';
    name.textContent = speakerDisplayName(label, names);
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'meeting-pop-rename';
    rename.textContent = 'Rename';
    rename.setAttribute('aria-label', `Rename ${speakerDisplayName(label, names)}`);
    rename.addEventListener('click', () => nameSpeaker(label));
    row.append(name, rename);
    return row;
  }

  /** The speaker menu: the facts line, the cast, and Stop as the one action. */
  function buildMenu(): void {
    pop.replaceChildren();
    pop.className = 'meeting-pop meeting-menu';
    pop.setAttribute('role', 'menu');
    pop.removeAttribute('aria-label');
    const head = document.createElement('div');
    head.className = 'meeting-pop-head';
    const headBlink = document.createElement('span');
    headBlink.className = 'meeting-blinker';
    headBlink.setAttribute('aria-hidden', 'true');
    const headline = document.createElement('span');
    headline.className = 'meeting-pop-headline';
    headline.textContent = menuHeadline();
    head.append(headBlink, headline);
    pop.append(head);
    const live = liveBot();
    if (live) {
      // A bot's speakers are display names from the call — nothing here to
      // rename; the rename that reaches backwards lives on the notes' tags.
      for (const who of live.speakers) {
        const row = document.createElement('div');
        row.className = 'meeting-pop-speaker';
        const name = document.createElement('span');
        name.className = 'meeting-pop-speaker-name';
        name.textContent = who;
        row.append(name);
        pop.append(row);
      }
    } else {
      for (const label of cast()) pop.append(speakerRow(label));
    }
    const sep = document.createElement('div');
    sep.className = 'meeting-pop-sep';
    pop.append(sep);
    const stopCta = document.createElement('button');
    stopCta.type = 'button';
    stopCta.className = 'meeting-stop-cta';
    stopCta.textContent = live ? '■ Send the bot home' : '■ Stop Recording';
    stopCta.addEventListener('click', () => {
      if (live) {
        stopCta.disabled = true;
        void bot
          ?.leave()
          .catch(() => {
            // The strip keeps showing the bot's real state; a failed leave
            // changes nothing worth a second surface.
          })
          .finally(() => {
            if (!disposed) closePop();
          });
        return;
      }
      stop();
      closePop();
    });
    pop.append(stopCta);
  }

  /** One radio card in the chooser. */
  function choice(args: {
    group: string;
    title: string;
    detail: string;
    checked: boolean;
    onPick: () => void;
  }): { el: HTMLLabelElement; body: HTMLElement; input: HTMLInputElement } {
    const label = document.createElement('label');
    label.className = args.checked ? 'meeting-choice is-selected' : 'meeting-choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = args.group;
    input.checked = args.checked;
    const body = document.createElement('span');
    body.className = 'meeting-choice-body';
    const title = document.createElement('span');
    title.className = 'meeting-choice-title';
    title.textContent = args.title;
    const detail = document.createElement('span');
    detail.className = 'meeting-choice-detail';
    detail.textContent = args.detail;
    body.append(title, detail);
    label.append(input, body);
    input.addEventListener('change', () => {
      if (input.checked) args.onPick();
    });
    return { el: label, body, input };
  }

  function choiceGroup(name: string): { group: HTMLElement; add: (el: HTMLElement) => void } {
    const group = document.createElement('div');
    group.className = 'meeting-choice-group';
    const label = document.createElement('div');
    label.className = 'meeting-choice-group-label';
    label.textContent = name;
    group.append(label);
    return { group, add: (el) => group.append(el) };
  }

  /**
   * The start chooser: every decision a recording takes, taken here, and a
   * red Start Recording that is the only verb.
   */
  function buildChooser(): void {
    pop.replaceChildren();
    pop.className = 'meeting-pop meeting-sheet';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Start recording');
    const h = document.createElement('h3');
    h.className = 'meeting-sheet-title';
    h.textContent = 'Start recording';
    pop.append(h);

    // The last meeting's voices, still nameable after it ended — the behavior
    // the old strip's idle legend carried, now living where the button leads.
    const idleCast = cast();
    if (idleCast.length > 0) {
      const castWrap = document.createElement('div');
      castWrap.className = 'meeting-pop-cast';
      const hint = document.createElement('div');
      hint.className = 'meeting-choice-group-label';
      hint.textContent = 'Speakers from the last recording';
      castWrap.append(hint);
      for (const label of idleCast) castWrap.append(speakerRow(label));
      pop.append(castWrap);
    }

    const source = choiceGroup('Source');
    const micChoice = choice({
      group: 'meeting-source',
      title: 'Use microphone',
      detail: 'Record the room from this device',
      checked: chooseSource === 'mic',
      onPick: () => {
        chooseSource = 'mic';
        renderChoiceSelection();
      },
    });
    micChoice.el.classList.add('meeting-choice-mic');
    source.add(micChoice.el);
    // Only where the server can actually field one: no key means no bot
    // source at all rather than a card that always fails.
    if (bot?.configured()) {
      const botChoice = choice({
        group: 'meeting-source',
        title: 'Join Zoom / Google Meet',
        detail: 'A bot joins the call and records it',
        checked: chooseSource === 'bot',
        onPick: () => {
          chooseSource = 'bot';
          renderChoiceSelection();
        },
      });
      botChoice.el.classList.add('meeting-choice-bot');
      const url = document.createElement('input');
      url.type = 'url';
      url.className = 'meeting-bot-url';
      url.placeholder = 'Paste the meeting link';
      url.setAttribute('aria-label', 'Meeting link for the bot to join');
      url.value = chooseBotUrl;
      url.addEventListener('input', () => {
        chooseBotUrl = url.value;
      });
      // Typing a link IS choosing the bot; make the radio agree.
      url.addEventListener('focus', () => {
        if (chooseSource !== 'bot') {
          chooseSource = 'bot';
          renderChoiceSelection();
        }
      });
      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'meeting-bot-name';
      name.setAttribute('aria-label', 'Bot display name — tap to change');
      name.value = chooseBotName;
      name.addEventListener('input', () => {
        chooseBotName = name.value;
      });
      botChoice.body.append(url, name);
      source.add(botChoice.el);
    }
    pop.append(source.group);

    const speakers = choiceGroup('Speakers');
    speakers.add(
      choice({
        group: 'meeting-speakers',
        title: 'Just me',
        detail: 'No speaker labels',
        checked: chooseMode === 'solo',
        onPick: () => {
          chooseMode = 'solo';
          renderChoiceSelection();
        },
      }).el,
    );
    speakers.add(
      choice({
        group: 'meeting-speakers',
        title: 'Multiple Speakers',
        detail: 'Labels each voice in the transcript',
        checked: chooseMode === 'conversation',
        onPick: () => {
          chooseMode = 'conversation';
          renderChoiceSelection();
        },
      }).el,
    );
    pop.append(speakers.group);

    // The engine row, only when there is a real choice to make. The seam the
    // in-flight engine integration slots into; see MeetingEngineChoice.
    if (engines.length > 1) {
      const engine = choiceGroup('Engine');
      for (const e of engines) {
        engine.add(
          choice({
            group: 'meeting-engine',
            title: e.label,
            detail: '',
            checked: chooseEngine === e.id,
            onPick: () => {
              chooseEngine = e.id;
              renderChoiceSelection();
            },
          }).el,
        );
      }
      pop.append(engine.group);
    }

    const consent = document.createElement('label');
    consent.className = 'meeting-consent';
    const consentBox = document.createElement('input');
    consentBox.type = 'checkbox';
    consentBox.checked = chooseConsent;
    consentBox.addEventListener('change', () => {
      chooseConsent = consentBox.checked;
    });
    const consentText = document.createElement('span');
    consentText.textContent = "I’ll ask for consent";
    consent.append(consentBox, consentText);
    pop.append(consent);

    const err = document.createElement('span');
    err.className = 'meeting-pop-error';
    // Assertive: this one only ever appears in answer to a press, and it is
    // the reason the thing the person just asked for did not happen.
    err.setAttribute('aria-live', 'assertive');
    err.textContent = chooseError;
    pop.append(err);

    const startCta = document.createElement('button');
    startCta.type = 'button';
    startCta.className = 'meeting-start-cta';
    startCta.textContent = '● Start Recording';
    startCta.disabled = chooseBusy;
    startCta.addEventListener('click', onStartPressed);
    pop.append(startCta);
  }

  /** Re-mark the selected cards without rebuilding inputs mid-interaction. */
  function renderChoiceSelection(): void {
    for (const card of pop.querySelectorAll('.meeting-choice')) {
      const input = card.querySelector('input');
      card.classList.toggle('is-selected', input?.checked === true);
    }
  }

  /**
   * The chooser's one verb. The device-announcement priming happens HERE,
   * synchronously in the gesture's own task — iOS only unlocks speech from
   * inside it, and the announcement itself cannot be spoken yet because it
   * has to wait for the microphone. See meeting-announce.ts.
   */
  function onStartPressed(): void {
    chooseError = '';
    if (chooseSource === 'bot') {
      if (chooseBusy || !bot) return;
      chooseBusy = true;
      renderPop();
      void bot
        .invite(chooseBotUrl.trim(), chooseBotName)
        .then(() => {
          chooseBusy = false;
          chooseBotUrl = '';
          if (!disposed) closePop();
        })
        .catch((e: Error) => {
          chooseBusy = false;
          chooseError = e.message;
          if (!disposed) renderPop();
        });
      return;
    }
    mode = chooseMode;
    const by: AnnouncedBy = chooseConsent ? 'spoken' : 'device';
    if (announcesRecording(mode) && by === 'device') announcer.prime();
    closePop();
    void start(false, by);
  }

  function openPop(next: Exclude<PopView, 'none'>): void {
    view = next;
    renderPop();
    scrim.hidden = false;
    pop.hidden = false;
    record.classList.add('is-open');
    record.setAttribute('aria-expanded', 'true');
  }

  function closePop(): void {
    view = 'none';
    scrim.hidden = true;
    pop.hidden = true;
    record.classList.remove('is-open');
    record.setAttribute('aria-expanded', 'false');
  }

  function renderPop(): void {
    if (view === 'menu') buildMenu();
    else if (view === 'chooser') buildChooser();
  }

  /** Which popover a press on the button should lead to right now. */
  function popForNow(): Exclude<PopView, 'none'> {
    const busy = state.kind === 'recording' || state.kind === 'requesting' || liveBot() !== null;
    return busy ? 'menu' : 'chooser';
  }

  /** Whether the strip row earns its height right now. */
  function stripVisible(): boolean {
    if (holdAnnouncement) return true;
    if (state.kind !== 'idle') return true;
    if (liveBot()) return true;
    if (botFarewell()) return true;
    return false;
  }

  function render(): void {
    root.dataset.state = state.kind;
    const botLive = liveBot();
    const isRecording = state.kind === 'recording' || botLive?.state === 'recording';
    root.classList.toggle('is-live', isRecording);
    root.classList.toggle('is-bot', botLive !== null && state.kind === 'idle');
    root.hidden = !stripVisible();
    // The button: Record Audio with the speaker glyph when idle, a solid red
    // dot and Recording while live — the strip and its owner read as one unit.
    recordLabel.textContent = isRecording ? 'Recording' : 'Record Audio';
    recordGlyph.hidden = isRecording;
    recordDot.hidden = !isRecording;
    record.classList.toggle('is-live', isRecording);
    record.title = isRecording ? 'Recording — open controls' : 'Record audio';
    record.setAttribute(
      'aria-label',
      isRecording ? 'Recording — open recording controls' : 'Record audio',
    );
    switch (state.kind) {
      case 'requesting':
        showNote('Asking for the microphone…');
        break;
      case 'unavailable':
        showNote(state.message || unavailableFallback(state.reason));
        break;
      case 'blocked':
      case 'error':
        if (tapToStart) {
          // Deliberately a button: the tap is the gesture the auto-start was
          // missing, and pressing it is how the huddle gets its mic.
          clearTurnSpans();
          const note = document.createElement('button');
          note.type = 'button';
          note.className = 'meeting-note meeting-note-dismiss meeting-note-start';
          note.textContent = 'The huddle is on — the mic needs one tap to start.';
          note.addEventListener('click', () => {
            if (announcesRecording(mode)) announcer.prime();
            void start(false, 'device');
          });
          line.append(note);
        } else {
          showNote(state.message);
        }
        break;
      default:
        break;
    }
    // A popover built for a state that ended re-renders for the one that is:
    // a chooser open when `ready` lands becomes controls; a menu open when
    // the meeting dies becomes the chooser.
    if (view !== 'none') {
      const want = popForNow();
      if (want !== view) view = want;
      renderPop();
    }
    tickClock();
    renderFeed();
  }

  function setState(next: StripState): void {
    state = next;
    if (next.kind === 'recording') {
      stopClock ??= interval(tickClock, CLOCK_MS);
    } else {
      stopClock?.();
      stopClock = null;
    }
    render();
  }

  function releaseAudio(): void {
    capture?.stop();
    capture = null;
  }

  /**
   * The echo-cancellation hedge, and its own failure swallowed HERE rather
   * than trusted of the capture: an announcement that a room is owed must not
   * be able to fail because a hedge did.
   *
   * The capture is passed in rather than read from the closure, and that is
   * the whole point of the parameter. An utterance that was cancelled can
   * stay pending for its full timeout, so the restore half of this pair can
   * run long after its meeting ended — by which time `capture` is the NEXT
   * meeting's microphone, in the middle of the NEXT announcement. Bound to
   * the instance, a stale restore lands on a track that is already stopped,
   * which is nothing.
   */
  async function suspendEchoCancellation(
    mic: MeetingCapture | null,
    suspended: boolean,
  ): Promise<void> {
    try {
      // Restored to what the ROOM asked for, not to `true`. Echo cancellation
      // is a knob (`?mic=ec0-…`) and the announcement is made on exactly the
      // mode that knob applies to, so restoring a constant would turn every
      // `ec0` room back on mid-meeting — silently, and for good.
      await mic?.setEchoCancellation(suspended ? false : wantsEchoCancellation());
    } catch {
      // Then the capture keeps the cancellation it has, and the sentence is
      // spoken into it anyway.
    }
  }

  /**
   * What the microphone that is open right now was OPENED with.
   *
   * Read off `captureConstraints` at the press, so this is the same rule the
   * capture itself used rather than a second copy of it that has to be kept
   * in step.
   */
  let openedEchoCancellation: boolean = ROOM_AUDIO_DEFAULT.echoCancellation;
  function wantsEchoCancellation(): boolean {
    return openedEchoCancellation;
  }

  /**
   * The meeting is over, however it ended: nothing may still be announcing
   * it. Called from EVERY terminal path, not only from Stop — a relay error
   * or a dropped socket ends a recording just as finally as the button does.
   * Without this the device carries on saying "this conversation is being
   * recorded" into a room where it is not, and the sentence's late resolution
   * can write a claim onto a meeting that failed. The generation bump is what
   * makes the pending `announce()` return without touching anything.
   */
  function endAnnouncement(): void {
    generation += 1;
    holdAnnouncement = false;
    // A cancelled utterance can stay unresolved for its whole timeout, and
    // the next meeting's offer must not be locked out by one.
    sayingAttempt = 0;
    announcer.cancel();
  }

  function closeSocket(): void {
    const sock = socket;
    socket = null;
    socketOpen = false;
    if (!sock) return;
    // Handlers first: closing is a deliberate end, and an onclose that still
    // fired would report it as a dropped connection.
    sock.onopen = null;
    sock.onmessage = null;
    sock.onclose = null;
    sock.onerror = null;
    sock.close();
  }

  function handle(msg: MeetingServerMessage | null, recvMs: number): void {
    if (!msg) return;
    switch (msg.type) {
      case 'ready':
        // What the server opened, which is what is being billed. A server
        // built before modes existed says `solo` for a session that
        // diarizes; showing its answer is still better than showing a claim
        // nothing checked.
        mode = msg.mode;
        // Where a rename lands once this meeting's socket is gone.
        if (msg.meetingId) lastMeetingId = msg.meetingId;
        // And the announcement follows the mode the SERVER opened, not the
        // one that was asked for. An old server answering `solo` to a
        // conversation request would otherwise announce a session the strip
        // has just relabelled solo; the inverse would skip an announcement
        // a room is owed.
        if (!announcesRecording(mode)) announceBy = undefined;
        else announceBy ??= DEFAULT_ANNOUNCED_BY;
        setState({ kind: 'recording', startedAt: now() });
        // AFTER the state change, and that ordering is the feature: `ready`
        // means the engine is receiving, so everything from here is in the
        // transcript — including this. Announcing before the mic was open
        // would leave the sentence in a moment nothing recorded.
        if (announceBy) void announce(announceBy, generation);
        break;
      case 'transcript':
        // Noted before the render and closed after it, so the DOM leg is the
        // strip's own work and nothing else.
        timing?.frameReceived(msg, recvMs);
        // A SETTLED turn is a whole utterance finished — the earliest
        // evidence the sentence has actually been said, and so the moment
        // the announcement stops owning the line. Partials are not: one
        // arrives from any noise in the room.
        if (msg.final) releaseAnnouncement();
        // The cast outlives the three-turn window — a voice that spoke early
        // and went quiet must still be nameable when the meeting stops.
        if (msg.speaker !== undefined) {
          const grew = !seen.has(msg.speaker);
          seen.add(msg.speaker);
          // The menu lists the cast; a voice arriving while it is open must
          // land as a row, not wait for the next open.
          if (grew && view === 'menu') renderPop();
        }
        turns = rollTranscript(turns, {
          turn: msg.turn,
          text: msg.text,
          final: msg.final,
          ...(msg.speaker !== undefined ? { speaker: msg.speaker } : {}),
        });
        renderFeed();
        timing?.domUpdated();
        break;
      case 'timing_pong':
        timing?.onPong(msg, recvMs);
        break;
      case 'unavailable':
        // The words are never coming, so the mic goes back rather than sitting
        // open behind a settled state — and nothing is left announcing a
        // meeting that is not happening.
        endAnnouncement();
        releaseAudio();
        closeSocket();
        setState({ kind: 'unavailable', reason: msg.reason, message: msg.message });
        break;
      case 'stopped':
        endAnnouncement();
        releaseAudio();
        closeSocket();
        setState({ kind: 'idle' });
        break;
      case 'error':
        endAnnouncement();
        releaseAudio();
        closeSocket();
        setState({ kind: 'error', message: msg.message || 'The meeting ended unexpectedly.' });
        break;
    }
  }

  /**
   * Tell the server the room HAS been told — never before it has, and never
   * twice for the same path: a claim repeated on the wire is not a second
   * announcement, and the record's own writer folds it away anyway.
   */
  function claim(path: AnnouncedBy): void {
    if (announced === path) return;
    announced = path;
    if (socketOpen) socket?.send(JSON.stringify({ type: 'announced', by: path }));
  }

  /**
   * Say it now, off the tap that unlocked the queue.
   *
   * `prime()` runs FIRST and synchronously — before any await and before any
   * guard that could grow one — because the gesture's own task is the only
   * place iOS accepts the unlock. Everything after it is the announcement
   * proper, made the same way the automatic one is: into the microphone that
   * is already open, with echo cancellation stood down for the length of the
   * sentence.
   */
  async function sayItNow(attempt: number): Promise<void> {
    // A meeting that has ended is not owed an announcement, and speaking into
    // the NEXT one would announce a recording that this line was never about.
    if (disposed || attempt !== generation) return;
    // A second tap on a sentence already in flight is not a second
    // announcement; see `sayingAttempt`.
    if (sayingAttempt !== 0) return;
    sayingAttempt = attempt;
    announcer.prime();
    const mic = capture;
    try {
      await suspendEchoCancellation(mic, true);
      if (disposed || attempt !== generation) {
        await suspendEchoCancellation(mic, false);
        return;
      }
      const outcome = await announcer.speak(RECORDING_ANNOUNCEMENT);
      await suspendEchoCancellation(mic, false);
      if (disposed || attempt !== generation) return;
      if (outcome === 'spoke') {
        claim('device');
        // The room has heard it; the line has no reader left to wait for.
        releaseAnnouncement();
        return;
      }
      // The tap was the last thing that could have made the device speak.
      // What is left is the sentence and a person, which is where every other
      // failure ends too.
      showAnnouncement(announcementNote('spoken'));
    } finally {
      // Only if this attempt still owns it: a meeting that ended has already
      // released the offer, and may have handed it to a newer one.
      if (sayingAttempt === attempt) sayingAttempt = 0;
    }
  }

  /**
   * Tell the room, now that the microphone is live.
   *
   * The device path can fail in three indistinguishable ways — no synthesis,
   * a refused gesture, an utterance that never comes back — and all three end
   * in the same place: the sentence goes on screen for a person, and the
   * server is told the record should say `spoken`. That correction matters
   * more than the announcement's own convenience, because the record is the
   * thing anybody would later be asked to show.
   */
  async function announce(by: AnnouncedBy, attempt: number): Promise<void> {
    if (by === 'spoken') {
      // Held, not merely shown: this one is a line to READ, and a partial
      // from anywhere in the room would otherwise take it away mid-read.
      showAnnouncement(announcementNote('spoken'));
      // The sentence is on screen, which is the whole of what `spoken`
      // claims — the strip cannot know whether anybody read it aloud.
      claim('spoken');
      return;
    }
    // The device's caption is a courtesy for something the room is already
    // hearing, so it yields to the words the way any other note does.
    showNote(announcementNote('device'));
    // Echo cancellation is asked for on every capture, and its entire job is
    // to remove what this device is playing from what its microphone hears —
    // which is the one moment that has to work the other way round. Suspended
    // for the length of the sentence and restored after, best-effort: a
    // browser that refuses the constraint leaves the capture where it was.
    // Whichever microphone is open NOW is the one this sentence is spoken
    // into, and the only one this call may touch again.
    const mic = capture;
    await suspendEchoCancellation(mic, true);
    // Suspending is a promise, and a meeting can end inside it. `cancel()`
    // silences an utterance that is already underway — it cannot silence one
    // that has not been started yet, and speaking here would announce a
    // recording to a room that is no longer being recorded. This is the one
    // window where the terminal paths cannot reach the announcement, so the
    // announcement has to check for them.
    if (disposed || attempt !== generation) {
      await suspendEchoCancellation(mic, false);
      return;
    }
    const outcome = await announcer.speak(RECORDING_ANNOUNCEMENT);
    await suspendEchoCancellation(mic, false);
    // A stop, or a second meeting, during the sentence: this one no longer
    // owns the strip or the socket, and — the reason nothing is claimed at
    // start — the room heard half a sentence at most, so the record is left
    // saying nothing rather than saying the device announced it.
    if (disposed || attempt !== generation) return;
    if (outcome === 'spoke') {
      claim('device');
      return;
    }
    // Accepted and never begun, on a page nothing has ever touched: iOS
    // Safari's locked speech queue, and the ONE failure a tap can still turn
    // into speech. Offered rather than assumed — a queue that was primed and
    // stayed silent is a dead end, and a button that cannot work is worse
    // than the line it would replace.
    if (outcome === 'mute' && !announcer.primed()) offerToSpeak(attempt);
    else showAnnouncement(announcementNote('spoken'));
    // Claimed either way, and for the same reason it always was: the sentence
    // is on screen for a person to read. The tap can only improve on that,
    // and does — to `device`, once the room has actually heard it.
    claim('spoken');
  }

  async function start(auto = false, by: AnnouncedBy = 'device'): Promise<void> {
    if (state.kind === 'requesting' || state.kind === 'recording') return;
    const attempt = ++generation;
    turns = [];
    names = {};
    // The engine hands out "A" afresh each session: the old cast, and the
    // meeting a late rename would have been addressed to, belong to the
    // meeting that is over.
    seen = new Set();
    lastMeetingId = null;
    tapToStart = false;
    // A solo capture announces nothing, whichever path started it — the
    // consent checkbox is moot there, and the mode can also come in off the
    // address, so the record must not claim a room was told when the mode
    // says there was no room.
    announceBy = announcesRecording(mode) ? by : undefined;
    announced = undefined;
    holdAnnouncement = false;
    setState({ kind: 'requesting' });
    const started = await startCapture({
      onFrame: (pcm) => {
        if (!socketOpen) return;
        socket?.send(pcm);
        // Counted only when it actually goes out, so this ordinal is the same
        // ordinal the server's ledger gives the chunk it receives.
        timing?.frameSent();
      },
      // Read HERE rather than at mount: the chooser can change it between
      // meetings, and the constraints belong to the microphone this press is
      // about to open.
      mode,
      ...(opts.room ? { room: opts.room } : {}),
    });
    // The same call the capture just made, so the announcement restores what
    // was actually asked for rather than what a different mode would want.
    openedEchoCancellation =
      (captureConstraints(mode, opts.room).audio as MediaTrackConstraints).echoCancellation ===
      true;
    if (disposed || attempt !== generation) {
      if (started.ok) started.capture.stop();
      return;
    }
    if (!started.ok) {
      // Only a DENIAL can be a missing gesture; an insecure origin gives no
      // mic to any press, and says so.
      tapToStart = auto && started.kind === 'denied';
      setState({ kind: 'blocked', message: started.message });
      return;
    }
    capture = started.capture;
    const sock = openSocket(meetingSocketUrl(docId));
    socket = sock;
    sock.onopen = () => {
      socketOpen = true;
      // Opening the socket IS starting the meeting; this frame only tells the
      // server what shape the audio behind it will be.
      sock.send(
        JSON.stringify({
          type: 'start',
          sampleRate: MEETING_SAMPLE_RATE,
          encoding: MEETING_AUDIO_ENCODING,
          mode,
          // Absent unless somebody said, so the server's default stays the
          // one place the room size is guessed.
          ...(opts.speakers !== undefined ? { speakers: opts.speakers } : {}),
          // Only when the chooser offered a real choice; a server that has
          // never heard of engines never receives the field.
          ...(chooseEngine !== undefined && engines.length > 1 ? { engine: chooseEngine } : {}),
          ...(timing ? { timing: true } : {}),
        }),
      );
      // After the start frame: the server reads the flag off it, and a ping
      // that overtook it would be answered by a connection not yet measuring.
      timing?.begin();
    };
    sock.onmessage = (ev) => {
      // The receive mark comes before the parse — the downlink ends when the
      // bytes land, not when we have finished reading them.
      const at = now();
      handle(parseMeetingServerMessage(ev.data), at);
    };
    sock.onclose = () => {
      socketOpen = false;
      endAnnouncement();
      releaseAudio();
      setState({ kind: 'error', message: 'The connection to the meeting was lost.' });
    };
    // `error` is always followed by `close`; reporting both would overwrite the
    // message with itself.
    sock.onerror = null;
  }

  function stop(): void {
    // A meeting stopped during the announcement stops announcing: the room
    // does not need to be told about a recording that is over.
    endAnnouncement();
    if (socketOpen) socket?.send(JSON.stringify({ type: 'stop' }));
    releaseAudio();
    closeSocket();
    setState({ kind: 'idle' });
  }

  const onRecordClick = (): void => {
    if (view !== 'none') {
      closePop();
      return;
    }
    openPop(popForNow());
  };
  record.addEventListener('click', onRecordClick);
  const onScrim = (): void => closePop();
  scrim.addEventListener('click', onScrim);
  const onKeydown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && view !== 'none') closePop();
  };
  document.addEventListener('keydown', onKeydown);

  const offBot = bot?.onChange(() => {
    if (disposed) return;
    if (bot.live()) {
      sawLiveBot = true;
      botNoteDismissed = false;
    }
    render();
  });
  // The bot feature answers whether it exists a beat after mount; a chooser
  // opened in that beat should grow the bot source when the answer lands.
  void bot?.ready.then(() => {
    if (!disposed && view === 'chooser') renderPop();
  });

  render();
  if (opts.autoStart) void start(true, 'device');
  if (opts.loadSpeakers) {
    // A doc opened after its meeting ended still owes its owner the names:
    // the cast comes back off the record, and a tap renames over HTTP. A
    // capture started before the answer arrives outranks it — that meeting's
    // labels are new people — which is what the generation check drops.
    const attempt = generation;
    void opts
      .loadSpeakers()
      .then((cast) => {
        if (disposed || attempt !== generation || !cast || state.kind !== 'idle') return;
        lastMeetingId = cast.meetingId;
        for (const voice of cast.voices) {
          seen.add(voice.label);
          if (voice.name !== speakerDisplayName(voice.label, {})) names[voice.label] = voice.name;
        }
        if (view === 'chooser') renderPop();
      })
      .catch(() => {
        // A record that cannot load costs the chooser its cast, never itself.
      });
  }

  return {
    state: () => state,
    mode: () => mode,
    announced: () => announced,
    destroy: () => {
      disposed = true;
      generation += 1;
      announcer.cancel();
      record.removeEventListener('click', onRecordClick);
      scrim.removeEventListener('click', onScrim);
      document.removeEventListener('keydown', onKeydown);
      offBot?.();
      timing?.destroy();
      releaseAudio();
      closeSocket();
      stopClock?.();
      stopClock = null;
      clearTurnSpans();
      record.remove();
      root.classList.remove('is-live', 'is-bot');
      root.hidden = true;
      root.removeAttribute('data-state');
      root.replaceChildren();
    },
  };
}
