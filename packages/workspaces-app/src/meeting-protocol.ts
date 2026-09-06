/**
 * The meeting strip's wire layer: the frames the doc's audio socket carries,
 * the fold that turns them into the rolling transcript, and the URL the socket
 * opens. No DOM in any of it. Split out of `meeting-strip.ts` (split-plan B4),
 * which keeps the socket state machine that drives these.
 *
 * NOT `packages/server/src/meeting-protocol.ts`. That file is the other end of
 * this same socket — the server's `MeetingRelay`, which owns the meeting
 * lifecycle. Two files, one name, in two packages: this one reads what that
 * one sends.
 */

import {
  type MeetingServerMessage,
  type MeetingTimingMark,
  meetingSocketPath,
  parseCaptureMode,
} from '@feedback/core';

/**
 * How many turns stay on the strip. Three is what the flowing line holds
 * before the mask has faded the oldest out anyway.
 */
export const TRANSCRIPT_KEEP = 3;
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
/** The doc's audio socket on this host. Same scheme rule as the Yjs socket. */
export function meetingSocketUrl(workspaceId: string, docId: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${meetingSocketPath(workspaceId, docId)}`;
}

/**
 * mm:ss, zero-padded, counting past an hour rather than wrapping.
 *
 * DOM-free like the rest of this file, and here rather than in the strip
 * because two surfaces quote the same clock: the strip's elapsed readout and
 * the speaker menu's headline. `meeting-strip.ts` re-exports it — that is
 * where its callers and its test have always imported it from.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
