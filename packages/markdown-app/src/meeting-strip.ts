/**
 * The live-meeting transcript strip: a bar along the bottom of the editor pane
 * that owns the doc's audio socket and renders what is being heard.
 *
 * IT IS THE ONLY SURFACE A MEETING HAS. The transcript is never written into
 * the document — the notes agent does that later, from the durable transcript
 * the server keeps — so every state a meeting can be left in has to arrive as
 * words here: a mic that was refused, an origin the browser will not give a
 * mic on at all, a server with no transcription key. A strip that renders
 * nothing in those cases is a Start button that does nothing when pressed,
 * which is the failure this file exists to avoid.
 *
 * IT RESERVES HEIGHT. The strip is the editor pane's third grid row, so the
 * scrolling document is shorter by exactly its height rather than running
 * underneath it. Layout rules live in styles.css under MEETING TRANSCRIPT
 * STRIP and are asserted in `meeting-strip-css.test.ts`, because no DOM test
 * resolves layout.
 *
 * IT ANNOUNCES A ROOM CAPTURE, AND THE ANNOUNCEMENT IS PART OF THE RECORDING.
 * A `conversation` capture is the one with other people in it, so it says so
 * out loud before anything else is said. The order is the point and it is the
 * opposite of the obvious one: the microphone opens FIRST and the sentence is
 * spoken into it, so the announcement is in the captured audio and in the
 * transcript rather than in a moment before the recording that nothing can be
 * shown afterwards. `I'll say it` starts the same capture and puts the
 * sentence on screen instead, for a person who would rather say it themselves
 * — and it is also where a device that cannot speak ends up. A `solo` capture
 * announces nothing; there is nobody to tell.
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
  type MeetingServerMessage,
  type MeetingTimingMark,
  type MeetingUnavailableReason,
  RECORDING_ANNOUNCEMENT,
  announcesRecording,
  meetingSocketPath,
  parseCaptureMode,
  speakerDisplayName,
} from '@feedback/core';
import { type Announcer, createAnnouncer } from './meeting-announce.ts';
import {
  type MeetingCapture,
  type MeetingCaptureStart,
  type RoomAudioProcessing,
  startMeetingCapture,
} from './meeting-audio.ts';
import { type TimingSession, createTimingSession } from './meeting-timing-client.ts';

/**
 * How many turns stay on the strip. Three is what fits the phone's two wrapped
 * lines; the bar shows the tail of the same three.
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

/** What the strip is showing. */
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
   * apart, so it offers its one button as "Tap to start the mic" rather than
   * reporting a refusal nobody made. A tap is a gesture, so a refusal after
   * that is reported as what it is.
   */
  autoStart?: boolean;
  /**
   * What this capture expects to hear. `solo` (the default) opens a cheap
   * session with no diarization; `conversation` pays for speaker labels. The
   * Board's "Record a conversation" button carries it in on the address.
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
   * Ask the person what to call a speaker; `current` is what the tag says
   * now. Null or blank means leave it. Defaults to `window.prompt` — the
   * strip is a 40px bar with no room for an inline field, and a name is
   * typed once per voice per meeting.
   */
  promptName?: (current: string) => string | null;
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
 * the tag while the record and the notes never heard it. The clip falls back
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
  return `${kept.trimEnd()}\u2026`;
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
export function announcementNote(by: AnnouncedBy): string {
  const said = `\u201c${RECORDING_ANNOUNCEMENT}\u201d`;
  return by === 'device' ? `Announcing: ${said}` : `Say this out loud: ${said}`;
}

