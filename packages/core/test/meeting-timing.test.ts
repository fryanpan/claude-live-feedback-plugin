/**
 * The arithmetic the latency measurement rests on.
 *
 * Two properties matter more than any single number here. The audio-offset
 * lookup has to name the chunk that ACTUALLY carried a word, because that is
 * the only correlation key the pipeline offers; and an error in the clock
 * offset has to cancel between the two network legs, because the browser and
 * the server keep different clocks and a report that quietly depended on them
 * agreeing would be wrong without ever looking wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  AudioChunkLedger,
  CSV_COLUMNS,
  type ClockOffset,
  type LatencySample,
  type PendingSample,
  bestOffset,
  buildSample,
  offsetFromPong,
  parseMeetingClientMessage,
  percentile,
  summarize,
  toCsv,
} from '../src/index.ts';

/** 16 kHz mono PCM16: 3200 bytes is exactly 100ms of audio. */
const RATE = 16_000;
const FRAME_BYTES = 3200;

describe('the chunk ledger maps an audio offset back to the chunk that carried it', () => {
  it('prices a chunk from the running byte count, not from an assumed frame size', () => {
    const ledger = new AudioChunkLedger(RATE);
    const first = ledger.record(FRAME_BYTES, 100, 101);
    const second = ledger.record(FRAME_BYTES, 200, 201);
    expect(first).toMatchObject({ seq: 0, audioStartMs: 0, audioEndMs: 100 });
    expect(second).toMatchObject({ seq: 1, audioStartMs: 100, audioEndMs: 200 });
    // A half-sized chunk is half the audio; nothing here assumes 100ms.
    expect(ledger.record(FRAME_BYTES / 2, 300, 301).audioEndMs).toBe(250);
  });

  it('finds the chunk whose span contains the offset', () => {
    const ledger = new AudioChunkLedger(RATE);
    for (let i = 0; i < 20; i++) ledger.record(FRAME_BYTES, 1000 + i, 1000 + i);
    expect(ledger.chunkAt(0)?.seq).toBe(0);
    expect(ledger.chunkAt(99.9)?.seq).toBe(0);
    // A boundary belongs to the chunk that STARTS there — the sample at
    // 100ms is the first sample of chunk 1, not the last of chunk 0.
    expect(ledger.chunkAt(100)?.seq).toBe(1);
    expect(ledger.chunkAt(570)?.seq).toBe(5);
    expect(ledger.chunkAt(1999)?.seq).toBe(19);
  });

  it('resolves an offset past the newest chunk to that chunk, and one before the window to nothing', () => {
    const ledger = new AudioChunkLedger(RATE, 4);
    for (let i = 0; i < 10; i++) ledger.record(FRAME_BYTES, i, i);
    // The engine's stream clock can run a hair ahead of the bytes we have
    // counted; refusing those would drop the newest partials, which is the
    // whole population being measured.
    expect(ledger.chunkAt(5_000)?.seq).toBe(9);
    // Older than the ring holds: no honest answer, so none is given.
    expect(ledger.chunkAt(50)).toBeNull();
    expect(ledger.chunkAt(650)?.seq).toBe(6);
  });

  it('has nothing to say before any audio has been forwarded', () => {
    expect(new AudioChunkLedger(RATE).chunkAt(0)).toBeNull();
  });
});

describe('the clock exchange', () => {
  it('recovers a known offset across a symmetric link', () => {
    // Server clock runs 5000ms ahead. One-way 20ms each way, 3ms turnaround.
    const clientMs = 1_000;
    const serverRecvMs = 1_020 + 5_000;
    const serverSendMs = serverRecvMs + 3;
    const clientRecvMs = 1_043;
    const est = offsetFromPong({ id: 1, clientMs, serverRecvMs, serverSendMs }, clientRecvMs);
    expect(est.offsetMs).toBeCloseTo(5_000, 6);
    expect(est.rttMs).toBeCloseTo(40, 6);
  });

  it('keeps the exchange with the lowest round trip, not the most recent', () => {
    const estimates: ClockOffset[] = [
      { offsetMs: 90, rttMs: 300 },
      { offsetMs: 100, rttMs: 12 },
      { offsetMs: 140, rttMs: 900 },
    ];
    expect(bestOffset(estimates)?.offsetMs).toBe(100);
    expect(bestOffset([])).toBeNull();
    // A NaN round trip is what an unanchored sample carries; it must never
    // win, or one unmeasured exchange would price the whole meeting.
    expect(bestOffset([{ offsetMs: 7, rttMs: Number.NaN }])).toBeNull();
  });
});

/** One fully specified hop-by-hop journey, with a server clock 5s ahead. */
const JOURNEY: PendingSample = {
  seq: 5,
  turn: 2,
  final: false,
  audioEndMs: 570,
  chunkAudioEndMs: 600,
  emitMs: 1_000,
  recvMs: 6_012,
  fwdMs: 6_013,
  engineMs: 6_300,
  sendMs: 6_301,
  clientRecvMs: 1_309,
  domMs: 1_312,
};
const PAINT_MS = 1_318;
const TRUE_OFFSET: ClockOffset = { offsetMs: 5_000, rttMs: 20 };

