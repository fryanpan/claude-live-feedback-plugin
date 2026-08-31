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
 * WHY THE STATE IS ITS OWN CHANNEL AND THE WORDS ARE NOT. A bot's state
 * changes a handful of times in a meeting — joining, waiting for the host,
 * recording, gone — so it rides the doc's SSE channel like `meeting.started`
 * does. The transcript does NOT: the SSE hub keeps 200 events per channel for
 * reconnect replay and a conversation emits that many words in about a
 * minute. The browser-mic path solves that by sending words back down the
 * socket that sent the audio; a bot meeting has no such socket, so a live
 * word ticker for bot meetings needs its own observer channel and is
 * deliberately NOT in this contract. What a viewer gets today is the bot's
 * state and the notes composing themselves into the doc.
 */

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
