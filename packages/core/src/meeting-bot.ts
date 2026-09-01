/**
 * The meeting BOT's wire contract — a bot that dials into a Zoom or Google
 * Meet call and feeds the same meeting-assistant pipeline the browser
 * microphone does.
 *
 * WHY A SECOND CAPTURE PATH RATHER THAN A SECOND PRODUCT. Everything after
 * the words — the transcript record, the pause/cadence notes composer, task
 * capture, the rename that reaches backwards — is written against
 * `EngineTurn`: a turn number, the whole turn's text, a `final` flag and an
 * opaque speaker label. A bot that produces those four things reuses all of
 * it. So this contract stops at the words: nothing here knows about notes.
 *
 * TWO EVENTS ON ONE CHANNEL, WITH DIFFERENT DURABILITY. A bot's state
 * changes a handful of times in a meeting — joining, waiting for the host,
 * recording, gone — so it rides the doc's SSE channel like `meeting.started`
 * does, buffered for reconnect replay. Its WORDS ride the same channel —
 * every viewer of the doc already holds that stream, and a second socket per
 * tab for a bot that has no browser of its own would be a socket nothing
 * else needs — but they are TRANSIENT: fanned out live and never buffered.
 * The hub keeps 200 events per channel for replay and a conversation says
 * that many words in about a minute, so a buffered word ticker would evict
 * every real doc event within a minute of the bot joining. A transient frame
 * carries no SSE id, so a reconnecting tab's cursor never points at one; the
 * words missed during a blip are gone, exactly as they are on the microphone
 * socket, and the durable transcript is the record either way.
 */

import type { MeetingServerMessage } from './meeting.ts';

/**
 * Where a bot is in its life, as a person would describe it.
 *
 * Deliberately COARSER than the vendor's status list: the states here are the
 * ones that change what a person should do — wait, click allow in Zoom, try a
 * different link. Vendor codes we do not model are carried in `detail` rather
 * than growing this union, because a state nobody can act on is a word on a
 * screen that costs a render and answers nothing.
 */
export type MeetingBotState =
  /** Accepted by the vendor; it has not reached the call yet. */
  | 'requested'
  /** Dialling in. */
  | 'joining'
  /** Parked in the meeting's waiting room — a human has to admit it. */
  | 'waiting_room'
  /** In the call, not recording. On Zoom this is usually the moment before
   *  the permission request goes to the host. */
  | 'in_call'
  /** Zoom's own recording-consent prompt is in front of the host. */
  | 'awaiting_permission'
  /** The host said no. Terminal: the bot leaves on its own timeout. */
  | 'permission_denied'
  /** Recording. Words are flowing. */
  | 'recording'
  /** The call ended or the bot was asked to leave. Terminal. */
  | 'left'
  /** The vendor gave up. Terminal; `detail` carries its reason. */
  | 'failed';

/** The states after which nothing more will happen without a new invite. */
export const TERMINAL_BOT_STATES: readonly MeetingBotState[] = [
  'permission_denied',
  'left',
  'failed',
];

export function isTerminalBotState(state: MeetingBotState): boolean {
  return TERMINAL_BOT_STATES.includes(state);
}

/**
 * What the doc's UI renders. `meetingUrl` is echoed back because the person
 * who invited the bot may not be the person looking at the strip.
 */
export interface MeetingBotStatus {
  botId: string;
  docId: string;
  state: MeetingBotState;
  meetingUrl: string;
  /** `zoom` / `google_meet` / `teams`, when the URL identified one. */
  platform: MeetingPlatform | null;
  /** Vendor detail for a state a person cannot act on. Never a credential. */
  detail?: string;
  /** Display names of everyone the bot has heard, in first-heard order. */
  speakers: string[];
  updatedAt: number;
}

/** The SSE event a doc's viewers receive when its bot changes state. */
export const MEETING_BOT_EVENT = 'meeting.bot' as const;