describe('one sample, hop by hop', () => {
  it('walks back to when the word was spoken and splits the rest into legs', () => {
    const s = buildSample(JOURNEY, PAINT_MS, TRUE_OFFSET);
    // The frame closed at 600ms of audio and the word ended at 570, so 30ms
    // of real time had already passed before the frame could even be sent.
    expect(s.capture).toBe(30);
    expect(s.spokenMs).toBe(970);
    expect(s.uplink).toBe(12);
    expect(s.queue).toBe(1);
    expect(s.vendor).toBe(287);
    expect(s.serverOut).toBe(1);
    expect(s.downlink).toBe(8);
    expect(s.render).toBe(3);
    expect(s.paint).toBe(6);
    expect(s.total).toBe(348);
  });

  it('accounts for every millisecond: the legs sum to the total', () => {
    const s = buildSample(JOURNEY, PAINT_MS, TRUE_OFFSET);
    const legs =
      s.capture + s.uplink + s.queue + s.vendor + s.serverOut + s.downlink + s.render + s.paint;
    expect(legs).toBeCloseTo(s.total, 9);
  });

  it('survives a wrong clock offset — the error moves between the two network legs and cancels', () => {
    // The load-bearing property. The browser and the server keep separate
    // clocks and the offset is an ESTIMATE; if a bad estimate could move the
    // headline number, the report would be wrong without looking wrong.
    const wrong = buildSample(JOURNEY, PAINT_MS, { offsetMs: 5_040, rttMs: 20 });
    const right = buildSample(JOURNEY, PAINT_MS, TRUE_OFFSET);
    expect(wrong.total).toBe(right.total);
    expect(wrong.vendor).toBe(right.vendor);
    expect(wrong.queue).toBe(right.queue);
    expect(wrong.serverOut).toBe(right.serverOut);
    expect(wrong.uplink + wrong.downlink).toBeCloseTo(right.uplink + right.downlink, 9);
    // And it really did move: the split is what a bad estimate distorts.
    expect(wrong.uplink).not.toBe(right.uplink);
  });
});

describe('percentiles and the summary', () => {
  it('takes the nearest rank and leaves the caller’s array alone', () => {
    const xs = [50, 10, 40, 20, 30];
    expect(percentile(xs, 0)).toBe(10);
    expect(percentile(xs, 50)).toBe(30);
    expect(percentile(xs, 95)).toBe(50);
    expect(percentile(xs, 100)).toBe(50);
    expect(xs).toEqual([50, 10, 40, 20, 30]);
    expect(percentile([], 50)).toBeNaN();
  });

  it('reports the network as uplink plus downlink, the figure a bad offset cannot move', () => {
    const samples = [10, 20, 30].map((extra) =>
      buildSample(
        { ...JOURNEY, clientRecvMs: JOURNEY.clientRecvMs + extra },
        PAINT_MS,
        TRUE_OFFSET,
      ),
    );
    const summary = summarize(samples);
    expect(summary.total.n).toBe(3);
    expect(summary.network.p50).toBeCloseTo(12 + 8 + 20, 9);
    expect(summary.vendor.p50).toBe(287);
  });
});

describe('the CSV cannot carry content', () => {
  it('writes only the declared columns, whatever else a sample gained', () => {
    const smuggled = {
      ...buildSample(JOURNEY, PAINT_MS, TRUE_OFFSET),
      text: 'so the sync is the bottleneck',
      docId: 'planning-huddle',
    } as unknown as LatencySample;
    const csv = toCsv([smuggled]);
    expect(csv.split('\n')[0]).toBe(CSV_COLUMNS.join(','));
    // The guarantee has to hold when someone adds a field to the type — the
    // column set is a decision in the module, not whatever the object holds.
    expect(csv).not.toContain('bottleneck');
    expect(csv).not.toContain('planning-huddle');
    expect(csv.split('\n')).toHaveLength(2);
  });
});

describe('the wire contract carries the opt-in and the clock exchange', () => {
  it('reads the timing flag off start, and only the literal true', () => {
    const base = { type: 'start', sampleRate: 16_000, encoding: 'pcm_s16le' };
    expect(parseMeetingClientMessage(JSON.stringify(base))).not.toHaveProperty('timing');
    expect(parseMeetingClientMessage(JSON.stringify({ ...base, timing: true }))).toMatchObject({
      timing: true,
    });
    // A client that does not know about timing must not be read as asking.
    expect(parseMeetingClientMessage(JSON.stringify({ ...base, timing: 1 }))).not.toHaveProperty(
      'timing',
    );
  });

  it('parses a ping and refuses one with a missing or unreadable timestamp', () => {
    expect(
      parseMeetingClientMessage(JSON.stringify({ type: 'timing_ping', id: 3, clientMs: 9 })),
    ).toEqual({ type: 'timing_ping', id: 3, clientMs: 9 });
    expect(parseMeetingClientMessage(JSON.stringify({ type: 'timing_ping', id: 3 }))).toBeNull();
    expect(
      parseMeetingClientMessage(JSON.stringify({ type: 'timing_ping', id: 3, clientMs: 'now' })),
    ).toBeNull();
  });
});
