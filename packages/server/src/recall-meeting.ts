/**
 * The bot half of the meeting assistant's lifecycle.
 *
 * `meeting-protocol.ts` is the microphone's: the audio socket IS the meeting,
 * and every way it ends ends the meeting. A bot meeting has no such socket.
 * Its lifecycle is a sequence of vendor STATUS FACTS arriving on a webhook,
 * and its words arrive on a socket the vendor dialled — two channels that can
 * be late, out of order, or (for the webhook) absent entirely. So the rule
 * here is different and stated once:
 *
 *   THE FIRST WORD STARTS THE MEETING; A TERMINAL STATE ENDS IT.
 *
 * Not "the `bot.in_call_recording` webhook starts it". A transcript frame is
 * proof that recording is happening; the webhook is a report that it is. If
 * the report is late, the words would otherwise be dropped on the floor with
 * no meeting to record them into — which is the failure a person would
 * describe as "the bot joined and the notes never came". The webhook still
 * moves the state a person reads, and still ends the meeting, because the
 * absence of words is not evidence of anything.
 *
 * WHAT THIS SHARES WITH THE MICROPHONE PATH, deliberately and completely: the
 * `MeetingStore` record, `beginNotesSession`, the `meeting.started` /
 * `meeting.stopped` broadcasts, and the speaker-name machinery. A bot meeting
 * is not a second kind of meeting — it is the same meeting with a different
 * way of hearing.
 */

import {
  MEETING_BOT_EVENT,
  type MeetingBotState,
  type MeetingBotStatus,
  type MeetingPlatform,
  isTerminalBotState,
  meetingPlatformOf,
} from '@feedback/core';
import {
  type MeetingNotesDeps,
  type MeetingNotesSession,
  beginNotesSession,
} from './meeting-notes.ts';
import type { ActiveMeeting, MeetingStore } from './meetings.ts';
import type { BotStatusEvent } from './recall-status.ts';
import { SpeakerNamer, TurnAllocator, parseRecallFrame } from './recall-turns.ts';
import type { RecallClient } from './recall.ts';

/** The engine name written into the meeting record for a bot meeting. */
export const BOT_ENGINE_NAME = 'recall+assemblyai';

/** Sample rate the record carries. Recall's separate audio is 16 kHz mono. */
const BOT_SAMPLE_RATE = 16_000;

/**
 * Seconds a bot waits after the host refuses before leaving on its own.
 *
 * Non-zero because Zoom's prompt can be answered late, and short because a
 * bot sitting in a call it may not record is a meter running for nothing.
 */
const PERMISSION_DENIED_TIMEOUT_SEC = 60;

/** How long `dispose` gives the vendor to take every bot out of its call. */
const DISPOSE_LEAVE_MS = 5_000;

export interface RecallMeetingDeps {
  store: MeetingStore;
  /** Same no-default seam as the microphone path: null composes no notes. */
  notes: MeetingNotesDeps | null;
  /** Null is the configured-off state — no key, or no public URL to dial. */
  client: RecallClient | null;
  /** Lifecycle facts only. Never a transcript frame; see meeting-bot.ts. */
  broadcast: (docId: string, payload: { event: string } & Record<string, unknown>) => void;
  now?: () => number;
  /** Injected so a test can assert the URL Recall is actually handed. */
  mintToken?: () => string;
}

export type InviteRefusal =
  /** No API key, or no public wss base for Recall to dial back on. */
  | 'not_configured'
  /** The URL is not a meeting on a platform this integration supports. */
  | 'unsupported_url'
  /** This doc already has a bot, or a microphone meeting is recording it. */
  | 'already_recording'
  /** The vendor refused the create. */
  | 'vendor_error';

export type InviteResult =
  | { ok: true; status: MeetingBotStatus }
  | { ok: false; reason: InviteRefusal; message: string };

interface BotRecord {
  botId: string;
  docId: string;
  meetingUrl: string;
  platform: MeetingPlatform;
  token: string;
  state: MeetingBotState;
  detail?: string;
  updatedAt: number;
  meeting: ActiveMeeting | null;
  notes: MeetingNotesSession | null;
  namer: SpeakerNamer;
  turns: TurnAllocator;
  /** Zoom's consent prompt is asked for exactly once per bot. */
  permissionAsked: boolean;
  /** Guards the end path against a webhook and a socket close racing. */
  ending: boolean;
}

