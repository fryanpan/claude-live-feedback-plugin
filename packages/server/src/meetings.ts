/**
 * A doc's meetings: which one is live, and where the words are kept.
 *
 * WHY THE TRANSCRIPT IS APPEND-ONLY JSONL. The live transcript revises itself
 * — a turn is rewritten in place until the engine settles it — and a file
 * that tracked those revisions would be rewritten several times a second for
 * the length of a meeting, with a torn write costing the whole recording. So
 * only SETTLED turns are written, one line each, and nothing already on disk
 * is ever touched again. A crash costs the sentence in progress, not the
 * meeting; a torn tail line is skipped on read the way `events.jsonl`'s is.
 *
 * WHY THERE IS AN INDEX AND IT IS ALSO APPEND-ONLY. A notes agent arriving
 * afterwards needs to enumerate a doc's meetings without opening every
 * transcript, and a meeting learns its end time an hour after it learns its
 * start. Rewriting the header at stop would be the one mutable file in a
 * durable record; instead the stop appends a second line for the same
 * `meetingId` and a read folds them. Same reason, same shape, no rewrite.
 *
 * Nothing here deletes. Soft delete is project-wide, and a transcript is the
 * least reconstructible thing this server holds — the audio is gone.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type CaptureMode, parseCaptureMode } from '@feedback/core';

/** One settled turn, as stored. */
export interface TranscriptTurn {
  turn: number;
  text: string;
  /** When the turn settled, not when it was spoken. */
  ts: number;
  /** The engine's label for the voice; names live on the meeting record. */
  speaker?: string;
}

/** A meeting as the index describes it, after folding start and stop. */
export interface MeetingRecord {
  meetingId: string;
  docId: string;
  startedAt: number;
  /** Null while the meeting is live or if the server died holding it. */
  endedAt: number | null;
  engine: string;
  sampleRate: number;
  /**
   * Whether this meeting was opened as a conversation (diarizing) or solo.
   * It is on the record because it is what the meeting COST — the surcharge
   * is per session-hour — and because a transcript with no speaker on any
   * turn otherwise cannot say whether nobody was labelled or nobody spoke.
   * A record written before modes existed reads as `solo`, which is what
   * those sessions were not; see the note in `listMeetings`.
   */
  mode: CaptureMode;
  /** Settled turns at stop. Absent for a meeting that never stopped. */
  turns?: number;
  /** Engine label → the name a person gave it, for THIS meeting only. */
  speakers?: Record<string, string>;
}

/**
 * The same sanitizer the clobber backups use (rooms.ts): a docId is
 * caller-supplied and reaches a path here, so everything outside the
 * filename-safe set becomes an underscore before it can mean `..`.
 */
function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** Where a doc's meetings live. Exported so tests assert the real path. */
export function meetingDirPath(dataDir: string, docId: string): string {
  return join(dataDir, 'meetings', safeSegment(docId));
}

/** Where one meeting's settled turns live. */
export function meetingTranscriptPath(dataDir: string, docId: string, meetingId: string): string {
  return join(meetingDirPath(dataDir, docId), `${safeSegment(meetingId)}.jsonl`);
}

/** Where the doc's enumerable list of meetings lives. */
export function meetingIndexPath(dataDir: string, docId: string): string {
  return join(meetingDirPath(dataDir, docId), 'meetings.jsonl');
}

/**
 * A meeting id is the doc plus the moment it started, so the file it names is
 * self-describing on disk and a human reading the data dir can see what they
 * are looking at without opening it.
 */
export function meetingIdFor(docId: string, startedAt: number): string {
  return `m-${safeSegment(docId)}-${startedAt}`;
}

function appendLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        // A tail line torn by a crash mid-append must not take the rest of
        // the transcript down with it.
        return [];
      }
    });
}

