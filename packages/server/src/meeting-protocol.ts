/**
 * The `/audio/<docId>` socket, kept out of `server.ts` the way `yjs-protocol`
 * keeps the editing socket out of it.
 *
 * The wire contract itself lives in `@feedback/core/meeting.ts`, shared with
 * the browser that opens the microphone. What lives here is the half a server
 * has to get right: the socket IS the meeting's lifecycle, so every way this
 * connection can end has to end the meeting exactly once — a clean `stop`, a
 * tab closing, a network drop mid-sentence.
 *
 * NOTHING WORD-RATE GOES OVER SSE. Transcript frames ride back down this same
 * socket; only `meeting.started` and `meeting.stopped` are broadcast to the
 * doc's channel, where other viewers learn that recording is live. The SSE
 * hub keeps 200 events per channel for reconnect replay, and a conversation
 * emits that many words in about a minute — broadcasting partials would
 * evict every real doc event from the buffer for the length of a meeting.
 */

import {
  type CaptureMode,
  type MeetingServerMessage,
  detectsSpeakers,
  parseMeetingClientMessage,
} from '@feedback/core';
import {
  type MeetingNotesDeps,
  type MeetingNotesSession,
  beginNotesSession,
} from './meeting-notes.ts';
import type { ActiveMeeting, MeetingStore } from './meetings.ts';
import type { TranscriptionEngine, TranscriptionSession } from './transcribe.ts';

/** The slice of a Bun `ServerWebSocket` this module needs. */
export interface MeetingClient {
  readonly data: { docId: string };
  send(payload: string): void;
}

export interface MeetingRelayDeps {
  store: MeetingStore;
  /** No engine is the configured-off state, not an error. See `transcribe.ts`. */
  engine: TranscriptionEngine | null;
  /**
   * Pause-driven notes. Same no-default seam as the engine — null means no
   * meeting composes notes, and nothing constructed here can reach an LLM.
   * See `meeting-notes.ts`.
   */
  notes: MeetingNotesDeps | null;
  /** Lifecycle facts only — never a transcript frame. */
  broadcast: (docId: string, payload: { event: string } & Record<string, unknown>) => void;
}

/**
 * `opening` and `ending` are real states rather than booleans because both
 * ends of a meeting are round trips: the engine handshake, and the flush that
 * `close()` waits for. A second stop arriving inside either one must not run
 * the teardown twice.
 */
type ConnState = 'idle' | 'opening' | 'live' | 'ending';

/** How long a shutdown waits for meetings to flush before going anyway. */
const DISPOSE_DRAIN_MS = 5_000;

interface Conn {
  state: ConnState;
  meeting: ActiveMeeting | null;
  session: TranscriptionSession | null;
  /** This meeting's notes pipeline, when the server has a composer. */
  notes: MeetingNotesSession | null;
  /** Audio that arrived before the engine session finished opening. */
  pending: Uint8Array[];
  /**
   * A stop that arrived while the handshake was still out, carrying whether
   * the socket is still there to be answered. Held as its own field rather
   * than as a fifth state so the decision survives the await: the state is
   * what the connection IS, this is what it has been asked to become.
   */
  pendingStop: { reply: boolean } | null;
}

