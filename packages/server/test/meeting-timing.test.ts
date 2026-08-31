/**
 * The relay's half of the latency measurement, through the REAL server
 * socket: the opt-in, the clock exchange, and the block it attaches to a
 * transcript frame.
 *
 * The engine here reports word offsets the way AssemblyAI does — audio
 * milliseconds from the start of its stream — and answers INSIDE the `send`
 * that fed it. That is deliberate: a synchronous engine is the only way to
 * catch a relay that records a chunk after forwarding it, which resolves
 * every offset to the previous frame and understates the vendor's leg by a
 * whole frame's worth.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEETING_AUDIO_ENCODING,
  MEETING_SAMPLE_RATE,
  type MeetingTimingMark,
  meetingSocketPath,
} from '@feedback/core';
import { type ServerHandle, createServer } from '../src/server.ts';
import { audioEndMsFromTurn } from '../src/transcribe-assemblyai.ts';
import type { TranscriptionEngine } from '../src/transcribe.ts';

/** 100ms of 16 kHz mono PCM16. */
const FRAME_BYTES = (MEETING_SAMPLE_RATE / 10) * 2;
/** Bytes of this audio per millisecond. */
const BYTES_PER_MS = (MEETING_SAMPLE_RATE * 2) / 1000;
/** How far behind the audio it has heard the engine's last word ends. */
const WORD_LAG_MS = 30;

interface ServerFrame {
  type: string;
  timing?: MeetingTimingMark;
  [key: string]: unknown;
}

/**
 * An engine that reports where in the audio its words end, and answers
 * synchronously. `openDelayMs` holds the handshake open so audio piles up in
 * the relay's buffer, which is the only way the queue leg is ever non-zero.
 */
function createOffsetEngine(openDelayMs = 0): TranscriptionEngine {
  return {
    name: 'offset-mock',
    async open(opts) {
      if (openDelayMs > 0) await new Promise((r) => setTimeout(r, openDelayMs));
      let bytes = 0;
      let words = 0;
      return {
        send(audio: Uint8Array): void {
          bytes += audio.byteLength;
          words++;
          opts.onTurn({
            turn: 0,
            text: Array.from({ length: words }, () => 'word').join(' '),
            final: false,
            audioEndMs: bytes / BYTES_PER_MS - WORD_LAG_MS,
            engineMs: Date.now(),
          });
        },
        close: () => Promise.resolve(),
      };
    },
  };
}

class AudioClient {
  readonly frames: ServerFrame[] = [];
  private constructor(readonly ws: WebSocket) {}

