/**
 * The raw record a meeting leaves beside its doc, for a person rather than
 * for the pipeline: `<docname>-raw-transcript.md`, the audio it was heard
 * from, and a `meeting.json` tying both back to the doc.
 *
 * WHY A SECOND TRANSCRIPT. The JSONL in `meetings.ts` is the pipeline's
 * durable record — append-only, revisable, machine-shaped. What it cannot do
 * is be opened by the person whose note came out wrong. That person needs
 * the words as they were heard, in order, with a clock and a name on each
 * line, in a file that any markdown viewer renders and any grep searches.
 * That is this file, and its whole grammar is two markdown forms: a
 * `## Segment N — <ISO start>` heading per recording, and a
 * `- [HH:MM:SSZ] Speaker: words` bullet per settled turn. No custom syntax,
 * so a viewer later is a rendering choice, not a parser.
 *
 * WHY IT IS WRITTEN AT STOP, FROM THE JSONL. The live record revises turns
 * in place — a punctuated final replaces a rough one, an end-of-session pass
 * relabels a speaker — and a markdown file appended live would carry every
 * draft of every turn. So a segment is composed once, when the meeting
 * ends, from the folded transcript. A server that dies mid-meeting leaves
 * the JSONL but no segment; the next meeting on the same doc writes the
 * missing one first (`flushRawSegments`), so every meeting keeps a segment
 * and they stay in order.
 *
 * WHY THE AUDIO IS RAW PCM. The microphone socket carries 16 kHz PCM16LE
 * frames with no container at all, and this tees exactly those bytes to
 * `segment-<N>-<stream>.pcm`: no transcode, no header, so the file replays
 * into the engine seam byte-for-byte (`scripts/replay-meeting-audio.ts`)
 * and plays with `ffplay -f s16le -ar 16000 -ac 1 <file>`. The sample rate
 * and channel count live in `meeting.json` beside it.
 *
 * NEVER PUSHED. All of this lives under the server data dir — prod's is
 * outside any checkout — and belt-and-braces `*-raw-transcript.md` and
 * `*.pcm` are gitignored and refused outright by `scripts/scrub-check.py`.
 * The repo is public; a meeting's words never enter it.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { speakerDisplayName } from '@feedback/core';
import {
  type MeetingRecord,
  type TranscriptTurn,
  listMeetings,
  meetingDirPath,
  readTranscript,
} from './meetings.ts';

/** What the store is told about the doc a meeting belongs to. */
export interface DocInfo {
  /** The file the doc is bound to at the time, when it is bound to one. */
  path?: string;
  title?: string;
}

export type DocInfoResolver = (docId: string) => DocInfo | undefined;

/** Where the audio came from. A bot's audio never reaches this server. */
export type MeetingSource = 'mic' | 'bot';

export interface MeetingJsonAudio {
  /** `mic` for the microphone; a per-participant id when a source has several. */
  stream: string;
  /** File name inside the meeting folder. */
  file: string;
  codec: 'pcm_s16le';
  sampleRate: number;
  channels: 1;
  bytes: number;
}

export interface MeetingJsonSegment {
  n: number;
  meetingId: string;
  startedAt: number;
  endedAt: number | null;
  engine: string;
  mode: string;
  source: MeetingSource;
  /** Who was on the microphone socket, when the client said — see MeetingRecord. */
  participant?: string;
  audio: MeetingJsonAudio[];
}

/**
 * The tie from the folder back to the doc. Rewritten (atomically) at every
 * meeting start and stop, so it names the path and title the doc had LAST —
 * which survives the doc moving, being renamed, or being committed, because
 * the folder is keyed by the doc id and the id never moves.
 */
export interface MeetingJson {
  docId: string;
  docName: string;
  /** The companion file's name inside this folder. */
  transcript: string;
  path?: string;
  title?: string;
  updatedAt: number;
  segments: MeetingJsonSegment[];
}

function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * The `<docname>` the companion file is named after: the bound file's own
 * name, so the two sit side by side in a listing; else a slug of the title;
 * else the doc id. Sanitized either way — it becomes a path.
 */
export function docNameFor(docId: string, info: DocInfo | undefined): string {
  if (info?.path) {
    const base = basename(info.path);
    const stem = base.slice(0, base.length - extname(base).length) || base;
    return safeSegment(stem);
  }
  if (info?.title) {
    const slug = info.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (slug) return slug;
  }
  return safeSegment(docId);
}

/** Where a doc's raw transcript lives — beside its JSONL, under the data dir. */
export function rawTranscriptPath(dataDir: string, docId: string, docName: string): string {
  return join(meetingDirPath(dataDir, docId), `${docName}-raw-transcript.md`);
}

export function meetingJsonPath(dataDir: string, docId: string): string {
  return join(meetingDirPath(dataDir, docId), 'meeting.json');
}

