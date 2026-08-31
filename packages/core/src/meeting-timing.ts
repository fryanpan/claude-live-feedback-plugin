/**
 * Stage timing for the live meeting pipeline: how long a spoken word takes to
 * become a word on the screen, and which hop spent it.
 *
 * OFF UNLESS ASKED. Nothing here runs on a normal meeting. The strip turns it
 * on with `?timing=1`, which puts `timing: true` on the `start` frame; a
 * server that was not asked attaches no timing block and allocates no ring.
 * That matters because the measurement is meant to run on PROD against a real
 * conversation, not against a synthetic harness — a flag that costs nothing
 * when it is off is a flag that can live in the shipped client.
 *
 * TIMINGS ONLY, NEVER CONTENT. Every field below is a number. No transcript
 * text, no doc id, no title, no path crosses this module, and the CSV it
 * writes has no column that could carry one. The population being sampled is
 * "the last word of a transcript frame", identified by its AUDIO OFFSET —
 * never by what the word was.
 *
 * WHY THE AUDIO OFFSET IS THE CORRELATION KEY. Audio goes up as raw PCM with
 * no sequence number in it, so there is nothing in a frame to echo back. But
 * the engine reports every word with `start`/`end` in milliseconds of the
 * audio stream, and the server knows exactly how many bytes it had forwarded
 * when it forwarded each chunk — so a word's audio offset names the chunk
 * that carried it, arithmetically, with nothing added to the wire. Correlating
 * on the text instead would break on the very thing this pipeline exists to
 * do: revise a word after it is already on screen.
 *
 * THE ONE ASSUMPTION, stated so it can be checked. The engine counts audio
 * milliseconds from the start of ITS stream; we count from the first byte we
 * forwarded. Those origins coincide because the relay forwards its handshake
 * buffer before anything else and never drops a chunk. The CSV keeps the raw
 * marks, so a systematic offset between the two would show up as a constant
 * added to the vendor leg rather than hiding.
 *
 * CLOCK SKEW, AND WHAT SURVIVES IT. The browser and the server keep separate
 * clocks, so the two network legs are estimated through an NTP-style exchange
 * (`estimateClockOffset`). An error in that estimate moves time BETWEEN
 * uplink and downlink and cancels in their sum — so `total`, `network`, every
 * server-internal leg and the vendor leg are exact regardless, and only the
 * up/down SPLIT depends on the estimate. Read the split as indicative and the
 * rest as measured.
 */

/** Bytes per sample of `pcm_s16le`, mono. */
const BYTES_PER_SAMPLE = 2;

/** How many audio chunks the server remembers. ~2 minutes at 100ms framing. */
export const TIMING_CHUNK_HISTORY = 1200;

/**
 * What the server knows about one audio chunk, in the server's own clock.
 *
 * `audioStartMs`/`audioEndMs` are this chunk's span of the audio stream,
 * derived from the running byte count — which is what lets a word's offset
 * find the chunk that carried it.
 */
export interface AudioChunkMark {
  /** Ordinal of the chunk on this connection, from 0. */
  seq: number;
  audioStartMs: number;
  audioEndMs: number;
  /** Server clock when the chunk arrived on the browser socket. */
  recvMs: number;
  /**
   * Server clock when the chunk was handed to the engine — the instant we
   * let go of it, not the instant its `send` returned. Time spent inside the
   * engine's `send` belongs to the engine's leg, not to ours. Equal to
   * `recvMs` within a tick on the live path; later by the whole handshake for
   * a chunk that was buffered through it.
   */
  fwdMs: number;
}

/**
 * The block the server attaches to a `transcript` frame when timing is on.
 * Every value is a server-clock millisecond or an audio-offset millisecond.
 */
export interface MeetingTimingMark {
  /** The chunk that carried `audioEndMs`. */
  seq: number;
  /** Audio offset of the last word in this transcript frame. */
  audioEndMs: number;
  /** That chunk's own span, so the client can price the framing wait. */
  chunkAudioEndMs: number;
  /** Server clock: chunk received from the browser. */
  recvMs: number;
  /** Server clock: chunk forwarded to the engine. */
  fwdMs: number;
  /** Server clock: this engine frame arrived. */
  engineMs: number;
  /** Server clock: immediately before writing the frame to the browser. */
  sendMs: number;
}

/** Client → server, and its answer. Four timestamps make one offset estimate. */
export interface TimingPing {
  id: number;
  /** Client clock at send. */
  clientMs: number;
}

export interface TimingPong {
  id: number;
  clientMs: number;
  /** Server clock on receipt. */
  serverRecvMs: number;
  /** Server clock at reply. */
  serverSendMs: number;
}