  static async open(base: string, docId: string): Promise<AudioClient> {
    const ws = new WebSocket(`${base}${meetingSocketPath(docId)}`);
    ws.binaryType = 'arraybuffer';
    const client = new AudioClient(ws);
    ws.addEventListener('message', (ev) => {
      client.frames.push(JSON.parse(ev.data as string) as ServerFrame);
    });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('audio socket refused')));
    });
    return client;
  }

  start(timing: boolean): void {
    this.ws.send(
      JSON.stringify({
        type: 'start',
        sampleRate: MEETING_SAMPLE_RATE,
        encoding: MEETING_AUDIO_ENCODING,
        ...(timing ? { timing: true } : {}),
      }),
    );
  }

  /** Whole 100ms frames, so a frame ordinal is a round 100ms of audio. */
  speak(frames: number): void {
    for (let i = 0; i < frames; i++) this.ws.send(new Uint8Array(FRAME_BYTES));
  }

  ping(id: number, clientMs: number): void {
    this.ws.send(JSON.stringify({ type: 'timing_ping', id, clientMs }));
  }

  async waitFor(type: string, timeoutMs = 3_000): Promise<ServerFrame> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.frames.find((f) => f.type === type);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no "${type}" frame; got ${JSON.stringify(this.frames.map((f) => f.type))}`);
  }

  async waitForCount(type: string, n: number, timeoutMs = 3_000): Promise<ServerFrame[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.frames.filter((f) => f.type === type);
      if (found.length >= n) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`only ${this.frames.filter((f) => f.type === type).length} "${type}" frames`);
  }

  close(): void {
    this.ws.close();
  }
}

async function makeServer(engine: TranscriptionEngine): Promise<{
  handle: ServerHandle;
  dataDir: string;
  wsBase: string;
  createDoc: (docId: string) => Promise<void>;
}> {
  const dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-timing-'));
  const handle = createServer({ port: 0, dataDir, transcription: engine });
  const base = `http://localhost:${handle.port}`;
  return {
    handle,
    dataDir,
    wsBase: `ws://localhost:${handle.port}`,
    createDoc: async (docId) => {
      const path = join(dataDir, `${docId}.md`);
      writeFileSync(path, `# ${docId}\n\nNotes go here.\n`);
      const res = await fetch(`${base}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ docId, sourceUrl: path, title: docId }),
      });
      expect(res.status, await res.clone().text()).toBe(200);
    },
  };
}

describe('the relay measures only when it is asked', () => {
  let env: Awaited<ReturnType<typeof makeServer>>;

  beforeAll(async () => {
    env = await makeServer(createOffsetEngine());
  });
  afterAll(async () => {
    await env.handle.stop();
    rmSync(env.dataDir, { recursive: true, force: true });
  });

  it('attaches nothing to an ordinary meeting', async () => {
    await env.createDoc('plain-meeting');
    const client = await AudioClient.open(env.wsBase, 'plain-meeting');
    client.start(false);
    await client.waitFor('ready');
    client.speak(6);
    const turns = await client.waitForCount('transcript', 6);
    for (const t of turns) expect(t.timing).toBeUndefined();
    client.close();
  });

  it('attaches a block to a meeting that asked — the control for the test above', async () => {
    // Without this, "no timing block" would pass on a relay that can never
    // produce one, which is the failure mode a negative assertion invites.
    await env.createDoc('measured-meeting');
    const client = await AudioClient.open(env.wsBase, 'measured-meeting');
    client.start(true);
    await client.waitFor('ready');
    client.speak(6);
    const turns = await client.waitForCount('transcript', 6);
    for (const t of turns) expect(t.timing).toBeDefined();
    client.close();
  });

  it('names the chunk that actually carried the word', async () => {
    await env.createDoc('offset-meeting');
    const client = await AudioClient.open(env.wsBase, 'offset-meeting');
    client.start(true);
    await client.waitFor('ready');
    client.speak(8);
    const turns = await client.waitForCount('transcript', 8);
    // Frame k closes at (k+1)*100ms of audio and the engine's word ends 30ms
    // before that — inside frame k, never frame k-1. A relay that recorded
    // the chunk after forwarding it would answer k-1 for every one of these.
    turns.forEach((t, k) => {
      const mark = t.timing as MeetingTimingMark;
      expect(mark.seq).toBe(k);
      expect(mark.audioEndMs).toBeCloseTo((k + 1) * 100 - WORD_LAG_MS, 6);
      expect(mark.chunkAudioEndMs).toBeCloseTo((k + 1) * 100, 6);
    });
    client.close();
  });

  it('stamps the marks in the order the time was spent', async () => {
    await env.createDoc('ordered-meeting');
    const client = await AudioClient.open(env.wsBase, 'ordered-meeting');
    client.start(true);
    await client.waitFor('ready');
    client.speak(3);
    const [first] = await client.waitForCount('transcript', 3);
    const mark = (first as ServerFrame).timing as MeetingTimingMark;
    expect(mark.recvMs).toBeLessThanOrEqual(mark.fwdMs);
    expect(mark.fwdMs).toBeLessThanOrEqual(mark.engineMs);
    expect(mark.engineMs).toBeLessThanOrEqual(mark.sendMs);
    client.close();
  });

  it('answers a clock ping with both of its own timestamps', async () => {
    await env.createDoc('ping-meeting');
    const client = await AudioClient.open(env.wsBase, 'ping-meeting');
    client.start(true);
    await client.waitFor('ready');
    const sentAt = Date.now();
    client.ping(7, sentAt);
    const pong = await client.waitFor('timing_pong');
    expect(pong.id).toBe(7);
    expect(pong.clientMs).toBe(sentAt);
    expect(typeof pong.serverRecvMs).toBe('number');
    expect(pong.serverSendMs as number).toBeGreaterThanOrEqual(pong.serverRecvMs as number);
    client.close();
  });
});

describe('audio held through the handshake reads as the server holding it', () => {
  it('prices the wait as the queue leg rather than as the engine’s', async () => {
    const env = await makeServer(createOffsetEngine(250));
    try {
      await env.createDoc('slow-open');
      const client = await AudioClient.open(env.wsBase, 'slow-open');
      client.start(true);
      // Straight into the relay's handshake buffer: there is no session yet.
      client.speak(3);
      const turns = await client.waitForCount('transcript', 3);
      const mark = (turns[0] as ServerFrame).timing as MeetingTimingMark;
      // The whole handshake sat between arrival and hand-off. Asserted well
      // under 250 so a slow machine cannot make this flaky in the other
      // direction; the point is that it is not ~0.
      expect(mark.fwdMs - mark.recvMs).toBeGreaterThan(100);
      client.close();
    } finally {
      await env.handle.stop();
      rmSync(env.dataDir, { recursive: true, force: true });
    }
  });
});

describe('a handshake long enough to drop audio stops the measurement instead of skewing it', () => {
  /**
   * The relay's handshake buffer is bounded, and a client that talks past the
   * bound has frames thrown away. The two sides count frames independently —
   * the browser numbers what it SENT, the ledger numbers what we FORWARDED —
   * so from the first dropped frame every ordinal names different audio, and
   * every later sample would be priced against an emit 100ms per drop too
   * early with nothing on screen to say so.
   */
  async function speakThroughTheHandshake(docId: string, frames: number): Promise<ServerFrame[]> {
    const env = await makeServer(createOffsetEngine(600));
    try {
      await env.createDoc(docId);
      const client = await AudioClient.open(env.wsBase, docId);
      client.start(true);
      // No session exists yet, so all of this lands in the bounded buffer.
      client.speak(frames);
      const turns = await client.waitForCount('transcript', 8, 6_000);
      client.close();
      return turns;
    } finally {
      await env.handle.stop();
      rmSync(env.dataDir, { recursive: true, force: true });
    }
  }

  it('measures a handshake the buffer absorbed — the control', async () => {
    // Without this the assertion below would pass on a relay that can never
    // attach a block through a slow handshake at all.
    const turns = await speakThroughTheHandshake('buffer-fits', 200);
    for (const t of turns) expect(t.timing).toBeDefined();
  }, 15_000);

  it('measures nothing once a frame has been dropped', async () => {
    const turns = await speakThroughTheHandshake('buffer-overflows', 320);
    for (const t of turns) expect(t.timing).toBeUndefined();
  }, 15_000);
});

describe('the engine adapter reads the word offsets AssemblyAI actually sends', () => {
  it('takes the end of the last word', () => {
    expect(
      audioEndMsFromTurn({
        type: 'Turn',
        words: [
          { text: 'so', start: 100, end: 240, word_is_final: true },
          { text: 'the', start: 250, end: 390, word_is_final: false },
        ],
      }),
    ).toBe(390);
  });

  it('costs the frame its sample rather than inventing an offset', () => {
    // Every one of these has been a real shape on some frame or other; none
    // of them may become a number, because a made-up offset would name the
    // wrong chunk and land in the percentiles looking like a measurement.
    expect(audioEndMsFromTurn({ type: 'Turn' })).toBeUndefined();
    expect(audioEndMsFromTurn({ type: 'Turn', words: [] })).toBeUndefined();
    expect(audioEndMsFromTurn({ type: 'Turn', words: 'nope' })).toBeUndefined();
    expect(audioEndMsFromTurn({ type: 'Turn', words: [{ text: 'so' }] })).toBeUndefined();
    expect(
      audioEndMsFromTurn({ type: 'Turn', words: [{ text: 'so', end: 'later' }] }),
    ).toBeUndefined();
  });
});