export function segmentAudioFileName(n: number, stream: string): string {
  return `segment-${n}-${safeSegment(stream)}.pcm`;
}

function utcClock(ts: number): string {
  return `${new Date(ts).toISOString().slice(11, 19)}Z`;
}

/** `- [HH:MM:SSZ] Speaker: words` — the whole grammar of a transcript line. */
export function formatRawBullet(ts: number, speaker: string, text: string): string {
  return `- [${utcClock(ts)}] ${speaker}: ${text.replace(/\s*\n\s*/g, ' ').trim()}`;
}

/**
 * Who a bullet says spoke: the engine's label, shown as the name the person
 * gave it or as "Speaker A"; failing a label, the participant on the
 * socket; failing that, "Speaker 1" — one voice assumed, as a solo capture
 * assumes.
 */
export function speakerLineName(
  label: string | undefined,
  names: Readonly<Record<string, string>>,
  participant: string | undefined,
): string {
  if (label !== undefined) return speakerDisplayName(label, names);
  return participant ?? 'Speaker 1';
}

export interface RawSegmentInput {
  n: number;
  startedAt: number;
  endedAt: number | null;
  engine: string;
  mode: string;
  source: MeetingSource;
  audio: readonly MeetingJsonAudio[];
  turns: readonly TranscriptTurn[];
  names: Readonly<Record<string, string>>;
  participant?: string;
}