/** One offset estimate and the round trip it came from. */
export interface ClockOffset {
  /** `serverClock - clientClock`, in ms. Add to a client time, subtract from
   *  a server time. */
  offsetMs: number;
  /** The exchange's round trip, minus the server's own turnaround. */
  rttMs: number;
}

/**
 * The NTP estimator, on one exchange.
 *
 * The server's own turnaround is subtracted before halving, so a slow reply
 * inflates neither leg. `rttMs` is kept because it is how a caller picks
 * between estimates: the lowest round trip is the one least distorted by a
 * queue on either side, which is a better rule than averaging estimates that
 * are each wrong by a different amount.
 */
export function offsetFromPong(pong: TimingPong, clientRecvMs: number): ClockOffset {
  const turnaround = pong.serverSendMs - pong.serverRecvMs;
  const rttMs = clientRecvMs - pong.clientMs - turnaround;
  const offsetMs = (pong.serverRecvMs - pong.clientMs + (pong.serverSendMs - clientRecvMs)) / 2;
  return { offsetMs, rttMs };
}

/** The best of a set of estimates: lowest round trip wins. */
export function bestOffset(estimates: readonly ClockOffset[]): ClockOffset | null {
  let best: ClockOffset | null = null;
  for (const e of estimates) {
    if (!Number.isFinite(e.offsetMs) || !Number.isFinite(e.rttMs)) continue;
    if (!best || e.rttMs < best.rttMs) best = e;
  }
  return best;
}

/**
 * The server's running record of what it forwarded and when.
 *
 * A bounded ring rather than a growing list: a meeting runs for an hour and
 * the only chunks a Turn can refer to are the recent ones. Older entries fall
 * off and a Turn that reaches past them yields no sample, which is the honest
 * answer — better than a made-up one.
 */
export class AudioChunkLedger {
  private readonly marks: AudioChunkMark[] = [];
  private nextSeq = 0;
  private bytes = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly history = TIMING_CHUNK_HISTORY,
  ) {}

  /**
   * Record a chunk. CALL THIS BEFORE FORWARDING IT, always.
   *
   * An engine is free to answer inside the very `send` that fed it — the
   * in-memory one the test suite drives does exactly that — and a turn
   * arriving then would look up an audio offset the ledger had not accounted
   * for yet, quietly resolving to the PREVIOUS chunk and pricing the leg
   * against a frame sent 100ms too early. Recording first costs nothing and
   * removes the ordering question entirely.
   */
  record(byteLength: number, recvMs: number, fwdMs: number): AudioChunkMark {
    const perMs = (this.sampleRate * BYTES_PER_SAMPLE) / 1000;
    const audioStartMs = this.bytes / perMs;
    this.bytes += byteLength;
    const mark: AudioChunkMark = {
      seq: this.nextSeq++,
      audioStartMs,
      audioEndMs: this.bytes / perMs,
      recvMs,
      fwdMs,
    };
    this.marks.push(mark);
    if (this.marks.length > this.history) this.marks.splice(0, this.marks.length - this.history);
    return mark;
  }

  /**
   * The chunk that carried audio offset `ms`, or null.
   *
   * An offset past the newest chunk resolves to that chunk rather than to
   * nothing: the engine's stream clock can run a hair ahead of the bytes we
   * have accounted for, and refusing those samples would silently drop the
   * newest — which is every partial, the population we most want.
   *
   * The upper edge belongs to the chunk BELOW it. A word ending at exactly
   * 100ms was carried to its last sample by the frame spanning 0–100, not by
   * the one that starts there — and frames here are 100ms by construction, so
   * a word ending on a boundary is an ordinary event, not a curiosity.
   * Reading it the other way moves a whole frame out of the vendor's leg and
   * into capture.
   */
  chunkAt(ms: number): AudioChunkMark | null {
    const marks = this.marks;
    if (marks.length === 0) return null;
    const last = marks[marks.length - 1] as AudioChunkMark;
    if (ms >= last.audioEndMs) return last;
    const first = marks[0] as AudioChunkMark;
    if (ms < first.audioStartMs) return null;
    let lo = 0;
    let hi = marks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = marks[mid] as AudioChunkMark;
      if (ms > m.audioEndMs) lo = mid + 1;
      else hi = mid;
    }
    return marks[lo] ?? null;
  }
}

/** The client's note of one outgoing audio frame. */
export interface FrameEmit {
  seq: number;
  /** Client clock when the frame was written to the socket. */
  emitMs: number;
}

/**
 * One end-to-end observation: a word's audio instant, and where the time
 * between it and the pixel went. Every field is milliseconds.
 */