/** Every meeting a doc has held, oldest first. */
export function listMeetings(dataDir: string, docId: string): MeetingRecord[] {
  const byId = new Map<string, MeetingRecord>();
  for (const row of readJsonl(meetingIndexPath(dataDir, docId))) {
    const meetingId = typeof row.meetingId === 'string' ? row.meetingId : null;
    if (!meetingId) continue;
    const existing = byId.get(meetingId);
    if (!existing) {
      if (typeof row.startedAt !== 'number') continue;
      byId.set(meetingId, {
        meetingId,
        docId,
        startedAt: row.startedAt,
        endedAt: null,
        engine: typeof row.engine === 'string' ? row.engine : 'unknown',
        sampleRate: typeof row.sampleRate === 'number' ? row.sampleRate : 0,
        // Absent is `solo` because that is what the field means now, not
        // what an old line meant: meetings recorded before this field
        // existed all diarized. They are readable as such by their turns
        // carrying labels, and nothing downstream reads this to decide
        // whether to trust one.
        mode: parseCaptureMode(row.mode),
      });
      continue;
    }
    if (typeof row.endedAt === 'number') existing.endedAt = row.endedAt;
    if (typeof row.turns === 'number') existing.turns = row.turns;
    // One line per naming, merged in order: a rename is a later line for
    // the same label, and the last one is what the person meant.
    if (typeof row.speakers === 'object' && row.speakers !== null) {
      existing.speakers = { ...existing.speakers };
      for (const [label, name] of Object.entries(row.speakers as Record<string, unknown>)) {
        if (typeof name === 'string') existing.speakers[label] = name;
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** One meeting's settled turns, in the order they settled. */
export function readTranscript(
  dataDir: string,
  docId: string,
  meetingId: string,
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const byTurn = new Map<number, TranscriptTurn>();
  for (const row of readJsonl(meetingTranscriptPath(dataDir, docId, meetingId))) {
    if (typeof row.turn !== 'number') continue;
    const speaker = typeof row.speaker === 'string' ? row.speaker : undefined;
    if (typeof row.text === 'string') {
      const turn: TranscriptTurn = {
        turn: row.turn,
        text: row.text,
        ts: typeof row.ts === 'number' ? row.ts : 0,
        ...(speaker !== undefined ? { speaker } : {}),
      };
      turns.push(turn);
      byTurn.set(row.turn, turn);
      continue;
    }
    // A line with a turn and a label but no words is a relabel of a turn
    // already written — the append-only form of "we now think it was B",
    // or of "we no longer think it was anyone" when the label is null.
    // Anything else in the field is malformed and changes nothing.
    const known = byTurn.get(row.turn);
    if (!known) continue;
    if (speaker !== undefined) {
      known.speaker = speaker;
    } else if (row.speaker === null) {
      // Replaced, not patched: an absent `speaker` is what "nobody" reads as
      // for a turn that never had one, and the two must not differ.
      const cleared: TranscriptTurn = { turn: known.turn, text: known.text, ts: known.ts };
      const at = turns.indexOf(known);
      if (at >= 0) turns[at] = cleared;
      byTurn.set(row.turn, cleared);
    }
  }
  return turns;
}

/** The handle the relay holds for as long as a meeting is live. */
export interface ActiveMeeting {
  readonly meetingId: string;
  readonly docId: string;
  readonly startedAt: number;
  /**
   * Append a settled turn. Repeats of a turn already written are ignored —
   * except a repeat with a DIFFERENT speaker label, which appends a relabel
   * line (the engine's end-of-session pass changing its mind).
   */
  recordTurn(turn: number, text: string, speaker?: string): void;
  /** "Label `speaker` is `name`" — appended to the index, last word wins. */
  nameSpeaker(speaker: string, name: string): void;
  /** End the meeting. Idempotent; returns the folded record either way. */
  stop(): MeetingRecord;
}

/**
 * One live meeting per doc, and the files behind it.
 *
 * The store owns the "one at a time" rule rather than the socket layer,
 * because the fact a second socket needs to know — is this doc already
 * recording — is the same fact the transcript files are named after. Two
 * owners of it would be two answers.
 */
export class MeetingStore {
  private readonly live = new Map<string, ActiveMeeting>();

  constructor(private readonly dataDir: string) {}

  /** The meeting currently recording this doc, if any. */
  active(docId: string): ActiveMeeting | undefined {
    return this.live.get(docId);
  }

  /**
   * Begin recording. Returns null when the doc is already recording — the
   * `already_recording` case the wire contract names, expressed as the
   * absence of a meeting rather than a thrown error, because the caller's
   * answer to it is a message to the client and not a failure.
   */
  start(args: {
    docId: string;
    engine: string;
    sampleRate: number;
    mode: CaptureMode;
    now?: number;
  }): ActiveMeeting | null {
    const { docId, engine, sampleRate, mode } = args;
    if (this.live.has(docId)) return null;
    const startedAt = args.now ?? Date.now();
    const dataDir = this.dataDir;
    // Two meetings on one doc cannot overlap, but they CAN be a millisecond
    // apart — stop, then start again — and the id is derived from that
    // millisecond. Without this the second meeting APPENDS to the first
    // one's transcript, which reads as one long meeting and is not something
    // an append-only file can be talked out of afterwards.
    let meetingId = meetingIdFor(docId, startedAt);
    let transcriptPath = meetingTranscriptPath(dataDir, docId, meetingId);
    for (let n = 2; existsSync(transcriptPath); n++) {
      meetingId = `${meetingIdFor(docId, startedAt)}-${n}`;
      transcriptPath = meetingTranscriptPath(dataDir, docId, meetingId);
    }
    appendLine(meetingIndexPath(dataDir, docId), {
      meetingId,
      docId,
      startedAt,
      engine,
      sampleRate,
      mode,
    });
    // Create the file at start so a meeting nobody spoke in still reads back
    // as an empty transcript rather than a missing one.
    mkdirSync(dirname(transcriptPath), { recursive: true });
    appendFileSync(transcriptPath, '');
    /** Turn → the label it was written with (undefined for none). */
    const written = new Map<number, string | undefined>();
    const speakers: Record<string, string> = {};
    let stopped = false;
    const live = this.live;

    const meeting: ActiveMeeting = {
      meetingId,
      docId,
      startedAt,
      recordTurn(turn: number, text: string, speaker?: string): void {
        if (stopped) return;
        // An engine that settles the same turn twice would otherwise double
        // it in the record, and appending is not something we can take back.
        if (written.has(turn)) {
          if (written.get(turn) === speaker) return;
          written.set(turn, speaker);
          // Explicit `null`, never an absent field: a relabel line says what
          // the label IS now, and the revision pass can take one away as
          // well as change it. Absent would read as "this line says nothing
          // about the speaker" and leave a label the strip already dropped.
          appendLine(transcriptPath, { turn, speaker: speaker ?? null, ts: Date.now() });
          return;
        }
        written.set(turn, speaker);
        appendLine(transcriptPath, {
          turn,
          text,
          ...(speaker !== undefined ? { speaker } : {}),
          ts: Date.now(),
        });
      },
      nameSpeaker(speaker: string, name: string): void {
        if (stopped) return;
        speakers[speaker] = name;
        appendLine(meetingIndexPath(dataDir, docId), { meetingId, speakers: { [speaker]: name } });
      },
      stop(): MeetingRecord {
        const record: MeetingRecord = {
          meetingId,
          docId,
          startedAt,
          endedAt: Date.now(),
          engine,
          sampleRate,
          mode,
          turns: written.size,
          ...(Object.keys(speakers).length > 0 ? { speakers: { ...speakers } } : {}),
        };
        if (stopped) return record;
        stopped = true;
        live.delete(docId);
        appendLine(meetingIndexPath(dataDir, docId), {
          meetingId,
          endedAt: record.endedAt,
          turns: written.size,
        });
        return record;
      },
    };
    this.live.set(docId, meeting);
    return meeting;
  }

  /** Every meeting this doc has held. */
  list(docId: string): MeetingRecord[] {
    return listMeetings(this.dataDir, docId);
  }

  /** One meeting's settled turns. */
  transcript(docId: string, meetingId: string): TranscriptTurn[] {
    return readTranscript(this.dataDir, docId, meetingId);
  }

  /** End every live meeting — server shutdown, so no doc is left recording. */
  stopAll(): void {
    for (const meeting of [...this.live.values()]) meeting.stop();
  }
}