export class RecallMeetingRelay {
  private readonly byDoc = new Map<string, BotRecord>();
  private readonly byToken = new Map<string, BotRecord>();
  private readonly byBotId = new Map<string, BotRecord>();
  /** Same reason as MeetingRelay's: a WeakMap of sockets cannot be drained. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly deps: RecallMeetingDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Whether this server can invite bots at all. */
  configured(): boolean {
    return this.deps.client !== null && this.deps.client.config.publicWsBase !== null;
  }

  /** The bot on this doc, as the UI renders it. */
  status(docId: string): MeetingBotStatus | null {
    const rec = this.byDoc.get(docId);
    return rec ? toStatus(rec) : null;
  }

  async invite(args: { docId: string; meetingUrl: string }): Promise<InviteResult> {
    const client = this.deps.client;
    if (!client) {
      return {
        ok: false,
        reason: 'not_configured',
        message: 'No Recall.ai API key is configured on this server.',
      };
    }
    const wsBase = client.config.publicWsBase;
    if (!wsBase) {
      return {
        ok: false,
        reason: 'not_configured',
        message:
          'Recall dials this server back, so RECALL_PUBLIC_WS_BASE must name a publicly reachable wss:// origin. It is unset.',
      };
    }
    const meetingUrl = args.meetingUrl.trim();
    const platform = meetingPlatformOf(meetingUrl);
    if (!platform) {
      return {
        ok: false,
        reason: 'unsupported_url',
        message: 'That is not a Zoom, Google Meet or Teams meeting link.',
      };
    }
    const existing = this.byDoc.get(args.docId);
    if (existing && !isTerminalBotState(existing.state)) {
      return {
        ok: false,
        reason: 'already_recording',
        message: 'This doc already has a bot in a call.',
      };
    }
    // The microphone path claims the doc in the same store, so this is the
    // same "one meeting per doc" rule and not a second one. Checked BEFORE the
    // vendor call: a bot created here and then refused a meeting record would
    // be a bot in a call that nothing is listening to, still billing.
    if (this.deps.store.active(args.docId)) {
      return {
        ok: false,
        reason: 'already_recording',
        message: 'This doc is already being recorded.',
      };
    }

    const token = (this.deps.mintToken ?? mintToken)();
    let botId: string;
    try {
      const bot = await client.createBot({
        meetingUrl,
        realtimeUrl: `${wsBase}/recall/${token}`,
        permissionDeniedTimeoutSec: PERMISSION_DENIED_TIMEOUT_SEC,
      });
      botId = bot.id;
    } catch (err) {
      return {
        ok: false,
        reason: 'vendor_error',
        message: err instanceof Error ? err.message : 'the vendor refused the bot',
      };
    }

    if (existing) this.forget(existing);
    const rec: BotRecord = {
      botId,
      docId: args.docId,
      meetingUrl,
      platform,
      token,
      state: 'requested',
      updatedAt: this.now(),
      meeting: null,
      notes: null,
      namer: new SpeakerNamer(),
      turns: new TurnAllocator(),
      permissionAsked: false,
      ending: false,
    };
    this.byDoc.set(rec.docId, rec);
    this.byToken.set(token, rec);
    this.byBotId.set(botId, rec);
    this.broadcastBot(rec);
    return { ok: true, status: toStatus(rec) };
  }

  /** Take the bot out of the call. Irreversible, per the vendor. */
  async leave(docId: string): Promise<boolean> {
    const rec = this.byDoc.get(docId);
    if (!rec) return false;
    if (this.deps.client) {
      try {
        await this.deps.client.leaveCall(rec.botId);
      } catch (err) {
        // The state below is still the right one to move to: whatever the
        // vendor did with the request, this server is done with the bot.
        console.error('[recall] leave_call failed:', err);
      }
    }
    await this.applyState(rec, 'left');
    return true;
  }

