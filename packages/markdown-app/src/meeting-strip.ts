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
 * ONE TAP WHEN ALONE. A Record press on a doc with nobody else on it starts
 * a solo recording at once — no chooser, the server's default engine — because
 * every question the chooser asks (who will the microphone hear, should a bot
 * go instead) has no answer when there is nobody else there, and a form that
 * recurs unchanged is friction rather than a decision (Urgent-fixes ticket,
 * 2026-09-02: "start recording in one tap when he is alone"). Whether anyone
 * else is here is the doc's presence, asked at press time through
 * `opts.alone` (`meeting-solo.ts`); with a collaborator on the doc the press
 * opens the chooser as before. The chooser itself stays one tap away either
 * way, behind the small options button beside Record — a conversation in a
 * room nobody else has the doc open in still has to be asked for somewhere.
 *
 * EVERY BILLED CHOICE HAPPENS AT START TIME. The chooser collects the source
 * (microphone, or a bot sent to a Zoom / Google Meet call) and whether the
 * room has one voice or several — a streaming session's configuration IS its
 * connect URL, so switching either mid-meeting would mean a second session
 * and a second bill for the same conversation. Which engine listens is NOT a
 * question it asks: the server's default runs unless the address names one
 * (`?engine=soniox`, a preference read on every visit — see huddle-entry.ts),
 * and the picker that used to sit above Speakers came out with the ticket
 * above. The bot path transcribes the vendor's raw audio through the same
 * engines, so the preference applies there too. The one exception to
 * start-time is the Advanced Options panel (meeting-advanced.ts), which stays
 * reachable from the menu while recording: AssemblyAI's protocol can change
 * its turn-detection knobs on the open socket, and everything it cannot
 * change waits for the next recording and says so under the control.
 *
 * IT NO LONGER ANNOUNCES ITSELF TO THE ROOM. A `conversation` capture used to
 * speak a fixed sentence into its own microphone, offer a second button that
 * declined it, and record which path was taken. All of it came out on
 * 2026-09-01 (Bryan: "This is too much fiddling. I'll manually handle consent
 * for now.") — it put a decision in front of somebody on every recording, in a
 * room that was already talking, for a claim the client could not stand
 * behind. What replaced it is one line at the head of the transcript,
 * `RECORDING_CONSENT_NOTE`, addressed to the person recording. Speakers is now
 * a plain question about who the microphone will hear, and nothing else.
 *
 * CORRECTIONS LAND ON THE WORD ALREADY ON SCREEN. A `transcript` frame carries
 * the WHOLE turn as currently understood, so a later frame for the same turn
 * is the engine revising itself. `diffTurnWords` finds which words actually
 * moved and only those are rewritten and flashed — redrawing the line instead
 * would make every partial look like a correction.
 */

import {
  type CaptureMode,
  DEFAULT_CAPTURE_MODE,
  MAX_SPEAKER_NAME,
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  type MeetingBotStatus,
  type MeetingServerMessage,
  type MeetingTimingMark,
  type MeetingUnavailableReason,
  RECORDING_CONSENT_NOTE,
  type TranscriptionEngineName,
  describeBotState,
  meetingSocketPath,
  parseCaptureMode,
  speakerDisplayName,
} from '@feedback/core';
import type { MeetingTranscriptEvent } from '@feedback/core';
import { liveTuningKeys, parseRoomSpeakers } from '@feedback/core';
import {
  type AdvancedState,
  advancedControls,
  buildAdvancedSection,
  defaultAdvancedState,
  tuningPayload,
} from './meeting-advanced.ts';
import {
  type MeetingCapture,
  type MeetingCaptureStart,
  type RoomAudioProcessing,
  startMeetingCapture,
} from './meeting-audio.ts';
import type { MeetingBotClient } from './meeting-bot-client.ts';
import type { MeetingLiveZone } from './meeting-live-zone.ts';
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
    case 'notes_progress': {
      if (typeof m.tick !== 'number' || !Number.isFinite(m.tick)) return null;
      const phase = m.phase;
      if (phase !== 'composing' && phase !== 'written' && phase !== 'failed') return null;
      return {
        type: 'notes_progress',
        tick: m.tick,
        phase,
        turns: Array.isArray(m.turns)
          ? m.turns.filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
          : [],
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
    case 'tuned':
      return {
        type: 'tuned',
        applied: Array.isArray(m.applied)
          ? m.applied.filter((k): k is string => typeof k === 'string')
          : [],
      };
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
  /**
   * What the bot-name field starts as — "<who>'s Claude Code Agent" from the
   * signed-in identity. Absent, the server's configured default stands and
   * the field shows it as a placeholder-shaped fact rather than a value.
   */
  botNamePrefill?: string;
  /**
   * The signed-in person's name, sent on `start` as `participant`: what the
   * raw transcript attributes an unlabelled turn to. Never a label on the
   * strip — a solo capture asks the engine for none.
   */
  participantName?: string;
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
   * Open the start CHOOSER on mount instead of the microphone — the entry
   * "Have a discussion" takes, where `autoStart` is what "Make a plan" takes.
   *
   * The difference is who else is in the room. A plan is one person thinking
   * out loud, so the fastest honest thing is an open mic. A discussion has
   * other people in it, and the sentence that tells them they are being
   * recorded is now a button they have to press — so a discussion cannot
   * begin without somebody choosing, and "begin the huddle" has to land on
   * the choice rather than on the recording.
   *
   * Mutually exclusive with `autoStart`, which wins if both are set: an open
   * mic is the stronger claim and a chooser over a live recording would be
   * offering a decision that has already been taken.
   */
  autoChoose?: boolean;
  /**
   * Whether the person pressing Record is the only one on this doc, asked at
   * the press. True means the press records at once — solo, no chooser;
   * false (or absent: a mount that cannot say) means the press opens the
   * chooser as it always did. `app.ts` answers it from the doc's presence via
   * `othersOnDoc`; see the header.
   */
  alone?: () => boolean;
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
   * Which transcription engine the next capture opens (`?engine=soniox` on
   * the address — the one place the engine is chosen). Absent means the
   * server's default, which is also what a server built before the choice
   * existed opens. Start-time only, like `mode` — an engine session's config
   * is fixed once open.
   */
  engine?: TranscriptionEngineName;
  /**
   * The engines this server can open, asked for once at mount — what names
   * the default the start frame carries and the Advanced panel is keyed on.
   * Injectable so a test drives it without a server; absent, the strip asks
   * `/api/meeting-engines`. Null (an old server, a failed fetch) leaves the
   * frame without an engine and the chooser without an Advanced panel.
   */
  listEngines?: () => Promise<{ engines: string[]; default: string | null } | null>;
  /**
   * Ask the person what to call a speaker; `current` is what the row says
   * now. Null or blank means leave it. Defaults to `window.prompt` — the
   * popover has no room for an inline field, and a name is typed once per
   * voice per meeting.
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
   * Measure this meeting and show the running numbers (`?timing=1`). Off on
   * every ordinary load: nothing is constructed, no clock is read per audio
   * frame, and the `start` frame is byte-for-byte what it was. See
   * `meeting-timing-client.ts`.
   */
  timing?: boolean;
  /**
   * The provisional zone at the end of the doc (meeting-live-zone.ts). When
   * present it is the ONLY transcript surface: the strip stops rendering the
   * rolling words on its own line — one meeting shown in two places reads as
   * two meetings — and instead feeds every frame (words, names, the
   * `notes_progress` lifecycle) to the zone. The strip keeps everything
   * else: the button, the clock, the announcement, the states.
   */
  liveZone?: MeetingLiveZone;
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

async function defaultListEngines(): Promise<{
  engines: string[];
  default: string | null;
} | null> {
  try {
    const res = await fetch('/api/meeting-engines');
    if (!res.ok) return null;
    const body = (await res.json()) as { engines?: unknown; default?: unknown };
    const engines = Array.isArray(body.engines)
      ? body.engines.filter((e): e is string => typeof e === 'string')
      : [];
    return { engines, default: typeof body.default === 'string' ? body.default : null };
  } catch {
    // An old server has no such route, and a strip on one behaves exactly as
    // it always did: no chooser, the server's one engine.
    return null;
  }
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
  const bot = opts.bot;

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
  /**
   * The chooser's own door, beside Record: the source and speaker questions a
   * one-tap start does not ask. Idle only — while recording, Record itself
   * opens the menu, and the chooser has nothing to decide.
   */
  const options = document.createElement('button');
  options.type = 'button';
  options.className = 'meeting-record-options';
  options.setAttribute('aria-label', 'Recording options');
  options.setAttribute('aria-haspopup', 'dialog');
  options.title = 'Recording options';
  options.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

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
    ...(timing ? [blinker, elapsed, feed, timing.element] : [blinker, elapsed, feed]),
  );
  // The scrim and the popovers dock beside the Record button, NOT inside
  // `root`: `root` is the strip itself, which is `hidden` (⇒ `display: none`,
  // taking its whole subtree with it) for exactly the idle state the start
  // chooser has to open FROM. Both are `position: fixed`, so nesting them
  // under the toolbar instead costs nothing visually. After the strip
  // children are set: the no-toolbar fallback docks everything in `root`
  // itself, where the `replaceChildren` above would eat it.
  (opts.toolbar ?? root).append(record, options, scrim, pop);

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
  /** Live word spans per turn, so a correction rewrites the span that is
   *  already on screen instead of redrawing the line under the reader. */
  const rendered = new Map<
    number,
    { span: HTMLElement; tag: HTMLElement | null; words: HTMLElement[]; text: string }
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
  /** Whether the bot was live at the LAST change — the edge a new bot
   *  meeting is detected on, so its turns start from a clean window. */
  let botWasLive = false;
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
   * (a Board solo huddle) presets it the other way — `opts.mode` is only
   * ever set for that huddle-start case (`app.ts` leaves it `undefined`
   * otherwise, on purpose: see its comment there), so this fallback is the
   * one place the mock's default actually applies.
   */
  let chooseMode: CaptureMode = opts.mode ?? 'conversation';
  /**
   * The engine the next capture opens. Starts as the address's ask
   * (`?engine=soniox`), the same start-time-only fact `mode` is; settled once
   * the fetch below answers — the server's default, unless the address named
   * one this server actually holds. Nothing in the chooser moves it.
   */
  let chooseEngine: string | undefined = opts.engine;
  /**
   * Advanced Options per engine, created on first look. Keyed by engine
   * because the panel is the engine's own — the address can name one and the
   * fetch can settle on another — though nothing here flips between them any
   * more. Per mount only: settings are per-recording facts, like `mode`, and
   * a knob remembered from yesterday would silently shape a session nobody
   * tuned it for.
   */
  const advStates = new Map<string, AdvancedState>();
  /** Whether the Advanced section is unfolded — one flag across engines. */
  let advOpen = false;
  /** The engine the LIVE capture runs on, from `ready` — what the menu's
   *  Advanced panel tunes. Null while idle. */
  let recordingEngine: string | null = null;
  /** Keys the server confirmed applying to the live session ("Applied."). */
  const appliedKeys = new Set<string>();
  /**
   * Live keys the panel moved that the open session could not be moved to
   * match. Only a term list the engine already took and the panel then
   * EMPTIED gets in here: `[]` has no wire form (the server's sanitizer
   * reads an empty list as "no change"), so the engine keeps running the
   * terms it has. The control says so until the key travels again.
   */
  const staleKeys = new Set<string>();

  function advFor(engineId: string): AdvancedState {
    let state = advStates.get(engineId);
    if (!state) {
      state = defaultAdvancedState(engineId);
      // The address's room size (`?speakers=3`) seeds the cap the panel now
      // owns, so the knob that used to reach the engine directly still does.
      const seeded = parseRoomSpeakers(opts.speakers);
      if (seeded !== undefined && 'max_speakers' in state) state.max_speakers = seeded;
      advStates.set(engineId, state);
    }
    return state;
  }

  const listEngines = opts.listEngines ?? defaultListEngines;
  void listEngines().then((info) => {
    if (disposed || !info || info.engines.length === 0) {
      // No answer (an old server, a failed fetch) or nothing configured: no
      // chooser and no Advanced panel — the address's own engine ask stands
      // even unlisted, because the server is the authority on refusals.
      return;
    }
    chooseEngine =
      chooseEngine !== undefined && info.engines.includes(chooseEngine)
        ? chooseEngine
        : (info.default ?? info.engines[0]);
    // The chooser may already be open (a fast mount, a slow fetch); redraw it
    // so the Advanced panel — keyed on the engine — does not wait for a
    // second open to appear.
    if (view === 'chooser') renderPop();
  });
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

  /**
   * The same tag with no tap in it — a bot turn's. The platform already
   * named the voice, and a live bot meeting cannot be renamed from here
   * anyway (the rename route refuses a recording meeting; the socket a
   * live rename rides is the microphone's). Same pill, same place on the
   * line, so a bot meeting reads exactly like a microphone one; the
   * pencil and the dotted underline are the stylesheet's to withhold.
   */
  function speakerLabel(): HTMLElement {
    const tag = document.createElement('span');
    tag.className = 'meeting-speaker is-fixed';
    const pill = document.createElement('span');
    pill.className = 'meeting-speaker-pill';
    tag.append(pill);
    return tag;
  }

  /** The tag every turn with this label wears, as it should read now. The
   *  name goes on the PILL, never on the button: the button is the tap
   *  target and holds nothing but padding (see the stylesheet). */
  function renderTag(entry: { tag: HTMLElement | null }, label: string): void {
    const tag = entry.tag;
    if (!tag) return;
    const shown = speakerDisplayName(label, names);
    tag.dataset.speaker = label;
    const pill = tag.querySelector('.meeting-speaker-pill');
    if (pill) pill.textContent = shown;
    if (tag instanceof HTMLButtonElement) tag.setAttribute('aria-label', `Name ${shown}`);
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
    opts.liveZone?.setNames({ ...names });
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
          opts.liveZone?.setNames({ ...names });
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
    // A note and a transcript share the line, so the reason the last attempt
    // gave has to go when words start arriving.
    line.querySelector('.meeting-note')?.remove();
    if (state.kind === 'idle') {
      // An idle strip with a live bot shows the bot's words once there are
      // any, and narrates its state until then; with a farewell, the
      // farewell; otherwise the strip is hidden and the line stays empty.
      const live = liveBot();
      if (live && turns.length > 0) {
        renderTurns(false);
        return;
      }
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
    // Recording, and nothing said yet: the line the transcript opens with.
    // It is where the announcement used to go, and it is deliberately a
    // different kind of thing — addressed to the person recording rather than
    // to the room, gone the instant there are words to show instead, and
    // never a control. See `RECORDING_CONSENT_NOTE`. A solo capture has no
    // room to have asked, so it gets no line at all: a reminder with nobody
    // to act on it is a question with no answer (Urgent-fixes ticket,
    // 2026-09-02).
    if (turns.length === 0) {
      if (mode !== 'solo') showNote(RECORDING_CONSENT_NOTE, 'meeting-consent-note');
      return;
    }
    renderTurns(true);
  }

  /**
   * The rolling window onto the line, one span per turn and one per word.
   * `tappable` is whether a speaker tag is the rename button (a microphone
   * meeting) or the fixed label a bot meeting's turns wear.
   */
  function renderTurns(tappable: boolean): void {
    // The zone at the end of the doc is the transcript surface when it
    // exists; the same words rolling in two places read as two meetings.
    if (opts.liveZone) {
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
          const tag = tappable ? speakerButton() : speakerLabel();
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

  function showNote(text: string, extra?: string): void {
    clearTurnSpans();
    const note = document.createElement('span');
    note.className = extra ? `meeting-note ${extra}` : 'meeting-note';
    note.textContent = text;
    line.append(note);
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
    // Mid-meeting tuning (v1 keeps it to this same panel, no new chrome):
    // the recording engine's own Advanced Options, still reachable while it
    // runs. Changes the live session can take apply immediately and say
    // "Applied."; the rest wait for the next recording and say that instead.
    // A bot meeting has no microphone engine to tune, so it gets nothing.
    if (!live && recordingEngine !== null && advancedControls(recordingEngine).length > 0) {
      pop.append(buildAdvancedPanel(recordingEngine, true));
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
   * One change to the LIVE meeting's knobs. Sent only for a key the running
   * engine can take on the open socket; the server answers `tuned` naming
   * what it applied, which is what turns the control's note into "Applied."
   * Everything else — Soniox entirely, and the non-live keys — changes the
   * stored panel and waits for the next recording, which the control already
   * says under itself.
   */
  function sendTune(engineId: string, key: string): void {
    // Whether the ENGINE is currently running this key, per the server's own
    // `tuned` answer — the only honest basis for claiming it still is.
    const wasApplied = appliedKeys.has(key);
    appliedKeys.delete(key);
    if (!socketOpen || !liveTuningKeys(engineId).has(key)) return;
    const value = advFor(engineId)[key];
    if (value === undefined) return;
    // An emptied term list cannot travel — the server's sanitizer drops
    // `[]` (an empty list IS the default) — so the frame would apply
    // nothing and still flash "Applied.". If the engine already took a list
    // this session it is still running it, and the control has to say so:
    // an empty box over live terms is the panel lying about the session.
    if (Array.isArray(value) && value.length === 0) {
      if (wasApplied) staleKeys.add(key);
      return;
    }
    staleKeys.delete(key);
    socket?.send(
      JSON.stringify({
        type: 'tune',
        settings: { [key]: Array.isArray(value) ? [...value] : value },
      }),
    );
  }

  /**
   * The Advanced Options section, shared by the chooser (pre-recording) and
   * the menu (mid-meeting tuning). State lives in `advStates`; every change
   * re-renders the popover — except a slider mid-drag, which the section
   * repaints in place and only commits when the drag settles.
   */
  function buildAdvancedPanel(engineId: string, recording: boolean): HTMLElement {
    const rerenderKeeping = (key: string | null): void => {
      renderPop();
      if (!key) return;
      // Adding a chip rebuilds the panel under the keyboard; hand focus back
      // to the field that was being typed in so a list of terms is one
      // sitting, not one term per tap. The selector only matches a chips
      // control, so a slider commit moves nothing.
      pop
        .querySelector<HTMLInputElement>(
          `.meeting-adv-ctl[data-key="${key}"] .meeting-adv-chips input`,
        )
        ?.focus();
    };
    return buildAdvancedSection({
      engineId,
      state: advFor(engineId),
      open: advOpen,
      recording,
      applied: appliedKeys,
      stale: staleKeys,
      onToggleOpen: () => {
        advOpen = !advOpen;
        renderPop();
      },
      onReset: (wasModified) => {
        // Mid-meeting, the panel's defaults must reach the live session too,
        // or the UI claims defaults the engine is not running. Each reverted
        // live key goes up as its own tune frame carrying the documented
        // default the panel showed beside the knob. Keys the session cannot
        // take already say "next recording" under themselves; a term list it
        // CAN take but cannot be emptied over the wire is the one case that
        // ends diverged, and `sendTune` marks it so the control admits it.
        if (recording) {
          for (const key of wasModified) sendTune(engineId, key);
        }
        renderPop();
      },
      onChange: (key) => {
        if (recording) sendTune(engineId, key);
        rerenderKeeping(key);
      },
    });
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
      // Bryan's late redline on the mock: sighted users saw a plain text box
      // with a prefilled string and no cue what it controlled. A visible
      // caption, not just the aria-label, says what the value becomes.
      const nameHint = document.createElement('span');
      nameHint.className = 'meeting-bot-name-hint';
      nameHint.textContent = 'Name shown in the meeting';
      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'meeting-bot-name';
      name.setAttribute('aria-label', 'Bot display name shown in the meeting — tap to change');
      name.value = chooseBotName;
      name.addEventListener('input', () => {
        chooseBotName = name.value;
      });
      botChoice.body.append(url, nameHint, name);
      source.add(botChoice.el);
    }
    pop.append(source.group);

    // No engine row: the engine is the server's default (or the address's
    // preference), never a question asked here — see the header.
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
    // The one per-engine fact worth stating beside the toggle itself: the
    // cap the AssemblyAI panels offer does not exist on Soniox at all.
    if (chooseEngine === 'soniox' && chooseMode === 'conversation') {
      const note = document.createElement('div');
      note.className = 'meeting-engine-hint';
      note.textContent = "Soniox labels speakers but doesn't cap how many.";
      pop.append(note);
    }

    // Advanced Options, below Speakers: the engine's own knobs, collapsed
    // until asked for. Absent entirely when the engine is unknown (an old
    // server never answered the list).
    if (chooseEngine !== undefined && advancedControls(chooseEngine).length > 0) {
      pop.append(buildAdvancedPanel(chooseEngine, false));
    }

    syncStartActions();
  }

  /**
   * The tail of the chooser — the error line and the start verb — rebuilt from
   * the choices as they stand.
   *
   * Separate from `buildChooser` because it follows the SOURCE and SPEAKERS
   * cards, which are picked without a rebuild.
   *
   * It stays a direct child of `pop` rather than moving into a wrapper of its
   * own: `.meeting-start-actions` is sticky, and a sticky element can only
   * travel inside its parent's box — put it in a wrapper the height of its own
   * contents and it has nowhere to stick to.
   */
  function syncStartActions(): void {
    for (const sel of ['.meeting-pop-error', '.meeting-start-actions']) {
      pop.querySelector(sel)?.remove();
    }

    const err = document.createElement('span');
    err.className = 'meeting-pop-error';
    // Assertive: this one only ever appears in answer to a press, and it is
    // the reason the thing the person just asked for did not happen.
    err.setAttribute('aria-live', 'assertive');
    err.textContent = chooseError;
    pop.append(err);

    // The verb rides a sticky footer: the chooser outgrows the iPad tier's
    // height as soon as Advanced Options is open, so this is the ordinary
    // case, not the edge one.
    const actions = document.createElement('div');
    actions.className = 'meeting-start-actions';

    const startCta = document.createElement('button');
    startCta.type = 'button';
    startCta.className = 'meeting-start-cta';
    startCta.textContent = '● Start Recording';
    startCta.disabled = chooseBusy;
    startCta.addEventListener('click', () => onStartPressed());
    actions.append(startCta);

    pop.append(actions);
  }

  /** Re-mark the selected cards without rebuilding inputs mid-interaction. */
  function renderChoiceSelection(): void {
    for (const card of pop.querySelectorAll('.meeting-choice')) {
      const input = card.querySelector('input');
      card.classList.toggle('is-selected', input?.checked === true);
    }
    // The verbs below depend on what was just picked. Guarded because this
    // runs off card clicks, and only the chooser has cards — a menu that
    // grew one later must not sprout a Start button.
    if (view === 'chooser') syncStartActions();
  }

  /** The chooser's one verb. */
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
    closePop();
    void start(false);
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
    if (state.kind !== 'idle') return true;
    if (liveBot()) return true;
    if (botFarewell()) return true;
    return false;
  }

  function render(): void {
    root.dataset.state = state.kind;
    // The options door is for a start; a running meeting has Record's menu.
    options.hidden = popForNow() !== 'chooser';
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
          note.addEventListener('click', () => void start(false));
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
      // However the meeting ended, there is no live session left to tune —
      // the menu's Advanced panel and its "Applied." notes end with it. The
      // tuned VALUES stay in `advStates`, which is the point: they are what
      // the next recording starts from.
      recordingEngine = null;
      appliedKeys.clear();
      staleKeys.clear();
    }
    render();
  }

  function releaseAudio(): void {
    capture?.stop();
    capture = null;
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
        // What the SERVER opened is what the menu's Advanced panel tunes —
        // the ask and the answer differ when the ask was refused.
        recordingEngine = msg.engine || null;
        appliedKeys.clear();
        staleKeys.clear();
        // Where a rename lands once this meeting's socket is gone.
        if (msg.meetingId) lastMeetingId = msg.meetingId;
        {
          const startedAt = now();
          // Same clock reading for the state and the zone, so the strip's
          // elapsed readout and the zone's per-line stamps agree.
          opts.liveZone?.begin(startedAt);
          setState({ kind: 'recording', startedAt });
        }
        break;
      case 'transcript':
        // Noted before the render and closed after it, so the DOM leg is the
        // strip's own work and nothing else.
        timing?.frameReceived(msg, recvMs);
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
        opts.liveZone?.onTurn({
          turn: msg.turn,
          text: msg.text,
          final: msg.final,
          ...(msg.speaker !== undefined ? { speaker: msg.speaker } : {}),
        });
        renderFeed();
        timing?.domUpdated();
        break;
      case 'notes_progress':
        // The zone is the only reader; a strip without one drops the frame.
        opts.liveZone?.onProgress(msg);
        break;
      case 'timing_pong':
        timing?.onPong(msg, recvMs);
        break;
      case 'tuned':
        // Only what the server actually applied earns the "Applied." note —
        // a key it names is one that reached the live engine session. The
        // note stands until that knob moves again or the meeting ends.
        for (const key of msg.applied) appliedKeys.add(key);
        if (view === 'menu') renderPop();
        break;
      case 'unavailable':
        // The words are never coming, so the mic goes back rather than sitting
        // open behind a settled state.
        releaseAudio();
        closeSocket();
        opts.liveZone?.end();
        setState({ kind: 'unavailable', reason: msg.reason, message: msg.message });
        break;
      case 'stopped':
        releaseAudio();
        closeSocket();
        opts.liveZone?.end();
        setState({ kind: 'idle' });
        break;
      case 'error':
        releaseAudio();
        closeSocket();
        opts.liveZone?.end();
        setState({ kind: 'error', message: msg.message || 'The meeting ended unexpectedly.' });
        break;
    }
  }

  async function start(auto = false): Promise<void> {
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
          // Who is on this socket, for the raw transcript's attribution of
          // turns the engine gives no label. Absent when nobody is signed in.
          ...(opts.participantName ? { participant: opts.participantName } : {}),
          // The server's default, or the address's preference — never a pick
          // made here. A server that has never heard of engines never
          // receives the field, and this frame is byte-for-byte what an
          // older strip sent.
          ...(chooseEngine !== undefined ? { engine: chooseEngine } : {}),
          // The Advanced Options — modified knobs only, and PRESENT even
          // when empty: sending the field is what hands the speaker cap to
          // the panel (default uncapped) instead of the legacy fallback.
          // Absent when the engine is unknown, which keeps an old server's
          // frame byte-for-byte what it was.
          ...(chooseEngine !== undefined && advancedControls(chooseEngine).length > 0
            ? { tuning: tuningPayload(chooseEngine, advFor(chooseEngine)) }
            : {}),
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
      releaseAudio();
      opts.liveZone?.end();
      setState({ kind: 'error', message: 'The connection to the meeting was lost.' });
    };
    // `error` is always followed by `close`; reporting both would overwrite the
    // message with itself.
    sock.onerror = null;
  }

  function stop(): void {
    if (socketOpen) socket?.send(JSON.stringify({ type: 'stop' }));
    releaseAudio();
    closeSocket();
    opts.liveZone?.end();
    setState({ kind: 'idle' });
  }

  const onRecordClick = (): void => {
    if (view !== 'none') {
      closePop();
      return;
    }
    const want = popForNow();
    // Alone on the doc and nothing running: the tap IS the start. Solo,
    // because nobody else is here to label; the engine the server defaults
    // to, because that is not this person's question. Everything the chooser
    // would have asked stays one tap away behind the options button.
    if (want === 'chooser' && opts.alone?.() === true) {
      mode = 'solo';
      void start(false);
      return;
    }
    openPop(want);
  };
  record.addEventListener('click', onRecordClick);
  const onOptionsClick = (): void => {
    if (view !== 'none') {
      closePop();
      return;
    }
    openPop('chooser');
  };
  options.addEventListener('click', onOptionsClick);
  const onScrim = (): void => closePop();
  scrim.addEventListener('click', onScrim);
  const onKeydown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && view !== 'none') closePop();
  };
  document.addEventListener('keydown', onKeydown);

  const offBot = bot?.onChange(() => {
    if (disposed) return;
    const live = bot.live() !== null;
    if (live) {
      sawLiveBot = true;
      botNoteDismissed = false;
    }
    if (live !== botWasLive) {
      botWasLive = live;
      // A bot meeting starting or ending is a meeting boundary, the same one
      // `start` draws for the microphone: the window empties so the next
      // meeting's turn 0 is not "older than the newest" and dropped, and a
      // new bot's cast is a new cast. The names stay when the bot LEAVES —
      // they are the record's, and the post-meeting rename (over HTTP, to
      // `lastMeetingId`) is addressed to exactly that meeting.
      turns = [];
      if (live) {
        names = {};
        seen = new Set();
        lastMeetingId = null;
      }
      // The zone follows the same boundary: a bot meeting ending clears it
      // (it began on the bot's first word), and one starting begins fresh.
      if (!live && state.kind === 'idle') opts.liveZone?.end();
    }
    render();
  });
  /**
   * The bot's words, through the SAME fold as the microphone's frames.
   * Rendered only while the strip's own capture is idle and a bot is live —
   * the server refuses a second capture on a doc, so anything else is a
   * frame for a meeting this strip is not showing.
   */
  const offBotWords = bot?.onTranscript((frame: MeetingTranscriptEvent) => {
    if (disposed || state.kind !== 'idle' || !liveBot()) return;
    if (frame.meetingId) lastMeetingId = frame.meetingId;
    if (frame.speaker !== undefined) {
      const grew = !seen.has(frame.speaker);
      seen.add(frame.speaker);
      // The platform's name for the voice fills the map a person fills by
      // tapping on the microphone path; a later frame naming it differently
      // (a disambiguated duplicate) wins, as a later tap would.
      if (frame.speakerName) {
        names[frame.speaker] = frame.speakerName;
        opts.liveZone?.setNames({ ...names });
      }
      if (grew && view === 'menu') renderPop();
    }
    turns = rollTranscript(turns, {
      turn: frame.turn,
      text: frame.text,
      final: frame.final,
      ...(frame.speaker !== undefined ? { speaker: frame.speaker } : {}),
    });
    // A bot meeting has no `ready` frame on this socket, so the zone starts
    // on the first word. Its stamps count from that word rather than from
    // the call's true start — the bot's stream carries no start time here.
    if (opts.liveZone && !opts.liveZone.active()) opts.liveZone.begin(now());
    opts.liveZone?.onTurn({
      turn: frame.turn,
      text: frame.text,
      final: frame.final,
      ...(frame.speaker !== undefined ? { speaker: frame.speaker } : {}),
    });
    renderFeed();
  });
  // The bot feature answers whether it exists a beat after mount; a chooser
  // opened in that beat should grow the bot source when the answer lands.
  void bot?.ready.then(() => {
    if (!disposed && view === 'chooser') renderPop();
  });

  render();
  if (opts.autoStart) void start(true);
  // A discussion arrives at the choice, not at the microphone.
  else if (opts.autoChoose) openPop('chooser');
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
    destroy: () => {
      disposed = true;
      generation += 1;
      record.removeEventListener('click', onRecordClick);
      options.removeEventListener('click', onOptionsClick);
      scrim.removeEventListener('click', onScrim);
      document.removeEventListener('keydown', onKeydown);
      offBot?.();
      offBotWords?.();
      timing?.destroy();
      releaseAudio();
      closeSocket();
      stopClock?.();
      stopClock = null;
      clearTurnSpans();
      closePop();
      record.remove();
      options.remove();
      scrim.remove();
      pop.remove();
      root.classList.remove('is-live', 'is-bot');
      root.hidden = true;
      root.removeAttribute('data-state');
      root.replaceChildren();
    },
  };
}
