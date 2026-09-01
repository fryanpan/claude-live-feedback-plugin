/**
 * The bot's words reach a doc's viewers on the stream they already hold.
 *
 * Through the real server: a bot is invited over the REST route, the vendor
 * "dials" `/recall/<token>` with a websocket, and the doc's `/events/<docId>`
 * SSE stream — the one `meeting-bot-client.ts` subscribes to — carries one
 * `meeting.transcript` per frame, partials included. The two properties
 * that make that safe are both asserted here: the frames carry NO id, and a
 * reconnect at the last REAL event's id is a clean no-op rather than a gap —
 * the words never entered the replay window.
 *
 * The vendor is a fake; nothing here bills anyone. Names are invented.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateBotArgs, RecallBot, RecallClient, RecallConfig } from '../src/recall.ts';
import { type ServerHandle, createServer } from '../src/server.ts';

type Frame = { event: string; id?: string; data?: Record<string, unknown> };

function listenFrames(res: Response): { frames: Frame[]; stop: () => Promise<void> } {
  const frames: Frame[] = [];
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let stopped = false;
  let buf = '';
  const pump = (async () => {
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let sep = buf.indexOf('\n\n');
        while (sep >= 0) {
          const raw = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          sep = buf.indexOf('\n\n');
          const frame: Frame = { event: 'message' };
          for (const line of raw.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) frame.event = line.slice(6).trim();
            else if (line.startsWith('id:')) frame.id = line.slice(3).trim();
            else if (line.startsWith('data:')) {
              try {
                frame.data = JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>;
              } catch {}
            }
          }
          if (frame.data || frame.id || frame.event !== 'message') frames.push(frame);
        }
      }
    } catch {}
  })();
  return {
    frames,
    stop: async () => {
      stopped = true;
      await reader.cancel().catch(() => {});
      await pump;
    },
  };
}

const waitFor = async (pred: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 3_000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A configured vendor that remembers the realtime URL it was handed. */
class FakeRecall implements RecallClient {
  readonly created: CreateBotArgs[] = [];
  readonly config: RecallConfig = {
    region: 'us-east-1',
    publicWsBase: 'wss://recall.example.test',
    retentionHours: 24,
    separateStreams: true,
    botName: 'Meeting Assistant',
  };
  createBot(args: CreateBotArgs): Promise<RecallBot> {
    this.created.push(args);
    return Promise.resolve({ id: `bot_${this.created.length}` });
  }
  getBot(botId: string): Promise<RecallBot> {
    return Promise.resolve({ id: botId });
  }
  leaveCall(): Promise<void> {
    return Promise.resolve();
  }
  requestRecordingPermission(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

function vendorFrame(args: { final: boolean; id: number; name: string; text: string }): string {
  return JSON.stringify({
    event: args.final ? 'transcript.data' : 'transcript.partial_data',
    data: {
      data: {
        words: args.text.split(' ').map((text) => ({ text, start_timestamp: { relative: 0 } })),
        language_code: 'en',
        participant: { id: args.id, name: args.name, is_host: false, platform: 'zoom' },
      },
      bot: { id: 'bot_1', metadata: {} },
      recording: { id: 'rec_1', metadata: {} },
    },
  });
}

describe("a bot meeting's live turns on the doc's own event stream", () => {
  let handle: ServerHandle;
  let dataDir: string;
  let base: string;
  let docId = '';
  const vendor = new FakeRecall();

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-recall-stream-'));
    handle = createServer({ port: 0, dataDir, meetingBot: vendor });
    base = `http://localhost:${handle.port}`;
    const path = join(dataDir, 'standup.md');
    writeFileSync(path, '# Standup\n\nAgenda.\n');
    const res = await fetch(`${base}/api/docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: 'standup', sourceUrl: path, title: 'Standup' }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    docId = ((await res.json()) as { docId: string }).docId;
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a replayed partial then final land on /events/<docId> as turn/text/final/speaker, unbuffered', async () => {
    // A viewer already on the doc — the stream the bot client subscribes to.
    const viewer = listenFrames(await fetch(`${base}/events/${docId}`));

    const invited = await fetch(`${base}/api/docs/${docId}/meeting-bot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meetingUrl: 'https://example.zoom.us/j/1234567890' }),
    });
    expect(invited.status, await invited.clone().text()).toBe(200);
    const realtime = vendor.created[0]?.realtimeUrl ?? '';
    const token = realtime.slice(realtime.lastIndexOf('/') + 1);
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    // The vendor dials us, and the meeting accepts its token.
    const ws = new WebSocket(`ws://localhost:${handle.port}/recall/${token}`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('recall socket refused')));
    });
    ws.send(vendorFrame({ final: false, id: 7, name: 'Rowan Pike', text: 'so the' }));
    ws.send(vendorFrame({ final: true, id: 7, name: 'Rowan Pike', text: 'So the sync.' }));

    const words = () => viewer.frames.filter((f) => f.event === 'meeting.transcript');
    await waitFor(() => words().length === 2, 'two live turns');
    expect(words().map((f) => f.data)).toEqual([
      expect.objectContaining({
        docId,
        turn: 0,
        text: 'so the',
        final: false,
        speaker: 'p7',
        speakerName: 'Rowan Pike',
      }),
      expect.objectContaining({
        docId,
        turn: 0,
        text: 'So the sync.',
        final: true,
        speaker: 'p7',
        speakerName: 'Rowan Pike',
      }),
    ]);
    // No id on a word: a client cursor can never point at a frame the
    // buffer does not hold.
    expect(words().every((f) => f.id === undefined)).toBe(true);

    // POSITIVE CONTROL: the bot's status still arrives on the same stream,
    // unchanged — WITH an id, because it is buffered for replay.
    const statuses = viewer.frames.filter((f) => f.event === 'meeting.bot');
    expect(statuses.length).toBeGreaterThan(0);
    const last = statuses[statuses.length - 1] as Frame;
    expect(last.id).toBeTruthy();
    expect(last.data).toMatchObject({ botId: 'bot_1', docId, speakers: ['Rowan Pike'] });
    // The buffered lifecycle fact rode along too.
    expect(viewer.frames.some((f) => f.event === 'meeting.started')).toBe(true);
    await viewer.stop();

    // The words never entered the replay window: a tab reconnecting at the
    // last real event's id gets a clean, empty catch-up — no gap, no words.
    const back = listenFrames(
      await fetch(`${base}/events/${docId}`, { headers: { 'last-event-id': last.id as string } }),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(back.frames.filter((f) => f.event === 'replay.gap')).toHaveLength(0);
    expect(back.frames.filter((f) => f.event === 'meeting.transcript')).toHaveLength(0);
    await back.stop();
    ws.close();
  });
});