  // --- the vendor's two inbound channels ---------------------------------

  /** A bot status-change webhook. Unknown bots are ignored, not an error. */
  onStatus(event: BotStatusEvent): void {
    const rec = this.byBotId.get(event.botId);
    if (!rec) return;
    this.track(this.applyState(rec, event.state, event.detail));
  }

  /** Is this the token of a bot we are expecting? */
  acceptsToken(token: string): boolean {
    return this.byToken.has(token);
  }

  /** One text frame from the socket Recall dialled. */
  onSocketText(token: string, text: string): void {
    const rec = this.byToken.get(token);
    if (!rec || rec.ending) return;
    const frame = parseRecallFrame(text);
    if (!frame || frame.kind !== 'transcript') return;

    // The first word is what starts the meeting — see the header.
    const meeting = this.ensureMeeting(rec);
    if (!meeting) return;

    // Name the voice before its words are used, so no tick ever composes a
    // note about "Speaker p7". The rename machinery is being driven here in
    // its forward direction only; nothing has been written yet to rewrite.
    if (rec.namer.isNew(frame.participant)) {
      const label = `p${frame.participant.id}`;
      const name = rec.namer.nameFor(frame.participant);
      meeting.nameSpeaker(label, name);
      rec.notes?.nameSpeaker(label, name);
      this.broadcastBot(rec);
    }

    const turn = rec.turns.allocate(frame);
    if (turn.final) meeting.recordTurn(turn.turn, turn.text, turn.speaker);
    // Every frame, partial included: a partial is speech in progress, which
    // is exactly the evidence that defers the notes composer's pause tick.
    rec.notes?.onTurn(turn);
  }

  /**
   * The socket Recall dialled went away.
   *
   * Deliberately NOT the end of the meeting, which is the opposite of the
   * microphone path's rule. Recall reconnects a dropped realtime endpoint,
   * and the call itself is still going; ending here would stop a meeting
   * mid-sentence over a transient network blip and leave the bot recording
   * into nothing. The status webhook says when the call ended.
   */
  onSocketClose(_token: string): void {
    // Intentionally empty. See above; kept as a named seam so the server's
    // websocket handler has one place to call and this decision has one place
    // to be read.
  }