export function mountMeetingStrip(opts: MeetingStripOpts): MeetingStripHandle {
  const { docId, root } = opts;
  const now = opts.now ?? Date.now;
  const interval = opts.interval ?? defaultInterval;
  const openSocket = opts.openSocket ?? defaultOpenSocket;
  const startCapture = opts.startCapture ?? startMeetingCapture;
  const promptName = opts.promptName ?? defaultPromptName;
  const announcer = opts.announcer ?? createAnnouncer();

  const strip = document.createElement('div');
  strip.className = 'meeting-strip-row';
  const meta = document.createElement('span');
  meta.className = 'meeting-meta';
  const dot = document.createElement('span');
  dot.className = 'meeting-dot';
  dot.setAttribute('aria-hidden', 'true');
  const status = document.createElement('span');
  status.className = 'meeting-status';
  const elapsed = document.createElement('span');
  elapsed.className = 'meeting-elapsed';
  meta.append(dot, status, elapsed);
  /**
   * "Detect multiple speakers" — the one thing that buys diarization.
   *
   * It is a switch rather than two Start buttons because it is a fact about
   * the room, not a second way to record, and it reads the same on the board
   * (where "Record a conversation" sets it) and on a doc Bryan is talking to
   * himself over. The label never changes with the state — `aria-pressed`
   * carries that — because a button whose text flips between the state and
   * the action cannot be read either way.
   */
  const modeToggle = document.createElement('button');
  modeToggle.type = 'button';
  modeToggle.className = 'meeting-mode';
  modeToggle.textContent = 'Multiple speakers';
  modeToggle.setAttribute('aria-label', 'Detect multiple speakers');
  /**
   * "I'll say it" — the second half of the hybrid, and a START button rather
   * than a preference.
   *
   * It has to start the capture itself, not merely change who speaks: the
   * announcement only counts if it is IN the recording, so a person saying it
   * needs the microphone already open exactly as much as the device does.
   * Pressing it opens the mic, puts the sentence on screen, and keeps quiet.
   * It appears only where it means something — a `conversation` capture that
   * has not started yet — because on a solo capture there is nobody to tell.
   */
  const announceToggle = document.createElement('button');
  announceToggle.type = 'button';
  announceToggle.className = 'meeting-announce';
  announceToggle.textContent = "I'll say it";
  announceToggle.title =
    'Start recording and read the announcement out yourself, instead of the device saying it.';
  announceToggle.setAttribute('aria-label', 'Start recording and announce it yourself');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'meeting-toggle';
  strip.append(meta, modeToggle, announceToggle, toggle);

  const caption = document.createElement('div');
  caption.className = 'meeting-caption';
  caption.setAttribute('aria-live', 'polite');
  const line = document.createElement('p');
  line.className = 'meeting-caption-line';
  caption.append(line);

  /**
   * Built only for a measured meeting. The readout is a THIRD child rather
   * than another item on the strip's one line: at 1180px the bar is 40px with
   * the caption already claiming the middle, and at 430px the panel is two
   * wrapped lines above the home indicator. A row of its own, present only
   * under the flag, cannot crowd either.
   */
  const timing: TimingSession | null = opts.timing
    ? createTimingSession({ now, send: (json) => socket?.send(json) })
    : null;

  root.classList.add('meeting-strip');
  root.classList.toggle('has-timing', timing !== null);
  root.replaceChildren(...(timing ? [strip, caption, timing.element] : [strip, caption]));
  root.hidden = false;

  let state: StripState = { kind: 'idle' };
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
   * Paused.
   */
  let generation = 0;
  /**
   * Solo unless this capture was asked to listen for a room. Held across
   * start/stop within one mount: the person who turned it on is still in the
   * same conversation after a pause. Never persisted beyond the mount —
   * a mode remembered from yesterday spends money on a session nobody chose
   * it for.
   */
  let mode: CaptureMode = opts.mode ?? DEFAULT_CAPTURE_MODE;
  /** The auto-start was refused in the way a missing gesture is: the button
   *  is the tap that supplies one, and says so. Cleared by any press. */
  let tapToStart = false;
  /**
   * Which button started this capture, and so who is meant to say the
   * sentence. Undefined when there is nobody to tell. This is an INTENTION —
   * it is not what the record is told.
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
   * The announcement prompt owns the caption line and will not be pushed off
   * it by words.
   *
   * A person reading the sentence aloud needs it to STAY there, and the
   * caption is one line: a partial from an air conditioner, or from whoever
   * was already mid-thought, would otherwise wipe the sentence out from
   * under them a moment after it appeared. So while this holds, transcript
   * turns accumulate in `turns` but are not drawn. It lifts on a SETTLED
   * turn — a whole utterance has finished, which is the earliest evidence
   * the sentence has been said — or on a tap, whichever comes first.
   */
  let holdAnnouncement = false;

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
    names[label] = answer;
    for (const entry of rendered.values()) {
      if (entry.tag?.dataset.speaker === label) renderTag(entry, label);
    }
    if (socketOpen) {
      socket?.send(JSON.stringify({ type: 'name_speaker', speaker: label, name: answer }));
    }
  }

  function renderCaption(): void {
    if (state.kind !== 'idle' && state.kind !== 'recording') return;
    // The announcement holds the line against the words; see `holdAnnouncement`.
    if (holdAnnouncement) return;
    // A note and a transcript share the line, so the reason the last attempt
    // gave has to go when words start arriving.
    line.querySelector('.meeting-note')?.remove();
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
          const tag = document.createElement('button');
          tag.type = 'button';
          tag.className = 'meeting-speaker';
          tag.title = 'Tap to name this speaker';
          // The pill is a child so the button itself can stay free of the
          // overflow that clipping a long name needs — a clip anywhere on
          // the button eats its own tap target.
          const pill = document.createElement('span');
          pill.className = 'meeting-speaker-pill';
          tag.append(pill);
          tag.addEventListener('click', () => nameSpeaker(tag.dataset.speaker ?? ''));
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
        // cannot line-break, which on the phone's wrapped lines would pin a
        // word boundary mid-line. At the start of a line it collapses away.
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

  function clearCaption(): void {
    rendered.clear();
    line.replaceChildren();
  }

  function showNote(text: string): void {
    clearCaption();
    const note = document.createElement('span');
    note.className = 'meeting-note';
    note.textContent = text;
    line.append(note);
  }

  /**
   * The sentence, held on the line until it has been said. A button because
   * it is dismissible, and a dismissible thing has to be reachable by more
   * than a pointer.
   */
  function showAnnouncement(text: string): void {
    holdAnnouncement = true;
    clearCaption();
    const note = document.createElement('button');
    note.type = 'button';
    note.className = 'meeting-note meeting-note-dismiss';
    note.textContent = text;
    note.title = 'Dismiss';
    note.setAttribute('aria-label', `${text} (tap to dismiss)`);
    note.addEventListener('click', releaseAnnouncement);
    line.append(note);
  }

  /** Give the line back to the transcript, and draw whatever arrived. */
  function releaseAnnouncement(): void {
    if (!holdAnnouncement) return;
    holdAnnouncement = false;
    clearCaption();
    renderCaption();
  }

  function tickClock(): void {
    elapsed.textContent =
      state.kind === 'recording' ? formatElapsed(now() - state.startedAt) : formatElapsed(0);
  }

  /**
   * The mode is settled when the mic starts and cannot move while it runs:
   * a streaming session's configuration IS its connect URL, so switching
   * mid-meeting would mean a second session and a second bill for the same
   * conversation. Stop and start says that plainly.
   */
  function renderMode(): void {
    const live = state.kind === 'recording' || state.kind === 'requesting';
    modeToggle.setAttribute('aria-pressed', String(mode === 'conversation'));
    modeToggle.disabled = live;
    modeToggle.title = live
      ? 'Set before the mic starts — stop and start again to change it.'
      : 'Label who is talking. Leave it off when you are the only voice: it costs more.';
    // Only where it means something: a room capture that has not begun. While
    // one runs, the announcement has already happened; on a solo capture
    // there was never anyone to announce it to; and where Start itself cannot
    // be pressed, neither can this.
    announceToggle.hidden = !announcesRecording(mode) || live || toggle.disabled;
  }

  function render(): void {
    root.dataset.state = state.kind;
    root.classList.toggle('is-live', state.kind === 'recording');
    // The visible label is one bare word in a strip that never says what it
    // is — the accessible name carries the feature's name instead.
    toggle.setAttribute(
      'aria-label',
      `${state.kind === 'recording' ? 'Stop' : 'Start'} meeting transcription`,
    );
    switch (state.kind) {
      case 'idle':
        status.textContent = 'Paused';
        toggle.textContent = 'Start';
        toggle.disabled = false;
        break;
      case 'requesting':
        status.textContent = 'Starting…';
        toggle.textContent = 'Start';
        toggle.disabled = true;
        showNote('Asking for the microphone…');
        break;
      case 'recording':
        status.textContent = 'REC';
        toggle.textContent = 'Stop';
        toggle.disabled = false;
        break;
      case 'unavailable':
        status.textContent = 'Off';
        toggle.textContent = 'Start';
        // Nothing is retrying and no key is going to appear on its own; the
        // other two reasons can clear without anyone editing a config.
        toggle.disabled = state.reason === 'not_configured';
        showNote(state.message || unavailableFallback(state.reason));
        break;
      case 'blocked':
      case 'error':
        status.textContent = 'Off';
        toggle.textContent = tapToStart ? 'Tap to start the mic' : 'Start';
        // Deliberately pressable: the press is how someone sees the reason
        // again after granting the permission the message named.
        toggle.disabled = false;
        showNote(tapToStart ? 'The huddle is on — the mic needs one tap to start.' : state.message);
        break;
    }
    renderMode();
    tickClock();
    renderCaption();
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
   * The meeting is over, however it ended: nothing may still be announcing
   * it.
   *
   * Called from EVERY terminal path, not only from Stop, and that is the
   * point — a relay error or a dropped socket ends a recording just as
   * finally as the button does. Without this the device carries on saying
   * "this conversation is being recorded" into a room where it is not, and
   * the sentence's late resolution can write a claim onto a meeting that
   * failed. The generation bump is what makes the pending `announce()`
   * return without touching anything.
   */
  /**
   * The echo-cancellation hedge, and its own failure swallowed HERE rather
   * than trusted of the capture.
   *
   * `setEchoCancellation` promises never to reject, but an announcement that
   * a room is owed must not be able to fail because a hedge did: a rejection
   * reaching `announce` would take the whole sentence down with it, and the
   * one thing that must never happen here is silence.
   */
  /**
   * The capture is passed in rather than read from the closure, and that is
   * the whole point of the parameter. An utterance that was cancelled can
   * stay pending for its full timeout, so the restore half of this pair can
   * run long after its meeting ended — by which time `capture` is the NEXT
   * meeting's microphone, in the middle of the NEXT announcement. Restoring
   * cancellation there is exactly the bug this suspension exists to prevent.
   * Bound to the instance, a stale restore lands on a track that is already
   * stopped, which is nothing.
   */
  async function suspendEchoCancellation(
    mic: MeetingCapture | null,
    suspended: boolean,
  ): Promise<void> {
    try {
      await mic?.setEchoCancellation(!suspended);
    } catch {
      // Then the capture keeps the cancellation it has, and the sentence is
      // spoken into it anyway.
    }
  }

  function endAnnouncement(): void {
    generation += 1;
    holdAnnouncement = false;
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
        turns = rollTranscript(turns, {
          turn: msg.turn,
          text: msg.text,
          final: msg.final,
          ...(msg.speaker !== undefined ? { speaker: msg.speaker } : {}),
        });
        renderCaption();
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
    /** Tell the server the room HAS been told — never before it has. */
    const claim = (path: AnnouncedBy): void => {
      announced = path;
      if (socketOpen) socket?.send(JSON.stringify({ type: 'announced', by: path }));
    };
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
    const spoke = await announcer.speak(RECORDING_ANNOUNCEMENT);
    await suspendEchoCancellation(mic, false);
    // A stop, or a second meeting, during the sentence: this one no longer
    // owns the strip or the socket, and — the reason nothing is claimed at
    // start — the room heard half a sentence at most, so the record is left
    // saying nothing rather than saying the device announced it.
    if (disposed || attempt !== generation) return;
    if (spoke) {
      claim('device');
      return;
    }
    showAnnouncement(announcementNote('spoken'));
    claim('spoken');
  }

  async function start(auto = false, by: AnnouncedBy = 'device'): Promise<void> {
    if (state.kind === 'requesting' || state.kind === 'recording') return;
    const attempt = ++generation;
    turns = [];
    names = {};
    tapToStart = false;
    // A solo capture announces nothing, whichever button was pressed — the
    // announce button is hidden there, but the mode can also come in off the
    // address, and the record must not claim a room was told when the mode
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
      // Read HERE rather than at mount: the switch can be flipped between
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

  const onToggle = (): void => {
    if (state.kind === 'recording' || state.kind === 'requesting') {
      stop();
      return;
    }
    // PRIMED HERE, SYNCHRONOUSLY, AND NOWHERE ELSE. iOS Safari only unlocks
    // speech from inside the gesture's own task, and the announcement itself
    // cannot be spoken here — it has to wait for the microphone. So the tap
    // spends its gesture on a silent utterance, and the real sentence rides
    // the unlock later. See meeting-announce.ts.
    if (announcesRecording(mode)) announcer.prime();
    void start(false, 'device');
  };
  toggle.addEventListener('click', onToggle);
  const onAnnounceToggle = (): void => {
    if (state.kind === 'recording' || state.kind === 'requesting') return;
    // No priming: the whole point of this button is that the device stays
    // quiet and a person says it.
    void start(false, 'spoken');
  };
  announceToggle.addEventListener('click', onAnnounceToggle);
  const onModeToggle = (): void => {
    if (state.kind === 'recording' || state.kind === 'requesting') return;
    mode = mode === 'conversation' ? 'solo' : 'conversation';
    renderMode();
  };
  modeToggle.addEventListener('click', onModeToggle);

  render();
  if (opts.autoStart) void start(true);

  return {
    state: () => state,
    mode: () => mode,
    announced: () => announced,
    destroy: () => {
      disposed = true;
      generation += 1;
      announcer.cancel();
      toggle.removeEventListener('click', onToggle);
      announceToggle.removeEventListener('click', onAnnounceToggle);
      modeToggle.removeEventListener('click', onModeToggle);
      timing?.destroy();
      releaseAudio();
      closeSocket();
      stopClock?.();
      stopClock = null;
      clearCaption();
      root.classList.remove('is-live');
      root.hidden = true;
      root.removeAttribute('data-state');
      root.replaceChildren();
    },
  };
}