export interface LatencySample {
  seq: number;
  turn: number;
  final: boolean;
  audioEndMs: number;
  /** Client clock, reconstructed: when that word was actually spoken. */
  spokenMs: number;
  /** Waiting for the 100ms frame carrying the word to close. */
  capture: number;
  /** Browser → server, using the clock offset. */
  uplink: number;
  /** Held on the server before the engine had a session (usually 0). */
  queue: number;
  /** Forwarded to the engine → the engine's frame carrying this word. */
  vendor: number;
  /** Engine frame in → transcript frame written to the browser socket. */
  serverOut: number;
  /** Server → browser, using the clock offset. */
  downlink: number;
  /** Browser receive → the DOM updated. */
  render: number;
  /** DOM updated → the frame carrying it was committed. */
  paint: number;
  /** Spoken to painted. Equals the sum of the eight legs above. */
  total: number;
  /** The offset estimate in force, and the round trip that produced it. */
  offsetMs: number;
  offsetRttMs: number;
}

/** Everything the client holds about one transcript frame before it paints. */
export interface PendingSample {
  seq: number;
  turn: number;
  final: boolean;
  audioEndMs: number;
  chunkAudioEndMs: number;
  emitMs: number;
  recvMs: number;
  fwdMs: number;
  engineMs: number;
  sendMs: number;
  clientRecvMs: number;
  domMs: number;
}

/**
 * Turn the marks into legs. Pure, and the only place the arithmetic lives —
 * the readout, the CSV and the tests all read the same numbers.
 *
 * `spokenMs` walks back from the frame's emit by the audio still owed at that
 * instant: the frame closed at `chunkAudioEndMs`, the word ended at
 * `audioEndMs`, and the difference is real time the speaker had already spent.
 */
export function buildSample(p: PendingSample, paintMs: number, clock: ClockOffset): LatencySample {
  const capture = p.chunkAudioEndMs - p.audioEndMs;
  const spokenMs = p.emitMs - capture;
  const serverToClient = (ms: number): number => ms - clock.offsetMs;
  return {
    seq: p.seq,
    turn: p.turn,
    final: p.final,
    audioEndMs: p.audioEndMs,
    spokenMs,
    capture,
    uplink: serverToClient(p.recvMs) - p.emitMs,
    queue: p.fwdMs - p.recvMs,
    vendor: p.engineMs - p.fwdMs,
    serverOut: p.sendMs - p.engineMs,
    downlink: p.clientRecvMs - serverToClient(p.sendMs),
    render: p.domMs - p.clientRecvMs,
    paint: paintMs - p.domMs,
    total: paintMs - spokenMs,
    offsetMs: clock.offsetMs,
    offsetRttMs: clock.rttMs,
  };
}

/**
 * The p-th percentile by nearest rank. Sorting a copy: the caller's array is
 * the live sample list and reordering it under them would be a bug that only
 * shows up in the CSV.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] as number;
}

/** The legs, in the order the time is actually spent. */
export const LATENCY_STAGES = [
  'capture',
  'uplink',
  'queue',
  'vendor',
  'serverOut',
  'downlink',
  'render',
  'paint',
  'total',
] as const;

export type LatencyStage = (typeof LATENCY_STAGES)[number];

export interface StageStats {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export type LatencySummary = Record<LatencyStage, StageStats> & {
  /** Uplink plus downlink: the part of the wire we own, and the figure that
   *  survives a wrong clock offset. */
  network: StageStats;
};

function stats(values: readonly number[]): StageStats {
  return {
    n: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: percentile(values, 100),
  };
}

/** Per-stage p50/p95 over a set of samples. */
export function summarize(samples: readonly LatencySample[]): LatencySummary {
  const out = {} as LatencySummary;
  for (const stage of LATENCY_STAGES) out[stage] = stats(samples.map((s) => s[stage]));
  out.network = stats(samples.map((s) => s.uplink + s.downlink));
  return out;
}

/** CSV columns, in order. Numbers and booleans only, by construction. */
export const CSV_COLUMNS = [
  'seq',
  'turn',
  'final',
  'audioEndMs',
  'spokenMs',
  'capture',
  'uplink',
  'queue',
  'vendor',
  'serverOut',
  'downlink',
  'render',
  'paint',
  'total',
  'offsetMs',
  'offsetRttMs',
] as const;

/**
 * The samples as CSV.
 *
 * Written from `CSV_COLUMNS` rather than from the sample's own keys so the
 * column set is a decision in this file rather than whatever a `LatencySample`
 * happens to carry — the guarantee that no content can appear here has to hold
 * when someone adds a field to the type.
 */
export function toCsv(samples: readonly LatencySample[]): string {
  const round = (v: unknown): string =>
    typeof v === 'number' ? String(Math.round(v * 10) / 10) : String(v);
  const rows = samples.map((s) =>
    CSV_COLUMNS.map((c) => round((s as unknown as Record<string, unknown>)[c])).join(','),
  );
  return [CSV_COLUMNS.join(','), ...rows].join('\n');
}