  /** Every live bot meeting ends — server shutdown. */
  async dispose(): Promise<void> {
    const records = [...this.byDoc.values()];
    // Bots are taken OUT of their calls, not left running. A restart loses
    // the in-memory token map, so a bot that survived one would keep
    // recording into a socket this server can no longer accept — billing on
    // both vendors and delivering nothing. Kicking it out is visible; the
    // alternative is silent.
    const leaves = records
      .filter((rec) => !isTerminalBotState(rec.state) && this.deps.client)
      .map((rec) =>
        this.deps.client?.leaveCall(rec.botId).catch((err: unknown) => {
          console.error('[recall] leave_call on shutdown failed:', err);
        }),
      );
    await Promise.race([
      Promise.allSettled(leaves),
      new Promise((r) => setTimeout(r, DISPOSE_LEAVE_MS)),
    ]);
    for (const rec of records) this.track(this.endMeeting(rec, 'left'));
    const deadline = Date.now() + DISPOSE_LEAVE_MS;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now()))),
      ]);
    }
  }

  // --- internals ---------------------------------------------------------

  private track(work: Promise<void>): void {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  /**
   * The meeting record and notes session for this bot, created on first use.
   *
   * Returns null when the store refuses — a microphone meeting claimed the
   * doc between the invite and the first word. The bot's words are dropped
   * rather than appended to somebody else's transcript.
   */
  private ensureMeeting(rec: BotRecord): ActiveMeeting | null {
    if (rec.meeting) return rec.meeting;
    const meeting = this.deps.store.start({
      docId: rec.docId,
      engine: BOT_ENGINE_NAME,
      sampleRate: BOT_SAMPLE_RATE,
      // Always a conversation: a bot is in a call with other people, which is
      // the whole reason it exists. The mode's OTHER job — deciding whether
      // to pay AssemblyAI's speaker-label surcharge — does not arise here,
      // because this path opens no AssemblyAI session of its own. The
      // platform already knows who is speaking.
      mode: 'conversation',
    });
    if (!meeting) return null;
    rec.meeting = meeting;
    rec.notes = this.deps.notes
      ? beginNotesSession(this.deps.notes, { docId: rec.docId, meetingId: meeting.meetingId })
      : null;
    this.deps.broadcast(rec.docId, {
      event: 'meeting.started',
      docId: rec.docId,
      meetingId: meeting.meetingId,
      startedAt: meeting.startedAt,
      engine: BOT_ENGINE_NAME,
    });
    return meeting;
  }

  private async applyState(rec: BotRecord, state: MeetingBotState, detail?: string): Promise<void> {
    // A terminal state is final. A late `in_call` arriving after `call_ended`
    // — the two channels are independent and the webhook order is the
    // vendor's, not ours — must not resurrect a meeting that has flushed.
    if (isTerminalBotState(rec.state)) return;
    const changed = rec.state !== state || rec.detail !== detail;
    rec.state = state;
    if (detail !== undefined) rec.detail = detail;
    rec.updatedAt = this.now();

    // Zoom's NATIVE consent banner: the bot is in the call, so ask the host.
    // Zoom only — the other platforms have no such prompt, and asking would
    // be a wasted call. Asked once; the answer comes back as a status event.
    if (
      state === 'in_call' &&
      rec.platform === 'zoom' &&
      !rec.permissionAsked &&
      this.deps.client
    ) {
      rec.permissionAsked = true;
      const asked = await this.deps.client.requestRecordingPermission(rec.botId);
      if (asked) {
        rec.state = 'awaiting_permission';
        rec.updatedAt = this.now();
      }
    }

    if (isTerminalBotState(rec.state)) {
      await this.endMeeting(rec, rec.state);
      return;
    }
    if (changed) this.broadcastBot(rec);
  }

  /** Flush the notes, stop the record, tell the doc. Idempotent. */
  private async endMeeting(rec: BotRecord, state: MeetingBotState): Promise<void> {
    if (rec.ending) return;
    rec.ending = true;
    rec.state = state;
    rec.updatedAt = this.now();
    const meeting = rec.meeting;
    const notes = rec.notes;
    rec.meeting = null;
    rec.notes = null;
    try {
      await notes?.end();
    } catch (err) {
      console.error('[recall] notes flush failed:', err);
    }
    if (meeting) {
      const record = meeting.stop();
      this.deps.broadcast(rec.docId, {
        event: 'meeting.stopped',
        docId: rec.docId,
        meetingId: record.meetingId,
        endedAt: record.endedAt ?? this.now(),
        turns: record.turns ?? 0,
      });
    }
    this.broadcastBot(rec);
    this.byToken.delete(rec.token);
  }

  private forget(rec: BotRecord): void {
    this.byToken.delete(rec.token);
    this.byBotId.delete(rec.botId);
    if (this.byDoc.get(rec.docId) === rec) this.byDoc.delete(rec.docId);
  }

  private broadcastBot(rec: BotRecord): void {
    this.deps.broadcast(rec.docId, { event: MEETING_BOT_EVENT, ...toStatus(rec) });
  }
}

function toStatus(rec: BotRecord): MeetingBotStatus {
  return {
    botId: rec.botId,
    docId: rec.docId,
    state: rec.state,
    meetingUrl: rec.meetingUrl,
    platform: rec.platform,
    ...(rec.detail ? { detail: rec.detail } : {}),
    speakers: rec.namer.names(),
    updatedAt: rec.updatedAt,
  };
}

/**
 * The unguessable half of the realtime endpoint URL.
 *
 * This token IS the authentication on that socket: Recall publishes no static
 * IPs to allowlist, and a token in the endpoint URL is one of the two schemes
 * its docs offer (the other is Svix signature headers on the upgrade, which
 * needs a shared secret the operator configures separately). 128 bits from
 * the platform CSPRNG, one per bot, forgotten when the bot's meeting ends —
 * so a leaked URL is useless the moment the call it belonged to is over.
 */
function mintToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