export class MeetingRelay {
  private readonly conns = new WeakMap<MeetingClient, Conn>();
  /**
   * Every started-and-unfinished piece of this relay's own async work.
   *
   * The socket callbacks cannot await — they are Bun websocket handlers —
   * but what they start is durable: `stop()` flushes the engine's turn in
   * progress and then the notes into the doc. On shutdown every socket closes
   * at once and those writes have to land before the rooms are flushed, so
   * `dispose()` waits here. A `WeakMap` of connections cannot be enumerated;
   * this can.
   *
   * `start` is tracked as well as `stop`, and not for symmetry: a socket that
   * closes mid-handshake gets a DEFERRED teardown — `stop()` only records
   * `pendingStop` and returns, and the real flush runs inside `start`'s own
   * continuation when the engine finally answers. Tracking only the `stop`
   * would see that connection as already finished and flush the rooms out
   * from under it.
   */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly deps: MeetingRelayDeps) {}

  /**
   * The notes pipeline this relay was built with, so the BOT relay can share
   * it rather than build a second one from the same options.
   *
   * Sharing is the requirement, not a convenience: `meeting-notes-merge`'s
   * ownership ledger is held per doc inside these deps' sink, and it is what
   * decides whether an item in the notes section is the agent's to replace or
   * a person's to leave alone. Two ledgers over one doc would each see the
   * other's writes as a person's and stop replacing their own notes.
   */
  get notesDeps(): MeetingNotesDeps | null {
    return this.deps.notes;
  }

  onOpen(ws: MeetingClient): void {
    this.conns.set(ws, {
      state: 'idle',
      meeting: null,
      session: null,
      notes: null,
      pending: [],
      pendingStop: null,
    });
  }

  /** A JSON text frame from the client. */
  onText(ws: MeetingClient, text: string): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    const msg = parseMeetingClientMessage(text);
    if (!msg) {
      // Distinct from `unavailable`: the meeting is not refused, this frame
      // was unreadable. The socket stays open either way.
      this.send(ws, { type: 'error', message: 'unreadable frame' });
      return;
    }
    if (msg.type === 'start') {
      this.track(this.start(ws, conn, msg.sampleRate, msg.mode));
      return;
    }
    if (msg.type === 'name_speaker') {
      // Both the record and the notes pipeline learn the name; the strip
      // that sent it already knows. Nothing to answer.
      conn.meeting?.nameSpeaker(msg.speaker, msg.name);
      conn.notes?.nameSpeaker(msg.speaker, msg.name);
      return;
    }
    this.track(this.stop(ws, conn, true));
  }

  /** A binary audio frame. */
  onAudio(ws: MeetingClient, chunk: Uint8Array): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    if (conn.state === 'opening') {
      // The client is allowed to talk before the handshake finishes, and the
      // words spoken in that window are as real as any other. Bounded so a
      // client streaming into an engine that never answers cannot grow this
      // without limit — roughly a few seconds of 16 kHz audio.
      if (conn.pending.length < 256) conn.pending.push(chunk);
      return;
    }
    if (conn.state !== 'live') return;
    conn.session?.send(chunk);
  }

  /** The socket went away. Whatever it was holding ends here. */
  onClose(ws: MeetingClient): void {
    const conn = this.conns.get(ws);
    if (!conn) return;
    this.conns.delete(ws);
    this.track(this.stop(ws, conn, false));
  }

  private track(work: Promise<void>): void {
    this.inFlight.add(work);
    void work.finally(() => this.inFlight.delete(work));
  }

  /**
   * Every live meeting ends — server shutdown.
   *
   * Awaits the teardowns already running first: a shutdown force-closes the
   * audio sockets, and each one's `onClose` is mid-flush when this is called.
   * `stopAll()` after them is the belt — it ends a meeting whose connection
   * never produced a close at all, so a restart never reads a doc as
   * recording by a socket that is gone.
   */
  async dispose(): Promise<void> {
    // Looped, not a single `allSettled`: finishing a handshake ENQUEUES the
    // deferred teardown, so the set is refilled by the very thing being
    // waited on.
    //
    // allSettled, and bounded: one meeting whose engine refuses to close must
    // keep neither the others' notes nor the process itself out of the flush
    // that follows. A shutdown that cannot finish is worse than a lost
    // sentence — SIGTERM comes through here.
    const deadline = Date.now() + DISPOSE_DRAIN_MS;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now()))),
      ]);
    }
    this.deps.store.stopAll();
  }

  private send(ws: MeetingClient, msg: MeetingServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // A socket that went away between the event and this write is the
      // normal end of a meeting, not a failure worth logging.
    }
  }

  private async start(
    ws: MeetingClient,
    conn: Conn,
    sampleRate: number,
    mode: CaptureMode,
  ): Promise<void> {
    if (conn.state !== 'idle') return;
    const docId = ws.data.docId;
    const engine = this.deps.engine;
    if (!engine) {
      this.send(ws, {
        type: 'unavailable',
        reason: 'not_configured',
        message: 'No transcription engine is configured on this server.',
      });
      return;
    }
    // Claim the doc BEFORE the handshake: two sockets starting at once would
    // otherwise both pass the check and both open a billed session.
    const meeting = this.deps.store.start({ docId, engine: engine.name, sampleRate, mode });
    if (!meeting) {
      this.send(ws, {
        type: 'unavailable',
        reason: 'already_recording',
        message: 'This doc is already being recorded by another connection.',
      });
      return;
    }
    conn.state = 'opening';
    conn.meeting = meeting;
    // The notes pipeline exists for exactly the meeting's lifetime. Created
    // before the handshake so the closure below can feed it, but it holds no
    // resource until a turn arrives — abandoning it on a failed handshake
    // leaks nothing.
    const notesDeps = this.deps.notes;
    // Held as a local, not read back off `conn`: `stop()` detaches the conn's
    // fields BEFORE awaiting the engine close, and the close is what settles
    // the turn in progress — the meeting's last sentence must still have a
    // pipeline to land in when that settle arrives.
    const notes = notesDeps
      ? beginNotesSession(notesDeps, { docId, meetingId: meeting.meetingId })
      : null;
    conn.notes = notes;

    let session: TranscriptionSession;
    try {
      session = await engine.open({
        sampleRate,
        // The mode is the only thing that turns diarization on, and it turns
        // it on for the ENGINE SESSION — there is no later switch.
        detectSpeakers: detectsSpeakers(mode),
        onTurn: (turn) => {
          this.send(ws, {
            type: 'transcript',
            turn: turn.turn,
            text: turn.text,
            final: turn.final,
            ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}),
          });
          // Only settled turns reach the file. A partial is a view of a turn
          // still being revised, and the record keeps what the turn became.
          if (turn.final) meeting.recordTurn(turn.turn, turn.text, turn.speaker);
          // The notes pipeline sees EVERY frame: a partial is speech in
          // progress, which is exactly the evidence that defers a pause tick.
          notes?.onTurn(turn);
        },
        onError: (message) => {
          this.send(ws, { type: 'error', message });
        },
      });
    } catch (err) {
      // The doc must not be left marked as recording by a session that never
      // opened, or the next attempt answers `already_recording` forever.
      meeting.stop();
      conn.state = 'idle';
      conn.meeting = null;
      // Nothing has fed it, so there is nothing to flush — just let it go.
      conn.notes = null;
      // The socket stays open after `unavailable`, so a client may retry
      // `start` on this same connection — and audio buffered during THIS
      // failed handshake must not be replayed into that next meeting's
      // append-only transcript.
      conn.pending = [];
      conn.pendingStop = null;
      this.send(ws, {
        type: 'unavailable',
        reason: 'engine_unavailable',
        message: err instanceof Error ? err.message : 'the transcription engine refused',
      });
      return;
    }

    conn.session = session;
    conn.state = 'live';
    // Whatever was said during the handshake goes in FIRST, and before any
    // pending stop: a meeting ended a second after it started still owes the
    // speaker the sentence they had already begun.
    for (const chunk of conn.pending) session.send(chunk);
    conn.pending = [];
    // Broadcast before the stop check so `meeting.started` and
    // `meeting.stopped` always reach the doc's other viewers as a pair — a
    // lone `stopped` reads as a meeting they missed the beginning of.
    this.deps.broadcast(docId, {
      event: 'meeting.started',
      docId,
      meetingId: meeting.meetingId,
      startedAt: meeting.startedAt,
      engine: engine.name,
    });
    // A stop (or a closed tab) that arrived during the handshake: honour it
    // now, and skip `ready` — the client is not waiting to be told it may
    // speak, it is waiting to be told the meeting ended.
    const asked = conn.pendingStop;
    if (asked) {
      conn.pendingStop = null;
      await this.stop(ws, conn, asked.reply);
      return;
    }
    this.send(ws, {
      type: 'ready',
      meetingId: meeting.meetingId,
      startedAt: meeting.startedAt,
      engine: engine.name,
      // What was actually opened, so the strip reports the session being
      // billed rather than the one it asked for.
      mode,
    });
  }

  /** `reply` is false when the socket is already gone. */
  private async stop(ws: MeetingClient, conn: Conn, reply: boolean): Promise<void> {
    if (conn.state === 'opening') {
      // The handshake is still out; `start` finishes the job when it lands.
      conn.pendingStop = { reply };
      return;
    }
    if (conn.state !== 'live') return;
    conn.state = 'ending';
    const meeting = conn.meeting;
    const session = conn.session;
    const notes = conn.notes;
    conn.session = null;
    conn.meeting = null;
    conn.notes = null;
    conn.pending = [];
    // Closing the session is what flushes the turn in progress, so the last
    // sentence of a meeting reaches `onTurn` — and therefore the file —
    // before the record is stopped.
    try {
      await session?.close();
    } catch (err) {
      console.error('[meeting] engine close failed:', err);
    }
    // AFTER the close: the flush above settles the turn in progress, and the
    // meeting's last sentence belongs in its notes as much as in its file.
    try {
      await notes?.end();
    } catch (err) {
      console.error('[meeting] notes flush failed:', err);
    }
    conn.state = 'idle';
    if (!meeting) return;
    const record = meeting.stop();
    if (reply) {
      this.send(ws, {
        type: 'stopped',
        meetingId: record.meetingId,
        endedAt: record.endedAt ?? Date.now(),
      });
    }
    this.deps.broadcast(meeting.docId, {
      event: 'meeting.stopped',
      docId: meeting.docId,
      meetingId: record.meetingId,
      endedAt: record.endedAt ?? Date.now(),
      turns: record.turns ?? 0,
    });
  }
}