/**
 * The SSE event carrying one turn of a bot meeting's live transcript.
 *
 * Transient on the wire (see the header): fanned out to every open stream,
 * never buffered, never given an id. Reaches the strip through the same
 * `rollTranscript` fold the microphone's socket frames use.
 */
export const MEETING_TRANSCRIPT_EVENT = 'meeting.transcript' as const;

/** The microphone socket's own transcript frame, the shape both paths share. */
export type MeetingTranscriptFrame = Extract<MeetingServerMessage, { type: 'transcript' }>;

/**
 * One live turn of a bot meeting, as the doc's viewers receive it.
 *
 * The same four facts the socket frame carries — `turn`, whole-turn `text`,
 * `final`, and an opaque `speaker` label — plus the two the bot path knows
 * and the microphone does not: which meeting this is, and the display name
 * the platform gave the voice. `speaker` stays the label (`p7`) so the strip
 * keys its tags and its name map exactly as it does for `"A"`; `speakerName`
 * is what fills that map without a person having to. The name is optional on
 * the wire so a frame for a voice the platform did not name still renders.
 */
export interface MeetingTranscriptEvent {
  event: typeof MEETING_TRANSCRIPT_EVENT;
  docId: string;
  meetingId: string;
  turn: number;
  text: string;
  final: boolean;
  speaker?: string;
  speakerName?: string;
}

/** Parse the SSE data of a `meeting.transcript` event; null for anything
 *  malformed. Same tolerance as `parseMeetingServerMessage`'s transcript
 *  branch: a turn number and a text string are required, the rest optional. */
export function parseMeetingTranscriptEvent(raw: unknown): MeetingTranscriptEvent | null {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  if (typeof m.turn !== 'number' || !Number.isFinite(m.turn)) return null;
  if (typeof m.text !== 'string') return null;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    event: MEETING_TRANSCRIPT_EVENT,
    docId: str(m.docId),
    meetingId: str(m.meetingId),
    turn: m.turn,
    text: m.text,
    final: m.final === true,
    ...(typeof m.speaker === 'string' && m.speaker ? { speaker: m.speaker } : {}),
    ...(typeof m.speakerName === 'string' && m.speakerName ? { speakerName: m.speakerName } : {}),
  };
}

/** The platforms this integration claims to support. */
export type MeetingPlatform = 'zoom' | 'google_meet' | 'teams';

/**
 * Identify the platform from the meeting URL.
 *
 * Used for two decisions, both of which have to be made BEFORE the bot exists:
 * whether to ask for Zoom's native recording permission (Zoom only), and
 * whether to refuse the invite outright. Refusing a URL we cannot name is the
 * point — a mistyped link otherwise becomes a bot that bills for a minute of
 * dialling nowhere.
 */
export function meetingPlatformOf(rawUrl: string): MeetingPlatform | null {
  let host: string;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    host = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
  // Suffix matches, anchored on a dot, so `zoom.us.evil.example` is not Zoom.
  const endsWith = (suffix: string): boolean => host === suffix || host.endsWith(`.${suffix}`);
  if (endsWith('zoom.us')) return 'zoom';
  if (endsWith('meet.google.com')) return 'google_meet';
  if (endsWith('teams.microsoft.com') || endsWith('teams.live.com')) return 'teams';
  return null;
}

/** One line a person can read for each state. Shared so the strip and any
 *  agent-facing tool describe a bot the same way. */
export function describeBotState(state: MeetingBotState): string {
  switch (state) {
    case 'requested':
      return 'Bot requested';
    case 'joining':
      return 'Joining the call';
    case 'waiting_room':
      return 'Waiting to be let in';
    case 'in_call':
      return 'In the call, not recording yet';
    case 'awaiting_permission':
      return 'Waiting for the host to allow recording';
    case 'permission_denied':
      return 'The host declined recording';
    case 'recording':
      return 'Recording';
    case 'left':
      return 'The bot has left';
    case 'failed':
      return 'The bot could not join';
  }
}