/** One `## Segment` block, ready to append. */
export function formatRawSegment(seg: RawSegmentInput): string {
  const facts = [
    `Engine: ${seg.engine}`,
    `Mode: ${seg.mode}`,
    `Source: ${seg.source}`,
    seg.endedAt !== null
      ? `Ended: ${new Date(seg.endedAt).toISOString()}`
      : 'Ended: no recorded end (the server stopped mid-meeting)',
  ];
  if (seg.audio.length > 0) {
    const first = seg.audio[0] as MeetingJsonAudio;
    facts.push(
      `Audio: ${seg.audio.map((a) => a.file).join(', ')} (${first.codec}, ${first.sampleRate} Hz, mono)`,
    );
  }
  const lines = [
    `## Segment ${seg.n} — ${new Date(seg.startedAt).toISOString()}`,
    '',
    facts.join(' · '),
    '',
  ];
  if (seg.turns.length === 0) {
    lines.push('_(no settled turns)_');
  } else {
    for (const t of seg.turns) {
      lines.push(
        formatRawBullet(t.ts, speakerLineName(t.speaker, seg.names, seg.participant), t.text),
      );
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function transcriptPreamble(docId: string, docName: string, info: DocInfo | undefined): string {
  const facts = [`Doc: ${docId}`];
  if (info?.title) facts.push(`Title: ${info.title}`);
  if (info?.path) facts.push(`File: ${info.path}`);
  return [
    `# Raw transcript — ${info?.title ?? docName}`,
    '',
    facts.join(' · '),
    '',
    'Every settled turn as the transcription engine heard it, one segment per',
    'recording. This file and the audio beside it are the meeting record kept',
    'outside the repo; `meeting.json` in this folder ties them to the doc.',
    '',
  ].join('\n');
}

export function readMeetingJson(dataDir: string, docId: string): MeetingJson | null {
  const path = meetingJsonPath(dataDir, docId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MeetingJson>;
    if (typeof parsed.docId !== 'string') return null;
    return {
      docId: parsed.docId,
      docName: typeof parsed.docName === 'string' ? parsed.docName : safeSegment(docId),
      transcript: typeof parsed.transcript === 'string' ? parsed.transcript : '',
      ...(typeof parsed.path === 'string' ? { path: parsed.path } : {}),
      ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      segments: Array.isArray(parsed.segments) ? (parsed.segments as MeetingJsonSegment[]) : [],
    };
  } catch {
    // A torn write is replaced by the next; the segments it named are
    // re-derivable from the transcript file's own headings if it ever matters.
    return null;
  }
}

/** Written whole and renamed into place: a reader never sees half a file. */
export function writeMeetingJson(dataDir: string, docId: string, json: MeetingJson): void {
  const path = meetingJsonPath(dataDir, docId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * The tie, refreshed. Called at meeting START so a folder whose meeting
 * never reaches stop still says which doc it belongs to.
 */
export function ensureMeetingJson(dataDir: string, docId: string, info: DocInfo | undefined): void {
  const docName = docNameFor(docId, info);
  const prior = readMeetingJson(dataDir, docId);
  writeMeetingJson(dataDir, docId, {
    docId,
    docName,
    transcript: `${docName}-raw-transcript.md`,
    ...(info?.path ? { path: info.path } : {}),
    ...(info?.title ? { title: info.title } : {}),
    updatedAt: Date.now(),
    segments: prior?.segments ?? [],
  });
}

/**
 * One audio stream of one segment, appended frame by frame as it arrives.
 *
 * A file descriptor rather than `appendFileSync`: the microphone sends fifty
 * frames a second, and opening the file for each would be the cost that
 * made someone turn this off. A write that fails disables the sink and says
 * so once; the meeting itself is unaffected — the transcript is the record,
 * the audio is what lets it be checked.
 */
export class AudioSink {
  private fd: number | null = null;
  private failed = false;
  bytes = 0;

  constructor(
    readonly path: string,
    readonly stream: string,
    readonly sampleRate: number,
  ) {}

  write(chunk: Uint8Array): void {
    if (this.failed) return;
    try {
      if (this.fd === null) {
        mkdirSync(dirname(this.path), { recursive: true });
        this.fd = openSync(this.path, 'a');
      }
      writeSync(this.fd, chunk);
      this.bytes += chunk.byteLength;
    } catch (err) {
      this.failed = true;
      console.error(
        `[meeting] audio tee to ${this.path} failed; audio for this segment stops here:`,
        err,
      );
    }
  }

  /** The audio entry for `meeting.json`, or null when nothing was written. */
  close(): MeetingJsonAudio | null {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // Already closed, or the disk went away — either way the bytes we
        // counted are what reached the file.
      }
      this.fd = null;
    }
    if (this.bytes === 0) return null;
    return {
      stream: this.stream,
      file: basename(this.path),
      codec: 'pcm_s16le',
      sampleRate: this.sampleRate,
      channels: 1,
      bytes: this.bytes,
    };
  }
}

/** The audio files a segment left on disk — how a backfill finds a crashed meeting's audio. */
function audioOnDisk(dir: string, n: number, sampleRate: number): MeetingJsonAudio[] {
  if (!existsSync(dir)) return [];
  const prefix = `segment-${n}-`;
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.pcm'))
    .sort()
    .map((file) => ({
      stream: file.slice(prefix.length, -'.pcm'.length),
      file,
      codec: 'pcm_s16le' as const,
      sampleRate,
      channels: 1 as const,
      bytes: statSync(join(dir, file)).size,
    }));
}

/**
 * Append every segment the transcript file does not yet hold, in index
 * order, and refresh `meeting.json`. Called at meeting stop with the meeting
 * that just ended; earlier meetings that never reached stop (a crash, a
 * meeting from before this file existed) are written on the way.
 */
export function flushRawSegments(args: {
  dataDir: string;
  docId: string;
  info: DocInfo | undefined;
  /** Meetings still recording in THIS process — not ready to be written. */
  liveMeetingIds: ReadonlySet<string>;
  /** The meeting that just stopped, with the audio its sinks closed on. */
  ended?: { meetingId: string; audio: MeetingJsonAudio[] };
}): void {
  const { dataDir, docId, info } = args;
  const docName = docNameFor(docId, info);
  const dir = meetingDirPath(dataDir, docId);
  const mdPath = rawTranscriptPath(dataDir, docId, docName);
  const json: MeetingJson = readMeetingJson(dataDir, docId) ?? {
    docId,
    docName,
    transcript: `${docName}-raw-transcript.md`,
    updatedAt: 0,
    segments: [],
  };
  const written = new Set(json.segments.map((s) => s.meetingId));
  const records: MeetingRecord[] = listMeetings(dataDir, docId);
  let appended = '';
  records.forEach((record, i) => {
    if (written.has(record.meetingId)) return;
    if (args.liveMeetingIds.has(record.meetingId) && record.meetingId !== args.ended?.meetingId) {
      return;
    }
    const n = record.segment ?? i + 1;
    const audio =
      args.ended?.meetingId === record.meetingId
        ? args.ended.audio
        : audioOnDisk(dir, n, record.sampleRate);
    const source: MeetingSource = record.source ?? 'mic';
    appended += formatRawSegment({
      n,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      engine: record.engine,
      mode: record.mode,
      source,
      audio,
      turns: readTranscript(dataDir, docId, record.meetingId),
      names: record.speakers ?? {},
      ...(record.participant !== undefined ? { participant: record.participant } : {}),
    });
    json.segments.push({
      n,
      meetingId: record.meetingId,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      engine: record.engine,
      mode: record.mode,
      source,
      ...(record.participant !== undefined ? { participant: record.participant } : {}),
      audio,
    });
    written.add(record.meetingId);
  });
  if (appended) {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(mdPath)) appendFileSync(mdPath, transcriptPreamble(docId, docName, info));
    appendFileSync(mdPath, appended);
  }
  json.docName = docName;
  json.transcript = basename(mdPath);
  if (info?.path) json.path = info.path;
  if (info?.title) json.title = info.title;
  json.updatedAt = Date.now();
  writeMeetingJson(dataDir, docId, json);
}
